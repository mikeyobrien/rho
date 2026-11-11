// Memory: what rho knows about the person, kept across conversations and compactions.
// One provider is active, chosen by the `memory` key of the config. This file owns what every
// provider shares: the contract, the sticky prompt section, the capture of finished runs, and
// choosing the provider. The contract is pi-dobo's (packages/agent/src/memory.ts), so a
// provider written for one fits the other.
import type { Context } from "@earendil-works/chord/context";
import { defineExtension, GenerationTask, hook, section, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import { fileMemory, type FileMemoryConfig } from "./file.ts";
import { honchoMemory, type HonchoMemoryConfig } from "./honcho.ts";

/** One finished turn: the person's own words, or rho's final answer. */
export interface MemoryTurn {
	conversationId: string;
	role: "user" | "assistant";
	text: string;
}
export interface MemoryProvider {
	/** What the log calls it: "file", "honcho: 127.0.0.1:8000". */
	readonly label: string;
	/** The section text, without its tag. Called when a conversation starts and after a compaction, never per request. `undefined`: nothing to show now. */
	load(): Promise<string | undefined>;
	/** A finished turn, fire-and-forget: never throws, never delays the run. */
	observe?(turn: MemoryTurn): void;
	/** The person's preferences on which model suits which work, one a line, as they stand now (not as a conversation was shown them). Read when a job is handed to a worker. */
	preferences?(): Promise<string[]>;
	/** Tools that write the store. */
	readonly tools?: readonly ToolRegistration[];
}
export type MemoryConfig = ({ kind: "file" } & FileMemoryConfig) | ({ kind: "honcho" } & HonchoMemoryConfig) | { kind: "off" };

export const MEMORY_CONTRACT = 1;
/** The entry kind of a message that the person did not write: a gate report, a check-in. */
export const NOTICE = "rho.notice";
type Content = string | { type: string; text?: string }[] | undefined;
const textOf = (content: Content): string => (typeof content === "string" ? content : (content ?? []).map((part) => (part.type === "text" ? (part.text ?? "") : "")).join(""));

export interface MemoryExtensionOptions {
	log?: (line: string) => void;
	/** Whose runs are handed to `observe`: the person's own conversations, not rho's side work. Default: all. */
	capture?: (conversationId: string) => boolean | Promise<boolean>;
}

/**
 * The `memory` extension over `provider`.
 * - The section is sticky: once a conversation shows it, each request repeats those bytes, so a
 *   change in the store never costs a prompt-cache miss mid-conversation. A failed load shows
 *   nothing and the next request asks again: memory is a courtesy, the run is the product.
 * - After a run answers, the person's own messages of that run and the final answer go to
 *   `observe`. Messages the person did not write (kind `rho.notice`) are never handed over.
 */
export function memoryExtension(provider: MemoryProvider, options: MemoryExtensionOptions = {}): Extension {
	const log = options.log ?? (() => {});
	return defineExtension({
		name: "memory",
		tools: [...(provider.tools ?? [])],
		sections: [
			section(
				"memory",
				async ({ shown }) => {
					if (shown.memory !== undefined) return shown.memory;
					const text = await Promise.resolve()
						.then(() => provider.load())
						.catch((error: unknown) => (log(`memory: load failed (${provider.label}): ${(error as Error)?.message ?? error}`), undefined));
					return text === undefined ? undefined : `<memory>\n${text}\n</memory>`;
				},
				{ tag: false }, // wrapped here, so the shown text is the rendered text
			),
		],
		hooks: provider.observe
			? [
					hook(GenerationTask, {
						afterRun: async (run, api, context: Context) => {
							try {
								const conversationId = String(api.conversationId);
								if (options.capture && !(await options.capture(conversationId))) return undefined;
								const page = await api.entries({ minEntryId: run.first, maxEntryId: run.last, order: "ascending" }, 200, undefined, context);
								for (const entry of page.items) {
									const message = entry.model?.[0] as { role?: string; content?: Content } | undefined;
									if (entry.kind === "pi.user" && message?.role === "user") provider.observe!({ conversationId, role: "user", text: textOf(message.content) });
								}
								const answer = page.items.find((entry) => entry.id === run.answer)?.model?.[0] as { content?: Content } | undefined;
								const said = textOf(answer?.content);
								if (said.trim() !== "") provider.observe!({ conversationId, role: "assistant", text: said });
							} catch (error) {
								log(`memory: capture failed (${provider.label}): ${(error as Error)?.message ?? error}`);
							}
							return undefined;
						},
					}),
				]
			: [],
	});
}

/**
 * The provider the config names. No `memory` key: files on this machine. A wrong shape is a log
 * line and no memory, so a typo never stops rho.
 */
export function openMemory(config: { memory?: unknown }, host: { dir: string; log?: (line: string) => void; fetch?: typeof fetch }): MemoryProvider | undefined {
	const log = host.log ?? (() => {});
	const memory = (config.memory ?? { kind: "file" }) as Record<string, unknown>;
	if (typeof memory !== "object" || memory === null || Array.isArray(memory)) return log("memory is off: the memory key is not an object."), undefined;
	if (memory.kind === "off") return undefined;
	if (memory.kind === "file") return fileMemory(memory as FileMemoryConfig, host);
	if (memory.kind === "honcho") {
		if (typeof memory.url !== "string" || !/^https?:\/\//.test(memory.url)) return log("memory is off: honcho needs a url that starts with http:// or https://."), undefined;
		for (const key of ["workspace", "user", "agent"]) if (memory[key] !== undefined && !/^[A-Za-z0-9_-]{1,100}$/.test(String(memory[key]))) return log(`memory is off: honcho ${key} may hold letters, digits, - and _.`), undefined;
		return honchoMemory(memory as unknown as HonchoMemoryConfig, host);
	}
	return log(`memory is off: unknown kind ${JSON.stringify(memory.kind)}. Known: file, honcho, off.`), undefined;
}
