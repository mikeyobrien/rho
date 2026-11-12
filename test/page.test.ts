import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { context, openCore, type Core } from "../src/core.ts";
import { openModels } from "../src/providers.ts";
import { Approvals } from "../src/tools/guard.ts";
import { serve, type Server } from "../src/http.ts";
import { noticeCard } from "../src/view.ts";
import type { MemoryProvider } from "../src/memory/provider.ts";
import { start } from "../web/app.js";
import { El, fakeDocument, fakeHistory } from "./fixtures/dom.ts";

// The page's real script against a real daemon with a scripted model, on a stand-in DOM.
// It proves the page's logic. It does not prove layout or anything a real browser adds.
let dir: string;
let work: string; // where the agent's tools work; never rho's own data directory
let core: Core;
let server: Server;
let faux: ReturnType<typeof fauxProvider>;
let models: ReturnType<typeof createModels>;
let gate: { release(): void; started: Promise<void> };
let down = false; // when true, the page cannot reach the daemon
let memoryOption: MemoryProvider | null | undefined; // undefined: the configured memory, which is the files
const pages: { stop(): void }[] = [];

async function boot(port = 0) {
	core = await openCore({ dir, models, config: { model: `${faux.getModel().provider}/${faux.getModel().id}`, cwd: work }, extensions: [defineExtension({ name: "t", tools: [waitTool()] })], workerRetryMs: 40, ...(memoryOption === undefined ? {} : { memory: memoryOption }) });
	server = await serve({ core, models, dir, port, workerPollMs: 100, commit: "0123abc456def7890123abc456def7890123abc4" });
}
function waitTool() {
	let release!: () => void;
	let begun!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	gate = { release, started: new Promise<void>((resolve) => (begun = resolve)) };
	return defineTool({ name: "wait", description: "Wait.", parameters: obj({ why: str() }), execute: async (_args, api, context) => {
		api.output("waiting for the test\n");
		begun();
		await Promise.race([held, new Promise<void>((resolve) => context.abortSignal?.addEventListener("abort", () => resolve(), { once: true }))]);
		return { output: [{ type: "text", text: "waited" }] };
	} });
}
beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "rho-page-test-"));
	work = mkdtempSync(join(tmpdir(), "rho-page-work-"));
	faux = fauxProvider({ models: [{ id: "faux-1" }, { id: "faux-2" }] });
	models = createModels();
	models.setProvider(faux.provider);
	down = false;
	memoryOption = undefined;
	await boot();
});
afterEach(async () => {
	for (const page of pages.splice(0)) page.stop();
	gate.release();
	await server.stop().catch(() => undefined);
	await core.close().catch(() => undefined);
	rmSync(dir, { recursive: true, force: true });
	rmSync(work, { recursive: true, force: true });
});

interface Page { $(id: string): El; stored: Map<string, string>; location: { hash: string; pathname: string; search: string }; document: ReturnType<typeof fakeDocument>; history: ReturnType<typeof fakeHistory>["history"]; messages(): string[]; type(words: string): Promise<void>; send(words: string): Promise<void> }
async function open(options: { pair?: boolean; stored?: Map<string, string>; touch?: boolean; shrink?: (file: any) => Promise<any>; now?: () => number } = {}): Promise<Page> {
	const document = fakeDocument();
	const stored = options.stored ?? new Map<string, string>();
	const location = { hash: options.pair === false ? "" : `#pair=${server.pairCode()}`, pathname: "/", search: "" };
	const past = fakeHistory(location);
	const page = start({
		document,
		storage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => void stored.set(key, value) },
		location,
		...past,
		fetch: (path: string, init?: RequestInit) => (down ? Promise.reject(new TypeError("fetch failed")) : fetch(`http://127.0.0.1:${server.port}${path}`, init)),
		touch: options.touch ?? true,
		...(options.shrink ? { shrink: options.shrink } : {}),
		...(options.now ? { now: options.now } : {}),
	});
	pages.push(page);
	await page.ready;
	const $ = (id: string) => document.getElementById(id);
	const type = async (words: string) => { $("input").value = words; await $("input").fire("input"); };
	return { $, stored, location, document, history: past.history, type, messages: () => [...$("entries").children, ...$("live").children].filter((node): node is El => node instanceof El && !node.hidden).map((node) => `${node.className}|${node.textContent}`),
		send: async (words) => { await type(words); await $("composer").requestSubmit(); } };
}
async function until(what: string, check: () => unknown, ms = 8_000): Promise<void> {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
		await Bun.sleep(20);
	}
}
const idle = (page: Page) => page.$("status").textContent.includes("/");

// --- the details page ---------------------------------------------------------------------------
/** Every element below `node` with exactly this class. */
const inside = (node: El, name: string) => node.all().filter((child) => child.className === name);
/** The rows of the open level, each as "title | second line | value". */
const detailRows = (page: Page) => inside(page.$("details-body"), "row").map((row) => ["row-title", "row-sub", "row-value"].map((name) => inside(row, name)[0]?.textContent ?? "").join(" | "));
/** Until what the page asked the daemon for when it opened has been drawn. */
const loaded = (page: Page) => until("the details to load", () => page.$("details-body").attrs["aria-busy"] === "false");
/** Leave every level of the details page. */
async function leave(page: Page) {
	while (!page.$("details").hidden) {
		const depth = page.history.depth;
		await page.$("details-back").click();
		await until("one level back", () => page.history.depth < depth);
	}
}
/** Open the details page afresh and go into one of its sections. */
async function section(page: Page, title: string) {
	await leave(page);
	await page.$("menu-button").click();
	await inside(page.$("details-body"), "row").find((row) => inside(row, "row-title")[0]!.textContent === title)!.click();
}

test("a browser with no pairing code is refused and told what to run", async () => {
	const page = await open({ pair: false });
	await until("the unpaired notice", () => page.$("status").textContent === "Not paired");
	expect(page.$("notice").hidden).toBe(false);
	expect(page.$("notice-text").textContent).toContain("rho open");
	expect(page.messages()).toEqual([]);
});

test("a first run with no key: the page says how to add one, and the notice goes when a model can be used", async () => {
	await server.stop();
	await core.close();
	rmSync(dir, { recursive: true, force: true });
	// A new person's rho: pi-ai's providers, no key anywhere.
	const fresh = openModels({ dir, config: {}, env: { HOME: dir } });
	models = fresh.models;
	core = await openCore({ dir, models, config: { cwd: work }, extensions: [defineExtension({ name: "t", tools: [waitTool()] })] });
	server = await serve({ core, models, dir, port: 0 });
	const page = await open();
	await until("the setup notice", () => page.$("notice").hidden === false && page.$("notice-text").textContent.startsWith("Rho has no model"));
	expect(page.$("notice-text").textContent).toBe("Rho has no model to use yet. Add an API key with: rho key anthropic");
	// Asking anyway fails in words, not silently.
	await page.send("hello?");
	await until("the failure", () => page.messages().some((line) => line === "note failure|The model call failed. Provider is not configured: anthropic"));
	expect(page.$("notice").hidden).toBe(false); // and what to do about it is still on the page
	// The key arrives (as `rho key anthropic` stores it) and the notice goes with the next change.
	await fresh.keys.modify("anthropic", async () => ({ type: "api_key", key: "sk-test-0123456789" }));
	await Bun.sleep(1_100);
	await core.root.configure({ thinkingLevel: "low" }, context);
	await until("the notice to go", () => page.$("notice").hidden === true);
}, 30_000);

test("pairing works once, the code leaves the address, and the empty state shows", async () => {
	const page = await open();
	await until("the page to go live", () => idle(page));
	expect(page.location.hash).toBe("");
	expect(JSON.parse(page.stored.get("token")!)).toBe(readFileSync(join(dir, "token"), "utf8"));
	expect(page.$("empty").hidden).toBe(false);
	expect(page.$("send").disabled).toBe(true);
	expect(page.$("notice").hidden).toBe(true);
});

test("a question is answered and drawn once; the answer's Markdown is rendered", async () => {
	faux.setResponses([fauxAssistantMessage("The capital is **Tokyo**.")]);
	const page = await open();
	await until("live", () => idle(page));
	await page.type("What is the capital of Japan?");
	expect(JSON.parse(page.stored.get("draft")!)).toBe("What is the capital of Japan?"); // the draft survives a reload
	expect(page.$("send").textContent).toBe("Send");
	await page.$("composer").requestSubmit();
	expect(page.$("input").value).toBe("");
	await until("the answer", () => page.messages().some((line) => line.startsWith("msg assistant|") && line.includes("Tokyo")) && idle(page));
	expect(page.messages()).toEqual(["msg user|What is the capital of Japan?", "msg assistant|The capital is Tokyo."]);
	expect((page.$("entries").children[1] as El).all().map((node) => node.tag)).toEqual(["p", "strong"]);
	expect(JSON.parse(page.stored.get("outbox")!)).toEqual([]);
	expect(page.$("empty").hidden).toBe(true);
});

test("a tool round shows a card while it runs and a card with its result after", async () => {
	faux.setResponses([fauxAssistantMessage(fauxToolCall("wait", { why: "the reason given" }), { stopReason: "toolUse" }), fauxAssistantMessage("All done.")]);
	const page = await open();
	await until("live", () => idle(page));
	await page.send("please wait");
	await gate.started;
	await until("the running card", () => page.messages().some((line) => line.startsWith("tool|wait") && line.includes("waiting for the test")));
	expect(page.$("status").textContent).toBe("Working");
	expect(page.$("send").textContent).toBe("Stop");
	gate.release();
	await until("the final answer", () => page.messages().at(-1) === "msg assistant|All done." && idle(page));
	// The tool-only assistant turn is hidden; the card carries the call's arguments and its output.
	expect(page.messages()).toEqual(["msg user|please wait", "tool|waitthe reason givenwaitedwaited", "msg assistant|All done."]);
});

