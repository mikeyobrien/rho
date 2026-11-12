import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { openCore, type Core } from "../src/core.ts";
import { serve, type Server } from "../src/http.ts";
import type { StateView } from "../src/view.ts";
import type { MemoryProvider } from "../src/memory/provider.ts";

// A real core and a real HTTP server on a free port, with a scripted model. No model is called.
let dir: string;
let core: Core;
let server: Server;
let faux: ReturnType<typeof fauxProvider>;
let base: string;
let token: string;
let gate: { release(): void; started: Promise<void> };
let allModels: ReturnType<typeof createModels>;

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "rho-http-test-"));
	faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	allModels = models;
	let release!: () => void;
	let begun!: () => void;
	const held = new Promise<void>((resolve) => (release = resolve));
	gate = { release, started: new Promise<void>((resolve) => (begun = resolve)) };
	// A tool that waits until the test lets it go, so a run can be held open.
	const wait = defineTool({ name: "wait", description: "Wait.", parameters: obj({ why: str() }), execute: async (_args, api, toolContext) => {
		api.output("waiting\n");
		begun();
		// A tool is told to stop through its context; one that ignores it would hold Stop open.
		await Promise.race([held, new Promise<void>((resolve) => toolContext.abortSignal?.addEventListener("abort", () => resolve(), { once: true }))]);
		return { output: [{ type: "text", text: "waited" }] };
	} });
	const model = faux.getModel();
	core = await openCore({ dir, models, config: { model: `${model.provider}/${model.id}` }, extensions: [defineExtension({ name: "t", tools: [wait] })] });
	server = await serve({ core, models, dir, port: 0 });
	base = `http://127.0.0.1:${server.port}`;
	token = readFileSync(join(dir, "token"), "utf8");
});
afterEach(async () => {
	gate.release();
	await server.stop();
	await core.close();
	rmSync(dir, { recursive: true, force: true });
});

const call = (path: string, body?: object, headers: Record<string, string> = { authorization: `Bearer ${token}` }) =>
	fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST", headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
const submit = (text: string, requestId: string, whenBusy?: string) => call("/api/submit", { text, requestId, whenBusy });

/** Read the event stream until `done` says so; returns every snapshot seen. */
async function follow(done: (state: StateView, all: StateView[]) => boolean, ms = 8_000): Promise<StateView[]> {
	const abort = new AbortController();
	const timer = setTimeout(() => abort.abort(), ms);
	const response = await call("/api/events");
	const reader = response.body!.getReader();
	const seen: StateView[] = [];
	let buffer = "";
	try {
		for (;;) {
			const { value, done: ended } = await Promise.race([reader.read(), new Promise<never>((_, reject) => abort.signal.addEventListener("abort", () => reject(new Error(`stream: timed out; last state ${JSON.stringify(seen.at(-1))?.slice(0, 400)}`))))]);
			if (ended) return seen;
			buffer += new TextDecoder().decode(value);
			let end: number;
			while ((end = buffer.indexOf("\n\n")) !== -1) {
				const frame = buffer.slice(0, end);
				buffer = buffer.slice(end + 2);
				if (!frame.startsWith("data: ")) continue;
				seen.push(JSON.parse(frame.slice(6)) as StateView);
				if (done(seen.at(-1)!, seen)) return seen;
			}
		}
	} finally {
		clearTimeout(timer);
		await reader.cancel().catch(() => undefined);
	}
}
const idleWith = (count: number) => (state: StateView) => !state.running && state.entries.length >= count;

test("every API call needs the token; the files that hold secrets are private", async () => {
	for (const path of ["/api/health", "/api/events", "/api/models", "/api/reminders", "/api/memory", "/api/workers", "/api/artifacts", "/api/span?from=1&before=5", "/api/earlier?before=5"]) expect((await call(path, undefined, {})).status).toBe(401);
	expect((await call("/api/submit", { text: "hi", requestId: "12345678" }, {})).status).toBe(401);
	expect((await call("/api/health", undefined, { authorization: "Bearer wrong" })).status).toBe(401);
	expect((await call("/api/health")).status).toBe(200);
	for (const file of ["token", "pair-code", "daemon.json"]) expect(statSync(join(dir, file)).mode & 0o777).toBe(0o600);
});

