// One model request on the person's Claude plan, made by the Claude Code CLI itself.
//
// Rho owns the conversation and the tools; Claude Code owns the login. As pi's Claude Code
// provider does, rho lets the CLI build and send its own request, so what reaches Anthropic is
// a Claude Code request: its headers, its system layout, its environment message, its tool
// format. Rho supplies the inputs (system prompt, history, an inert tool inventory) and a
// loopback relay changes only this on the way out:
//   - user messages are put back to exactly what rho sent, which drops the reminders the CLI
//     attaches (the account email among them);
//   - the CLI's environment messages keep the place they had in the conversation's first
//     request, so the prompt cache still matches when history is replayed;
//   - one request per turn is forwarded, so the CLI cannot carry on by itself.
// The response is handed to rho as it streams. The CLI never runs a tool.
//
// A CLI process is kept warm for a conversation that simply continues (at most two, five
// minutes). Anything else (a tool round, an edit, a different prompt) starts a fresh one that
// replays rho's history.
//
// The login's headers pass through this process in memory for one request. They are never
// logged or stored.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";

export interface RelayOptions {
	/** The CLI to run, with any leading arguments. Default: `RHO_CLAUDE`, then `claude` on PATH. */
	command?: string | readonly string[];
	/** Where the relay forwards to. Only tests change it. */
	upstream?: string;
	/** Longest the CLI may take to make its request. */
	startTimeoutMs?: number;
	/** Let a turn that Claude Code reports as charged to usage credits go through. Default false. */
	allowUsageCredits?: boolean;
	/** The directory the CLI runs in; it tells the model this path. Default: the process's. */
	cwd?: string;
	env?: Record<string, string | undefined>;
}
/** What is known about the call beyond its request body. */
export interface TurnInfo {
	/** The conversation's stable id. With one, a warm process and the cache layout are kept for it. */
	sessionId?: string;
}

type Json = Record<string, unknown>;
export interface Frame {
	type: "user" | "assistant";
	message: { role: "user" | "assistant"; content: Json[] };
	shouldQuery?: false;
}
export interface TurnPlan {
	model: string;
	system: string;
	tools: Json[];
	frames: Frame[];
	/** Request fields the CLI is told to use as given: thinking, effort, output limit. */
	extraBody: Json;
}

/** The CLI lists an MCP server's tools under this prefix. Rho's names go on in, and come off out. */
export const TOOL_PREFIX = "mcp__rho__";
const MISMATCH = "Claude Code's request does not line up with rho's conversation; the turn was stopped rather than sent as a guess.";
const MAX_WARM = 2;
const MAX_AGE_MS = 5 * 60_000;
const QUIET = {
	ENABLE_TOOL_SEARCH: "false", DISABLE_AUTOUPDATER: "1", DISABLE_FEEDBACK_COMMAND: "1", DISABLE_ERROR_REPORTING: "1", DISABLE_TELEMETRY: "1",
	CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1", CLAUDE_CODE_DISABLE_FILE_MENTIONS: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
	CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_MAX_RETRIES: "0", DISABLE_AUTO_COMPACT: "1",
	DISABLE_COMPACT: "1", CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off",
};
/** Settings that would send the request somewhere other than the person's plan. */
const CONFLICTS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_EXTRA_BODY"];
// Anthropic's words when it will not take a request on plan limits (from pi's Claude Code provider).
const CREDITS_REJECTION = /third-party apps now draw from your extra usage|out of extra usage|draws? from your usage credits/i;
const CREDITS_CHARGED = "Claude Code billing: this request was charged to Claude usage credits instead of your plan limits. Rho stopped so further requests are not charged. To stay on plan limits only, turn off usage credits at claude.ai/settings/usage; to allow them, set allowUsageCredits.";

