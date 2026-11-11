import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { obj, str } from "@earendil-works/pi-schema";
import { CLAUDE_CODE, claudeCodeProvider, claudeStatus } from "../src/claude/provider.ts";
import { closeWarmProcesses, normalizeSchema, planTurn, relayFetch, restoreBlocks, restoreRequest, sweepStale, warmProcessCount, type Frame } from "../src/claude/relay.ts";

// No model is called here: a fake CLI (test/fixtures/fake-claude.ts) and a fake Anthropic.
const command = [process.execPath, join(import.meta.dir, "fixtures", "fake-claude.ts")];
const dir = mkdtempSync(join(tmpdir(), "rho-claude-test-"));
const out = join(dir, "cli.json");
const cliSaw = () => JSON.parse(readFileSync(out, "utf8")) as { pid: number; args: string[]; requests: number; second?: number; cwd: string; sawApiKey: string | null };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

interface Seen { body: any; headers: Headers; path: string; cancelled: boolean }
const seen: Seen[] = [];
let reply: (seen: Seen) => Response;
const enc = new TextEncoder();
const sse = (event: string, data: object) => enc.encode(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
function answer(blocks: object[], stop: string, options: { slow?: boolean } = {}) {
	return (entry: Seen) => {
		let timer: ReturnType<typeof setInterval> | undefined;
		const body = new ReadableStream<Uint8Array>({
			start(c) {
				c.enqueue(sse("message_start", { message: { id: "msg_1", type: "message", role: "assistant", model: entry.body.model, content: [], stop_reason: null, usage: { input_tokens: 7, output_tokens: 0 } } }));
				if (options.slow) return void (timer = setInterval(() => c.enqueue(sse("ping", {})), 20));
				blocks.forEach((block: any, index) => {
					if (block.type === "text") {
						c.enqueue(sse("content_block_start", { index, content_block: { type: "text", text: "" } }));
						c.enqueue(sse("content_block_delta", { index, delta: { type: "text_delta", text: block.text } }));
					} else {
						c.enqueue(sse("content_block_start", { index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } }));
						c.enqueue(sse("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } }));
					}
					c.enqueue(sse("content_block_stop", { index }));
				});
				c.enqueue(sse("message_delta", { delta: { stop_reason: stop }, usage: { output_tokens: 3 } }));
				c.enqueue(sse("message_stop", {}));
				c.close();
			},
			cancel() { clearInterval(timer); entry.cancelled = true; },
		});
		return new Response(body, { headers: { "content-type": "text/event-stream" } });
	};
}
let upstream: ReturnType<typeof Bun.serve>;
beforeAll(() => {
	upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(request) {
		const entry: Seen = { body: await request.json(), headers: request.headers, path: new URL(request.url).pathname + new URL(request.url).search, cancelled: false };
		seen.push(entry);
		return reply(entry);
	} });
});
afterEach(() => closeWarmProcesses());
afterAll(() => { void upstream.stop(true); rmSync(dir, { recursive: true, force: true }); });
const options = (mode = "normal", extra: object = {}) => ({ command, upstream: `http://127.0.0.1:${upstream.port}`, env: { FAKE_CLAUDE: mode, FAKE_CLAUDE_OUT: out, ANTHROPIC_API_KEY: "must-not-reach-the-cli" }, startTimeoutMs: 8_000, ...extra });
const text = (value: string) => ({ type: "text", text: value });
const request = (messages: object[], extra: object = {}) => ({ model: "claude-haiku-5-5", max_tokens: 100, stream: true, system: [{ type: "text", text: "Rho system prompt.", cache_control: { type: "ephemeral" } }], messages,
	tools: [{ name: "read", description: "Read a file.", input_schema: { type: "object", properties: { path: { type: "string" } } } }, { name: "__pi_deferred_placeholder__", defer_loading: true, input_schema: {} }], thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "high" }, ...extra });
