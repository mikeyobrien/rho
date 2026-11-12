// The ledger: what a worker asked and how it was settled, kept durably for the session.
//
// A worker never asks the person. Its question goes to the agent that handed it the job (the
// coordinator), with the default the worker goes on with; the worker does not wait. The
// coordinator answers it only from something recorded (what the person said, memory, a goal,
// an earlier answer) and names that basis, or leaves it, and the default stands. When the
// worker ends, every item of its still open is "defaulted", and its report lists each one as
// decided without the person.
//
// There is no budget and no rate limit here: the owner rejected the proposed numbers
// (2026-11-12). The only bound is how many items one worker may have open at once.
import { defineDoc } from "@earendil-works/pi-durable";

// Types, not interfaces: they are stored as JSON.
export type ItemStatus = "open" | "answered" | "defaulted";
export type LedgerItem = {
	/** Minted by the ledger: q1, q2, ... */
	id: string;
	/** Room for "change" later; only questions are built. */
	kind: "question";
	/** The worker that asked. */
	worker: string;
	/** The person's conversation the job came from, where the question is shown. */
	conversation: string;
	question: string;
	/** What the worker goes on with when nobody answers. */
	default: string;
	why?: string;
	askedAt: number;
	status: ItemStatus;
	/** Set when an answer was accepted, also one that came after the worker had ended. */
	answer?: { by: "coordinator" | "person"; text: string; basis: string; at: number };
	endedAt?: number;
};
type Book = { items: LedgerItem[]; seq: number };
export const Ledger = defineDoc<Book>({ kind: "rho.ledger", version: 1, scope: "session", initial: () => ({ items: [], seq: 0 }), checkpointWhen: () => true });

/** Ended items kept; open ones are always kept. */
export const KEPT_ITEMS = 100;
/** Most questions one worker may have open at once. */
export const MAX_OPEN = 3;
export const QUESTION_MAX = 300;
export const DEFAULT_MAX = 300;
export const WHY_MAX = 500;
export const ANSWER_MAX = 2_000;
export const BASIS_MAX = 500;

/** One line, at most `most` characters. */
export const oneLine = (text: string, most: number): string => {
	const line = text.trim().replace(/\s+/g, " ");
	return line.length > most ? `${line.slice(0, most - 1)}…` : line;
};
export const plainItem = (item: LedgerItem): LedgerItem => JSON.parse(JSON.stringify(item)) as LedgerItem;
/** Drop the oldest ended items past the bound. Assigns a new array of plain copies (never a draft stored again). */
export function trim(book: Book): void {
	const ended = book.items.filter((item) => item.status !== "open");
	if (ended.length <= KEPT_ITEMS) return;
	const kept = new Set(ended.slice(-KEPT_ITEMS).map((item) => item.id));
	book.items = book.items.filter((item) => item.status === "open" || kept.has(item.id)).map(plainItem);
}

/** What was settled without the person, one entry per item, for a report card. */
export type Decided = { question: string; done: string; by: "coordinator" | "person" | "default"; basis: string };
export const DECIDED_MAX = 20;
export function decidedOf(items: readonly LedgerItem[]): Decided[] {
	return items.slice(-DECIDED_MAX).map((item) =>
		item.status === "answered" && item.answer
			? { question: item.question, done: item.answer.text.slice(0, 300), by: item.answer.by, basis: item.answer.basis.slice(0, 300) }
			: { question: item.question, done: item.default, by: "default", basis: item.why ? `No answer came; the worker's reason: ${item.why.slice(0, 240)}` : "No answer came." },
	);
}
/** The same list in words, for the model. */
export function decidedText(decided: readonly Decided[]): string {
	if (decided.length === 0) return "";
	return `Decided without the person (${decided.length}):\n${decided.map((entry) => `- ${entry.question} → ${entry.done} (${entry.by === "default" ? "the worker's default" : `answered by the ${entry.by}`}; basis: ${entry.basis})`).join("\n")}`;
}
