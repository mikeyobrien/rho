// One model request on the person's Claude plan, sent through the Claude Code CLI.
//
// Rho owns the conversation and the tools. Claude Code owns the login. So the CLI is started
// for one turn with a throwaway prompt and pointed at a loopback relay. When it makes its
// request, the relay swaps in rho's own request (system prompt, messages, tools, thinking),
// keeps the CLI's authentication and its leading billing and identity lines, forwards it,
// and hands the response to rho. Nothing the CLI adds to the conversation (environment block,
// account email reminder) reaches the model, and the CLI never runs a tool.
//
// The login's headers pass through this process in memory for the length of one request.
// They are never logged or stored.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";

export interface RelayOptions {
	/** The CLI to run, with any leading arguments. Default: `RHO_CLAUDE`, then `claude` on PATH. */
	command?: string | readonly string[];
	/** Where requests go. Only tests change it. */
	upstream?: string;
	/** Longest the CLI may take to make its request, from spawn. */
	startTimeoutMs?: number;
	/** Let a turn that is billed as usage credits, not plan usage, go through. Default false. */
	allowUsageCredits?: boolean;
	env?: Record<string, string | undefined>;
}

const MARKER = "rho-relay-placeholder";
const QUIET = {
	ENABLE_TOOL_SEARCH: "false", DISABLE_AUTOUPDATER: "1", DISABLE_FEEDBACK_COMMAND: "1", DISABLE_ERROR_REPORTING: "1", DISABLE_TELEMETRY: "1",
	CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1", CLAUDE_CODE_DISABLE_FILE_MENTIONS: "1", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
	CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_MAX_RETRIES: "0", DISABLE_AUTO_COMPACT: "1",
	DISABLE_COMPACT: "1", CLAUDE_CODE_TOTAL_TOKENS_REMINDER: "off",
};
/** Settings that would send the request somewhere other than the person's plan. */
const CONFLICTS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"];

type Json = Record<string, unknown>;
/** The program and leading arguments that start the CLI. */
export function cliCommand(options: RelayOptions, env: Record<string, string | undefined>): [string, ...string[]] {
	const command = options.command ?? env.RHO_CLAUDE ?? "claude";
	const parts = typeof command === "string" ? [command] : [...command];
	return [parts[0] ?? "claude", ...parts.slice(1)];
}

const blocksOf = (system: unknown): Json[] => (Array.isArray(system) ? (system as Json[]) : typeof system === "string" && system !== "" ? [{ type: "text", text: system }] : []);

/** Rho's request, carrying only the CLI's leading system lines (billing, identity) and its metadata. */
export function mergeRequest(ours: Json, theirs: Json): Json {
	const lead: Json[] = [];
	for (const block of blocksOf(theirs.system)) {
		if (typeof block.text === "string" && block.text.includes(MARKER)) break;
		const { cache_control: _dropped, ...rest } = block; // rho's own blocks carry the cache marks
		lead.push(rest);
	}
	return { ...ours, system: [...lead, ...blocksOf(ours.system)], ...(theirs.metadata !== undefined ? { metadata: theirs.metadata } : {}) };
}

/**
 * True when the response says this turn is paid from usage credits, not the plan. On a plan
 * turn the unified status is "allowed" and overage is "rejected" or absent (seen 2026-11-10).
 * The exact headers of a credits turn were not observed; this reads the two forms Anthropic's
 * unified rate-limit headers use for it.
 */
export function chargedToCredits(headers: Headers): boolean {
	const overage = (headers.get("anthropic-ratelimit-unified-overage-status") ?? "").toLowerCase();
	const claim = (headers.get("anthropic-ratelimit-unified-representative-claim") ?? "").toLowerCase();
	return (headers.get("anthropic-ratelimit-unified-overage-in-use") ?? "").toLowerCase() === "true" || claim === "overage" || (overage === "allowed" && (headers.get("anthropic-ratelimit-unified-status") ?? "").toLowerCase() === "rejected");
}

function mergeBetas(a: string | null, b: string | null): string | undefined {
	const all = [...(a ?? "").split(","), ...(b ?? "").split(",")].map((part) => part.trim()).filter(Boolean);
	return all.length > 0 ? [...new Set(all)].join(",") : undefined;
}

function killTree(child: ChildProcess): void {
	if (child.pid === undefined || child.exitCode !== null) return;
	try {
		process.kill(-child.pid, "SIGKILL"); // the CLI may be a wrapper script: end its whole group
	} catch {
		child.kill("SIGKILL");
	}
}

