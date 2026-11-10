import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { checkinNote, dueReminders, nextDue, parseReminder, type Reminder } from "../src/checkins.ts";
import { context, openCore, type Core } from "../src/core.ts";
import { entryView, type EntryView } from "../src/view.ts";
import { fakeClock, HOUR, MINUTE } from "./fixtures/clock.ts";

// Check-ins on a clock the test moves: a real core, real durable sleeps, a scripted model.
const dirs: string[] = [];
const cores: Core[] = [];
const procs: ReturnType<typeof Bun.spawn>[] = [];
afterEach(async () => {
	for (const proc of procs.splice(0)) proc.kill("SIGKILL");
	for (const core of cores.splice(0)) await core.close().catch(() => undefined);
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "rho-checkin-test-")));
	dirs.push(dir);
	return dir;
};
const T0 = Date.parse("2026-03-01T10:00:00Z");
async function open(config: object = {}, reuse?: { dir: string; clock: ReturnType<typeof fakeClock> }) {
	const dir = reuse?.dir ?? scratch();
	const clock = reuse?.clock ?? fakeClock(T0);
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const logged: string[] = [];
	const calls: string[] = []; // what each model request was asked, newest user text
	const core = await openCore({ dir, models, config: { model: `${faux.getModel().provider}/${faux.getModel().id}`, cwd: dir, ...config }, memory: null, clock, log: (line) => logged.push(line) });
	cores.push(core);
	/** Script the model: each reply is given once, and the request it answered is recorded. */
	const script = (...replies: (string | ReturnType<typeof fauxAssistantMessage>)[]) =>
		faux.setResponses(replies.map((reply) => ((transcript: { messages: { role: string; content: unknown }[] }) => {
			const last = transcript.messages.findLast((message) => message.role === "user");
			calls.push(typeof last?.content === "string" ? last.content : JSON.stringify(last?.content));
			return typeof reply === "string" ? fauxAssistantMessage(reply) : reply;
		}) as never));
	const entries = async (): Promise<EntryView[]> => (await core.root.entries({ order: "ascending" }, 300, undefined, context)).items.flatMap((entry) => entryView(entry) ?? []);
	const notices = async () => (await entries()).filter((entry) => entry.role === "notice").map((entry) => entry.text);
	return { core, dir, clock, faux, script, calls, logged, entries, notices, reminders: core.reminders! };
}
async function until(what: string, check: () => unknown | Promise<unknown>, ms = 8_000): Promise<void> {
	const end = Date.now() + ms;
	while (!(await check())) {
		if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
		await Bun.sleep(20);
	}
}
/**
 * A time as hours from the test's start, when it is within ten seconds of a whole number of
 * them. The clock runs on while the test does, and a second process takes a moment to start, so
 * "due at 11:00" is really 11:00 and some milliseconds; anything further off is returned as it is.
 */
const hours = (at: number): number => {
	const exact = (at - T0) / HOUR;
	return Math.abs(exact - Math.round(exact)) * HOUR < 10_000 ? Math.round(exact) : exact;
};
/** Long enough for a due check-in to have started if one were going to. */
const settle = () => Bun.sleep(400);

// --- the decision, in code -------------------------------------------------------------------

const reminder = (id: string, nextDueAt: number, cadence: Reminder["cadence"] = { kind: "interval", everyMs: HOUR }): Reminder => ({ id, text: `do ${id}`, cadence, nextDue: nextDueAt, createdAt: T0 });
test("due-ness is a pure function of the reminders and the time", () => {
	const items = [reminder("late", T0 + 2 * HOUR), reminder("early", T0 + HOUR), reminder("exact", T0 + 90 * MINUTE)];
	expect(dueReminders(items, T0)).toEqual([]);
	expect(dueReminders(items, T0 + HOUR - 1)).toEqual([]);
	expect(dueReminders(items, T0 + HOUR).map((item) => item.id)).toEqual(["early"]);
	expect(dueReminders(items, T0 + 90 * MINUTE).map((item) => item.id)).toEqual(["early", "exact"]); // earliest first; due at exactly its time
	expect(dueReminders(items, T0 + 9 * HOUR).map((item) => item.id)).toEqual(["early", "exact", "late"]);
	expect(dueReminders([], T0)).toEqual([]);
});

