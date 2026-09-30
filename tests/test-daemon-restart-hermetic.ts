/**
 * Hermetic daemon restart. Uses a throwaway Herdr session and HOME so the
 * live rho session is never stopped or attached.
 *
 * Run: npx tsx tests/test-daemon-restart-hermetic.ts
 * Real agent: RHO_HERMETIC_REAL_AGENT=1 runs the workspace `rho agent` on the
 * installed Pi instead of a title-only stand-in. It needs `pi` on PATH.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repoRoot, "cli", "index.ts");
const tsx = path.join(repoRoot, "node_modules", ".bin", "tsx");
const session = `rho-hermetic-${process.pid}`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), "rho-daemon-restart-"));
const bin = path.join(home, "bin");
const calls = path.join(home, "herdr-calls.log");
const realAgent = process.env.RHO_HERMETIC_REAL_AGENT === "1";

/** Absolute Pi cli.js. The installed `pi` wrapper uses $HOME, which the test replaces. */
function realPiCli(): string {
	const found = spawnSync("bash", ["-lc", "command -v pi"], { encoding: "utf-8" });
	const bin = found.stdout.trim();
	if (!bin) throw new Error("RHO_HERMETIC_REAL_AGENT=1 needs pi on PATH");
	const body = fs.readFileSync(bin, "utf-8");
	const match = body.match(/"([^"]*pi-coding-agent[^"]*cli\.js)"/) ?? body.match(/(\S*pi-coding-agent\S*cli\.js)/);
	if (!match?.[1]) throw new Error(`Could not find Pi's cli.js from ${bin}`);
	return match[1].replace("$HOME", os.homedir());
}

let failed = 0;
function assert(condition: boolean, label: string): void {
	if (condition) console.log(`  PASS: ${label}`);
	else {
		failed += 1;
		console.error(`  FAIL: ${label}`);
	}
}

function herdr(args: string[], timeout = 15000): { status: number; stdout: string; stderr: string } {
	const result = spawnSync("herdr", ["--session", session, ...args], {
		encoding: "utf-8",
		timeout,
		env: cleanEnv(),
	});
	return {
		status: result.status ?? 1,
		stdout: result.stdout || "",
		stderr: result.stderr || result.error?.message || "",
	};
}

function cleanEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, HOME: home };
	for (const key of [
		// The caller may be a live Rho session. Never hand its Pi state to the test.
		"PI_CODING_AGENT_DIR",
		"PI_CODING_AGENT_SESSION_DIR",
		"PI_SESSION_FILE",
		"PI_SESSION_ID",
		"HERDR_ENV",
		"HERDR_SESSION",
		"HERDR_SOCKET_PATH",
		"HERDR_CONFIG_PATH",
		"HERDR_WORKSPACE_ID",
		"HERDR_TAB_ID",
		"HERDR_PANE_ID",
	]) {
		delete env[key];
	}
	return env;
}

function rhoEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	return {
		...cleanEnv(),
		PATH: `${bin}:${process.env.PATH}`,
		RHO_HERDR_SESSION: session,
		RHO_TMUX_SOCKET: `rho-hermetic-${process.pid}`,
		NODE_NO_WARNINGS: "1",
		...extra,
	};
}

function runRho(args: string[], timeout = 45000): { code: number; stdout: string; stderr: string } {
	try {
		const stdout = execFileSync(tsx, [cli, ...args], {
			encoding: "utf-8",
			timeout,
			env: rhoEnv(),
			stdio: ["ignore", "pipe", "pipe"],
		});
		return { code: 0, stdout, stderr: "" };
	} catch (error) {
		const result = error as { stdout?: string; stderr?: string; status?: number };
		return {
			code: result.status || 1,
			stdout: result.stdout || "",
			stderr: result.stderr || "",
		};
	}
}

function daemonPid(): number | null {
	try {
		const pid = parseInt(fs.readFileSync(path.join(home, ".rho-daemon.pid"), "utf-8"), 10);
		return Number.isFinite(pid) ? pid : null;
	} catch {
		return null;
	}
}

function pidAlive(pid: number | null): boolean {
	if (pid === null) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function killDaemon(): void {
	const pid = daemonPid();
	if (!pidAlive(pid)) return;
	try {
		process.kill(pid as number, "SIGTERM");
	} catch {
		// already gone
	}
}

function agentList(): string {
	return herdr(["agent", "list"]).stdout;
}

function processName(pane?: string): string {
	const id = pane || agentList().match(/"pane_id":"([^"]+)"/)?.[1];
	if (!id) return "";
	const info = herdr(["pane", "process-info", "--pane", id]).stdout;
	return info.match(/"name":"([^"]+)"/)?.[1] || "";
}

