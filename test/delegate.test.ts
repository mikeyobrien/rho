import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { context, openCore, type Core } from "../src/core.ts";
import { localPlace, Workers, type Worker } from "../src/tools/delegate.ts";
import { entryView } from "../src/view.ts";

// The real tool in a real core. One scripted model answers every conversation: it tells a worker
// from the main agent by the worker's brief, as a real model would be told. No model is called.
const dirs: string[] = [];
const cores: Core[] = [];
afterEach(async () => {
	for (const core of cores.splice(0)) await core.close().catch(() => undefined);
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
/** Let a held worker go: waits until its model call has reached the gate. */
async function pass(gates: Map<string, () => void>, name: string): Promise<void> {
	const end = Date.now() + 15_000;
	while (!gates.has(name)) {
		if (Date.now() > end) throw new Error(`worker ${name} never reached its gate`);
		await Bun.sleep(20);
	}
	gates.get(name)!();
}
const BRIEF = (extra = "") => `The person asked for the greeting file to be fixed. Read hello.txt in the working directory, correct the typo, and check the file reads right. Report what you changed. ${extra}`;
type Reply = ReturnType<typeof fauxAssistantMessage>;
/** A wait that a test opens by name, and that ends, as a real model request does, when the request is aborted. */
const hold = (gates: Map<string, () => void>, name: string, signal: AbortSignal | undefined) =>
	new Promise<void>((resolve, reject) => {
		gates.set(name, resolve);
		signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
	});
/** What a conversation has seen so far, for a scripted model to decide on. */
const said = (asked: TranscriptContext, signal?: AbortSignal) => ({
	first: asked.messages.find((message) => message.role === "user"),
	firstText: (() => { const first = asked.messages.find((message) => message.role === "user"); return typeof first?.content === "string" ? first.content : (first?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join(""); })(),
	results: asked.messages.filter((message) => message.role === "toolResult").length,
	signal,
	lastText: (() => { const last = asked.messages.at(-1); return typeof last?.content === "string" ? last.content : ((last?.content ?? []) as { type: string; text?: string }[]).map((part) => (part.type === "text" ? (part.text ?? "") : "")).join(""); })(),
});
async function open(options: { config?: object; worker?: (seen: ReturnType<typeof said>) => Reply | Promise<Reply>; main?: (seen: ReturnType<typeof said>) => Reply; free?: () => number; reuse?: string } = {}) {
	const parent = options.reuse ?? realpathSync(mkdtempSync(join(tmpdir(), "rho-delegate-")));
	if (!options.reuse) {
		dirs.push(parent);
		for (const made of ["data", "work"]) mkdirSync(join(parent, made));
	}
	const [dir, work] = [join(parent, "data"), join(parent, "work")];
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const logged: string[] = [];
	// The main agent's script is a queue the test fills; a worker's replies come from `options.worker`.
	const queue: Reply[] = [];
	const answer = async (asked: TranscriptContext, sent?: { signal?: AbortSignal }): Promise<Reply> => {
		const seen = said(asked, sent?.signal);
		if (seen.firstText.startsWith("You are a worker.")) {
			return (options.worker ?? (() => fauxAssistantMessage("DONE\nFixed the typo and read the file back.")))(seen);
		}
		return options.main?.(seen) ?? queue.shift() ?? fauxAssistantMessage("(nothing scripted)");
	};
	faux.setResponses(Array.from({ length: 200 }, () => answer));
	const core = await openCore({ dir, models, config: { model: `${faux.getModel().provider}/${faux.getModel().id}`, cwd: work, ...options.config }, log: (line) => logged.push(line), workerRetryMs: 40, ...(options.free ? { freeMemory: options.free } : {}) });
	cores.push(core);
	const entries = async () => (await core.root.entries({ order: "ascending" }, 400, undefined, context)).items.flatMap((entry) => entryView(entry) ?? []);
	const call = (args: object) => fauxAssistantMessage(fauxToolCall("delegate", args as never), { stopReason: "toolUse" });
	/** The main agent calls `delegate` once and then says `after`. Returns the tool's result text. */
	const use = async (args: object, after = "Handed off.") => {
		queue.push(call(args), fauxAssistantMessage(after));
		await (await core.root.submit({ type: "input", content: "go" }, context)).wait(context);
		return (await entries()).findLast((entry) => entry.role === "tool")!.text;
	};
	const workers = async (): Promise<Worker[]> => ((await core.harness.snapshot(Workers, context)) ?? { workers: [] }).workers;
	const reports = async () => (await entries()).flatMap((entry) => (entry.role === "notice" && entry.from === "worker" ? [entry.text] : []));
	const until = async (what: string, check: () => Promise<unknown> | unknown, ms = 15_000) => {
		const end = Date.now() + ms;
		while (!(await check())) {
			if (Date.now() > end) throw new Error(`timed out waiting for: ${what}; workers ${JSON.stringify((await workers()).map((worker) => [worker.id, worker.status]))}; log ${JSON.stringify(logged.slice(-4))}`);
			await Bun.sleep(30);
		}
	};
	/** The tools a worker's conversation offers its model. */
	const toolsOf = async (worker: Worker) => (await (await core.harness.conversation(worker.conversation as never, context))!.agent(context)).tools.map((tool) => tool.name);
	return { core, faux, queue, parent, dir, work, logged, entries, use, workers, reports, until, toolsOf };
}

test("a job is handed off at once; the worker does it in its own thread and reports once, and the main thread stays free", async () => {
	let release!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	const t = await open({
		// The worker: read, edit, read again, report. It is held before its report so the test can look around.
		worker: async (seen) => {
			if (seen.results === 0) return fauxAssistantMessage(fauxToolCall("read", { path: "hello.txt" }), { stopReason: "toolUse" });
			if (seen.results === 1) return fauxAssistantMessage(fauxToolCall("edit", { path: "hello.txt", edits: [{ oldText: "wrold", newText: "world" }] }), { stopReason: "toolUse" });
			if (seen.results === 2) return fauxAssistantMessage(fauxToolCall("bash", { command: "cat hello.txt" }), { stopReason: "toolUse" });
			await held;
			return fauxAssistantMessage("DONE\nI changed `wrold` to `world` in hello.txt and read the file back: it says hello world.");
		},
	});
	writeFileSync(join(t.work, "hello.txt"), "hello wrold\n");
	const began = Date.now();
	const told = await t.use({ action: "start", title: "Fix the greeting typo", brief: BRIEF() });
	expect(Date.now() - began).toBeLessThan(1000); // criterion 1: under a second
	expect(told).toMatch(/^Worker w1 has the job\. Its report reaches you in a later message/);
	// The worker does the work while the main thread is idle and answers the person.
	await t.until("the worker's edit", () => readFileSync(join(t.work, "hello.txt"), "utf8") === "hello world\n");
	t.queue.push(fauxAssistantMessage("Tokyo."));
	await (await t.core.root.submit({ type: "input", content: "Capital of Japan?" }, context)).wait(context);
	const mid = await t.entries();
	expect(mid.at(-1)).toMatchObject({ role: "assistant", text: "Tokyo." }); // criterion 10
	// Criterion 2: none of the worker's steps or words are in the main thread.
	expect(mid.filter((entry) => entry.role === "tool").map((entry) => entry.name)).toEqual(["delegate"]);
	expect(JSON.stringify(mid)).not.toContain("cat hello.txt");
	expect(await t.reports()).toEqual([]);
	expect((await t.workers())[0]).toMatchObject({ id: "w1", title: "Fix the greeting typo", place: "local", status: "working" });
	// Criterion 3: one report, a notice, saying how it ended, and the model takes a turn on it.
	t.queue.push(fauxAssistantMessage("The worker fixed it; I checked the file."));
	release();
	await t.until("the report", async () => (await t.reports()).length === 1);
	const [report] = await t.reports();
	expect(report).toBe("[worker w1] Fix the greeting typo\nIt reports done. Its report follows; it is the worker's claim, not checked.\n\nDONE\nI changed `wrold` to `world` in hello.txt and read the file back: it says hello world.");
	await t.core.harness.waitForIdle(context);
	expect((await t.entries()).at(-1)).toMatchObject({ role: "assistant", text: "The worker fixed it; I checked the file." });
	expect((await t.reports()).length).toBe(1);
	expect((await t.workers())[0]).toMatchObject({ status: "done" });
	expect((await t.workers())[0]!.endedAt).toBeGreaterThan(0);
	// Criterion 9: the worker had the agent's tools, without the two that start more work.
	const offered = await t.toolsOf((await t.workers())[0]!);
	const mine = (await t.core.root.agent(context)).tools.map((tool) => tool.name);
	expect(mine).toContain("delegate");
	expect(mine).toContain("background");
	// Without the tools that start more work or change rho itself.
	expect(offered).toEqual(mine.filter((name) => !["delegate", "background", "settings", "reminder"].includes(name)));
	expect(offered).toContain("bash");
	// And the same working directory: its relative path was the main agent's.
	expect(await t.use({ action: "list" }, "Listed.")).toBe("[w1] done (local): Fix the greeting typo");
}, 40_000);

test("a worker is set up as the conversation that asked is now: its working directory, thinking and model", async () => {
	const t = await open();
	// The person moved this conversation to another directory and changed its thinking after rho started.
	const elsewhere = join(t.parent, "elsewhere");
	mkdirSync(elsewhere);
	await t.core.root.configure({ cwd: elsewhere, thinkingLevel: "high" as never }, context);
	t.queue.length = 0;
	await t.use({ action: "start", title: "Elsewhere", brief: BRIEF() });
	t.queue.push(fauxAssistantMessage("Noted."));
	await t.until("the report", async () => (await t.reports()).length === 1);
	const worker = (await t.workers())[0]!;
	const [mine, its] = [await t.core.root.agent(context), await (await t.core.harness.conversation(worker.conversation as never, context))!.agent(context)];
	expect(its.cwd).toBe(elsewhere);
	expect(its.thinkingLevel).toBe("high");
	expect(its.model).toEqual(mine.model);
	expect(its.instructions).toBe(mine.instructions);
	expect(its.maxTurns).toBe(60); // its own limit, not the conversation's 200
	expect(mine.maxTurns).toBe(200);
}, 40_000);

test("how a worker ends: partial, failed, no word at all, and its step limit", async () => {
	const ends: Record<string, (seen: ReturnType<typeof said>) => Reply> = {
		partial: () => fauxAssistantMessage("PARTIAL\nThe typo is fixed; I could not run the tests."),
		failed: () => fauxAssistantMessage("FAILED: the file does not exist."),
		unsaid: () => fauxAssistantMessage("I fixed it, everything is fine."), // no word: not taken as done
		loops: () => fauxAssistantMessage(fauxToolCall("bash", { command: "true" }), { stopReason: "toolUse" }), // never reports
	};
	const t = await open({ config: { delegates: { maxTurns: 3, max: 4 } }, worker: (seen) => ends[/KIND=(\w+)/.exec(seen.firstText)![1]!]!(seen) });
	for (const kind of Object.keys(ends)) await t.use({ action: "start", title: `job ${kind}`, brief: BRIEF(`KIND=${kind}`) });
	for (let n = 0; n < 4; n++) t.queue.push(fauxAssistantMessage("Noted."));
	await t.until("four reports", async () => (await t.reports()).length === 4, 30_000);
	const by = Object.fromEntries((await t.reports()).map((text) => [/job (\w+)/.exec(text)![1]!, text]));
	expect(by.partial).toContain("It reports partial.");
	expect(by.failed).toContain("It reports failed.");
	expect(by.failed).toContain("FAILED: the file does not exist.");
	expect(by.unsaid).toContain("It reports partial."); // a report that does not say how it ended is not "done"
	expect(by.loops).toContain("It reports partial.");
	expect(by.loops).toContain("The worker stopped at its limit of 3 steps without a report."); // criterion 5
	expect(Object.fromEntries((await t.workers()).map((worker) => [worker.title, worker.status]))).toEqual({ "job partial": "partial", "job failed": "failed", "job unsaid": "partial", "job loops": "partial" });
}, 60_000);

test("the cap follows the place: past it a job waits its turn in order, and a place short of memory starts one at a time", async () => {
	const gates = new Map<string, () => void>();
	const worker = async (seen: ReturnType<typeof said>) => {
		const name = /NAME=(\w+)/.exec(seen.firstText)![1]!;
		await hold(gates, name, seen.signal);
		return fauxAssistantMessage(`DONE\n${name} finished.`);
	};
	const t = await open({ config: { delegates: { max: 2 } }, worker });
	expect(await t.use({ action: "start", title: "first", brief: BRIEF("NAME=a") })).toMatch(/^Worker w1 has the job\. Its report/);
	expect(await t.use({ action: "start", title: "second", brief: BRIEF("NAME=b") })).toMatch(/^Worker w2 has the job\. Its report/);
	await t.until("two working", async () => (await t.workers()).filter((item) => item.status === "working").length === 2);
	// The third is not refused: it waits, and is told so.
	const third = await t.use({ action: "start", title: "third", brief: BRIEF("NAME=c") });
	expect(third).toMatch(/^Worker w3 has the job, and waits for a slot behind 1 \(this place runs 2 at once\)\./);
	await t.use({ action: "start", title: "fourth", brief: BRIEF("NAME=d") });
	await Bun.sleep(200);
	expect((await t.workers()).map((item) => item.status)).toEqual(["working", "working", "waiting", "waiting"]);
	expect(await t.use({ action: "list" }, "Listed.")).toMatch(/^\[w1\] working for \d+ s \(local\): first\n\[w2\] working for \d+ s \(local\): second\n\[w3\] waiting for a slot \(local\): third\n\[w4\] waiting for a slot \(local\): fourth$/);
	// A slot opens: the one that waited longest takes it, not the newest.
	t.queue.push(fauxAssistantMessage("Noted."));
	await pass(gates, "a");
	await t.until("the third to start", async () => (await t.workers())[2]!.status === "working");
	expect((await t.workers()).map((item) => item.status)).toEqual(["done", "working", "working", "waiting"]);
	for (const name of ["b", "c"]) await pass(gates, name);
	for (let n = 0; n < 3; n++) t.queue.push(fauxAssistantMessage("Noted."));
	await t.until("the fourth to start", async () => (await t.workers())[3]!.status === "working");
	await pass(gates, "d");
	await t.until("all four reports", async () => (await t.reports()).length === 4);
	expect((await t.reports()).map((text) => /\[worker (w\d)\]/.exec(text)![1])).toEqual(["w1", "w2", "w3", "w4"]);

	// A place that is short of memory: the ceiling is 4, but a second worker does not start beside a running one.
	let free = 100 * 1024 * 1024;
	const tight = await open({ config: { delegates: { max: 4 } }, worker, free: () => free });
	gates.clear();
	await tight.use({ action: "start", title: "one", brief: BRIEF("NAME=x") });
	await tight.use({ action: "start", title: "two", brief: BRIEF("NAME=y") });
	await tight.until("the first to start", async () => (await tight.workers())[0]!.status === "working"); // with nothing running, one job always starts
	await Bun.sleep(250);
	expect((await tight.workers()).map((item) => item.status)).toEqual(["working", "waiting"]);
	free = 4 * 1024 * 1024 * 1024; // memory comes back: the second starts without the first ending
	await tight.until("the second to start", async () => (await tight.workers())[1]!.status === "working");
	for (const name of ["x", "y"]) await pass(gates, name);
	tight.queue.push(fauxAssistantMessage("Noted."), fauxAssistantMessage("Noted."));
	await tight.until("both reports", async () => (await tight.reports()).length === 2);
	expect(localPlace({ ceiling: 0 }).ceiling).toBe(1);
	expect(localPlace({ free: () => 1, minFreeBytes: 10 }).room!()).toContain("MB of memory free");
	expect(localPlace({ free: () => 100, minFreeBytes: 10 }).room!()).toBeUndefined();
}, 90_000);

test("a worker can be stopped, running or waiting, and then reports nothing; what is refused is said", async () => {
	const t = await open({ config: { delegates: { max: 1 } }, worker: () => fauxAssistantMessage(fauxToolCall("bash", { command: "sleep 30" }), { stopReason: "toolUse" }) });
	await t.use({ action: "start", title: "long one", brief: BRIEF() });
	await t.use({ action: "start", title: "queued one", brief: BRIEF() });
	await t.until("the first to start", async () => (await t.workers())[0]!.status === "working");
	// The waiting one is stopped first: it never starts.
	expect(await t.use({ action: "stop", id: "w2" }, "Stopped.")).toBe("Stopped worker w2: queued one. It reports nothing more; what it changed is as it left it.");
	expect((await t.workers())[1]).toMatchObject({ status: "stopped" });
	expect((await t.workers())[1]!.conversation).toBeUndefined();
	// The running one: its command ends with it.
	const stopped = Date.now();
	expect(await t.use({ action: "stop", id: "w1" }, "Stopped.")).toContain("Stopped worker w1: long one.");
	expect(Date.now() - stopped).toBeLessThan(10_000);
	expect((await t.workers()).map((item) => item.status)).toEqual(["stopped", "stopped"]);
	await Bun.sleep(300);
	expect(await t.reports()).toEqual([]); // criterion 7: a stopped job reports nothing more
	expect(await t.use({ action: "stop", id: "w1" }, "Already.")).toBe("Worker w1 had already ended (stopped).");
	expect(await t.use({ action: "stop", id: "w9" }, "None.")).toContain('No worker "w9". None is running.');
	// What is not a job is refused in words that say what a brief is.
	expect(await t.use({ action: "start", brief: BRIEF() })).toContain("title is required");
	expect(await t.use({ action: "start", title: "x", brief: "fix it" })).toContain("The worker sees nothing of this conversation");
	expect(await t.use({ action: "start", title: "x", brief: "y".repeat(20_001) })).toContain("too long");
	expect((await t.workers()).length).toBe(2);
	// The tool can be left out.
	const off = await open({ config: { delegates: false } });
	expect((await off.core.root.agent(context)).tools.map((tool) => tool.name)).not.toContain("delegate");
}, 60_000);

test("a worker's records survive a clean restart, and a waiting job starts after it", async () => {
	const gates = new Map<string, () => void>();
	const worker = async (seen: ReturnType<typeof said>) => {
		const name = /NAME=(\w+)/.exec(seen.firstText)![1]!;
		if (!gates.has(`${name}-go`)) await hold(gates, name, seen.signal);
		return fauxAssistantMessage(`DONE\n${name} finished.`);
	};
	const first = await open({ config: { delegates: { max: 1 } }, worker });
	await first.use({ action: "start", title: "running", brief: BRIEF("NAME=a") });
	await first.use({ action: "start", title: "waiting", brief: BRIEF("NAME=b") });
	await first.until("the first to start", async () => (await first.workers())[0]!.status === "working");
	first.queue.push(fauxAssistantMessage("Noted."));
	await pass(gates, "a");
	await first.until("the first report", async () => (await first.reports()).length === 1);
	await first.core.harness.waitForIdle(context);
	await first.core.close();
	// Reopened: the finished one is still listed, and the one that waited is taken up.
	gates.set("b-go", () => {});
	const second = await open({ config: { delegates: { max: 1 } }, worker, reuse: first.parent });
	second.queue.push(fauxAssistantMessage("Noted."));
	await second.until("the second report", async () => (await second.reports()).length === 2, 20_000);
	expect((await second.workers()).map((item) => [item.title, item.status])).toEqual([["running", "done"], ["waiting", "done"]]);
	expect((await second.reports())[1]).toContain("[worker w2] waiting\nIt reports done.");
}, 60_000);
