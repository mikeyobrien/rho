import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { context, openCore, type Core } from "../src/core.ts";
import { serve, type Server } from "../src/http.ts";
import type { StateView } from "../src/view.ts";
import { start } from "../web/app.js";
import { El, fakeDocument, fakeHistory } from "./fixtures/dom.ts";

// Several conversations over HTTP and in the page: a real core and server, a scripted model
// with two models to choose between.
const dirs: string[] = [];
let core: Core;
let server: Server;
let faux: ReturnType<typeof fauxProvider>;
let models: ReturnType<typeof createModels>;
let dir: string;
let token: string;
const pages: { stop(): void }[] = [];
const scratch = (prefix: string) => {
	const made = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	dirs.push(made);
	return made;
};
async function boot(work: string, port = 0) {
	core = await openCore({ dir, models, config: { model: `${faux.getModel().provider}/model-a`, cwd: work } });
	server = await serve({ core, models, dir, port });
	token = readFileSync(join(dir, "token"), "utf8");
}
async function setup() {
	dir = scratch("rho-conv-data-");
	faux = fauxProvider({ models: [{ id: "model-a" }, { id: "model-b" }] });
	models = createModels();
	models.setProvider(faux.provider);
	const work = scratch("rho-conv-work-");
	await boot(work);
	return work;
}
afterEach(async () => {
	for (const page of pages.splice(0)) page.stop();
	await server?.stop().catch(() => undefined);
	await core?.close().catch(() => undefined);
	for (const made of dirs.splice(0)) rmSync(made, { recursive: true, force: true });
});
const call = (path: string, body?: object) => fetch(`http://127.0.0.1:${server.port}${path}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
const list = async () => ((await (await call("/api/conversations")).json()) as { items: { id: string; title: string; root: boolean; cwd: string; model: string; running: boolean }[] }).items;
/** The newest snapshot of a conversation, once `done` holds. */
async function state(c: string, done: (view: StateView) => boolean = () => true): Promise<StateView> {
	const response = await call(`/api/events${c ? `?c=${c}` : ""}`);
	const reader = response.body!.getReader();
	let buffer = "";
	const end = Date.now() + 8_000;
	try {
		for (;;) {
			if (Date.now() > end) throw new Error(`timed out; last ${buffer.slice(-300)}`);
			const { value } = await reader.read();
			buffer += new TextDecoder().decode(value);
			const frames = buffer.split("\n\n").filter((frame) => frame.startsWith("data: "));
			const complete = buffer.endsWith("\n\n") ? frames : frames.slice(0, -1);
			for (const frame of complete.reverse()) {
				const view = JSON.parse(frame.slice(6)) as StateView;
				if (done(view)) return view;
				break; // only the newest counts
			}
		}
	} finally {
		await reader.cancel().catch(() => undefined);
	}
}
const answered = (count: number) => (view: StateView) => !view.running && view.entries.length >= count;

test("a new conversation is made, listed, and has its own thread, directory and model", async () => {
	const workA = await setup();
	const workB = scratch("rho-conv-b-");
	expect(await list()).toMatchObject([{ title: "", root: true, cwd: workA, model: "faux/model-a", running: false }]);
	// Made in a directory of its own; a directory that is not there is refused.
	expect((await call("/api/conversations", { cwd: join(workB, "missing") })).status).toBe(400);
	expect((await call("/api/conversations", { cwd: "relative" })).status).toBe(400);
	const { id: b } = (await (await call("/api/conversations", { cwd: workB })).json()) as { id: string };
	const [first, second] = await list();
	expect(second).toMatchObject({ id: b, root: false, cwd: workB, model: "faux/model-a" });
	// A message to one does not appear in the other, and names its conversation.
	faux.setResponses([fauxAssistantMessage("answer in B"), fauxAssistantMessage("answer in A")]);
	await call(`/api/submit?c=${b}`, { text: "Plan the garden\nwith details", requestId: "req-conv-b1" });
	expect((await state(b, answered(2))).entries.map((entry) => entry.text)).toEqual(["Plan the garden\nwith details", "answer in B"]);
	expect((await state("")).entries).toEqual([]);
	await call("/api/submit", { text: "Fix the build", requestId: "req-conv-a1" });
	expect((await state(first!.id, answered(2))).entries.map((entry) => entry.text)).toEqual(["Fix the build", "answer in A"]);
	expect((await state(b)).entries.length).toBe(2);
	expect((await list()).map((item) => item.title)).toEqual(["Fix the build", "Plan the garden"]);
	// A later message does not rename it.
	faux.setResponses([fauxAssistantMessage("again")]);
	await call(`/api/submit?c=${b}`, { text: "Something else", requestId: "req-conv-b2" });
	await state(b, answered(4));
	expect((await list())[1]!.title).toBe("Plan the garden");
	// Model, thinking and directory are changed for one conversation only.
	expect((await call(`/api/model?c=${b}`, { model: "faux/model-b", thinking: "high" })).status).toBe(200);
	expect(await state(b, (view) => view.model === "faux/model-b")).toMatchObject({ model: "faux/model-b", thinking: "high", cwd: workB });
	expect(await state("")).toMatchObject({ model: "faux/model-a", thinking: "medium", cwd: workA });
	// A conversation that is not listed does not exist to the wire.
	for (const path of ["/api/events?c=999999", "/api/earlier?c=nope&before=5"]) expect((await call(path)).status).toBe(404);
	expect((await call("/api/submit?c=999999", { text: "x", requestId: "req-conv-x1" })).status).toBe(404);
});

test("each conversation's tools work in its own directory, and each answers with its own model", async () => {
	const workA = await setup();
	const workB = scratch("rho-conv-b-");
	const { id: b } = (await (await call("/api/conversations", { cwd: workB })).json()) as { id: string };
	await call(`/api/model?c=${b}`, { model: "faux/model-b" });
	const pwd = fauxAssistantMessage(fauxToolCall("bash", { command: "pwd" }), { stopReason: "toolUse" });
	const used: string[] = [];
	const record = (reply: ReturnType<typeof fauxAssistantMessage>) => ((_t: unknown, _o: unknown, _s: unknown, model: { id: string }) => (used.push(model.id), reply)) as never;
	faux.setResponses([record(pwd), record(fauxAssistantMessage("done"))]);
	await call(`/api/submit?c=${b}`, { text: "where", requestId: "req-conv-pwd-b" });
	const inB = await state(b, answered(4));
	expect(inB.entries.find((entry) => entry.role === "tool")!.text.trim()).toBe(workB);
	faux.setResponses([record(pwd), record(fauxAssistantMessage("done"))]);
	await call("/api/submit", { text: "where", requestId: "req-conv-pwd-a" });
	expect((await state("", answered(4))).entries.find((entry) => entry.role === "tool")!.text.trim()).toBe(workA);
	expect(used).toEqual(["model-b", "model-b", "model-a", "model-a"]);
});

test("after a restart each conversation keeps its thread, title, model, thinking level and directory", async () => {
	const workA = await setup();
	const workB = scratch("rho-conv-b-");
	const { id: b } = (await (await call("/api/conversations", { cwd: workB })).json()) as { id: string };
	await call(`/api/model?c=${b}`, { model: "faux/model-b", thinking: "xhigh" });
	faux.setResponses([fauxAssistantMessage("kept in B")]);
	await call(`/api/submit?c=${b}`, { text: "Remember this one", requestId: "req-conv-keep" });
	await state(b, answered(2));
	const before = await list();
	const port = server.port;
	await server.stop();
	await core.close();
	await boot(scratch("rho-conv-other-"), port); // started again, with another default directory in its config
	expect(await list()).toEqual(before);
	expect(await state(b)).toMatchObject({ model: "faux/model-b", thinking: "xhigh", cwd: workB });
	expect((await state(b)).entries.map((entry) => entry.text)).toEqual(["Remember this one", "kept in B"]);
	expect(await state("")).toMatchObject({ model: "faux/model-a", thinking: "medium", cwd: workA });
	// And both still work.
	faux.setResponses([fauxAssistantMessage("after restart")]);
	await call(`/api/submit?c=${b}`, { text: "still there?", requestId: "req-conv-after" });
	expect((await state(b, answered(4))).entries.at(-1)!.text).toBe("after restart");
});

interface Page { $(id: string): El; stored: Map<string, string>; document: ReturnType<typeof fakeDocument>; messages(): string[]; send(words: string): Promise<void>; rows(): Promise<El[]> }
async function open(options: { stored?: Map<string, string>; down?: () => boolean } = {}): Promise<Page> {
	const document = fakeDocument();
	const stored = options.stored ?? new Map<string, string>();
	const location = { hash: options.stored ? "" : `#pair=${server.pairCode()}`, pathname: "/", search: "" };
	const past = fakeHistory(location);
	const page = start({
		document,
		storage: { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => void stored.set(key, value) },
		location,
		...past,
		fetch: (path: string, init?: RequestInit) => (options.down?.() ? Promise.reject(new TypeError("fetch failed")) : fetch(`http://127.0.0.1:${server.port}${path}`, init)),
		touch: true,
	});
	pages.push(page);
	await page.ready;
	const $ = (id: string) => document.getElementById(id);
	return {
		$, stored, document,
		messages: () => [...$("entries").children, ...$("live").children].filter((node): node is El => node instanceof El && !node.hidden).map((node) => `${node.className}|${node.textContent}`),
		send: async (words) => { $("input").value = words; await $("input").fire("input"); await $("composer").requestSubmit(); },
		/** Open the details page afresh, go into Conversations, and return its rows once the daemon's list is drawn. */
		rows: async () => {
			while (!$("details").hidden) {
				const depth = past.history.depth;
				await $("details-back").click();
				await until("one level back", () => past.history.depth < depth);
			}
			await $("menu-button").click();
			await within($("details-body"), "row").find((row) => within(row, "row-title")[0]!.textContent === "Conversations")!.click();
			await until("the list", () => $("details-body").attrs["aria-busy"] === "false");
			return within($("details-body"), "row");
		},
	};
}
async function until(what: string, check: () => unknown, ms = 8_000): Promise<void> {
	const end = Date.now() + ms;
	while (!check()) {
		if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
		await Bun.sleep(20);
	}
}
const idle = (page: Page) => page.$("status").textContent.includes("/");
const within = (node: El, name: string) => node.all().filter((child) => child.className === name);
const titles = (rows: El[]) => rows.map((row) => `${row.attrs["aria-current"] ? "*" : " "}${within(row, "row-title")[0]!.textContent}`);

