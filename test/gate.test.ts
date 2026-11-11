import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeRelease, preflight, release, releaseView, type GateHost } from "../src/gate.ts";
import { judgeCommand } from "../src/tools/guard.ts";

// The gate against a small stand-in program in real git checkouts: a "release" checkout the
// program runs from and a "work" checkout where commits are made. The program is a real
// process that answers with the commit it was started from, so health is really checked.
const dirs: string[] = [];
const procs: ReturnType<typeof Bun.spawn>[] = [];
afterEach(() => {
	for (const proc of procs.splice(0)) proc.kill("SIGKILL");
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = (prefix: string) => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	dirs.push(dir);
	return dir;
};
const git = (cwd: string, ...args: string[]) => {
	const result = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } });
	if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
	return result.stdout.toString().trim();
};
const APP = `const commit = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: import.meta.dir }).stdout.toString().trim();
Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT), fetch: () => new Response(commit) });
`;
let nextPort = 5400 + Math.floor(Math.random() * 400);
async function setup() {
	const work = scratch("rho-gate-work-");
	const releaseDir = scratch("rho-gate-release-");
	const dataDir = scratch("rho-gate-data-");
	git(work, "init", "-q", "-b", "main");
	writeFileSync(join(work, "app.ts"), APP);
	writeFileSync(join(work, "check.sh"), "exit 0\n");
	git(work, "add", ".");
	git(work, "commit", "-q", "-m", "first");
	git(releaseDir, "clone", "-q", work, ".");
	const port = nextPort++;
	const events: string[] = [];
	const notes: { text: string; key: string }[] = [];
	let proc: ReturnType<typeof Bun.spawn> | undefined;
	const host: GateHost = {
		releaseDir,
		dataDir,
		install: ["true"],
		check: ["bash", "check.sh"],
		stop: async () => {
			events.push("stop");
			proc?.kill("SIGKILL");
			await proc?.exited;
			proc = undefined;
		},
		start: async () => {
			events.push(`start ${git(releaseDir, "rev-parse", "--short", "HEAD")}`);
			proc = Bun.spawn([process.execPath, join(releaseDir, "app.ts")], { env: { ...process.env, PORT: String(port) }, stdout: "ignore", stderr: "ignore" });
			procs.push(proc);
		},
		healthy: async (commit) => (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) }).then((response) => response.text(), () => "")) === commit,
		notify: async (text, key) => void notes.push({ text, key }),
		log: (line) => events.push(line),
		healthTimeoutMs: 4_000,
		checkTimeoutMs: 10_000,
	};
	await host.start();
	const first = git(work, "rev-parse", "HEAD");
	while (!(await host.healthy(first))) await Bun.sleep(50);
	events.length = 0;
	/** Commit a change in the work checkout; returns the commit. */
	const commit = (files: Record<string, string>, message: string) => {
		for (const [name, text] of Object.entries(files)) writeFileSync(join(work, name), text);
		git(work, "add", ".");
		git(work, "commit", "-q", "-m", message);
		return git(work, "rev-parse", "HEAD");
	};
	const running = () => fetch(`http://127.0.0.1:${port}/`).then((response) => response.text(), () => "(nothing answers)");
	const record = () => JSON.parse(readFileSync(join(dataDir, "release.json"), "utf8"));
	return { work, releaseDir, dataDir, host, first, commit, running, record, events, notes, head: () => git(releaseDir, "rev-parse", "HEAD") };
}
const leftovers = () => readdirSync(tmpdir()).filter((name) => name.startsWith("rho-release-"));

test("a good commit is checked, adopted, and the restarted program runs it", async () => {
	const t = await setup();
	const before = leftovers().length;
	const good = t.commit({ "notes.txt": "a change\n" }, "a good change");
	const outcome = await release(t.host, t.work);
	expect(outcome).toMatchObject({ status: "released", commit: good, previous: t.first });
	expect(t.head()).toBe(good);
	expect(await t.running()).toBe(good); // the process that answers was started from the new commit
	expect(existsSync(join(t.releaseDir, "notes.txt"))).toBe(true);
	expect(t.record()).toMatchObject({ status: "released", commit: good });
	expect(t.notes).toEqual([{ key: `release:${good.slice(0, 7)}:released`, text: expect.stringContaining(`Rho now runs ${good.slice(0, 7)} (it ran ${t.first.slice(0, 7)})`) }]);
	// The check came before the restart, and the copy it ran in is gone.
	const order = t.events.filter((line) => /: check$|^stop$|^start /.test(line));
	expect(order).toEqual([`release ${good.slice(0, 7)}: check`, "stop", `start ${good.slice(0, 7)}`]);
	expect(leftovers().length).toBe(before);
	expect(git(t.releaseDir, "worktree", "list").split("\n").length).toBe(1);
	// A commit on another branch of the work checkout can be released by name.
	git(t.work, "checkout", "-q", "-b", "side");
	const side = t.commit({ "side.txt": "x\n" }, "on a side branch");
	git(t.work, "checkout", "-q", "main");
	expect(await release(t.host, t.work, "side")).toMatchObject({ status: "released", commit: side, previous: good });
	expect(await t.running()).toBe(side);
}, 40_000);

