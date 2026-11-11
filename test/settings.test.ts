import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { context, openCore, type Core } from "../src/core.ts";
import { serve, type Server } from "../src/http.ts";
import { answerApproval, Approvals } from "../src/tools/guard.ts";
import { isProtected } from "../src/tools/protected.ts";
import { changeText, SETTINGS } from "../src/tools/settings.ts";
import { entryView, type EntryView, type StateView } from "../src/view.ts";

// The real tool in a real core with a scripted model. No model is called.
type ToolEntry = Extract<EntryView, { role: "tool" }>;
const dirs: string[] = [];
const cores: Core[] = [];
const servers: Server[] = [];
afterEach(async () => {
	for (const server of servers.splice(0)) await server.stop().catch(() => undefined);
	for (const core of cores.splice(0)) await core.close().catch(() => undefined);
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function open(stored?: string, reuse?: string) {
	// A scratch directory that was handed a deleted data directory's inode is kept and another made (see decider.test.ts).
	let parent = reuse ?? "";
	for (let tries = 0; reuse === undefined; tries++) {
		parent = realpathSync(mkdtempSync(join(tmpdir(), "rho-settings-")));
		dirs.push(parent);
		for (const made of ["data", "work"]) mkdirSync(join(parent, made));
		if (!isProtected(join(parent, "work"))) break;
		if (tries > 50) throw new Error("no scratch directory free of a stale inode");
	}
	const [dir, work] = [join(parent, "data"), join(parent, "work")];
	const file = join(dir, "config.json");
	if (stored !== undefined) writeFileSync(file, stored, { mode: 0o644 });
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const model = `${faux.getModel().provider}/${faux.getModel().id}`;
	const core = await openCore({ dir, models, config: { model, cwd: work } });
	cores.push(core);
	const call = (args: object) => fauxAssistantMessage(fauxToolCall("settings", args as never), { stopReason: "toolUse" });
	const use = async (args: object, conversation = core.root): Promise<ToolEntry> => {
		faux.setResponses([call(args), fauxAssistantMessage("done")]);
		await (await conversation.submit({ type: "input", content: "go" }, context)).wait(context);
		return (await conversation.entries({ order: "descending" }, 20, undefined, context)).items.flatMap((entry) => entryView(entry) ?? []).find((entry): entry is ToolEntry => entry.role === "tool")!;
	};
	const waiting = async () => (await core.harness.snapshot(Approvals, core.root.id, context))?.pending ?? [];
	const config = () => (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>) : undefined);
	return { core, faux, models, model, dir, work, file, call, use, waiting, config, parent };
}

test("list names the settings that can be proposed, with their values, and shows nothing else of the file", async () => {
	const { use } = await open(JSON.stringify({ thinking: "high", memory: { kind: "honcho", apiKey: "sk-secret-123" }, providers: [{ id: "local", baseUrl: "http://10.0.0.5/v1" }] }));
	const listed = await use({ action: "list" });
	expect(listed.error).toBeUndefined();
	expect(listed.text).toContain('thinking: "high"');
	expect(listed.text).toContain("model: not set");
	for (const name of Object.keys(SETTINGS)) expect(listed.text).toContain(`${name}: `);
	expect(listed.text).not.toContain("sk-secret-123");
	expect(listed.text).not.toContain("10.0.0.5");
	expect(listed.text).toContain("are the person's to edit in config.json");
});

test("a change waits for the person: nothing is written, a yes writes that change once, and the rest of the file is kept", async () => {
	const before = { thinking: "medium", memory: { kind: "honcho", apiKey: "sk-secret-123" }, maxTurns: 50 };
	const { core, use, waiting, config, file } = await open(JSON.stringify(before));
	const held = await use({ action: "set", name: "thinking", value: "high" });
	expect(held.error).toBe(true);
	expect(held.text).toContain("waits for the person's yes");
	expect(held.text).not.toContain("sk-secret-123");
	expect(config()).toEqual(before); // nothing was written
	const change = 'set thinking to "high" (now "medium")';
	expect(await waiting()).toMatchObject([{ tool: "settings", command: change, what: 'changing rho\'s own setting "thinking"' }]);
	await use({ action: "set", name: "thinking", value: "high" }); // asked again while it waits: still one request
	expect((await waiting()).length).toBe(1);
	expect(config()).toEqual(before);

	const [ask] = await waiting();
	expect(await answerApproval(core.root, ask!.id, true, context)).toMatchObject({ tool: "settings", command: change });
	// A yes for one change is not a yes for another.
	expect((await use({ action: "set", name: "thinking", value: "max" })).text).toContain("waits for the person's yes");
	expect(config()).toEqual(before);
	const saved = await use({ action: "set", name: "thinking", value: "high" });
	expect(saved.error).toBeUndefined();
	expect(saved.text).toBe(`Saved: ${change}. It takes effect when rho next starts; the rho that is running now still has the old value.`);
	expect(config()).toEqual({ ...before, thinking: "high" }); // the key and the limit are as they were
	expect(statSync(file).mode & 0o777).toBe(0o600);
	expect(existsSync(`${file}.tmp`)).toBe(false);
	// It was a yes for once, and the value now is the new one.
	expect((await use({ action: "set", name: "thinking", value: "high" })).text).toBe('thinking is already "high". Nothing was changed.');
	expect((await use({ action: "set", name: "thinking", value: "medium" })).text).toContain('set thinking to "medium" (now "high")');
	expect(config()).toEqual({ ...before, thinking: "high" });
}, 30_000);

test("a no writes nothing and grants nothing; unset goes back to the default the same way", async () => {
	const { core, use, waiting, config } = await open(JSON.stringify({ checkins: false }));
	await use({ action: "unset", name: "checkins" });
	const [ask] = await waiting();
	expect(ask!.command).toBe("unset checkins (now false)");
	await answerApproval(core.root, ask!.id, false, context);
	expect(await waiting()).toEqual([]);
	expect((await use({ action: "unset", name: "checkins" })).text).toContain("waits for the person's yes"); // asked afresh
	expect(config()).toEqual({ checkins: false });
	await answerApproval(core.root, (await waiting())[0]!.id, true, context);
	expect((await use({ action: "unset", name: "checkins" })).text).toStartWith("Saved: unset checkins (now false).");
	expect(config()).toEqual({});
	expect((await use({ action: "unset", name: "checkins" })).text).toBe("checkins is already not set. Nothing was changed.");
}, 30_000);

test("a yes is for one change from one old value, and a yes for a shell command is never a yes for a setting", async () => {
	const { core, use, waiting, config, file } = await open(JSON.stringify({ thinking: "low" }));
	await use({ action: "set", name: "thinking", value: "high" });
	await answerApproval(core.root, (await waiting())[0]!.id, true, context);
	// The person edits the file by hand before the agent comes back: the yes was for "low" to "high".
	writeFileSync(file, JSON.stringify({ thinking: "off" }));
	const again = await use({ action: "set", name: "thinking", value: "high" });
	expect(again.text).toContain('set thinking to "high" (now "off")');
	expect(again.error).toBe(true);
	expect(config()).toEqual({ thinking: "off" });
	// A shell command allowed once, with the very text of the change, opens nothing here.
	const text = changeText("thinking", "high", "off");
	await core.root.commit(async (tx) => {
		const doc = await tx.doc(Approvals, core.root.id);
		doc.pending = [];
		doc.granted.push(text);
	}, context);
	expect((await use({ action: "set", name: "thinking", value: "high" })).error).toBe(true);
	expect(config()).toEqual({ thinking: "off" });
}, 30_000);

test("a waiting change and a given yes both survive a restart", async () => {
	const first = await open(JSON.stringify({ thinking: "low" }));
	await first.use({ action: "set", name: "thinking", value: "high" });
	await first.core.close();
	const second = await open(undefined, first.parent);
	const [ask] = await second.waiting();
	expect(ask).toMatchObject({ tool: "settings", command: 'set thinking to "high" (now "low")' });
	await answerApproval(second.core.root, ask!.id, true, context);
	await second.core.close();
	const third = await open(undefined, first.parent);
	expect((await third.use({ action: "set", name: "thinking", value: "high" })).text).toStartWith("Saved: ");
	expect(third.config()).toEqual({ thinking: "high" });
}, 30_000);

test("what is not on the list, or is not a value the setting takes, is refused in words and asks nobody", async () => {
	const { use, waiting, config, model, work, dir } = await open(JSON.stringify({ thinking: "low" }));
	const refused = async (args: object) => {
		const result = await use(args);
		expect([args, result.error]).toEqual([args, true]);
		return result.text;
	};
	for (const name of ["memory", "providers", "claudePlan", "maxTurns", "allowUsageCredits", "__proto__", "constructor", "token", ""]) expect(await refused({ action: "set", name, value: "true" })).toContain("You can propose: model, thinking, cwd, notifications, checkins, decider.");
	expect(await refused({ action: "set", name: "thinking", value: "loud" })).toContain("thinking is one of: off, minimal");
	expect(await refused({ action: "set", name: "thinking" })).toContain("value is required");
	expect(await refused({ action: "set", name: "thinking", value: "null" })).toContain("use unset");
	expect(await refused({ action: "set", name: "checkins", value: "yes" })).toContain("checkins is true or false.");
	expect(await refused({ action: "set", name: "notifications", value: "loud" })).toContain("notifications is true or false.");
	expect(await refused({ action: "set", name: "model", value: "nobody/nothing" })).toContain(`For example: ${model}`);
	expect(await refused({ action: "set", name: "cwd", value: "relative/path" })).toContain("cwd is an absolute directory");
	expect(await refused({ action: "set", name: "cwd", value: join(work, "missing") })).toContain("That directory does not exist.");
	expect(await refused({ action: "set", name: "cwd", value: dir })).toContain("cwd cannot be rho's own data directory.");
	expect(await refused({ action: "set", name: "decider", value: "http://127.0.0.1:8098" })).toContain('decider is an object with a "baseUrl".');
	expect(await refused({ action: "set", name: "decider", value: '{"baseUrl":"columba:8098"}' })).toContain('It needs "baseUrl"');
	expect(await refused({ action: "set", name: "decider", value: '{"baseUrl":"http://127.0.0.1:8098","mode":"enforce"}' })).toContain('The only decider modes are "shadow" and "off".');
	expect(await refused({ action: "set", name: "decider", value: '{"baseUrl":"http://127.0.0.1:8098","apiKey":"x"}' })).toContain("Not: apiKey.");
	expect(await refused({ action: "set", name: "thinking", value: "x".repeat(2001) })).toContain("too long");
	expect(await waiting()).toEqual([]);
	expect(config()).toEqual({ thinking: "low" });
	// Values that are taken: a model that can be used, a directory that exists, a decider as JSON.
	expect((await use({ action: "set", name: "model", value: model })).text).toContain(`set model to "${model}" (now not set)`);
	expect((await use({ action: "set", name: "cwd", value: work })).text).toContain(`set cwd to "${work}" (now not set)`);
	expect((await use({ action: "set", name: "decider", value: '{"baseUrl":"http://127.0.0.1:18098"}' })).text).toContain('set decider to {"baseUrl":"http://127.0.0.1:18098"} (now not set)');
	expect((await waiting()).map((pending) => pending.tool)).toEqual(["settings", "settings", "settings"]);
}, 60_000);

test("with no config file one is made; a file that is not JSON is left alone and said to be the person's to fix", async () => {
	const fresh = await open();
	await fresh.use({ action: "set", name: "checkins", value: "false" });
	expect(fresh.config()).toBeUndefined();
	await answerApproval(fresh.core.root, (await fresh.waiting())[0]!.id, true, context);
	expect((await fresh.use({ action: "set", name: "checkins", value: "false" })).error).toBeUndefined();
	expect(fresh.config()).toEqual({ checkins: false });

	const broken = await open('{"thinking": "low",');
	for (const args of [{ action: "list" }, { action: "set", name: "thinking", value: "high" }]) {
		const result = await broken.use(args);
		expect(result.error).toBe(true);
		expect(result.text).toContain("config.json is not valid JSON, so it was not changed");
	}
	expect(readFileSync(broken.file, "utf8")).toBe('{"thinking": "low",');
	expect(await broken.waiting()).toEqual([]);
}, 30_000);

test("where nobody is watching, a change is refused in words and no request is left", async () => {
	const { core, use, config } = await open(JSON.stringify({ thinking: "low" }));
	// A conversation that is not one of the person's own, as rho's side work (a check-in) is.
	const { model, thinkingLevel, instructions, cwd } = await core.root.agent(context);
	const side = await core.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { model: model!, thinkingLevel, instructions, cwd } }, context);
	const result = await use({ action: "set", name: "thinking", value: "high" }, side);
	expect(result.error).toBe(true);
	expect(result.text).toContain("needs the person's yes, and nobody is here to give it");
	expect((await core.harness.snapshot(Approvals, side.id, context))?.pending ?? []).toEqual([]);
	expect(config()).toEqual({ thinking: "low" });
}, 30_000);

test("over HTTP: the card shows the change, and Allow tells the agent to do it, not to run it", async () => {
	const { core, faux, models, dir, call, config } = await open(JSON.stringify({ thinking: "low" }));
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
	const args = { action: "set", name: "thinking", value: "high" };
	faux.setResponses([call(args), fauxAssistantMessage("It needs your yes."), call(args), fauxAssistantMessage("Saved.")]);
	await (await core.root.submit({ type: "input", content: "think harder from now on" }, context)).wait(context);
	const asked = (await state()).approvals;
	expect(asked).toEqual([{ id: asked[0]!.id, tool: "settings", command: 'set thinking to "high" (now "low")', what: 'changing rho\'s own setting "thinking"' }]);
	expect(config()).toEqual({ thinking: "low" });
	expect((await post("/api/approve", { id: asked[0]!.id, allow: true })).status).toBe(200);
	await core.harness.waitForIdle(context);
	const after = await state();
	expect(after.approvals).toEqual([]);
	expect(after.entries.filter((entry) => entry.role === "user").map((entry) => entry.text)).toEqual(["think harder from now on", 'Yes. Do it: `set thinking to "high" (now "low")`']);
	expect(config()).toEqual({ thinking: "high" });
}, 30_000);
