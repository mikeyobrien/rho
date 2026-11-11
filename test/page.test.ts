import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
async function open(options: { pair?: boolean; stored?: Map<string, string>; touch?: boolean; shrink?: (file: any) => Promise<any>; now?: () => number } = {}): Promise<Page> {
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
		...(options.shrink ? { shrink: options.shrink } : {}),
		...(options.now ? { now: options.now } : {}),
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
	expect(page.$("release").hidden).toBe(true);
	// What the gate, another process, writes as it works. Its pid here is this test's, which lives.
	const [commit, previous] = ["a".repeat(40), "b".repeat(40)];
	const stage = (name: string, at: number) => writeFileSync(join(dir, "release.json"), JSON.stringify({ status: "running", stage: name, commit, previous, pid: process.pid, started: 1_000, at }));
	const line = () => page.$("release-text").textContent;
	now = 42_000;
	stage("check", 2_000);
	await until("the release line", () => !page.$("release").hidden);
	expect(line()).toBe("Releasing aaaaaaa · running the checks · 0:41");
	expect(page.$("release").classList.contains("bad")).toBe(false);
	// The time counts on its own between the daemon's snapshots.
	now = 65_000;
	await until("the clock to move", () => line() === "Releasing aaaaaaa · running the checks · 1:04", 15_000);
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
	await until("the line to count through the restart", () => line() === "Releasing aaaaaaa · restarting rho · 1:14", 15_000);
	// It comes back on the new commit.
	writeFileSync(join(dir, "release.json"), JSON.stringify({ status: "released", commit, previous, at: Date.now() }));
	down = false;
	await until("the result", () => line() === "Rho now runs aaaaaaa (it ran bbbbbbb).", 15_000);
	expect(idle(page)).toBe(true);
	// A release that failed, and one that went back, say so in the colour of a fault.
	writeFileSync(join(dir, "release.json"), JSON.stringify({ status: "failed", commit, previous, reason: "Its checks failed (exit 1):\nlots", at: Date.now() }));
	await until("the failure", () => line() === "aaaaaaa was not released. Rho still runs bbbbbbb.");
	expect(page.$("release").classList.contains("bad")).toBe(true);
	expect(JSON.stringify(page.$("release").textContent)).not.toContain("lots");
	writeFileSync(join(dir, "release.json"), JSON.stringify({ status: "rolled-back", commit, previous, at: Date.now() }));
	await until("the roll back", () => line() === "aaaaaaa did not start, so rho is back on bbbbbbb.");
	// After five minutes it is no longer news.
	writeFileSync(join(dir, "release.json"), JSON.stringify({ status: "released", commit, previous, at: Date.now() - 6 * 60_000 }));
	await until("the line to go", () => page.$("release").hidden);
	expect(line()).toBe("");
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