test("a rho that had a model before the restart and has none after is released with the reason said", async () => {
	const t = await setup();
	t.commit({ "notes.txt": "second\n" }, "second");
	let asked = 0;
	const outcome = await release({ ...t.host, ready: async () => asked++ === 0 }, t.work); // ready before, not after
	expect(outcome.status).toBe("released");
	expect(outcome.reason).toContain("came up without a model");
	expect(outcome.reason).toContain("rho key <provider>");
	expect(t.record().reason).toContain("rho key");
	expect(t.events).toContain("release: rho had a model before the restart and has none now");
	// Ready both times: nothing is said.
	t.commit({ "notes.txt": "third\n" }, "third");
	expect((await release({ ...t.host, ready: async () => true }, t.work)).reason).toBeUndefined();
});

test("a commit whose checks fail is not adopted: nothing is switched and nothing is restarted", async () => {
	const t = await setup();
	const bad = t.commit({ "check.sh": "echo 'expected 2, got 3'; exit 1\n", "notes.txt": "must not appear\n" }, "breaks the checks");
	const outcome = await release(t.host, t.work);
	expect(outcome).toMatchObject({ status: "failed", commit: bad, previous: t.first });
	expect(outcome.reason).toContain("Its checks failed (exit 1)");
	expect(outcome.reason).toContain("expected 2, got 3"); // the check's own words reach the report
	expect(t.head()).toBe(t.first);
	expect(await t.running()).toBe(t.first);
	expect(existsSync(join(t.releaseDir, "notes.txt"))).toBe(false);
	expect(t.events.filter((line) => line === "stop" || line.startsWith("start "))).toEqual([]); // the running program was never touched
	expect(t.notes[0]!.text).toContain(`${bad.slice(0, 7)} was not released, and rho still runs ${t.first.slice(0, 7)}`);
	expect(git(t.releaseDir, "status", "--porcelain")).toBe("");
	// Checks that never finish count as failed.
	const slow = t.commit({ "check.sh": "sleep 60\n" }, "hangs");
	expect((await release({ ...t.host, checkTimeoutMs: 500 }, t.work)).reason).toContain("timed out");
	expect(await t.running()).toBe(t.first);
	expect(slow).not.toBe(t.head());
}, 40_000);

test("a commit that passes its checks but does not start is rolled back to the last good one", async () => {
	const t = await setup();
	const broken = t.commit({ "app.ts": "throw new Error('cannot start');\n" }, "passes checks, crashes on start");
	const outcome = await release(t.host, t.work);
	expect(outcome).toMatchObject({ status: "rolled-back", commit: broken, previous: t.first });
	expect(t.head()).toBe(t.first);
	expect(await t.running()).toBe(t.first); // the old program answers again
	expect(readFileSync(join(t.releaseDir, "app.ts"), "utf8")).toBe(APP);
	expect(t.events.filter((line) => line === "stop" || line.startsWith("start "))).toEqual(["stop", `start ${broken.slice(0, 7)}`, "stop", `start ${t.first.slice(0, 7)}`]);
	expect(t.notes[0]!.text).toContain(`did not start, so rho is back on ${t.first.slice(0, 7)}`);
	expect(t.record()).toMatchObject({ status: "rolled-back" });
	// A program that starts but is the wrong commit is no better than one that does not start.
	const liar = t.commit({ "app.ts": `Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT), fetch: () => new Response("${t.first}") });\n` }, "answers as the old commit");
	expect(await release(t.host, t.work)).toMatchObject({ status: "rolled-back", commit: liar });
	expect(await t.running()).toBe(t.first);
	// After a rollback a good commit is still released.
	const fixed = t.commit({ "app.ts": APP }, "fixed");
	expect(await release(t.host, t.work)).toMatchObject({ status: "released", commit: fixed });
	expect(await t.running()).toBe(fixed);
}, 60_000);

test("when going back fails too, the gate says rho is down and sends no report it cannot deliver", async () => {
	const t = await setup();
	t.commit({ "app.ts": "throw new Error('cannot start');\n" }, "crashes");
	let starts = 0;
	const outcome = await release({ ...t.host, healthTimeoutMs: 800, start: async () => void (starts++ > 0 ? undefined : await t.host.start()) }, t.work);
	expect(outcome.status).toBe("down");
	expect(outcome.reason).toContain("Going back");
	expect(t.head()).toBe(t.first); // the checkout is back on the old commit, ready for a start by hand
	expect(t.notes).toEqual([]);
	expect(t.record().status).toBe("down");
}, 40_000);