test("pairing trades the one-time code for the token, once", async () => {
	const code = server.pairCode();
	expect(readFileSync(join(dir, "pair-code"), "utf8")).toBe(code);
	expect((await call("/api/pair", { code: "wrong" }, {})).status).toBe(401);
	const paired = await call("/api/pair", { code }, {});
	expect(await paired.json()).toEqual({ token });
	expect((await call("/api/pair", { code }, {})).status).toBe(401); // used
	expect(server.pairCode()).not.toBe(code);
	expect(readFileSync(join(dir, "pair-code"), "utf8")).toBe(server.pairCode());
});

test("another origin, or another host name, is refused even with the token", async () => {
	expect((await call("/api/health", undefined, { authorization: `Bearer ${token}`, origin: "https://evil.example" })).status).toBe(403);
	expect((await call("/api/health", undefined, { authorization: `Bearer ${token}`, origin: base })).status).toBe(200);
	expect((await call("/api/health", undefined, { authorization: `Bearer ${token}`, host: "evil.example" })).status).toBe(403);
	expect((await call("/not-api")).status).toBe(404);
	expect((await call("/api/nope")).status).toBe(404);
});

test("artifacts are listed over the whole conversation; a span gives the entries back to one of them", async () => {
	expect(await (await call("/api/artifacts")).json()).toEqual({ photos: [], files: [], reports: [] });
	// Twelve writes, two of them to the same file, and one that fails: more than one snapshot's window of entries.
	const paths = [...Array.from({ length: 11 }, (_, n) => `f${n}.txt`), "f3.txt"];
	faux.setResponses([
		...paths.map((path) => fauxAssistantMessage(fauxToolCall("write", { path, content: "x\n" }), { stopReason: "toolUse" })),
		fauxAssistantMessage(fauxToolCall("edit", { path: "nope.txt", edits: [{ oldText: "a", newText: "b" }] }), { stopReason: "toolUse" }),
		fauxAssistantMessage("Written."),
	]);
	expect((await submit("write them", "req-artifacts-1")).status).toBe(200);
	await follow((state) => !state.running && state.entries.at(-1)?.role === "assistant" && state.entries.at(-1)?.text === "Written.");
	const found = (await (await call("/api/artifacts")).json()) as { photos: unknown[]; files: { path: string; count: number; id: number; last: string }[]; reports: unknown[]; cut?: true };
	// Newest change first; the file written twice is one row counted twice; the edit that failed is not there.
	expect(found.files.map((file) => `${file.path} ${file.count}`)).toEqual(["f3.txt 2", "f10.txt 1", "f9.txt 1", "f8.txt 1", "f7.txt 1", "f6.txt 1", "f5.txt 1", "f4.txt 1", "f2.txt 1", "f1.txt 1", "f0.txt 1"]);
	expect(found.cut).toBeUndefined();
	expect(found.files.every((file) => Number.isSafeInteger(file.id) && file.last !== "")).toBe(true);
	// A span: from the oldest file's entry up to an entry a client already holds, in order, with whether more lies before it.
	const oldest = found.files.at(-1)!.id;
	const newest = found.files[0]!.id;
	const span = (await (await call(`/api/span?from=${oldest}&before=${newest}`)).json()) as { entries: { id: number; role: string }[]; more: boolean };
	expect(span.entries[0]!.id).toBe(oldest);
	expect(span.entries.every((entry, n) => n === 0 || entry.id > span.entries[n - 1]!.id)).toBe(true);
	expect(span.entries.every((entry) => entry.id < newest)).toBe(true);
	expect(span.more).toBe(true); // the person's message and the first call come before the first result
	for (const bad of ["from=0&before=5", "from=5&before=5", "from=x&before=9", "before=9"]) expect((await call(`/api/span?${bad}`)).status).toBe(400);
	// Another conversation has none of these.
	const other = (await (await call("/api/conversations", {})).json()) as { id: string };
	expect(await (await call(`/api/artifacts?c=${other.id}`)).json()).toEqual({ photos: [], files: [], reports: [] });
}, 40_000);

