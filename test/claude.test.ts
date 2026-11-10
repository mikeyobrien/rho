import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { obj, str } from "@earendil-works/pi-schema";
import { CLAUDE_CODE, claudeCodeProvider, claudeStatus } from "../src/claude/provider.ts";
import { chargedToCredits, mergeRequest, relayFetch } from "../src/claude/relay.ts";

// No model is called here: a fake CLI (test/fixtures/fake-claude.ts) and a fake Anthropic.
const command = [process.execPath, join(import.meta.dir, "fixtures", "fake-claude.ts")];
const dir = mkdtempSync(join(tmpdir(), "rho-claude-test-"));
const out = join(dir, "cli.json");
const cliSaw = () => JSON.parse(readFileSync(out, "utf8")) as { pid: number; args: string[]; other: number; sawApiKey: string | null };
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

interface Seen { body: any; headers: Headers; path: string; cancelled: boolean }
const seen: Seen[] = [];
let reply: (seen: Seen) => Response;
const enc = new TextEncoder();
const sse = (event: string, data: object) => enc.encode(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
function answer(blocks: object[], stop: string, options: { headers?: Record<string, string>; slow?: boolean } = {}) {
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
		return new Response(body, { headers: { "content-type": "text/event-stream", ...options.headers } });
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
afterAll(() => { void upstream.stop(true); rmSync(dir, { recursive: true, force: true }); });
const options = (mode = "normal", extra: object = {}) => ({ command, upstream: `http://127.0.0.1:${upstream.port}`, env: { FAKE_CLAUDE: mode, FAKE_CLAUDE_OUT: out, ANTHROPIC_API_KEY: "must-not-reach-the-cli" }, startTimeoutMs: 8_000, ...extra });
const ours = { model: "claude-haiku-5-5", max_tokens: 100, stream: true, system: [{ type: "text", text: "Rho system prompt.", cache_control: { type: "ephemeral" } }], messages: [{ role: "user", content: [{ type: "text", text: "the real question" }] }], tools: [{ name: "read" }] };
const post = (fetchImpl: typeof fetch, signal?: AbortSignal) => fetchImpl("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "content-type": "application/json", "x-api-key": "placeholder", "anthropic-beta": "rho-beta" }, body: JSON.stringify(ours), signal });

test("the merged request is rho's, with only the CLI's leading system lines and its metadata", () => {
	const merged = mergeRequest(ours, { system: [{ type: "text", text: "billing" }, { type: "text", text: "identity", cache_control: { type: "ephemeral" } }, { type: "text", text: "rho-relay-placeholder" }, { type: "text", text: "after" }], messages: [{ role: "user", content: "cli" }], metadata: { user_id: "u" }, max_tokens: 1 }) as any;
	expect(merged.system.map((b: any) => b.text)).toEqual(["billing", "identity", "Rho system prompt."]);
	expect(merged.system[1].cache_control).toBeUndefined();
	expect(merged.system[2].cache_control).toEqual({ type: "ephemeral" });
	expect(merged.messages).toEqual(ours.messages);
	expect(merged.max_tokens).toBe(100);
	expect(merged.metadata).toEqual({ user_id: "u" });
});

test("a plan turn is not read as usage credits; an overage turn is", () => {
	expect(chargedToCredits(new Headers({ "anthropic-ratelimit-unified-status": "allowed", "anthropic-ratelimit-unified-overage-status": "rejected", "anthropic-ratelimit-unified-representative-claim": "seven_day" }))).toBe(false);
	expect(chargedToCredits(new Headers())).toBe(false);
	expect(chargedToCredits(new Headers({ "anthropic-ratelimit-unified-representative-claim": "overage" }))).toBe(true);
	expect(chargedToCredits(new Headers({ "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-overage-status": "allowed" }))).toBe(true);
});

test("upstream gets rho's conversation with the CLI's login, and none of what the CLI adds", async () => {
	seen.length = 0;
	reply = answer([{ type: "text", text: "hello" }], "end_turn");
	const response = await post(relayFetch(options()));
	expect(response.status).toBe(200);
	expect(await response.text()).toContain("hello");
	expect(seen.length).toBe(1);
	const sent = seen[0]!;
	expect(sent.headers.get("authorization")).toBe("Bearer cli-login-token");
	expect(sent.headers.get("x-api-key")).toBeNull();
	expect(sent.headers.get("anthropic-beta")).toBe("cli-beta,rho-beta");
	expect(sent.path).toBe("/v1/messages?beta=true");
	expect(sent.body.system.map((b: any) => b.text)).toEqual(["x-anthropic-billing-header: cc_version=test;", "You are a Claude agent.", "Rho system prompt."]);
	expect(sent.body.messages).toEqual(ours.messages);
	expect(sent.body.tools).toEqual(ours.tools);
	const flat = JSON.stringify(sent.body);
	for (const leak of ["person@example.com", "# Environment", "/secret/path", "system-reminder", "rho-relay-placeholder"]) expect(flat).not.toContain(leak);
	const cli = cliSaw();
	expect(cli.sawApiKey).toBeNull(); // an API key in rho's environment must not change who pays
	expect(cli.args).toContain("--no-session-persistence");
	expect(cli.args[cli.args.indexOf("--tools") + 1]).toBe(""); // the CLI has no tools of its own
	expect(cli.other).toBe(404); // nothing but the one model request is relayed
});

test("a second request from the CLI is refused: one model request per turn", async () => {
	seen.length = 0;
	reply = answer([{ type: "text", text: "once" }], "end_turn");
	const response = await post(relayFetch(options("second-request")));
	await response.text();
	await Bun.sleep(300); // the fake CLI sends two requests at once; upstream must see one
	expect(seen.length).toBe(1);
});

test("a CLI that exits before asking is an error that says why", async () => {
	await expect(post(relayFetch(options("exit-early")))).rejects.toThrow(/exited \(3\) before sending a request.*not logged in/s);
});

test("a turn that would be paid from usage credits is stopped unless allowed", async () => {
	reply = answer([{ type: "text", text: "paid" }], "end_turn", { headers: { "anthropic-ratelimit-unified-representative-claim": "overage" } });
	await expect(post(relayFetch(options()))).rejects.toThrow(/Claude Code billing/);
	const allowed = await post(relayFetch(options("normal", { allowUsageCredits: true })));
	expect(await allowed.text()).toContain("paid");
});

test("cancel ends the upstream request and the CLI process", async () => {
	seen.length = 0;
	reply = answer([], "end_turn", { slow: true });
	const abort = new AbortController();
	const response = await post(relayFetch(options("linger")), abort.signal);
	const reader = response.body!.getReader();
	await reader.read();
	abort.abort();
	await reader.read().catch(() => undefined);
	await Bun.sleep(250);
	expect(seen[0]!.cancelled).toBe(true);
	expect(alive(cliSaw().pid)).toBe(false);
});

test("the CLI does not outlive its turn", async () => {
	reply = answer([{ type: "text", text: "done" }], "end_turn");
	const response = await post(relayFetch(options("linger")));
	await response.text();
	const { pid } = cliSaw(); // "linger" would sleep a minute after its request
	await Bun.sleep(200);
	expect(alive(pid)).toBe(false);
});

test("status reads the CLI's login without a model request", async () => {
	expect(await claudeStatus(options())).toEqual({ available: true, loggedIn: true, plan: "max" });
	expect((await claudeStatus(options("logged-out"))).loggedIn).toBe(false);
	expect((await claudeStatus({ command: "/nonexistent/claude" })).available).toBe(false);
});

test("through pi-ai: text and a tool request come back as pi messages, and the model list is the plan's", async () => {
	const models = createModels();
	models.setProvider(claudeCodeProvider(options()));
	const listed = (await models.getAvailable()).filter((model) => model.provider === CLAUDE_CODE).map((model) => model.id);
	for (const id of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2"]) expect(listed).toContain(id);
	const model = models.getModel(CLAUDE_CODE, "claude-haiku-5-5")!;
	seen.length = 0;
	reply = answer([{ type: "text", text: "Reading it." }, { type: "tool_use", id: "toolu_1", name: "read", input: { path: "/etc/hostname" } }], "tool_use");
	const stream = models.streamSimple(model, { systemPrompt: "Rho system prompt.", tools: [{ name: "read", description: "Read a file.", parameters: obj({ path: str() }) }], messages: [{ role: "user", content: "read it", timestamp: 1 }] });
	const message = await stream.result();
	expect(message.stopReason).toBe("toolUse");
	expect(message.provider).toBe(CLAUDE_CODE);
	expect(message.content).toMatchObject([{ type: "text", text: "Reading it." }, { type: "toolCall", id: "toolu_1", name: "read", arguments: { path: "/etc/hostname" } }]);
	expect(seen[0]!.body.tools[0].name).toBe("read"); // rho's own tool name, no mcp__ prefix
	expect(seen[0]!.body.system.at(-1).text).toContain("Rho system prompt.");
});