const post = (body: object, mode = "normal", extra: object = {}, sessionId?: string, signal?: AbortSignal) => relayFetch(options(mode, extra), { sessionId })("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": "placeholder" }, body: JSON.stringify(body), signal });
const flat = (value: unknown) => JSON.stringify(value);
const users = (body: any) => body.messages.filter((message: any) => message.role === "user");
const sayHello = () => (reply = answer([text("hello")], "end_turn"));

test("a message steered in after a tool result is one user message with it, as Claude Code sends it", () => {
	// pi-durable gives the tool result and the steered message as two user messages in a row.
	const plan = planTurn(request([
		{ role: "user", content: [text("run it")] },
		{ role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "read", input: { path: "/x" } }] },
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [text("file text")] }] },
		{ role: "user", content: [text("and also this")] },
	]));
	expect(plan.frames.map((frame) => frame.type)).toEqual(["user", "assistant", "user"]);
	expect(plan.frames[2]!.message.content.map((block) => block.type)).toEqual(["tool_result", "text"]);
	// Claude Code's request then has as many user messages as rho's plan, and each is restored to rho's.
	const theirs = { system: [], messages: [
		{ role: "user", content: [text("run it")] },
		{ role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "mcp__rho__read", input: { path: "/x" } }] },
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [text("file text")] }, text("<system-reminder>the CLI's own</system-reminder>"), text("and also this")] },
	] };
	const restored = restoreRequest(theirs, plan.frames) as { messages: { role: string; content: { type: string; text?: string }[] }[] };
	expect(restored.messages.length).toBe(3);
	expect(restored.messages[2]!.content.map((block) => block.type)).toEqual(["tool_result", "text"]);
	expect(restored.messages[2]!.content[1]!.text).toBe("and also this");
	// When the two do not line up, the error says how.
	expect(() => restoreRequest({ system: [], messages: theirs.messages.slice(0, 1) }, plan.frames)).toThrow(/Rho has 2 user messages and Claude Code sent 1/);
});

test("a request is planned as the CLI's inputs: prompt, inventory, history frames, fixed fields", () => {
	const plan = planTurn(request([
		{ role: "user", content: [{ type: "text", text: "q1", cache_control: { type: "ephemeral" } }] },
		{ role: "assistant", content: [{ type: "thinking", thinking: "t", signature: "sig" }, { type: "tool_use", id: "toolu_1", name: "read", input: { path: "/x" } }] },
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [text("file text")] }] },
	]));
	expect(plan.system).toBe("Rho system prompt.");
	expect(plan.tools).toEqual([{ name: "read", description: "Read a file.", inputSchema: { type: "object", properties: { path: { type: "string" } } } }]); // the deferred placeholder is left out
	expect(plan.frames.map((frame) => [frame.type, frame.shouldQuery])).toEqual([["user", false], ["assistant", undefined], ["user", undefined]]);
	expect(plan.frames[0]!.message.content).toEqual([text("q1")]); // no cache marks: the CLI sets its own
	expect(plan.frames[1]!.message.content[0]).toEqual({ type: "thinking", thinking: "t", signature: "sig" }); // signed thinking goes back untouched
	expect(plan.frames[1]!.message.content[1]!.name).toBe("mcp__rho__read");
	expect(plan.extraBody).toEqual({ thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "high" }, max_tokens: 100 });
	expect(() => planTurn(request([{ role: "user", content: "q" }, { role: "assistant", content: "a" }]))).toThrow(/must end in a user message/);
	expect(() => planTurn(request([{ role: "user", content: "q" }], { tools: [{ name: "bad name!" }] }))).toThrow(/Tool names/);
});

test("tool schemas are simplified the way the CLI accepts them", () => {
	expect(normalizeSchema({ type: "object", properties: { a: { type: ["string", "null"] }, b: { anyOf: [{ type: "number" }, { type: "null" }] } }, oneOf: [{}] })).toEqual({ type: "object", properties: { a: { type: "string" }, b: { type: "number" } } });
	expect(normalizeSchema(undefined)).toEqual({ type: "object", properties: {} });
});