test("after it runs, a reminder moves past every time it missed, on its own grid", () => {
	const hourly = reminder("h", T0 + HOUR);
	expect(nextDue(hourly, T0 + HOUR)).toBe(T0 + 2 * HOUR);
	expect(nextDue(hourly, T0 + HOUR + 5 * MINUTE)).toBe(T0 + 2 * HOUR); // ran a little late: still on the hour
	expect(nextDue(hourly, T0 + 7.5 * HOUR)).toBe(T0 + 8 * HOUR); // six times were missed: one next time, not six
	expect(nextDue(reminder("o", T0 + HOUR, { kind: "once" }), T0 + HOUR)).toBeUndefined();
	const daily = reminder("d", 0, { kind: "daily", at: "08:00" });
	const next = nextDue(daily, T0)!;
	expect(next).toBeGreaterThan(T0);
	expect(next - T0).toBeLessThanOrEqual(24 * HOUR);
	expect([new Date(next).getHours(), new Date(next).getMinutes()]).toEqual([8, 0]);
	expect(nextDue(daily, next)! - next).toBeGreaterThanOrEqual(23 * HOUR); // the day after, not the same minute again
});

test("a reminder is one of every, daily or at, and a bad one is refused in words", () => {
	expect(parseReminder({ text: "x", every: "2h" }, T0)).toEqual({ cadence: { kind: "interval", everyMs: 2 * HOUR }, nextDue: T0 + 2 * HOUR });
	expect(parseReminder({ text: "x", every: "30 m" }, T0).cadence).toEqual({ kind: "interval", everyMs: 30 * MINUTE });
	expect(parseReminder({ text: "x", daily: "8:05" }, T0).cadence).toEqual({ kind: "daily", at: "08:05" });
	expect(parseReminder({ text: "x", at: "2026-03-02T09:00:00Z" }, T0)).toEqual({ cadence: { kind: "once" }, nextDue: Date.parse("2026-03-02T09:00:00Z") });
	for (const [spec, why] of [[{ every: "2m" }, /at least five minutes/], [{ every: "soon" }, /a number and a unit/], [{ daily: "25:00" }, /a time of day/], [{ at: "yesterday-ish" }, /a date and time/], [{ at: "2026-02-01T00:00:00Z" }, /in the past/], [{}, /exactly one of/], [{ every: "1h", daily: "08:00" }, /exactly one of/]] as const) expect(() => parseReminder({ text: "x", ...spec }, T0)).toThrow(why);
});

test("the note says what is due, how late, that nobody can approve, and how to say nothing", () => {
	const note = checkinNote([reminder("r1", T0 + HOUR), reminder("r2", T0 + HOUR, { kind: "daily", at: "08:00" })], T0 + 4 * HOUR);
	expect(note).toContain("[check-in] The person did not send this. These reminders are due:");
	expect(note).toContain("- [r1] do r1 (every 1h, 3 h late)");
	expect(note).toContain("- [r2] do r2 (daily at 08:00, 3 h late)");
	expect(note).toContain("nobody can approve anything here");
	expect(note).toContain("answer exactly: nothing to report");
	expect(checkinNote([reminder("r1", T0)], T0)).toContain("- [r1] do r1 (every 1h)"); // on time: no lateness
});

// --- the durable task ------------------------------------------------------------------------

test("nothing runs while nothing is due; when it is due the check-in runs once and its answer reaches the first conversation", async () => {
	const { clock, script, calls, notices, reminders, entries, core, logged } = await open();
	script("The build is green.", "should never be asked");
	const added = await reminders.add({ text: "Check that the build is green", every: "2h" });
	expect([added.id, hours(added.nextDue)]).toEqual(["r1", 2]);
	await settle();
	clock.advance(HOUR + 59 * MINUTE); // one minute short
	await settle();
	expect(calls).toEqual([]); // no model was called
	expect(await notices()).toEqual([]);
	clock.advance(2 * MINUTE);
	await until("the report", async () => (await notices()).length === 1);
	expect(await notices()).toEqual(["[check-in] The build is green."]);
	expect(calls.length).toBe(1);
	expect(calls[0]).toContain("- [r1] Check that the build is green (every 2h)");
	// It ran beside the person's conversation: no run happened there, and its question is not in the thread.
	expect((await entries()).map((entry) => entry.role)).toEqual(["notice"]);
	expect((await core.conversations()).length).toBe(1); // the check-in's own conversation is not one of the person's
	const moved = (await reminders.list())[0]!;
	expect([moved.id, hours(moved.nextDue)]).toEqual(["r1", 4]);
	expect(Math.abs(moved.lastRun! - (T0 + 2 * HOUR + MINUTE))).toBeLessThan(10_000); // it ran when the clock said 12:01
	await settle();
	expect(calls.length).toBe(1); // and it is asleep again until the next time
	expect(logged.some((line) => line.startsWith("check-in: reported"))).toBe(true);
});

