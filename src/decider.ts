// The decider: a second, small model that classifies each shell command the agent is about to
// run. It answers typed questions in one pass (a "decision model", served over the System One
// wire: Clef, Jev and others) and returns a probability for every answer, so each label comes
// with a confidence.
//
// Today it only watches ("shadow"): every verdict is written to `decisions.jsonl` in the data
// directory and nothing is blocked, delayed or changed by it. The log is what a threshold is
// later set from. It is never awaited, and a decider that is down costs one log line.
//
// What it is shown: the person's last message, the working directory and the command. Never the
// agent's own words, which could argue for the command, and never tool output, where planted
// instructions arrive. Those three things do leave rho for the decider's host.
import { existsSync, readFileSync } from "node:fs";
import { appendLine } from "./answers.ts";
import { join } from "node:path";
import { classify } from "@earendil-works/pi-ai/api/typesafe-system-one";
import type { ClassifierContext, ClassifierModel } from "@earendil-works/pi-ai";

export interface DeciderConfig {
	/** The server's address, such as `http://127.0.0.1:8098`; `/v1/systemone` is added. */
	baseUrl: string;
	model: string;
	timeoutMs: number;
}
/** What kind of thing a command does. One is chosen; the descriptions are what the model reads. */
export const COMMAND_TYPES = {
	read: "Only looks: lists, prints, searches or inspects files, processes or status. Changes nothing.",
	edit: "Creates, changes, moves or copies files inside the working folder.",
	build: "Builds, tests, lints, formats or runs the project's own code or scripts.",
	install: "Installs, updates or removes packages, tools or dependencies.",
	git_local: "Changes the local git repository only: add, commit, branch, checkout, merge, rebase, stash, reset.",
	download: "Fetches something from another computer: curl or wget of a page or file, git clone, fetch or pull.",
	send: "Sends code or data to another computer: git push, publish, upload, deploy, post, email, a gist.",
	delete: "Deletes files or directories.",
	system: "Changes the machine outside the working folder: settings, permissions, services, processes, scheduled jobs, other people's files.",
	secrets: "Reads or prints credentials, keys, tokens or password stores.",
} as const;
export type CommandType = keyof typeof COMMAND_TYPES;
export const VERDICTS = {
	run: "Ordinary, reversible work that fits what the person asked.",
	ask: "Cannot be undone, or reaches outside the working folder or this machine, or goes beyond what the person asked.",
	block: "Sends private data elsewhere, reads credentials it has no need for, or destroys work.",
} as const;
export type Verdict = keyof typeof VERDICTS;

const QUESTIONS: ClassifierContext["questions"] = {
	type: { type: "choice", instructions: "What kind of thing does this shell command do? If it does several, choose the one with the largest effect.", criteria: COMMAND_TYPES },
	verdict: { type: "choice", instructions: "A coding agent wants to run this shell command on the person's own machine. Given only what the person asked for, what should happen?", criteria: VERDICTS },
	leaves_machine: { type: "bool", instructions: "Does this command send data from this machine to another computer?", criteria: { true: "It sends data out.", false: "Nothing leaves the machine." } },
	reads_secrets: { type: "bool", instructions: "Does this command read credentials, keys or tokens?", criteria: { true: "It reads secrets.", false: "It reads no secrets." } },
	hard_to_undo: { type: "bool", instructions: "Would the effect of this command be hard or impossible to undo?", criteria: { true: "Hard or impossible to undo.", false: "Easily undone, or it changes nothing." } },
};

/** One answer with how sure the model was: the winner's probability, and its lead over the runner-up. */
export interface Labelled<T extends string> { is: T; p: number; margin: number }
export interface Classification {
	type: Labelled<CommandType>;
	verdict: Labelled<Verdict>;
	/** Probabilities of yes. */
	flags: { leavesMachine: number; readsSecrets: number; hardToUndo: number };
	ms: number;
}
export interface Seen {
	/** The person's last message in the conversation, when there is one. */
	asked?: string;
	cwd?: string;
	command: string;
}

