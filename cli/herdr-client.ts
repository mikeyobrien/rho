/**
 * Minimal Herdr CLI wrapper for Rho's named `rho` session.
 * Never targets the user's default Herdr session.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
	HERDR_AGENT,
	HERDR_WORKSPACE_LABEL,
	agentIsRho,
	firstPaneId,
	foregroundProcessName,
	herdrSessionName,
	isInteractiveShell,
	namedAgent,
	paneIdFromWorkspaceCreate,
	parseHerdrServerRunning,
	workspaceIdByLabel,
} from "./session-host.ts";

function session(): string {
	return herdrSessionName();
}

function assertDedicatedSession(args: string[]): void {
	const name = session();
	const scoped = args[0] === "--session" && args[1] === name;
	const namedStop = args[0] === "session" && args[1] === "stop" && args[2] === name;
	if (!scoped && !namedStop) {
		throw new Error(
			`Refusing Herdr command without the dedicated '${name}' session`,
		);
	}
}

export function herdrConfigPath(home = process.env.HOME || os.homedir()): string {
	return path.join(home, ".config", "herdr", "sessions", herdrSessionName(), "config.toml");
}

const CONFIG_TEMPLATE = `onboarding = false

[terminal]
shell_mode = "login"
new_cwd = "~/.rho/workspace"

[server]
headless_cols = 160
headless_rows = 50

[ui]
window_title = "rho"

[ui.toast]
delivery = "herdr"

[ui.sound]
enabled = false

[ui.sound.agents]
pi = "off"

[ui.sidebar.agents.rows_by_agent]
pi = [
  ["state_icon", "agent", "$next"],
  ["workspace"],
]

[session]
resume_agents_on_restore = false

[[keys.command]]
key = "prefix+alt+t"
type = "shell"
command = "rho trigger"
description = "trigger rho heartbeat"

[[keys.command]]
key = "prefix+alt+s"
type = "popup"
command = "rho status"
description = "rho status"

[[keys.command]]
key = "prefix+alt+l"
type = "popup"
command = "rho logs"
description = "rho logs"
`;

export function ensureHerdrConfig(home = process.env.HOME || os.homedir()): string {
	const target = herdrConfigPath(home);
	if (!existsSync(target)) {
		const packaged = path.resolve(
			path.dirname(fileURLToPath(import.meta.url)),
			"..",
			"configs",
			"herdr-rho.toml",
		);
		const body = existsSync(packaged) ? readFileSync(packaged, "utf-8") : CONFIG_TEMPLATE;
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, body.endsWith("\n") ? body : `${body}\n`);
	}
	return target;
}

export function herdrProcessEnv(
	base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const name = herdrSessionName(base);
	const env: NodeJS.ProcessEnv = {
		...base,
		HERDR_CONFIG_PATH: ensureHerdrConfig(base.HOME || os.homedir()),
		HERDR_SESSION: name,
	};
	const socket = env.HERDR_SOCKET_PATH || "";
	if (socket && !socket.includes(`/sessions/${name}/`)) {
		delete env.HERDR_SOCKET_PATH;
	}
	return env;
}

function herdr(args: string[]): { status: number | null; stdout: string; stderr: string } {
	assertDedicatedSession(args);
	const result = spawnSync("herdr", args, {
		encoding: "utf-8",
		env: herdrProcessEnv(),
	});
	return {
		status: result.status,
		stdout: result.stdout || "",
		stderr: result.stderr || "",
	};
}

export function herdrServerRunning(): boolean {
	const result = herdr(["--session", session(), "status", "server", "--json"]);
	return parseHerdrServerRunning(result.stdout);
}

export function startHerdrServerDetached(): void {
	const child = spawn("herdr", ["--session", session(), "server"], {
		detached: true,
		stdio: "ignore",
		env: herdrProcessEnv(),
	});
	child.unref();
}

export async function waitForHerdrServer(timeoutMs = 8000): Promise<boolean> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (herdrServerRunning()) return true;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	return herdrServerRunning();
}

export function herdrAgentLive(): boolean {
	const result = herdr(["--session", session(), "agent", "list"]);
	if (!agentIsRho(result.stdout, HERDR_AGENT)) return false;
	const paneId = namedAgent(result.stdout, HERDR_AGENT)?.paneId;
	if (!paneId) return false;
	return readPaneForeground(paneId) === "rho";
}

export function readPaneForeground(paneId: string): string | null {
	const result = herdr([
		"--session",
		session(),
		"pane",
		"process-info",
		"--pane",
		paneId,
	]);
	return foregroundProcessName(result.stdout);
}

export function closeHerdrWorkspace(workspaceId: string): void {
	herdr(["--session", session(), "workspace", "close", workspaceId]);
}

export function ensureHerdrWorkspace(input: {
	cwd: string;
	envPairs: string[];
}): string {
	const listed = herdr(["--session", session(), "workspace", "list"]);
	const existing = workspaceIdByLabel(listed.stdout, HERDR_WORKSPACE_LABEL);
	if (existing) {
		const panes = herdr([
			"--session",
			session(),
			"pane",
			"list",
			"--workspace",
			existing,
		]);
		const pane = firstPaneId(panes.stdout);
		if (pane) {
			const foreground = readPaneForeground(pane);
			// A live Pi (or any non-shell) occupant is not a reusable prompt.
			// Typing into it would inject the launch command into that process.
			if (!foreground || isInteractiveShell(foreground) || foreground === "rho") {
				return pane;
			}
			// Close the pane itself too: closing the workspace alone left the
			// Pi process alive and holding the rho name.
			herdr(["--session", session(), "pane", "close", pane]);
			closeHerdrWorkspace(existing);
		}
	}

	const args = [
		"--session",
		session(),
		"workspace",
		"create",
		"--cwd",
		input.cwd,
		"--label",
		HERDR_WORKSPACE_LABEL,
		"--no-focus",
	];
	for (const pair of input.envPairs) {
		args.push("--env", pair);
	}
	const created = herdr(args);
	const pane = paneIdFromWorkspaceCreate(created.stdout);
	if (!pane) {
		throw new Error(created.stderr.trim() || "Failed to create the Rho Herdr workspace");
	}
	return pane;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function rhoAgentCommand(rhoBin: string): string {
	return `${shellQuote(rhoBin)} agent`;
}

async function waitForForeground(
	paneId: string,
	wanted: string,
	timeoutMs: number,
): Promise<boolean> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (readPaneForeground(paneId) === wanted) return true;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	return readPaneForeground(paneId) === wanted;
}

async function waitForShell(paneId: string, timeoutMs: number): Promise<string | null> {
	const started = Date.now();
	let current = readPaneForeground(paneId);
	while (!current && Date.now() - started < timeoutMs) {
		await new Promise((resolve) => setTimeout(resolve, 200));
		current = readPaneForeground(paneId);
	}
	return current;
}

export async function startHerdrAgent(paneId: string, rhoBin: string): Promise<void> {
	// A just-created pane has no foreground process until its login shell is up.
	// Text sent before then is dropped, and the pane stays at a bare prompt.
	const current = await waitForShell(paneId, 15000);
	if (current !== "rho") {
		if (!current) {
			throw new Error(`Herdr pane ${paneId} never reached a shell prompt`);
		}
		if (!isInteractiveShell(current)) {
			throw new Error(
				`Refusing to type a launch command into ${current}. Close that pane first.`,
			);
		}
		const run = herdr([
			"--session",
			session(),
			"pane",
			"run",
			paneId,
			rhoAgentCommand(rhoBin),
		]);
		if (run.status !== 0) {
			throw new Error(run.stderr.trim() || run.stdout.trim() || "Failed to start Rho in Herdr");
		}
		const becameRho = await waitForForeground(paneId, "rho", 20000);
		if (!becameRho) {
			const screen = herdr([
				"--session",
				session(),
				"pane",
				"read",
				paneId,
				"--source",
				"visible",
				"--lines",
				"40",
			]).stdout.trim();
			throw new Error(
				`Herdr pane is running ${readPaneForeground(paneId) || "nothing"}, not rho` +
					(screen ? `\n--- pane ${paneId} ---\n${screen}` : ""),
			);
		}
	}
	const reported = herdr([
		"--session",
		session(),
		"pane",
		"report-agent",
		paneId,
		"--source",
		"rho",
		"--agent",
		"rho",
		"--state",
		"idle",
	]);
	if (reported.status !== 0) {
		throw new Error(
			reported.stderr.trim() || reported.stdout.trim() || "Failed to report the Rho agent",
		);
	}
	// A stale occupant (usually a Pi process renamed to rho) keeps the name
	// and makes the rename fail. Close its pane; this session is Rho-only.
	const holder = namedAgent(
		herdr(["--session", session(), "agent", "list"]).stdout,
		HERDR_AGENT,
	);
	if (holder?.paneId && holder.paneId !== paneId) {
		herdr(["--session", session(), "pane", "close", holder.paneId]);
	}
	const renamed = herdr([
		"--session",
		session(),
		"agent",
		"rename",
		paneId,
		HERDR_AGENT,
	]);
	if (renamed.status !== 0) {
		throw new Error(renamed.stderr.trim() || renamed.stdout.trim() || "Failed to name the Rho agent");
	}
}

export function readHerdrAgent(lines: number): string {
	const result = herdr([
		"--session",
		session(),
		"agent",
		"read",
		HERDR_AGENT,
		"--source",
		"recent-unwrapped",
		"--lines",
		String(lines),
	]);
	if (result.status !== 0) return "";
	return result.stdout;
}

export function stopHerdrSession(): void {
	const args = ["session", "stop", session(), "--json"];
	assertDedicatedSession(args);
	spawnSync("herdr", args, { stdio: "ignore", env: herdrProcessEnv() });
}

export function attachHerdrSession(): void {
	spawnSync("herdr", ["--session", session()], {
		stdio: "inherit",
		env: herdrProcessEnv(),
	});
}

function nextHeartbeatLabel(home: string): string | null {
	try {
		const state = JSON.parse(
			readFileSync(path.join(home, ".rho", "rho-state.json"), "utf-8"),
		) as { nextCheckAt?: number };
		if (typeof state.nextCheckAt !== "number") return null;
		const mins = Math.max(0, Math.ceil((state.nextCheckAt - Date.now()) / 60000));
		return mins === 0 ? "now" : `${mins}m`;
	} catch {
		return null;
	}
}

export function reportRhoPaneMetadata(): void {
	const info = herdr(["--session", session(), "agent", "get", HERDR_AGENT]);
	let paneId: string | null = null;
	try {
		const parsed = JSON.parse(info.stdout) as {
			result?: { agent?: { pane_id?: string } };
		};
		paneId = parsed.result?.agent?.pane_id ?? null;
	} catch {
		return;
	}
	if (!paneId) return;
	const next = nextHeartbeatLabel(process.env.HOME || os.homedir());
	const args = [
		"--session",
		session(),
		"pane",
		"report-metadata",
		paneId,
		"--source",
		"rho",
		"--display-agent",
		"rho",
		"--ttl-ms",
		"120000",
	];
	if (next) args.push("--token", `next=${next}`);
	herdr(args);
}
