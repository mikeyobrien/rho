/**
 * Rho-owned Pi locations. Ordinary ~/.pi/agent is never a fallback.
 */
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
	const piAgentDir = path.join(rhoDir, "pi-agent");
	return {
		home,
		rhoDir,
		piAgentDir,
		sessionDir: path.join(rhoDir, "sessions"),
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
	return {
		...base,
		HOME: paths.home,
		PI_CODING_AGENT_DIR: paths.piAgentDir,
		PI_CODING_AGENT_SESSION_DIR: paths.sessionDir,
	};
}

export function classifyInstall(input: {
	initTomlExists: boolean;
	markerVersion: number | null;
}): InstallKind {
	if (input.markerVersion === LAYOUT_VERSION) return "v2";
	if (input.initTomlExists || input.markerVersion != null) return "legacy";
	return "fresh";
}

export function piLaunchArgs(paths: RhoPaths, args: string[] = []): string[] {
	return ["--session-dir", paths.sessionDir, ...args];
}

export function legacyBlockMessage(): string {
	return [
		"Existing Rho install is not isolated from ordinary Pi.",
		"Run `rho migrate` to preview, then `rho migrate --apply`.",
		"Rho will not read or write ~/.pi/agent until you confirm.",
	].join(" ");
}
