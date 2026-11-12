// The reply counter: how often rho ends a reply by asking the person something.
//
// The person's attention is the scarce thing, and a reply that ends in two or three questions
// spends it. Rho's instructions say not to; this measures whether it holds. After each run in
// one of the person's own conversations, one line goes to `replies.jsonl` in the data
// directory: when, which conversation, how long the reply was, how many questions it held and
// how many of them were in its closing paragraph. No text of the reply is kept.
//
// It only counts. Nothing is blocked, changed or shown because of it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { defineExtension, GenerationTask, hook, type Extension } from "@earendil-works/pi-durable";
import { appendLine } from "./answers.ts";

const LOG = "replies.jsonl";
export interface ReplyLine {
	at: number;
	conversation: string;
	chars: number;
	/** Questions anywhere in the reply. */
	questions: number;
	/** Questions in its last paragraph: the ones the person is left holding. */
	closing: number;
}

/** A reply without what is quoted or code: a question mark in a command or a quotation is not a question to the person. */
const prose = (text: string): string => text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "").replace(/^\s*>.*$/gm, "");
const marks = (text: string): number => (text.match(/\?(?=["'”’)\]*_\s]|$)/g) ?? []).length;
/** How many questions a reply asks, and how many of them are in its closing paragraph. Pure. */
export function countQuestions(reply: string): { questions: number; closing: number } {
	const text = prose(reply).trim();
	const paragraphs = text.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
	return { questions: marks(text), closing: marks(paragraphs.at(-1) ?? "") };
}

type Content = string | { type: string; text?: string }[] | undefined;
const textOf = (content: Content): string => (typeof content === "string" ? content : (content ?? []).map((part) => (part.type === "text" ? (part.text ?? "") : "")).join(""));

export interface ReplyCounterOptions {
	/** Whose replies are counted: the person's own conversations, not a worker's or a check-in's. */
	counts: (conversationId: string) => boolean | Promise<boolean>;
	now?: () => number;
	log?: (line: string) => void;
}
/** The `replies` extension: one log line per answered run. Never throws into the run. */
export function replyCounter(dir: string, options: ReplyCounterOptions): Extension {
	return defineExtension({
		name: "replies",
		hooks: [
			hook(GenerationTask, {
				afterRun: async (run, api, context: Context) => {
					try {
						const conversation = String(api.conversationId);
						if (!(await options.counts(conversation))) return undefined;
						const page = await api.entries({ minEntryId: run.answer, maxEntryId: run.answer, order: "ascending" }, 1, undefined, context);
						const reply = textOf((page.items[0]?.model?.[0] as { content?: Content } | undefined)?.content);
						if (reply.trim() === "") return undefined;
						const line: ReplyLine = { at: (options.now ?? Date.now)(), conversation, chars: reply.length, ...countQuestions(reply) };
						appendLine(join(dir, LOG), JSON.stringify(line));
					} catch (error) {
						options.log?.(`replies: could not count a reply: ${String((error as Error)?.message ?? error)}`);
					}
					return undefined;
				},
			}),
		],
	});
}

export function readReplies(dir: string): ReplyLine[] {
	const path = join(dir, LOG);
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8").split("\n").flatMap((text) => {
		try {
			return text.trim() === "" ? [] : [JSON.parse(text) as ReplyLine];
		} catch {
			return []; // a line cut short by a kill
		}
	});
}

/** The log in words: how many replies ended by asking, over all of it and over the newest ones. */
export function describeReplies(lines: ReplyLine[], last = 0): string {
	if (lines.length === 0) return "No replies counted yet. A line is kept for each reply rho gives in one of your conversations.";
	const part = (some: ReplyLine[], label: string): string => {
		const asked = some.filter((line) => line.closing > 0);
		const total = some.reduce((sum, line) => sum + line.closing, 0);
		return `${label}: ${some.length} ${some.length === 1 ? "reply" : "replies"}, ${asked.length} ended by asking (${Math.round((asked.length / some.length) * 100)}%), ${total} closing ${total === 1 ? "question" : "questions"} in all.`;
	};
	const out = [part(lines, "All")];
	if (lines.length > 20) out.push(part(lines.slice(-20), "Newest 20"));
	for (const line of last > 0 ? lines.slice(-last) : []) out.push(`${new Date(line.at).toISOString().slice(0, 16).replace("T", " ")} · ${line.chars} characters · ${line.questions} asked, ${line.closing} at the end`);
	return out.join("\n");
}