test("a check-in with nothing to report shows nothing", async () => {
	const { clock, script, calls, notices, reminders, logged, entries } = await open();
	script("Nothing to report.");
	await reminders.add({ text: "Look for failed backups", every: "1h" });
	clock.advance(HOUR + MINUTE);
	await until("the quiet run", () => logged.includes("check-in: nothing to report"));
	expect(calls.length).toBe(1);
	expect(await notices()).toEqual([]);
	expect(await entries()).toEqual([]); // the person's thread is untouched
});

test("the person's next message is answered with the check-in's report in view", async () => {
	const { clock, script, calls, notices, reminders, core, faux } = await open();
	script("Two backups failed last night.");
	await reminders.add({ text: "Look for failed backups", every: "1h" });
	clock.advance(HOUR + MINUTE);
	await until("the report", async () => (await notices()).length === 1);
	const seen: string[] = [];
	faux.setResponses([((transcript: { messages: { role: string; content: unknown }[] }) => (seen.push(JSON.stringify(transcript.messages.filter((message) => message.role === "user").map((message) => message.content))), fauxAssistantMessage("I saw that; want me to rerun them?"))) as never]);
	await (await core.root.submit({ type: "input", content: "anything I should know?" }, context)).wait(context);
	expect(seen[0]).toContain("[check-in] Two backups failed last night.");
	expect(seen[0]).toContain("anything I should know?");
	expect(calls.length).toBe(1);
});

test("several reminders due at once run as one check-in; a once reminder is gone after it runs", async () => {
	const { clock, script, calls, notices, reminders } = await open();
	script("Both done.");
	await reminders.add({ text: "Water the plants", every: "1h" });
	await reminders.add({ text: "Call the dentist", at: new Date(T0 + 30 * MINUTE).toISOString() });
	await reminders.add({ text: "Not yet", every: "1d" });
	clock.advance(HOUR + MINUTE);
	await until("the report", async () => (await notices()).length === 1);
	expect(calls.length).toBe(1);
	expect(calls[0]).toContain("These reminders are due:\n- [r2] Call the dentist (once, 31 min late)\n- [r1] Water the plants (every 1h)");
	expect(calls[0]).not.toContain("Not yet");
	expect((await reminders.list()).map((item) => item.id)).toEqual(["r1", "r3"]);
});

test("a reminder added later, and due sooner than what the task sleeps on, still fires at its own time; removing the last one ends the waiting", async () => {
	const { clock, script, calls, notices, reminders } = await open();
	script("Sooner one done.", "should never be asked");
	await reminders.add({ text: "Far off", every: "1d" });
	await settle(); // the task is now asleep until tomorrow
	await reminders.add({ text: "Soon", every: "10m" });
	clock.advance(11 * MINUTE);
	await until("the sooner check-in", async () => (await notices()).length === 1);
	expect(calls[0]).toContain("- [r2] Soon (every 10m)");
	expect(calls[0]).not.toContain("Far off");
	expect(await reminders.remove("r2")).toMatchObject({ id: "r2" });
	expect(await reminders.remove("r1")).toMatchObject({ id: "r1" });
	expect(await reminders.remove("r1")).toBeUndefined();
	clock.advance(3 * 24 * HOUR);
	await settle();
	expect(calls.length).toBe(1); // nothing left to be due
});

test("a check-in is bounded by a turn limit, and says that it did not finish", async () => {
	const { clock, faux, notices, reminders, calls } = await open({ checkins: { maxTurns: 2 } });
	const step = () => fauxAssistantMessage(fauxToolCall("bash", { command: "true" }), { stopReason: "toolUse" });
	let asked = 0;
	faux.setResponses(Array.from({ length: 6 }, () => (() => (asked++, step())) as never));
	await reminders.add({ text: "Loop for ever", every: "1h" });
	clock.advance(HOUR + MINUTE);
	await until("the report", async () => (await notices()).length === 1);
	expect(await notices()).toEqual(["[check-in] The check-in for r1 did not finish (turn limit)."]);
	expect(asked).toBe(2); // stopped at its limit, not at the script's end
	expect(calls).toEqual([]);
	expect(hours((await reminders.list())[0]!.nextDue)).toBe(2); // and it will be tried at its next time
});

