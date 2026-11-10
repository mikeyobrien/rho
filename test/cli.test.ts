import { afterEach, expect, test } from "bun:test";
import { existsSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, type CliEnv } from "../src/cli.ts";

// The real command against a real daemon process in a scratch home, with no API key in its
// environment: a new person's first run. The Claude CLI is the fake one, and it is used only by
// the test that turns the Claude plan on.
const KEY_VARS = /(_API_KEY|_TOKEN|_ACCESS_KEY.*|^AWS_.*|^GOOGLE_.*|^AZURE_.*|^CLOUDFLARE_.*)$/;
const bare = (): Record<string, string | undefined> => Object.fromEntries(Object.entries(process.env).filter(([name]) => !KEY_VARS.test(name)));
const homes: string[] = [];
let port = 4900 + Math.floor(Math.random() * 500);
function scratch(): { cli: CliEnv; lines: string[]; opened: string[]; dir: string } {
	const home = mkdtempSync(join(tmpdir(), "rho-cli-test-"));
	homes.push(home);
	const claude = join(home, "claude");
	writeFileSync(claude, `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(import.meta.dir, "fixtures", "fake-claude.ts"))} "$@"\n`);
	chmodSync(claude, 0o755);
	const lines: string[] = [];
	const opened: string[] = [];
	return { lines, opened, dir: join(home, "v2"), cli: { env: { ...bare(), RHO_HOME: home, RHO_PORT: String(port++), RHO_CLAUDE: claude }, out: (line) => lines.push(line), openLink: (url) => (opened.push(url), true) } };
}
afterEach(async () => {
	for (const home of homes.splice(0)) {
		await run(["stop"], { env: { ...process.env, RHO_HOME: home }, out: () => {}, openLink: () => false });
		rmSync(home, { recursive: true, force: true });
	}
});

test("start, status and stop; a second start changes nothing", async () => {
	const { cli, lines, dir } = scratch();
	expect(await run(["status"], cli)).toBe(1);
	expect(lines.at(-1)).toBe("Not running.");
	expect(await run(["logs"], cli)).toBe(0); // never started: there is no log, and that is not an error
	expect(lines.at(-1)).toBe("No log yet, start rho first.");
	expect(await run(["start"], cli)).toBe(0);
	// A first run, with no key: rho starts all the same, and says what is missing and how to add it.
	expect(lines.at(-2)).toMatch(/^Rho is running \(pid \d+\) at http:\/\/127\.0\.0\.1:\d+\.$/);
	expect(lines.at(-1)).toBe("Not ready: Rho has no model to use yet. Add an API key with: rho key anthropic");
	const pid = JSON.parse(readFileSync(join(dir, "daemon.json"), "utf8")).pid as number;
	expect(await run(["start"], cli)).toBe(0);
	expect(lines.at(-1)).toContain(`already running (pid ${pid})`);
	expect(await run(["status"], cli)).toBe(0);
	// The daemon runs from this checkout, so the commit it names is this checkout's.
	const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: import.meta.dir }).stdout.toString().trim();
	const port = JSON.parse(readFileSync(join(dir, "daemon.json"), "utf8")).port as number;
	expect(lines.at(-2)).toBe(`Running (pid ${pid}) at http://127.0.0.1:${port}, commit ${head.slice(0, 7)}.`);
	expect(lines.at(-1)).toBe("Not ready: Rho has no model to use yet. Add an API key with: rho key anthropic");
	expect(readFileSync(join(dir, "daemon.log"), "utf8")).toContain("setup: Rho has no model to use yet.");
	expect(await run(["logs", "5"], cli)).toBe(0);
	expect(lines.at(-1)).toContain(`rho: pid ${pid}`);
	expect(await run(["stop"], cli)).toBe(0);
	expect(lines.at(-1)).toBe("Rho is stopped.");
	expect(() => process.kill(pid, 0)).toThrow();
	expect(await run(["stop"], cli)).toBe(0);
	expect(lines.at(-1)).toBe("Rho is not running.");
}, 40_000);

