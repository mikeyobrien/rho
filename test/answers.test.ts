import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { describeAnswers, readAnswers, recordAnswer, type AnswerLine } from "../src/answers.ts";
import { run } from "../src/cli.ts";
import { context, openCore, type Core } from "../src/core.ts";
import { COMMAND_TYPES, readDecisions, VERDICTS, type DecisionLine } from "../src/decider.ts";
import { serve, type Server } from "../src/http.ts";
import { Approvals } from "../src/tools/guard.ts";
import { isProtected } from "../src/tools/protected.ts";

// A real core and server with a scripted model. The commands asked for here are never allowed to
// run for real: the work directory is not a git checkout, and no test retries one after a yes.
const dirs: string[] = [];
const cores: Core[] = [];
const servers: Server[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) await server.stop().catch(() => undefined);
	for (const core of cores.splice(0)) await core.close().catch(() => undefined);
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
/** A stand-in decision server that calls every command a "send". */
const decider = (async () => {
	const spread = (keys: string[], pick: string) => Object.fromEntries(keys.map((key) => [key, key === pick ? 0.9 : 0.1 / (keys.length - 1)]));
	return Response.json({ answers: { type: { type: "choice", choice: "send", confidence: 0.9, probabilities: spread(Object.keys(COMMAND_TYPES), "send") }, verdict: { type: "choice", choice: "ask", confidence: 0.9, probabilities: spread(Object.keys(VERDICTS), "ask") }, leaves_machine: { type: "noul", noul: 0.9 }, reads_secrets: { type: "noul", noul: 0.1 }, hard_to_undo: { type: "noul", noul: 0.5 } } });
}) as unknown as typeof fetch;
async function open(withDecider = false) {
	// A scratch directory that was handed a deleted data directory's inode is kept and another made (see decider.test.ts).
	let parent = "";
	for (let tries = 0; ; tries++) {
		parent = realpathSync(mkdtempSync(join(tmpdir(), "rho-answers-")));
		dirs.push(parent);
		for (const made of ["data", "work"]) mkdirSync(join(parent, made));
		if (!isProtected(join(parent, "work"))) break;
		if (tries > 50) throw new Error("no scratch directory free of a stale inode");
	}
	const [dir, work] = [join(parent, "data"), join(parent, "work")];
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const core = await openCore({ dir, models, deciderFetch: decider, config: { model: `${faux.getModel().provider}/${faux.getModel().id}`, cwd: work, ...(withDecider ? { decider: { baseUrl: "http://127.0.0.1:8098" } } : {}) } });
	cores.push(core);
	const server = await serve({ core, models, dir, port: 0 });
	servers.push(server);
	const token = readFileSync(join(dir, "token"), "utf8");
	const approve = (id: string, allow: boolean) => fetch(`http://127.0.0.1:${server.port}/api/approve`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ id, allow }) });
	/** The agent calls a tool; the reply after it is plain words, so nothing is retried. */
	const ask = async (name: string, args: object) => {
		faux.setResponses([fauxAssistantMessage(fauxToolCall(name, args as never), { stopReason: "toolUse" }), fauxAssistantMessage("It needs your yes."), fauxAssistantMessage("Understood.")]);
		await (await core.root.submit({ type: "input", content: "go" }, context)).wait(context);
		await core.deciderIdle?.();
		return (await core.harness.snapshot(Approvals, core.root.id, context))!.pending;
	};
	return { core, dir, ask, approve, lines: () => readAnswers(dir) };
}

test("a request is a line when it is first shown, and the person's answer is a line with how long it waited", async () => {
	const { core, dir, ask, approve, lines } = await open();
	expect(existsSync(join(dir, "answers.jsonl"))).toBe(false);
	const [push] = await ask("bash", { command: "git push origin main" });
	expect(lines()).toEqual([{ at: expect.any(Number), event: "asked", id: push!.id, conversation: core.rootId, tool: "bash", what: "git push", command: "git push origin main" }]);
	expect(statSync(join(dir, "answers.jsonl")).mode & 0o777).toBe(0o600);
	// Asked again while it waits: still one request, still one line.
	await ask("bash", { command: "git push origin main" });
	expect(lines().length).toBe(1);
	await Bun.sleep(30);
	expect((await approve(push!.id, false)).status).toBe(200);
	await core.harness.waitForIdle(context);
	expect(lines().at(-1)).toEqual({ at: expect.any(Number), event: "deny", id: push!.id, conversation: core.rootId, tool: "bash", what: "git push", command: "git push origin main", waitedMs: expect.any(Number) });
	expect(lines().at(-1)!.waitedMs).toBeGreaterThanOrEqual(30);
	// An answer that did not land (the card was already answered) is not a line.
	expect((await approve(push!.id, true)).status).toBe(409);
	expect(lines().length).toBe(2);
	// A settings change is a request like any other, under its own tool.
	const pending = await ask("settings", { action: "set", name: "thinking", value: "high" });
	const change = pending.find((item) => item.tool === "settings")!;
	expect(lines().at(-1)).toMatchObject({ event: "asked", id: change.id, tool: "settings", what: 'changing rho\'s own setting "thinking"', command: 'set thinking to "high" (now not set)' });
	expect((await approve(change.id, true)).status).toBe(200);
	await core.harness.waitForIdle(context);
	expect(lines().map((line) => [line.event, line.tool])).toEqual([["asked", "bash"], ["deny", "bash"], ["asked", "settings"], ["allow", "settings"]]);
	// What rho refuses outright asked nobody, so it is not in the log; nor is ordinary work.
	await ask("bash", { command: "echo hello" });
	await ask("bash", { command: `cat ${join(dir, "token")}` });
	expect(lines().length).toBe(4);
	// The log is rho's data: the agent cannot read it.
	expect(isProtected(join(dir, "answers.jsonl"))).toBe(true);
}, 40_000);