test("a question is answered: the stream shows the question, then the answer, as whole snapshots", async () => {
	faux.setResponses([fauxAssistantMessage("Tokyo.")]);
	const first = await follow(() => true);
	expect(first[0]).toMatchObject({ entries: [], running: false, queued: [], more: false });
	expect(first[0]!.model).toContain("/");
	expect((await submit("Capital of Japan?", "req-00001")).status).toBe(200);
	const states = await follow(idleWith(2));
	expect(states.at(-1)!.entries.map((entry) => [entry.role, entry.text])).toEqual([["user", "Capital of Japan?"], ["assistant", "Tokyo."]]);
	expect(states.at(-1)!.failure).toBeUndefined();
});

test("a resend with the same request id is one question, not two", async () => {
	faux.setResponses([fauxAssistantMessage("once")]);
	const a = (await (await submit("hello", "req-same-1")).json()) as { submissionId: string };
	const b = (await (await submit("hello", "req-same-1")).json()) as { submissionId: string };
	expect(b.submissionId).toBe(a.submissionId);
	const states = await follow(idleWith(2));
	expect(states.at(-1)!.entries.filter((entry) => entry.role === "user").length).toBe(1);
});

test("a tool round shows the call, its running output, and its result", async () => {
	faux.setResponses([fauxAssistantMessage(fauxToolCall("wait", { why: "test" }), { stopReason: "toolUse" }), fauxAssistantMessage("Done waiting.")]);
	await submit("wait please", "req-tool-1");
	await gate.started;
	const during = await follow((state) => state.tools.some((tool) => tool.name === "wait" && tool.output.includes("waiting")));
	expect(during.at(-1)!.running).toBe(true);
	expect(during.at(-1)!.entries.at(-1)).toMatchObject({ role: "assistant", calls: [{ name: "wait", args: { why: "test" } }] });
	gate.release();
	const done = await follow(idleWith(4));
	expect(done.at(-1)!.entries.map((entry) => entry.role)).toEqual(["user", "assistant", "tool", "assistant"]);
	expect(done.at(-1)!.entries[2]).toMatchObject({ role: "tool", name: "wait", text: "waited" });
	expect(done.at(-1)!.tools).toEqual([]);
});

test("while a run works: a message queues and can be taken back, a steer joins the run, stop ends it", async () => {
	faux.setResponses([fauxAssistantMessage(fauxToolCall("wait", { why: "hold" }), { stopReason: "toolUse" })]);
	await submit("start", "req-busy-1");
	await gate.started;
	const queued = (await (await submit("and then this", "req-busy-2")).json()) as { submissionId: string };
	const withQueue = await follow((state) => state.queued.length === 1);
	expect(withQueue.at(-1)!.queued).toEqual([{ id: queued.submissionId, mode: "followUp", text: "and then this" }]);
	expect(await (await call("/api/unqueue", { id: queued.submissionId })).json()).toEqual({ ok: true, result: "aborted" });
	await follow((state) => state.queued.length === 0);
	await submit("use pnpm", "req-busy-3", "steer");
	expect((await follow((state) => state.queued.length === 1)).at(-1)!.queued[0]!.mode).toBe("steer");
	expect((await call("/api/stop", {})).status).toBe(200);
	const stopped = await follow((state) => !state.running);
	expect(stopped.at(-1)!.failure).toMatchObject({ reason: "aborted", text: "Stopped." });
});

test("a model failure is said in words, with the provider's detail", async () => {
	faux.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "400 bad request from provider" })]);
	await submit("fail please", "req-fail-1");
	const states = await follow((state) => !state.running && state.failure !== undefined, 20_000);
	expect(states.at(-1)!.failure).toMatchObject({ reason: "model_error", text: "The model call failed." });
	expect(states.at(-1)!.failure!.detail).toContain("400 bad request");
}, 30_000);

