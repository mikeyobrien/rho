// The answer log: every time rho asked the person for a yes, and what they said. One line when a
// request is first shown, one when it is answered, in `answers.jsonl` in the data directory.
//
// It is the record of the person's own judgement: what they allow, what they refuse, how long a
// card waits, and what they never answer. Nothing reads it to decide anything yet. It is kept so
// that a threshold for the decider, or asking less often for a kind of command, can later rest on
// what the person did and not on a guess. The agent cannot read or change it (it is rho's data).
//
// It is a log beside the durable state, not part of it: a kill between a commit and its line loses
// that line, and the request then reads as not answered. Writing it never fails a command or an answer.
import { appendFileSync, closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { join } from "node:path";
import type { DecisionLine } from "./decider.ts";

export interface AnswerLine {
	at: number;
	event: "asked" | "allow" | "deny";
	/** The request's id: the tool call that first asked. The decider's log names the same call. */
	id: string;
	conversation: string;
	tool: string;
	/** The kind of thing asked for, as the card names it: "git push". */
	what: string;
	command: string;
	/** On an answer: how long the card waited. */
	waitedMs?: number;
}
const LOG = "answers.jsonl";

/**
 * Append one line to a log of lines. A kill can leave the last line cut short, with no line end;
 * the new line then starts on a line of its own, so it is not lost with the broken one.
 */
export function appendLine(path: string, text: string): void {
	let broken = false;
	try {
		const file = openSync(path, "r");
		try {
			const size = fstatSync(file).size;
			const last = Buffer.alloc(1);
			broken = size > 0 && readSync(file, last, 0, 1, size - 1) === 1 && last[0] !== 0x0a;
		} finally {
			closeSync(file);
		}
	} catch {
		// no file yet
	}
	appendFileSync(path, `${broken ? "\n" : ""}${text}\n`, { mode: 0o600 });
}

/** Append one line. Never throws: a log that cannot be written costs the line, nothing else. */
export function recordAnswer(dir: string, line: AnswerLine): void {
	try {
		appendLine(join(dir, LOG), JSON.stringify({ ...line, command: line.command.slice(0, 2_000), ...(line.waitedMs === undefined ? {} : { waitedMs: Math.max(0, Math.round(line.waitedMs)) }) }));
	} catch {
		// the request and its answer stand without it
	}
}

export function readAnswers(dir: string): AnswerLine[] {
	const path = join(dir, LOG);
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8").split("\n").flatMap((text) => {
		try {
			const line = text.trim() === "" ? undefined : (JSON.parse(text) as AnswerLine);
			return line && typeof line.id === "string" && typeof line.what === "string" ? [line] : [];
		} catch {
			return []; // a line cut short by a kill
		}
	});
}

interface Request { what: string; tool: string; command: string; answer?: "allow" | "deny"; waitedMs?: number }
const span = (ms: number): string => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);
const median = (values: number[]): number | undefined => (values.length === 0 ? undefined : [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]);
function counts(requests: Request[]): string {
	const allowed = requests.filter((request) => request.answer === "allow").length;
	const denied = requests.filter((request) => request.answer === "deny").length;
	const open = requests.length - allowed - denied;
	return [`${allowed} allowed`, ...(denied > 0 ? [`${denied} denied`] : []), ...(open > 0 ? [`${open} not answered`] : [])].join(" · ");
}

/** The log in words: how many requests, how they were answered, by kind, and by the decider's type where it saw the same call. */
export function describeAnswers(lines: AnswerLine[], decisions: DecisionLine[] = [], last = 0): string {
	if (lines.length === 0) return "No requests yet. A line is kept each time rho asks for your yes, and each time you answer.";
	const requests = new Map<string, Request>();
	for (const line of lines) {
		const request = requests.get(line.id) ?? { what: line.what, tool: line.tool, command: line.command };
		if (line.event !== "asked") Object.assign(request, { answer: line.event, ...(line.waitedMs === undefined ? {} : { waitedMs: line.waitedMs }) });
		requests.set(line.id, request);
	}
	const all = [...requests.values()];
	const out = [`${all.length} ${all.length === 1 ? "request" : "requests"}: ${counts(all)}.`];
	const kinds = new Map<string, Request[]>();
	for (const request of all) kinds.set(request.what, [...(kinds.get(request.what) ?? []), request]);
	for (const [what, group] of [...kinds].sort((a, b) => b[1].length - a[1].length)) {
		const wait = median(group.flatMap((request) => (request.waitedMs === undefined ? [] : [request.waitedMs])));
		out.push(`${what}: ${group.length} asked · ${counts(group)}${wait === undefined ? "" : ` · median wait ${span(wait)}`}`);
	}
	// The decider logs the same tool call under the same id, so its label and the person's answer meet here.
	const typed = new Map<string, Request[]>();
	for (const decision of decisions) {
		const request = decision.type ? requests.get(decision.call) : undefined;
		if (request) typed.set(decision.type!.is, [...(typed.get(decision.type!.is) ?? []), request]);
	}
	if (typed.size > 0) out.push(`By the decider's type: ${[...typed].sort((a, b) => b[1].length - a[1].length).map(([type, group]) => `${type} ${group.length} (${counts(group)})`).join("; ")}`);
	for (const line of last > 0 ? lines.slice(-last) : []) out.push(`${line.event}${line.waitedMs === undefined ? "" : ` after ${span(line.waitedMs)}`} · ${line.what} · ${line.command.split("\n")[0]!.slice(0, 70)}`);
	return out.join("\n");
}