test("the decider's label and the person's answer meet on the same tool call", async () => {
	const { dir, ask, approve, lines, core } = await open(true);
	const [push] = await ask("bash", { command: "git push origin main" });
	await approve(push!.id, true);
	await core.harness.waitForIdle(context);
	const decision = readDecisions(dir).find((line) => line.command === "git push origin main")!;
	expect(decision.call).toBe(push!.id);
	expect(decision).toMatchObject({ rule: "ask", type: { is: "send" } });
	expect(describeAnswers(lines(), readDecisions(dir)).split("\n")).toEqual(["1 request: 1 allowed.", expect.stringMatching(/^git push: 1 asked · 1 allowed · median wait \d+ s$/), "By the decider's type: send 1 (1 allowed)"]);
}, 40_000);

test("rho answers says how the requests went, by kind, and a log that cannot be written costs nothing", async () => {
	expect(describeAnswers([])).toContain("No requests yet.");
	const line = (event: AnswerLine["event"], id: string, what: string, command: string, waitedMs?: number): AnswerLine => ({ at: 1, event, id, conversation: "c", tool: "bash", what, command, ...(waitedMs === undefined ? {} : { waitedMs }) });
	const lines = [
		line("asked", "1", "git push", "git push origin v2"), line("allow", "1", "git push", "git push origin v2", 4_000),
		line("asked", "2", "git push", "git push --force"), line("deny", "2", "git push", "git push --force", 90_000),
		line("asked", "3", "git push", "git push origin v2"), line("allow", "3", "git push", "git push origin v2", 6_000),
		line("asked", "4", "putting new code into the running rho", "bin/rho release"),
	];
	const typed = (call: string, type: string): DecisionLine => ({ at: 1, mode: "shadow", conversation: "c", call, command: "x", rule: "ask", model: "m", ms: 300, type: { is: type as never, p: 0.9, margin: 0.8 } });
	expect(describeAnswers(lines, [typed("1", "send"), typed("2", "send"), typed("4", "system"), typed("99", "read"), { at: 1, mode: "shadow", conversation: "c", call: "3", command: "x", rule: "ask", model: "m", ms: 9, error: "down" }], 2).split("\n")).toEqual([
		"4 requests: 2 allowed · 1 denied · 1 not answered.",
		"git push: 3 asked · 2 allowed · 1 denied · median wait 6 s",
		"putting new code into the running rho: 1 asked · 0 allowed · 1 not answered",
		"By the decider's type: send 2 (1 allowed · 1 denied); system 1 (0 allowed · 1 not answered)",
		"allow after 6 s · git push · git push origin v2",
		"asked · putting new code into the running rho · bin/rho release",
	]);
	expect(describeAnswers([line("asked", "1", "git push", "git push"), line("allow", "1", "git push", "git push", 5 * 60_000)])).toContain("median wait 5 min");
	// The command reads the file; rho need not be running. A line cut short by a kill is skipped.
	const home = mkdtempSync(join(tmpdir(), "rho-answers-cli-"));
	dirs.push(home);
	mkdirSync(join(home, "v2"));
	const out: string[] = [];
	const cli = { env: { RHO_HOME: home }, out: (text: string) => out.push(text), openLink: () => false };
	expect(await run(["answers"], cli)).toBe(0);
	expect(out.at(-1)).toContain("No requests yet.");
	writeFileSync(join(home, "v2", "answers.jsonl"), `${JSON.stringify(lines[0])}\n${JSON.stringify(lines[1])}\n{"at":1,"eve`);
	expect(await run(["answers", "1"], cli)).toBe(0);
	expect(out.at(-1)!.split("\n")).toEqual(["1 request: 1 allowed.", "git push: 1 asked · 1 allowed · median wait 4 s", "allow after 4 s · git push · git push origin v2"]);
	// The line a kill cut short has no line end: the next line written is still a line of its own.
	// A very long command is cut in the log.
	recordAnswer(join(home, "v2"), line("asked", "9", "git push", `git push ${"x".repeat(5000)}`));
	expect(readAnswers(join(home, "v2")).map((item) => item.id)).toEqual(["1", "1", "9"]);
	expect(readAnswers(join(home, "v2")).at(-1)!.command.length).toBe(2000);
	recordAnswer(join(home, "v2"), line("deny", "9", "git push", "git push", 10));
	expect(readFileSync(join(home, "v2", "answers.jsonl"), "utf8").split("\n").filter((text) => text === "").length).toBe(1); // no blank lines but the file's end
	// A directory that is not there loses the line without a throw.
	expect(() => recordAnswer(join(home, "nowhere"), line("asked", "9", "git push", "git push"))).not.toThrow();
});