test("open starts rho and opens a link that pairs a fresh browser once", async () => {
	const { cli, lines, opened, dir } = scratch();
	expect(await run(["open"], cli)).toBe(0);
	expect(lines.at(-1)).toBe("Opened rho in the browser.");
	const link = new URL(opened[0]!);
	expect(link.hostname).toBe("127.0.0.1");
	const code = new URLSearchParams(link.hash.slice(1)).get("pair")!;
	const pair = () => fetch(`${link.origin}/api/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
	const first = await pair();
	expect(((await first.json()) as { token: string }).token).toBe(readFileSync(join(dir, "token"), "utf8"));
	expect((await pair()).status).toBe(401); // the same link again is refused
	expect((await fetch(`${link.origin}/`)).status).toBe(200); // and the page is there
	// A second `rho open` gives a new link that works.
	await run(["open"], cli);
	expect(opened[1]).not.toBe(opened[0]);
}, 40_000);

test("with no way to open a browser, the link is printed; an unknown command prints the usage", async () => {
	const { cli, lines, opened } = scratch();
	// For a browser on another device: printed even where a browser could be opened here.
	expect(await run(["open", "--print"], cli)).toBe(0);
	expect(lines.at(-1)).toMatch(/It works once: http:\/\/127\.0\.0\.1:\d+\/#pair=/);
	expect(opened).toEqual([]);
	expect(await run(["open"], { ...cli, openLink: () => false })).toBe(0);
	expect(lines.at(-1)).toMatch(/^Open this address in a browser on this machine: http:\/\/127\.0\.0\.1:\d+\/#pair=/);
	expect(await run(["nonsense"], cli)).toBe(2);
	expect(lines.at(-1)).toContain("Usage: rho start");
}, 40_000);

test("a daemon that cannot start says why", async () => {
	const { cli, lines, dir } = scratch();
	await run(["start"], cli);
	const saved = readFileSync(join(dir, "daemon.json"), "utf8");
	// The record of the running daemon is lost, so the command tries to start another: the data's
	// lock refuses it, and the command reports the log's reason.
	writeFileSync(join(dir, "daemon.json"), "{}");
	expect(await run(["start"], cli)).toBe(1);
	expect(lines.at(-1)).toContain("Rho did not start");
	expect(lines.at(-1)).toContain("Another rho");
	writeFileSync(join(dir, "daemon.json"), saved); // so the first one can be stopped
}, 40_000);

test("a release typed in the work checkout is handed to the rho that runs, with the directory it was typed in", async () => {
	const { cli, lines, dir } = scratch();
	// A stand-in for the checkout the daemon runs from: its command says what it was given.
	const running = join(dir, "..", "running-checkout");
	mkdirSync(join(running, "bin"), { recursive: true });
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(running, "bin", "rho"), 'console.log(`handed: ${process.argv.slice(2).join(" ")} in ${process.cwd()}`); process.exit(7);');
	writeFileSync(join(dir, "daemon.json"), JSON.stringify({ pid: 1, port: 1, startedAt: 1, root: running }));
	const typedIn = realpathSync(join(dir, ".."));
	expect(await run(["release", "abc123"], { ...cli, cwd: typedIn })).toBe(7);
	expect(lines.at(-1)).toBe(`handed: release abc123 in ${typedIn}`);
	expect(await run(["release", "--status"], { ...cli, cwd: typedIn })).toBe(7);
	expect(lines.at(-1)).toBe(`handed: release --status in ${typedIn}`);
});

test("the installed command runs", async () => {
	const { cli } = scratch();
	const result = Bun.spawnSync([join(import.meta.dir, "..", "bin", "rho"), "status"], { env: cli.env as Record<string, string> });
	expect(result.stdout.toString().trim()).toBe("Not running.");
	expect(result.exitCode).toBe(1);
});

test("version prints the commit of the checkout rho runs from", async () => {
	const { cli, lines } = scratch();
	const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: join(import.meta.dir, "..") }).stdout.toString().trim();
	expect(head).toMatch(/^[0-9a-f]{40}$/);
	expect(await run(["version"], cli)).toBe(0);
	expect(lines.at(-1)).toBe(head); // not running, so nothing more to say
});

test("rho key stores a key the running rho uses at once; it is never an argument and never printed", async () => {
	const { cli, lines, dir } = scratch();
	const secret = "sk-test-0123456789abcdef";
	expect(await run(["key"], cli)).toBe(0);
	expect(lines.join("\n")).toContain("Rho has no API key yet.");
	expect(lines.join("\n")).toContain("anthropic  Anthropic (or set ANTHROPIC_API_KEY)");
	expect(lines.join("\n")).toContain('"claudePlan": true');
	expect(await run(["start"], cli)).toBe(0);
	expect(lines.at(-1)).toContain("Not ready");
	// Refusals: as an argument, with nobody to ask, an unknown provider, an empty or malformed key.
	expect(await run(["key", "anthropic", secret], { ...cli, readSecret: async () => secret })).toBe(2);
	expect(lines.at(-1)).toContain("not given as an argument");
	expect(await run(["key", "anthropic"], cli)).toBe(2);
	expect(lines.at(-1)).toContain("nobody to ask");
	expect(await run(["key", "nonesuch"], { ...cli, readSecret: async () => secret })).toBe(2);
	expect(await run(["key", "claude-code"], { ...cli, readSecret: async () => secret })).toBe(2);
	expect(lines.at(-1)).toContain("not a key");
	expect(await run(["key", "anthropic"], { ...cli, readSecret: async () => "  " })).toBe(1);
	expect(await run(["key", "anthropic"], { ...cli, readSecret: async () => "two words here" })).toBe(1);
	expect(await run(["status"], cli)).toBe(0);
	expect(lines.at(-1)).toContain("Not ready");
	// The key, asked for and stored.
	const asked: string[] = [];
	expect(await run(["key", "anthropic"], { ...cli, readSecret: async (prompt) => (asked.push(prompt), `${secret}\n`) })).toBe(0);
	expect(asked).toEqual(["Anthropic API key (not shown): "]);
	expect(JSON.parse(readFileSync(join(dir, "keys.json"), "utf8"))).toEqual({ anthropic: { type: "api_key", key: secret } });
	expect(statSync(join(dir, "keys.json")).mode & 0o777).toBe(0o600);
	expect(lines.join("\n")).not.toContain(secret);
	expect(readFileSync(join(dir, "daemon.log"), "utf8")).not.toContain(secret);
	// The running rho needs no restart to see it.
	expect(await run(["status"], cli)).toBe(0);
	expect(lines.at(-1)).toBe("Model: anthropic/claude-sonnet-5-5.");
	expect(await run(["key"], cli)).toBe(0);
	expect(lines.join("\n")).toContain("  anthropic: key stored by rho");
	expect(await run(["key", "anthropic", "--remove"], cli)).toBe(0);
	expect(lines.at(-1)).toBe("Removed rho's stored key for anthropic.");
	expect(await run(["key", "anthropic", "--remove"], cli)).toBe(0);
	expect(lines.at(-1)).toBe("Rho has no stored key for anthropic.");
	expect(await run(["status"], cli)).toBe(0);
	expect(lines.at(-1)).toContain("Not ready");
}, 40_000);

test("a key in the environment is enough; the Claude plan is used only when the config turns it on, and then with its warning", async () => {
	const keyed = scratch();
	expect(await run(["start"], { ...keyed.cli, env: { ...keyed.cli.env, OPENAI_API_KEY: "sk-test-0123456789" } })).toBe(0);
	expect(keyed.lines.at(-1)).toMatch(/^Rho is running/); // nothing is missing
	expect(await run(["status"], keyed.cli)).toBe(0);
	expect(keyed.lines.at(-1)).toBe("Model: openai/gpt-5.5.");
	expect(readFileSync(join(keyed.dir, "daemon.log"), "utf8")).not.toContain("Claude plan");

	const plan = scratch();
	mkdirSync(plan.dir, { recursive: true });
	writeFileSync(join(plan.dir, "config.json"), JSON.stringify({ claudePlan: true }));
	expect(await run(["start"], plan.cli)).toBe(0);
	expect(await run(["status"], plan.cli)).toBe(0);
	expect(plan.lines.at(-1)).toMatch(/^Model: claude-code\/claude-opus/);
	const log = readFileSync(join(plan.dir, "daemon.log"), "utf8");
	expect(log).toContain("Claude plan: rho is using your Claude Code login. This is not an API key.");
	expect(log).toContain("charged to usage credits");
}, 60_000);

test("a key in the daemon's environment is used for requests and is not in the environment its bash tool runs with", async () => {
	// A stand-in model server: it asks for `env` to be run, then says done. It records the key it was sent.
	const sent: (string | null)[] = [];
	const chunk = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
	const model = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => {
		sent.push(request.headers.get("authorization"));
		const first = sent.length === 1;
		const body = first
			? `${chunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "env" }) } }] })}${chunk({}, "tool_calls")}`
			: `${chunk({ role: "assistant", content: "done" })}${chunk({}, "stop")}`;
		return new Response(`${body}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
	} });
	try {
		const { cli, dir } = scratch();
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "config.json"), JSON.stringify({ cwd: join(dir, ".."), providers: [{ id: "local", baseUrl: `http://127.0.0.1:${model.port}/v1`, apiKeyEnv: "MY_SERVER_KEY", models: ["m"] }] }));
		const env = { ...cli.env, MY_SERVER_KEY: "key-for-my-server-1234", OPENAI_API_KEY: "sk-openai-in-env-5678", HARMLESS_SETTING: "stays" };
		expect(await run(["start"], { ...cli, env })).toBe(0);
		const port = JSON.parse(readFileSync(join(dir, "daemon.json"), "utf8")).port as number;
		const headers = { authorization: `Bearer ${readFileSync(join(dir, "token"), "utf8").trim()}`, "content-type": "application/json" };
		await fetch(`http://127.0.0.1:${port}/api/model`, { method: "POST", headers, body: JSON.stringify({ model: "local/m" }) });
		expect((await fetch(`http://127.0.0.1:${port}/api/submit`, { method: "POST", headers, body: JSON.stringify({ text: "run env", requestId: "env-check-0001" }) })).status).toBe(200);
		let output = "";
		for (let i = 0; i < 100 && output === ""; i++) {
			await new Promise((done) => setTimeout(done, 100));
			const events = await fetch(`http://127.0.0.1:${port}/api/events`, { headers });
			const reader = events.body!.getReader();
			let text = "";
			while (!text.includes("\n\n")) text += new TextDecoder().decode((await reader.read()).value);
			await reader.cancel();
			const state = JSON.parse(text.split("\n\n")[0]!.slice(6)) as { running: boolean; entries: { role: string; text: string }[] };
			if (!state.running) output = state.entries.find((entry) => entry.role === "tool")?.text ?? "";
		}
		expect(sent).toEqual(["Bearer key-for-my-server-1234", "Bearer key-for-my-server-1234"]); // the key is used
		expect(output).toContain("HARMLESS_SETTING=stays"); // the shell has the rest of the environment
		expect(output).not.toContain("key-for-my-server-1234");
		expect(output).not.toContain("sk-openai-in-env-5678");
		expect(output).not.toContain("MY_SERVER_KEY");
		expect(output).not.toContain("OPENAI_API_KEY");
	} finally {
		model.stop(true);
	}
}, 60_000);

