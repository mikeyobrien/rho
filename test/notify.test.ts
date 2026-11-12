import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { context, openCore, type Core } from "../src/core.ts";
import { serve, type Server } from "../src/http.ts";
import { attention, findSender, openNotifier, type Note, type Sender } from "../src/notify.ts";
import { isProtected } from "../src/tools/protected.ts";
import type { StateView } from "../src/view.ts";

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
/** A sender that records what it was asked to send and take away. */
function recorder() {
	const sent: Note[] = [];
	const removed: string[] = [];
	const opened: string[] = [];
	const sender: Sender = { label: "test", send: async (note, open) => void (sent.push(note), opened.push(open)), remove: async (key) => void removed.push(key) };
	return { sent, removed, opened, sender };
}
const state = (over: Partial<StateView> = {}): StateView => ({ conversation: "c1", entries: [], more: false, running: false, partial: "", tools: [], queued: [], approvals: [], ...over });
const ask = (id: string, command = "git push origin v2") => ({ id, tool: "bash", command, what: "git push" });
const report = (id: number, text: string, from = "check-in") => ({ id, role: "notice" as const, text, from });

test("what is worth attention: a waiting request, a failure that was not a stop, a report; never an answer", () => {
	expect(attention(state())).toEqual({ approvals: [], notices: [] });
	expect(attention(state({ entries: [{ id: 1, role: "user", text: "hi" }, { id: 2, role: "assistant", text: "A finished answer.", calls: [] }] }))).toEqual({ approvals: [], notices: [] });
	expect(attention(state({ approvals: [ask("a1", "git push origin v2\n  --force")] })).approvals).toEqual([{ key: "approval:c1:a1", title: "rho needs your yes", text: "git push: git push origin v2 --force" }]);
	expect(attention(state({ approvals: [ask("a1", `echo ${"x".repeat(400)}`)] })).approvals[0]!.text.length).toBe("git push: ".length + 160);
	expect(attention(state({ failure: { reason: "model_error", text: "The model call failed.", detail: "529 overloaded" }, entries: [{ id: 7, role: "user", text: "go" }] })).failure).toEqual({ key: "failure:c1:model_error:7", title: "rho: the run failed", text: "The model call failed. 529 overloaded" });
	expect(attention(state({ failure: { reason: "aborted", text: "Stopped." } })).failure).toBeUndefined(); // the person stopped it themselves
	expect(attention(state({ entries: [report(4, "[check-in] The backup failed at 02:00."), report(5, "[release gate] Rho now runs abc1234.", "gate"), report(6, "plain", "other")] })).notices).toEqual([
		{ key: "notice:c1:4", title: "rho check-in", text: "The backup failed at 02:00." },
		{ key: "notice:c1:5", title: "rho release", text: "Rho now runs abc1234." },
		{ key: "notice:c1:6", title: "rho", text: "plain" },
	]);
	// A worker's question is for the agent: it never notifies the person.
	expect(attention(state({ entries: [report(8, "[a worker asks] Fix it: Which file?\nIt goes on with: hello.txt", "worker-ask")] })).notices).toEqual([]);
});

test("a request rings once while nobody looks, not while the page is open, and its notification goes when it is answered", async () => {
	const dir = scratch("rho-notify-");
	const { sent, removed, opened, sender } = recorder();
	const notifier = openNotifier({ dir, sender, open: "http://127.0.0.1:4780/" });
	const keys = async () => (await notifier.idle(), sent.map((note) => note.key));
	notifier.update("c1", state(), false);
	notifier.update("c1", state({ approvals: [ask("a1")] }), false);
	notifier.update("c1", state({ approvals: [ask("a1")], running: true }), false); // the same card, a later snapshot
	expect(await keys()).toEqual(["approval:c1:a1"]);
	expect(opened).toEqual(["http://127.0.0.1:4780/"]);
	// Answered: the notification is taken away, and nothing new rings.
	notifier.update("c1", state(), false);
	await notifier.idle();
	expect(removed).toEqual(["approval:c1:a1"]);
	// With the page open the card is on the screen: no notification.
	notifier.update("c1", state({ approvals: [ask("a2")] }), true);
	expect(await keys()).toEqual(["approval:c1:a1"]);
	// They close the page with the card still waiting: now it rings.
	notifier.update("c1", state({ approvals: [ask("a2")] }), false);
	expect(await keys()).toEqual(["approval:c1:a1", "approval:c1:a2"]);
	// Another conversation's cards are its own.
	notifier.update("c2", state({ conversation: "c2", approvals: [ask("a2")] }), false);
	expect(await keys()).toEqual(["approval:c1:a1", "approval:c1:a2", "approval:c2:a2"]);
	expect(removed).toEqual(["approval:c1:a1"]);
});

