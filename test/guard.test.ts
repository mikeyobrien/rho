import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { context, openCore, type Core } from "../src/core.ts";
import { serve, type Server } from "../src/http.ts";
import { answerApproval, Approvals, judgeCommand } from "../src/tools/guard.ts";
import { entryView, type EntryView, type StateView } from "../src/view.ts";

type ToolEntry = Extract<EntryView, { role: "tool" }>;
const dirs: string[] = [];
const cores: Core[] = [];
const servers: Server[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) await server.stop().catch(() => undefined);
	for (const core of cores.splice(0)) await core.close().catch(() => undefined);
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = (prefix: string) => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	dirs.push(dir);
	return dir;
};
async function open(config: object = {}, reuse?: { dir: string; work: string }) {
	const dir = reuse?.dir ?? scratch("rho-guard-data-");
	const work = reuse?.work ?? scratch("rho-guard-work-");
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const core = await openCore({ dir, models, config: { model: `${faux.getModel().provider}/${faux.getModel().id}`, cwd: work, ...config } });
	cores.push(core);
	const call = (name: string, args: object) => fauxAssistantMessage(fauxToolCall(name, args as never), { stopReason: "toolUse" });
	const entries = async () => (await core.root.entries({ order: "ascending" }, 300, undefined, context)).items.flatMap((entry) => entryView(entry) ?? []);
	const use = async (name: string, args: object): Promise<ToolEntry> => {
		faux.setResponses([call(name, args), fauxAssistantMessage("done")]);
		await (await core.root.submit({ type: "input", content: "go" }, context)).wait(context);
		return (await entries()).findLast((entry): entry is ToolEntry => entry.role === "tool")!;
	};
	const waiting = async () => (await core.harness.snapshot(Approvals, core.root.id, context))?.pending ?? [];
	return { core, faux, models, dir, work, call, use, entries, waiting };
}

test("the rules, as text: what is refused, what waits, and what is ordinary work", () => {
	const data = "/home/u/.rho/v2";
	const judge = (command: string) => judgeCommand(command, data, "/home/u").kind;
	for (const command of ["rm -rf .git", "rm -rf ./.git", "rm -r /work/repo/.git", "rm -rf .git/", "cd repo && rm -rf .git", "rm -rf .git/objects", "rm -f .git/index", 'rm -rf "$repo/.git"', "sudo rm -rf sub/.git"]) expect([command, judge(command)]).toEqual([command, "refuse"]);
	for (const command of ["cat /home/u/.rho/v2/token", "rm -rf ~/.rho/v2", "sqlite3 $HOME/.rho/v2/rho.sqlite .dump", "echo x > ${HOME}/.rho/v2/config.json", "ls /home/u/.rho/v2"]) expect([command, judge(command)]).toEqual([command, "refuse"]);
	for (const command of ["git push", "git push origin v2", "git push --force", "git -C /repo push", "git -c user.name=x push origin", "cd repo && git push", "npm publish", "bun publish --access public", "pnpm publish", "gh release create v2.0.0", "gh pr merge 12", "gh repo delete x"]) expect([command, judge(command)]).toEqual([command, "ask"]);
	// Ordinary work, including things that only look alike.
	for (const command of ["rm -rf node_modules dist", "rm .gitignore", "rm -rf .github/workflows", "rm notes.gitx", "git status", "git commit -m 'push the button'", "git log --grep=push", "git stash push", "echo 'run git push yourself'  # a note", "ls ~/.rho", "cat ~/.rho/brain/brain.jsonl", "bun run check", "git pull", "gh pr view 3"]) {
		const verdict = judge(command);
		// One of these is the rules' known false alarm: text that names a push without doing one.
		expect([command, verdict]).toEqual([command, /git push yourself/.test(command) ? "ask" : "allow"]);
	}
});