test("a tool card is two lines, what it is for and what it did, with the output and the diff inside", async () => {
	writeFileSync(join(work, "hello.txt"), "one\nhello wrold\nthree\n");
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("edit", { reasoning: "fix the greeting typo", path: "hello.txt", edits: [{ oldText: "wrold", newText: "world" }] }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("bash", { reasoning: "confirm the file reads right", command: "cat hello.txt" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("read", { path: "missing.txt" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Fixed."),
	]);
	const page = await open();
	await until("live", () => idle(page));
	await page.send("fix it");
	await until("the answer", () => page.messages().at(-1) === "msg assistant|Fixed." && idle(page));
	const cards = (page.$("entries").children as El[]).filter((node) => node.tag === "details");
	const part = (card: El, name: string) => card.all().find((node) => node.className === name)?.textContent;
	const lines = (card: El) => (card.children[0] as El).children.map((line) => (line as El).children.map((cell) => cell.textContent));
	// Line one: the tool and why. Line two: what it acted on and how it went.
	expect(lines(cards[0]!)).toEqual([["edit", "fix the greeting typo"], ["hello.txt", "+1 −1"]]);
	expect(lines(cards[1]!)).toEqual([["bash", "confirm the file reads right"], ["cat hello.txt", "3 lines"]]);
	expect(lines(cards[2]!)[0]).toEqual(["read", ""]); // no reason given: the line holds the name alone
	expect(cards[2]!.className).toBe("tool error");
	expect(part(cards[2]!, "tool-result")).toMatch(/missing\.txt|not found|ENOENT/i);
	// On demand: the cards start closed, and hold the diff and the output.
	expect(cards.map((card) => card.open)).toEqual([false, false, false]);
	const diff = cards[0]!.all().find((node) => node.className === "diff")!;
	const changed = (diff.children as El[]).filter((line) => line.className !== "same").map((line) => [line.className, line.textContent.trim().replace(/^([+-])\s*\d*\s*/, "$1")]);
	expect(changed).toEqual([["del", "-hello wrold"], ["add", "+hello world"]]);
	expect(part(cards[1]!, "output")).toBe("one\nhello world\nthree\n");
	expect(cards[1]!.all().some((node) => node.className === "diff")).toBe(false);
	expect(readFileSync(join(work, "hello.txt"), "utf8")).toBe("one\nhello world\nthree\n");
});

test("a command that cannot be undone shows a card with Allow and Deny, and Deny tells the agent no", async () => {
	faux.setResponses([fauxAssistantMessage(fauxToolCall("bash", { command: "git push origin main" }), { stopReason: "toolUse" }), fauxAssistantMessage("It needs your yes."), fauxAssistantMessage("Understood, not pushing.")]);
	const page = await open();
	await until("live", () => idle(page));
	await page.send("push it");
	await until("the card", () => page.messages().some((line) => line.startsWith("approval|")) && idle(page));
	const card = (page.$("live").children as El[]).find((node) => node.className === "approval")!;
	expect(card.textContent).toContain("Needs your yes: git push");
	expect(card.all().find((node) => node.tag === "pre")!.textContent).toBe("git push origin main");
	expect(card.all().filter((node) => node.tag === "button").map((node) => node.textContent)).toEqual(["Deny", "Allow"]);
	await card.all().find((node) => node.textContent === "Deny")!.fire("click");
	await until("the answer to no", () => page.messages().at(-1) === "msg assistant|Understood, not pushing." && idle(page));
	expect(page.messages().some((line) => line.startsWith("approval|"))).toBe(false);
	expect(page.messages()).toContain("msg user|No. Do not run: `git push origin main`");
});

test("while a run works: words queue and can be taken back; an empty box is Stop", async () => {
	faux.setResponses([fauxAssistantMessage(fauxToolCall("wait", { why: "hold" }), { stopReason: "toolUse" })]);
	const page = await open();
	await until("live", () => idle(page));
	await page.send("start");
	await gate.started;
	await until("Stop", () => page.$("send").textContent === "Stop");
	await page.type("Also mention foghorns.");
	expect(page.$("send").textContent).toBe("Send");
	expect(page.$("send").attrs["aria-label"]).toBe("Send to the work in hand");
	await page.$("composer").requestSubmit();
	const row = () => page.$("queue").children[0] as El | undefined;
	const button = (label: string) => row()!.all().find((node) => node.tag === "button" && node.textContent === label)!;
	// A message sent while rho works joins the work at its next step, and says so.
	await until("the queued row", () => row()?.textContent.includes("Steer · next step"));
	expect(page.$("status").textContent).toBe("Working · 1 waiting");
	// The person can make it wait for the answer instead.
	await button("Wait for the answer").fire("click");
	await until("the row to wait", () => row()?.textContent.includes("Queued · after the answer"));
	expect(page.$("queue").children.length).toBe(1);
	await button("Remove").fire("click");
	await until("the queue to empty", () => page.$("queue").children.length === 0);
	expect(page.$("input").value).toBe("Also mention foghorns."); // a removed message's words go back in the box
	await page.type("");
	await page.$("composer").requestSubmit(); // Stop
	await until("the stop", () => page.messages().includes("note|Stopped."));
});

test("with the daemon unreachable a message is kept, and it is sent once when the daemon is back", async () => {
	faux.setResponses([fauxAssistantMessage("Rome.")]);
	const page = await open();
	await until("live", () => idle(page));
	down = true;
	await page.document.fire("visibilitychange"); // as when the phone wakes the page: the old stream is dropped
	await until("the offline notice", () => page.$("status").textContent === "Can't reach rho");
	await page.send("And of Italy?");
	expect(page.messages()).toEqual(["msg user unsent|And of Italy?", "note unsent-note|Not sent yet"]);
	expect(page.$("notice-text").textContent).toContain("kept and sends when it is back");
	expect(JSON.parse(page.stored.get("outbox")!).length).toBe(1);
	down = false;
	await until("the kept message to be answered", () => page.messages().includes("msg assistant|Rome.") && idle(page), 15_000);
	expect(page.messages().filter((line) => line === "msg user|And of Italy?").length).toBe(1);
	expect(JSON.parse(page.stored.get("outbox")!)).toEqual([]);
	expect(page.$("notice").hidden).toBe(true);
}, 20_000);

test("a message kept across a daemon restart and a page reload is still sent once", async () => {
	faux.setResponses([fauxAssistantMessage("Kept and answered.")]);
	const first = await open();
	await until("live", () => idle(first));
	down = true;
	await first.document.fire("visibilitychange");
	await until("offline", () => first.$("status").textContent === "Can't reach rho");
	await first.send("survive this");
	pages.pop()!.stop(); // the browser tab is closed
	const port = server.port;
	await server.stop();
	await core.close(); // the daemon goes away and comes back on the same port
	await boot(port);
	down = false;
	const second = await open({ pair: false, stored: first.stored }); // the same browser, already paired
	await until("the answer", () => second.messages().includes("msg assistant|Kept and answered.") && idle(second), 15_000);
	expect(second.messages()).toEqual(["msg user|survive this", "msg assistant|Kept and answered."]);
}, 25_000);

test("the details page opens over the thread from ⋯ and from the title, and closes by its button, Escape and the back gesture", async () => {
	const page = await open();
	await until("live", () => idle(page));
	// The reader is part-way up the thread: that place is theirs, and the page must not move it.
	Object.assign(page.$("thread"), { scrollHeight: 1000, clientHeight: 300, scrollTop: 120 });
	await page.$("thread").fire("scroll");
	expect([page.$("details").hidden, page.$("menu-button").attrs["aria-expanded"]]).toEqual([true, "false"]);
	await page.$("menu-button").click();
	expect([page.$("details").hidden, page.$("menu-button").attrs["aria-expanded"], page.history.depth]).toEqual([false, "true", 1]);
	expect(El.focused).toBe(page.$("details-back"));
	const under = () => ["top", "thread", "bottom"].map((id) => page.$(id).inert);
	expect(under()).toEqual([true, true, true]); // what is under the page cannot be reached while it is open
	expect(page.$("details-notice").hidden).toBe(true);
	expect([page.$("details-title").textContent, page.$("details-back").attrs["aria-label"]]).toEqual(["Details", "Back to the conversation"]);
	await loaded(page);
	// The header block: the name, the status line, the commit this rho runs, where the conversation works.
	const head = (name: string) => inside(page.$("details-body"), name)[0]?.textContent;
	expect([head("details-name"), head("details-status"), head("details-line details-commit"), head("details-line details-cwd")]).toEqual(["rho", page.$("status").textContent, "Commit 0123abc", work]);
	expect(detailRows(page)).toEqual(["Workers | Jobs rho handed off | 0", "Artifacts | Photos, files changed, reports | 0", "Preferences and memory | What rho knows about you | 0", "Reminders | What rho checks on its own | 0", "Settings | Model, thinking, context | faux-1", "Conversations | Open another, or start one | 1"]);
	expect(inside(page.$("details-body"), "row").every((row) => row.tag === "button")).toBe(true);
	// Its own back button is one step of the browser's history.
	await page.$("details-back").click();
	await until("closed", () => page.$("details").hidden);
	expect([page.history.depth, El.focused === page.$("menu-button"), page.$("thread").scrollTop]).toEqual([0, true, 120]);
	expect(under()).toEqual([false, false, false]);
	// The title block opens it too; Escape closes it.
	await page.$("title").click();
	expect(page.$("details").hidden).toBe(false);
	await page.document.fire("keydown", { key: "Escape" });
	await until("closed by Escape", () => page.$("details").hidden);
	// A section is a second level: the back gesture leaves it first, then the page, and never the app.
	await section(page, "Settings");
	expect([page.$("details-title").textContent, page.$("details-back").attrs["aria-label"], page.history.depth]).toEqual(["Settings", "Back to details", 2]);
	expect(El.focused).toBe(page.$("details-back"));
	page.history.back();
	await until("the sections again", () => page.$("details-title").textContent === "Details");
	expect(page.$("details").hidden).toBe(false);
	page.history.back();
	await until("closed by back", () => page.$("details").hidden);
	expect([page.history.depth, page.$("thread").scrollTop]).toEqual([0, 120]);
	// A back with nothing open is the browser's own: the page does nothing with it.
	page.history.depth = 1;
	page.history.back();
	await Bun.sleep(20);
	expect(page.$("details").hidden).toBe(true);
});

test("settings on the details page list models and thinking levels and change them; clear context puts a divider", async () => {
	faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
	const page = await open();
	await until("live", () => idle(page));
	await section(page, "Settings");
	const field = (id: string) => page.$("details-body").find(id)!;
	await until("the model list", () => field("model").children.length === 2);
	expect((field("model").children as El[]).map((node) => [node.value, node.selected])).toEqual([["faux/faux-1", true], ["faux/faux-2", false]]);
	expect((field("thinking").children as El[]).map((node) => node.value)).toEqual(["low", "medium", "high", "xhigh", "max"]);
	expect((field("thinking").children as El[]).find((node) => node.selected)?.value).toBe("medium");
	expect(field("cwd").textContent).toBe(work);
	field("thinking").value = "high";
	await field("thinking").fire("change");
	await until("the new level", () => (field("thinking").children as El[]).find((node) => node.selected)?.value === "high");
	field("model").value = "faux/faux-2";
	await field("model").fire("change");
	await until("the new model", () => page.$("status").textContent === "faux/faux-2" && (field("model").children as El[]).find((node) => node.selected)?.value === "faux/faux-2");
	expect((await core.root.agent(context)).model).toMatchObject({ modelId: "faux-2" });
	// A reload draws the same from the daemon's state: which section was open is not kept.
	const again = await open({ pair: false, stored: page.stored });
	await until("the second page live", () => idle(again));
	expect(again.$("details").hidden).toBe(true);
	await section(again, "Settings");
	await until("its pickers", () => (again.$("details-body").find("model")!.children as El[]).find((node) => node.selected)?.value === "faux/faux-2");
	expect((again.$("details-body").find("thinking")!.children as El[]).find((node) => node.selected)?.value).toBe("high");
	await page.document.fire("keydown", { key: "Escape" });
	await page.document.fire("keydown", { key: "Escape" });
	await until("closed", () => page.$("details").hidden);
	await page.send("one");
	await until("first answer", () => page.messages().includes("msg assistant|first") && idle(page));
	await section(page, "Settings");
	await field("new-chat").click();
	await until("the page closed", () => page.$("details").hidden && page.history.depth === 0);
	await page.send("two");
	await until("second answer", () => page.messages().includes("msg assistant|second") && idle(page));
	expect(page.messages().map((line) => line.split("|")[0])).toEqual(["msg user", "msg assistant", "divider", "msg user", "msg assistant"]);
	expect(page.messages()[2]).toBe("divider|Context cleared");
});

test("conversations on the details page: the open one is marked, a new one opens empty, and a row opens its thread", async () => {
	faux.setResponses([fauxAssistantMessage("first answer")]);
	const page = await open();
	await until("live", () => idle(page));
	await page.send("About the build");
	await until("the answer", () => page.messages().includes("msg assistant|first answer") && idle(page));
	await section(page, "Conversations");
	await loaded(page);
	const list = () => inside(page.$("details-body"), "row").map((row) => `${row.attrs["aria-current"] ? "*" : " "}${inside(row, "row-title")[0]!.textContent} | ${inside(row, "row-sub")[0]?.textContent ?? ""}`);
	expect(list()).toEqual([`*About the build | ${work}`]);
	await page.$("details-body").find("new-conversation")!.click();
	await until("the empty thread, with the page closed", () => page.$("details").hidden && page.messages().length === 0 && idle(page) && !page.$("empty").hidden);
	expect(page.history.depth).toBe(0);
	await section(page, "Conversations");
	await loaded(page);
	expect(list()).toEqual([` About the build | ${work}`, `*New conversation | ${work}`]);
	await inside(page.$("details-body"), "row")[0]!.click();
	await until("the first thread", () => page.$("details").hidden && page.messages().includes("msg assistant|first answer") && idle(page));
});

test("on a keyboard Enter sends and Shift+Enter does not; on touch Enter is a new line", async () => {
	faux.setResponses([fauxAssistantMessage("ok")]);
	const desk = await open({ touch: false });
	await until("live", () => idle(desk));
	await desk.type("hello");
	await desk.$("input").fire("keydown", { key: "Enter", shiftKey: true });
	expect(desk.messages()).toEqual([]);
	await desk.$("input").fire("keydown", { key: "Enter", isComposing: true }); // an IME choosing a word
	expect(desk.messages()).toEqual([]);
	await desk.$("input").fire("keydown", { key: "Enter" });
	await until("sent", () => desk.messages().includes("msg assistant|ok"));
	const phone = await open({ pair: false, stored: desk.stored });
	await until("live", () => idle(phone));
	await phone.type("not sent by Enter");
	await phone.$("input").fire("keydown", { key: "Enter" });
	expect(phone.$("input").value).toBe("not sent by Enter");
});

test("the daemon serves the page's files without a token, with a strict policy, and nothing outside them", async () => {
	const base = `http://127.0.0.1:${server.port}`;
	const index = await fetch(`${base}/`);
	expect(index.status).toBe(200);
	expect(index.headers.get("content-type")).toContain("text/html");
	expect(index.headers.get("content-security-policy")).toContain("default-src 'self'");
	expect(index.headers.get("content-security-policy")).not.toContain("unsafe");
	expect(await index.text()).toContain('id="composer"');
	for (const file of ["/app.js", "/markdown.js", "/main.js", "/style.css"]) expect((await fetch(`${base}${file}`)).status).toBe(200);
	for (const path of ["/../src/http.ts", "/%2e%2e/package.json", "/..%2f..%2fpackage.json", "/token", "/nope.js", "/index.html.bak"]) expect((await fetch(`${base}${path}`)).status).toBe(404);
	expect((await fetch(`${base}/`, { method: "POST" })).status).toBe(404);
});

// A real 1x1 PNG, and a stand-in for the File a picker or the clipboard gives.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const file = (type = "image/png", data = PNG, size?: number) => ({ type, size: size ?? Buffer.from(data, "base64").length, arrayBuffer: async () => new Uint8Array(Buffer.from(data, "base64")).buffer });
const pick = async (page: Page, ...files: object[]) => { Object.assign(page.$("photo-input"), { files }); await page.$("photo-input").fire("change"); };
const imgs = (node: El) => node.all().filter((child) => child.tag === "img") as (El & { src?: string; alt?: string })[];

test("a photo is picked, shown before it is sent, and reaches the model; the thread shows it", async () => {
	let seen: any;
	faux.setResponses([(asked) => ((seen = asked.messages.at(-1)), fauxAssistantMessage("A white dot."))]);
	const page = await open();
	await until("live", () => idle(page));
	expect(page.$("send").disabled).toBe(true);
	// The button opens the device's picker.
	let opened = 0;
	page.$("photo-input").addEventListener("click", () => void opened++);
	await page.$("attach").fire("click");
	expect(opened).toBe(1);
	await pick(page, file());
	expect(page.$("photo-input").value).toBe(""); // so the same photo can be picked again
	expect(imgs(page.$("photos")).map((img) => [img.alt, img.src])).toEqual([["Photo 1", `data:image/png;base64,${PNG}`]]);
	expect(page.$("send").disabled).toBe(false); // a photo alone can be sent
	expect(page.$("send").textContent).toBe("Send");
	await page.send("What is this?");
	expect(page.$("photos").children).toEqual([]);
	await until("the answer", () => page.messages().includes("msg assistant|A white dot.") && idle(page));
	expect(seen.content).toEqual([{ type: "image", data: PNG, mimeType: "image/png" }, { type: "text", text: "What is this?" }]);
	expect(page.messages()[0]).toBe("msg user|What is this?");
	// The sent photo is fetched with the token and drawn in the message.
	const sent = imgs(page.$("entries").children[0] as El);
	await until("the photo in the thread", () => sent[0]?.src !== undefined);
	expect(sent.map((img) => [img.alt, img.src])).toEqual([["Photo 1", `data:image/png;base64,${PNG}`]]);
	// The browser's storage never held the picture.
	expect([...page.stored.values()].join("")).not.toContain(PNG);
});

test("artifacts on the details page: photos sent, files changed and reports, as the daemon lists them; a row jumps to its place in the thread", async () => {
	writeFileSync(join(work, "hello.txt"), "one\nhello wrold\nthree\n");
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("edit", { path: "hello.txt", edits: [{ oldText: "wrold", newText: "world" }] }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("write", { path: join(work, "notes/new.md"), content: "# Notes\n" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("edit", { path: join(work, "hello.txt"), edits: [{ oldText: "three", newText: "3" }] }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("edit", { path: "hello.txt", edits: [{ oldText: "not in the file", newText: "x" }] }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("read", { path: "hello.txt" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Changed."),
		fauxAssistantMessage("A white dot."),
		fauxAssistantMessage("Noted."),
	]);
	const page = await open();
	await until("live", () => idle(page));
	await page.$("menu-button").click();
	await loaded(page);
	expect(detailRows(page)[1]).toBe("Artifacts | Photos, files changed, reports | 0");
	await leave(page);
	await page.send("fix the file");
	await until("the answer", () => page.messages().at(-1) === "msg assistant|Changed." && idle(page));
	await pick(page, file());
	await page.send("What is this?");
	await until("the photo's answer", () => page.messages().at(-1) === "msg assistant|A white dot." && idle(page));
	// A report of side work, stored as the worker tool stores one.
	await core.root.submit({ type: "input", content: "Worker w9 reports.", requestId: "artifact-report-1", whenBusy: "followUp", entry: { kind: "rho.notice", data: { from: "worker", card: { kind: "report", title: "Publish the branch", verdict: "partial", who: "worker w9", body: "PARTIAL\nNot pushed." } } } }, context);
	await until("the report's answer", () => page.messages().at(-1) === "msg assistant|Noted." && idle(page));
	await page.$("menu-button").click();
	await until("the daemon's list", () => detailRows(page)[1] === "Artifacts | Photos, files changed, reports | 4"); // asked of the daemon when the page opens
	await section(page, "Artifacts");
	const body = page.$("details-body");
	expect(inside(body, "quiet-line")[0]!.textContent).toBe("This covers every message of the conversation.");
	expect(body.find("artifacts-earlier")).toBeUndefined();
	expect(inside(body, "section-label").map((node) => node.textContent)).toEqual(["Photos · 1", "Files changed · 2", "Reports · 1"]);
	// The photo is a thumbnail, fetched with the token; the page asked for it once, for the thread.
	const thumbs = inside(body, "thumb");
	expect(thumbs.map((thumb) => [thumb.tag, thumb.attrs["aria-label"]])).toEqual([["button", "Go to the message with photo 1"]]);
	await until("the thumbnail", () => imgs(thumbs[0]!)[0]?.src === `data:image/png;base64,${PNG}`);
	// Files: newest change first, one row a file however it was named, a failed edit not counted, a read not listed.
	const rowsNow = detailRows(page);
	expect(rowsNow[0]).toBe("hello.txt | 2 changes · last +1 −1 | ");
	expect(rowsNow[1]).toMatch(/^notes\/new\.md \| 1 change · last .+ \| $/);
	expect(rowsNow[2]).toBe("Publish the branch | partial · worker | "); // a card stored with an id shows none
	expect(inside(body, "row-line report-row partial").length).toBe(1);
	// A file's row closes the page and brings its last change into view: out of its fold, opened, and the thread no longer follows the end.
	await inside(body, "row")[0]!.click();
	await until("the page closed", () => page.$("details").hidden && page.history.depth === 0);
	const target = El.scrolled!;
	expect([target.className, target.open, target.classList.contains("jumped")]).toEqual(["tool", true, true]);
	expect(target.all().find((node) => node.className === "tool-target")!.textContent).toBe(join(work, "hello.txt"));
	const fold = (page.$("entries").children as El[]).find((node) => node.className === "fold")!;
	expect([fold.contains(target), fold.open, page.$("latest").hidden]).toEqual([true, true, false]);
	// A report's row goes to its card, and a photo's to its message.
	await section(page, "Artifacts");
	await inside(page.$("details-body"), "row")[2]!.click();
	await until("closed again", () => page.$("details").hidden);
	expect([El.scrolled!.className, El.scrolled!.open]).toEqual(["report partial", true]);
	await section(page, "Artifacts");
	await inside(page.$("details-body"), "thumb")[0]!.click();
	await until("closed a third time", () => page.$("details").hidden);
	expect(El.scrolled!.textContent).toBe("What is this?");
	expect(El.scrolled!.className).toBe("msg user");
});

test("artifacts cover the whole conversation without loading the thread, and a tap on an old one brings in the way there", async () => {
	// One long run before any page is open: thirty files written, more entries than a first snapshot holds.
	const names = Array.from({ length: 30 }, (_, n) => `file-${String(n).padStart(2, "0")}.txt`);
	faux.setResponses([...names.map((name) => fauxAssistantMessage(fauxToolCall("write", { path: name, content: "x\n" }), { stopReason: "toolUse" })), fauxAssistantMessage("All written.")]);
	await core.root.submit({ type: "input", content: "write thirty files", requestId: "artifact-many-1", whenBusy: "followUp" }, context);
	await until("the last file", () => existsSync(join(work, names.at(-1)!)), 20_000);
	await until("the run to end", () => faux.state.callCount === 31);
	await Bun.sleep(300); // the answer is stored: a page opened now is given a window, not the whole run
	const page = await open();
	await until("the answer", () => page.messages().at(-1) === "msg assistant|All written." && idle(page), 20_000);
	expect(page.$("earlier").hidden).toBe(false); // the thread itself holds only its newest part
	// What the thread holds is counted in tool results it knows of: a run of them folds into one row on screen.
	const held = () => (page.$("entries").children as El[]).flatMap((node) => [node, ...node.all()]).filter((node) => node.className === "tool" || node.className === "tool error").length;
	const loaded = held();
	expect(loaded).toBeLessThan(30);
	await page.$("menu-button").click();
	// The count on the main page is the whole conversation's, though the thread has loaded a part of it.
	await until("the count", () => detailRows(page)[1] === "Artifacts | Photos, files changed, reports | 30");
	await section(page, "Artifacts");
	const body = page.$("details-body");
	const files = () => detailRows(page).map((line) => line.split(" | ")[0]);
	expect(files()).toEqual([...names].reverse()); // all thirty, newest first
	expect(inside(body, "quiet-line")[0]!.textContent).toBe("This covers every message of the conversation.");
	expect(inside(body, "section-label")[1]!.textContent).toBe("Files changed · 30");
	expect(body.find("artifacts-earlier")).toBeUndefined(); // there is nothing to load
	expect(held()).toBe(loaded); // and listing them loaded nothing into the thread
	// The oldest file's card is further back than the thread holds: a tap brings in the way there and goes to it.
	El.scrolled = undefined;
	await inside(body, "row").at(-1)!.click();
	await until("the page to close on the oldest card", () => page.$("details").hidden === true && (El.scrolled as El | undefined)?.className.startsWith("tool") === true);
	expect(El.scrolled!.textContent).toContain("file-00.txt");
	expect(El.scrolled!.open).toBe(true);
	expect(held()).toBe(30); // the whole way back to it was brought in
	expect(page.$("earlier").hidden).toBe(false); // the person's message and the first call are still further back
}, 40_000);

test("photos: one can be removed, pasted ones are added, and what cannot be sent is said at once", async () => {
	let seen: any;
	faux.setResponses([(asked) => ((seen = asked.messages.at(-1)), fauxAssistantMessage("Two dots."))]);
	const page = await open();
	await until("live", () => idle(page));
	await pick(page, file("application/pdf"));
	expect(page.$("status").textContent).toBe("That is not a JPEG, PNG, GIF or WebP picture.");
	await pick(page, file("image/jpeg", PNG, 11 * 1024 * 1024));
	expect(page.$("status").textContent).toBe("That photo is too large: the most is 10 MB.");
	expect(page.$("photos").children).toEqual([]);
	expect(page.$("send").disabled).toBe(true);
	await pick(page, file(), file(), file(), file(), file());
	expect(imgs(page.$("photos")).length).toBe(4);
	expect(page.$("status").textContent).toBe("A message takes up to 4 photos.");
	// Remove takes one away.
	const remove = (page.$("photos").children[0] as El).all().find((node) => node.tag === "button")!;
	expect(remove.attrs["aria-label"]).toBe("Remove photo 1");
	for (let i = 0; i < 3; i++) await (page.$("photos").children[0] as El).all().find((node) => node.tag === "button")!.fire("click");
	expect(imgs(page.$("photos")).length).toBe(1);
	// A pasted screenshot is added; pasted words are left to the browser.
	let prevented = 0;
	await page.$("input").fire("paste", { clipboardData: { files: [] }, preventDefault: () => void prevented++ });
	expect(prevented).toBe(0);
	await page.$("input").fire("paste", { clipboardData: { files: [file()] }, preventDefault: () => void prevented++ });
	expect(prevented).toBe(1);
	expect(imgs(page.$("photos")).length).toBe(2);
	// Sent with no words at all.
	await page.$("composer").requestSubmit();
	await until("the answer", () => page.messages().includes("msg assistant|Two dots.")); // the status line still holds the notice
	expect(seen.content.map((part: { type: string }) => part.type)).toEqual(["image", "image"]);
	expect(imgs(page.$("entries").children[0] as El).length).toBe(2);
});

test("a photo the daemon refuses comes back to the composer with its words", async () => {
	const page = await open();
	await until("live", () => idle(page));
	// The page believes the picker; the daemon reads the bytes.
	await pick(page, file("image/png", Buffer.from("not a picture").toString("base64")));
	await page.send("look at this");
	await until("the refusal", () => page.$("status").textContent === "That photo is not a JPEG, PNG, GIF or WebP picture.");
	expect(page.$("input").value).toBe("look at this");
	expect(imgs(page.$("photos")).length).toBe(1);
	expect(page.messages()).toEqual([]);
	expect(JSON.parse(page.stored.get("outbox")!)).toEqual([]);
});

test("with the daemon unreachable a photo is kept in the page and sent once; a reload loses the photo and says so", async () => {
	faux.setResponses([fauxAssistantMessage("A dot.")]);
	const page = await open();
	await until("live", () => idle(page));
	down = true;
	await page.document.fire("visibilitychange");
	await until("the offline notice", () => page.$("status").textContent === "Can't reach rho");
	await pick(page, file());
	await page.send("And this?");
	expect(page.messages()).toEqual(["msg user unsent|And this?", "note unsent-note|Not sent yet"]);
	expect(imgs(page.$("live")).map((img) => img.src)).toEqual([`data:image/png;base64,${PNG}`]);
	// Stored without the picture, with a count of what it had.
	expect(JSON.parse(page.stored.get("outbox")!)).toMatchObject([{ text: "And this?", photos: 1 }]);
	expect(page.stored.get("outbox")).not.toContain(PNG);
	const kept = new Map(page.stored);
	down = false;
	await until("the kept message to be answered", () => page.messages().includes("msg assistant|A dot.") && idle(page), 15_000);
	expect(page.messages().filter((line) => line === "msg user|And this?").length).toBe(1);
	expect(imgs(page.$("entries").children[0] as El).length).toBe(1);
	// The same storage in a page opened afresh, as after a reload before it was sent: the photo
	// is gone, so the message is not sent short. Its words go back in the box.
	kept.delete("token");
	const reloaded = await open({ stored: kept });
	await until("the thread", () => reloaded.messages().includes("msg assistant|A dot.")); // the status line holds the notice below
	expect(reloaded.$("input").value).toBe("And this?");
	expect(JSON.parse(reloaded.stored.get("outbox")!)).toEqual([]);
	expect(reloaded.$("status").textContent).toBe("A message with photos was not sent before the page closed. Add the photos again.");
	await Bun.sleep(200);
	expect(reloaded.messages().filter((line) => line.includes("And this?")).length).toBe(1); // still the one that was sent
}, 25_000);

test("a waiting message with a photo says so, and can be removed but not moved", async () => {
	faux.setResponses([fauxAssistantMessage(fauxToolCall("wait", { why: "test" }), { stopReason: "toolUse" }), fauxAssistantMessage("Done."), fauxAssistantMessage("Next.")]);
	const page = await open();
	await until("live", () => idle(page));
	await page.send("wait please");
	await gate.started;
	await pick(page, file());
	await page.type("and look");
	await page.$("input").fire("keydown", { key: "Enter", altKey: true }); // touch: no send; set the mode by hand below
	await page.$("composer").requestSubmit();
	await until("the waiting message", () => page.$("queue").children.length === 1);
	const row = page.$("queue").children[0] as El;
	expect(row.all().find((node) => node.className === "queued-text")!.textContent).toBe("1 photo · and look");
	expect(row.all().filter((node) => node.tag === "button").map((node) => node.textContent)).toEqual(["Remove"]);
	await row.all().find((node) => node.tag === "button")!.fire("click");
	await until("the queue to empty", () => page.$("queue").children.length === 0);
	expect(page.$("input").value).toBe("and look");
	expect(page.$("status").textContent).toBe("Removed. Its 1 photo would need adding again.");
	gate.release();
	await until("the answer", () => page.messages().includes("msg assistant|Done."));
});

test("a photo is made smaller in the browser before it is sent; if that fails it goes as it is", async () => {
	const SMALL = Buffer.from(PNG, "base64").toString("base64");
	let fail = false;
	const asked: number[] = [];
	// Stands in for the browser's canvas: a 12 MB camera photo comes back as a small picture.
	const page = await open({ shrink: async (given) => (asked.push(given.size), fail ? Promise.reject(new Error("no canvas")) : file("image/jpeg", SMALL)) });
	await until("live", () => idle(page));
	await pick(page, file("image/jpeg", PNG, 12 * 1024 * 1024)); // over the limit as taken, under it once smaller
	expect(asked).toEqual([12 * 1024 * 1024]);
	expect(imgs(page.$("photos")).map((img) => img.src)).toEqual([`data:image/jpeg;base64,${SMALL}`]);
	fail = true;
	await pick(page, file("image/png"));
	expect(imgs(page.$("photos")).map((img) => img.src)).toEqual([`data:image/jpeg;base64,${SMALL}`, `data:image/png;base64,${PNG}`]);
	await pick(page, file("image/jpeg", PNG, 12 * 1024 * 1024)); // cannot be made smaller, so the limit holds
	expect(page.$("status").textContent).toBe("That photo is too large: the most is 10 MB.");
	expect(imgs(page.$("photos")).length).toBe(2);
	expect(page.$("send").disabled).toBe(false);
});

test("a release shows in the page as it goes: its stage and time, the restart as a restart, and how it ended", async () => {
	// This server looks at the release record often, so the test does not wait on a 2 s poll.
	await server.stop();
	server = await serve({ core, models, dir, port: 0, releasePollMs: 40 });
	let now = 0;
	const page = await open({ now: () => now });
	await until("live", () => idle(page));
	expect(runningRows(page)).toEqual([]);
	// What the gate, another process, writes as it works. Its pid here is this test's, which lives.
	const [commit, previous] = ["a".repeat(40), "b".repeat(40)];
	const stage = (name: string, at: number) => writeFileSync(join(dir, "release.json"), JSON.stringify({ status: "running", stage: name, commit, previous, pid: process.pid, started: 1_000, at }));
	// The release is a row of the Running card at the tail of the thread, not a strip of its own.
	const line = () => runningRows(page).find((text) => text.startsWith("Release | "))?.slice("Release | ".length) ?? "";
	now = 42_000;
	stage("check", 2_000);
	await until("the release row", () => line() !== "");
	expect(line()).toBe("aaaaaaa · running the checks · 0:41");
	expect((page.$("live").children as El[]).at(-1)!.className).toBe("running"); // the card is the last thing in the thread
	expect(page.$("release").hidden).toBe(true); // nothing outside the thread
	// The time counts on its own between the daemon's snapshots.
	now = 65_000;
	await until("the clock to move", () => line() === "aaaaaaa · running the checks · 1:04", 15_000);
	stage("wait for idle", 66_000);
	await until("the next stage", () => line().includes("waiting for rho to finish its answer"));
	stage("restart", 70_000);
	await until("the restart stage", () => line().includes("restarting rho"));
	// Rho goes away for the restart: that is said as a restart, not as a fault.
	down = true;
	await page.document.fire("visibilitychange");
	await until("the page to lose rho", () => page.$("status").textContent === "Restarting");
	expect(page.$("status").classList.contains("warn")).toBe(false);
	expect(page.$("notice").hidden).toBe(true);
	now = 75_000;
	await until("the line to count through the restart", () => line() === "aaaaaaa · restarting rho · 1:14", 15_000);
	// It comes back on the new commit: the release is over, so its row goes at once and with it the card.
	// How it ended is the gate's message in the thread, not a row that sits under "Running".
	writeFileSync(join(dir, "release.json"), JSON.stringify({ status: "released", commit, previous, at: Date.now() }));
	down = false;
	await until("the row to go", () => idle(page) && runningCard(page) === undefined, 15_000);
	// One that failed, and one that went back, leave no row either.
	for (const ended of [{ status: "failed", reason: "Its checks failed (exit 1):\nlots" }, { status: "rolled-back" }]) {
		stage("check", Date.now());
		await until("a release under way again", () => line() !== "");
		writeFileSync(join(dir, "release.json"), JSON.stringify({ ...ended, commit, previous, at: Date.now() }));
		await until(`no row after ${ended.status}`, () => runningCard(page) === undefined);
	}
}, 40_000);

test("when rho is unreachable with no release under way, it is still said as a fault", async () => {
	const page = await open();
	await until("live", () => idle(page));
	down = true;
	await page.document.fire("visibilitychange");
	await until("the offline notice", () => page.$("status").textContent === "Can't reach rho");
	expect(page.$("status").classList.contains("warn")).toBe(true);
	expect(page.$("notice").hidden).toBe(false);
	expect(page.$("release").hidden).toBe(true);
});

test("an approval card lists what the command would do, when rho worked that out", async () => {
	const page = await open();
	await until("live", () => idle(page));
	const card = () => (page.$("live").children as El[]).find((node) => node.className === "approval");
	const lines = () => card()!.all().filter((node) => node.tag === "li").map((node) => node.textContent);
	// As the guard leaves them: one with lines, one without.
	await core.root.commit(async (tx) => {
		(await tx.doc(Approvals, core.root.id)).pending.push({ id: "ask-1", tool: "bash", command: "bin/rho release", what: "putting new code into the running rho", at: 1, details: ["Rho will run aaaaaaa (now bbbbbbb).", "It brings in 1 commit:", "aaaaaaa <b>A title</b>"] });
	}, context);
	await page.send("anything"); // a turn, so the page takes a fresh snapshot
	await until("the card", () => card() !== undefined && lines().length === 3);
	expect(lines()).toEqual(["Rho will run aaaaaaa (now bbbbbbb).", "It brings in 1 commit:", "aaaaaaa <b>A title</b>"]); // a title is text, never markup
	expect(card()!.all().map((node) => node.tag)).toEqual(["p", "pre", "ul", "li", "li", "li", "div", "button", "button"]);
	await core.root.commit(async (tx) => {
		(await tx.doc(Approvals, core.root.id)).pending = [{ id: "ask-2", tool: "bash", command: "git push", what: "git push", at: 2 }];
	}, context);
	await page.send("again");
	await until("the plain card", () => card()?.all().find((node) => node.tag === "pre")?.textContent === "git push");
	expect(card()!.all().map((node) => node.tag)).toEqual(["p", "pre", "div", "button", "button"]);
}, 30_000);

test("a run of finished steps folds into one row, edits too; a failure and a step outside the folder stay out", async () => {
	for (const name of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(work, name), `${name}\nline\n`);
	// A real file outside the conversation's folder (and outside rho's data), read by its full path.
	const outside = join(mkdtempSync(join(tmpdir(), "rho-page-outside-")), "note.txt");
	writeFileSync(outside, "elsewhere\n");
	const step = (name: string, args: object) => fauxAssistantMessage(fauxToolCall(name, args as never), { stopReason: "toolUse" });
	faux.setResponses([
		step("read", { path: "a.txt" }),
		step("read", { path: "b.txt" }),
		step("edit", { path: "c.txt", edits: [{ oldText: "line", newText: "LINE\nmore" }] }),
		step("bash", { command: "cat c.txt" }),
		step("read", { path: "missing.txt" }), // fails: stays out, and ends the run of steps
		step("read", { path: "a.txt" }),
		step("read", { path: outside }), // it works, and it is outside the folder: stays out
		step("ls", { path: "." }),
		fauxAssistantMessage("All done."),
	]);
	const page = await open();
	await until("live", () => idle(page));
	await page.send("do the work");
	await until("the answer", () => page.messages().at(-1) === "msg assistant|All done." && idle(page), 20_000);
	const shown = (page.$("entries").children as El[]).filter((node) => !node.hidden);
	const row = (node: El) => (node.children[0] as El).children.map((cell) => (cell as El).textContent);
	// The four steps that went well, in a row, are one row that says what they did.
	expect(shown.map((node) => node.className)).toEqual(["msg user", "fold", "tool error", "tool", "tool", "tool", "msg assistant"]);
	const fold = shown[1]!;
	expect(row(fold)[0]).toMatch(/^4 steps( · \d+ s)?$/);
	expect(row(fold)[1]).toBe("read 2 · edited 1 (+2 −1) · ran 1");
	expect(fold.open).toBe(false);
	// Inside it, each step's own card, with its diff and output.
	const inside = (fold.children[1] as El).children as El[];
	expect(inside.map((card) => card.all().find((node) => node.className === "tool-name")!.textContent)).toEqual(["read", "read", "edit", "bash"]);
	expect(inside[2]!.all().some((node) => node.className === "diff")).toBe(true);
	// The failure is its own card. After it, two steps are too few to fold, and one of them left the folder.
	expect(shown[2]!.all().find((node) => node.className === "tool-target")!.textContent).toBe("missing.txt");
	expect(shown.slice(3, 6).map((node) => node.all().find((cell) => cell.className === "tool-target")!.textContent)).toEqual(["a.txt", outside.slice(0, 80), "."]);
	rmSync(join(outside, ".."), { recursive: true, force: true });
	// A fold the person opened stays open when the thread is drawn again.
	fold.open = true;
	faux.setResponses([fauxAssistantMessage("Yes.")]);
	await page.send("still there?");
	await until("the next answer", () => page.messages().at(-1) === "msg assistant|Yes." && idle(page));
	const again = (page.$("entries").children as El[]).filter((node) => !node.hidden);
	expect(again[1]).toBe(fold);
	expect(again[1]!.open).toBe(true);
}, 40_000);

test("steps of work in hand stay as cards and fold when it answers; a path that climbs out of the folder never folds", async () => {
	for (const name of ["a.txt", "b.txt", "c.txt"]) writeFileSync(join(work, name), "x\n");
	const step = (name: string, args: object) => fauxAssistantMessage(fauxToolCall(name, args as never), { stopReason: "toolUse" });
	faux.setResponses([step("read", { path: "a.txt" }), step("read", { path: "b.txt" }), step("read", { path: "c.txt" }), step("wait", { why: "hold the run open" }), fauxAssistantMessage("Done.")]);
	const page = await open();
	await until("live", () => idle(page));
	await page.send("read them");
	await gate.started;
	const classes = () => (page.$("entries").children as El[]).filter((node) => !node.hidden).map((node) => node.className);
	await until("three finished cards", () => classes().filter((name) => name === "tool").length === 3);
	expect(classes()).toEqual(["msg user", "tool", "tool", "tool"]); // still working: what it just did is in view
	gate.release();
	await until("the answer", () => page.messages().at(-1) === "msg assistant|Done." && idle(page));
	expect(classes()).toEqual(["msg user", "fold", "msg assistant"]);
	expect(((page.$("entries").children as El[]).find((node) => node.className === "fold")!.children[0] as El).children.map((cell) => (cell as El).textContent)[1]).toBe("read 3 · used tools 1");
	// Paths that leave the folder by `..` or `~`, three in a row, are each their own card.
	faux.setResponses([step("read", { path: "../x" }), step("read", { path: "sub/../../y" }), step("ls", { path: "~" }), fauxAssistantMessage("Looked.")]);
	await page.send("look outside");
	await until("the second answer", () => page.messages().at(-1) === "msg assistant|Looked." && idle(page));
	// Whether each read worked is the machine's business; what matters is that none was folded away.
	const after = classes().slice(3);
	expect(after.length).toBe(5);
	expect([after[0], after[4]]).toEqual(["msg user", "msg assistant"]);
	expect(after.slice(1, 4).every((name) => name === "tool" || name === "tool error")).toBe(true);
}, 40_000);

test("a running step shows how long it has run and its newest line", async () => {
	let now = 1_000_000;
	faux.setResponses([fauxAssistantMessage(fauxToolCall("wait", { why: "a long job" }), { stopReason: "toolUse" }), fauxAssistantMessage("Finished.")]);
	const page = await open({ now: () => now });
	await until("live", () => idle(page));
	await page.send("start it");
	await gate.started;
	const result = () => (page.$("live").children as El[]).find((node) => node.className === "tool")?.all().find((cell) => cell.className === "tool-result")?.textContent;
	await until("the running card", () => result()?.startsWith("running · 0:00") === true);
	expect(result()).toBe("running · 0:00 · waiting for the test");
	// The time counts on its own while the daemon sends nothing new.
	now += 32_000;
	await until("the clock to move", () => result() === "running · 0:32 · waiting for the test", 15_000); // a one-second timer, on a phone that the suite itself loads
	gate.release();
	await until("the answer", () => page.messages().at(-1) === "msg assistant|Finished." && idle(page));
	expect(result()).toBeUndefined();
}, 30_000);

// One scripted model for the agent and its worker: a worker is known by its brief, as in test/delegate.test.ts.
function scriptWorker(worker: (seen: { results: number; lastRole: string }) => ReturnType<typeof fauxAssistantMessage>, main: ReturnType<typeof fauxAssistantMessage>[]) {
	faux.setResponses(Array.from({ length: 60 }, () => (asked: { messages: { role: string; content: unknown }[] }) => {
		const first = asked.messages.find((message) => message.role === "user")?.content;
		const text = typeof first === "string" ? first : ((first ?? []) as { text?: string }[]).map((part) => part.text ?? "").join("");
		if (!text.startsWith("You are a worker.")) return main.shift() ?? fauxAssistantMessage("(nothing scripted)");
		return worker({ results: asked.messages.filter((message) => message.role === "toolResult").length, lastRole: asked.messages.at(-1)!.role });
	}));
}
const BRIEF = "The person asked for the branch to be published. Wait for the build, then push main to origin, and report what was pushed and how you checked it.";
const PUSH = "git push --dry-run origin main"; // held by the guard like any push, and changes nothing if it runs

// --- what runs beside the conversation is shown in the thread ---------------------------------------
/** The Running card at the tail of the thread, or undefined when nothing runs. */
const runningCard = (page: Page) => (page.$("live").children as El[]).find((node) => node.className === "running");
const runningRowEls = (page: Page) => (runningCard(page)?.all() ?? []).filter((node) => node.tag === "li");
const part = (node: El, name: string) => node.all().find((child) => child.className === name);
/** Its rows, each as "title | state". */
const runningRows = (page: Page) => runningRowEls(page).map((row) => `${part(row, "running-title")!.textContent} | ${part(row, "running-state")!.textContent}`);
/** The report cards in the thread, oldest first. */
const reports = (page: Page) => (page.$("entries").children as El[]).filter((node) => node.className.startsWith("report "));
const reportWords = (card: El) => ["report-verdict", "report-title", "report-summary", "report-who"].map((name) => part(card, name)!.textContent);
/** The thread's lines without the Running card, which is always last. */
const thread = (page: Page) => page.messages().filter((line) => !line.startsWith("running|"));

test("a worker is a row of the Running card at the tail of the thread; its request for a yes is a card; its report is a card", async () => {
	scriptWorker(({ results, lastRole }) => {
		if (results === 0) return fauxAssistantMessage(fauxToolCall("wait", { why: "the build" }), { stopReason: "toolUse" });
		if (results === 1 || (results === 2 && lastRole === "user")) return fauxAssistantMessage(fauxToolCall("bash", { command: PUSH }), { stopReason: "toolUse" });
		if (results === 2) return fauxAssistantMessage("The push waits for the person's yes.");
		return fauxAssistantMessage("DONE\nI ran the push as a dry run after the person allowed it.\n\nChecked: the command exited 0.");
	}, [fauxAssistantMessage(fauxToolCall("delegate", { action: "start", title: "Publish the branch", brief: BRIEF }), { stopReason: "toolUse" }), fauxAssistantMessage("Handed off."), fauxAssistantMessage("The worker is done.")]);
	const page = await open();
	await until("live", () => idle(page));
	expect(runningCard(page)).toBeUndefined();
	await page.send("publish it");
	await gate.started;
	// The row: the job, how it stands, how long, where, on which model, and the step it is on.
	await until("the worker's row with its step", () => /^Publish the branch \| working · 0:\d\d · local · .+ · wait$/.test(runningRows(page)[0] ?? ""), 15_000);
	expect((page.$("live").children as El[]).at(-1)!.className).toBe("running"); // after everything else in the thread
	expect(page.$("workers").hidden).toBe(true); // nothing above the message box
	await until("the main thread idle", () => idle(page));
	expect(page.$("status").textContent).toEndWith(" · 1 running");
	expect(thread(page).at(-1)).toBe("msg assistant|Handed off."); // none of the worker's steps are in this thread
	// Its push needs a yes: the card is here, under the worker's name, above the Running card.
	gate.release();
	const card = () => (page.$("live").children as El[]).find((node) => node.className === "approval");
	await until("the worker's card", () => card() !== undefined, 15_000);
	expect(card()!.textContent).toContain("Publish the branch · a worker");
	expect(card()!.textContent).not.toContain("w1");
	expect(card()!.textContent).toContain("Needs your yes: git push");
	expect(card()!.all().find((node) => node.tag === "pre")!.textContent).toBe(PUSH);
	await until("the row to say it asks", () => (runningRows(page)[0] ?? "").includes("needs your yes"));
	expect(runningRowEls(page)[0]!.className).toContain("asking");
	const order = (page.$("live").children as El[]).map((node) => node.className);
	expect(order.indexOf("approval")).toBeLessThan(order.indexOf("running"));
	expect((await core.workers.list())[0]).toMatchObject({ status: "asking" });
	// Allow: the worker is told, runs it, and reports. The agent in this thread is not sent a "Yes. Run it".
	await card()!.all().find((node) => node.textContent === "Allow")!.fire("click");
	await until("the report and the answer to it", () => thread(page).at(-1) === "msg assistant|The worker is done." && idle(page), 20_000);
	expect(card()).toBeUndefined();
	expect(page.messages().some((line) => line.startsWith("msg user|Yes. Run it"))).toBe(false);
	// The report is one card: how it ended and what it was, then one line and whose it is. The rest opens on a tap.
	expect(reports(page).length).toBe(1);
	const report = reports(page)[0]!;
	expect(report.className).toBe("report done");
	expect(reportWords(report)).toEqual(["done", "Publish the branch", "I ran the push as a dry run after the person allowed it.", "worker"]);
	expect(report.open).toBe(false);
	expect(part(report, "report-body")!.textContent).toContain("Checked: the command exited 0.");
	expect(page.messages().some((line) => line.startsWith("notice-entry|"))).toBe(false); // not also as a block of text
	// Its job over, the row is gone, and with nothing else running so is the card.
	await until("the card to go", () => runningCard(page) === undefined);
	expect(page.$("status").textContent).not.toContain("running");
	// The details page keeps it: its job, how it ended, how long it took, on which model, and when. No Stop.
	await page.$("menu-button").click();
	await loaded(page);
	expect(detailRows(page)[0]).toBe("Workers | Jobs rho handed off | 1");
	await section(page, "Workers");
	expect(detailRows(page).length).toBe(1);
	expect(detailRows(page)[0]).toMatch(/^Publish the branch \| done · 0:\d\d · local · faux-1 · ended \d\d:\d\d \| $/);
	expect(inside(page.$("details-body"), "row-action")).toEqual([]);
}, 60_000);

test("a worker's No is told to it; its thread opens from its row, to read; Stop on the row ends it and leaves no report", async () => {
	scriptWorker(({ results, lastRole }) => {
		if (results === 0) return fauxAssistantMessage(fauxToolCall("bash", { command: PUSH }), { stopReason: "toolUse" });
		if (results === 1 && lastRole === "toolResult") return fauxAssistantMessage("The push waits for the person's yes.");
		if (results === 1) return fauxAssistantMessage(fauxToolCall("wait", { why: "what is left" }), { stopReason: "toolUse" }); // told no: it goes on with the rest
		return fauxAssistantMessage("PARTIAL\nNot pushed: the person said no.");
	}, [fauxAssistantMessage(fauxToolCall("delegate", { action: "start", title: "Publish the branch", brief: BRIEF }), { stopReason: "toolUse" }), fauxAssistantMessage("Handed off.")]);
	const page = await open();
	await until("live", () => idle(page));
	await page.send("publish it");
	const card = () => (page.$("live").children as El[]).find((node) => node.className === "approval");
	await until("the worker's card", () => card() !== undefined, 15_000);
	await card()!.all().find((node) => node.textContent === "Deny")!.fire("click");
	await gate.started; // the worker was told no and went on
	await until("the row to say working again", () => (runningRows(page)[0] ?? "").includes("working"));
	const worker = (await core.workers.list())[0]!;
	const its = await core.harness.conversation(worker.conversation as never, context);
	const told = (await its!.entries({ order: "descending" }, 10, undefined, context)).items.map((entry) => JSON.stringify(entry.model?.[0] ?? "")).find((text) => text.includes("The person said no"));
	expect(told).toContain(`Do not run: \`${PUSH}\``);
	// Its thread opens from the row: read only, with a way back, and nothing can be sent into it.
	await part(runningRowEls(page)[0]!, "running-title")!.fire("click");
	await until("the worker's thread", () => page.$("worker-thread").hidden === false && page.messages().some((line) => line.startsWith("msg user|You are a worker.")));
	expect(page.$("worker-thread").textContent).toContain("Publish the branch: a worker's thread, read only.");
	expect(page.$("composer").hidden).toBe(true);
	expect(runningCard(page)).toBeUndefined(); // a worker's own thread lists no workers
	const token = JSON.parse(page.stored.get("token")!);
	const post = (path: string, body: object) => fetch(`http://127.0.0.1:${server.port}/api/${path}?c=${worker.conversation}`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
	for (const [path, body] of [["submit", { text: "do something else", requestId: "worker-thread-1" }], ["stop", {}], ["new", {}], ["cwd", { path: work }]] as const) {
		const refused = await post(path, body);
		expect([path, refused.status, ((await refused.json()) as { error?: string }).error]).toEqual([path, 403, "A worker's thread is read only."]);
	}
	await part(page.$("worker-thread"), "worker-back")!.fire("click");
	await until("back in the main thread", () => page.$("worker-thread").hidden === true && page.messages().includes("msg assistant|Handed off."));
	expect(page.$("composer").hidden).toBe(false);
	await until("its row again", () => runningRows(page).length === 1);
	// The details page opens its thread too, and closes itself; the row there has a Stop while it works.
	await section(page, "Workers");
	expect(detailRows(page)[0]).toMatch(/^Publish the branch \| working · \d:\d\d · local · faux-1( · wait)? · started \d\d:\d\d \| $/);
	expect(inside(page.$("details-body"), "row-action").map((button) => [button.textContent, button.attrs["aria-label"]])).toEqual([["Stop", "Stop the worker: Publish the branch"]]);
	await inside(page.$("details-body"), "row")[0]!.click();
	await until("the worker's thread, from the details page", () => page.$("details").hidden && page.history.depth === 0 && page.$("worker-thread").hidden === false && page.messages().some((line) => line.startsWith("msg user|You are a worker.")));
	await part(page.$("worker-thread"), "worker-back")!.fire("click");
	await until("back again", () => page.$("worker-thread").hidden === true && runningRows(page).length === 1);
	// Stop, from the row: it ends, its row and the card go, and it reports nothing.
	await part(runningRowEls(page)[0]!, "running-stop")!.fire("click");
	await until("the card to go, the only worker being stopped", () => runningCard(page) === undefined, 15_000);
	await Bun.sleep(200);
	expect(reports(page)).toEqual([]);
	expect((await core.workers.list())[0]).toMatchObject({ status: "stopped" });
	expect(page.$("status").textContent).not.toContain("running");
}, 60_000);

test("five workers: the card holds only the ones still at it; each that ended left a report card, a failed one in red", async () => {
	// Five jobs: two end done, one fails, one is held at work, one waits for a slot (two run at once).
	const jobs = ["done-a", "done-b", "fails", "held", "queued"];
	faux.setResponses(Array.from({ length: 80 }, () => (asked: { messages: { role: string; content: unknown }[] }) => {
		const first = asked.messages.find((message) => message.role === "user")?.content;
		const text = typeof first === "string" ? first : ((first ?? []) as { text?: string }[]).map((item) => item.text ?? "").join("");
		const results = asked.messages.filter((message) => message.role === "toolResult").length;
		if (!text.startsWith("You are a worker.")) {
			// The agent hands off one job per step, then answers; later turns (the reports) get a word.
			if (asked.messages.filter((message) => message.role === "user").length === 1 && results < jobs.length) return fauxAssistantMessage(fauxToolCall("delegate", { action: "start", title: `Job ${jobs[results]}`, brief: `${BRIEF} KIND=${jobs[results]}` }), { stopReason: "toolUse" });
			return fauxAssistantMessage(results >= jobs.length && asked.messages.at(-1)!.role === "toolResult" ? "All handed off." : "Noted.");
		}
		const kind = /KIND=([\w-]+)/.exec(text)![1]!;
		if (kind === "fails") return fauxAssistantMessage("FAILED\nThe remote does not exist.");
		if (kind.startsWith("done")) return fauxAssistantMessage("DONE\nNothing to send.");
		return results === 0 ? fauxAssistantMessage(fauxToolCall("wait", { why: "the build" }), { stopReason: "toolUse" }) : fauxAssistantMessage("DONE\nWaited.");
	}));
	const page = await open();
	await until("live", () => idle(page));
	await page.send("hand off five jobs");
	const titles = () => runningRows(page).map((row) => row.split(" | ")[0]).sort();
	// Three ended at once; the two that are left hold the two slots.
	await until("two rows, both working", () => JSON.stringify(titles()) === JSON.stringify(["Job held", "Job queued"]) && runningRows(page).every((row) => row.includes("| working")), 25_000);
	expect(runningRowEls(page).filter((row) => part(row, "running-stop") !== undefined).length).toBe(2);
	await until("three report cards", () => reports(page).length === 3 && idle(page), 20_000);
	expect(reports(page).map((card) => `${card.className}: ${reportWords(card).join(" / ")}`).sort()).toEqual([
		"report done: done / Job done-a / Nothing to send. / worker",
		"report done: done / Job done-b / Nothing to send. / worker",
		"report failed: failed / Job fails / The remote does not exist. / worker",
	]);
	expect(page.$("status").textContent).toEndWith(" · 2 running");
	expect(part(runningCard(page)!, "running-head")!.textContent).toBe("Running"); // the ended ones are on the details page
	// A second browser is shown the same, from the daemon's state alone.
	const again = await open({ pair: false, stored: page.stored });
	await until("the second page's rows", () => runningRows(again).length === 2 && reports(again).length === 3);
	// The details page lists all five, the live ones first with a Stop each, then the newest first.
	await page.$("menu-button").click();
	await loaded(page);
	expect(detailRows(page)[0]).toBe("Workers | 2 running | 5");
	await section(page, "Workers");
	const listed = () => detailRows(page).map((line) => line.split(" | ").slice(0, 2).join(" | ").replace(/ · \d:\d\d · local · faux-1.*$/, ""));
	expect(listed()).toEqual(["Job queued | working", "Job held | working", "Job fails | failed", "Job done-b | done", "Job done-a | done"]);
	expect(inside(page.$("details-body"), "row-line worker failed").length).toBe(1);
	expect(inside(page.$("details-body"), "row-action").map((button) => button.attrs["aria-label"])).toEqual(["Stop the worker: Job queued", "Stop the worker: Job held"]);
	// The list the page asked the daemon for names this conversation as the one each came from.
	const known = (await (await fetch(`http://127.0.0.1:${server.port}/api/workers`, { headers: { authorization: `Bearer ${JSON.parse(page.stored.get("token")!)}` } })).json()) as { items: { from: string; conversation?: string }[] };
	expect(known.items.map((item) => [item.from, typeof item.conversation])).toEqual(Array.from({ length: 5 }, () => [String(core.root.id), "string"]));
	// Stop, from the details page: it ends there and in the Running card, and leaves no report.
	await inside(page.$("details-body"), "row-action")[0]!.click();
	await until("the stopped one, after the one still at work", () => JSON.stringify(listed().slice(0, 2)) === JSON.stringify(["Job held | working", "Job queued | stopped"]), 15_000);
	expect(inside(page.$("details-body"), "row-action").length).toBe(1);
	await leave(page);
	await until("one row left in the card", () => runningRows(page).length === 1 && runningRows(again).length === 1);
	// The last one ends: no card on either page, and four reports.
	gate.release();
	await until("the cards to go", () => runningCard(page) === undefined && runningCard(again) === undefined && reports(page).length === 4, 25_000);
}, 90_000);

test("preferences and memory on the details page: the three lists to read, and in words when memory is elsewhere or off", async () => {
	mkdirSync(join(dir, "memory"), { recursive: true });
	writeFileSync(join(dir, "memory", "user.md"), "# About the person\n\n- Prefers short answers\n- Treats research older than three months as stale, and wants the date of anything older said beside it\n");
	writeFileSync(join(dir, "memory", "models.md"), "- Haiku for running checks\n");
	const page = await open();
	await until("live", () => idle(page));
	await page.$("menu-button").click();
	await loaded(page);
	expect(detailRows(page)[2]).toBe("Preferences and memory | What rho knows about you | 3");
	await section(page, "Preferences and memory");
	const body = () => page.$("details-body");
	expect(inside(body(), "section-label").map((node) => node.textContent)).toEqual(["About you · 2", "Rho's notes · 0", "Model preferences · 1"]);
	expect(inside(body(), "row-text").map((node) => node.textContent)).toEqual(["Prefers short answers", "Treats research older than three months as stale, and wants the date of anything older said beside it", "Haiku for running checks"]);
	expect(body().all().some((node) => node.tag === "button")).toBe(false); // to read: nothing here changes memory
	expect(inside(body(), "quiet-line").map((node) => node.textContent)).toEqual(["Rho reads these at the start of a conversation. To change one, tell rho in chat.", "Nothing yet."]);
	// Memory kept by another provider is not listed, and the page says where it is.
	const restart = async (memory: MemoryProvider | null) => {
		for (const open of pages.splice(0)) open.stop();
		await server.stop();
		await core.close();
		memoryOption = memory;
		await boot();
	};
	await restart({ label: "honcho: 127.0.0.1:8000", load: async () => undefined });
	const elsewhere = await open();
	await until("live again", () => idle(elsewhere));
	await elsewhere.$("menu-button").click();
	await loaded(elsewhere);
	expect(detailRows(elsewhere)[2]).toBe("Preferences and memory | What rho knows about you | elsewhere");
	await section(elsewhere, "Preferences and memory");
	expect(inside(elsewhere.$("details-body"), "quiet-line").map((node) => node.textContent)).toEqual(["Memory is kept by honcho: 127.0.0.1:8000, not in lists on this machine, so there is nothing to list here."]);
	expect(inside(elsewhere.$("details-body"), "row-text")).toEqual([]);
	// And off is said as off.
	await restart(null);
	const off = await open();
	await until("live a third time", () => idle(off));
	await off.$("menu-button").click();
	await loaded(off);
	expect(detailRows(off)[2]).toBe("Preferences and memory | What rho knows about you | off");
	await section(off, "Preferences and memory");
	expect(inside(off.$("details-body"), "quiet-line").map((node) => node.textContent)).toEqual(["Memory is off. Rho keeps nothing about you between conversations."]);
}, 30_000);

test("reminders on the details page: each with its cadence and next time, and Remove asks once before it removes", async () => {
	const kept = await core.reminders!.add({ text: "Check the build and say only what broke, with the name of the test and the commit that broke it", every: "2h" });
	await core.reminders!.add({ text: "Morning summary", daily: "08:00" });
	const page = await open();
	await until("live", () => idle(page));
	await page.$("menu-button").click();
	await loaded(page);
	expect(detailRows(page)[3]).toBe("Reminders | What rho checks on its own | 2");
	await section(page, "Reminders");
	await loaded(page);
	const lines = () => detailRows(page).map((line) => line.replace(/ · next .*$/, (next) => (/^ · next (\d+ \w{3} )?\d\d:\d\d \| $/.test(next) ? " · next (time)" : next)));
	expect(lines().sort()).toEqual([`${kept.text} | every 2h · next (time)`, "Morning summary | daily at 08:00 · next (time)"]);
	expect(inside(page.$("details-body"), "row").every((row) => row.tag === "div")).toBe(true); // a reminder opens nothing
	// The first tap asks; nothing is removed by it.
	const remove = () => inside(page.$("details-body"), "row-line wrap").find((line) => line.textContent.includes("Morning summary"))!.all().find((node) => node.tag === "button")!;
	expect([remove().textContent, remove().attrs["aria-label"]]).toEqual(["Remove", "Remove reminder: Morning summary"]);
	await remove().click();
	expect([remove().textContent, remove().className]).toEqual(["Remove now", "row-action sure"]);
	expect((await core.reminders!.list()).length).toBe(2);
	await remove().click();
	await until("one reminder left", () => detailRows(page).length === 1);
	expect((await core.reminders!.list()).map((item) => item.text)).toEqual([kept.text]);
	// One that is already gone: the daemon's refusal is said on this page, and the list is read again.
	await core.reminders!.remove(kept.id);
	const last = inside(page.$("details-body"), "row-action")[0]!;
	await last.click();
	await last.click();
	await until("the list read again", () => detailRows(page).length === 0);
	expect([page.$("details-notice").hidden, page.$("details-notice").textContent]).toEqual([false, "No such reminder."]);
	expect(inside(page.$("details-body"), "quiet-line")[0]!.textContent).toBe("No reminders.");
	await leave(page);
	await page.$("menu-button").click();
	await loaded(page);
	expect(detailRows(page)[3]).toBe("Reminders | What rho checks on its own | 0");
});

test("a background command is a row too: its command, its time, a Stop; and how it ended is a report card", async () => {
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("background", { action: "start", command: "sleep 30" }), { stopReason: "toolUse" }), fauxAssistantMessage("Started."),
		fauxAssistantMessage(fauxToolCall("background", { action: "start", command: "echo hi" }), { stopReason: "toolUse" }), fauxAssistantMessage("Started again."), fauxAssistantMessage("It passed."),
		fauxAssistantMessage(fauxToolCall("background", { action: "start", command: "echo no; exit 3" }), { stopReason: "toolUse" }), fauxAssistantMessage("Started a third."), fauxAssistantMessage("It failed."),
	]);
	const page = await open();
	await until("live", () => idle(page));
	await page.send("run the long job");
	await until("its row", () => /^sleep 30 \| running · 0:\d\d · background command$/.test(runningRows(page)[0] ?? "") && idle(page), 15_000);
	expect(runningRowEls(page)[0]!.className).toContain("background");
	expect(page.$("status").textContent).toEndWith(" · 1 running");
	// Stop, from the row: the command ends and says nothing more.
	await part(runningRowEls(page)[0]!, "running-stop")!.fire("click");
	await until("the card to go", () => runningCard(page) === undefined, 15_000);
	expect(reports(page)).toEqual([]);
	expect(await core.background.running()).toBeUndefined();
	const token = JSON.parse(page.stored.get("token")!);
	const again = await fetch(`http://127.0.0.1:${server.port}/api/background/stop`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: "{}" });
	expect([again.status, ((await again.json()) as { error?: string }).error]).toEqual([409, "No background command is running."]);
	// One that passes: a card with one line and nothing to open.
	await page.send("run the short one");
	await until("the report and the answer to it", () => thread(page).at(-1) === "msg assistant|It passed." && idle(page), 20_000);
	expect(reports(page).length).toBe(1);
	expect(reports(page)[0]!.className).toBe("report done");
	expect(reportWords(reports(page)[0]!).join(" / ")).toMatch(/^done \/ echo hi \/ passed in \d+ s\. \/ background command$/);
	expect(part(reports(page)[0]!, "report-body")).toBeUndefined();
	// One that fails: red, and its last lines open on a tap.
	await page.send("run the bad one");
	await until("the second report", () => thread(page).at(-1) === "msg assistant|It failed." && idle(page), 20_000);
	expect(reports(page)[1]!.className).toBe("report failed");
	expect(reportWords(reports(page)[1]!).slice(0, 2)).toEqual(["failed", "echo no; exit 3"]);
	expect(part(reports(page)[1]!, "report-body")!.textContent).toContain("no");
	expect(runningCard(page)).toBeUndefined();
}, 60_000);

test("a worker's question is one quiet line; its report card folds what was decided without the person into one line", async () => {
	faux.setResponses([fauxAssistantMessage("Noted."), fauxAssistantMessage("Read it.")]);
	const page = await open();
	await until("live", () => idle(page));
	await core.root.submit({ type: "input", content: "[a worker asks] Fix the greeting: Which spelling?\nIt goes on with: American\n(Item q1, from worker w1.)", requestId: "ask-1", whenBusy: "followUp", entry: { kind: "rho.notice", data: { from: "worker-ask", item: "q1" } } }, context);
	await until("the quiet line", () => page.messages().some((line) => line.startsWith("notice-entry quiet|")) && idle(page), 15_000);
	expect(page.messages().find((line) => line.startsWith("notice-entry quiet|"))).toBe("notice-entry quiet|A worker asks rho · Fix the greeting: Which spelling?");
	const decided = [{ question: "Which spelling?", done: "<b>British</b>", by: "coordinator", basis: "the person said so" }, { question: "Keep it?", done: "keep it", by: "default", basis: "No answer came." }];
	await core.root.submit({ type: "input", content: "[worker w1] reports.", requestId: "ask-report-1", whenBusy: "followUp", entry: { kind: "rho.notice", data: { from: "worker", card: { kind: "report", title: "Fix the greeting", verdict: "done", who: "worker w1", body: "DONE\nFixed.", decided } } } }, context);
	await until("the report card", () => reports(page).length === 1 && idle(page), 15_000);
	const fold = part(reports(page)[0]!, "report-decided")!;
	expect((fold.children[0] as El).textContent).toBe("Decided without you · 2");
	expect(fold.all().filter((node) => node.className === "decided-done").map((node) => node.textContent)).toEqual(["→ <b>British</b>", "→ keep it"]); // as text, never markup
	expect(fold.all().filter((node) => node.className === "decided-basis").map((node) => node.textContent)).toEqual(["answered by rho · the person said so", "the worker's default · No answer came."]);
}, 40_000);

test("a notice is drawn as a card only when what was stored is a card, field by field", () => {
	const good = { kind: "report", title: "Fix it", verdict: "partial", who: "worker w4", body: "PARTIAL\nHalf." };
	expect(noticeCard({ from: "worker", card: good })).toEqual(good as never);
	expect(noticeCard({ from: "worker", card: { ...good, summary: "One line", extra: "<script>" } })).toEqual({ ...good, summary: "One line" } as never); // unknown fields are dropped
	for (const bad of [undefined, {}, { card: "report" }, { card: { ...good, kind: "html" } }, { card: { ...good, verdict: "great" } }, { card: { ...good, title: 7 } }, { card: { kind: "report", verdict: "done" } }]) expect(noticeCard(bad)).toBeUndefined();
	expect(noticeCard({ card: { ...good, body: "x".repeat(9_000) } })!.body!.length).toBe(6_000);
	// What was decided without the person: kept entry by entry, a bad entry dropped, at most 20.
	const decided = { question: "Which file?", done: "hello.txt", by: "default", basis: "No answer came." };
	expect(noticeCard({ card: { ...good, decided: [decided, { ...decided, by: "boss" }, { question: 1 }, null, { ...decided, extra: "<b>" }] } })!.decided).toEqual([decided, decided] as never);
	expect(noticeCard({ card: { ...good, decided: Array.from({ length: 30 }, () => decided) } })!.decided!.length).toBe(20);
	expect(noticeCard({ card: { ...good, decided: "no" } })!.decided).toBeUndefined();
});
