// Stands in for the Claude Code CLI in tests. Like the real one it reads history frames on
// stdin, acknowledges earlier user messages, and builds and sends its own request: its login,
// its system lines, an environment message, reminders around user content, tools under the
// MCP prefix. FAKE_CLAUDE says how it behaves; what it did is written to FAKE_CLAUDE_OUT.
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const mode = process.env.FAKE_CLAUDE ?? "normal";
const args = process.argv.slice(2);
if (args[0] === "auth") {
	console.log(JSON.stringify(mode === "logged-out" ? { loggedIn: false } : { loggedIn: true, subscriptionType: "max" }));
	process.exit(0);
}
if (mode === "exit-early") {
	console.error("not logged in");
	process.exit(3);
}
const arg = (name: string) => args[args.indexOf(name) + 1] ?? "";
if (!args.includes("--system-prompt-file")) {
	// The model catalog probe: an initialize request, answered with what this login is offered.
	for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
		const event = JSON.parse(line) as { type: string; request_id?: string };
		if (event.type !== "control_request") continue;
		process.stdout.write(`${JSON.stringify({ type: "control_response", response: { request_id: event.request_id, subtype: "success", response: { models: [
			{ value: "default", resolvedModel: "claude-opus-5-5", displayName: "Default" },
			{ value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus" },
			{ value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku" },
			{ value: "claude-next-9", resolvedModel: "claude-next-9", displayName: "Unknown to pi-ai" },
		] } } })}\n`);
	}
	process.exit(0);
}
const system = readFileSync(arg("--system-prompt-file"), "utf8");
const extra = JSON.parse(JSON.parse(readFileSync(arg("--settings"), "utf8")).env.CLAUDE_CODE_EXTRA_BODY);
const inventory = JSON.parse(readFileSync(JSON.parse(arg("--mcp-config")).mcpServers.rho.args[1], "utf8")) as { name: string; description: string; inputSchema: object }[];
const tools = inventory.map((tool) => ({ name: `mcp__rho__${tool.name}`, description: tool.description, input_schema: tool.inputSchema }));
const cache = { type: "ephemeral" };
const reminder = { type: "text", text: "<system-reminder>The user's email address is person@example.com</system-reminder>" };
const history: { role: string; content: any[] }[] = [];
let requests = 0;
let second: number | undefined;
const report = () => process.env.FAKE_CLAUDE_OUT && writeFileSync(process.env.FAKE_CLAUDE_OUT, JSON.stringify({ pid: process.pid, args, requests, second, cwd: process.cwd(), sawApiKey: process.env.ANTHROPIC_API_KEY ?? null }));
const emit = (event: object) => process.stdout.write(`${JSON.stringify(event)}\n`);
report();

function wire(): object[] {
	const messages: object[] = [];
	const users = history.filter((message) => message.role === "user").length;
	const newest = history.findLastIndex((message) => message.role === "user");
	let seen = 0;
	history.forEach((message, index) => {
		if (message.role !== "user") return void messages.push(message);
		const content = structuredClone(message.content);
		if (index === newest) {
			// Reminders ride on the newest message: in front of plain text, inside a tool result.
			if (content[0]?.type === "tool_result" && Array.isArray(content[0].content)) content[0].content.push(reminder);
			else content.unshift(reminder);
			content[content.length - 1].cache_control = cache;
		}
		messages.push({ role: "user", content });
		// On a first turn the environment carries the date; on a replay the date moves to the tail.
		if (++seen === 1) messages.push({ role: "system", content: [{ type: "text", text: `# Environment\nPrimary working directory: ${process.cwd()}${users === 1 ? "\nToday's date is 2026-01-01." : ""}`, cache_control: cache }] });
	});
	if (users > 1) messages.push({ role: "system", content: [{ type: "text", text: "Today's date is 2026-01-01.", cache_control: cache }] });
	return messages;
}

async function ask(): Promise<{ status: number; text: string }> {
	requests++;
	report();
	const body = {
		model: arg("--model"), max_tokens: 32000, stream: true, metadata: { user_id: "cli-user" }, tools, messages: wire(), ...extra,
		system: [{ type: "text", text: "x-anthropic-billing-header: cc_version=test;" }, { type: "text", text: "You are a Claude agent.", cache_control: cache }, { type: "text", text: system, cache_control: cache }],
	};
	const response = await fetch(`${process.env.ANTHROPIC_BASE_URL}/v1/messages?beta=true`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer cli-login-token", "user-agent": "claude-cli/test", "x-app": "cli", "anthropic-beta": "cli-beta" }, body: JSON.stringify(body) });
	return { status: response.status, text: await response.text().catch(() => "") };
}

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
	const frame = JSON.parse(line) as { type: string; shouldQuery?: boolean; message: { role: string; content: any[] } };
	history.push({ role: frame.message.role, content: frame.message.content });
	if (frame.type !== "user") continue;
	if (frame.shouldQuery === false) {
		emit(mode === "reject-history" ? { type: "result", subtype: "error", is_error: true, num_turns: 0 } : { type: "result", subtype: "success", is_error: false, num_turns: 0 });
		continue;
	}
	const { text } = await ask();
	const said = text.split("\n").filter((l) => l.startsWith("data: ")).map((l) => { try { return JSON.parse(l.slice(6)); } catch { return {}; } }).filter((e) => e.delta?.type === "text_delta").map((e) => e.delta.text).join("");
	const tool = text.includes('"type":"tool_use"');
	history.push({ role: "assistant", content: [{ type: "text", text: said }] });
	emit({ type: "rate_limit_event", rate_limit_info: { status: "allowed", isUsingOverage: mode === "overage" } });
	if (mode === "second-request") second = (await ask()).status;
	report();
	emit(tool ? { type: "result", subtype: "error_max_turns", is_error: true, num_turns: 2 } : { type: "result", subtype: "success", is_error: false, num_turns: 1 });
}