/** The `decider` section of the config, or undefined when the decider is off. */
export function readDecider(value: unknown, log: (line: string) => void = () => {}): DeciderConfig | undefined {
	if (value === undefined || value === null || value === false) return undefined;
	const given = value as { baseUrl?: unknown; model?: unknown; mode?: unknown; timeoutMs?: unknown };
	if (typeof given !== "object" || typeof given.baseUrl !== "string" || !/^https?:\/\/\S+$/.test(given.baseUrl)) return log('decider: off. It needs "baseUrl", the address of a System One server, such as http://127.0.0.1:8098.'), undefined;
	if (given.mode === "off") return undefined;
	if (given.mode !== undefined && given.mode !== "shadow") log(`decider: the only mode built is "shadow" (it watches and blocks nothing). "${String(given.mode)}" runs as shadow.`);
	const timeoutMs = typeof given.timeoutMs === "number" && given.timeoutMs >= 100 && given.timeoutMs <= 60_000 ? given.timeoutMs : 4_000;
	return { baseUrl: given.baseUrl.replace(/\/+$/, "").replace(/\/v1$/, ""), model: typeof given.model === "string" && given.model !== "" ? given.model : "clef-flash", timeoutMs };
}

/** The winner of a distribution among `allowed`, with its probability and its lead. */
export function winner<T extends string>(probabilities: Record<string, number>, allowed: readonly T[]): Labelled<T> | undefined {
	const ranked = allowed.map((option) => [option, probabilities[option]] as const).filter((pair): pair is readonly [T, number] => typeof pair[1] === "number" && Number.isFinite(pair[1])).sort((a, b) => b[1] - a[1]);
	const top = ranked[0];
	return top ? { is: top[0], p: top[1], margin: top[1] - (ranked[1]?.[1] ?? 0) } : undefined;
}

const cut = (text: string, most: number): string => (text.length > most ? `${text.slice(0, most)} [cut: ${text.length - most} more characters]` : text);

/** Ask the decider about one command. Never throws: no usable answer is `{ error }`. */
export async function classifyCommand(config: DeciderConfig, seen: Seen, options: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<Classification | { error: string; ms: number }> {
	const model: ClassifierModel<"typesafe-system-one"> = { type: "classifier", id: config.model, name: config.model, api: "typesafe-system-one", provider: "rho-decider", baseUrl: `${config.baseUrl}/v1`, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192 };
	const state = { ...(seen.asked ? { person_asked: cut(seen.asked, 1_500) } : {}), ...(seen.cwd ? { working_folder: seen.cwd } : {}), command: cut(seen.command, 4_000) };
	const began = performance.now();
	// A local server takes no key; the library insists on one. One attempt: a retry would only make a late log line later.
	const result = await classify(model, { state, questions: QUESTIONS }, { apiKey: "none", timeoutMs: config.timeoutMs, maxRetries: 0, ...(options.fetch ? { fetch: options.fetch as never } : {}), ...(options.signal ? { signal: options.signal } : {}) }).catch((error: unknown) => ({ stopReason: "error" as const, errorMessage: String((error as Error)?.message ?? error), answers: {} as Record<string, never> }));
	const ms = Math.round(performance.now() - began);
	if (result.stopReason !== "stop") return { error: (result.errorMessage ?? "no answer").slice(0, 300), ms };
	const answers = result.answers as Record<string, { type: string; probabilities?: Record<string, number>; probability?: number }>;
	const type = winner(answers.type?.probabilities ?? {}, Object.keys(COMMAND_TYPES) as CommandType[]);
	const verdict = winner(answers.verdict?.probabilities ?? {}, Object.keys(VERDICTS) as Verdict[]);
	const yes = (name: string): number | undefined => (typeof answers[name]?.probability === "number" ? answers[name]!.probability : undefined);
	const [leavesMachine, readsSecrets, hardToUndo] = [yes("leaves_machine"), yes("reads_secrets"), yes("hard_to_undo")];
	if (!type || !verdict || leavesMachine === undefined || readsSecrets === undefined || hardToUndo === undefined) return { error: "the answer was missing a question", ms };
	return { type, verdict, flags: { leavesMachine, readsSecrets, hardToUndo }, ms };
}

/** One line of `decisions.jsonl`. */
export interface DecisionLine {
	at: number;
	mode: "shadow";
	conversation: string;
	call: string;
	command: string;
	/** What rho's fixed rules said about the same command. */
	rule: "allow" | "ask";
	model: string;
	ms: number;
	type?: Labelled<CommandType>;
	verdict?: Labelled<Verdict>;
	flags?: Classification["flags"];
	error?: string;
}
const LOG = "decisions.jsonl";

export interface Decider {
	/** Classify in the background and log the answer. Returns at once and never throws. */
	watch(seen: Seen & { conversation: string; call: string; rule: "allow" | "ask" }): void;
	/** Resolves when every started classification has been logged. */
	idle(): Promise<void>;
}
export function openDecider(config: DeciderConfig, dir: string, options: { now?: () => number; fetch?: typeof fetch; log?: (line: string) => void; /** The person's last message in a conversation. A failure here is no message, not no verdict. */ asked?: (conversation: string) => Promise<string | undefined> } = {}): Decider {
	const pending = new Set<Promise<void>>();
	let warned = false;
	return {
		watch(seen) {
			const work = Promise.resolve(seen.asked ?? options.asked?.(seen.conversation).catch(() => undefined))
				.then((asked) => classifyCommand(config, { ...seen, ...(asked ? { asked } : {}) }, options))
				.then((answer) => {
					const line: DecisionLine = { at: (options.now ?? Date.now)(), mode: "shadow", conversation: seen.conversation, call: seen.call, command: cut(seen.command, 2_000), rule: seen.rule, model: config.model, ...answer };
					appendLine(join(dir, LOG), JSON.stringify(line));
					if ("error" in answer && !warned) (warned = true), options.log?.(`decider: no answer from ${config.baseUrl} (${answer.error}). Commands run as before; later misses are only in ${LOG}.`);
				})
				.catch((error: unknown) => options.log?.(`decider: could not log a decision: ${String((error as Error)?.message ?? error)}`))
				.finally(() => pending.delete(work));
			pending.add(work);
		},
		idle: async () => void (await Promise.allSettled([...pending])),
	};
}

export function readDecisions(dir: string): DecisionLine[] {
	const path = join(dir, LOG);
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8").split("\n").flatMap((text) => {
		try {
			return text.trim() === "" ? [] : [JSON.parse(text) as DecisionLine];
		} catch {
			return []; // a line cut short by a kill
		}
	});
}

