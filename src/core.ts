// The rho core: one durable agent in one process. It opens storage, runs the conversation, and
// finishes whatever the last process left unfinished. Everything else (HTTP, the page, tools,
// memory) is added around this.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { createRegistry, Harness, type Conversation, type Extension } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const context = BACKGROUND_CONTEXT;

export interface RhoConfig {
	/** `provider/modelId`. Default: Claude Opus 5.5 on the person's plan. */
	model?: string;
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
	log?: (line: string) => void;
	/** Called once if storage fails; the host should exit non-zero so its service runner reopens it. */
	onFailed?: (error: unknown) => void;
}
export interface Core {
	harness: Harness;
	root: Conversation;
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
	const registry = createRegistry();
	for (const extension of options.extensions ?? []) registry.install(extension);
	const harness = await Harness.open(
		await openNodeSqliteStorage(join(options.dir, "rho.sqlite")),
		{
			models: options.models,
			registry,
			identity: { attribution: { name: "rho", url: "https://rhobot.dev" } },
			// A run that fails does not strand the messages queued behind it: the next run takes them.
			settings: { afterFailedRun: "continue" },
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
	const config = options.config ?? {};
	// The agent choices are stored with the conversation on first use; later starts keep them.
	const root = await harness.root(context, { agent: { model: parseModel(config.model ?? DEFAULT_MODEL), thinkingLevel: config.thinking ?? "medium", instructions: INSTRUCTIONS } });
	harness.resume();
	return { harness, root, close: () => harness.close(context).finally(release) };
}
