import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { openCore, type Core } from "../src/core.ts";
import { serve, type Server } from "../src/http.ts";
import { start } from "../web/app.js";
import { El, fakeDocument } from "./fixtures/dom.ts";

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
const pages: { stop(): void }[] = [];

async function boot(port = 0) {
	core = await openCore({ dir, models, config: { model: `${faux.getModel().provider}/${faux.getModel().id}`, cwd: work }, extensions: [defineExtension({ name: "t", tools: [waitTool()] })] });
	server = await serve({ core, models, dir, port });
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
	faux = fauxProvider();
	models = createModels();
	models.setProvider(faux.provider);
	down = false;
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

interface Page { $(id: string): El; stored: Map<string, string>; location: { hash: string; pathname: string; search: string }; document: ReturnType<typeof fakeDocument>; messages(): string[]; type(words: string): Promise<void>; send(words: string): Promise<void> }
async function open(options: { pair?: boolean; stored?: Map<string, string>; touch?: boolean } = {}): Promise<Page> {
	const document = fakeDocument();
	const stored = options.stored ?? new Map<string, string>();
	const location = { hash: options.pair === false ? "" : `#pair=${server.pairCode()}`, pathname: "/", search: "" };
	const page = start({
		document,
		storage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => void stored.set(key, value) },
		location,
		history: { replaceState: () => void (location.hash = "") },
		fetch: (path: string, init?: RequestInit) => (down ? Promise.reject(new TypeError("fetch failed")) : fetch(`http://127.0.0.1:${server.port}${path}`, init)),
		touch: options.touch ?? true,
	});
	pages.push(page);
	await page.ready;
	const $ = (id: string) => document.getElementById(id);
	const type = async (words: string) => { $("input").value = words; await $("input").fire("input"); };
	return { $, stored, location, document, type, messages: () => [...$("entries").children, ...$("live").children].filter((node): node is El => node instanceof El && !node.hidden).map((node) => `${node.className}|${node.textContent}`),
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

test("a browser with no pairing code is refused and told what to run", async () => {
	const page = await open({ pair: false });
	await until("the unpaired notice", () => page.$("status").textContent === "Not paired");
	expect(page.$("notice").hidden).toBe(false);
	expect(page.$("notice-text").textContent).toContain("rho open");
	expect(page.messages()).toEqual([]);
});

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

test("the menu lists models and thinking levels and changes them; new chat puts a divider", async () => {
	faux.setResponses([fauxAssistantMessage("first"), fauxAssistantMessage("second")]);
	const page = await open();
	await until("live", () => idle(page));
	await page.$("menu-button").fire("click");
	await until("the model list", () => page.$("model").children.length > 0);
	expect(page.$("menu").hidden).toBe(false);
	expect((page.$("thinking").children as El[]).map((node) => node.value)).toEqual(["low", "medium", "high", "xhigh", "max"]);
	expect((page.$("thinking").children as El[]).find((node) => node.selected)?.value).toBe("medium");
	page.$("thinking").value = "high";
	await page.$("thinking").fire("change");
	await page.document.fire("keydown", { key: "Escape" });
	expect(page.$("menu").hidden).toBe(true);
	await page.$("menu-button").fire("click");
	await until("the new level", () => (page.$("thinking").children as El[]).find((node) => node.selected)?.value === "high");
	await page.send("one");
	await until("first answer", () => page.messages().includes("msg assistant|first") && idle(page));
	await page.$("new-chat").fire("click");
	await page.send("two");
	await until("second answer", () => page.messages().includes("msg assistant|second") && idle(page));
	expect(page.messages().map((line) => line.split("|")[0])).toEqual(["msg user", "msg assistant", "divider", "msg user", "msg assistant"]);
	expect(page.messages()[2]).toBe("divider|Context cleared");
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