test("user messages are restored to rho's: reminders dropped, the CLI's cache mark and image copies kept", () => {
	const reminder = text("<system-reminder>The user's email address is person@example.com</system-reminder>");
	expect(restoreBlocks([reminder, text("hello")], [text("hello")])).toEqual([text("hello")]);
	// A message that itself quotes a reminder keeps it; the CLI's extra one still goes.
	const quoted = text("<system-reminder>quoted by the person</system-reminder>");
	expect(restoreBlocks([quoted, reminder, text("why?")], [quoted, text("why?")])).toEqual([quoted, text("why?")]);
	expect(restoreBlocks([{ type: "tool_result", tool_use_id: "t1", content: [text("out"), reminder] }], [{ type: "tool_result", tool_use_id: "t1", content: [text("out")] }])).toEqual([{ type: "tool_result", tool_use_id: "t1", content: [text("out")] }]);
	const scaled = { type: "image", source: { data: "scaled" } };
	const note = text("[Image: original 4000x3000, displayed at 2000x1500]");
	expect(restoreBlocks([scaled, note, reminder], [{ type: "image", source: { data: "original" } }])).toEqual([scaled, note]);
	expect(() => restoreBlocks([text("only this")], [text("a"), text("b")])).toThrow(/does not line up/);
	const frames: Frame[] = [{ type: "user", message: { role: "user", content: [text("hello")] } }];
	const restored = restoreRequest({ model: "m", system: "kept", messages: [{ role: "user", content: [reminder, { ...text("hello"), cache_control: { type: "ephemeral" } }] }, { role: "system", content: [text("# Environment")] }] }, frames) as any;
	expect(restored.messages).toEqual([{ role: "user", content: [{ ...text("hello"), cache_control: { type: "ephemeral" } }] }, { role: "system", content: [text("# Environment")] }]);
	expect(restored.system).toBe("kept");
	expect(() => restoreRequest({ messages: [{ role: "user", content: "a" }, { role: "user", content: "b" }] }, frames)).toThrow(/does not line up/);
});

test("what reaches upstream is the CLI's own request, with rho's conversation and no reminders", async () => {
	seen.length = 0;
	sayHello();
	const response = await post(request([{ role: "user", content: [text("the real question")] }]));
	expect(response.status).toBe(200);
	expect(await response.text()).toContain("hello");
	expect(seen.length).toBe(1);
	const sent = seen[0]!;
	// The CLI's: its login and identity headers, its system lines, its environment message, its tool format.
	expect(sent.headers.get("authorization")).toBe("Bearer cli-login-token");
	expect(sent.headers.get("user-agent")).toBe("claude-cli/test");
	expect(sent.headers.get("x-app")).toBe("cli");
	expect(sent.headers.get("x-api-key")).toBeNull();
	expect(sent.path).toBe("/v1/messages?beta=true");
	expect(sent.body.system.map((b: any) => b.text)).toEqual(["x-anthropic-billing-header: cc_version=test;", "You are a Claude agent.", "Rho system prompt."]);
	expect(sent.body.metadata).toEqual({ user_id: "cli-user" });
	expect(sent.body.tools.map((tool: any) => tool.name)).toEqual(["mcp__rho__read"]);
	expect(sent.body.messages[1].role).toBe("system");
	expect(sent.body.messages[1].content[0].text).toContain("# Environment");
	// Rho's: the conversation, thinking, effort and output limit.
	expect(users(sent.body)).toEqual([{ role: "user", content: [{ ...text("the real question"), cache_control: { type: "ephemeral" } }] }]);
	expect(sent.body.thinking).toEqual({ type: "adaptive", display: "summarized" });
	expect(sent.body.output_config).toEqual({ effort: "high" });
	expect(sent.body.max_tokens).toBe(100);
	expect(flat(sent.body)).not.toContain("person@example.com");
	expect(flat(sent.body)).not.toContain("system-reminder");
	const cli = cliSaw();
	expect(cli.sawApiKey).toBeNull(); // an API key in rho's environment must not change who pays
	expect(cli.args[cli.args.indexOf("--tools") + 1]).toBe(""); // the CLI has no tools of its own
	expect(cli.args).toContain("--no-session-persistence");
	expect(cli.args).not.toContain("--effort"); // effort goes in the request body, as pi does it
});