test("new chat puts a divider in the thread; earlier entries page backwards", async () => {
	faux.setResponses([fauxAssistantMessage("a1"), fauxAssistantMessage("a2")]);
	await submit("q1", "req-page-1");
	await follow(idleWith(2));
	expect((await call("/api/new", {})).status).toBe(200);
	await submit("q2", "req-page-2");
	const states = await follow((state) => !state.running && state.entries.at(-1)?.role === "assistant" && state.entries.at(-1)?.text === "a2");
	const entries = states.at(-1)!.entries;
	expect(entries.map((entry) => entry.role)).toEqual(["user", "assistant", "divider", "user", "assistant"]);
	const earlier = (await (await call(`/api/earlier?before=${entries[2]!.id}`)).json()) as { entries: { text: string }[]; more: boolean };
	expect(earlier.entries.map((entry) => entry.text)).toEqual(["q1", "a1"]);
	expect(earlier.more).toBe(false);
	expect((await call("/api/earlier?before=0")).status).toBe(400);
});

test("the model and thinking level can be changed, and a wrong value is refused in words", async () => {
	const { items } = (await (await call("/api/models")).json()) as { items: { id: string }[] };
	expect(items.length).toBeGreaterThan(0);
	expect((await call("/api/model", { model: "nope/none" })).status).toBe(400);
	expect((await call("/api/model", { model: "noslash" })).status).toBe(400);
	expect((await call("/api/model", { thinking: "enormous" })).status).toBe(400);
	expect((await call("/api/model", { model: items[0]!.id, thinking: "high" })).status).toBe(200);
	expect((await follow((state) => state.thinking === "high")).at(-1)).toMatchObject({ model: items[0]!.id, thinking: "high" });
});

