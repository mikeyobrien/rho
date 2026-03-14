/**
 * Tests for cli/index.ts command router.
 *
 * NOTE: these tests must NOT start daemons or mutate user config.
 * We only call `--help` / `--version` and check basic routing.
 *
 * Run: npx -y tsx tests/test-cli.ts
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { createServer } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// ---- Test harness ----
let PASS = 0;
let FAIL = 0;

function assert(condition: boolean, label: string): void {
	if (condition) {
		console.log(`  PASS: ${label}`);
		PASS++;
	} else {
		console.error(`  FAIL: ${label}`);
		FAIL++;
	}
}

function assertIncludes(haystack: string, needle: string, label: string): void {
	if (haystack.includes(needle)) {
		console.log(`  PASS: ${label}`);
		PASS++;
	} else {
		console.error(`  FAIL: ${label} -- "${needle}" not found in output`);
		FAIL++;
	}
}

function assertNotIncludes(
	haystack: string,
	needle: string,
	label: string,
): void {
	if (!haystack.includes(needle)) {
		console.log(`  PASS: ${label}`);
		PASS++;
	} else {
		console.error(
			`  FAIL: ${label} -- "${needle}" should not appear in output`,
		);
		FAIL++;
	}
}

const THIS_DIR =
	import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.resolve(THIS_DIR, "../cli/index.ts");
const TSX_BIN = path.resolve(THIS_DIR, "../node_modules/.bin/tsx");
const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "rho-cli-test-"));
const TEST_RHO_DIR = path.join(TEST_HOME, ".rho");
const TEST_TMUX_SOCKET = `rho-cli-test-${process.pid}`;

fs.mkdirSync(TEST_RHO_DIR, { recursive: true });
fs.writeFileSync(
	path.join(TEST_RHO_DIR, "init.toml"),
	"[settings.web]\nenabled = false\nport = 3141\n",
	"utf-8",
);

process.on("exit", () => {
	fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

function run(args: string): { stdout: string; stderr: string; code: number } {
	const argv = args.trim() ? args.trim().split(/\s+/) : [];
	try {
		const stdout = execFileSync(TSX_BIN, [CLI_PATH, ...argv], {
			encoding: "utf-8",
			env: {
				...process.env,
				NODE_NO_WARNINGS: "1",
				HOME: TEST_HOME,
				RHO_TMUX_SOCKET: TEST_TMUX_SOCKET,
			},
			timeout: 10_000,
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { stdout, stderr: "", code: 0 };
	} catch (e: unknown) {
		const err = e as { stdout?: string; stderr?: string; status?: number };
		return {
			stdout: err.stdout ?? "",
			stderr: err.stderr ?? "",
			code: err.status ?? 1,
		};
	}
}

console.log("\n=== CLI Router Tests ===\n");

// -- --help flag --
console.log("-- --help --");
{
	const r = run("--help");
	assert(r.code === 0, "--help exits 0");
	assertIncludes(r.stdout, "rho", "--help mentions rho");
	for (const cmd of [
		"init",
		"sync",
		"doctor",
		"upgrade",
		"start",
		"stop",
		"status",
		"trigger",
		"logs",
		"login",
		"telegram",
		"web",
		"skills",
	]) {
		assertIncludes(r.stdout, cmd, `--help lists ${cmd}`);
	}
}

// -- no args routes to start without executing real daemon state --
console.log("\n-- no args --");
{
	const cliSource = fs.readFileSync(CLI_PATH, "utf-8");
	assertIncludes(
		cliSource,
		'await cmd.run(["--foreground"]);',
		"no args dispatches to start (not help)",
	);
}

// -- --version flag --
console.log("\n-- --version --");
{
	const pkg = JSON.parse(
		fs.readFileSync(path.resolve(THIS_DIR, "../package.json"), "utf-8"),
	);
	const r = run("--version");
	assert(r.code === 0, "--version exits 0");
	assertIncludes(r.stdout, pkg.version, "--version shows package version");
}

// -- unknown command --
console.log("\n-- unknown command --");
{
	const r = run("nonexistent");
	assert(r.code !== 0, "unknown command exits non-zero");
	assertIncludes(
		r.stderr || r.stdout,
		"nonexistent",
		"unknown command mentions the bad command",
	);
}

// -- each command supports --help without routing failure --
console.log("\n-- subcommand --help --");
for (const cmd of [
	"init",
	"sync",
	"doctor",
	"upgrade",
	"start",
	"stop",
	"status",
	"trigger",
	"logs",
	"login",
	"telegram",
	"web",
	"skills",
]) {
	const r = run(`${cmd} --help`);
	assertNotIncludes(r.stderr, "Unknown command", `${cmd} --help routes`);
}

// -- web help advertises restart action --
console.log("\n-- web restart help --");
{
	const r = run("web --help");
	assert(r.code === 0, "web --help exits 0");
	assertIncludes(
		r.stdout,
		"rho web restart",
		"web --help mentions restart action",
	);
}

// -- web argument validation --
console.log("\n-- web invalid args --");
{
	const r = run("web --port");
	assert(r.code !== 0, "web --port without value exits non-zero");
	assertIncludes(
		r.stderr || r.stdout,
		"Missing value for --port",
		"web reports missing port value",
	);
}

// -- web restart handles busy port gracefully --
console.log("\n-- web restart busy port --");
{
	const busyServer = createServer();
	await new Promise<void>((resolve, reject) => {
		busyServer.once("error", reject);
		busyServer.listen(0, "127.0.0.1", resolve);
	});

	const address = busyServer.address();
	const busyPort =
		typeof address === "object" && address !== null ? address.port : 0;
	assert(busyPort > 0, "test server allocated a valid port");

	const r = run(`web restart --port ${busyPort}`);
	assert(r.code !== 0, "web restart exits non-zero when port is busy");
	assertIncludes(r.stderr || r.stdout, "Port", "web restart reports busy port");

	await new Promise<void>((resolve, reject) => {
		busyServer.close((err) => {
			if (err) {
				reject(err);
				return;
			}
			resolve();
		});
	});
}

// ---- smol-toml dependency check ----
console.log("\n-- smol-toml available --");
try {
	const toml = await import("smol-toml");
	assert(typeof toml.parse === "function", "smol-toml parse is available");
	const parsed = toml.parse("[test]\nval = 42") as {
		test?: { val?: number };
	};
	assert(parsed.test?.val === 42, "smol-toml parses TOML correctly");
} catch {
	assert(false, "smol-toml is importable");
	assert(false, "smol-toml parses TOML correctly");
}

console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