test("history is replayed, a tool result keeps its text without the CLI's reminder, tool names lose the prefix", async () => {
	seen.length = 0;
	reply = answer([{ type: "tool_use", id: "toolu_2", name: "mcp__rho__read", input: { path: "/b" } }], "tool_use");
	const response = await post(request([
		{ role: "user", content: [text("read /a")] },
		{ role: "assistant", content: [{ type: "thinking", thinking: "", signature: "sig-1" }, { type: "tool_use", id: "toolu_1", name: "read", input: { path: "/a" } }] },
		{ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: [text("contents of a")] }] },
	]));
	const body = await response.text();
	expect(body).toContain('"name":"read"');
	expect(body).not.toContain("mcp__rho__");
	const sent = seen[0]!.body;
	expect(sent.messages.map((m: any) => m.role)).toEqual(["user", "system", "assistant", "user", "system"]);
	expect(sent.messages[2].content).toEqual([{ type: "thinking", thinking: "", signature: "sig-1" }, { type: "tool_use", id: "toolu_1", name: "mcp__rho__read", input: { path: "/a" } }]);
	expect(sent.messages[3].content).toEqual([{ type: "tool_result", tool_use_id: "toolu_1", content: [text("contents of a")], cache_control: { type: "ephemeral" } }]);
	expect(flat(sent)).not.toContain("person@example.com");
});

test("a second request from the CLI is refused: one model request per turn", async () => {
	seen.length = 0;
	sayHello();
	const response = await post(request([{ role: "user", content: [text("q")] }]), "second-request");
	await response.text();
	await Bun.sleep(200);
	expect(seen.length).toBe(1);
	expect(cliSaw().second).toBe(400);
});

test("a plain conversation reuses one CLI process, and its environment message keeps its place", async () => {
	seen.length = 0;
	sayHello();
	const q1 = { role: "user", content: [text("first question")] };
	const a = { role: "assistant", content: [text("hello")] };
	await (await post(request([q1]), "normal", {}, "conv-1")).text();
	const first = cliSaw().pid;
	expect(warmProcessCount()).toBe(1);
	await (await post(request([q1, a, { role: "user", content: [text("second question")] }]), "normal", {}, "conv-1")).text();
	expect(cliSaw().pid).toBe(first); // the same process answered
	expect(cliSaw().requests).toBe(2);
	const q3 = [q1, a, { role: "user", content: [text("second question")] }, a, { role: "user", content: [text("third question")] }];
	await (await post(request(q3), "normal", {}, "conv-1")).text();
	expect(cliSaw().pid).toBe(first);
	const third = seen[2]!.body;
	// The environment message is the first turn's (with its date), in its first place, and not repeated at the tail.
	expect(third.messages.map((m: any) => m.role)).toEqual(["user", "system", "assistant", "user", "assistant", "user"]);
	expect(third.messages[1].content[0].text).toBe(seen[0]!.body.messages[1].content[0].text);
	expect(flat(third.messages[1])).not.toContain("cache_control"); // its cache mark moved to the previous question
	expect(third.messages[3].content.at(-1).cache_control).toEqual({ type: "ephemeral" });
	expect(third.messages[5].content.at(-1).cache_control).toEqual({ type: "ephemeral" });
	// An edited history is not a continuation: a new process replays it.
	await (await post(request([{ role: "user", content: [text("a different start")] }, a, { role: "user", content: [text("next")] }]), "normal", {}, "conv-1")).text();
	expect(cliSaw().pid).not.toBe(first);
	await Bun.sleep(100);
	expect(alive(first)).toBe(false);
});