test("Stop ends a running check-in quietly; the reminder stays and runs at its next time", async () => {
	const { clock, faux, notices, reminders, logged, entries } = await open();
	let asked = 0;
	faux.setResponses([(async () => (asked++, await Bun.sleep(1_500), fauxAssistantMessage("too late"))) as never, (() => (asked++, fauxAssistantMessage("Second time round."))) as never]);
	await reminders.add({ text: "Slow thing", every: "1h" });
	expect(await reminders.stop()).toBe(false); // nothing is running yet
	clock.advance(HOUR + MINUTE);
	await until("the check-in's model call", () => asked === 1);
	expect(await reminders.stop()).toBe(true);
	await until("the stop to be logged", () => logged.some((line) => line.startsWith("check-in: stopped by the person (r1)")));
	await until("the task to go back to sleep", () => logged.includes("check-in: no report"));
	expect(await entries()).toEqual([]); // nothing is said about a check-in the person stopped
	expect(hours((await reminders.list())[0]!.nextDue)).toBe(2);
	clock.advance(HOUR);
	await until("the next check-in", async () => (await notices()).length === 1);
	expect(await notices()).toEqual(["[check-in] Second time round."]);
});

test("the agent sets, lists and removes reminders with the reminder tool", async () => {
	const { core, faux, entries, reminders } = await open();
	const call = (args: object) => fauxAssistantMessage(fauxToolCall("reminder", args as never), { stopReason: "toolUse" });
	const use = async (args: object) => {
		faux.setResponses([call(args), fauxAssistantMessage("ok")]);
		await (await core.root.submit({ type: "input", content: "go" }, context)).wait(context);
		return (await entries()).findLast((entry) => entry.role === "tool") as Extract<EntryView, { role: "tool" }>;
	};
	expect((await use({ action: "add", text: "Check the  build\nis green", every: "2h" })).text).toBe("Added: [r1] Check the build is green (every 2h; next 2026-03-01T12:00Z)");
	expect((await use({ action: "add", text: "Morning summary", daily: "08:00" })).text).toMatch(/^Added: \[r2\] Morning summary \(daily at 08:00; next 2026-03-0\dT\d\d:\d\dZ\)$/);
	expect((await use({ action: "list" })).text.split("\n").length).toBe(2);
	for (const [args, why] of [[{ action: "add", text: "x", every: "1m" }, /at least five minutes/], [{ action: "add", text: "", every: "1h" }, /text says what to do/], [{ action: "add", text: "x" }, /exactly one of/], [{ action: "remove", id: "r9" }, /No reminder "r9"\. \[r1\]/]] as const) {
		const refused = await use(args);
		expect([refused.error, why.test(refused.text)]).toEqual([true, true]);
	}
	expect((await use({ action: "remove", id: "r1" })).text).toContain("Removed: [r1] Check the build is green");
	expect((await reminders.list()).map((item) => item.id)).toEqual(["r2"]);
	expect((await use({ action: "remove", id: "r2" })).error).toBeUndefined();
	expect((await use({ action: "list" })).text).toBe("No reminders.");
});

test("check-ins can be turned off: no tool, no book", async () => {
	const { core } = await open({ checkins: false });
	expect(core.reminders).toBeUndefined();
	expect((await core.root.agent(context)).tools.map((tool) => tool.name)).not.toContain("reminder");
});

// --- restarts --------------------------------------------------------------------------------

test("a clean restart keeps the reminders and their times, and starts no second check-in", async () => {
	const first = await open();
	first.script("First run.");
	await first.reminders.add({ text: "Hourly thing", every: "1h" });
	first.clock.advance(HOUR + MINUTE);
	await until("the first report", async () => (await first.notices()).length === 1);
	const before = await first.reminders.list();
	await first.core.close();
	const second = await open({}, first);
	second.script("Second run.", "should never be asked");
	expect(await second.reminders.list()).toEqual(before);
	await settle();
	expect(second.calls).toEqual([]); // reopening is not a reason to run
	second.clock.advance(HOUR);
	await until("the second report", async () => (await second.notices()).length === 2);
	expect(await second.notices()).toEqual(["[check-in] First run.", "[check-in] Second run."]);
	await settle();
	expect(second.calls.length).toBe(1);
});

