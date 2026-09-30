/**
 * Herdr lifecycle regressions. Run: npx tsx tests/test-herdr-lifecycle.ts
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let failed = 0;
function assert(condition: boolean, label: string): void {
	if (condition) console.log(`  PASS: ${label}`);
	else {
		failed += 1;
		console.error(`  FAIL: ${label}`);
	}
}

const repoRoot = path.resolve(import.meta.dirname, "..");
const cli = path.join(repoRoot, "cli", "index.ts");
const tsx = path.join(repoRoot, "node_modules", ".bin", "tsx");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "rho-herdr-lifecycle-"));
const bin = path.join(home, "bin");
const calls = path.join(home, "herdr-calls.log");
fs.mkdirSync(path.join(home, ".rho"), { recursive: true });
fs.mkdirSync(bin, { recursive: true });
fs.writeFileSync(
	path.join(home, ".rho", "init.toml"),
	'[settings.heartbeat]\nhost = "herdr"\n[settings.web]\nenabled = false\n',
);
fs.writeFileSync(
	path.join(bin, "herdr"),
	`#!/bin/sh\nprintf '%s\\n' "$*" >> "$HERDR_CALLS"\nif [ "$*" = "--session rho status server --json" ]; then\n  printf '%s\\n' '{"running":true}'\nfi\n`,
	{ mode: 0o755 },
);

function run(args: string[]): { stdout: string; stderr: string; code: number } {
	try {
		const stdout = execFileSync(tsx, [cli, ...args], {
			encoding: "utf-8",
			env: {
				...process.env,
				HOME: home,
				PATH: `${bin}:${process.env.PATH}`,
				HERDR_CALLS: calls,
				RHO_TMUX_SOCKET: `rho-test-${process.pid}`,
				NODE_NO_WARNINGS: "1",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { stdout, stderr: "", code: 0 };
	} catch (error) {
		const result = error as { stdout?: string; stderr?: string; status?: number };
		return { stdout: result.stdout || "", stderr: result.stderr || "", code: result.status || 1 };
	}
}

try {
	const stopped = run(["stop"]);
	const logged = fs.existsSync(calls) ? fs.readFileSync(calls, "utf-8") : "";
	assert(stopped.code === 0, "stop exits successfully");
	assert(logged.includes("session stop rho --json"), "stop terminates a Herdr-only rho session");
	assert(!stopped.stdout.includes("Rho is not running."), "running Herdr session is not reported stopped");

	const help = run(["restart", "--help"]);
	assert(help.code === 0, "restart command is routed");
	assert(help.stdout.includes("Stop and restart"), "restart documents its lifecycle behavior");

	const startSource = fs.readFileSync(path.join(repoRoot, "cli", "commands", "start.ts"), "utf-8");
	assert(!startSource.includes("Use `/rho status`"), "shell guidance never presents a pi slash command");
} finally {
	fs.rmSync(home, { recursive: true, force: true });
}

if (failed > 0) {
	console.error(`\n${failed} failed`);
	process.exit(1);
}
console.log("\nall passed");