test("bad input is refused with a reason", async () => {
	expect(await (await submit("   ", "req-bad-01")).json()).toEqual({ error: "Write a message first." });
	expect((await submit("hi", "short")).status).toBe(400);
	expect((await fetch(`${base}/api/submit`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{not json" })).status).toBe(400);
	expect((await fetch(`${base}/api/submit`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ text: "x".repeat(300_000), requestId: "req-big-001" }) })).status).toBe(413);
});

test("two clients see the same state, and one leaving does not disturb the other", async () => {
	faux.setResponses([fauxAssistantMessage("shared")]);
	const leaver = await call("/api/events");
	await leaver.body!.getReader().cancel();
	const watching = follow(idleWith(2));
	await submit("to both", "req-two-01");
	expect((await watching).at(-1)!.entries.at(-1)!.text).toBe("shared");
	expect((await follow(() => true))[0]!.entries.length).toBe(2); // a late joiner starts from the current snapshot
});

test("the working directory is shown and can be changed to a directory that exists", async () => {
	const first = (await follow(() => true))[0]!;
	expect(first.cwd).toBeTruthy();
	expect((await call("/api/cwd", { path: "relative/path" })).status).toBe(400);
	expect(await (await call("/api/cwd", { path: join(dir, "missing") })).json()).toEqual({ error: "That directory does not exist." });
	expect((await call("/api/cwd", { path: dir })).status).toBe(200);
	expect((await follow((state) => state.cwd === dir)).at(-1)!.cwd).toBe(dir);
});

test("an empty or cut-short token file is replaced at start, so a request with no token is still refused", async () => {
	await server.stop();
	for (const broken of ["", "short"]) {
		writeFileSync(join(dir, "token"), broken);
		const logged: string[] = [];
		const again = await serve({ core, models: createModels(), dir, port: 0, log: (line) => logged.push(line) });
		try {
			const fresh = readFileSync(join(dir, "token"), "utf8");
			expect(fresh.length).toBeGreaterThanOrEqual(32);
			expect(logged.join("\n")).toContain("the stored token was unusable and was replaced");
			const at = `http://127.0.0.1:${again.port}/api/conversations`;
			expect((await fetch(at)).status).toBe(401);
			expect((await fetch(at, { headers: { authorization: "Bearer " } })).status).toBe(401);
			expect((await fetch(at, { headers: { authorization: `Bearer ${broken}` } })).status).toBe(401);
			expect((await fetch(at, { headers: { authorization: `Bearer ${fresh}` } })).status).toBe(200);
		} finally {
			await again.stop();
		}
	}
});

test("a body far over the limit is refused, with or without the token", async () => {
	const huge = JSON.stringify({ code: "x".repeat(3 * 1024 * 1024) });
	const unpaired = await fetch(`${base}/api/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: huge });
	expect(unpaired.status).toBe(413);
	expect((await call("/api/submit", { text: "x".repeat(300 * 1024), requestId: "big-message-1" })).status).toBe(413);
	expect((await call("/api/health")).status).toBe(200); // and rho is still there
});

test("reminders are listed and removed over the API", async () => {
	expect(await (await call("/api/reminders")).json()).toEqual({ items: [] });
	const added = await core.reminders!.add({ text: "Check the build", every: "2h" });
	const { items } = (await (await call("/api/reminders")).json()) as { items: { id: string; text: string }[] };
	expect(items.map((item) => [item.id, item.text])).toEqual([[added.id, "Check the build"]]);
	expect((await call("/api/reminders/remove", { id: "nope" })).status).toBe(404);
	expect((await call("/api/reminders/remove", {})).status).toBe(404);
	expect((await call("/api/reminders/remove", { id: added.id })).status).toBe(200);
	expect(await (await call("/api/reminders")).json()).toEqual({ items: [] });
});

test("memory is read over the API with the token: the file provider's three lists, and in words when there are none to list", async () => {
	expect((await call("/api/memory", undefined, {})).status).toBe(401);
	expect((await call("/api/memory", undefined, { authorization: "Bearer wrong" })).status).toBe(401);
	expect(await (await call("/api/memory")).json()).toEqual({ provider: "file", lists: { user: [], notes: [], models: [] } });
	mkdirSync(join(dir, "memory"), { recursive: true });
	writeFileSync(join(dir, "memory", "user.md"), "# About the person\n\n- Prefers short answers\n* Lives in Lisbon\n");
	writeFileSync(join(dir, "memory", "notes.md"), `- ${"n".repeat(3_000)}\n`);
	const read = (await (await call("/api/memory")).json()) as { provider: string; lists: Record<string, string[]> };
	expect([read.provider, read.lists.user, read.lists.models]).toEqual(["file", ["Prefers short answers", "Lives in Lisbon"], []]); // a heading and a blank line are not entries
	expect(read.lists.notes!.map((entry) => entry.length)).toEqual([2_000]); // an entry is cut, never the request refused
	expect(JSON.stringify(read)).not.toContain(dir); // where the files are stays here
	expect((await call("/api/memory", {})).status).toBe(404); // read only: there is nothing to post to
	// Another provider keeps no lists on this machine; none at all is off. Both are said, not shown as empty lists.
	const reopen = async (memory: MemoryProvider | null) => {
		await server.stop();
		await core.close();
		core = await openCore({ dir, models: allModels, config: { model: `${faux.getModel().provider}/${faux.getModel().id}` }, memory });
		server = await serve({ core, models: allModels, dir, port: 0 });
		base = `http://127.0.0.1:${server.port}`;
	};
	await reopen({ label: "honcho: 127.0.0.1:8000", load: async () => undefined });
	expect(await (await call("/api/memory")).json()).toEqual({ provider: "honcho: 127.0.0.1:8000", note: "Memory is kept by honcho: 127.0.0.1:8000, not in lists on this machine, so there is nothing to list here." });
	await reopen(null);
	expect(await (await call("/api/memory")).json()).toEqual({ provider: "off", note: "Memory is off. Rho keeps nothing about you between conversations." });
});

// A real 1x1 PNG. Its bytes are what is checked, so it must be one.
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==";
const sendPhotos = (body: object) => call("/api/submit", body);

test("a photo reaches the model with its words; the stream names it and the picture is fetched apart", async () => {
	let seen: unknown;
	faux.setResponses([(asked) => ((seen = asked.messages.at(-1)), fauxAssistantMessage("A white dot."))]);
	expect((await sendPhotos({ text: "What is this?", requestId: "req-photo-1", images: [{ data: PNG }] })).status).toBe(200);
	const states = await follow(idleWith(2));
	// The model was given the picture, then the words.
	expect(seen).toMatchObject({ role: "user", content: [{ type: "image", mimeType: "image/png", data: PNG }, { type: "text", text: "What is this?" }] });
	// A client is told there is one photo. The picture is not in the stream.
	const mine = states.at(-1)!.entries[0]!;
	expect(mine).toEqual({ id: mine.id, role: "user", text: "What is this?", images: 1 });
	expect(JSON.stringify(states)).not.toContain(PNG);
	expect(await (await call(`/api/image?entry=${mine.id}&n=0`)).json()).toEqual({ mimeType: "image/png", data: PNG });
	// It is asked for with the token, and only where there is one.
	expect((await call(`/api/image?entry=${mine.id}&n=0`, undefined, {})).status).toBe(401);
	expect((await call(`/api/image?entry=${mine.id}&n=1`)).status).toBe(404);
	expect((await call(`/api/image?entry=${states.at(-1)!.entries[1]!.id}&n=0`)).status).toBe(404); // the answer has none
	expect((await call("/api/image?entry=nope")).status).toBe(400);
});

test("a photo may go without words, and names the conversation", async () => {
	let seen: unknown;
	faux.setResponses([(asked) => ((seen = asked.messages.at(-1)), fauxAssistantMessage("A dot."))]);
	expect((await sendPhotos({ requestId: "req-photo-2", images: [{ data: PNG }, { data: PNG }] })).status).toBe(200);
	const states = await follow(idleWith(2));
	expect(seen).toMatchObject({ content: [{ type: "image" }, { type: "image" }] });
	expect(states.at(-1)!.entries[0]).toMatchObject({ role: "user", text: "", images: 2 });
	expect(((await (await call("/api/conversations")).json()) as { items: { title: string }[] }).items[0]!.title).toBe("Photo");
});

test("what is not a photo is refused in words, and nothing is put in the thread", async () => {
	const refused = async (body: object) => {
		const response = await sendPhotos({ requestId: `req-bad-photo-${Math.random()}`, text: "look", ...body });
		return [response.status, ((await response.json()) as { error: string }).error];
	};
	const text = Buffer.from("<svg onload=alert(1)>").toString("base64");
	expect(await refused({ images: [{ data: text }] })).toEqual([400, "That photo is not a JPEG, PNG, GIF or WebP picture."]);
	expect(await refused({ images: [{ data: PNG }, { data: text }] })).toEqual([400, "Photo 2 is not a JPEG, PNG, GIF or WebP picture."]);
	expect(await refused({ images: [{ data: "not base64!" }] })).toEqual([400, "That photo did not arrive whole. Try it again."]);
	expect(await refused({ images: [{ mimeType: "image/png" }] })).toEqual([400, "That photo did not arrive whole. Try it again."]);
	expect(await refused({ images: [] })).toEqual([400, "Send one to 4 photos with a message."]);
	expect(await refused({ images: Array.from({ length: 5 }, () => ({ data: PNG })) })).toEqual([400, "Send one to 4 photos with a message."]);
	expect(await refused({ images: "photo" })).toEqual([400, "Send one to 4 photos with a message."]);
	// A PNG too large to go as it is, where nothing can scale it (this server was given no processor).
	const big = Buffer.concat([Buffer.from(PNG, "base64"), Buffer.alloc(4 * 1024 * 1024)]).toString("base64");
	expect(await refused({ images: [{ data: big }] })).toEqual([400, "That photo is too large to send as it is, and this rho cannot make pictures smaller."]);
	// A gate's report carries no photo, and words are still needed without one.
	expect((await sendPhotos({ requestId: "req-bad-photo-from", from: "gate", images: [{ data: PNG }] })).status).toBe(400);
	expect((await sendPhotos({ requestId: "req-bad-photo-none" })).status).toBe(400);
	// Far too much is refused before it is read; words alone keep their own small limit.
	expect((await sendPhotos({ requestId: "req-bad-photo-huge", images: [{ data: "A".repeat(30 * 1024 * 1024) }] })).status).toBe(413);
	expect((await sendPhotos({ requestId: "req-bad-photo-words", text: "x".repeat(300 * 1024), images: [{ data: PNG }] })).status).toBe(413);
	expect((await follow(() => true))[0]!.entries).toEqual([]);
}, 20_000);

test("a large photo is scaled by the processor, and one it cannot read is refused; a model without sight says so", async () => {
	await server.stop();
	const asked: [number, string][] = [];
	const images = { prepare: async (bytes: Uint8Array, mimeType: string) => (asked.push([bytes.length, mimeType]), bytes.length > 1000 ? undefined : { data: "c21hbGxlcg==", mimeType: "image/jpeg" }) };
	const blind = fauxProvider({ provider: "blind", models: [{ id: "words-only", input: ["text"] }] });
	const models = createModels();
	models.setProvider(faux.provider);
	models.setProvider(blind.provider);
	server = await serve({ core, models, dir, port: 0, images });
	base = `http://127.0.0.1:${server.port}`;
	let seen: unknown;
	faux.setResponses([(context) => ((seen = context.messages.at(-1)), fauxAssistantMessage("Seen."))]);
	expect((await sendPhotos({ text: "and this", requestId: "req-scaled-1", images: [{ data: PNG }] })).status).toBe(200);
	await follow(idleWith(2));
	expect(asked).toEqual([[Buffer.from(PNG, "base64").length, "image/png"]]); // the type is the bytes' own
	expect(seen).toMatchObject({ content: [{ type: "image", data: "c21hbGxlcg==", mimeType: "image/jpeg" }, { type: "text", text: "and this" }] });
	const broken = Buffer.concat([Buffer.from(PNG, "base64"), Buffer.alloc(2000)]).toString("base64");
	expect(await (await sendPhotos({ requestId: "req-scaled-2", images: [{ data: broken }] })).json()).toEqual({ error: "That photo could not be read as a picture." });
	// A model that takes only words: said before the photo is in the thread.
	expect((await call("/api/model", { model: "blind/words-only" })).status).toBe(200);
	expect(await (await sendPhotos({ text: "look", requestId: "req-scaled-3", images: [{ data: PNG }] })).json()).toEqual({ error: "This conversation's model does not take photos. Choose another model in Details, under Settings." });
	expect((await sendPhotos({ text: "words are fine", requestId: "req-scaled-4" })).status).toBe(200);
});

test("the page can be installed as an app: a manifest and icons are served without the token", async () => {
	const page = await (await fetch(`${base}/`)).text();
	expect(page).toContain('<link rel="manifest" href="/manifest.webmanifest">');
	const response = await fetch(`${base}/manifest.webmanifest`);
	expect([response.status, response.headers.get("content-type")]).toEqual([200, "application/manifest+json"]);
	const manifest = (await response.json()) as { name: string; start_url: string; display: string; icons: { src: string; sizes: string; type: string; purpose: string }[] };
	expect([manifest.name, manifest.start_url, manifest.display]).toEqual(["rho", "/", "standalone"]);
	// What a browser asks for before it offers an install: a 192 and a 512 pixel PNG.
	expect(manifest.icons.map((icon) => icon.sizes).sort()).toEqual(["192x192", "512x512", "512x512"]);
	expect(manifest.icons.some((icon) => icon.purpose === "maskable")).toBe(true);
	for (const icon of manifest.icons) {
		const image = await fetch(`${base}${icon.src}`);
		expect([icon.src, image.status, image.headers.get("content-type")]).toEqual([icon.src, 200, "image/png"]);
		const bytes = new Uint8Array(await image.arrayBuffer());
		expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		const size = new DataView(bytes.buffer).getUint32(16); // the width in the PNG's header
		expect(`${size}x${size}`).toBe(icon.sizes);
	}
});

test("a photo that needs no scaling has its metadata taken off before it is stored; its picture is untouched", async () => {
	const { stripMetadata } = await import("../src/photos.ts");
	// A JPEG as a camera writes it: start, an Exif segment with a place in it, a comment, a quantization table, the picture.
	const segment = (marker: number, body: Buffer) => Buffer.concat([Buffer.from([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff]), body]);
	const exif = segment(0xe1, Buffer.from("Exif\0\0MM\0*GPSLatitude 52.37 home"));
	const xmp = segment(0xe1, Buffer.from("http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>owner@example.com</x:xmpmeta>"));
	const comment = segment(0xfe, Buffer.from("taken at home"));
	const table = segment(0xdb, Buffer.alloc(65, 1));
	const picture = Buffer.concat([Buffer.from([0xff, 0xda, 0, 2]), Buffer.from("PIXELS-AND-AN-FF-00-INSIDE"), Buffer.from([0xff, 0x00, 0xff, 0xd9])]);
	const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), exif, table, xmp, comment, picture]);
	const clean = Buffer.from(stripMetadata(jpeg, "image/jpeg"));
	expect(clean.equals(Buffer.concat([Buffer.from([0xff, 0xd8]), table, picture]))).toBe(true); // only the three segments are gone
	for (const secret of ["GPSLatitude", "owner@example.com", "taken at home"]) expect(clean.includes(secret)).toBe(false);
	// A PNG: its text and time chunks go, its picture chunks stay byte for byte.
	const png = Buffer.from(PNG, "base64");
	const chunk = (name: string, body: Buffer) => Buffer.concat([Buffer.from([0, 0, 0, body.length]), Buffer.from(name), body, Buffer.alloc(4)]);
	const tagged = Buffer.concat([png.subarray(0, 33), chunk("tEXt", Buffer.from("Author\0Sam at home")), chunk("eXIf", Buffer.from("MM\0*GPS")), chunk("tIME", Buffer.alloc(7)), png.subarray(33)]);
	expect(Buffer.from(stripMetadata(tagged, "image/png")).equals(png)).toBe(true);
	expect(Buffer.from(stripMetadata(png, "image/png")).equals(png)).toBe(true); // nothing to take off: the same bytes
	// A WebP: the Exif and XMP chunks go, the header's flags for them are cleared, and the size is right again.
	const riff = (chunks: Buffer[]) => { const body = Buffer.concat(chunks); const head = Buffer.from("RIFF\0\0\0\0WEBP"); head.writeUInt32LE(body.length + 4, 4); return Buffer.concat([head, body]); };
	const part = (name: string, body: Buffer) => { const size = Buffer.alloc(4); size.writeUInt32LE(body.length); return Buffer.concat([Buffer.from(name), size, body, Buffer.alloc(body.length & 1)]); };
	const webp = riff([part("VP8X", Buffer.from([0x0c, 0, 0, 0, 0, 0, 0, 0, 0, 0])), part("VP8 ", Buffer.from("pixels")), part("EXIF", Buffer.from("GPS home!")), part("XMP ", Buffer.from("<x>me</x>"))]);
	const bare = Buffer.from(stripMetadata(webp, "image/webp"));
	expect(bare.equals(riff([part("VP8X", Buffer.from([0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0])), part("VP8 ", Buffer.from("pixels"))]))).toBe(true);
	// A file that is not what it says, a file cut short, and a GIF come back as they are.
	for (const [bytes, type] of [[Buffer.from("not a jpeg at all"), "image/jpeg"], [jpeg.subarray(0, 20), "image/jpeg"], [tagged.subarray(0, 50), "image/png"], [Buffer.from("GIF89a...."), "image/gif"]] as const) expect(Buffer.from(stripMetadata(bytes, type)).equals(bytes)).toBe(true);

	// Through rho: with a processor that passes a small photo through, what is stored has no metadata.
	await server.stop();
	const models = createModels();
	models.setProvider(faux.provider);
	const passThrough = { prepare: async (bytes: Uint8Array, mimeType: string) => ({ data: Buffer.from(bytes).toString("base64"), mimeType }) };
	server = await serve({ core, models, dir, port: 0, images: passThrough });
	base = `http://127.0.0.1:${server.port}`;
	faux.setResponses([fauxAssistantMessage("Seen.")]);
	expect((await sendPhotos({ requestId: "req-exif-1", images: [{ data: tagged.toString("base64") }] })).status).toBe(200);
	const states = await follow(idleWith(2));
	const stored = (await (await call(`/api/image?entry=${states.at(-1)!.entries[0]!.id}&n=0`)).json()) as { data: string };
	expect(stored.data).toBe(PNG);
	// With no processor a photo is stored as it came: nothing here could turn one whose metadata says it is rotated.
	await server.stop();
	server = await serve({ core, models, dir, port: 0 });
	base = `http://127.0.0.1:${server.port}`;
	faux.setResponses([fauxAssistantMessage("Seen.")]);
	expect((await sendPhotos({ requestId: "req-exif-2", images: [{ data: tagged.toString("base64") }] })).status).toBe(200);
	const later = await follow(idleWith(4));
	const kept = (await (await call(`/api/image?entry=${later.at(-1)!.entries.findLast((entry) => entry.role === "user")!.id}&n=0`)).json()) as { data: string };
	expect(kept.data).toBe(tagged.toString("base64"));
}, 30_000);