function encodeBucket(cwd: string): string {
	return `--${path.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function waitFor(label: string, predicate: () => boolean, timeoutMs = 20000): boolean {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (predicate()) return true;
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
	}
	console.error(`  timeout waiting for ${label}`);
	return false;
}

/** Rho processes started under this test's HOME (monitors, detached restarts). */
function ownedPids(match: string): number[] {
	const pids: number[] = [];
	for (const entry of fs.readdirSync("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		try {
			const cmd = fs.readFileSync(`/proc/${entry}/cmdline`, "utf-8").replaceAll("\0", " ");
			if (!cmd.includes(match)) continue;
			const env = fs.readFileSync(`/proc/${entry}/environ`, "utf-8").split("\0");
			if (env.includes(`HOME=${home}`)) pids.push(Number(entry));
		} catch {
			// exited or not ours
		}
	}
	return pids;
}

function cleanup(): void {
	for (const pid of [...ownedPids("restart --detached"), ...ownedPids("start --monitor")]) {
		try {
			process.kill(pid, "SIGTERM");
		} catch {
			// already gone
		}
	}
	waitFor("owned processes exit", () => ownedPids("start --monitor").length === 0, 5000);
	killDaemon();
	const env = cleanEnv();
	spawnSync("herdr", ["session", "stop", session], { env, stdio: "ignore" });
	spawnSync("herdr", ["session", "delete", session], { env, stdio: "ignore" });
	fs.rmSync(home, { recursive: true, force: true });
}

const herdrBin = spawnSync("bash", ["-lc", "command -v herdr"], { encoding: "utf-8" });
if (herdrBin.status !== 0 || !herdrBin.stdout.trim()) {
	console.error("herdr is not installed; hermetic restart test cannot run");
	process.exit(1);
}

fs.mkdirSync(path.join(home, ".rho", "workspace"), { recursive: true });
fs.mkdirSync(bin, { recursive: true });
fs.writeFileSync(
	path.join(home, ".rho", "init.toml"),
	'[settings.heartbeat]\nhost = "herdr"\ninterval = "30m"\n[settings.web]\nenabled = false\n',
);
fs.writeFileSync(path.join(home, ".rho", "layout.json"), '{"version":2}\n');
if (realAgent) {
	fs.mkdirSync(path.join(home, ".rho", "agent"), { recursive: true });
	fs.writeFileSync(path.join(home, ".rho", "agent", "settings.json"), '{"packages":[]}\n');
	fs.writeFileSync(
		path.join(bin, "pi"),
		`#!/bin/sh\nexec "${process.execPath}" "${realPiCli()}" "$@"\n`,
		{ mode: 0o755 },
	);
	fs.writeFileSync(
		path.join(bin, "rho"),
		`#!/bin/sh\nexec "${process.execPath}" --experimental-strip-types --no-warnings "${cli}" "$@"\n`,
		{ mode: 0o755 },
	);
} else {
	fs.writeFileSync(
		path.join(bin, "rho"),
		`#!/bin/sh
if [ "$1" = "agent" ]; then
  exec node -e 'process.title="rho"; setInterval(() => {}, 1000)'
fi
printf '%s\\n' "$*" >> "$HOME/rho-stub.log"
exit 0
`,
		{ mode: 0o755 },
	);
}
fs.writeFileSync(
	path.join(bin, "tmux"),
	`#!/bin/sh
printf '%s\\n' "$*" >> "$HOME/tmux-calls.log"
exit 1
`,
	{ mode: 0o755 },
);
fs.writeFileSync(
	path.join(bin, "herdr-log"),
	"",
);

