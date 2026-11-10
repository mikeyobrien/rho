// Check-ins: rho does something at a time the person named, without being asked again.
//
// A reminder is text and a cadence ("every 2h", "daily 08:00", or once at a time). Reminders
// live in a session document. One durable task sleeps until the earliest is due. The sleep is
// stored, so it survives a restart, and while nothing is due nothing runs and no model is called.
//
// When the task wakes, code decides what is due (`dueReminders`). Each due reminder is moved to
// its next time in the same commit that starts the run, so a reminder missed while rho was down
// fires once, not once per missed time. The run happens in a conversation of its own, beside the
// person's, with a turn limit. Its answer reaches the first conversation as a notice the model
// reads on its next turn; "nothing to report" is shown to nobody.
import type { Context } from "@earendil-works/chord/context";
import { configure, defineDoc, defineExtension, defineTask, defineTool, type Conversation, type ConversationId, type Extension, type Harness, type TaskId } from "@earendil-works/pi-durable";
import { obj, oneOf, opt, str } from "@earendil-works/pi-schema";

export type Cadence = { kind: "interval"; everyMs: number } | { kind: "daily"; at: string } | { kind: "once" };
export type Reminder = { id: string; text: string; cadence: Cadence; nextDue: number; createdAt: number; lastRun?: number };
type Book = { items: Reminder[]; taskId: string; seq: number };
const Reminders = defineDoc<Book>({ kind: "rho.reminders", version: 1, scope: "session", initial: () => ({ items: [], taskId: "", seq: 0 }), checkpointWhen: () => true });

export const NOTHING = "nothing to report";
const MINUTE = 60_000;
const UNITS: Record<string, number> = { m: MINUTE, h: 60 * MINUTE, d: 24 * 60 * MINUTE };

/** The reminders that are due at `now`, earliest first. Pure: this is the whole decision. */
export function dueReminders(items: readonly Reminder[], now: number): Reminder[] {
	return items.filter((item) => item.nextDue <= now).sort((a, b) => a.nextDue - b.nextDue);
}
/** The next time a daily reminder falls, strictly after `after`, in this machine's time zone. */
function nextDaily(at: string, after: number): number {
	const [hours = 0, minutes = 0] = at.split(":").map(Number);
	const day = new Date(after);
	day.setHours(hours, minutes, 0, 0);
	if (day.getTime() <= after) day.setDate(day.getDate() + 1);
	return day.getTime();
}
/** When a reminder that just ran at `now` is next due; undefined when it does not come again. */
export function nextDue(reminder: Reminder, now: number): number | undefined {
	if (reminder.cadence.kind === "once") return undefined;
	if (reminder.cadence.kind === "daily") return nextDaily(reminder.cadence.at, now);
	// On its own grid, so "every 2h" does not drift, and past every time that was missed.
	const every = reminder.cadence.everyMs;
	return reminder.nextDue + (Math.floor((now - reminder.nextDue) / every) + 1) * every;
}
export interface ReminderSpec { text: string; every?: string; daily?: string; at?: string | number }
/** A reminder from what was asked, or a refusal that says what is wrong. */
export function parseReminder(spec: ReminderSpec, now: number): { cadence: Cadence; nextDue: number } {
	const given = [spec.every, spec.daily, spec.at].filter((value) => value !== undefined && value !== "").length;
	if (given !== 1) throw new Error('Give exactly one of: every ("30m", "2h", "1d"), daily ("08:00"), at (a date and time).');
	if (spec.every !== undefined) {
		const match = /^(\d+)\s*([mhd])$/.exec(spec.every.trim());
		const everyMs = match ? Number(match[1]) * UNITS[match[2]!]! : 0;
		if (everyMs < 5 * MINUTE) throw new Error('every is a number and a unit, at least five minutes: "30m", "2h", "1d".');
		return { cadence: { kind: "interval", everyMs }, nextDue: now + everyMs };
	}
	if (spec.daily !== undefined) {
		const match = /^(\d{1,2}):(\d{2})$/.exec(spec.daily.trim());
		if (!match || Number(match[1]) > 23 || Number(match[2]) > 59) throw new Error('daily is a time of day: "08:00".');
		const at = `${match[1]!.padStart(2, "0")}:${match[2]}`;
		return { cadence: { kind: "daily", at }, nextDue: nextDaily(at, now) };
	}
	const when = typeof spec.at === "number" ? spec.at : Date.parse(String(spec.at));
	if (!Number.isFinite(when)) throw new Error('at is a date and time, like "2026-12-24T09:00".');
	if (when <= now) throw new Error("at is in the past.");
	return { cadence: { kind: "once" }, nextDue: when };
}
const cadenceWords = (cadence: Cadence): string => (cadence.kind === "once" ? "once" : cadence.kind === "daily" ? `daily at ${cadence.at}` : `every ${cadence.everyMs % UNITS.d! === 0 ? `${cadence.everyMs / UNITS.d!}d` : cadence.everyMs % UNITS.h! === 0 ? `${cadence.everyMs / UNITS.h!}h` : `${cadence.everyMs / MINUTE}m`}`);
const late = (ms: number): string => (ms < 2 * MINUTE ? "" : ms < 2 * UNITS.h! ? `, ${Math.round(ms / MINUTE)} min late` : ms < 2 * UNITS.d! ? `, ${Math.round(ms / UNITS.h!)} h late` : `, ${Math.round(ms / UNITS.d!)} days late`);

