// The rho core: one durable agent in one process. It opens storage, runs the conversation, and
// finishes whatever the last process left unfinished. Everything else (HTTP, the page, tools,
// memory) is added around this.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { createRegistry, defineDoc, Harness, LiveDoc, type Conversation, type ConversationId, type Extension } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { HarnessOptions } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { homedir } from "node:os";
import { checkins as checkinFeature, type Reminder, type ReminderSpec } from "./checkins.ts";
import { projectExtension, type ContextOptions } from "./context.ts";
import { openDecider, readDecider } from "./decider.ts";
import { entryView, textOf } from "./view.ts";
import { memoryExtension, NOTICE, openMemory, type MemoryProvider } from "./memory/provider.ts";
import { describeRelease } from "./gate.ts";
import { openPicks, readPickCheck } from "./picks.ts";
import { backgroundTool, Jobs, type BackgroundJob } from "./tools/background.ts";
import { delegateTool, live as liveWorker, localPlace, Workers, type Worker } from "./tools/delegate.ts";
import { commandCheck, guard, RELEASE, type Explain } from "./tools/guard.ts";
import { settingsTool } from "./tools/settings.ts";
import { excludeFromSearch, SearchTools } from "./tools/search.ts";
import { tidy } from "./tools/tidy.ts";
import { webTools, type WebOptions } from "./tools/web.ts";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

export const context = BACKGROUND_CONTEXT;

export interface RhoConfig {
	/** `provider/modelId`. Default: the first preferred model whose provider has an API key. */
	model?: string;
	/** Use the Claude Code login (the person's Claude plan) as a provider. Default: false. */
	claudePlan?: boolean;
	/** Servers that speak the OpenAI chat API: `[{ "id", "baseUrl", "models": [...] }]`. */
	providers?: unknown;
	/** The directory the first conversation works in. Default: the home directory. */
	cwd?: string;
	/** Memory: `{ "kind": "file" }` (default), `{ "kind": "honcho", "url": ... }` or `{ "kind": "off" }`. */
	memory?: unknown;
	/** A decision model that classifies each shell command: `{ "baseUrl": "http://127.0.0.1:8098", "model": "clef-flash" }`. It only watches and logs. Default: off. */
	decider?: unknown;
	/** Notifications when rho needs a yes, a run fails or a report arrives. `false` turns them off. */
	notifications?: boolean;
	/** Workers the agent hands whole jobs to. `false` leaves the tool out. `max`: how many run at once here (default 2). `maxTurns`: a worker's step limit (default 60). `check`: the model asked, in shadow, whether a worker's model fits the person's preferences (default claude-code/claude-haiku-5-5 when it can be used); `false` turns that off. */
	delegates?: boolean | { max?: number; maxTurns?: number; check?: unknown };
	/** The `background` tool: a shell command run outside the agent's turn. `false` leaves it out. */
	background?: boolean;
	/** Check-ins (reminders rho runs unattended). `false` turns them off. */
	checkins?: boolean | { maxTurns?: number };
	/** Most tool rounds one run takes before it stops and says so. Default: 200. */
	maxTurns?: number;
	/** Thinking level for new conversations. Default: medium. */
	thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}
/** The model named when none is configured and no key is set yet. */
export const DEFAULT_MODEL = "anthropic/claude-sonnet-5-5";
export const INSTRUCTIONS =
	"You are rho, an agent that runs on the person's own machine. Answer the question first, in plain words. " +
	"Keep answers short unless asked for depth. If something needs information or a tool you do not have, say so. " +
	"Spend the person's attention only where it changes the outcome. A report is a claim, not a fact: check the result " +
	"before you say it is done, and say done, partial or failed. Reversible work goes on; an action that cannot be undone " +
	"(a delete, a send, a push, a purchase) waits for the person's yes. " +
	// Asked by the owner 2026-11-12: a reply that ends in questions spends their attention.
	"Do not end a reply with questions. When a choice is open and can be undone, take the careful option, say in one line which you took, and go on. " +
	"Ask only when a wrong guess could not be cheaply undone: then ask one thing, with what you would do by default, and with only as much background as the person does not already have from the last few messages. " +
	// Asked by the owner 2026-11-12: a message sent while rho works is just a message, with no mode to choose.
	"When the person says something while you are working, hear it as a chief of staff hears a remark mid-task: if it changes the work in hand, change course; " +
	"if it is a new matter, finish or set down what you are doing as fits, and say in one line which you did. Never ask them whether to do it now or later.";