/** A `fetch` for pi-ai's Anthropic adapter that sends each request through the CLI. */
export function relayFetch(options: RelayOptions = {}): typeof fetch {
	const send = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
		const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
		const signal = request.signal;
		signal.throwIfAborted();
		const ours = (await request.json()) as Json;
		const ourBetas = request.headers.get("anthropic-beta");
		const upstream = options.upstream ?? "https://api.anthropic.com";
		const secret = randomBytes(18).toString("base64url");

		let settle!: (value: Response | Error) => void;
		const outcome = new Promise<Response | Error>((resolve) => (settle = resolve));
		let used = false;
		let child: ChildProcess | undefined;
		let stderr = "";
		const upstreamAbort = new AbortController();

		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			idleTimeout: 0,
			async fetch(incoming) {
				const url = new URL(incoming.url);
				if (!url.pathname.startsWith(`/${secret}/`)) return new Response("not found", { status: 404 });
				if (incoming.method !== "POST" || !url.pathname.endsWith("/v1/messages")) return Response.json({ type: "error", error: { type: "not_found_error", message: "rho relays one model request only" } }, { status: 404 });
				// One request per turn. A second one is the CLI trying to go on by itself.
				if (used) return Response.json({ type: "error", error: { type: "invalid_request_error", message: "rho allows one model request per turn" } }, { status: 400 });
				used = true;
				try {
					const theirs = (await incoming.json()) as Json;
					const headers = new Headers(incoming.headers);
					for (const name of ["host", "content-length", "accept-encoding", "connection"]) headers.delete(name);
					const betas = mergeBetas(headers.get("anthropic-beta"), ourBetas);
					if (betas) headers.set("anthropic-beta", betas);
					const answer = await fetch(`${upstream}${url.pathname.slice(secret.length + 1)}${url.search}`, { method: "POST", headers, body: JSON.stringify(mergeRequest(ours, theirs)), signal: upstreamAbort.signal });
					const back = new Headers(answer.headers);
					for (const name of ["content-encoding", "content-length", "transfer-encoding", "connection"]) back.delete(name);
					if (chargedToCredits(answer.headers) && !options.allowUsageCredits) {
						upstreamAbort.abort();
						settle(new Error("Claude Code billing: this turn would be charged to usage credits, not the plan. Set allowUsageCredits to let it through."));
						return Response.json({ type: "error", error: { type: "invalid_request_error", message: "stopped by rho" } }, { status: 400 });
					}
					if (!answer.body) {
						settle(new Response(null, { status: answer.status, headers: back }));
						return new Response(null, { status: answer.status, headers: back });
					}
					const [mine, cli] = answer.body.tee();
					settle(new Response(mine, { status: answer.status, headers: back }));
					return new Response(cli, { status: answer.status, headers: back });
				} catch (error) {
					settle(error instanceof Error ? error : new Error(String(error)));
					return Response.json({ type: "error", error: { type: "api_error", message: "rho relay could not reach upstream" } }, { status: 502 });
				}
			},
		});

		const stop = () => {
			if (child) killTree(child);
			void server.stop(true);
		};
		const abort = () => {
			upstreamAbort.abort();
			settle(signal.reason instanceof Error ? signal.reason : new DOMException("The request was aborted.", "AbortError"));
			stop();
		};
		signal.addEventListener("abort", abort, { once: true });

		const base = { ...process.env, ...options.env } as Record<string, string | undefined>;
		for (const name of CONFLICTS) delete base[name];
		const env = { ...base, ...QUIET, ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}/${secret}` } as Record<string, string>;
		const args = ["-p", "--model", String(ours.model), "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--tools", "", "--system-prompt", MARKER,
			"--setting-sources", "", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}', "--disable-slash-commands", "--max-turns", "1", "--permission-mode", "dontAsk", "--no-session-persistence"];
		const [command, ...lead] = cliCommand(options, base);
		try {
			child = spawn(command, [...lead, ...args], { cwd: tmpdir(), env, detached: true, stdio: ["pipe", "ignore", "pipe"] });
		} catch (error) {
			stop();
			throw new Error(`Could not start Claude Code (${command}): ${(error as Error).message}`);
		}
		child.stderr?.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-2000)));
		child.on("error", (error) => settle(new Error(`Could not start Claude Code (${command}): ${error.message}`)));
		child.on("exit", (code) => {
			if (!used) settle(new Error(`Claude Code exited (${String(code)}) before sending a request. ${stderr.trim().slice(-400) || "Is it logged in? Run: claude auth status"}`));
		});
		child.stdin?.end(`${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "." }] } })}\n`);
		const startTimer = setTimeout(() => settle(new Error("Claude Code did not send its request in time.")), options.startTimeoutMs ?? 60_000);

		const result = await outcome;
		clearTimeout(startTimer);
		if (result instanceof Error) {
			signal.removeEventListener("abort", abort);
			stop();
			throw result;
		}
		// The response is rho's now. The CLI is only kept until the body has been read.
		const body = result.body;
		if (!body) {
			signal.removeEventListener("abort", abort);
			stop();
			return result;
		}
		const reader = body.getReader();
		const finish = () => {
			signal.removeEventListener("abort", abort);
			stop();
		};
		const watched = new ReadableStream<Uint8Array>({
			async pull(controller) {
				try {
					const { value, done } = await reader.read();
					if (done) {
						controller.close();
						finish();
					} else controller.enqueue(value);
				} catch (error) {
					controller.error(error);
					finish();
				}
			},
			cancel(reason) {
				upstreamAbort.abort();
				finish();
				return reader.cancel(reason);
			},
		});
		return new Response(watched, { status: result.status, headers: result.headers });
	};
	return send as typeof fetch;
}
