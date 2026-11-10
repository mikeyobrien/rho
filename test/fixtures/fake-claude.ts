// Stands in for the Claude Code CLI in tests. Like the real one, it makes its request to
// ANTHROPIC_BASE_URL with its own login and its own additions around the prompt.
// FAKE_CLAUDE says how it behaves; what it saw is written to FAKE_CLAUDE_OUT.
const mode = process.env.FAKE_CLAUDE ?? "normal";
const args = process.argv.slice(2);
if (args[0] === "auth") {
	console.log(JSON.stringify(mode === "logged-out" ? { loggedIn: false } : { loggedIn: true, subscriptionType: "max" }));
	process.exit(0);
}
const report = async (value: object) => { if (process.env.FAKE_CLAUDE_OUT) await Bun.write(process.env.FAKE_CLAUDE_OUT, JSON.stringify(value)); };
if (mode === "exit-early") {
	console.error("not logged in");
	process.exit(3);
}
const placeholder = args[args.indexOf("--system-prompt") + 1];
const base = process.env.ANTHROPIC_BASE_URL;
const body = {
	model: args[args.indexOf("--model") + 1],
	max_tokens: 1,
	stream: true,
	metadata: { user_id: "cli-user" },
	system: [
		{ type: "text", text: "x-anthropic-billing-header: cc_version=test;" },
		{ type: "text", text: "You are a Claude agent.", cache_control: { type: "ephemeral" } },
		{ type: "text", text: placeholder, cache_control: { type: "ephemeral" } },
	],
	messages: [
		{ role: "user", content: [{ type: "text", text: "<system-reminder>The user's email address is person@example.com</system-reminder>" }, { type: "text", text: "." }] },
		{ role: "system", content: [{ type: "text", text: "# Environment\nPrimary working directory: /secret/path" }] },
	],
};
// Reported before the model request: rho ends this process as soon as it has the response.
const other = await fetch(`${base}/v1/models`).then((r) => r.status, () => 0);
await report({ pid: process.pid, args, other, sawApiKey: process.env.ANTHROPIC_API_KEY ?? null });
const send = () => fetch(`${base}/v1/messages?beta=true`, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer cli-login-token", "anthropic-beta": "cli-beta", "anthropic-version": "2023-06-01" }, body: JSON.stringify(body) });
const requests = mode === "second-request" ? [send(), send()] : [send()];
await Promise.all(requests.map((request) => request.then((response) => response.text(), () => "")));
if (mode === "linger") await Bun.sleep(60_000);
export {};