/** `<dataDir>/config.json`. A file that does not parse is a log line, never a stop. */
export function readConfig(dir: string, log: (line: string) => void = () => {}): RhoConfig {
	const path = join(dir, "config.json");
	if (!existsSync(path)) return {};
	try {
		const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (typeof value === "object" && value !== null && !Array.isArray(value)) return value as RhoConfig;
		log(`config: ${path} is not an object and was ignored.`);
	} catch (error) {
		log(`config: ${path} is not JSON and was ignored: ${(error as Error).message}`);
	}
	return {};
}

/** `provider/modelId`, where the model id may itself contain slashes. */
export function parseModel(value: string): { provider: string; modelId: string } {
	const cut = value.indexOf("/");
	if (cut <= 0 || cut === value.length - 1) throw new Error(`A model is written provider/model, for example ${DEFAULT_MODEL}. Got: ${value}`);
	return { provider: value.slice(0, cut), modelId: value.slice(cut + 1) };
}

export interface CoreOptions {
	dir: string;
	models: Models;
	config?: RhoConfig;
	extensions?: readonly Extension[];
	/** The memory provider to use instead of the configured one; `null` for none. Tests set it. */
	memory?: MemoryProvider | null;
	/** The clock and timers everything durable runs on. Tests change it. */
	clock?: { now: () => number; setTimer?: HarnessOptions["setTimer"] };
	/** The project-context section's clock. Tests change it. */
	context?: ContextOptions;
	/** The checkout rho runs from, which a release switches. Default: this one. Tests change it. */
	releaseDir?: string;
	/** Free memory, in bytes, as the place a worker runs asks for it. Tests change it. */
	freeMemory?: () => number;
	/** How often a waiting worker looks for a slot. Tests change it. */
	workerRetryMs?: number;
	/** How the decider is reached. Tests change it. */
	deciderFetch?: typeof fetch;
	/** How the web tools reach the web. Tests change it. */
	web?: WebOptions;
	/** Where tools touch files and run commands. Default: this machine, in the conversation's directory. Tests change it. */
	env?: (cwd: string) => ExecutionEnv;
	log?: (line: string) => void;
	/** Called once if storage fails; the host should exit non-zero so its service runner reopens it. */
	onFailed?: (error: unknown) => void;
}
/** One of the person's conversations. Each has its own thread, directory and model. */
export type ConversationInfo = { id: string; title: string; createdAt: number };
/** The person's conversations, oldest first. Conversations that tasks own are not in it. */
const Conversations = defineDoc<{ items: (ConversationInfo & { ref: string | number })[] }>({ kind: "rho.conversations", version: 1, scope: "session", initial: () => ({ items: [] }), checkpointWhen: () => true });

export interface Core {
	harness: Harness;
	/** Resolves when the decider has logged every command it was shown; undefined when it is off. */
	deciderIdle?: () => Promise<void>;
	/** Resolves when every pick shown to the pick check has been logged; undefined when it is off. */
	picksIdle?: () => Promise<void>;
	/** The reminder book; undefined when check-ins are off. */
	reminders?: { list(): Promise<Reminder[]>; add(spec: ReminderSpec): Promise<Reminder>; remove(id: string): Promise<Reminder | undefined>; stop(): Promise<boolean> };
	/** The memory provider in use, to name and to read; undefined when memory is off. */
	memory?: Pick<MemoryProvider, "label" | "lists">;
	/** The first conversation; it always exists. */
	root: Conversation;
	rootId: string;
	conversations(): Promise<ConversationInfo[]>;
	/** One of the listed conversations, or undefined. */
	conversation(id: string): Promise<Conversation | undefined>;
	/** A new conversation with the configured model, working in `cwd` (default: the configured directory). */
	create(options?: { cwd?: string }): Promise<ConversationInfo>;
	/** The workers the agent handed jobs to: live ones and those that ended lately. */
	workers: { list(): Promise<Worker[]>; /** End one. False when it is not running or waiting. */ stop(id: string): Promise<boolean>; /** Told after each change to the list. Returns how to stop being told. */ onChange(listener: () => void): () => void };
	/** The shell command running outside the agent's turn, if one is. */
	background: { running(): Promise<BackgroundJob | undefined>; /** End it. False when none runs. */ stop(): Promise<boolean> };
	/** Whether a conversation is one of the person's own (not a worker's or a check-in's). */
	persons(id: string): Promise<boolean>;
	/** Put a message the person did not write into a conversation: a gate report, a check-in. The model reads it; memory never takes it as the person's words. */
	notice(conversation: Conversation, text: string, requestId: string, from: string): Promise<string>;
	/** Name a conversation that has no name yet, from its first message. */
	title(id: string, text: string): Promise<void>;
	close(): Promise<void>;
}