test("a restart does not ring again for a card that still waits, and rings for one nobody was told of", async () => {
	const dir = scratch("rho-notify-");
	const first = recorder();
	const before = openNotifier({ dir, sender: first.sender, open: "x" });
	before.update("c1", state({ approvals: [ask("a1")] }), false);
	await before.idle();
	expect(JSON.parse(readFileSync(join(dir, "notified.json"), "utf8"))).toEqual(["approval:c1:a1"]);
	// The next process: the same card is still waiting, and one more was asked while rho was down.
	const second = recorder();
	const after = openNotifier({ dir, sender: second.sender, open: "x" });
	after.update("c1", state({ approvals: [ask("a1"), ask("a3")] }), false);
	await after.idle();
	expect(second.sent.map((note) => note.key)).toEqual(["approval:c1:a3"]);
	// A file cut short by a kill is no memory, not a crash.
	writeFileSync(join(dir, "notified.json"), '["approval:c1');
	const third = recorder();
	const broken = openNotifier({ dir, sender: third.sender, open: "x" });
	broken.update("c1", state({ approvals: [ask("a1")] }), false);
	await broken.idle();
	expect(third.sent.length).toBe(1);
});

test("a failure and a report ring once, when new and unwatched; what was there at the start or seen in the page does not", async () => {
	const { sent, sender } = recorder();
	const notifier = openNotifier({ dir: scratch("rho-notify-"), sender, open: "x" });
	const keys = async () => (await notifier.idle(), sent.map((note) => note.key));
	// At the first look (rho just started) an old report and an old failure are history.
	notifier.update("c1", state({ entries: [report(3, "[check-in] Yesterday's report.")], failure: { reason: "model_error", text: "The model call failed." } }), false);
	expect(await keys()).toEqual([]);
	// A new report arrives while nobody looks.
	const entries = [report(3, "[check-in] Yesterday's report."), report(9, "[check-in] The disk is 96% full.")];
	notifier.update("c1", state({ entries }), false);
	notifier.update("c1", state({ entries }), false);
	expect(await keys()).toEqual(["notice:c1:9"]);
	expect(sent[0]).toMatchObject({ title: "rho check-in", text: "The disk is 96% full." });
	// One that arrives while the page is open was seen there: it does not ring later either.
	notifier.update("c1", state({ entries: [...entries, report(12, "[release gate] Rho now runs abc1234.", "gate")] }), true);
	notifier.update("c1", state({ entries: [...entries, report(12, "[release gate] Rho now runs abc1234.", "gate")] }), false);
	expect(await keys()).toEqual(["notice:c1:9"]);
	// A run fails unwatched: once. A run the person stopped: never.
	const failed = state({ entries: [{ id: 20, role: "user", text: "go" }], failure: { reason: "turn_limit", text: "The run reached its step limit." } });
	notifier.update("c1", failed, false);
	notifier.update("c1", failed, false);
	notifier.update("c1", state({ entries: [{ id: 30, role: "user", text: "go" }], failure: { reason: "aborted", text: "Stopped." } }), false);
	expect(await keys()).toEqual(["notice:c1:9", "failure:c1:turn_limit:20"]);
	// A sender that throws costs a log line, not the next notification.
	const logged: string[] = [];
	let fail = true;
	const flaky = openNotifier({ dir: scratch("rho-notify-"), sender: { label: "t", send: async (note) => void (fail ? (() => { throw new Error("no app"); })() : sent.push(note)) }, open: "x", log: (line) => logged.push(line) });
	flaky.update("c9", state({ conversation: "c9", approvals: [ask("a1")] }), false);
	await flaky.idle();
	expect(logged).toEqual(["notifications: no app"]);
	fail = false;
	flaky.update("c9", state({ conversation: "c9", approvals: [ask("a1"), ask("a2")] }), false);
	expect(await keys()).toContain("approval:c9:a2");
});