/** What the check-in run is told. */
export function checkinNote(due: readonly Reminder[], now: number): string {
	return [
		`[check-in] The person did not send this. ${due.length === 1 ? "This reminder is" : "These reminders are"} due:`,
		...due.map((item) => `- [${item.id}] ${item.text} (${cadenceWords(item.cadence)}${late(now - item.nextDue)})`),
		"Do what each asks, with your tools if it needs them. You run unattended, beside the person's conversations: nobody can approve anything here, so an action that needs their yes is reported, not done.",
		`Answer with what the person should know, briefly. If nothing needs their attention, answer exactly: ${NOTHING}`,
	].join("\n");
}

type State = { phase: "wait" } | { phase: "run"; conversation: string | number; note: string; stamp: number; ids: string[] } | { phase: "report"; text: string; stamp: number };
export interface CheckinOptions {
	now: () => number;
	log?: (line: string) => void;
	/** Most tool rounds one check-in takes. Default 20. */
	maxTurns?: number;
	/** The entry kind of a message the person did not write. */
	noticeKind: string;
}

/** The check-in feature: its extension (the task and the `reminder` tool) and its hands on the reminder book. */
export function checkins(options: CheckinOptions) {
	const log = options.log ?? (() => {});
	let harness: Harness | undefined;
	let root: Conversation | undefined;
	const context = (): Context => ({}) as Context;
	let background: Context = context();
	// The check-in that is running now, if one is: what the person's Stop reaches.
	let running: { conversation: ConversationId; stopped: boolean } | undefined;

	const Checkin = defineTask<Record<string, never>, State, null>({
		name: "rho.checkin",
		version: 1,
		initial: () => ({ phase: "wait" }),
		phases: {
			// Asleep until the earliest reminder is due; awake, decide in code what is due.
			wait: async (task, runtime, ctx) => {
				await runtime.commit(async (tx) => {
					const book = await tx.doc(Reminders);
					if (book.taskId !== String(task.id)) return { status: "terminal", outcome: { status: "completed", result: null } }; // a newer task holds the book
					const now = options.now();
					const due = dueReminders(book.items, now);
					if (due.length === 0) {
						const next = Math.min(...book.items.map((item) => item.nextDue));
						if (!Number.isFinite(next)) {
							book.taskId = "";
							return { status: "terminal", outcome: { status: "completed", result: null } }; // no reminders: nothing to wait for
						}
						return { status: "sleeping", until: next, checkpoint: { phase: "wait" } };
					}
					const note = checkinNote(due, now);
					// Each due reminder moves on now, in the commit that starts the run: it cannot fire twice for one time.
					for (const item of due) {
						const next = nextDue(item, now);
						const kept = book.items.find((candidate) => candidate.id === item.id)!;
						if (next === undefined) book.items.splice(book.items.indexOf(kept), 1);
						else Object.assign(kept, { nextDue: next, lastRun: now });
					}
					const made = await tx.createConversation({ ownership: { kind: "task", taskId: task.id } });
					await configure(tx, made.id, { maxTurns: options.maxTurns ?? 20 }); // a check-in is bounded
					return { status: "running", checkpoint: { phase: "run", conversation: made.id as unknown as string | number, note, stamp: now, ids: due.map((item) => item.id) } };
				}, ctx);
			},
			// The run, in its own conversation. The request id makes a rerun after a restart the same run.
			run: async (task, runtime, ctx) => {
				const { conversation, note, stamp, ids } = task.state.checkpoint;
				const handle = await runtime.conversation(conversation as unknown as ConversationId, ctx);
				if (!handle) throw new Error("the check-in's conversation is gone");
				const mine = (running = { conversation: conversation as unknown as ConversationId, stopped: false });
				const settled = await (await handle.submit({ type: "input", content: note, requestId: `checkin:${String(task.id)}:${stamp}` }, ctx)).wait(ctx).finally(() => void (running === mine && (running = undefined)));
				if (mine.stopped) log(`check-in: stopped by the person (${ids.join(", ")})`);
				await runtime.commit(async (tx) => {
					let text: string;
					if (mine.stopped) text = ""; // the person stopped it: they know, and it comes again at its next time
					else if (settled.status === "done" && settled.type === "input") {
						const answer = (await tx.entry(settled.answer))?.model?.[0] as { content?: string | { type: string; text?: string }[] } | undefined;
						const content = answer?.content;
						text = (typeof content === "string" ? content : (content ?? []).map((part) => (part.type === "text" ? (part.text ?? "") : "")).join("")).trim();
					} else text = `The check-in for ${ids.join(", ")} did not finish (${"reason" in settled ? String(settled.reason).replace(/_/g, " ") : settled.status}).`;
					return { status: "running", checkpoint: { phase: "report", text, stamp } };
				}, ctx);
			},
			// What the person should know goes to the first conversation, where its model reads it on its next turn. It starts no run there.
			report: async (task, runtime, ctx) => {
				const { text, stamp } = task.state.checkpoint;
				const quiet = text === "" || text.toLowerCase().replace(/[.!\s]+$/, "") === NOTHING;
				if (text === "") log("check-in: no report");
				else if (quiet) log("check-in: nothing to report");
				else {
					const handle = await runtime.conversation(runtime.conversationId, ctx);
					const words = `[check-in] ${text}`;
					await handle!.submit({ type: "write", requestId: `checkin-report:${String(task.id)}:${stamp}`, entry: { kind: options.noticeKind, data: { from: "check-in" }, model: [{ role: "user", content: words, timestamp: stamp }] } }, ctx);
					log(`check-in: reported ${words.length} characters`);
				}
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "wait" } }), ctx); // and back to sleep
			},
		},
		abort: async (_task, runtime, ctx) => void (await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx)),
	});

	/** Start a task on the book as it is now. The task before it ends when it next wakes and finds it is not the newest. */
	const ensure = async (): Promise<void> => {
		if (!harness || !root) return;
		const rootId = root.id;
		await harness.commit(async (tx) => {
			const book = await tx.doc(Reminders);
			if (book.items.length === 0) return void (book.taskId = "");
			const id: TaskId<null> = await tx.createTask(Checkin, {}, { ownership: { kind: "conversation" }, conversationId: rootId, background: true });
			book.taskId = String(id);
		}, background);
	};
	const book = async (): Promise<Book> => (harness && (await harness.snapshot(Reminders, background))) || { items: [], taskId: "", seq: 0 };
	const api = {
		list: async (): Promise<Reminder[]> => [...(await book()).items].sort((a, b) => a.nextDue - b.nextDue),
		add: async (spec: ReminderSpec): Promise<Reminder> => {
			const text = spec.text?.replace(/\s+/g, " ").trim() ?? "";
			if (text === "" || text.length > 500) throw new Error("text says what to do, in at most 500 characters.");
			const now = options.now();
			const parsed = parseReminder(spec, now);
			const made = await harness!.commit(async (tx) => {
				const doc = await tx.doc(Reminders);
				if (doc.items.length >= 50) throw new Error("There are 50 reminders already. Remove one first.");
				const reminder: Reminder = { id: `r${++doc.seq}`, text, ...parsed, createdAt: now };
				doc.items.push(reminder);
				return structuredClone(reminder);
			}, background);
			await ensure(); // it may be due before what the sleeping task waits for
			return made;
		},
		remove: async (id: string): Promise<Reminder | undefined> =>
			harness!.commit(async (tx) => {
				const doc = await tx.doc(Reminders);
				const index = doc.items.findIndex((item) => item.id === id);
				if (index < 0) return undefined;
				const removed = JSON.parse(JSON.stringify(doc.items[index])) as Reminder; // a plain copy: the document's objects end with the commit
				doc.items.splice(index, 1);
				return removed;
			}, background),
	};

	const when = (at: number): string => new Date(at).toISOString().replace(/:\d\d\.\d+Z$/, "Z");
	const line = (item: Reminder): string => `[${item.id}] ${item.text} (${cadenceWords(item.cadence)}; next ${when(item.nextDue)})`;
	const reminder = defineTool({
		name: "reminder",
		description: 'Reminders: things you do later without being asked again. add {text, and one of every: "30m"|"2h"|"1d", daily: "08:00", at: "2026-12-24T09:00"}: text says what to do then, in words that stand alone. remove {id}. list. When one is due you run it unattended and report to the person only what they should know.',
		parameters: obj({ action: oneOf(["add", "remove", "list"]), text: opt(str()), every: opt(str()), daily: opt(str()), at: opt(str()), id: opt(str()) }),
		execute: async (args) => {
			if (args.action === "list") {
				const items = await api.list();
				return { output: [{ type: "text", text: items.length === 0 ? "No reminders." : items.map(line).join("\n") }] };
			}
			if (args.action === "remove") {
				const removed = args.id ? await api.remove(args.id) : undefined;
				if (!removed) throw new Error(`No reminder ${JSON.stringify(args.id ?? "")}. ${(await api.list()).map(line).join("\n") || "There are none."}`);
				return { output: [{ type: "text", text: `Removed: ${line(removed)}` }] };
			}
			return { output: [{ type: "text", text: `Added: ${line(await api.add({ text: args.text ?? "", every: args.every, daily: args.daily, at: args.at }))}` }] };
		},
	});
	const extension: Extension = defineExtension({ name: "checkins", tasks: [Checkin], tools: [reminder] });
	return {
		extension,
		...api,
		/** Stop the check-in that is running now. Its reminders stay, and come again at their next times. True when one was running. */
		stop: async (): Promise<boolean> => {
			const now = running;
			if (!now) return false;
			now.stopped = true;
			await (await harness!.conversation(now.conversation, background))?.abort(background);
			return true;
		},
		/** Bind to the open harness and take up the book: called once, before scheduling starts. */
		attach: async (to: Harness, first: Conversation, ctx: Context): Promise<void> => {
			harness = to;
			root = first;
			background = ctx;
			await ensure();
		},
	};
}
export type Checkins = ReturnType<typeof checkins>;