const startOf = (pid: number): string => {
	try {
		return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ").at(-1)!.split(" ")[19] ?? "";
	} catch {
		return ""; // no /proc (macOS): the pid alone decides
	}
};
/**
 * One process owns the data. The lock names its owner's pid and start time, so a lock left by
 * a killed rho, or by a pid the system has since given to something else, is taken over.
 */
function own(dir: string): () => void {
	const path = join(dir, "rho.lock");
	const mine = `${process.pid} ${startOf(process.pid)}`;
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			writeFileSync(path, mine, { flag: "wx", mode: 0o600 });
			return () => {
				try {
					if (readFileSync(path, "utf8") === mine) rmSync(path);
				} catch {
					// already gone
				}
			};
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const [pid = "", start = ""] = readFileSync(path, "utf8").split(" ");
			let alive = false;
			try {
				process.kill(Number(pid), 0);
				alive = start === "" || startOf(Number(pid)) === start;
			} catch {
				// no such process, or not ours
			}
			if (alive) throw new Error(`Another rho (pid ${pid}) already runs on ${dir}. One process owns the data.`);
			rmSync(path, { force: true });
		}
	}
	throw new Error(`Could not take the lock in ${dir}.`);
}

/** Open the agent on `dir` and continue any run the last process left. */
export async function openCore(options: CoreOptions): Promise<Core> {
	const log = options.log ?? (() => {});
	mkdirSync(options.dir, { recursive: true, mode: 0o700 });
	const release = own(options.dir);
	const config = options.config ?? {};
	// `~` is the home directory here as in a shell; a config file has no shell to expand it.
	const home = (config.cwd ?? homedir()).replace(/^~(?=\/|$)/, homedir());
	const registry = createRegistry();
	// The decider is shown each shell command with the person's last message. It watches; it blocks nothing.
	const deciderConfig = readDecider(config.decider, log);
	let asked: (id: string) => Promise<string | undefined> = async () => undefined;
	const decider = deciderConfig ? openDecider(deciderConfig, options.dir, { log, asked: (id) => asked(id), ...(options.clock ? { now: options.clock.now } : {}), ...(options.deciderFetch ? { fetch: options.deciderFetch } : {}) }) : undefined;
	if (deciderConfig) log(`decider: ${deciderConfig.model} at ${deciderConfig.baseUrl}, shadow (it logs and blocks nothing)`);
	const watch = decider && ((seen: Parameters<typeof decider.watch>[0]) => decider.watch(seen));
	// A release that waits for a yes says what it would bring in.
	const releaseDir = options.releaseDir ?? resolve(import.meta.dir, "..");
	const explain: Explain = async (ask) => (ask.what === RELEASE && ask.cwd ? describeRelease(releaseDir, ask.cwd, ask.command) : undefined);
	// Marked before the guard is made, and unmarked when this core closes (see protected.ts).
	const unprotect = [...new Set([options.dir, realpathSync(options.dir)])].map((dir) => excludeFromSearch(dir));
	// Every tool, whoever brings it, takes the optional `reasoning` argument.
	for (const extension of [CodingTools /* read, write, edit, bash */, SearchTools /* grep, find, ls */, webTools(options.web) /* web_search, fetch_content */, ...(options.extensions ?? []), settingsTool(options.dir, { persons: (id) => persons(id) }) /* settings */, guard(options.dir, (id) => asks(id), watch, explain)]) registry.install(tidy(extension));
	// Only the person's own conversations are mirrored to memory or may ask for a yes, not rho's side work.
	let persons: (id: string) => Promise<boolean> = async () => false;
	const memory = options.memory === undefined ? openMemory(config, { dir: options.dir, log }) : (options.memory ?? undefined);
	if (memory) registry.install(tidy(memoryExtension(memory, { log, capture: (id) => persons(id) })));
	log(`memory: ${memory?.label ?? "off"}`);
	const now = options.clock?.now ?? Date.now;
	const reminders = config.checkins === false ? undefined : checkinFeature({ now, log, noticeKind: NOTICE, maxTurns: typeof config.checkins === "object" ? config.checkins.maxTurns : undefined });
	if (reminders) registry.install(tidy(reminders.extension));
	// A command that runs outside the agent's turn, judged by the guard as `bash` is. `false` in the config leaves it out.
	// Who can be asked for a yes: the person's own conversations, and a worker that is still at work (its card is shown in the thread that handed it the job).
	let asks: (conversation: string) => Promise<boolean> = async () => true;
	const workerListeners = new Set<() => void>();
	let peekWorker: (worker: Worker) => Promise<string> = async () => "";
	let deliverWorker: (worker: Worker, text: string) => Promise<void> = async () => undefined;
	let endTask: (task: never, ctx: typeof context) => Promise<unknown> = async () => undefined;
	if (config.background !== false) registry.install(tidy(backgroundTool({ check: (args, api, ctx) => commandCheck(options.dir)(args, api, ctx), noticeKind: NOTICE, changed: () => workerListeners.forEach((listener) => listener()), stop: (task, ctx) => endTask(task as never, ctx), now, log })));
	// A whole job handed to a worker: a second agent in its own conversation, which cannot delegate or start background commands.
	const workers = typeof config.delegates === "object" && config.delegates !== null ? config.delegates : {};
	// Each handoff made while the person has model preferences is logged, with what a small model says of the pick. It watches; it blocks nothing.
	const pickCheck = config.delegates === false || !memory?.preferences ? undefined : readPickCheck(workers.check, log);
	const picks = pickCheck ? openPicks(pickCheck, options.dir, { models: options.models, now, log }) : undefined;
	if (config.delegates !== false) registry.install(tidy(delegateTool({ ...(memory?.preferences ? { preferences: () => memory.preferences!() } : {}), ...(picks ? { checkPick: (pick) => picks.watch(pick) } : {}), place: localPlace({ ...(Number.isInteger(workers.max) && workers.max! >= 1 ? { ceiling: workers.max! } : {}), ...(options.freeMemory ? { free: options.freeMemory } : {}) }), noticeKind: NOTICE, maxTurns: Number.isInteger(workers.maxTurns) && workers.maxTurns! >= 1 ? workers.maxTurns! : 60, withhold: ["background", "settings", "reminder"], stop: (task, ctx) => endTask(task as never, ctx), now, log, changed: () => workerListeners.forEach((listener) => listener()), peek: (worker) => peekWorker(worker), deliver: (worker, text) => deliverWorker(worker, text), ...(options.workerRetryMs ? { retryMs: options.workerRetryMs } : {}) })));
	// The person's standing instructions live beside rho's data, where the agent cannot rewrite them.
	registry.install(projectExtension(home, { personal: join(options.dir, "AGENTS.md"), ...options.context }));
	const harness = await Harness.open(
		await openNodeSqliteStorage(join(options.dir, "rho.sqlite")),
		{
			models: options.models,
			registry,
			identity: { attribution: { name: "rho", url: "https://rhobot.dev" } },
			// A run that fails does not strand the messages queued behind it: the next run takes them.
			settings: { afterFailedRun: "continue" },
			...(options.clock ? { now: options.clock.now, ...(options.clock.setTimer ? { setTimer: options.clock.setTimer } : {}) } : {}),
			// Each conversation's tools work in that conversation's own directory.
			env: ({ cwd }) => (options.env ?? ((dir: string) => new NodeExecutionEnv({ cwd: dir })))(cwd ?? home),
			onReport: (report) => {
				log(`report: ${report.kind}: ${String((report.error as Error | undefined)?.message ?? report.error ?? "").slice(0, 300)}`);
				if (report.kind === "storage_failed") options.onFailed?.(report.error);
			},
		},
		context,
	).catch((error) => {
		release();
		throw error;
	});
	// The agent choices are stored with each conversation when it is made; later starts keep them.
	const fresh = (cwd: string) => ({ model: parseModel(config.model ?? DEFAULT_MODEL), thinkingLevel: config.thinking ?? ("medium" as const), instructions: INSTRUCTIONS, cwd });
	const root = await harness.root(context, { agent: fresh(home) });
	const rootId = String(root.id);
	const maxTurns = Number.isInteger(config.maxTurns) && config.maxTurns! >= 1 ? config.maxTurns! : 200;
	const listed = async () => (await harness.snapshot(Conversations, context))?.items ?? [];
	const add = (conversation: Conversation) =>
		harness.commit(async (tx) => {
			const doc = await tx.doc(Conversations);
			const info = { id: String(conversation.id), ref: conversation.id as unknown as string | number, title: "", createdAt: Date.now() };
			if (!doc.items.some((item) => item.id === info.id)) doc.items.push(info);
			return { id: info.id, title: info.title, createdAt: info.createdAt };
		}, context);
	if (!(await listed()).some((item) => item.id === rootId)) await add(root);
	persons = async (id) => (await listed()).some((item) => item.id === id);
	const workerList = async (): Promise<Worker[]> => (await harness.snapshot(Workers, context))?.workers ?? [];
	// What a worker is on now, its last steps and its latest words, read from its own thread.
	peekWorker = async (worker) => {
		if (worker.conversation === undefined) return "";
		const thread = await harness.conversation(worker.conversation as unknown as ConversationId, context);
		if (!thread) return "";
		const views = (await thread.entries({ order: "descending" }, 30, undefined, context)).items.flatMap((entry) => entryView(entry) ?? []).reverse();
		const calls = new Map(views.flatMap((view) => (view.role === "assistant" ? view.calls : [])).map((call) => [call.id, call]));
		const target = (id: string): string => {
			const args = calls.get(id)?.args ?? {};
			const value = args.path ?? args.command ?? args.pattern ?? args.url ?? args.query ?? "";
			return typeof value === "string" && value !== "" ? ` ${value.split("\n")[0]!.slice(0, 100)}` : "";
		};
		const steps = views.flatMap((view) => (view.role === "tool" ? [`- ${view.name}${target(view.callId)}: ${view.error ? "failed, " : ""}${view.summary}`] : []));
		const running = ((await harness.snapshot(LiveDoc, worker.conversation as unknown as ConversationId, context))?.tools ?? []).filter((tool) => tool.status !== "done").map((tool) => `${tool.name}${target(tool.callId)}`);
		const words = views.findLast((view) => view.role === "assistant" && view.text.trim() !== "")?.text.trim();
		const total = views.filter((view) => view.role === "tool").length;
		return [
			...(running.length > 0 ? [`Now: ${running.join(", ")}`] : []),
			...(steps.length > 0 ? [`Its last ${Math.min(6, steps.length)} of ${total === 30 ? "30 or more" : total} steps:`, ...steps.slice(-6)] : running.length > 0 ? [] : ["It has finished no step yet: it may be on its first."]),
			...(words ? [`Its latest words: ${words.slice(0, 400)}`] : []),
		].join("\n");
	};
	// The same request id the worker's task uses for this message: sent twice, it is one request.
	deliverWorker = async (worker, text) => {
		const thread = worker.conversation === undefined ? undefined : await harness.conversation(worker.conversation as unknown as ConversationId, context);
		await thread?.submit({ type: "input", content: text, requestId: `worker-tell:${worker.id}:${(worker.told ?? []).length - 1}`, whenBusy: "steer" }, context);
	};
	asks = async (id) => (await persons(id)) || (await workerList()).some((worker) => liveWorker(worker) && String(worker.conversation) === id);
	// The newest message the person wrote themselves: a gate report or a check-in (another entry kind) is not their word.
	// Read once far back, then only what is new since: a cache a restart may lose.
	const lastAsked = new Map<string, { upTo: unknown; text?: string }>();
	asked = async (id) => {
		const known = lastAsked.get(id);
		const conversation = await harness.conversation(id as unknown as ConversationId, context);
		const page = await conversation?.entries({ order: "descending", ...(known ? { minEntryId: known.upTo as never } : {}) }, 400, undefined, context);
		const mine = page?.items.find((entry) => entry.kind === "pi.user" && entry.model?.[0]?.role === "user")?.model?.[0];
		const text = mine?.role === "user" ? textOf(mine.content).trim() || undefined : known?.text;
		if (page?.items[0]) lastAsked.set(id, { upTo: page.items[0].id, ...(text ? { text } : {}) });
		return text;
	};
	const find = async (id: string): Promise<Conversation | undefined> => {
		const item = (await listed()).find((candidate) => candidate.id === id);
		if (item) return harness.conversation(item.ref as unknown as ConversationId, context);
		// A worker's thread can be opened too, to read: it is not listed among the person's conversations.
		const worker = (await workerList()).find((candidate) => candidate.conversation !== undefined && String(candidate.conversation) === id);
		return worker ? harness.conversation(worker.conversation as unknown as ConversationId, context) : undefined;
	};
	// A run is bounded, in every conversation, also when the setting changed since it was made.
	for (const item of await listed()) {
		const conversation = await find(item.id);
		if (!conversation) continue;
		const agent = await conversation.agent(context);
		if (agent.maxTurns !== maxTurns) await conversation.configure({ maxTurns }, context);
		// A conversation keeps the instructions it was made with. They are rho's own text, with no way
		// for the person to set them per conversation, so a conversation made by an older rho takes
		// the current text at start: a rule added later holds in the thread the person already has.
		if (agent.instructions !== INSTRUCTIONS) await conversation.configure({ instructions: INSTRUCTIONS }, context);
	}
	// A conversation whose model cannot be used any more (its key is gone, its provider is off)
	// moves to the model of new conversations, when that one can be used.
	const usable = new Set((await options.models.getAvailable().catch(() => [])).map((model) => `${model.provider}/${model.id}`));
	const wanted = fresh(home).model;
	if (usable.has(`${wanted.provider}/${wanted.modelId}`)) {
		for (const item of await listed()) {
			const conversation = await find(item.id);
			const now = conversation && (await conversation.agent(context)).model;
			if (!conversation || !now || usable.has(`${now.provider}/${now.modelId}`)) continue;
			await conversation.configure({ model: wanted }, context);
			log(`models: ${now.provider}/${now.modelId} cannot be used; "${item.title || "the first conversation"}" now uses ${wanted.provider}/${wanted.modelId}.`);
		}
	}
	endTask = async (task, ctx) => {
		if ((await harness.abortTask(task, ctx)) !== "terminal") await harness.waitForTask(task, ctx);
	};
	await reminders?.attach(harness, root, context); // before scheduling starts, so one task holds the book
	harness.resume();
	return {
		harness,
		...(decider ? { deciderIdle: decider.idle } : {}),
		...(picks ? { picksIdle: picks.idle } : {}),
		...(memory ? { memory: { label: memory.label, ...(memory.lists ? { lists: () => memory.lists!() } : {}) } } : {}),
		reminders: reminders ? { list: reminders.list, add: reminders.add, remove: reminders.remove, stop: reminders.stop } : undefined,
		root,
		rootId,
		conversations: async () => (await listed()).map(({ id, title, createdAt }) => ({ id, title, createdAt })),
		conversation: find,
		// Two commits: a kill between them leaves a conversation nothing lists, which is harmless.
		create: async (made = {}) => add(await harness.createConversation({ ownership: { kind: "ownerless" }, agent: { ...fresh(made.cwd ?? home), maxTurns } }, context)),
		notice: async (conversation, text, requestId, from) =>
			String((await conversation.submit({ type: "input", content: text, requestId, whenBusy: "followUp", entry: { kind: NOTICE, data: { from } } }, context)).id),
		title: async (id, text) => {
			const words = (text.trim().split("\n")[0] ?? "").slice(0, 60);
			if (words === "" || (await listed()).find((item) => item.id === id)?.title !== "") return;
			await harness.commit(async (tx) => {
				const item = (await tx.doc(Conversations)).items.find((candidate) => candidate.id === id);
				if (item && item.title === "") item.title = words;
			}, context);
		},
		workers: {
			list: workerList,
			stop: async (id) => {
				const worker = (await workerList()).find((candidate) => candidate.id === id);
				if (!worker || !liveWorker(worker)) return false;
				await endTask(worker.task as never, context);
				log(`worker ${worker.id}: stopped by the person`);
				return true;
			},
			onChange: (listener) => (workerListeners.add(listener), () => void workerListeners.delete(listener)),
		},
		background: {
			running: async () => (await harness.snapshot(Jobs, context))?.running[0],
			stop: async () => {
				const job = (await harness.snapshot(Jobs, context))?.running[0];
				if (!job) return false;
				await endTask(job.task as never, context);
				log(`background: ${job.id} stopped by the person`);
				return true;
			},
		},
		persons: (id) => persons(id),
		close: () => harness.close(context).finally(() => (release(), unprotect.forEach((end) => end()))),
	};
}