test("a tool round is never continued in the same process", async () => {
	reply = answer([{ type: "tool_use", id: "toolu_1", name: "mcp__rho__read", input: {} }], "tool_use");
	await (await post(request([{ role: "user", content: [text("q")] }]), "normal", {}, "conv-2")).text();
	const pid = cliSaw().pid;
	await Bun.sleep(150);
	expect(warmProcessCount()).toBe(0);
	expect(alive(pid)).toBe(false);
});

test("without a conversation id nothing is kept, and the CLI does not outlive its turn", async () => {
	sayHello();
	await (await post(request([{ role: "user", content: [text("q")] }]))).text();
	const pid = cliSaw().pid;
	await Bun.sleep(150);
	expect(warmProcessCount()).toBe(0);
	expect(alive(pid)).toBe(false);
});

test("a turn Claude Code reports as charged to usage credits fails, unless allowed", async () => {
	sayHello();
	const stopped = await post(request([{ role: "user", content: [text("q")] }]), "overage");
	await expect(stopped.text()).rejects.toThrow(/Claude Code billing.*usage credits/);
	const allowed = await post(request([{ role: "user", content: [text("q")] }]), "overage", { allowUsageCredits: true });
	expect(await allowed.text()).toContain("hello");
});

test("Anthropic refusing the plan for a request is a billing error that names it", async () => {
	reply = () => Response.json({ type: "error", error: { type: "invalid_request_error", message: "Third-party apps now draw from your extra usage, not your plan limits." } }, { status: 400 });
	await expect(post(request([{ role: "user", content: [text("q")] }]))).rejects.toThrow(/Claude Code billing.*will not retry/);
});