test("in the page: a new conversation starts empty, each keeps its thread, and switching shows the other", async () => {
	const workA = await setup();
	faux.setResponses([fauxAssistantMessage("first answer"), fauxAssistantMessage("second answer")]);
	const page = await open();
	await until("live", () => idle(page));
	await page.send("About the build");
	await until("the first answer", () => page.messages().includes("msg assistant|first answer") && idle(page));
	expect(titles(await page.rows())).toEqual(["*About the build"]);
	await page.$("details-body").find("new-conversation")!.click();
	await until("the empty thread", () => page.messages().length === 0 && idle(page) && !page.$("empty").hidden);
	expect(page.$("details").hidden).toBe(true);
	await page.send("About the garden");
	await until("the second answer", () => page.messages().includes("msg assistant|second answer") && idle(page));
	expect(page.messages()).toEqual(["msg user|About the garden", "msg assistant|second answer"]);
	const rows = await page.rows();
	expect(titles(rows)).toEqual([" About the build", "*About the garden"]);
	expect(within(rows[1]!, "row-sub")[0]!.textContent).toBe(workA); // it started where the first one works
	await rows[0]!.fire("click");
	await until("the first thread", () => page.messages().includes("msg assistant|first answer") && idle(page));
	expect(page.messages()).toEqual(["msg user|About the build", "msg assistant|first answer"]);
	expect(titles(await page.rows())).toEqual(["*About the build", " About the garden"]);
});