test("rho login: what it refuses, a stored login makes the provider usable, and logout removes it", async () => {
	const { cli, lines, dir } = scratch();
	expect(await run(["login"], cli)).toBe(0);
	expect(lines.at(-1)).toContain("Providers with a sign-in: ");
	expect(lines.at(-1)).toContain("openai");
	expect(lines.at(-1)).not.toMatch(/\banthropic\b/); // a Claude subscription goes through Claude Code only
	expect(await run(["login", "anthropic"], cli)).toBe(2);
	expect(lines.at(-1)).toContain('"claudePlan": true');
	expect(await run(["login", "deepseek"], cli)).toBe(2);
	expect(lines.at(-1)).toContain("it takes a key: rho key deepseek");
	expect(await run(["login", "nonesuch"], cli)).toBe(2);
	// A login as the provider's flow stores it (the flow itself needs a person and a browser, and is not run here).
	mkdirSync(dir, { recursive: true });
	const login = { type: "oauth", access: "access-token-not-real-0001", refresh: "refresh-token-not-real-0002", expires: Date.now() + 3_600_000 };
	writeFileSync(join(dir, "keys.json"), JSON.stringify({ openai: login }), { mode: 0o600 });
	expect(await run(["key"], cli)).toBe(0);
	expect(lines.join("\n")).toContain("  openai: signed in (rho login)");
	expect(lines.join("\n")).not.toContain("token-not-real");
	expect(await run(["start"], cli)).toBe(0);
	expect(await run(["status"], cli)).toBe(0);
	expect(lines.at(-1)).toBe("Model: openai/gpt-5.6-sol."); // not gpt-5.5, which OpenAI refuses to a ChatGPT account
	expect(await run(["logout", "openai"], cli)).toBe(0);
	expect(lines.at(-1)).toBe("Removed rho's stored login for openai.");
	expect(JSON.parse(readFileSync(join(dir, "keys.json"), "utf8"))).toEqual({});
	expect(await run(["status"], cli)).toBe(0);
	expect(lines.at(-1)).toContain("Not ready");
}, 40_000);