interface HostState { pid: number; now: number; reminders: Reminder[]; notices: string[]; runsInRoot: number }
function host(dir: string, args: string[] = [], env: Record<string, string> = {}) {
	const proc = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures", "checkin-host.ts"), dir, ...args], { env: { ...process.env, ...env }, stdout: "ignore", stderr: "inherit" });
	procs.push(proc);
	const state = (): HostState | undefined => {
		try {
			const read = JSON.parse(readFileSync(join(dir, "state.json"), "utf8")) as HostState;
			return read.pid === proc.pid ? read : undefined; // only what this process wrote
		} catch {
			return undefined;
		}
	};
	return { proc, state, kill: async () => { proc.kill("SIGKILL"); await proc.exited; } };
}
const lines = (dir: string, file: string) => (existsSync(join(dir, file)) ? readFileSync(join(dir, file), "utf8").trim().split("\n").filter(Boolean) : []);
function killable(script: string[]) {
	const dir = scratch();
	writeFileSync(join(dir, "script.json"), JSON.stringify(script));
	writeFileSync(join(dir, "epoch"), String(Date.now())); // every process of this test shares one clock
	writeFileSync(join(dir, "clock"), "0");
	return { dir, advance: (ms: number) => writeFileSync(join(dir, "clock"), String(Number(readFileSync(join(dir, "clock"), "utf8")) + ms)) };
}

test("killed while asleep and down for six of its times: after the restart the missed check-in fires once", async () => {
	const { dir, advance } = killable(["Caught up after the outage.", "should never be asked", "nor this"]);
	const first = host(dir, ["1h", "Hourly thing"]);
	await until("the reminder to be stored", () => first.state()?.reminders.length === 1, 20_000);
	expect([first.state()!.reminders[0]!.id, hours(first.state()!.reminders[0]!.nextDue)]).toEqual(["r1", 1]);
	await first.kill(); // SIGKILL, as Android does it
	advance(6.5 * HOUR); // 11:00, 12:00, 13:00, 14:00, 15:00 and 16:00 all pass while nothing runs
	const second = host(dir);
	await until("the missed check-in's report", () => second.state()?.notices.length === 1, 20_000);
	await Bun.sleep(1_000); // time for a second one, if one were coming
	const after = second.state()!;
	expect(after.notices).toEqual(["[check-in] Caught up after the outage."]);
	expect(lines(dir, "model.log").length).toBe(1); // one model call, not six
	expect(hours(after.reminders[0]!.nextDue)).toBe(7); // next at 17:00: past all that was missed
	expect(after.runsInRoot).toBe(0);
	// And it goes on from there.
	advance(HOUR);
	await until("the next one", () => second.state()?.notices.length === 2, 20_000);
	expect(lines(dir, "model.log").length).toBe(2);
}, 60_000);

test("killed while the check-in is running: the next process finishes that one check-in and does not start another", async () => {
	// The first answer streams slowly, so the kill lands mid-answer; the retry after the restart is the second.
	const { dir, advance } = killable(["one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen", "Finished after the restart.", "should never be asked"]);
	const first = host(dir, ["1h", "Hourly thing"], { FAUX_TPS: "4" });
	await until("the reminder to be stored", () => first.state()?.reminders.length === 1, 20_000);
	advance(HOUR + MINUTE);
	await until("the check-in's model call to start", () => lines(dir, "model.log").length === 1, 20_000);
	await Bun.sleep(300); // the state file is written every 100 ms
	expect(hours(first.state()!.reminders[0]!.nextDue)).toBe(2); // already moved on, in the commit that started the run
	await first.kill();
	const second = host(dir);
	await until("the report", () => second.state()?.notices.length === 1, 30_000);
	await Bun.sleep(1_000);
	expect(second.state()!.notices).toEqual(["[check-in] Finished after the restart."]);
	expect(lines(dir, "model.log").length).toBe(2); // the interrupted attempt and its one retry; no second check-in
	expect(hours(second.state()!.reminders[0]!.nextDue)).toBe(2);
}, 60_000);