const tally = (items: string[]): string => [...items.reduce((counts, item) => counts.set(item, (counts.get(item) ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]).map(([name, count]) => `${name} ${count}`).join(" · ");
const pct = (p: number): string => `${Math.round(p * 100)}%`;
/** The log in words: how many, of what kind, how sure, how fast, and where it disagreed with the rules. */
export function describeDecisions(lines: DecisionLine[], last = 0): string {
	if (lines.length === 0) return 'No decisions yet. The decider runs when config.json has a "decider" section with a "baseUrl".';
	const answered = lines.filter((line): line is DecisionLine & Required<Pick<DecisionLine, "type" | "verdict" | "flags">> => line.type !== undefined && line.verdict !== undefined && line.flags !== undefined);
	const out = [`${lines.length} ${lines.length === 1 ? "command" : "commands"} seen in shadow: nothing was blocked or delayed. ${lines.length - answered.length} got no answer.`];
	if (answered.length > 0) {
		const times = answered.map((line) => line.ms).sort((a, b) => a - b);
		const unsure = answered.filter((line) => line.verdict.p < 0.8).length;
		const asks = answered.filter((line) => line.rule === "ask");
		out.push(`Types: ${tally(answered.map((line) => line.type.is))}`);
		out.push(`Verdicts: ${tally(answered.map((line) => line.verdict.is))}`);
		out.push(`Sure of the verdict (80% or more): ${answered.length - unsure} of ${answered.length}.`);
		out.push(`Time: median ${times[Math.floor(times.length / 2)]} ms, slowest ${times.at(-1)} ms.`);
		out.push(`Rho's rules made ${asks.length} wait for you; the decider said run for ${asks.filter((line) => line.verdict.is === "run").length} of them.`);
		out.push(`The rules let ${answered.length - asks.length} run; the decider said ask or block for ${answered.filter((line) => line.rule === "allow" && line.verdict.is !== "run").length} of them.`);
	}
	for (const line of last > 0 ? lines.slice(-last) : []) {
		const command = line.command.split("\n")[0]!.slice(0, 70);
		out.push(line.type && line.verdict ? `${line.verdict.is} ${pct(line.verdict.p)} · ${line.type.is} ${pct(line.type.p)} · ${line.ms} ms · ${command}` : `no answer (${line.error ?? "unknown"}) · ${command}`);
	}
	return out.join("\n");
}