test("an ordinary upstream error comes back as it is", async () => {
	reply = () => Response.json({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, { status: 529 });
	const response = await post(request([{ role: "user", content: [text("q")] }]));
	expect(response.status).toBe(529);
	expect(await response.text()).toContain("Overloaded");
});

test("a CLI that exits before asking, or rejects the history, is an error that says why", async () => {
	await expect(post(request([{ role: "user", content: [text("q")] }]), "exit-early")).rejects.toThrow(/exited \(3\) before sending a request.*not logged in/s);
	await expect(post(request([{ role: "user", content: [text("q1")] }, { role: "assistant", content: [text("a")] }, { role: "user", content: [text("q2")] }]), "reject-history")).rejects.toThrow(/rejected the conversation history/);
});

test("cancel ends the upstream request and the CLI process", async () => {
	seen.length = 0;
	reply = answer([], "end_turn", { slow: true });
	const abort = new AbortController();
	const response = await post(request([{ role: "user", content: [text("q")] }]), "normal", {}, "conv-3", abort.signal);
	const reader = response.body!.getReader();
	await reader.read();
	abort.abort();
	await reader.read().catch(() => undefined);
	await Bun.sleep(250);
	expect(seen[0]!.cancelled).toBe(true);
	expect(alive(cliSaw().pid)).toBe(false);
	expect(warmProcessCount()).toBe(0);
});

test("the CLI runs in the directory rho names, so the model is told the real one", async () => {
	sayHello();
	await (await post(request([{ role: "user", content: [text("q")] }]), "normal", { cwd: dir })).text();
	expect(cliSaw().cwd).toBe(dir);
});

test("turn directories left by a killed rho are cleared at the next start, and fresh ones are left alone", () => {
	const root = mkdtempSync(join(tmpdir(), "rho-sweep-test-"));
	for (const name of ["rho-claude-AAAAAA", "rho-claude-BBBBBB", "rho-claude-test-CCCCCC", "other"]) mkdirSync(join(root, name));
	const old = new Date(Date.now() - 3_600_000);
	utimesSync(join(root, "rho-claude-AAAAAA"), old, old);
	utimesSync(join(root, "other"), old, old);
	expect(sweepStale(600_000, root)).toBe(1);
	expect(readdirSync(root).sort()).toEqual(["other", "rho-claude-BBBBBB", "rho-claude-test-CCCCCC"]);
	rmSync(root, { recursive: true, force: true });
});

test("status reads the CLI's login without a model request", async () => {
	expect(await claudeStatus(options())).toEqual({ available: true, loggedIn: true, plan: "max" });
	expect((await claudeStatus(options("logged-out"))).loggedIn).toBe(false);
	expect((await claudeStatus({ command: "/nonexistent/claude" })).available).toBe(false);
});

test("the model list is what the CLI offers this login, and each is selected by the CLI's own name", async () => {
	const models = createModels();
	models.setProvider(claudeCodeProvider(options()));
	const before = (await models.getAvailable()).filter((model) => model.provider === CLAUDE_CODE).map((model) => model.id);
	expect(before).toContain("claude-sonnet-5-5"); // not yet asked: everything pi-ai knows
	await models.refresh({ providers: [CLAUDE_CODE] });
	const listed = (await models.getAvailable()).filter((model) => model.provider === CLAUDE_CODE);
	expect(listed.map((model) => model.id).sort()).toEqual(["claude-haiku-5-5", "claude-opus-5-5"]); // an unknown model is left out
	expect(listed[0]!.contextWindow).toBeGreaterThan(0);
	seen.length = 0;
	sayHello();
	await models.streamSimple(models.getModel(CLAUDE_CODE, "claude-opus-5-5")!, { systemPrompt: "s", messages: [{ role: "user", content: "q", timestamp: 1 }] }).result();
	expect(cliSaw().args[cliSaw().args.indexOf("--model") + 1]).toBe("opus");
	expect(seen[0]!.body.model).toBe("opus");
});

test("through pi-ai: text and a tool request come back as pi messages, and a second turn continues warm", async () => {
	const models = createModels();
	models.setProvider(claudeCodeProvider(options()));
	const model = models.getModel(CLAUDE_CODE, "claude-sonnet-5-5")!;
	const tools = [{ name: "read", description: "Read a file.", parameters: obj({ path: str() }) }];
	seen.length = 0;
	reply = answer([text("Reading it."), { type: "tool_use", id: "toolu_1", name: "mcp__rho__read", input: { path: "/etc/hostname" } }], "tool_use");
	const first = { role: "user" as const, content: "read it", timestamp: 1 };
	const message = await models.streamSimple(model, { systemPrompt: "Rho system prompt.", tools, messages: [first] }, { reasoning: "medium", sessionId: "conv-4" }).result();
	expect(message.stopReason).toBe("toolUse");
	expect(message.provider).toBe(CLAUDE_CODE);
	expect(message.content).toMatchObject([{ type: "text", text: "Reading it." }, { type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "/etc/hostname" } }]);
	expect(seen[0]!.body.system.at(-1).text).toContain("Rho system prompt.");
	expect(seen[0]!.body.output_config).toEqual({ effort: "medium" });
	expect(seen[0]!.body.messages.every((m: any) => m.role !== "system" || flat(m).includes("# Environment"))).toBe(true); // no effort or tool messages of pi-ai's inside the conversation
	sayHello();
	const result = { role: "toolResult" as const, toolCallId: "toolu_1", toolName: "read", content: [{ type: "text" as const, text: "host-1" }], isError: false, timestamp: 2 };
	const second = await models.streamSimple(model, { systemPrompt: "Rho system prompt.", tools, messages: [first, message, result] }, { reasoning: "medium", sessionId: "conv-4" }).result();
	expect(second.stopReason).toBe("stop");
	expect(seen[1]!.body.messages.find((m: any) => m.role === "assistant").content.at(-1)).toMatchObject({ type: "tool_use", id: "toolu_1", name: "mcp__rho__read" });
	expect(flat(users(seen[1]!.body)[1])).toContain("host-1");
});
