/**
 * rho web — Launch or restart the Rho web server.
 *
 * Starts a web server providing a chat interface and state file viewer/editor.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { serve } from "@hono/node-server";
import app, {
	disposeServerResources,
	injectWebSocket,
} from "../../web/server.ts";
import { type RhoConfig, parseInitToml } from "../config.ts";
import { PID_FILE, SESSION_NAME } from "../daemon-core.ts";

const HOME = process.env.HOME || os.homedir();
const RHO_DIR = path.join(HOME, ".rho");
const INIT_TOML = path.join(RHO_DIR, "init.toml");
const DAEMON_PID_PATH = path.join(HOME, PID_FILE);
const STANDALONE_WEB_PID_PATH = path.join(HOME, ".rho-web.pid");
const DEFAULT_PORT = 3141;
const DEFAULT_HOST = "0.0.0.0";

interface WebConfig {
	enabled: boolean;
	port: number;
}

type WebAction = "start" | "restart";

interface ParsedArgs {
	action: WebAction;
	port?: number;
	open: boolean;
	help: boolean;
	error?: string;
}

function readInitConfig(): RhoConfig | null {
	try {
		if (!existsSync(INIT_TOML)) return null;
		return parseInitToml(readFileSync(INIT_TOML, "utf-8"));
	} catch {
		return null;
	}
}

function getWebConfig(): WebConfig {
	const cfg = readInitConfig();
	const settings = (cfg?.settings as Record<string, unknown>)?.web as
		| Record<string, unknown>
		| undefined;

	return {
		enabled: typeof settings?.enabled === "boolean" ? settings.enabled : false,
		port: typeof settings?.port === "number" ? settings.port : DEFAULT_PORT,
	};
}

function getTmuxSocket(): string {
	const env = (process.env.RHO_TMUX_SOCKET || "").trim();
	if (env) return env;

	const cfg = readInitConfig();
	const heartbeatSettings = (cfg?.settings as Record<string, unknown>)
		?.heartbeat as Record<string, unknown> | undefined;
	const socket = heartbeatSettings?.tmux_socket;
	if (typeof socket === "string" && socket.trim()) {
		return socket.trim();
	}

	return "rho";
}

function tmuxSessionExists(): boolean {
	try {
		const result = spawnSync(
			"tmux",
			["-L", getTmuxSocket(), "has-session", "-t", SESSION_NAME],
			{ stdio: "ignore" },
		);
		return result.status === 0;
	} catch {
		return false;
	}
}

function tmuxLegacySessionExists(): boolean {
	try {
		const result = spawnSync("tmux", ["has-session", "-t", SESSION_NAME], {
			stdio: "ignore",
		});
		return result.status === 0;
	} catch {
		return false;
	}
}

function parseArgs(args: string[]): ParsedArgs {
	let action: WebAction = "start";
	let port: number | undefined;
	let open = false;
	let help = false;
	let error: string | undefined;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--help" || arg === "-h") {
			help = true;
		} else if (arg === "--open" || arg === "-o") {
			open = true;
		} else if (arg === "--port" || arg === "-p") {
			const next = args[i + 1];
			if (!next || next.startsWith("-")) {
				error = "Missing value for --port";
				break;
			}
			const parsed = Number.parseInt(next, 10);
			if (!Number.isFinite(parsed) || parsed <= 0) {
				error = `Invalid port: ${next}`;
				break;
			}
			port = parsed;
			i++;
		} else if (arg.startsWith("--port=")) {
			const rawPort = arg.slice(7);
			const parsed = Number.parseInt(rawPort, 10);
			if (!Number.isFinite(parsed) || parsed <= 0) {
				error = `Invalid port: ${rawPort}`;
				break;
			}
			port = parsed;
		} else if (arg === "restart") {
			action = "restart";
		} else if (arg === "start") {
			action = "start";
		} else if (!arg.startsWith("-")) {
			error = `Unknown action: ${arg}`;
			break;
		} else {
			error = `Unknown option: ${arg}`;
			break;
		}
	}

	return { action, port, open, help, error };
}

function openBrowser(url: string): void {
	const platform = process.platform;
	let cmd: string;
	let args: string[];

	if (platform === "darwin") {
		cmd = "open";
		args = [url];
	} else if (platform === "win32") {
		cmd = "cmd";
		args = ["/c", "start", url];
	} else {
		// Linux / Android - try xdg-open first
		cmd = "xdg-open";
		args = [url];
	}

	try {
		const child = spawn(cmd, args, {
			detached: true,
			stdio: "ignore",
		});
		child.unref();
	} catch {
		// Non-fatal - browser open is best-effort
	}
}

function readPidFile(filePath: string): number | null {
	try {
		const content = readFileSync(filePath, "utf-8").trim();
		const pid = Number.parseInt(content, 10);
		return Number.isFinite(pid) ? pid : null;
	} catch {
		return null;
	}
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function clearStandaloneWebPidFile(): void {
	try {
		unlinkSync(STANDALONE_WEB_PID_PATH);
	} catch {
		// ignore
	}
}

function readDaemonPid(): number | null {
	return readPidFile(DAEMON_PID_PATH);
}

function readStandaloneWebPid(): number | null {
	return readPidFile(STANDALONE_WEB_PID_PATH);
}

async function waitForPidToExit(
	pid: number,
	timeoutMs: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!pidAlive(pid)) return true;
		await sleep(100);
	}
	return !pidAlive(pid);
}

async function stopStandaloneWebServer(): Promise<boolean> {
	const pid = readStandaloneWebPid();
	if (pid === null) {
		clearStandaloneWebPidFile();
		return false;
	}

	if (pid === process.pid) {
		return false;
	}

	const daemonPid = readDaemonPid();
	if (daemonPid !== null && pid === daemonPid) {
		console.warn(
			"Standalone web PID points to rho daemon; refusing to stop daemon process.",
		);
		return false;
	}

	if (!pidAlive(pid)) {
		clearStandaloneWebPidFile();
		return false;
	}

	try {
		process.kill(pid, "SIGTERM");
	} catch {
		return false;
	}

	let stopped = await waitForPidToExit(pid, 3_000);
	if (!stopped) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// ignore
		}
		stopped = await waitForPidToExit(pid, 1_000);
	}

	clearStandaloneWebPidFile();

	if (stopped) {
		console.log(`Stopped standalone web server (${pid}).`);
	} else {
		console.warn(
			`Standalone web server (${pid}) did not exit cleanly; continuing.`,
		);
	}

	return true;
}

function readProcessCmdline(pid: number): string | null {
	if (process.platform !== "linux") return null;
	try {
		return readFileSync(`/proc/${pid}/cmdline`, "utf-8")
			.split("\0")
			.join(" ")
			.trim();
	} catch {
		return null;
	}
}

function isLikelyRhoWebProcess(cmdline: string): boolean {
	return (
		cmdline.includes("cli/index.ts web") ||
		cmdline.includes("cli/rho.mjs web") ||
		cmdline.includes("web/dev.ts") ||
		cmdline.includes(" rho web")
	);
}

function findListeningPidByPort(port: number): number | null {
	if (process.platform !== "linux") return null;
	try {
		const result = spawnSync("ss", ["-ltnp"], {
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		if (result.status !== 0 || !result.stdout) return null;
		const portPattern = new RegExp(`:${port}\\b`);
		for (const line of result.stdout.split("\n")) {
			if (!portPattern.test(line)) continue;
			const match = line.match(/pid=(\d+)/);
			if (!match) continue;
			const pid = Number.parseInt(match[1], 10);
			if (Number.isFinite(pid)) return pid;
		}
		return null;
	} catch {
		return null;
	}
}

async function stopUntrackedWebServerByPort(port: number): Promise<boolean> {
	const pid = findListeningPidByPort(port);
	if (pid === null || pid === process.pid) return false;

	const daemonPid = readDaemonPid();
	if (daemonPid !== null && pid === daemonPid) {
		return false;
	}

	if (!pidAlive(pid)) {
		return false;
	}

	const cmdline = readProcessCmdline(pid);
	if (!cmdline || !isLikelyRhoWebProcess(cmdline)) {
		return false;
	}

	try {
		process.kill(pid, "SIGTERM");
	} catch {
		return false;
	}

	let stopped = await waitForPidToExit(pid, 3_000);
	if (!stopped) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// ignore
		}
		stopped = await waitForPidToExit(pid, 1_000);
	}

	if (stopped) {
		console.log(`Stopped untracked web server on port ${port} (${pid}).`);
	} else {
		console.warn(
			`Untracked web server on port ${port} (${pid}) did not exit cleanly; continuing.`,
		);
	}

	return true;
}

async function isPortInUse(
	port: number,
	host: string = DEFAULT_HOST,
): Promise<boolean> {
	return await new Promise((resolve) => {
		const tester = createServer();
		tester.once("error", () => {
			resolve(true);
		});
		tester.once("listening", () => {
			tester.close(() => resolve(false));
		});
		tester.listen(port, host);
	});
}

async function restartDaemonManagedWeb(
	port: number,
	open: boolean,
): Promise<void> {
	console.log("Web is managed by `rho start`; restarting daemon...");

	const stopCommand = await import("./stop.ts");
	await stopCommand.run([]);

	const startCommand = await import("./start.ts");
	await startCommand.run([]);

	if (open) {
		openBrowser(`http://localhost:${port}`);
	}
}

function printHelp(): void {
	console.log(`rho web

Launch or restart the Rho web server.

The web server provides:
- Chat interface with pi RPC integration
- Brain viewer/editor (brain.jsonl entries)
- Tasks list view
- Real-time updates via WebSocket

Usage:
  rho web [options]
  rho web restart [options]

Actions:
  restart            Restart standalone web server (tracked in ~/.rho-web.pid).

Notes:
  If web is daemon-managed ([settings.web].enabled + \`rho start\`), this command
  restarts the daemon to bounce the web server.

Options:
  --port, -p <port>   Port to bind to (default: 3141 or from init.toml)
  --open, -o          Open browser after starting/restarting
  -h, --help          Show this help

Configuration:
  Add a [settings.web] section to ~/.rho/init.toml:

  [settings.web]
  port = 3141          # Server port
  enabled = false      # Auto-start with \`rho start\`

Examples:
  rho web              Start on default port (3141)
  rho web --port 4000  Start on port 4000
  rho web --open       Start and open browser
  rho web restart      Restart web server`);
}

async function runForegroundServer(port: number, open: boolean): Promise<void> {
	const hostname = DEFAULT_HOST;
	const server = serve({ fetch: app.fetch, port, hostname });
	injectWebSocket(server);

	try {
		writeFileSync(STANDALONE_WEB_PID_PATH, String(process.pid));
	} catch {
		// best effort
	}

	console.log(`Rho web running at http://localhost:${port}`);

	if (open) {
		openBrowser(`http://localhost:${port}`);
	}

	let closed = false;

	const cleanup = (): void => {
		if (closed) return;
		closed = true;

		disposeServerResources();
		server.close();
		clearStandaloneWebPidFile();
	};

	function shutdown(signal: string): void {
		console.log(`\nShutting down web server (${signal})...`);
		cleanup();
		process.exit(0);
	}

	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));
	process.on("exit", cleanup);

	// Keep the process alive
	await new Promise(() => {});
}

export async function run(args: string[]): Promise<void> {
	const parsed = parseArgs(args);

	if (parsed.help) {
		printHelp();
		return;
	}

	if (parsed.error) {
		console.error(parsed.error);
		console.error("Run `rho web --help` for usage.");
		process.exit(1);
	}

	const webConfig = getWebConfig();
	const port = parsed.port ?? webConfig.port;

	if (parsed.action === "restart") {
		const daemonPid = readDaemonPid();
		const daemonManagedRunning =
			(daemonPid !== null && pidAlive(daemonPid)) ||
			tmuxSessionExists() ||
			tmuxLegacySessionExists();

		if (webConfig.enabled && daemonManagedRunning) {
			await restartDaemonManagedWeb(webConfig.port, parsed.open);
			return;
		}

		let stopped = await stopStandaloneWebServer();
		if (!stopped) {
			stopped = await stopUntrackedWebServerByPort(port);
		}
		if (!stopped) {
			console.log("No standalone web server detected; starting a new server.");
		}
	}

	if (await isPortInUse(port)) {
		console.error(`Port ${port} is already in use.`);
		if (parsed.action === "restart") {
			console.error(
				"Could not restart automatically because the process on that port is not a tracked rho web server.",
			);
		}
		console.error(
			"Stop the process using that port or use `rho web --port <port>`.",
		);
		process.exit(1);
	}

	await runForegroundServer(port, parsed.open);
}

/**
 * Start the web server programmatically (for integration with rho start).
 * Returns a cleanup function.
 */
export function startWebServer(port: number = DEFAULT_PORT): {
	url: string;
	stop: () => void;
} {
	const hostname = DEFAULT_HOST;
	const server = serve({ fetch: app.fetch, port, hostname });
	injectWebSocket(server);

	const url = `http://localhost:${port}`;

	return {
		url,
		stop: () => {
			disposeServerResources();
			server.close();
		},
	};
}

/**
 * Get the web config from init.toml.
 */
export { getWebConfig };

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
