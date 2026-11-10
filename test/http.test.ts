import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { openCore, type Core } from "../src/core.ts";
import { serve, type Server } from "../src/http.ts";
import type { StateView } from "../src/view.ts";

// A real core and a real HTTP server on a free port, with a scripted model. No model is called.
let dir: string;
let core: Core;
let server: Server;
let faux: ReturnType<typeof fauxProvider>;
let base: string;
let token: string;
let gate: { release(): void; started: Promise<void> };

beforeEach(async () => {
	dir = mkdtempSync(join(tmpdir(), "rho-http-test-"));
	faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
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
	for (const path of ["/api/health", "/api/events", "/api/models", "/api/reminders", "/api/earlier?before=5"]) expect((await call(path, undefined, {})).status).toBe(401);
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
