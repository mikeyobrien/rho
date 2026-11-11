// The `background` tool: a shell command that runs outside the agent's turn. The agent starts
// it and is free at once; when the command ends, how it ended reaches the conversation as a
// message the person did not write, which the model reads on its next turn. It is for what takes
// a minute and needs no watching: the project's checks, a build, an install.
//
// It is not a second agent. Nothing reasons while the command runs, and the command is one the
// agent could have run with `bash`: it goes through the same guard, so a command that waits for
// the person's yes waits here too, and one the guard refuses is refused.
//
// One at a time: a second start while one runs is refused in words. The reason is the machine,
// not the design: on a phone, two test suites at once fail each other's timing.
//
// Durable in the way a tool call is. The job is a task of its own: its start is committed before
// the command runs, and its report is written in the commit that ends it, so there is exactly
// one report. A kill while the command runs loses the command (nothing owns a process once rho
// is dead); the next start then reports that it was interrupted, and does not run it again,
// because a command may not be safe to run twice.
import type { Context } from "@earendil-works/chord/context";
import { defineDoc, defineExtension, defineTask, defineTool, type Extension, type TaskId, type ToolRegistration } from "@earendil-works/pi-durable";
import { num, obj, oneOf, opt, str } from "@earendil-works/pi-schema";

/** The job that is running, if one is, and the last few that ended. Session-wide: one phone, one job. */
// Types, not interfaces: they are stored as JSON.
export type BackgroundJob = { id: string; command: string; conversation: string; startedAt: number; /** The task's id, kept as the engine gives it (a number in SQLite): as text it names no task. */ task: string | number };
export type EndedJob = { id: string; command: string; endedAt: number; ms: number; how: "passed" | "failed" | "timed out" | "interrupted" | "stopped"; exit?: number };
type Book = { running: BackgroundJob[]; ended: EndedJob[]; seq: number }; // `running` holds none or one
const Jobs = defineDoc<Book>({ kind: "rho.background", version: 1, scope: "session", initial: () => ({ running: [], ended: [], seq: 0 }), checkpointWhen: () => true });

