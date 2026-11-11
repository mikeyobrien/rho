import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { context, openCore, type Core } from "../src/core.ts";
import { Approvals } from "../src/tools/guard.ts";
import { entryView, type EntryView } from "../src/view.ts";

// The real tool in a real core with a scripted model, running real shell commands in a scratch
// directory. No model is called.
const dirs: string[] = [];
const cores: Core[] = [];
afterEach(async () => {
	for (const core of cores.splice(0)) await core.close().catch(() => undefined);
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
type Seen = { role: string; text: string; from?: string };
async function open(config: object = {}, reuse?: string) {
	const parent = reuse ?? realpathSync(mkdtempSync(join(tmpdir(), "rho-background-")));
	if (!reuse) {
		dirs.push(parent);
		for (const made of ["data", "work"]) mkdirSync(join(parent, made));
	}
	const [dir, work] = [join(parent, "data"), join(parent, "work")];
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const logged: string[] = [];
	const core = await openCore({ dir, models, config: { model: `${faux.getModel().provider}/${faux.getModel().id}`, cwd: work, ...config }, log: (line) => logged.push(line) });
	cores.push(core);
	const entries = async (): Promise<Seen[]> =>
		(await core.root.entries({ order: "ascending" }, 300, undefined, context)).items.flatMap((entry) => {
			const view: EntryView | undefined = entryView(entry);
			return view && "text" in view ? [{ role: view.role, text: view.text, ...(view.role === "notice" ? { from: view.from } : {}) }] : [];
		});
	const call = (args: object) => fauxAssistantMessage(fauxToolCall("background", args as never), { stopReason: "toolUse" });
	/** The agent calls the tool once and then answers; returns the tool's result text. */
	const use = async (args: object, after = "Started.") => {
		faux.appendResponses([call(args), fauxAssistantMessage(after)]);
		await (await core.root.submit({ type: "input", content: "go" }, context)).wait(context);
		return (await entries()).findLast((entry) => entry.role === "tool")!.text;
	};
	const until = async (what: string, check: () => Promise<unknown> | unknown, ms = 15_000) => {
		const end = Date.now() + ms;
		while (!(await check())) {
			if (Date.now() > end) throw new Error(`timed out waiting for: ${what}; entries ${JSON.stringify(await entries()).slice(-600)}`);
			await Bun.sleep(40);
		}
	};
	const reports = async () => (await entries()).filter((entry) => entry.role === "notice" && entry.from === "background").map((entry) => entry.text);
	return { core, faux, parent, dir, work, logged, entries, use, until, reports };
}

test("a command started in the background returns at once, and its result arrives as one report the model answers", async () => {
	const { faux, work, use, until, reports, entries, core } = await open();
	// The model's answer to the report, scripted ahead: it comes after the job ends.
	const began = Date.now();
	const told = await use({ action: "start", command: "sleep 1; echo built > out.txt; echo all good" });
	expect(Date.now() - began).toBeLessThan(900); // the turn did not wait for the one-second command
	expect(told).toMatch(/^Started in the background \(b1\)\. You will be told how it ends/);
	expect(existsSync(join(work, "out.txt"))).toBe(false);
	expect(await reports()).toEqual([]);
	// While it runs the agent is free: the person asks something else and is answered.
	faux.appendResponses([fauxAssistantMessage("Tokyo."), fauxAssistantMessage("Good, the build passed.")]);
	await (await core.root.submit({ type: "input", content: "Capital of Japan?" }, context)).wait(context);
	expect((await entries()).at(-1)).toMatchObject({ role: "assistant", text: "Tokyo." });
	expect(await reports()).toEqual([]);
	// Then the report: once, as a message the person did not write, and the model takes a turn on it.
	await until("the report", async () => (await reports()).length === 1);
	expect((await reports())[0]).toMatch(/^\[background\] `sleep 1; echo built > out\.txt; echo all good` passed in \d+ s\.$/);
	expect(readFileSync(join(work, "out.txt"), "utf8")).toBe("built\n");
	await core.harness.waitForIdle(context);
	expect((await entries()).at(-1)).toMatchObject({ role: "assistant", text: "Good, the build passed." });
	expect((await reports()).length).toBe(1);
	// The status afterwards.
	expect(await use({ action: "status" }, "Nothing running.")).toMatch(/^Nothing is running\.\npassed \(exit 0\) after \d+ s: sleep 1; echo built > out\.txt; echo all good$/);
}, 40_000);

test("a failure reports its exit code and last lines; a time limit and a stop are said as what they are", async () => {
	const { faux, use, until, reports, core } = await open();
	faux.appendResponses([]);
	const failing = `for i in $(seq 1 60); do echo "line $i"; done; echo "error: the test failed" >&2; exit 3`;
	await use({ action: "start", command: failing });
	faux.appendResponses([fauxAssistantMessage("I see the failure.")]);
	await until("the failure report", async () => (await reports()).length === 1);
	const [report] = await reports();
	expect(report).toMatch(/^\[background\] `for i in \$\(seq 1 60\).*` failed \(exit 3\) after \d+ s\.\nIts last lines:\n/);
	expect(report).toContain("… (21 earlier lines left out)"); // 61 lines, the newest 40 kept
	expect(report).toContain("line 60\nerror: the test failed");
	expect(report).not.toContain("line 20\n");
	await core.harness.waitForIdle(context);
	// A time limit.
	await use({ action: "start", command: "echo begun; sleep 30", timeout: 5 });
	faux.appendResponses([fauxAssistantMessage("It timed out.")]);
	await until("the timeout report", async () => (await reports()).length === 2, 20_000);
	expect((await reports())[1]).toMatch(/^\[background\] `echo begun; sleep 30` was stopped at its time limit after \d+ s\.\nIts last lines:\nbegun$/);
	await core.harness.waitForIdle(context);
	// A stop: the command ends, and nothing more is said about it.
	await use({ action: "start", command: "sleep 30" });
	expect(await use({ action: "status" }, "Running.")).toMatch(/^Running for \d+ s: sleep 30\n/);
	const stopped = Date.now();
	expect(await use({ action: "stop" }, "Stopped.")).toBe("Stopped: sleep 30");
	expect(Date.now() - stopped).toBeLessThan(8_000);
	expect(await use({ action: "status" }, "Idle.")).toMatch(/^Nothing is running\.\nstopped after \d+ s: sleep 30\n/);
	await Bun.sleep(300);
	expect((await reports()).length).toBe(2);
	expect(await use({ action: "stop" }, "Nothing to stop.")).toBe("Nothing is running.");
}, 90_000);

test("one at a time, and the guard judges the command as it judges bash", async () => {
	const { use, until, reports, faux, core, dir, work } = await open();
	await use({ action: "start", command: "sleep 2" });
	const second = await use({ action: "start", command: "echo second > second.txt" });
	expect(second).toMatch(/One is already running \(for \d+ s\): sleep 2\. Wait for its report, or stop it first\./);
	expect(existsSync(join(work, "second.txt"))).toBe(false);
	faux.appendResponses([fauxAssistantMessage("Done.")]);
	await until("the first report", async () => (await reports()).length === 1);
	await core.harness.waitForIdle(context);
	// What bash would refuse is refused here, and nothing is started.
	expect(await use({ action: "start", command: `cat ${join(dir, "token")}` })).toContain("Refused: rho's own data");
	expect(await use({ action: "start", command: ["rm", "-rf", ".git"].join(" ") })).toContain("Refused: deleting a git directory");
	// What bash would hold for the person's yes waits here, as a card, and does not run.
	const held = await use({ action: "start", command: ["git", "push", "origin", "main"].join(" ") });
	expect(held).toContain("waits for the person's yes");
	expect(((await core.harness.snapshot(Approvals, core.root.id, context))?.pending ?? []).map((ask) => ask.what)).toEqual(["git push"]);
	expect(await use({ action: "status" }, "Idle.")).toMatch(/^Nothing is running\./);
	expect(await use({ action: "start" })).toContain("command is required");
	expect((await reports()).length).toBe(1);
}, 60_000);

test("the tool can be left out, and a restart with nothing running changes nothing", async () => {
	const off = await open({ background: false });
	expect((await off.core.root.agent(context)).tools.map((tool) => tool.name)).not.toContain("background");
	const on = await open();
	expect((await on.core.root.agent(context)).tools.map((tool) => tool.name)).toContain("background");
	await on.use({ action: "start", command: "echo quick" });
	on.faux.appendResponses([fauxAssistantMessage("Good.")]);
	await on.until("the report", async () => (await on.reports()).length === 1);
	await on.core.harness.waitForIdle(context);
	await on.core.close();
	const again = await open({}, on.parent);
	await Bun.sleep(300);
	expect((await again.reports()).length).toBe(1);
	expect(await again.use({ action: "status" }, "Idle.")).toMatch(/^Nothing is running\.\npassed \(exit 0\)/);
}, 40_000);