test("the Termux sender: found by its command, called with a stable id and a tap that opens rho, and never hangs", async () => {
	expect(findSender(() => null)).toBeUndefined();
	// A stand-in for the command that writes down its arguments, one per line.
	const bin = scratch("rho-notify-bin-");
	const fake = (name: string, body: string) => {
		writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
		chmodSync(join(bin, name), 0o755);
		return join(bin, name);
	};
	const post = fake("termux-notification", `printf '%s\\n' "$@" > ${JSON.stringify(join(bin, "posted"))}`);
	const remove = fake("termux-notification-remove", `printf '%s\\n' "$@" > ${JSON.stringify(join(bin, "removed"))}`);
	const which = (name: string) => (name === "termux-notification" ? post : name === "termux-notification-remove" ? remove : null);
	const sender = findSender(which)!;
	expect(sender.label).toBe("termux-notification");
	// Text that a shell would act on is one argument, as it is.
	await sender.send({ key: "approval:c1:tool:17/x", title: "rho needs your yes", text: 'git push: echo "$(whoami)"; rm -rf ~' }, "http://127.0.0.1:4780/");
	expect(readFileSync(join(bin, "posted"), "utf8").trimEnd().split("\n")).toEqual(["--id", "rho-approval-c1-tool-17-x", "--title", "rho needs your yes", "--content", 'git push: echo "$(whoami)"; rm -rf ~', "--priority", "high", "--action", "termux-open-url http://127.0.0.1:4780/"]);
	await sender.remove!("approval:c1:tool:17/x");
	expect(readFileSync(join(bin, "removed"), "utf8").trim()).toBe("rho-approval-c1-tool-17-x");
	// Without the remove command there is still a sender; it just cannot take one away.
	expect(findSender((name) => (name === "termux-notification" ? post : null))!.remove).toBeUndefined();
	// A command that is gone, or one that fails, is not a throw.
	await findSender(() => join(bin, "missing"))!.send({ key: "k", title: "t", text: "x" }, "u");
	await findSender(() => fake("failing", "exit 3"))!.send({ key: "k", title: "t", text: "x" }, "u");
});

test("in a real rho: a request rings with the page closed, and not while a client has the conversation open", async () => {
	let parent = "";
	for (let tries = 0; ; tries++) {
		parent = scratch("rho-notify-core-");
		for (const made of ["data", "work"]) mkdirSync(join(parent, made));
		if (!isProtected(join(parent, "work"))) break; // a stale inode from a deleted data directory: make another (see decider.test.ts)
		if (tries > 50) throw new Error("no scratch directory free of a stale inode");
	}
	const [dir, work] = [join(parent, "data"), join(parent, "work")];
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const core = await openCore({ dir, models, config: { model: `${faux.getModel().provider}/${faux.getModel().id}`, cwd: work } });
	cores.push(core);
	const { sent, removed, sender } = recorder();
	const notifier = openNotifier({ dir, sender, open: "http://127.0.0.1:1/" });
	const server = await serve({ core, models, dir, port: 0, notifier });
	servers.push(server);
	const token = readFileSync(join(dir, "token"), "utf8");
	const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
	const push = async (command: string) => {
		faux.setResponses([fauxAssistantMessage(fauxToolCall("bash", { command }), { stopReason: "toolUse" }), fauxAssistantMessage("It needs your yes."), fauxAssistantMessage("Understood.")]);
		await (await core.root.submit({ type: "input", content: "push" }, context)).wait(context);
		await core.harness.waitForIdle(context);
		await Bun.sleep(100); // the watch delivers the last snapshot
		await notifier.idle();
	};
	// Nobody has the page open: the request rings, once.
	await push("git push origin main");
	expect(sent).toMatchObject([{ title: "rho needs your yes", text: "git push: git push origin main" }]);
	// A client connects and answers no: the notification is taken away.
	const stream = await fetch(`http://127.0.0.1:${server.port}/api/events`, { headers });
	const reader = stream.body!.getReader();
	const first = JSON.parse(new TextDecoder().decode((await reader.read()).value).split("\n\n")[0]!.slice(6)) as StateView;
	expect((await fetch(`http://127.0.0.1:${server.port}/api/approve`, { method: "POST", headers, body: JSON.stringify({ id: first.approvals[0]!.id, allow: false }) })).status).toBe(200);
	await core.harness.waitForIdle(context);
	await Bun.sleep(100);
	await notifier.idle();
	expect(removed).toEqual([sent[0]!.key]);
	// With that client still connected, a new request is on its screen: nothing rings.
	await push("git push --force origin main");
	expect(sent.length).toBe(1);
	// The client goes away with the card still waiting: now it rings.
	await reader.cancel();
	await Bun.sleep(100);
	await notifier.idle();
	expect(sent.map((note) => note.text)).toEqual(["git push: git push origin main", "git push: git push --force origin main"]);
	// A gate's report with the page closed rings as a report; the answer to it does not.
	faux.setResponses([fauxAssistantMessage("Noted.")]);
	await core.notice(core.root, "[release gate] Rho now runs abc1234 (it ran def5678).", "notify-test-gate-1", "gate");
	await core.harness.waitForIdle(context);
	await Bun.sleep(100);
	await notifier.idle();
	expect(sent.at(-1)).toMatchObject({ title: "rho release", text: "Rho now runs abc1234 (it ran def5678)." });
	expect(sent.length).toBe(3);
	expect(existsSync(join(dir, "notified.json"))).toBe(true);
	expect(isProtected(join(dir, "notified.json"))).toBe(true); // rho's data: the agent cannot make itself quiet or loud
}, 40_000);