type State = { phase: "run" } | { phase: "report"; how: EndedJob["how"]; exit?: number; tail: string; ms: number };
type Input = { id: string; command: string; timeoutSeconds: number; conversation: string | number };
const MAX_TAIL = 3_000;
const tailOf = (text: string): string => {
	const lines = text.trimEnd().split("\n");
	const kept = lines.slice(-40).join("\n");
	return kept.length > MAX_TAIL ? `…${kept.slice(-MAX_TAIL)}` : lines.length > 40 ? `… (${lines.length - 40} earlier lines left out)\n${kept}` : kept;
};
/** A plain copy of an ended job, for storing beside a new one. */
const plain = (job: EndedJob): EndedJob => ({ id: job.id, command: job.command, endedAt: job.endedAt, ms: job.ms, how: job.how, ...(job.exit === undefined ? {} : { exit: job.exit }) });
const span = (ms: number): string => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`);

export interface BackgroundOptions {
	/** The guard's check of a shell command: returns when it may run, throws when it is refused or waits for a yes. */
	check: (args: { command: string }, api: Parameters<ToolRegistration["execute"]>[1], context: Context) => Promise<void>;
	/** The entry kind of a message the person did not write. */
	noticeKind: string;
	/** End a task of the harness. */
	stop: (task: TaskId<null>, context: Context) => Promise<unknown>;
	now?: () => number;
	log?: (line: string) => void;
}
export function backgroundTool(options: BackgroundOptions): Extension {
	const now = options.now ?? Date.now;
	const log = options.log ?? (() => {});
	const Job = defineTask<Input, State, null>({
		name: "rho.background",
		version: 1,
		initial: () => ({ phase: "run" }),
		phases: {
			run: async (task, runtime, ctx) => {
				const { id, command, timeoutSeconds } = task.input;
				// A second visit to this phase means rho died while the command ran. It is not run again.
				const first = await runtime.memo<boolean>("started", ctx);
				if (first) return void (await runtime.commit(() => ({ status: "running", checkpoint: { phase: "report", how: "interrupted", tail: "", ms: 0 } }), ctx));
				await runtime.memo("started", true, ctx);
				const began = now();
				let how: EndedJob["how"] = "failed";
				let exit: number | undefined;
				let tail = "";
				try {
					const env = await runtime.env(ctx);
					if (!env) throw new Error("There is nowhere to run a command.");
					// Only the end of the output is kept: a long build's first megabyte is not what a failure report needs.
					let output = "";
					const result = await env.exec(command, { timeout: timeoutSeconds, onOutput: (text) => void (output = (output + text).slice(-20_000)) }, ctx);
					if (result.ok) {
						exit = result.value.exitCode;
						how = exit === 0 ? "passed" : "failed";
						tail = tailOf(output);
					} else {
						if (result.error.code === "aborted") throw result.error; // stopped: the abort phase ends it, and nothing is reported
						how = result.error.code === "timeout" ? "timed out" : "failed";
						tail = tailOf(output) || result.error.message.slice(0, MAX_TAIL);
					}
				} catch (error) {
					if (runtime.signal.aborted) throw error; // stopped: the abort phase reports it
					tail = String((error as Error)?.message ?? error).slice(0, MAX_TAIL);
				}
				log(`background: ${id} ${how}${exit === undefined ? "" : ` (exit ${exit})`} after ${span(now() - began)}`);
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "report", how, ...(exit === undefined ? {} : { exit }), tail, ms: now() - began } }), ctx);
			},
			// One commit ends the job and writes its report, so there is one report or none, never two.
			report: async (task, runtime, ctx) => {
				const { id, command, conversation } = task.input;
				const { how, exit, tail, ms } = task.state.checkpoint as Extract<State, { phase: "report" }>;
				const words =
					how === "passed" ? `passed in ${span(ms)}.` : how === "timed out" ? `was stopped at its time limit after ${span(ms)}.` : how === "interrupted" ? "was cut off: rho was restarted while it ran. It was not run again; start it again if it is still wanted." : `failed${exit === undefined ? "" : ` (exit ${exit})`} after ${span(ms)}.`;
				const text = `[background] \`${command.split("\n")[0]!.slice(0, 200)}\` ${words}${tail && how !== "passed" ? `\nIts last lines:\n${tail}` : ""}`;
				const handle = await runtime.conversation(conversation as never, ctx);
				await runtime.commit(async (tx) => {
					const doc = await tx.doc(Jobs);
					if (doc.running[0]?.id === id) doc.running = [];
					doc.ended = [...doc.ended.map(plain), { id, command: command.slice(0, 300), endedAt: now(), ms, how, ...(exit === undefined ? {} : { exit }) }].slice(-10);
					// Passed or not, it starts a run: the agent was told it would hear, and may be waiting to commit.
					if (handle) await handle.submit(tx, { type: "input", content: text, requestId: `background:${id}`, whenBusy: "followUp", entry: { kind: options.noticeKind, data: { from: "background" } } });
					return { status: "terminal", outcome: { status: "completed", result: null } };
				}, ctx);
			},
		},
		// Stopped by the person or by the agent: the record is cleared and nothing more is said.
		abort: async (task, runtime, ctx) => (log(`background: ${task.input.id} stopped`),
			void (await runtime.commit(async (tx) => {
				const doc = await tx.doc(Jobs);
				// The document's objects are tracked drafts: plain copies are stored, never the drafts themselves.
				const mine = doc.running.find((job) => job.id === task.input.id);
				if (mine) {
					const ended: EndedJob = { id: task.input.id, command: task.input.command.slice(0, 300), endedAt: now(), ms: now() - mine.startedAt, how: "stopped" };
					doc.ended = [...doc.ended.map(plain), ended].slice(-10);
					doc.running = [];
				}
				return { status: "terminal", outcome: { status: "aborted" } };
			}, ctx))),
	});

	const tool = defineTool({
		name: "background",
		description:
			"Run a shell command outside your turn. start {command, timeout?}: returns at once; when the command ends you are told how (passed, failed with its last lines, timed out) in a later message, so do not wait or poll. " +
			"Use it for what takes about a minute or more and needs no watching: the project's checks, a build, an install. For anything quick, use bash. One runs at a time. status: what is running and what ended lately. stop: end the one that is running. " +
			"The same rules apply as for bash: a command that needs the person's yes waits for it here too.",
		parameters: obj({ action: oneOf(["start", "status", "stop"]), command: opt(str()), timeout: opt(num()) }),
		execute: async (args, api, context: Context) => {
			const state = async (): Promise<Book> => (await api.snapshot(Jobs, context)) ?? { running: [], ended: [], seq: 0 };
			if (args.action === "status") {
				const doc = await state();
				const lines = [doc.running[0] ? `Running for ${span(now() - doc.running[0].startedAt)}: ${doc.running[0].command.split("\n")[0]!.slice(0, 120)}` : "Nothing is running.", ...doc.ended.slice(-5).reverse().map((job) => `${job.how}${job.exit === undefined ? "" : ` (exit ${job.exit})`} after ${span(job.ms)}: ${job.command.split("\n")[0]!.slice(0, 120)}`)];
				return { output: [{ type: "text", text: lines.join("\n") }] };
			}
			if (args.action === "stop") {
				const running = (await state()).running[0];
				if (!running) return { output: [{ type: "text", text: "Nothing is running." }] };
				// Marked, then waited for: when this returns the command is dead and the record is clear.
				await options.stop(running.task as unknown as TaskId<null>, context);
				return { output: [{ type: "text", text: `Stopped: ${running.command.split("\n")[0]!.slice(0, 120)}` }] };
			}
			const command = (args.command ?? "").trim();
			if (command === "") throw new Error("command is required: the shell command to run.");
			const timeoutSeconds = Math.min(Math.max(Math.round(args.timeout ?? 600), 5), 3600);
			// The guard judges it exactly as it judges `bash`: refused, waiting for a yes, or free to run.
			await options.check({ command }, api, context);
			const started = await api.commit(async (tx) => {
				const doc = await tx.doc(Jobs);
				const busy = doc.running[0]; // a tracked draft: its fields are copied out, the draft is not cloned
				if (busy) return { id: "", busy: { command: busy.command, startedAt: busy.startedAt } };
				const id = `b${++doc.seq}`;
				const task = await tx.createTask(Job, { id, command, timeoutSeconds, conversation: api.conversationId as unknown as string | number }, { ownership: { kind: "conversation" }, conversationId: api.conversationId, background: true });
				doc.running = [{ id, command: command.slice(0, 300), conversation: String(api.conversationId), startedAt: now(), task: task as unknown as string | number }];
				return { id, busy: undefined };
			}, context);
			if (started.busy) throw new Error(`One is already running (for ${span(now() - started.busy.startedAt)}): ${started.busy.command.split("\n")[0]!.slice(0, 120)}. Wait for its report, or stop it first.`);
			return { output: [{ type: "text", text: `Started in the background (${started.id}). You will be told how it ends in a later message; go on with other work or answer the person now. Do not wait for it or check on it.` }] };
		},
	});
	return defineExtension({ name: "background", tasks: [Job], tools: [tool] });
}