try {
	console.log(`\n=== hermetic session ${session} (${realAgent ? "real rho agent" : "stand-in agent"}) ===\n`);

	const started = runRho(["start"]);
	fs.appendFileSync(calls, `START\n${started.stdout}\n${started.stderr}\n`);
	assert(started.code === 0, "rho start exits 0 from outside Herdr");
	assert(started.stdout.includes("Attach with:"), "start tells the caller how to attach");
	assert(!started.stdout.includes("Rho already running."), "fresh start does not complain that a session exists");
	assert(
		!started.stdout.includes("still running in tmux"),
		"start does not complain about a tmux session",
	);
	const rhoKind = waitFor("rho agent", () => {
		const list = agentList();
		return list.includes('"agent":"rho"') && list.includes('"name":"rho"');
	});
	assert(rhoKind, "Herdr agent kind is rho, not pi");
	assert(processName() === "rho", "pane foreground process is rho, not pi");
	if (realAgent) {
		// Pi resets process.title during startup; give it time to try.
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 8000);
		assert(processName() === "rho", "real agent is still rho after Pi finishes loading");
		const screen = herdr(["agent", "read", "rho", "--source", "visible", "--lines", "40"]).stdout;
		assert(/pi v\d/.test(screen), "real agent screen shows the Pi engine loaded");
		const bucket = encodeBucket(path.join(home, ".rho", "workspace"));
		assert(
			!fs.existsSync(path.join(os.homedir(), ".rho", "agent", "sessions", bucket)),
			"no session bucket leaked into the real ~/.rho",
		);
	}
	assert(daemonPid() !== null, "daemon pid file is in the hermetic HOME");

	const again = runRho(["start"]);
	assert(again.code === 0, "second start exits 0");
	assert(again.stdout.includes("Rho already running."), "healthy rho session is left running");
	assert(!again.stdout.includes("Failed to start"), "second start does not try to steal the terminal");
	assert(processName() === "rho", "second start does not replace rho with pi");

	const socket = herdr(["status", "server", "--json"]).stdout.match(/"socket":"([^"]+)"/)?.[1] || "";
	assert(socket.includes(`/sessions/${session}/`), "status socket is the hermetic session");
	let insideResult: { code: number; stdout: string; stderr: string };
	try {
		const stdout = execFileSync(tsx, [cli, "restart"], {
			encoding: "utf-8",
			timeout: 10000,
			env: rhoEnv({ HERDR_SOCKET_PATH: socket, HERDR_SESSION: session }),
			stdio: ["ignore", "pipe", "pipe"],
		});
		insideResult = { code: 0, stdout, stderr: "" };
	} catch (error) {
		const result = error as { stdout?: string; stderr?: string; status?: number };
		insideResult = {
			code: result.status || 1,
			stdout: result.stdout || "",
			stderr: result.stderr || "",
		};
	}
	assert(insideResult.code === 0, "in-session restart returns");
	assert(
		insideResult.stdout.includes("outside this session"),
		"in-session restart does not attach or block on the dying pane",
	);
	const cameBack = waitFor("restarted rho agent", () => {
		const list = agentList();
		return list.includes('"agent":"rho"') && list.includes('"name":"rho"') && processName() === "rho";
	}, 30000);
	assert(cameBack, "detached restart brings the rho agent back");
	assert(daemonPid() !== null, "restart leaves a daemon pid");
	// The detached restart polls after the agent returns. Let it finish so it
	// cannot race the Pi fixture below.
	assert(
		waitFor("detached restart exit", () => ownedPids("restart --detached").length === 0, 45000),
		"detached restart process exits",
	);
	assert(ownedPids("start --monitor").length === 1, "exactly one monitor after restart");

	killDaemon();
	waitFor("daemon exit", () => !pidAlive(daemonPid()), 5000);
	spawnSync("herdr", ["session", "stop", session], { env: cleanEnv(), stdio: "ignore" });
	waitFor("session stopped", () => !herdr(["status", "server", "--json"]).stdout.includes('"running":true'), 8000);
	// Same environment rho uses when it starts the server. A server with a
	// different PATH gives its panes a different pi than the test installed.
	const server = spawn("herdr", ["--session", session, "server"], {
		detached: true,
		stdio: "ignore",
		env: rhoEnv(),
	});
	server.unref();
	waitFor("session server", () => herdr(["status", "server", "--json"]).stdout.includes('"running":true'), 8000);
	let pane = "";
	let created = { status: 1, stdout: "", stderr: "" };
	for (let attempt = 0; attempt < 8 && !pane; attempt++) {
		created = herdr(["workspace", "create", "--cwd", home, "--label", "rho", "--no-focus"]);
		pane = created.stdout.match(/"pane_id":"([^"]+)"/)?.[1] || "";
		if (!pane) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
	}
	if (!pane) {
		console.error(`workspace create status=${created.status}`);
		console.error(created.stdout.slice(0, 500));
		console.error(created.stderr.slice(0, 500));
	}
	assert(Boolean(pane), "pi fixture has a fresh pane");
	if (pane) {
		waitFor("shell prompt", () => {
			const info = herdr(["pane", "process-info", "--pane", pane]).stdout;
			return /"name":"(bash|zsh|sh)"/.test(info);
		}, 8000);
		herdr(["pane", "run", pane, `node -e 'process.title="pi"; setInterval(() => {}, 1000)'`]);
		const piUp = waitFor("pi process", () => processName(pane) === "pi", 8000);
		assert(piUp, "fixture pane foreground is pi");
		herdr(["pane", "report-agent", pane, "--source", "rho", "--agent", "pi", "--state", "idle"]);
		herdr(["agent", "rename", pane, "rho"]);
	}
	const before = agentList();
	assert(
		before.includes('"agent":"pi"') && before.includes('"name":"rho"') && processName(pane) === "pi",
		"fixture is a pi process renamed to rho",
	);
	const repaired = runRho(["start"]);
	if (repaired.code !== 0 || repaired.stdout.includes("Rho already running.")) {
		console.error(repaired.stdout);
		console.error(repaired.stderr);
		const monitorErr = path.join(home, ".rho", "monitor.err");
		if (fs.existsSync(monitorErr)) console.error(fs.readFileSync(monitorErr, "utf-8"));
	}
	assert(repaired.code === 0, "start repairs a session whose agent is pi");
	assert(
		!repaired.stdout.includes("Rho already running."),
		"start does not treat a pi occupant as an existing rho session",
	);
	const repairedOk = waitFor("repaired rho", () => {
		const list = agentList();
		return list.includes('"agent":"rho"') && processName() === "rho";
	});
	assert(repairedOk, "repair leaves a rho process, not pi");
} finally {
	cleanup();
}

if (failed > 0) {
	console.error(`\n${failed} failed`);
	process.exit(1);
}
console.log("\nall passed");
