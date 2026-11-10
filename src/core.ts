// The rho core: one durable agent in one process. It opens storage, runs the conversation, and
// finishes whatever the last process left unfinished. Everything else (HTTP, the page, tools,
// memory) is added around this.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import { createRegistry, Harness, type Conversation, type Extension } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
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
	"Keep answers short unless asked for depth. If something needs information or a tool you do not have, say so.";

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

/** Open the agent on `dir` and continue any run the last process left. */
export async function openCore(options: CoreOptions): Promise<Core> {
	const log = options.log ?? (() => {});
	mkdirSync(options.dir, { recursive: true, mode: 0o700 });
	const registry = createRegistry();
	for (const extension of options.extensions ?? []) registry.install(extension);
	const harness = await Harness.open(
		await openNodeSqliteStorage(join(options.dir, "rho.sqlite")),
		{
			models: options.models,
			registry,
			identity: { attribution: { name: "rho", url: "https://rhobot.dev" } },
			onReport: (report) => {
				log(`report: ${report.kind}: ${String((report.error as Error | undefined)?.message ?? report.error ?? "").slice(0, 300)}`);
				if (report.kind === "storage_failed") options.onFailed?.(report.error);
			},
		},
		context,
	);
	const config = options.config ?? {};
	// The agent choices are stored with the conversation on first use; later starts keep them.
	const root = await harness.root(context, { agent: { model: parseModel(config.model ?? DEFAULT_MODEL), thinkingLevel: config.thinking ?? "medium", instructions: INSTRUCTIONS } });
	harness.resume();
	return { harness, root, close: () => harness.close(context) };
}