const asBlocks = (content: unknown): Json[] => (typeof content === "string" ? [{ type: "text", text: content }] : Array.isArray(content) ? (content as Json[]) : []);
const textOf = (content: unknown): string => asBlocks(content).map((block) => (typeof block.text === "string" ? block.text : "")).join("");
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** The program and leading arguments that start the CLI. */
export function cliCommand(options: RelayOptions, env: Record<string, string | undefined>): [string, ...string[]] {
	const command = options.command ?? env.RHO_CLAUDE ?? "claude";
	const parts = typeof command === "string" ? [command] : [...command];
	return [parts[0] ?? "claude", ...parts.slice(1)];
}

/** A tool schema the CLI accepts: nullable variants and schema composition are simplified away. */
export function normalizeSchema(schema: unknown): Json {
	const strip = (value: unknown): unknown => {
		if (Array.isArray(value)) return value.map(strip);
		if (!value || typeof value !== "object") return value;
		const out: Json = {};
		for (const [key, child] of Object.entries(value)) out[key] = strip(child);
		if (Array.isArray(out.type) && out.type.includes("null")) {
			const rest = out.type.filter((kind) => kind !== "null");
			out.type = rest.length === 1 ? rest[0] : rest;
		}
		if (Array.isArray(out.anyOf)) {
			const rest = out.anyOf.filter((branch) => !(branch && typeof branch === "object" && (branch as Json).type === "null"));
			if (rest.length === 1 && rest.length !== out.anyOf.length) {
				delete out.anyOf;
				if (rest[0] && typeof rest[0] === "object") Object.assign(out, rest[0]);
			}
		}
		return out;
	};
	const normal = (strip(schema) ?? {}) as Json;
	for (const key of ["oneOf", "allOf", "anyOf"]) delete normal[key];
	if (!normal.type) normal.type = "object";
	if (normal.type === "object" && (!normal.properties || typeof normal.properties !== "object")) normal.properties = {};
	return normal;
}

/** A block as the CLI should replay it: no cache marks (it sets its own), tool names as it knows them. */
function forCli(block: Json): Json {
	const { cache_control: _dropped, ...rest } = block;
	if (rest.type === "tool_use" && typeof rest.name === "string") rest.name = TOOL_PREFIX + rest.name;
	if (rest.type === "tool_result" && Array.isArray(rest.content)) rest.content = (rest.content as Json[]).map(forCli);
	return rest;
}

/** What to give the CLI for one Anthropic-format request: prompt, tools, history, and fixed fields. */
export function planTurn(request: Json): TurnPlan {
	const system = asBlocks(request.system).map((block) => String(block.text ?? "")).join("\n\n");
	const names = new Set<string>();
	const tools: Json[] = [];
	for (const tool of (request.tools as Json[] | undefined) ?? []) {
		if (tool.defer_loading === true) continue;
		const name = String(tool.name);
		if (!/^[A-Za-z0-9_-]{1,50}$/.test(name) || names.has(name)) throw new Error("Tool names for Claude Code must be unique, at most 50 characters, of letters, digits, _ and -.");
		names.add(name);
		tools.push({ name, description: tool.description ?? "", inputSchema: normalizeSchema(tool.input_schema) });
	}
	const frames: Frame[] = [];
	for (const message of (request.messages as Json[] | undefined) ?? []) {
		if (message.role !== "user" && message.role !== "assistant") throw new Error(`The Claude Code provider cannot replay a ${String(message.role)} message inside the conversation.`);
		frames.push({ type: message.role, message: { role: message.role, content: asBlocks(message.content).map(forCli) } });
	}
	const last = frames.at(-1);
	if (!last || last.type !== "user" || last.message.content.length === 0) throw new Error("The conversation must end in a user message or a tool result.");
	// Earlier user messages are history: the CLI records them without asking the model.
	for (const frame of frames.slice(0, -1)) if (frame.type === "user") frame.shouldQuery = false;
	const extraBody: Json = {};
	const thinking = request.thinking as Json | undefined;
	if (thinking?.type === "adaptive") extraBody.thinking = { type: "adaptive", display: "summarized" };
	else if (thinking?.type === "enabled") extraBody.thinking = { type: "enabled", budget_tokens: thinking.budget_tokens };
	else if (thinking?.type === "disabled") Object.assign(extraBody, { thinking: { type: "disabled" }, context_management: { edits: [] } });
	const effort = (request.output_config as Json | undefined)?.effort;
	if (typeof effort === "string") extraBody.output_config = { effort };
	if (typeof request.max_tokens === "number") extraBody.max_tokens = request.max_tokens;
	return { model: String(request.model), system, tools, frames, extraBody };
}