test("what the gate refuses before doing anything", async () => {
	const t = await setup();
	expect(await release(t.host, t.work)).toMatchObject({ status: "refused", reason: expect.stringContaining("already runs") });
	expect(await preflight(t.releaseDir, t.releaseDir, "HEAD")).toEqual({ refused: expect.stringContaining("This is the checkout rho runs from") });
	expect(await preflight(t.releaseDir, scratch("rho-gate-none-"), "HEAD")).toEqual({ refused: expect.stringContaining("inside the git checkout") });
	expect(await preflight(scratch("rho-gate-none-"), t.work, "HEAD")).toEqual({ refused: expect.stringContaining("does not run from a git checkout") });
	t.commit({ "notes.txt": "x\n" }, "next");
	expect(await preflight(t.releaseDir, t.work, "no-such-branch")).toEqual({ refused: "No such commit: no-such-branch" });
	// Someone edited the running checkout by hand: it is not switched from under them.
	writeFileSync(join(t.releaseDir, "app.ts"), `${APP}// a local edit\n`);
	const dirty = await release(t.host, t.work);
	expect(dirty).toMatchObject({ status: "refused", reason: expect.stringContaining("uncommitted changes") });
	expect(readFileSync(join(t.releaseDir, "app.ts"), "utf8")).toContain("// a local edit");
	expect(t.events.filter((line) => line === "stop")).toEqual([]);
});

test("the switch waits for rho to be idle, but not for ever", async () => {
	const t = await setup();
	const good = t.commit({ "notes.txt": "x\n" }, "good");
	let asked = 0;
	const outcome = await release({ ...t.host, idle: async () => ++asked >= 3 }, t.work);
	expect(outcome.status).toBe("released");
	expect(asked).toBe(3);
	const next = t.commit({ "notes.txt": "y\n" }, "next");
	const started = Date.now();
	expect((await release({ ...t.host, idle: async () => false, idleTimeoutMs: 700 }, t.work)).status).toBe("released"); // a run that never ends does not hold a release for ever
	expect(Date.now() - started).toBeGreaterThan(600);
	expect(await t.running()).toBe(next);
	expect(good).not.toBe(next);
}, 40_000);

test("the agent's own `rho release` waits for the person's yes; looking at the status does not", () => {
	const judge = (command: string) => judgeCommand(command, "/home/u/.rho/v2", "/home/u").kind;
	for (const command of ["rho release", "rho release HEAD", "cd ../work && rho release v2", "bin/rho release"]) expect([command, judge(command)]).toEqual([command, "ask"]);
	for (const command of ["rho release --status", "rho status", "rho logs 20"]) expect([command, judge(command)]).toEqual([command, "allow"]);
});

test("the page is shown a release that is under way, and one that just ended, and nothing of a dead gate", async () => {
	const dir = scratch("rho-gate-view-");
	const write = (record: object | string) => writeFileSync(join(dir, "release.json"), typeof record === "string" ? record : JSON.stringify(record));
	const [commit, previous] = ["a".repeat(40), "b".repeat(40)];
	expect(releaseView(dir)).toBeUndefined(); // no release yet
	// Under way: the gate's process lives. Commits are short; the gate's pid and the data's path are not shown.
	write({ status: "running", stage: "check", commit, previous, pid: process.pid, started: 1000, at: 5000 });
	expect(releaseView(dir)).toEqual({ status: "running", stage: "check", commit: "aaaaaaa", previous: "bbbbbbb", started: 1000, at: 5000 });
	// A record written before `started` existed counts from its stage.
	write({ status: "running", stage: "check", commit, previous, pid: process.pid, at: 5000 });
	expect(releaseView(dir)!.started).toBe(5000);
	// A gate that was killed left "running" behind: there is no release to show.
	const gone = Bun.spawnSync(["true"]).pid;
	write({ status: "running", stage: "check", commit, previous, pid: gone, started: 1000, at: 5000 });
	expect(releaseView(dir)).toBeUndefined();
	// How it ended is shown for five minutes, without the reason's text (a check's output can be long and is in the thread).
	for (const status of ["released", "failed", "rolled-back"]) {
		write({ status, commit, previous, reason: "Its checks failed (exit 1):\nlots of output", at: 10_000 });
		expect(releaseView(dir, 10_000 + 4 * 60_000)).toEqual({ status: status as never, commit: "aaaaaaa", previous: "bbbbbbb", at: 10_000 });
		expect(releaseView(dir, 10_000 + 6 * 60_000)).toBeUndefined();
	}
	// A refusal changed nothing and names no commit; a record cut short by a kill is no record.
	write({ status: "refused", reason: "Rho already runs aaaaaaa.", at: 10_000 });
	expect(releaseView(dir, 10_000)).toBeUndefined();
	write('{"status":"running","sta');
	expect(releaseView(dir)).toBeUndefined();
	write("null");
	expect(releaseView(dir)).toBeUndefined();
});

