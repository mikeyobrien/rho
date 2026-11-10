// The rho core: one durable agent in one process. It opens storage, runs the conversation, and
// finishes whatever the last process left unfinished. Everything else (HTTP, the page, tools,
// memory) is added around this.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { createRegistry, defineDoc, Harness, type Conversation, type ConversationId, type Extension } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { HarnessOptions } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { homedir } from "node:os";
import { checkins as checkinFeature, type Reminder, type ReminderSpec } from "./checkins.ts";
import { projectExtension, type ContextOptions } from "./context.ts";
import { memoryExtension, NOTICE, openMemory, type MemoryProvider } from "./memory/provider.ts";
import { guard } from "./tools/guard.ts";
import { excludeFromSearch, SearchTools } from "./tools/search.ts";
import { tidy } from "./tools/tidy.ts";
import { webTools, type WebOptions } from "./tools/web.ts";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const context = BACKGROUND_CONTEXT;

export interface RhoConfig {
	/** `provider/modelId`. Default: Claude Opus 5.5 on the person's plan. */
	model?: string;
	/** The directory the first conversation works in. Default: the home directory. */
	cwd?: string;
	/** Memory: `{ "kind": "file" }` (default), `{ "kind": "honcho", "url": ... }` or `{ "kind": "off" }`. */
	memory?: unknown;
	/** Check-ins (reminders rho runs unattended). `false` turns them off. */
	checkins?: boolean | { maxTurns?: number };
	/** Most tool rounds one run takes before it stops and says so. Default: 200. */
	maxTurns?: number;
	/** Thinking level for new conversations. Default: medium. */
	thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}
export const DEFAULT_MODEL = "claude-code/claude-opus-5-5";
export const INSTRUCTIONS =
	"You are rho, an agent that runs on the person's own machine. Answer the question first, in plain words. " +
	"Keep answers short unless asked for depth. If something needs information or a tool you do not have, say so. " +
	"Spend the person's attention only where it changes the outcome. A report is a claim, not a fact: check the result " +
	"before you say it is done, and say done, partial or failed. Reversible work goes on; an action that cannot be undone " +
	"(a delete, a send, a push, a purchase) waits for the person's yes.";

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
	/** The reminder book; undefined when check-ins are off. */
	reminders?: { list(): Promise<Reminder[]>; add(spec: ReminderSpec): Promise<Reminder>; remove(id: string): Promise<Reminder | undefined>; stop(): Promise<boolean> };
	/** The first conversation; it always exists. */
	root: Conversation;
	rootId: string;
	conversations(): Promise<ConversationInfo[]>;
	/** One of the listed conversations, or undefined. */
	conversation(id: string): Promise<Conversation | undefined>;
	/** A new conversation with the configured model, working in `cwd` (default: the configured directory). */
	create(options?: { cwd?: string }): Promise<ConversationInfo>;
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
	const home = config.cwd ?? homedir();
	const registry = createRegistry();
	// Every tool, whoever brings it, takes the optional `reasoning` argument.
	for (const extension of [CodingTools /* read, write, edit, bash */, SearchTools /* grep, find, ls */, webTools(options.web) /* web_search, fetch_content */, ...(options.extensions ?? []), guard(options.dir)]) registry.install(tidy(extension));
	for (const dir of new Set([options.dir, realpathSync(options.dir)])) excludeFromSearch(dir);
	const memory = options.memory === undefined ? openMemory(config, { dir: options.dir, log }) : (options.memory ?? undefined);
	// Only the person's own conversations are mirrored to memory, not rho's side work.
	let persons: (id: string) => Promise<boolean> = async () => false;
	if (memory) registry.install(tidy(memoryExtension(memory, { log, capture: (id) => persons(id) })));
	log(`memory: ${memory?.label ?? "off"}`);
	const now = options.clock?.now ?? Date.now;
	const reminders = config.checkins === false ? undefined : checkinFeature({ now, log, noticeKind: NOTICE, maxTurns: typeof config.checkins === "object" ? config.checkins.maxTurns : undefined });
	if (reminders) registry.install(tidy(reminders.extension));
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
	const find = async (id: string): Promise<Conversation | undefined> => {
		const item = (await listed()).find((candidate) => candidate.id === id);
		return item ? harness.conversation(item.ref as unknown as ConversationId, context) : undefined;
	};
	// A run is bounded, in every conversation, also when the setting changed since it was made.
	for (const item of await listed()) {
		const conversation = await find(item.id);
		if (conversation && (await conversation.agent(context)).maxTurns !== maxTurns) await conversation.configure({ maxTurns }, context);
	}
	await reminders?.attach(harness, root, context); // before scheduling starts, so one task holds the book
	harness.resume();
	return {
		harness,
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
		close: () => harness.close(context).finally(release),
	};
}
