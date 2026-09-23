/**
 * Detect Rho layout version without reading ordinary Pi state.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
	LAYOUT_VERSION,
	type InstallKind,
	type RhoPaths,
	classifyInstall,
	legacyBlockMessage,
	resolveRhoPaths,
} from "./rho-paths.ts";

export function loadInstallKind(paths: RhoPaths = resolveRhoPaths()): {
	paths: RhoPaths;
	kind: InstallKind;
} {
	const initTomlExists = fs.existsSync(paths.initToml);
	let markerVersion: number | null = null;
	if (fs.existsSync(paths.layoutMarker)) {
		try {
			const parsed = JSON.parse(fs.readFileSync(paths.layoutMarker, "utf8")) as {
				version?: unknown;
			};
			markerVersion = typeof parsed.version === "number" ? parsed.version : null;
		} catch {
			markerVersion = null;
		}
	}
	return {
		paths,
		kind: classifyInstall({ initTomlExists, markerVersion }),
	};
}

export function refuseLegacy(paths: RhoPaths = resolveRhoPaths()): RhoPaths {
	const loaded = loadInstallKind(paths);
	if (loaded.kind === "legacy") {
		console.error(legacyBlockMessage());
		process.exit(1);
	}
	return loaded.paths;
}

export function writeLayoutMarker(paths: RhoPaths): void {
	atomicWrite(
		paths.layoutMarker,
		`${JSON.stringify({ version: LAYOUT_VERSION }, null, 2)}\n`,
	);
}

export function atomicWrite(filePath: string, content: string): void {
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	const tmp = `${filePath}.tmp`;
	fs.writeFileSync(tmp, content);
	fs.renameSync(tmp, filePath);
}

export function ensureIsolatedDirs(paths: RhoPaths): void {
	for (const dir of [
		paths.piAgentDir,
		paths.sessionDir,
		paths.workspaceDir,
		paths.brainDir,
		paths.vaultDir,
	]) {
		fs.mkdirSync(dir, { recursive: true });
	}
}