test("deleting a git directory is refused and nothing is deleted", async () => {
	const { use, work } = await open();
	mkdirSync(join(work, ".git", "objects"), { recursive: true });
	writeFileSync(join(work, ".git", "HEAD"), "ref: refs/heads/main\n");
	const refused = await use("bash", { command: "rm -rf .git" });
	expect(refused.error).toBe(true);
	expect(refused.text).toContain("Refused: deleting a git directory");
	expect(readFileSync(join(work, ".git", "HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
	expect((await use("bash", { command: "rm -rf .git/objects && echo gone" })).error).toBe(true);
	expect(existsSync(join(work, ".git", "objects"))).toBe(true);
	// Ordinary deletes still work.
	writeFileSync(join(work, "scratch.txt"), "x");
	expect((await use("bash", { command: "rm scratch.txt .gitignore 2>/dev/null; echo ok" })).text).toContain("ok");
	expect(existsSync(join(work, "scratch.txt"))).toBe(false);
});

test("rho's own data is refused to every tool, also by a relative path or through a link", async () => {
	const { use, dir, work } = await open();
	const token = join(dir, "token");
	writeFileSync(token, "the-secret-token");
	symlinkSync(dir, join(work, "link-to-data"));
	const before = readFileSync(join(dir, "rho.lock"), "utf8");
	const tries: [string, object][] = [
		["read", { path: token }],
		["read", { path: "link-to-data/token" }],
		["write", { path: join(dir, "config.json"), content: "{}" }],
		["write", { path: "link-to-data/planted.txt", content: "x" }], // a new file: only its parent exists to be resolved
		["write", { path: "link-to-data/new/deeper/planted.txt", content: "x" }],
		["edit", { path: token, edits: [{ oldText: "the-secret", newText: "changed" }] }],
		["ls", { path: dir }],
		["find", { pattern: "*", path: dir }],
		["grep", { pattern: "secret", path: dir }],
		["grep", { pattern: "secret", path: "link-to-data" }],
		["bash", { command: `cat ${token}` }],
		["bash", { command: `echo x >> ${join(dir, "config.json")}` }],
	];
	for (const [name, args] of tries) {
		const result = await use(name, args);
		expect([name, JSON.stringify(args).slice(0, 60), result.error, result.text.includes("the-secret-token")]).toEqual([name, JSON.stringify(args).slice(0, 60), true, false]);
		expect(result.text).toContain("rho's own data");
	}
	expect(readFileSync(token, "utf8")).toBe("the-secret-token");
	expect(existsSync(join(dir, "planted.txt"))).toBe(false);
	expect(existsSync(join(dir, "config.json"))).toBe(false);
	expect(readFileSync(join(dir, "rho.lock"), "utf8")).toBe(before);
	// A search from above the data directory passes over it instead of failing.
	writeFileSync(join(work, "mine.txt"), "the-secret-token is mentioned here\n");
	const above = await use("grep", { pattern: "the-secret-token", path: join(dir, "..") });
	expect(above.text).not.toContain(`${dir.split("/").at(-1)}/token`);
});

test("a push waits for the person: it does not run, a yes runs that command once, and a no runs nothing", async () => {
	const { core, faux, call, use, work, waiting } = await open();
	const remote = scratch("rho-guard-remote-");
	const git = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" } }).stdout.toString().trim();
	git(remote, "init", "-q", "--bare");
	git(work, "init", "-q", "-b", "main");
	writeFileSync(join(work, "a.txt"), "a\n");
	git(work, "add", "a.txt");
	git(work, "commit", "-q", "-m", "first");
	git(work, "remote", "add", "origin", remote);
	const pushed = () => git(remote, "rev-parse", "--verify", "-q", "refs/heads/main");

	const held = await use("bash", { command: "git push origin main" });
	expect(held.error).toBe(true);
	expect(held.text).toContain("waits for the person's yes");
	expect(pushed()).toBe(""); // nothing was pushed
	const [ask] = await waiting();
	expect(ask).toMatchObject({ tool: "bash", command: "git push origin main", what: "git push" });
	await use("bash", { command: "git push origin main" }); // asked again while it waits: still one request, still not run
	expect((await waiting()).length).toBe(1);
	expect(pushed()).toBe("");

	// A yes for one command is not a yes for another.
	expect(await answerApproval(core.root, ask!.id, true, context)).toMatchObject({ command: "git push origin main" });
	expect(await answerApproval(core.root, ask!.id, true, context)).toBeUndefined(); // an approval answers once
	expect((await use("bash", { command: "git push --force origin main" })).text).toContain("waits for the person's yes");
	expect(pushed()).toBe("");
	const ran = await use("bash", { command: "git push origin main" });
	expect(ran.error).toBeUndefined();
	expect(pushed()).toBe(git(work, "rev-parse", "HEAD"));
	// And it was a yes for once: the same command waits again.
	expect((await use("bash", { command: "git push origin main" })).text).toContain("waits for the person's yes");

	// A no clears the request and grants nothing.
	const again = (await waiting()).find((pending) => pending.command === "git push origin main")!;
	await answerApproval(core.root, again.id, false, context);
	expect((await waiting()).map((pending) => pending.command)).toEqual(["git push --force origin main"]);
	faux.setResponses([call("bash", { command: "npm publish" }), fauxAssistantMessage("waiting")]);
	await (await core.root.submit({ type: "input", content: "publish" }, context)).wait(context);
	expect((await waiting()).map((pending) => pending.what)).toEqual(["git push", "publishing a package"]);
}, 30_000);

test("a waiting request and a given yes both survive a restart", async () => {
	const first = await open();
	await first.use("bash", { command: "git push origin v2" });
	const [ask] = await first.waiting();
	await first.core.close();
	const second = await open({}, first);
	expect(await second.waiting()).toEqual([ask!]);
	await answerApproval(second.core.root, ask!.id, true, context);
	await second.core.close();
	const third = await open({}, first);
	expect(await third.waiting()).toEqual([]);
	// The grant is still there: the command runs (and fails as git, not as a refusal).
	const ran = await third.use("bash", { command: "git push origin v2" });
	expect(ran.text).not.toContain("waits for the person's yes");
	expect(ran.text).toMatch(/not a git repository|fatal/i);
}, 30_000);

test("over HTTP: the request is in the state, Allow answers once and tells the agent, and a second answer changes nothing", async () => {
	const { core, faux, models, dir, call } = await open();
	const server = await serve({ core, models, dir, port: 0 });
	servers.push(server);
	const token = readFileSync(join(dir, "token"), "utf8");
	const post = (path: string, body: object) => fetch(`http://127.0.0.1:${server.port}${path}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
	const state = async (): Promise<StateView> => {
		const response = await fetch(`http://127.0.0.1:${server.port}/api/events`, { headers: { authorization: `Bearer ${token}` } });
		const reader = response.body!.getReader();
		const { value } = await reader.read();
		await reader.cancel();
		return JSON.parse(new TextDecoder().decode(value).split("\n\n")[0]!.slice(6)) as StateView;
	};
	faux.setResponses([call("bash", { command: "git push origin main" }), fauxAssistantMessage("It needs your yes."), call("bash", { command: "git push origin main" }), fauxAssistantMessage("Tried it.")]);
	await (await core.root.submit({ type: "input", content: "push" }, context)).wait(context);
	const asked = (await state()).approvals;
	expect(asked).toEqual([{ id: asked[0]!.id, tool: "bash", command: "git push origin main", what: "git push" }]);
	expect((await post("/api/approve", { id: asked[0]!.id })).status).toBe(400);
	expect((await post("/api/approve", { id: asked[0]!.id, allow: true })).status).toBe(200);
	expect((await post("/api/approve", { id: asked[0]!.id, allow: true })).status).toBe(409);
	expect((await post("/api/approve", { id: "nope", allow: true })).status).toBe(409);
	await core.harness.waitForIdle(context);
	const after = await state();
	expect(after.approvals).toEqual([]);
	const users = after.entries.filter((entry) => entry.role === "user").map((entry) => entry.text);
	expect(users).toEqual(["push", "Yes. Run it: `git push origin main`"]);
	// With the yes, the agent's retry was let through to git.
	expect((after.entries.findLast((entry) => entry.role === "tool") as ToolEntry).text).not.toContain("waits for the person's yes");
}, 30_000);

test("a run stops at its turn limit and says so, and the limit survives a restart", async () => {
	const first = await open({ maxTurns: 3 });
	const step = first.call("bash", { command: "true" });
	first.faux.setResponses([step, step, step, step, step, fauxAssistantMessage("never reached")]);
	const settled = await (await first.core.root.submit({ type: "input", content: "loop" }, context)).wait(context);
	expect(settled).toMatchObject({ status: "unanswered", reason: "turn_limit" });
	expect((await first.entries()).filter((entry) => entry.role === "tool").length).toBe(3);
	const live = (await first.core.harness.snapshot((await import("@earendil-works/pi-durable")).LiveDoc, first.core.root.id, context))!;
	expect(live.runFailure).toMatchObject({ reason: "turn_limit", detail: "3 turns" });
	expect((await first.core.root.agent(context)).maxTurns).toBe(3);
	await first.core.close();
	// Reopened with no setting: the default bound applies, never "no limit".
	const second = await open({}, first);
	expect((await second.core.root.agent(context)).maxTurns).toBe(200);
	const bad = await open({ maxTurns: 0 });
	expect((await bad.core.root.agent(context)).maxTurns).toBe(200);
}, 30_000);

test("the guard's seatbelt is not a wall: what it does not catch is written down", () => {
	// These pass the rules. They are here so the limit is stated in a test, not discovered later.
	const judge = (command: string) => judgeCommand(command, join(homedir(), ".rho", "v2")).kind;
	for (const command of ['g=git; $g push', "bash deploy.sh", 'python3 -c "import shutil; shutil.rmtree(\'.git\')"', "find . -name .git -exec rm -rf {} +", "cat ~/.rho/v*/token"]) expect([command, judge(command)]).toEqual([command, "allow"]);
});