/** A fingerprint of a history, for telling whether a warm process holds exactly this conversation. */
export function historyKey(frames: Frame[]): string {
	return digest(frames.map((frame) => (frame.type === "user" ? ["u", frame.message.content] : ["a", textOf(frame.message.content), frame.message.content.filter((block) => block.type === "tool_use").map((block) => block.id)])));
}

const isImageNote = (block: Json | undefined): boolean => block?.type === "text" && typeof block.text === "string" && /^\[Image: original \d+x\d+/.test(block.text);

/**
 * The CLI's blocks for one user message, put back to rho's. Rho's blocks are found in order by
 * type; whatever else the CLI put there (its reminders) is dropped. The CLI's copies of images
 * are kept, with its note about their size, because it may have scaled them.
 */
export function restoreBlocks(theirs: Json[], ours: Json[]): Json[] {
	const out: Json[] = [];
	let cursor = 0;
	for (const want of ours) {
		const index = theirs.findIndex((block, position) => position >= cursor && block.type === want.type && (want.type !== "tool_result" || block.tool_use_id === want.tool_use_id));
		if (index < 0) throw new Error(MISMATCH);
		const { cache_control: _dropped, ...native } = theirs[index]!;
		cursor = index + 1;
		if (want.type === "image") {
			out.push(native);
			if (isImageNote(theirs[cursor])) {
				const { cache_control: _note, ...note } = theirs[cursor++]!;
				out.push(note);
			}
		} else if (want.type === "tool_result" && Array.isArray(want.content) && Array.isArray(native.content)) out.push({ ...want, content: restoreBlocks(native.content as Json[], want.content as Json[]) });
		else out.push({ ...want });
	}
	return out;
}

function mark(message: Json, cache: Json): void {
	const content = asBlocks(message.content).map(({ cache_control: _dropped, ...block }) => block);
	if (content.length > 0) content[content.length - 1] = { ...content.at(-1), cache_control: cache };
	message.content = content;
}

/** The system messages a request has right after its first user message, and any at its tail. */
export function environmentOf(request: Json): Json[] | undefined {
	const messages = (request.messages as Json[] | undefined) ?? [];
	if (messages[0]?.role !== "user") return undefined;
	let end = 1;
	while (messages[end]?.role === "system") end++;
	const found = messages.slice(1, end);
	let tail = messages.length;
	while (tail > end && messages[tail - 1]?.role === "system") tail--;
	found.push(...messages.slice(tail));
	return found.length > 0 ? structuredClone(found) : undefined;
}

/**
 * The CLI's request with every user message restored to rho's and, when `environment` is given,
 * its environment messages back where the conversation's first request had them. Everything
 * else is the CLI's.
 */
export function restoreRequest(theirs: Json, frames: Frame[], environment?: Json[]): Json {
	const mine = frames.filter((frame) => frame.type === "user");
	let messages = structuredClone((theirs.messages as Json[] | undefined) ?? []);
	const users = messages.filter((message) => message.role === "user");
	if (users.length !== mine.length) throw new Error(MISMATCH);
	const cache = ([...asBlocks(theirs.system), ...messages.flatMap((message) => asBlocks(message.content))].find((block) => block.cache_control)?.cache_control as Json | undefined) ?? { type: "ephemeral" };
	users.forEach((message, index) => {
		const native = asBlocks(message.content);
		const marker = native.findLast((block) => block.cache_control)?.cache_control; // kept even if it sat on a dropped block
		const content = restoreBlocks(native, mine[index]!.message.content);
		if (marker && content.length > 0) content[content.length - 1] = { ...content.at(-1), cache_control: marker };
		message.content = content;
	});
	if (environment?.length && messages[0]?.role === "user") {
		let end = 1;
		while (messages[end]?.role === "system") end++;
		messages.splice(1, end - 1, ...structuredClone(environment));
		const known = environment.map((message) => textOf(message.content)).join("\n");
		while (messages.at(-1)?.role === "system") {
			const text = textOf(messages.at(-1)!.content);
			if (!text || !known.includes(text)) break;
			messages.pop();
		}
		// Four cache marks are allowed and the system prompt uses two. Once an earlier question
		// exists, the environment's mark moves to it, so the cached prefix ends at a real boundary.
		const at = messages.map((message, index) => (message.role === "user" ? index : -1)).filter((index) => index >= 0);
		if (at.length >= 3) {
			for (const message of messages) if (message.role === "system") message.content = asBlocks(message.content).map(({ cache_control: _dropped, ...block }) => block);
			mark(messages[at.at(-2)!]!, cache);
		}
		if (messages.at(-1)) mark(messages.at(-1)!, cache);
	}
	return { ...theirs, messages };
}

function killTree(child: ChildProcess): void {
	if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
	try {
		process.kill(-child.pid, "SIGKILL"); // the CLI may be a wrapper script: end its whole group
	} catch {
		child.kill("SIGKILL");
	}
}

interface Turn {
	frames: Frame[];
	environment?: Json[];
	used: boolean;
	abort: AbortController;
	settle(value: Response | Error): void;
	seen?: Json[];
}

/**
 * Remove turn directories a killed rho left in the temp directory. A SIGKILL gives rho no
 * chance to end its CLI or delete its files; the orphaned CLI stops by itself once its relay is
 * gone, and this clears the files at the next start. Only directories older than `olderThanMs`
 * are removed, so a turn in progress in another rho is not touched.
 */
export function sweepStale(olderThanMs = 10 * 60_000, root = tmpdir()): number {
	let removed = 0;
	for (const name of readdirSync(root)) {
		if (!/^rho-claude-[A-Za-z0-9]{6}$/.test(name)) continue;
		const path = join(root, name);
		try {
			if (Date.now() - statSync(path).mtimeMs < olderThanMs) continue;
			rmSync(path, { recursive: true, force: true });
			removed++;
		} catch {
			// gone already, or not ours to remove
		}
	}
	return removed;
}

const warm = new Map<string, Worker>();
/** Per conversation: the environment messages its first request had. In memory only. */
const environments = new Map<string, { head: string; messages: Json[] }>();
process.on("exit", () => { for (const worker of warm.values()) worker.close(); });

/** How many CLI processes are being kept for a next turn. */
export const warmProcessCount = (): number => warm.size;
/** End every kept CLI process. */
export function closeWarmProcesses(): void {
	for (const [id, worker] of [...warm]) {
		worker.close();
		warm.delete(id);
	}
}

/** One CLI process and the loopback route it sends its requests to. */
class Worker {
	busy = true;
	tip?: string;
	results = 0;
	failed = false;
	overage = false;
	exited = false;
	closed = false;
	stderr = "";
	turn?: Turn;
	readonly createdAt = Date.now();
	private waiters = new Set<() => void>();
	private expiry?: ReturnType<typeof setTimeout>;
	private constructor(readonly fingerprint: string, readonly child: ChildProcess, private server: ReturnType<typeof Bun.serve>, private dir: string) {}

	static start(plan: TurnPlan, options: RelayOptions, fingerprint: string): Worker {
		const upstream = options.upstream ?? "https://api.anthropic.com";
		const secret = randomBytes(18).toString("base64url");
		const dir = mkdtempSync(join(tmpdir(), "rho-claude-"));
		writeFileSync(join(dir, "system.txt"), plan.system);
		writeFileSync(join(dir, "tools.json"), JSON.stringify(plan.tools));
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ env: { CLAUDE_CODE_EXTRA_BODY: JSON.stringify(plan.extraBody) } }));
		let self!: Worker;
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			idleTimeout: 0,
			async fetch(incoming) {
				const url = new URL(incoming.url);
				if (incoming.method !== "POST" || url.pathname !== `/${secret}/v1/messages` || incoming.headers.has("origin")) return new Response(null, { status: 404 });
				const turn = self.turn;
				// One request per turn. Another is the CLI trying to go on by itself.
				if (!turn || turn.used) return Response.json({ type: "error", error: { type: "invalid_request_error", message: "RHO_TURN_RELAY_CONSUMED" } }, { status: 400 });
				turn.used = true;
				try {
					const theirs = (await incoming.json()) as Json;
					turn.seen = environmentOf(theirs);
					const body = restoreRequest(theirs, turn.frames, turn.environment);
					const headers = new Headers(incoming.headers);
					for (const name of ["host", "connection", "content-length", "transfer-encoding", "proxy-authorization", "proxy-connection", "accept-encoding"]) headers.delete(name);
					headers.set("accept-encoding", "identity");
					const answer = await fetch(`${upstream}/v1/messages${url.search}`, { method: "POST", headers, body: JSON.stringify(body), signal: turn.abort.signal });
					const back = new Headers(answer.headers);
					for (const name of ["content-encoding", "content-length", "transfer-encoding", "connection"]) back.delete(name);
					if (answer.status >= 400 || !answer.body) {
						const text = await answer.text();
						if (CREDITS_REJECTION.test(text)) turn.settle(new Error(`Claude Code billing: Anthropic did not accept this request on your Claude plan limits and wants to charge it to usage credits. Rho will not retry it. Original error: ${text.slice(0, 500)}`));
						else turn.settle(new Response(text, { status: answer.status, headers: back }));
						return new Response(text, { status: answer.status, headers: back });
					}
					const [mine, cli] = answer.body.tee();
					turn.settle(new Response(mine, { status: answer.status, headers: back }));
					return new Response(cli, { status: answer.status, headers: back });
				} catch (error) {
					turn.settle(error instanceof Error ? error : new Error(String(error)));
					return Response.json({ type: "error", error: { type: "invalid_request_error", message: "stopped by rho" } }, { status: 400 });
				}
			},
		});
		const base = { ...process.env, ...options.env } as Record<string, string | undefined>;
		for (const name of CONFLICTS) delete base[name];
		const env = { ...base, ...QUIET, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}/${secret}` } as Record<string, string>;
		const mcp = { mcpServers: { rho: { command: process.execPath, args: [join(import.meta.dir, "inert-mcp.ts"), join(dir, "tools.json")] } } };
		const args = ["-p", "--model", plan.model, "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--tools", "", "--system-prompt-file", join(dir, "system.txt"),
			"--settings", join(dir, "settings.json"), "--setting-sources", "", "--strict-mcp-config", "--disable-slash-commands", "--max-turns", "1", "--permission-mode", "dontAsk",
			"--no-session-persistence", "--mcp-config", JSON.stringify(mcp)];
		const [command, ...lead] = cliCommand(options, base);
		let child: ChildProcess;
		try {
			child = spawn(command, [...lead, ...args], { cwd: options.cwd ?? process.cwd(), env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
		} catch (error) {
			void server.stop(true);
			rmSync(dir, { recursive: true, force: true });
			throw new Error(`Could not start Claude Code (${command}): ${(error as Error).message}`);
		}
		self = new Worker(fingerprint, child, server, dir);
		child.stderr?.on("data", (chunk: Buffer) => (self.stderr = (self.stderr + chunk.toString()).slice(-4000)));
		child.stdin?.on("error", () => undefined); // a CLI that died is reported by its exit
		child.on("error", (error) => {
			self.exited = true;
			self.turn?.settle(new Error(`Could not start Claude Code (${command}): ${error.message}`));
			self.wake();
		});
		child.on("exit", (code) => {
			self.exited = true;
			if (self.turn && !self.turn.used) self.turn.settle(new Error(`Claude Code exited (${String(code)}) before sending a request. ${self.stderr.trim().slice(-400) || "Is it logged in? Run: claude auth status"}`));
			self.wake();
		});
		void (async () => {
			for await (const line of createInterface({ input: child.stdout!, crlfDelay: Infinity })) {
				let event: Json;
				try {
					event = JSON.parse(line) as Json;
				} catch {
					continue;
				}
				if (event.type === "result") {
					self.failed = event.is_error === true || (event.num_turns !== 0 && event.num_turns !== 1);
					self.results++;
				} else if (event.type === "rate_limit_event" && (event.rate_limit_info as Json | undefined)?.isUsingOverage === true) self.overage = true;
				self.wake();
			}
		})().catch(() => undefined);
		return self;
	}

	private wake(): void {
		for (const waiter of [...this.waiters]) waiter();
	}
	/** Resolves when `check` holds, the CLI is gone, or `ms` passed. */
	until(check: () => boolean, ms?: number): Promise<void> {
		return new Promise((done) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const waiter = () => {
				if (!check() && !this.exited && !this.closed) return;
				this.waiters.delete(waiter);
				clearTimeout(timer);
				done();
			};
			this.waiters.add(waiter);
			if (ms !== undefined) timer = setTimeout(() => { this.waiters.delete(waiter); done(); }, ms);
			waiter();
		});
	}
	write(frame: Frame): void {
		this.child.stdin?.write(`${JSON.stringify({ ...frame, uuid: randomUUID() })}\n`);
	}
	get usable(): boolean {
		return !this.busy && !this.closed && !this.exited && Date.now() - this.createdAt < MAX_AGE_MS;
	}
	keep(id: string, tip: string): void {
		this.busy = false;
		this.turn = undefined;
		this.tip = tip;
		warm.set(id, this);
		this.expiry = setTimeout(() => { if (warm.get(id) === this) warm.delete(id); this.close(); }, Math.max(0, MAX_AGE_MS - (Date.now() - this.createdAt)));
		this.expiry.unref?.();
	}
	close(): void {
		if (this.closed) return;
		this.closed = true;
		clearTimeout(this.expiry);
		killTree(this.child);
		void this.server.stop(true);
		rmSync(this.dir, { recursive: true, force: true });
		this.wake();
	}
}

/** What rho's copy of the response said, as far as keeping the process needs to know. */
interface Heard { text: string; tool: boolean; stop?: string; complete: boolean }

/** Rho's copy of the response: tool names lose the CLI's prefix, and the answer is noted. */
function listen(body: ReadableStream<Uint8Array>, heard: Heard): ReadableStream<Uint8Array> {
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let carry = "";
	const line = (text: string): string => {
		if (!text.startsWith("data: ")) return text;
		try {
			const event = JSON.parse(text.slice(6)) as Json;
			const block = event.content_block as Json | undefined;
			const delta = event.delta as Json | undefined;
			if (event.type === "content_block_start" && block?.type === "tool_use") heard.tool = true;
			else if (event.type === "content_block_delta" && delta?.type === "text_delta") heard.text += String(delta.text ?? "");
			else if (event.type === "message_delta" && typeof delta?.stop_reason === "string") heard.stop = delta.stop_reason;
			else if (event.type === "message_stop") heard.complete = true;
		} catch {
			// not JSON: passed on as it is
		}
		return text.replaceAll(`"name":"${TOOL_PREFIX}`, '"name":"');
	};
	return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			const text = carry + decoder.decode(chunk, { stream: true });
			const end = text.lastIndexOf("\n") + 1; // whole lines only, so nothing is split
			carry = text.slice(end);
			if (end > 0) controller.enqueue(encoder.encode(text.slice(0, end).split("\n").map(line).join("\n")));
		},
		flush(controller) {
			if (carry !== "") controller.enqueue(encoder.encode(line(carry)));
		},
	}));
}