test("in the page: a reload opens the conversation that was open, and a kept message goes to the one it was written in", async () => {
	await setup();
	faux.setResponses([fauxAssistantMessage("garden answer"), fauxAssistantMessage("answer to the kept one")]);
	let down = false;
	const page = await open({ down: () => down });
	await until("live", () => idle(page));
	await page.rows();
	await page.$("details-body").find("new-conversation")!.click();
	await until("the new one", () => idle(page) && JSON.parse(page.stored.get("conversation") ?? '""') !== "");
	await page.send("In the garden");
	await until("its answer", () => page.messages().includes("msg assistant|garden answer") && idle(page));
	// Rho goes away; a message is written in the garden conversation; the person then looks at the first one.
	down = true;
	await page.document.fire("visibilitychange");
	await until("offline", () => page.$("status").textContent === "Can't reach rho");
	await page.send("Kept while offline");
	expect(page.messages().at(-2)).toBe("msg user unsent|Kept while offline");
	pages.pop()!.stop();
	down = false;
	const reloaded = await open({ stored: page.stored, down: () => down });
	await until("the kept message answered", () => reloaded.messages().includes("msg assistant|answer to the kept one") && idle(reloaded));
	// The reload opened the garden conversation, and the kept message landed there, once.
	expect(reloaded.messages()).toEqual(["msg user|In the garden", "msg assistant|garden answer", "msg user|Kept while offline", "msg assistant|answer to the kept one"]);
	expect((await state("")).entries).toEqual([]); // nothing went to the first conversation
});

test("in the page: a stored conversation that no longer exists falls back to the first one", async () => {
	await setup();
	const stored = new Map<string, string>([["token", JSON.stringify(token)], ["conversation", JSON.stringify("424242")]]);
	const page = await open({ stored });
	await until("live", () => idle(page));
	expect(JSON.parse(stored.get("conversation")!)).toBe("");
	expect(titles(await page.rows())).toEqual(["*New conversation"]);
});
