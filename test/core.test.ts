import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseModel, readConfig } from "../src/core.ts";

// The core is run in a real second process (test/fixtures/crash-host.ts) with a scripted model
// and killed with SIGKILL, which is what Android does to it. No model is called.
const host = join(import.meta.dir, "fixtures", "crash-host.ts");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function scratch(script: object[]): string {
	const dir = mkdtempSync(join(tmpdir(), "rho-core-test-"));
	dirs.push(dir);
	writeFileSync(join(dir, "script.json"), JSON.stringify(script));
	return dir;
}
const lines = (dir: string, file: string) => (existsSync(join(dir, file)) ? readFileSync(join(dir, file), "utf8").trim().split("\n").filter(Boolean) : []);

interface Host { events: any[]; until(event: string, ms?: number): Promise<any>; kill(): Promise<void>; exited: Promise<number> }
function start(dir: string, submit?: [string, string], env: Record<string, string> = {}): Host {
	const child = Bun.spawn([process.execPath, host, dir, join(dir, "script.json"), ...(submit ?? [])], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
	const events: any[] = [];
	const waiters = new Set<() => void>();
	let stderr = "";
	void (async () => { for await (const chunk of child.stderr) stderr += new TextDecoder().decode(chunk); })();
	void (async () => {
		let buffer = "";
		for await (const chunk of child.stdout) {
			buffer += new TextDecoder().decode(chunk);
			let end: number;
			while ((end = buffer.indexOf("\n")) !== -1) {
				try { events.push(JSON.parse(buffer.slice(0, end))); } catch { /* not an event */ }
				buffer = buffer.slice(end + 1);
				for (const waiter of [...waiters]) waiter();
			}
		}
	})();
	void child.exited.then(() => { for (const waiter of [...waiters]) waiter(); });
	return {
		events,
		exited: child.exited,
		until: (event, ms = 20_000) => new Promise((resolve, reject) => {
			const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`timed out waiting for ${event}; saw ${events.map((e) => e.event).join(",")}; stderr: ${stderr.slice(-600)}`)); }, ms);
			const check = () => {
				const found = events.find((e) => e.event === event);
				if (!found && child.exitCode === null) return;
				clearTimeout(timer);
				waiters.delete(check);
				found ? resolve(found) : reject(new Error(`the host exited (${child.exitCode}) before ${event}; stderr: ${stderr.slice(-600)}`));
			};
			waiters.add(check);
			check();
		}),
		kill: async () => { child.kill("SIGKILL"); await child.exited; },
	};
}
const kinds = (idle: any) => idle.entries.map((entry: any) => entry.kind);

test("a question is answered and stored; a second process sees the same conversation", async () => {
	const dir = scratch([{ text: "Tokyo." }]);
	const first = start(dir, ["req-1", "What is the capital of Japan?"]);
	const idle = await first.until("idle");
	expect(kinds(idle)).toEqual(["pi.user", "pi.system", "pi.assistant"]);
	expect(idle.entries.at(-1).text).toBe("Tokyo.");
	expect(await first.exited).toBe(0);
	// Reopened with nothing to do: the same entries, and no new model call.
	const again = await start(dir).until("idle");
	expect(again.entries).toEqual(idle.entries);
	expect(lines(dir, "model.log").length).toBe(1);
});

