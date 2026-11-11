// The `delegate` tool: the agent hands a whole job to a worker and is free at once. The worker
// is a second agent in a conversation of its own, with the same tools, guard and working
// directory, and the same model and thinking unless the agent picks others for the job (guided
// by the person's model preferences, which the tool reads as they stand at the handoff). It starts from a brief and nothing else: it does not see the thread it came from.
// When it ends, what it reports reaches that thread once, as a message the person did not write.
//
// Where workers run is a "place". Today there is one, this machine. Each place has a cap, and
// a job past the cap waits its turn in order; it is not refused. The cap is the smaller of a
// ceiling the place declares and what the place can carry right now (see `capacity`).
//
// A job is a durable task. Its start is committed before anything runs, the worker's
// conversation is owned by the task, and its report is written in the commit that ends it: one
// report or none. Killed while the worker is answering, the next start goes on with the same
// worker (the conversation resumes; the same request id is the same request). A worker's
// commands are not run twice: an interrupted tool call is told to the worker's model, as in any
// conversation.
//
// A worker cannot delegate, and cannot start a background command of its own.
import { freemem } from "node:os";
import type { Context } from "@earendil-works/chord/context";
import { configure, defineDoc, defineExtension, defineTask, defineTool, type ConversationId, type Extension, type TaskId, type ToolRegistration } from "@earendil-works/pi-durable";
import { obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { Approvals } from "./guard.ts";

// Types, not interfaces: they are stored as JSON.
export type WorkerStatus = "waiting" | "working" | "asking" | "done" | "partial" | "failed" | "stopped";
export type Worker = {
	id: string;
	/** The job in one line, written by the agent. */
	title: string;
	place: string;
	status: WorkerStatus;
	/** The conversation that asked, and the worker's own once it has one. */
	from: string;
	conversation?: string | number;
	task: string | number;
	createdAt: number;
	startedAt?: number;
	endedAt?: number;
	/** Messages the agent sent it while it worked, in order. Each is a request of its own in the worker's thread. */
	told?: string[];
	/** Its work is over and its report is being written. */
	reporting?: boolean;
	/** What it runs on, `provider/id`, and its thinking level. Absent on a record older than the choice. */
	model?: string;
	thinking?: string;
	/** The agent chose the model or the thinking for this job; otherwise they are the asking conversation's. */
	picked?: boolean;
};
type Book = { workers: Worker[]; seq: number };
export const Workers = defineDoc<Book>({ kind: "rho.workers", version: 1, scope: "session", initial: () => ({ workers: [], seq: 0 }), checkpointWhen: () => true });
const KEPT = 30; // ended workers remembered
/** Not ended. A worker that waits for the person's yes ("asking") still holds its slot. */
export const live = (worker: Worker): boolean => worker.status === "waiting" || worker.status === "working" || worker.status === "asking";
const busy = (worker: Worker): boolean => worker.status === "working" || worker.status === "asking";
const plain = (worker: Worker): Worker => JSON.parse(JSON.stringify(worker)) as Worker;

/** How many workers a place may run at once, now. */
export interface Place {
	name: string;
	/** The most it ever runs at once. */
	ceiling: number;
	/** Whether it can take one more right now, beyond the count. A reason when it cannot. */
	room?(): string | undefined;
}
/** This machine: a ceiling from the config, and no new worker while free memory is low. */
export function localPlace(options: { ceiling?: number; minFreeBytes?: number; free?: () => number } = {}): Place {
	const floor = options.minFreeBytes ?? 600 * 1024 * 1024;
	const free = options.free ?? freemem;
	return {
		name: "local",
		ceiling: Math.max(1, Math.floor(options.ceiling ?? 2)),
		room: () => (free() < floor ? `this machine has ${Math.round(free() / 1024 / 1024)} MB of memory free, under the ${Math.round(floor / 1024 / 1024)} MB a worker is started with` : undefined),
	};
}

type State =
	| { phase: "wait" }
	/** `round` 0 gives the worker its brief; a later round gives it the person's answers, in `say`. */
	| { phase: "work"; round?: number; say?: string }
	/** The worker stopped at commands that need the person's yes: these wait on cards in the thread that asked. */
	| { phase: "ask"; round: number; commands: string[] }
	| { phase: "report"; outcome: "done" | "partial" | "failed"; text: string };
type Input = { id: string; title: string; brief: string; from: string | number; maxTurns: number; /** The model and thinking the worker runs on (the agent's pick, else the asking conversation's), and that conversation's directory and instructions at the handoff. */ agent: { model?: { provider: string; modelId: string }; thinking?: string; cwd?: string; instructions?: string } };

const BRIEF_HEAD =
	"You are a worker. Another agent handed you this job and is not watching; the person is not here either. Do the whole job yourself: read, change, run and check as it needs. " +
	"You cannot ask questions, so where the brief is silent choose the careful option and say what you chose. " +
	"The one exception: a command that cannot be undone is shown to the person for their yes. When a tool tells you a command waits for that, stop and say in one line what waits; you will be told their answer and go on from there. " +
	"End with a report for the agent that asked. Its first line is exactly one of: DONE, PARTIAL or FAILED. Then say what you did, what you checked and how, and what is left or uncertain. A report is a claim, not a fact: do not write DONE for what you did not check.";

export interface DelegateOptions {
	place: Place;
	/** The entry kind of a message the person did not write. */
	noticeKind: string;
	/** Most tool rounds a worker takes. */
	maxTurns: number;
	/** End a task of the harness, and wait until it has ended. */
	stop: (task: TaskId<null>, context: Context) => Promise<unknown>;
	/** Names of tools a worker does not get, beside `delegate` itself. */
	withhold?: readonly string[];
	now?: () => number;
	log?: (line: string) => void;
	/** How often a waiting job looks for room, and a worker for the person's answer. Tests change it. */
	retryMs?: number;
	/** Put the newest message for a worker into its thread now, so it is read at its next step and not only when its run ends. */
	deliver?: (worker: Worker, text: string) => Promise<void>;
	/** What a worker is doing and has lately done, in lines for the agent. */
	peek?: (worker: Worker) => Promise<string>;
	/** The person's model preferences as they stand now, one a line. None when there is no such list. */
	preferences?: () => Promise<string[]>;
	/** Shown each handoff made while preferences exist, to log it and what a checker says. It must return at once; what it throws is dropped. */
	checkPick?: (pick: { worker: string; conversation: string; title: string; brief: string; model: string; thinking?: string; picked: boolean; asked?: string; preferences: string[] }) => void;
	/** Told after every change to the workers' records, so a page can show it. A cache: a restart reads the records. */
	changed?: () => void;
}
export function delegateTool(options: DelegateOptions): Extension {
	const now = options.now ?? Date.now;
	const log = options.log ?? (() => {});
	const place = options.place;
	const changed = () => { try { options.changed?.(); } catch { /* a listener's failure is not the job's */ } };
	const textOf = (content: unknown): string => (typeof content === "string" ? content : Array.isArray(content) ? content.map((part: { type?: string; text?: string }) => (part.type === "text" ? (part.text ?? "") : "")).join("") : "");

	const Job = defineTask<Input, State, null>({
		name: "rho.worker",
		version: 1,
		initial: () => ({ phase: "wait" }),
		phases: {
			// Waiting for a slot. The first in line takes one when the place has room; the rest sleep and look again.
			wait: async (task, runtime, ctx) => {
				const full = place.room?.();
				// The worker is set up as the conversation that asked was when it handed the job off.
				const asker = task.input.agent;
				await runtime.commit(async (tx) => {
					const book = await tx.doc(Workers);
					const mine = book.workers.find((worker) => worker.id === task.input.id);
					if (!mine || mine.status !== "waiting") return { status: "terminal", outcome: { status: "completed", result: null } }; // stopped while it waited
					const working = book.workers.filter((worker) => worker.place === place.name && busy(worker)).length;
					const first = book.workers.find((worker) => worker.place === place.name && worker.status === "waiting")?.id === mine.id;
					if (!first || working >= place.ceiling || (full !== undefined && working > 0)) return { status: "sleeping", until: now() + (options.retryMs ?? 2_000), checkpoint: { phase: "wait" } };
					// A place with nothing running takes one job even when it reports no room: a job that can never start helps nobody.
					const made = await tx.createConversation({ ownership: { kind: "task", taskId: task.id } });
					// By name, as they are installed: the core wraps every tool, so the objects made here are not the installed ones.
					const withheld = new Set(["delegate", ...(options.withhold ?? [])]);
					await configure(tx, made.id, { ...(asker.model ? { model: asker.model } : {}), ...(asker.thinking ? { thinkingLevel: asker.thinking as never } : {}), ...(asker.cwd ? { cwd: asker.cwd } : {}), ...(asker.instructions ? { instructions: asker.instructions } : {}), maxTurns: task.input.maxTurns, tools: { remove: runtime.registry.tools().map((entry) => entry.tool).filter((installed) => withheld.has(installed.name)) } });
					mine.status = "working";
					mine.startedAt = now();
					mine.conversation = made.id as unknown as string | number;
					return { status: "running", checkpoint: { phase: "work" } };
				}, ctx);
				changed();
			},
			// The worker's run. The request id makes a rerun after a restart the same request, not a second one.
			work: async (task, runtime, ctx) => {
				const mine = ((await runtime.snapshot(Workers, ctx)) ?? { workers: [] as Worker[] }).workers.find((worker) => worker.id === task.input.id);
				const handle = mine?.conversation === undefined ? undefined : await runtime.conversation(mine.conversation as unknown as ConversationId, ctx);
				if (!handle) return void (await runtime.commit(() => ({ status: "running", checkpoint: { phase: "report", outcome: "failed", text: "The worker's conversation could not be opened." } }), ctx));
				const { round = 0, say } = task.state.checkpoint as Extract<State, { phase: "work" }>;
				const content = round === 0 ? `${BRIEF_HEAD}\n\nThe job:\n${task.input.brief}` : (say ?? "Go on.");
				let settled = await (await handle.submit({ type: "input", content, requestId: `worker:${task.input.id}${round === 0 ? "" : `:${round}`}` }, ctx)).wait(ctx);
				// Messages the agent sent meanwhile are requests of their own: each is waited for, and the newest answer is the
				// report. Sent again under the same id, a message is the same request, so one lost to a kill is not lost.
				const told = (((await runtime.snapshot(Workers, ctx)) ?? { workers: [] as Worker[] }).workers.find((worker) => worker.id === task.input.id)?.told ?? []).slice();
				for (const [n, text] of told.entries()) {
					const also = await (await handle.submit({ type: "input", content: tellText(text), requestId: `worker-tell:${task.input.id}:${n}`, whenBusy: "steer" }, ctx)).wait(ctx);
					if (also.status === "done" || settled.status !== "done") settled = also; // the newest answer is the report
				}
				await runtime.commit(async (tx) => {
					// One arrived after the last look: go round again, so it is not left unread behind a report.
					if (((await tx.doc(Workers)).workers.find((worker) => worker.id === task.input.id)?.told ?? []).length > told.length) return { status: "running", checkpoint: { phase: "work", round, ...(say === undefined ? {} : { say }) } };
					// It stopped at a command that needs the person's yes: the job is not over, it waits for them.
					const asked = (await tx.doc(Approvals, handle.id)).pending.map((pending) => pending.command);
					if (asked.length > 0) {
						const record = (await tx.doc(Workers)).workers.find((worker) => worker.id === task.input.id);
						if (record) record.status = "asking";
						return { status: "running", checkpoint: { phase: "ask", round, commands: asked } };
					}
					// From here the job is over and only its report is left: a message sent now would never be read, so it is refused.
					const closing = (await tx.doc(Workers)).workers.find((worker) => worker.id === task.input.id);
					if (closing) closing.reporting = true;
					if (settled.status === "done" && settled.type === "input") {
						const said = textOf(((await tx.entry(settled.answer))?.model?.[0] as { content?: unknown } | undefined)?.content).trim();
						const word = /^\W*(DONE|PARTIAL|FAILED)\b/i.exec(said)?.[1]?.toUpperCase();
						// A report that does not say how it ended is not taken as done.
						const outcome = word === "DONE" ? "done" : word === "FAILED" ? "failed" : "partial";
						return { status: "running", checkpoint: { phase: "report", outcome, text: said || "The worker ended without a report." } };
					}
					const why = "reason" in settled ? String(settled.reason).replace(/_/g, " ") : settled.status;
					const limit = "reason" in settled && settled.reason === "turn_limit";
					return { status: "running", checkpoint: { phase: "report", outcome: limit ? "partial" : "failed", text: limit ? `The worker stopped at its limit of ${task.input.maxTurns} steps without a report. What it changed is as it left it.` : `The worker did not finish (${why}).` } };
				}, ctx);
				changed();
			},
			// Waiting for the person. Their answer is taken off the card by the page; the worker is then told it and goes on.
			ask: async (task, runtime, ctx) => {
				const { round, commands } = task.state.checkpoint as Extract<State, { phase: "ask" }>;
				const mine = ((await runtime.snapshot(Workers, ctx)) ?? { workers: [] as Worker[] }).workers.find((worker) => worker.id === task.input.id);
				let answered = false;
				await runtime.commit(async (tx) => {
					const doc = await tx.doc(Approvals, mine!.conversation as unknown as ConversationId);
					const waiting = doc.pending.filter((pending) => commands.includes(pending.command));
					if (waiting.length > 0) return { status: "sleeping", until: now() + (options.retryMs ?? 2_000), checkpoint: { phase: "ask", round, commands } };
					// A yes left a grant for the exact command, which the guard takes when the worker runs it again.
					const say = commands.map((command) => (doc.granted.includes(command) ? `The person said yes. Run it: \`${command}\`` : `The person said no. Do not run: \`${command}\`. Do not try it another way; finish what can be finished without it and say so in your report.`)).join("\n");
					const record = (await tx.doc(Workers)).workers.find((worker) => worker.id === task.input.id);
					if (record) record.status = "working";
					answered = true;
					return { status: "running", checkpoint: { phase: "work", round: round + 1, say } };
				}, ctx);
				if (answered) changed();
			},
			// One commit ends the job and writes its report: one report, or none.
			report: async (task, runtime, ctx) => {
				const { outcome, text } = task.state.checkpoint as Extract<State, { phase: "report" }>;
				const handle = await runtime.conversation(task.input.from as unknown as ConversationId, ctx);
				const words = `[worker ${task.input.id}] ${task.input.title}\n${outcome === "done" ? "It reports done." : outcome === "partial" ? "It reports partial." : "It reports failed."} Its report follows; it is the worker's claim, not checked.\n\n${text.slice(0, 6_000)}`;
				await runtime.commit(async (tx) => {
					const book = await tx.doc(Workers);
					const mine = book.workers.find((worker) => worker.id === task.input.id);
					if (mine) {
						mine.status = outcome;
						mine.endedAt = now();
					}
					const ended = book.workers.filter((worker) => !live(worker));
					if (ended.length > KEPT) book.workers = book.workers.filter((worker) => live(worker) || ended.slice(-KEPT).includes(worker)).map(plain);
					if (handle) await handle.submit(tx, { type: "input", content: words, requestId: `worker-report:${task.input.id}`, whenBusy: "followUp", entry: { kind: options.noticeKind, data: { from: "worker", card: { kind: "report", title: task.input.title, verdict: outcome, who: `worker ${task.input.id}`, body: text.slice(0, 6_000) } } } });
					return { status: "terminal", outcome: { status: "completed", result: null } };
				}, ctx);
				log(`worker ${task.input.id}: ${outcome}`);
				changed();
			},
		},
		// Stopped: the worker's conversation is aborted with the task (it owns it), and nothing more is said.
		abort: async (task, runtime, ctx) => {
			await runtime.commit(async (tx) => {
				const mine = (await tx.doc(Workers)).workers.find((worker) => worker.id === task.input.id);
				if (mine && live(mine)) {
					mine.status = "stopped";
					mine.endedAt = now();
					// A card of its that still waits has nothing left to allow.
					if (mine.conversation !== undefined) (await tx.doc(Approvals, mine.conversation as unknown as ConversationId)).pending = [];
				}
				return { status: "terminal", outcome: { status: "aborted" } };
			}, ctx);
			changed();
		},
	});

	const tellText = (text: string): string => `From the agent that handed you this job: ${text}\n(Take this into account and go on. End, as before, with your report: DONE, PARTIAL or FAILED first.)`;
	const span = (ms: number): string => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min`);
	const line = (worker: Worker): string => `[${worker.id}] ${worker.status}${worker.status === "working" && worker.startedAt ? ` for ${span(now() - worker.startedAt)}` : worker.status === "waiting" ? " for a slot" : worker.status === "asking" ? " (needs the person's yes)" : ""} (${worker.place}${worker.model ? `, ${worker.model}${worker.picked && worker.thinking ? `, thinking ${worker.thinking}` : ""}` : ""}): ${worker.title}`;
	const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
	const nameOf = (model: { provider: string; id: string }): string => `${model.provider}/${model.id}`;
	const preferences = async (): Promise<string[]> => (await options.preferences?.().catch(() => [])) ?? [];
	const tool: ToolRegistration<any, any> = defineTool({
		name: "delegate",
		description:
			"Hand a whole job to a worker: a second agent with your tools and working directory, in its own thread. start {title, brief}: returns at once; the worker's report reaches you in a later message, once, so do not wait or poll. " +
			"The worker sees only the brief, not this conversation: write what the person asked, what you already know, what the worker owns, what to check, and what to report back. " +
			"Delegate a job that is long, stands alone and ends in a short result (run and fix the checks, a build, a change with its tests, 'find out X'). Do it yourself when it is a few steps, needs this conversation, or the person is waiting on the answer. " +
			"Do not split a job, with a worker that reads and you writing: delegate it whole or not at all. " +
			"start also takes model (provider/id) and thinking (off, minimal, low, medium, high, xhigh, max): with neither, the worker runs as you do. Choose them by the person's model preferences and by nothing else; pick a costlier model than your own only when a preference says so. " +
			"models: the person's preferences as they are now and the models that can be used; read it before you hand off a job if you have not in this conversation. " +
			"list: workers and their status. stop {id}: end one. A job past the limit waits its turn. " +
			"status {id}: what one is doing now, its last steps and latest words; for when the person asks how it is going, not a way to wait. " +
			"tell {id, message}: give a working worker a correction or a new fact; it reads it at its next step and still reports once.",
		parameters: obj({ action: oneOf(["start", "list", "stop", "status", "tell", "models"]), title: opt(str()), brief: opt(str()), id: opt(str()), message: opt(str()), model: opt(str()), thinking: opt(str()) }),
		execute: async (args, api, context: Context) => {
			const book = async (): Promise<Book> => (await api.snapshot(Workers, context)) ?? { workers: [], seq: 0 };
			if (args.action === "list") {
				const workers = (await book()).workers;
				const shown = [...workers.filter(live), ...workers.filter((worker) => !live(worker)).slice(-5).reverse()];
				return { output: [{ type: "text", text: shown.length === 0 ? "No workers." : shown.map(line).join("\n") }] };
			}
			if (args.action === "models") {
				const [wanted, known, mine] = [await preferences(), (await api.models.getAvailable()).map(nameOf), await api.agent(context)];
				const own = mine.model ? `${mine.model.provider}/${mine.model.modelId}` : "";
				return { output: [{ type: "text", text: `The person's model preferences:\n${wanted.length === 0 ? "(none yet: a worker runs as you do. When the person says which model suits which work, save it to memory in the models list.)" : wanted.map((entry) => `- ${entry}`).join("\n")}\n\nModels that can be used:\n${known.map((name) => `- ${name}${name === own ? " (yours)" : ""}`).join("\n") || "(none)"}\n\nYou run on ${own || "no model"}, thinking ${mine.thinkingLevel}. With no model and no thinking given, a worker does too.` }] };
			}
			if (args.action === "status") {
				const worker = (await book()).workers.find((candidate) => candidate.id === args.id);
				if (!worker) throw new Error(`No worker ${JSON.stringify(args.id ?? "")}. ${(await book()).workers.map(line).join("\n") || "There are none."}`);
				const seen = (await options.peek?.(worker).catch(() => "")) ?? "";
				return { output: [{ type: "text", text: `${line(worker)}${seen ? `\n${seen}` : ""}${live(worker) ? "\nIts report will reach you by itself: do not check again to wait for it." : ""}` }] };
			}
			if (args.action === "tell") {
				const message = (args.message ?? "").trim();
				if (message === "") throw new Error("message is required: what the worker should know or do differently.");
				if (message.length > 4_000) throw new Error("That message is too long (the most is 4,000 characters).");
				// Recorded in the commit that checks it is still working: the worker's own task then sends it and waits for it.
				const outcome = await api.commit(async (tx) => {
					const worker = (await tx.doc(Workers)).workers.find((candidate) => candidate.id === args.id);
					if (!worker) return "none" as const;
					if (worker.status !== "working") return worker.status;
					if (worker.reporting) return "reporting" as const;
					worker.told = [...(worker.told ?? []), message];
					return "told" as const;
				}, context);
				if (outcome === "none") throw new Error(`No worker ${JSON.stringify(args.id ?? "")}.`);
				if (outcome === "waiting") throw new Error(`Worker ${args.id} has not started: it waits for a slot. Stop it and hand the job off again with a brief that says this.`);
				if (outcome === "asking") throw new Error(`Worker ${args.id} waits for the person's yes on a command. It can be told once they have answered.`);
				if (outcome === "reporting") throw new Error(`Worker ${args.id} has just finished and its report is on its way. Read it, then hand off a new job if something is left.`);
				if (outcome !== "told") throw new Error(`Worker ${args.id} has already ended (${outcome}). Hand off a new job that says what is left.`);
				await options.deliver?.((await book()).workers.find((candidate) => candidate.id === args.id)!, tellText(message)).catch(() => undefined);
				log(`worker ${args.id}: told (${message.length} characters)`);
				return { output: [{ type: "text", text: `Worker ${args.id} will read that at its next step. It still reports once, when it ends.` }] };
			}
			if (args.action === "stop") {
				const worker = (await book()).workers.find((candidate) => candidate.id === args.id);
				if (!worker) throw new Error(`No worker ${JSON.stringify(args.id ?? "")}. ${(await book()).workers.filter(live).map(line).join("\n") || "None is running."}`);
				if (!live(worker)) return { output: [{ type: "text", text: `Worker ${worker.id} had already ended (${worker.status}).` }] };
				await options.stop(worker.task as unknown as TaskId<null>, context);
				log(`worker ${worker.id}: stopped by the agent`);
				return { output: [{ type: "text", text: `Stopped worker ${worker.id}: ${worker.title}. It reports nothing more; what it changed is as it left it.` }] };
			}
			const title = (args.title ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
			const brief = (args.brief ?? "").trim();
			if (title === "") throw new Error("title is required: the job in one line, for the person to read.");
			if (brief.length < 40) throw new Error("brief is required, and a few words are not one. The worker sees nothing of this conversation: say what the person asked, what you know, what the worker owns, what to check, and what to report.");
			if (brief.length > 20_000) throw new Error("That brief is too long (the most is 20,000 characters). Point the worker at files to read, do not paste them.");
			const mine = await api.agent(context);
			// The agent's pick, checked before anything is started: a worker on a model that cannot answer would only fail later.
			const wantedModel = (args.model ?? "").trim();
			const wantedThinking = (args.thinking ?? "").trim().toLowerCase();
			if (wantedThinking !== "" && !LEVELS.includes(wantedThinking)) throw new Error(`thinking is one of: ${LEVELS.join(", ")}. Got: ${wantedThinking}. Nothing was handed off.`);
			let chosen: { provider: string; modelId: string } | undefined;
			if (wantedModel !== "") {
				const known = await api.models.getAvailable();
				// Written provider/id; an id alone is taken when exactly one provider offers it.
				const exact = known.filter((model) => nameOf(model) === wantedModel);
				const found = exact.length > 0 ? exact : known.filter((model) => model.id === wantedModel);
				if (found.length !== 1) throw new Error(`The model ${JSON.stringify(wantedModel)} ${found.length > 1 ? "is offered by more than one provider: write it provider/id" : "is not available"}. Nothing was handed off. Available: ${known.map(nameOf).join(", ") || "none"}. Leave model out to use your own.`);
				chosen = { provider: found[0]!.provider, modelId: found[0]!.id };
			}
			const own = mine.model ? { provider: mine.model.provider, modelId: mine.model.modelId } : undefined;
			const runs = chosen ?? own;
			const runsOn = runs ? `${runs.provider}/${runs.modelId}` : "";
			const level = wantedThinking || mine.thinkingLevel;
			const picked = (chosen !== undefined && runsOn !== (own ? `${own.provider}/${own.modelId}` : "")) || (wantedThinking !== "" && wantedThinking !== mine.thinkingLevel);
			const wanted = await preferences();
			const agent: Input["agent"] = { ...(runs ? { model: runs } : {}), thinking: level, ...(mine.cwd ? { cwd: mine.cwd } : {}), ...(mine.instructions ? { instructions: mine.instructions } : {}) };
			const started = await api.commit(async (tx) => {
				const doc = await tx.doc(Workers);
				const waiting = doc.workers.filter((worker) => worker.place === place.name && worker.status === "waiting").length;
				const working = doc.workers.filter((worker) => worker.place === place.name && busy(worker)).length;
				if (waiting >= 10) return { id: "", ahead: waiting, refused: true };
				const id = `w${++doc.seq}`;
				const task = await tx.createTask(Job, { id, title, brief, from: api.conversationId as unknown as string | number, maxTurns: options.maxTurns, agent }, { ownership: { kind: "conversation" }, conversationId: api.conversationId, background: true });
				doc.workers = [...doc.workers.map(plain), { id, title, place: place.name, status: "waiting", from: String(api.conversationId), task: task as unknown as string | number, createdAt: now(), ...(runsOn ? { model: runsOn } : {}), ...(level ? { thinking: level } : {}), ...(picked ? { picked: true } : {}) }];
				return { id, ahead: waiting + Math.max(0, working - place.ceiling + 1), refused: false };
			}, context);
			if (started.refused) throw new Error(`Ten jobs are already waiting. Wait for some to end, or stop one.`);
			// Enough to judge the choice afterwards: what was handed off and how large the brief was.
			log(`worker ${started.id}: handed "${title}" (brief ${brief.length} characters, on ${runsOn || "no model"}${level ? ` thinking ${level}` : ""}, ${picked ? "picked for the job" : `the conversation's own${wanted.length > 0 ? `; nothing picked though ${wanted.length} model ${wanted.length === 1 ? "preference exists" : "preferences exist"}` : ""}`}${started.ahead > 0 ? `, waits behind ${started.ahead}` : ""})`);
			changed();
			// The pick is shown to a checker in shadow, when the person has given preferences. Not awaited: the handoff is already made.
			if (wanted.length > 0) {
				try {
					options.checkPick?.({ worker: started.id, conversation: String(api.conversationId), title, brief, model: runsOn, ...(level ? { thinking: level } : {}), picked, ...(own ? { asked: `${own.provider}/${own.modelId}` } : {}), preferences: wanted });
				} catch {
					// the check is a courtesy; the job is the product
				}
			}
			return { output: [{ type: "text", text: `Worker ${started.id} has the job${picked ? `, on ${runsOn}${wantedThinking ? ` with thinking ${level}` : ""}` : ""}${started.ahead > 0 ? `, and waits for a slot behind ${started.ahead} (this place runs ${place.ceiling} at once)` : ""}. Its report reaches you in a later message; go on with other work or answer the person now. Do not wait for it or check on it.${!picked && wanted.length > 0 ? ` It runs on ${runsOn}, as you do: the person has model preferences, and \`delegate models\` shows them for the next job.` : ""}` }] };
		},
	});
	return defineExtension({ name: "delegate", tasks: [Job], tools: [tool] });
}
