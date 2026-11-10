import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, type CliEnv } from "../src/cli.ts";

// The real command against a real daemon process in a scratch home. The Claude CLI is the fake
// one, so starting asks it for its model list and calls no model.
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
	return { lines, opened, dir: join(home, "v2"), cli: { env: { ...process.env, RHO_HOME: home, RHO_PORT: String(port++), RHO_CLAUDE: claude }, out: (line) => lines.push(line), openLink: (url) => (opened.push(url), true) } };
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
	expect(await run(["start"], cli)).toBe(0);
	expect(lines.at(-1)).toMatch(/^Rho is running \(pid \d+\) at http:\/\/127\.0\.0\.1:\d+\.$/);
	const pid = JSON.parse(readFileSync(join(dir, "daemon.json"), "utf8")).pid as number;
	expect(await run(["start"], cli)).toBe(0);
	expect(lines.at(-1)).toContain(`already running (pid ${pid})`);
	expect(await run(["status"], cli)).toBe(0);
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
	const { cli, lines } = scratch();
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