test("a real release records when it began, and each stage keeps that time", async () => {
	const t = await setup();
	const good = t.commit({ "notes.txt": "x\n" }, "good");
	const seen: { stage: string; started: number; at: number }[] = [];
	// The record as it stands when rho is stopped for the restart.
	const outcome = await release({ ...t.host, stop: async () => (seen.push(t.record()), t.host.stop()) }, t.work);
	expect(outcome.status).toBe("released");
	expect(seen[0]).toMatchObject({ status: "running", stage: "restart", commit: good, previous: t.first, pid: process.pid });
	expect(seen[0]!.started).toBeLessThanOrEqual(seen[0]!.at);
	expect(releaseView(t.dataDir)).toEqual({ status: "released", commit: good.slice(0, 7), previous: t.first.slice(0, 7), at: outcome.at });
}, 30_000);

test("a release's card says what it brings in, and says nothing of a command that is more than a release", async () => {
	const t = await setup();
	const a = t.commit({ "notes.txt": "x\n" }, "Add the notes");
	const b = t.commit({ "notes.txt": "y\n" }, `A very long title ${"that goes on ".repeat(12)}`);
	const [s, was] = [(commit: string) => commit.slice(0, 7), t.first.slice(0, 7)];
	const lines = await describeRelease(t.releaseDir, t.work, "rho release");
	expect(lines).toEqual([
		`Rho will run ${s(b)} (now ${was}).`,
		"It brings in 2 commits:",
		expect.stringMatching(new RegExp(`^${s(b)} A very long title .{60,}…$`)),
		`${s(a)} Add the notes`,
		"The gate runs the checks first. If they fail, nothing changes.",
		`If it does not start, rho goes back to ${was}.`,
	]);
	expect(lines![2]!.length).toBe(90);
	// The forms the agent types: a path to the command, a `cd` first, a commit by name.
	expect((await describeRelease(t.releaseDir, t.work, "bin/rho release"))![0]).toBe(lines![0]);
	expect((await describeRelease(t.releaseDir, "/", `cd ${t.work} && bin/rho release`))![0]).toBe(lines![0]);
	expect((await describeRelease(t.releaseDir, t.work, `rho release ${a}`))!.slice(0, 3)).toEqual([`Rho will run ${s(a)} (now ${was}).`, "It brings in 1 commit:", `${s(a)} Add the notes`]);
	expect((await describeRelease(t.releaseDir, t.work, "rho release HEAD~1"))![0]).toBe(`Rho will run ${s(a)} (now ${was}).`);
	// More than six commits: the newest six by title, and a count of the rest.
	for (let n = 0; n < 6; n++) t.commit({ "notes.txt": `${n}\n` }, `step ${n}`);
	const many = (await describeRelease(t.releaseDir, t.work, "rho release"))!;
	expect(many[1]).toBe("It brings in 8 commits:");
	expect(many.slice(2, 9).map((line) => line.replace(/^[0-9a-f]{7} /, ""))).toEqual(["step 5", "step 4", "step 3", "step 2", "step 1", "step 0", "and 2 more"]);
	// What the gate would refuse is said on the card, before a yes is spent on it.
	expect(await describeRelease(t.releaseDir, t.work, "rho release nope")).toEqual(["The gate would refuse it: No such commit: nope"]);
	expect(await describeRelease(t.releaseDir, t.releaseDir, "rho release")).toEqual([expect.stringContaining("The gate would refuse it: This is the checkout rho runs from.")]);
	// A release to an older commit leaves commits out, and says so.
	expect((await release(t.host, t.work)).status).toBe("released");
	const back = (await describeRelease(t.releaseDir, t.work, `rho release ${a}`))!;
	// Going back brings nothing in, so only what is left out is said.
	expect(back.slice(0, 2)).toEqual([`Rho will run ${s(a)} (now ${many[0]!.slice(13, 20)}).`, "It leaves out 7 commits that rho runs now."]);
	// A command that does anything besides the release is not described: the lines could not be trusted to match it.
	for (const command of ["git commit -am x && rho release", "rho release; rm -rf dist", "rho release $(cat ref)", "rho release `cat ref`", "rho release HEAD | tee log", "cd a && cd b && rho release", "echo rho release", "rho release HEAD extra", "rho release --status", "rho release -f"]) expect([command, await describeRelease(t.releaseDir, t.work, command)]).toEqual([command, undefined]);
}, 60_000);
