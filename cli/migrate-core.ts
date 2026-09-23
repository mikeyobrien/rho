/**
 * Explicit Rho v2 migration. Preview reads only. Apply copies Rho-owned
 * settings and sessions, never ordinary Pi credentials unless asked.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWrite, writeLayoutMarker } from "./install-kind.ts";
import { type RhoPaths, resolveRhoPaths } from "./rho-paths.ts";

export interface MigrateHooks {
	onBackupFile?: (rel: string) => void;
	onCopyFile?: (rel: string) => void;
}

export interface MigrateOptions {
	copyAuth?: boolean;
	removePackage?: boolean;
	now?: string;
	hooks?: MigrateHooks;
}

export interface MigrateReport {
	sourceSettings: string;
	destSettings: string;
	sourceSessions: string;
	destSessions: string;
	sourceAuth: string;
	destAuth: string;
	sourceState: string;
	destState: string;
	rhoPackageDetected: boolean;
	rhoPackageSource: string | null;
	sessionCount: number;
	collisions: string[];
	actions: string[];
	copiesAuth: boolean;
	removesPackage: boolean;
	wroteMarker: boolean;
}

interface SettingsFile {
	packages?: unknown[];
	[key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function packageSource(value: unknown): string | null {
	if (!isRecord(value)) return null;
	return typeof value.source === "string" ? value.source : null;
}

export function isRhoPackage(value: unknown): boolean {
	if (!isRecord(value)) return false;
	if (value._managed_by === "rho") return true;
	const source = packageSource(value);
	return source != null && source.includes("@rhobot-dev/rho");
}

function sameJson(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function readJson(filePath: string): { ok: true; value: unknown } | { ok: false; error: string } {
	try {
		return { ok: true, value: JSON.parse(fs.readFileSync(filePath, "utf8")) };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, error: message };
	}
}

function listFiles(root: string): string[] {
	if (!fs.existsSync(root)) return [];
	const found: string[] = [];
	const stack = [root];
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current) continue;
		for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
			const full = path.join(current, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) {
				stack.push(full);
				continue;
			}
			if (entry.isFile()) found.push(path.relative(root, full));
		}
	}
	return found.sort();
}

function sameBytes(left: string, right: string): boolean {
	return fs.readFileSync(left).equals(fs.readFileSync(right));
}

function copyAtomic(source: string, destination: string): void {
	fs.mkdirSync(path.dirname(destination), { recursive: true });
	const tmp = `${destination}.migrate-tmp`;
	fs.copyFileSync(source, tmp);
	fs.renameSync(tmp, destination);
}

function backupFile(source: string, backupRoot: string, rel: string, hooks?: MigrateHooks): void {
	hooks?.onBackupFile?.(rel);
	copyAtomic(source, path.join(backupRoot, rel));
}

function rhoEntries(settings: unknown): unknown[] {
	if (!isRecord(settings) || !Array.isArray(settings.packages)) return [];
	return settings.packages.filter(isRhoPackage);
}

function collisionFor(rel: string, source: string, destination: string): string | null {
	if (!fs.existsSync(destination)) return null;
	if (sameBytes(source, destination)) return null;
	return `${rel} exists and differs; left unchanged`;
}

export function previewMigration(
	paths: RhoPaths = resolveRhoPaths(),
	options: MigrateOptions = {},
): MigrateReport {
	const copyAuth = options.copyAuth === true;
	const removePackage = options.removePackage === true;
	const collisions: string[] = [];
	const actions: string[] = [];
	let rhoPackageDetected = false;
	let rhoPackageSource: string | null = null;

	if (fs.existsSync(paths.ordinaryPiAgentDir) && fs.existsSync(path.join(paths.ordinaryPiAgentDir, "settings.json"))) {
		const parsed = readJson(path.join(paths.ordinaryPiAgentDir, "settings.json"));
		if (parsed.ok) {
			const entries = rhoEntries(parsed.value);
			rhoPackageDetected = entries.length > 0;
			rhoPackageSource = packageSource(entries[0]);
			if (rhoPackageDetected) {
				actions.push("copy Rho package entry into isolated settings.json");
			}
		} else {
			collisions.push(`ordinary settings.json is not valid JSON: ${parsed.error}`);
		}
	}

	const sessions = listFiles(path.join(paths.ordinaryPiAgentDir, "sessions"));
	for (const rel of sessions) {
		const source = path.join(paths.ordinaryPiAgentDir, "sessions", rel);
		const destination = path.join(paths.sessionDir, rel);
		const collision = collisionFor(`sessions/${rel}`, source, destination);
		if (collision) collisions.push(collision);
		else if (!fs.existsSync(destination)) actions.push(`copy sessions/${rel}`);
	}

	const stateSource = path.join(paths.ordinaryPiAgentDir, "rho-state.json");
	if (fs.existsSync(stateSource)) {
		const collision = collisionFor("rho-state.json", stateSource, path.join(paths.rhoDir, "rho-state.json"));
		if (collision) collisions.push(collision);
		else if (!fs.existsSync(path.join(paths.rhoDir, "rho-state.json"))) {
			actions.push("copy rho-state.json");
		}
	}

	if (copyAuth && fs.existsSync(path.join(paths.ordinaryPiAgentDir, "auth.json"))) {
		actions.push("copy auth.json because --copy-auth was set");
	} else if (fs.existsSync(path.join(paths.ordinaryPiAgentDir, "auth.json"))) {
		actions.push("leave auth.json in ordinary Pi");
	}
	if (removePackage && rhoPackageDetected) {
		actions.push("remove Rho package entry from ordinary Pi because --remove-package was set");
	}

	return {
		sourceSettings: path.join(paths.ordinaryPiAgentDir, "settings.json"),
		destSettings: paths.settingsPath,
		sourceSessions: path.join(paths.ordinaryPiAgentDir, "sessions"),
		destSessions: paths.sessionDir,
		sourceAuth: path.join(paths.ordinaryPiAgentDir, "auth.json"),
		destAuth: paths.authPath,
		sourceState: stateSource,
		destState: path.join(paths.rhoDir, "rho-state.json"),
		rhoPackageDetected,
		rhoPackageSource,
		sessionCount: sessions.length,
		collisions,
		actions,
		copiesAuth: copyAuth,
		removesPackage: removePackage,
		wroteMarker: false,
	};
}

function mergePackageEntry(destination: SettingsFile, entry: unknown): "copied" | "present" | "collision" {
	const packages = Array.isArray(destination.packages) ? destination.packages : [];
	const existing = packages.find(isRhoPackage);
	if (existing && sameJson(existing, entry)) return "present";
	if (existing) return "collision";
	destination.packages = [...packages, entry];
	return "copied";
}

export function applyMigration(
	paths: RhoPaths = resolveRhoPaths(),
	options: MigrateOptions = {},
): MigrateReport {
	const preview = previewMigration(paths, options);
	const actions: string[] = [];
	const collisions = [...preview.collisions];
	const stamp = (options.now ?? new Date().toISOString()).replace(/[:.]/g, "-");
	const backupRoot = path.join(paths.rhoDir, "migrate-backups", stamp);
	const hooks = options.hooks;

	fs.mkdirSync(paths.piAgentDir, { recursive: true });
	fs.mkdirSync(paths.sessionDir, { recursive: true });
	fs.mkdirSync(backupRoot, { recursive: true });

	const settingsSource = path.join(paths.ordinaryPiAgentDir, "settings.json");
	if (fs.existsSync(settingsSource)) {
		backupFile(settingsSource, backupRoot, "settings.json", hooks);
		hooks?.onCopyFile?.("settings.json");
		const parsed = readJson(settingsSource);
		if (parsed.ok) {
			const entries = rhoEntries(parsed.value);
			if (entries.length > 0) {
				const destExists = fs.existsSync(paths.settingsPath);
				const current = destExists ? readJson(paths.settingsPath) : { ok: true as const, value: {} };
				if (!current.ok) {
					collisions.push(`isolated settings.json is not valid JSON: ${current.error}`);
				} else if (isRecord(current.value)) {
					const next = { ...current.value } as SettingsFile;
					let changed = false;
					for (const entry of entries) {
						const result = mergePackageEntry(next, entry);
						if (result === "collision") {
							collisions.push("isolated settings.json already has a different Rho package entry; left unchanged");
							changed = false;
							break;
						}
						if (result === "copied") changed = true;
					}
					if (changed) {
						atomicWrite(paths.settingsPath, `${JSON.stringify(next, null, 2)}\n`);
						actions.push(destExists ? "merged Rho package entry" : "created isolated settings.json");
					} else if (!collisions.some((item) => item.includes("settings.json"))) {
						actions.push("Rho package entry already present");
					}
				} else {
					collisions.push("isolated settings.json is not an object; left unchanged");
				}
			}
		}
	}

	for (const rel of listFiles(path.join(paths.ordinaryPiAgentDir, "sessions"))) {
		const source = path.join(paths.ordinaryPiAgentDir, "sessions", rel);
		const destination = path.join(paths.sessionDir, rel);
		if (fs.existsSync(destination)) {
			if (!sameBytes(source, destination)) {
				const warning = `sessions/${rel} exists and differs; left unchanged`;
				if (!collisions.includes(warning)) collisions.push(warning);
			}
			continue;
		}
		backupFile(source, backupRoot, path.join("sessions", rel), hooks);
		hooks?.onCopyFile?.(path.join("sessions", rel));
		copyAtomic(source, destination);
		actions.push(`copied sessions/${rel}`);
	}

	const stateSource = path.join(paths.ordinaryPiAgentDir, "rho-state.json");
	const stateDest = path.join(paths.rhoDir, "rho-state.json");
	if (fs.existsSync(stateSource) && !fs.existsSync(stateDest)) {
		backupFile(stateSource, backupRoot, "rho-state.json", hooks);
		hooks?.onCopyFile?.("rho-state.json");
		copyAtomic(stateSource, stateDest);
		actions.push("copied rho-state.json");
	}

	if (options.copyAuth === true) {
		const authSource = path.join(paths.ordinaryPiAgentDir, "auth.json");
		if (fs.existsSync(authSource) && !fs.existsSync(paths.authPath)) {
			backupFile(authSource, backupRoot, "auth.json", hooks);
			hooks?.onCopyFile?.("auth.json");
			copyAtomic(authSource, paths.authPath);
			actions.push("copied auth.json");
		}
	}

	if (options.removePackage === true && fs.existsSync(settingsSource)) {
		const parsed = readJson(settingsSource);
		if (parsed.ok && isRecord(parsed.value) && Array.isArray(parsed.value.packages)) {
			const kept = parsed.value.packages.filter((entry) => !isRhoPackage(entry));
			if (kept.length !== parsed.value.packages.length) {
				hooks?.onCopyFile?.("remove-package");
				const next = { ...parsed.value, packages: kept };
				atomicWrite(settingsSource, `${JSON.stringify(next, null, 2)}\n`);
				actions.push("removed Rho package entry from ordinary Pi");
			}
		}
	}

	writeLayoutMarker(paths);
	return {
		...preview,
		collisions,
		actions,
		wroteMarker: true,
	};
}