/** A `fetch` for pi-ai's Anthropic adapter that has the Claude Code CLI make each request. */
export function relayFetch(options: RelayOptions = {}, info: TurnInfo = {}): typeof fetch {
	const send = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
		const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
		const signal = request.signal;
		signal.throwIfAborted();
		const plan = planTurn((await request.json()) as Json);
		const id = info.sessionId;
		const [command, ...lead] = cliCommand(options, { ...process.env, ...options.env });
		const fingerprint = digest([command, lead, resolve(options.cwd ?? process.cwd()), options.upstream, plan.model, plan.system, plan.tools, plan.extraBody]);
		const head = digest(plan.frames.find((frame) => frame.type === "user")?.message.content);
		const environment = id !== undefined && environments.get(id)?.head === head ? environments.get(id)!.messages : undefined;

		// A warm process is used only when it holds exactly this conversation up to the new message.
		const cached = id === undefined ? undefined : warm.get(id);
		const continuing = cached !== undefined && cached.usable && cached.fingerprint === fingerprint && cached.tip === historyKey(plan.frames.slice(0, -1));
		if (cached && !cached.busy && !continuing) {
			warm.delete(id!);
			cached.close();
		}
		let worker: Worker;
		if (continuing) {
			worker = cached;
			warm.delete(id!);
			worker.busy = true;
		} else worker = Worker.start(plan, options, fingerprint);

		let settle!: (value: Response | Error) => void;
		const outcome = new Promise<Response | Error>((done) => (settle = done));
		const turn: Turn = { frames: plan.frames, environment, used: false, abort: new AbortController(), settle };
		worker.turn = turn;
		const abort = () => {
			turn.abort.abort();
			settle(signal.reason instanceof Error ? signal.reason : new DOMException("The request was aborted.", "AbortError"));
			worker.close();
		};
		signal.addEventListener("abort", abort, { once: true });
		const startTimer = setTimeout(() => settle(new Error("Claude Code did not send its request in time.")), options.startTimeoutMs ?? 60_000);
		const done = (keepAs?: string) => {
			signal.removeEventListener("abort", abort);
			clearTimeout(startTimer);
			if (keepAs !== undefined && id !== undefined && !worker.closed && !worker.exited && warm.size < MAX_WARM && !warm.has(id)) worker.keep(id, keepAs);
			else worker.close();
		};

		const before = worker.results;
		const acks = continuing ? 0 : plan.frames.filter((frame) => frame.shouldQuery === false).length;
		void (async () => {
			// History goes in one frame at a time; the CLI acknowledges each earlier user message.
			for (const frame of continuing ? plan.frames.slice(-1) : plan.frames) {
				const seen = worker.results;
				worker.write(frame);
				if (frame.shouldQuery !== false) continue;
				await worker.until(() => worker.results > seen);
				if (worker.failed) return settle(new Error("Claude Code rejected the conversation history."));
				if (worker.exited || worker.closed) return;
			}
		})().catch((error) => settle(error instanceof Error ? error : new Error(String(error))));

		const result = await outcome;
		clearTimeout(startTimer);
		if (result instanceof Error || !result.body || result.status !== 200) {
			done();
			if (result instanceof Error) throw result;
			return result;
		}
		if (id !== undefined && environment === undefined && turn.seen) {
			if (environments.size >= 200) environments.delete(environments.keys().next().value!);
			environments.set(id, { head, messages: turn.seen });
		}
		// The response is rho's now. Before it ends, hear from the CLI whether the turn was charged
		// to usage credits; then the process is kept for a plain continuation, or ended.
		const heard: Heard = { text: "", tool: false, complete: false };
		const reader = listen(result.body, heard).getReader();
		const watched = new ReadableStream<Uint8Array>({
			async pull(controller) {
				try {
					const { value, done: ended } = await reader.read();
					if (!ended) return controller.enqueue(value);
					await worker.until(() => worker.results > before + acks, 5_000);
					if (worker.overage && !options.allowUsageCredits) {
						controller.error(new Error(CREDITS_CHARGED));
						return done();
					}
					controller.close();
					const plain = heard.complete && !heard.tool && heard.stop === "end_turn" && worker.results > before + acks && !worker.failed;
					done(plain ? historyKey([...plan.frames, { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: heard.text }] } }]) : undefined);
				} catch (error) {
					controller.error(error);
					done();
				}
			},
			cancel(reason) {
				turn.abort.abort();
				done();
				return reader.cancel(reason);
			},
		});
		return new Response(watched, { status: result.status, headers: result.headers });
	};
	return send as typeof fetch;
}
