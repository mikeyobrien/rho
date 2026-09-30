/**
 * Rho-owned Pi locations. Ordinary ~/.pi/agent is never a fallback.
 *
 * The agent directory is ~/.rho/agent, matching ~/.pi/agent. Sessions stay
 * under that directory. Do not set PI_CODING_AGENT_SESSION_DIR or pass
 * --session-dir: Pi treats an explicit session dir as a leaf and skips the
 * cwd bucket (~/.pi/agent/sessions/<encoded-cwd>/).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const LAYOUT_VERSION = 2;

export interface RhoPaths {
	home: string;
	rhoDir: string;
	piAgentDir: string;
	sessionDir: string;
	workspaceDir: string;
	settingsPath: string;
	authPath: string;
	initToml: string;
	packagesToml: string;
	syncLock: string;
	layoutMarker: string;
	brainDir: string;
	vaultDir: string;
	ordinaryPiAgentDir: string;
}

export type InstallKind = "fresh" | "v2" | "legacy";

export function resolveRhoPaths(
	home = process.env.HOME || os.homedir(),
): RhoPaths {
	const rhoDir = path.join(home, ".rho");
	const piAgentDir = path.join(rhoDir, "agent");
	return {
		home,
		rhoDir,
		piAgentDir,
		sessionDir: path.join(piAgentDir, "sessions"),
		workspaceDir: path.join(rhoDir, "workspace"),
		settingsPath: path.join(piAgentDir, "settings.json"),
		authPath: path.join(piAgentDir, "auth.json"),
		initToml: path.join(rhoDir, "init.toml"),
		packagesToml: path.join(rhoDir, "packages.toml"),
		syncLock: path.join(rhoDir, "sync.lock"),
		layoutMarker: path.join(rhoDir, "layout.json"),
		brainDir: path.join(rhoDir, "brain"),
		vaultDir: path.join(rhoDir, "vault"),
		ordinaryPiAgentDir: path.join(home, ".pi", "agent"),
	};
}

export function buildPiChildEnv(
	paths: RhoPaths,
	base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {
		...base,
		HOME: paths.home,
		PI_CODING_AGENT_DIR: paths.piAgentDir,
	};
	delete env.PI_CODING_AGENT_SESSION_DIR;
	return env;
}

/** Pi's cwd bucket name under <agent>/sessions/. */
export function encodeSessionBucket(cwd: string): string {
	const resolved = path.resolve(cwd);
	return `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function sessionCwdFromHeader(filePath: string): string | null {
	try {
		const firstLine = fs.readFileSync(filePath, "utf8").split("\n", 1)[0] ?? "";
		const parsed = JSON.parse(firstLine) as { cwd?: unknown };
		return typeof parsed.cwd === "string" && parsed.cwd.length > 0
			? parsed.cwd
			: null;
	} catch {
		return null;
	}
}

function moveIfAbsent(source: string, destination: string): void {
	if (fs.existsSync(destination)) return;
	fs.mkdirSync(path.dirname(destination), { recursive: true });
	fs.renameSync(source, destination);
}

/**
 * Move the earlier v2 names (~/.rho/pi-agent and flat ~/.rho/sessions) onto
 * the Pi-shaped layout. Existing files are never overwritten.
 */
export function relocateLegacyAgentLayout(paths: RhoPaths): void {
	const oldAgent = path.join(paths.rhoDir, "pi-agent");
	if (fs.existsSync(oldAgent) && !fs.existsSync(paths.piAgentDir)) {
		fs.renameSync(oldAgent, paths.piAgentDir);
	}

	const oldSessions = path.join(paths.rhoDir, "sessions");
	if (!fs.existsSync(oldSessions) || oldSessions === paths.sessionDir) return;

	for (const entry of fs.readdirSync(oldSessions, { withFileTypes: true })) {
		const source = path.join(oldSessions, entry.name);
		if (entry.isDirectory()) {
			moveIfAbsent(source, path.join(paths.sessionDir, entry.name));
			continue;
		}
		if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
		const cwd = sessionCwdFromHeader(source) ?? paths.workspaceDir;
		moveIfAbsent(
			source,
			path.join(paths.sessionDir, encodeSessionBucket(cwd), entry.name),
		);
	}

	try {
		if (fs.readdirSync(oldSessions).length === 0) fs.rmdirSync(oldSessions);
	} catch {
		// Leave a non-empty or busy directory in place.
	}
}

export function classifyInstall(input: {
	initTomlExists: boolean;
	markerVersion: number | null;
}): InstallKind {
	if (input.markerVersion === LAYOUT_VERSION) return "v2";
	if (input.initTomlExists || input.markerVersion != null) return "legacy";
	return "fresh";
}

export function piLaunchArgs(_paths: RhoPaths, args: string[] = []): string[] {
	return args;
}

export function legacyBlockMessage(): string {
	return [
		"Existing Rho install is not isolated from ordinary Pi.",
		"Run `rho migrate` to preview, then `rho migrate --apply`.",
		"Rho will not read or write ~/.pi/agent until you confirm.",
	].join(" ");
}