test("killed while the model is answering: the next process finishes the run, and the question is not asked twice", async () => {
	const dir = scratch([{ text: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen" }, { text: "The answer, after a restart." }]);
	const first = start(dir, ["req-2", "Tell me something."], { FAUX_TPS: "4" }); // slow enough to be killed mid-answer
	await first.until("submitted");
	await Bun.sleep(700);
	await first.kill();
	expect(lines(dir, "model.log").length).toBe(1); // the first request had started
	// The same request id on reopen: the existing submission, not a second question.
	const second = start(dir, ["req-2", "Tell me something."]);
	const idle = await second.until("idle", 40_000);
	const users = idle.entries.filter((entry: any) => entry.kind === "pi.user");
	expect(users.length).toBe(1);
	const answers = idle.entries.filter((entry: any) => entry.kind === "pi.assistant");
	expect(answers.at(-1).text).toBe("The answer, after a restart.");
	expect(answers.at(-1).stop).toBe("stop");
	// The interrupted attempt is kept as a cut-off entry, not lost and not shown as an answer.
	expect(answers.slice(0, -1).every((entry: any) => entry.stop === "aborted")).toBe(true);
	expect(lines(dir, "model.log").length).toBe(2); // one retry, no more
}, 60_000);

test("killed while a tool is running: the tool does not run again, and the model is told it was interrupted", async () => {
	const dir = scratch([{ tool: "effect", args: { label: "send-the-email" } }, { text: "It was interrupted; I did not repeat it." }]);
	const first = start(dir, ["req-3", "Send the email."], { TOOL_MS: "30000" });
	await first.until("tool-started");
	expect(lines(dir, "effects.log")).toEqual(["send-the-email"]);
	await first.kill();
	const second = start(dir, undefined, { TOOL_MS: "0" });
	const idle = await second.until("idle", 40_000);
	expect(lines(dir, "effects.log")).toEqual(["send-the-email"]); // still once
	const result = idle.entries.find((entry: any) => entry.kind === "pi.tool-result");
	expect(result.isError).toBe(true);
	expect(result.text.toLowerCase()).toContain("interrupt");
	expect(idle.entries.at(-1).kind).toBe("pi.assistant");
	expect(idle.entries.at(-1).text).toBe("It was interrupted; I did not repeat it.");
	expect(lines(dir, "model.log").length).toBe(2); // the tool request, then the answer after the interruption
}, 60_000);

test("a finished tool call is not run again by a restart", async () => {
	const dir = scratch([{ tool: "effect", args: { label: "once" } }, { text: "Done." }]);
	const idle = await start(dir, ["req-4", "Do it."]).until("idle");
	expect(kinds(idle)).toEqual(["pi.user", "pi.system", "pi.assistant", "pi.tool-result", "pi.assistant"]);
	await start(dir).until("idle");
	expect(lines(dir, "effects.log")).toEqual(["once"]);
});

test("one process owns the data: a second rho on the same directory is refused, and a dead owner's lock is taken over", async () => {
	const dir = scratch([{ tool: "effect", args: { label: "hold" } }, { text: "ok" }]);
	const first = start(dir, ["req-5", "Hold."], { TOOL_MS: "30000" });
	await first.until("tool-started");
	await expect(start(dir).until("open")).rejects.toThrow(/Another rho \(pid \d+\) already runs/);
	await first.kill(); // its lock stays behind, naming a pid that is gone
	const idle = await start(dir, undefined, { TOOL_MS: "0" }).until("idle", 40_000);
	expect(idle.entries.at(-1).text).toBe("ok");
	// A lock whose pid now belongs to something else (this test) with another start time is stale too.
	writeFileSync(join(dir, "rho.lock"), `${process.pid} 1`);
	await start(dir).until("idle");
}, 60_000);

test("config", () => {
	expect(parseModel("claude-code/claude-opus-5-5")).toEqual({ provider: "claude-code", modelId: "claude-opus-5-5" });
	expect(parseModel("openrouter/anthropic/claude")).toEqual({ provider: "openrouter", modelId: "anthropic/claude" });
	expect(() => parseModel("no-slash")).toThrow(/provider\/model/);
	const dir = scratch([]);
	expect(readConfig(dir)).toEqual({});
	writeFileSync(join(dir, "config.json"), '{"model":"a/b"}');
	expect(readConfig(dir)).toEqual({ model: "a/b" });
	const logged: string[] = [];
	writeFileSync(join(dir, "config.json"), "{nope");
	expect(readConfig(dir, (line) => logged.push(line))).toEqual({});
	expect(logged[0]).toMatch(/not JSON and was ignored/);
});

test("killed while a worker is mid-job: the next process goes on with the same worker, which reports once", async () => {
	// The worker's first step is a tool that takes long enough to be killed in. Its steps are marked for it.
	const brief = "The person asked for the slow effect to be recorded. Call the effect tool with the label given, then report what you did and how you checked it.";
	const dir = scratch([
		{ tool: "delegate", args: { action: "start", title: "Record the effect", brief } },
		{ text: "Handed off." },
		{ tool: "effect", args: { label: "worker-step" }, worker: true },
		{ text: "DONE\nThe effect was interrupted once; I did not repeat it and report what is recorded.", worker: true },
		{ text: "The worker reports done." },
	]);
	const first = start(dir, ["req-worker-1", "Hand this off."], { STAY_UP: "1", TOOL_MS: "20000" });
	const began = await first.until("tool-started", 30_000);
	expect(began.label).toBe("worker-step");
	// The main thread was free before the worker's step began: its own turn is over.
	expect(lines(dir, "model.log").map((line) => JSON.parse(line).text ?? JSON.parse(line).tool)).toEqual(["delegate", "Handed off.", "effect"]);
	await first.kill();
	// Reopened with nothing submitted: the worker's own conversation is resumed, it is told its step was cut off, and it reports.
	const second = start(dir, undefined, { WAIT_FOR_KIND: "rho.notice" });
	const idle = await second.until("idle", 40_000);
	const reports = idle.entries.filter((entry: any) => entry.kind === "rho.notice");
	expect(reports.length).toBe(1); // criterion 4: one report
	expect(reports[0].text).toStartWith("[worker w1] Record the effect\nIt reports done.");
	expect(idle.entries.at(-1).text).toBe("The worker reports done.");
	expect(await second.exited).toBe(0);
	expect(lines(dir, "effects.log")).toEqual(["worker-step"]); // the worker's step was not run a second time
	// The job was not handed off again: one `delegate`, and the same worker finished it.
	expect(lines(dir, "model.log").filter((line) => line.includes('"delegate"')).length).toBe(1);
	expect(lines(dir, "model.log").length).toBe(5);
	// A third start has nothing more to say.
	const third = await start(dir).until("idle");
	expect(third.entries.filter((entry: any) => entry.kind === "rho.notice").length).toBe(1);
	expect(lines(dir, "model.log").length).toBe(5);
}, 120_000);

test("killed after a worker asked: the next process neither loses the question nor shows it twice, and the report lists it as defaulted", async () => {
	const brief = "The person asked for the slow effect to be recorded. Call the effect tool with the label given, then report what you did and how you checked it.";
	const dir = scratch([
		{ tool: "delegate", args: { action: "start", title: "Record the effect", brief } },
		{ text: "Handed off." },
		{ tool: "ask", args: { question: "Which label?", default: "worker-step" }, worker: true },
		{ tool: "effect", args: { label: "worker-step" }, worker: true },
		{ text: "DONE\nRecorded worker-step, the default.", worker: true },
		{ text: "Noted the question; leaving it on its default." },
		{ text: "The worker reports done." },
	]);
	const first = start(dir, ["req-ask-1", "Hand this off."], { STAY_UP: "1", TOOL_MS: "20000" });
	expect((await first.until("tool-started", 30_000)).label).toBe("worker-step"); // the question was asked before this step
	await first.kill();
	const second = start(dir, undefined, { WAIT_FOR_KIND: "rho.notice", WAIT_FOR_COUNT: "2", TEXT_MAX: "2000" });
	const idle = await second.until("idle", 40_000);
	expect(await second.exited).toBe(0);
	const notices = idle.entries.filter((entry: any) => entry.kind === "rho.notice").map((entry: any) => entry.text);
	expect(notices.length).toBe(2);
	expect(notices.filter((text: string) => text.startsWith("[a worker asks] Record the effect: Which label?")).length).toBe(1);
	expect(notices.find((text: string) => text.startsWith("[worker w1]"))).toContain("Decided without the person (1):\n- Which label? → worker-step (the worker's default; basis: No answer came.)");
	expect(lines(dir, "model.log").filter((line) => line.includes('"ask"')).length).toBe(1); // asked once
	expect(lines(dir, "effects.log")).toEqual(["worker-step"]);
}, 120_000);

test("killed while a background command runs: the next process reports it once, as cut off, and does not run it again", async () => {
	// The command leaves a mark each time it really starts, then sleeps long enough to be killed in.
	// The mark is outside the host's data directory: a command that names rho's own data is refused by the guard.
	const outside = mkdtempSync(join(tmpdir(), "rho-core-marks-"));
	dirs.push(outside);
	const mark = join(outside, "marks.txt");
	const dir = scratch([{ tool: "background", args: { action: "start", command: `echo ran >>${mark};sleep 20` } }, { text: "Started it." }, { text: "I see it was cut off." }]);
	// The turn ends at once and the job goes on in the background, so the host is told to stay up to be killed.
	const first = start(dir, ["req-bg-1", "Run the long job."], { STAY_UP: "1" });
	await first.until("submitted");
	const marks = () => (existsSync(mark) ? readFileSync(mark, "utf8").trim().split("\n") : []);
	for (let waited = 0; marks().length === 0 && waited < 15_000; waited += 50) await Bun.sleep(50);
	expect(marks()).toEqual(["ran"]); // the command really started
	await first.kill();
	// Reopened: the job's task finds it had started. It reports that it was cut off and does not run the command again.
	// The host waits for a report before it looks for idle, since a job's report starts a run of its own.
	const second = start(dir, undefined, { WAIT_FOR_KIND: "rho.notice" });
	const idle = await second.until("idle", 40_000);
	const reports = idle.entries.filter((entry: any) => entry.kind === "rho.notice");
	expect(reports.length).toBe(1);
	// The host shows the first 120 characters of an entry: enough for how it ended.
	expect(reports[0].text).toContain("` was cut off: rho");
	expect(idle.entries.at(-1).text).toBe("I see it was cut off.");
	expect(await second.exited).toBe(0);
	expect(marks()).toEqual(["ran"]); // once: not run again, and the killed one did not finish
	// A third start has nothing more to say.
	const third = await start(dir).until("idle");
	expect(third.entries.filter((entry: any) => entry.kind === "rho.notice").length).toBe(1);
	expect(lines(dir, "model.log").length).toBe(3);
	expect(marks()).toEqual(["ran"]);
}, 90_000);
