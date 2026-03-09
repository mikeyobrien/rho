/**
 * rho sync — Reconcile init.toml + packages.toml with pi settings.json.
 *
 * Reads config, builds exclusion-based filter, writes settings.json,
 * installs/removes packages.toml entries via `pi install/remove`,
 * writes sync.lock, creates data dirs, and applies select module settings
 * (currently: heartbeat interval).
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { migrateLegacyMemoryConfigToInitToml } from "../../extensions/lib/memory-settings.ts";
import {
	type PackageEntry,
	parseInitToml,
	parsePackagesToml,
	validateConfig,
} from "../config.ts";
import { PID_FILE } from "../daemon-core.ts";
import {
	type SyncLock,
	collectExternalModulePackages,
	findRhoEntryIndex,
	planSync,
} from "../sync-core.ts";

const HOME = process.env.HOME || os.homedir();
const RHO_DIR = path.join(HOME, ".rho");
const SETTINGS_PATH = path.join(HOME, ".pi", "agent", "settings.json");
const INIT_TOML = path.join(RHO_DIR, "init.toml");
const PACKAGES_TOML = path.join(RHO_DIR, "packages.toml");
const SYNC_LOCK = path.join(RHO_DIR, "sync.lock");
const HB_STATE_PATH = path.join(RHO_DIR, "rho-state.json");
const PID_PATH = path.join(HOME, PID_FILE);

// Data directories to ensure exist
const DATA_DIRS = [path.join(RHO_DIR, "brain"), path.join(RHO_DIR, "vault")];

type JsonMap = Record<string, unknown>;

type ManagedPackageEntry = {
	source: string;
	extensions?: string[];
	skills?: string[];
	[key: string]: unknown;
};

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export async function run(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		console.log(`rho sync

Reconcile ~/.rho/init.toml and packages.toml with pi settings.

Reads your Rho config, builds module filters, updates
~/.pi/agent/settings.json, installs/removes third-party packages
declared in packages.toml, and writes ~/.rho/sync.lock.

Options:
  --dry-run    Show what would change without writing or installing
  --verbose    Show detailed output`);
		return;
	}

	const dryRun = args.includes("--dry-run");
	const verbose = args.includes("--verbose");

	// ---- 1. Read init.toml ----
	if (!fs.existsSync(INIT_TOML)) {
		console.error(`Error: ${INIT_TOML} not found.\nRun \`rho init\` first.`);
		process.exit(1);
	}

	const migratedMemorySettings = migrateLegacyMemoryConfigToInitToml(INIT_TOML);
	if (migratedMemorySettings.changed && verbose) {
		console.log(
			`  Migrated legacy memory settings to init.toml: ${migratedMemorySettings.migratedKeys.join(", ")}`,
		);
	}

	let config: ReturnType<typeof parseInitToml>;
	try {
		const content = fs.readFileSync(INIT_TOML, "utf-8");
		config = parseInitToml(content);
	} catch (err: unknown) {
		console.error(`Error parsing init.toml: ${toErrorMessage(err)}`);
		process.exit(1);
	}

	const validation = validateConfig(config);
	if (!validation.valid) {
		console.error("Config validation errors:");
		for (const e of validation.errors) console.error(`  - ${e}`);
		process.exit(1);
	}
	if (validation.warnings.length > 0 && verbose) {
		console.log("Config warnings:");
		for (const w of validation.warnings) console.log(`  ! ${w}`);
	}

	// ---- 2. Read packages.toml ----
	let pkgConfig: { packages: PackageEntry[] };
	if (fs.existsSync(PACKAGES_TOML)) {
		try {
			const content = fs.readFileSync(PACKAGES_TOML, "utf-8");
			pkgConfig = parsePackagesToml(content);
		} catch (err: unknown) {
			console.error(`Error parsing packages.toml: ${toErrorMessage(err)}`);
			process.exit(1);
		}
	} else {
		pkgConfig = { packages: [] };
	}

	// ---- 2b. Inject npm-backed registry modules ----
	const externalModulePkgs = collectExternalModulePackages(config);
	const existingSources = new Set(pkgConfig.packages.map((p) => p.source));
	for (const ext of externalModulePkgs) {
		if (!existingSources.has(ext.source)) {
			pkgConfig.packages.push(ext);
		}
	}

	// ---- 3. Read settings.json (if exists) ----
	const settingsJsonBefore = readJsonFile(SETTINGS_PATH);

	// ---- 4. Read sync.lock (if exists) ----
	const syncLockBefore = readJsonFile(SYNC_LOCK) as SyncLock | null;

	// ---- 5. Determine rho source string ----
	const rhoRootOnDisk = resolveRhoRootOnDisk();
	const pkgName = readPackageName(rhoRootOnDisk) ?? "@rhobot-dev/rho";
	const rhoVersion = readPackageVersion(rhoRootOnDisk);

	const rhoSourceOverride = (process.env.RHO_SOURCE || "").trim();
	const rhoSource = rhoSourceOverride
		? rhoSourceOverride
		: pickRhoSource({
				settingsJson: settingsJsonBefore,
				rhoRootOnDisk,
				pkgName,
			});

	// ---- 6. Plan (based on current settings) ----
	const planBefore = planSync({
		config,
		pkgConfig,
		settingsJson: settingsJsonBefore,
		syncLock: syncLockBefore,
		rhoRoot: rhoSource,
		rhoVersion: rhoVersion ?? undefined,
	});

	if (verbose || dryRun) {
		console.log("Sync plan:");
		console.log(`  Rho source: ${rhoSource}`);
		const extEx =
			planBefore.rhoEntry.extensions?.filter((p) => p.startsWith("!")) ?? [];
		const skEx =
			planBefore.rhoEntry.skills?.filter((p) => p.startsWith("!")) ?? [];
		console.log(
			`  Disabled module exclusions: ${extEx.length} extensions, ${skEx.length} skills`,
		);

		if (planBefore.packagesToInstall.length > 0) {
			console.log(
				`  Install (${planBefore.packagesToInstall.length}): ${planBefore.packagesToInstall.join(", ")}`,
			);
		}
		if (planBefore.packagesToRemove.length > 0) {
			console.log(
				`  Remove (${planBefore.packagesToRemove.length}): ${planBefore.packagesToRemove.join(", ")}`,
			);
		}

		const filteredPkgs = pkgConfig.packages.filter(
			(p) => p.extensions || p.skills,
		);
		if (filteredPkgs.length > 0) {
			console.log(
				`  Package filters: ${filteredPkgs.length} package(s) specify extensions/skills filters`,
			);
		}
	}

	if (dryRun) {
		console.log("\nDry run — no changes written.");
		return;
	}

	// ---- 7. Install/remove third-party packages via pi ----
	// We do this before writing settings.json so pi can add any missing entries,
	// then we re-read settings.json and apply our managed edits.
	if (
		planBefore.packagesToInstall.length > 0 ||
		planBefore.packagesToRemove.length > 0
	) {
		ensurePiAvailable();
	}

	for (const src of planBefore.packagesToInstall) {
		const r = runPi(["install", src], { verbose });
		if (!r.ok) {
			console.error(`Error: pi install failed for ${src}`);
			const msg = (r.stderr || r.stdout || "").trim();
			if (msg) console.error(msg);
			if (!verbose) console.error("Re-run with --verbose for full output.");
			process.exit(1);
		}
	}

	for (const src of planBefore.packagesToRemove) {
		const r = runPi(["remove", src], { verbose });
		if (!r.ok) {
			console.error(`Error: pi remove failed for ${src}`);
			const msg = (r.stderr || r.stdout || "").trim();
			if (msg) console.error(msg);
			if (!verbose) console.error("Re-run with --verbose for full output.");
			process.exit(1);
		}
	}

	// ---- 7b. Install npm dependencies for dev-mode (git checkout) ----
	// When running from a local clone, new deps added to package.json won't
	// exist until `npm install` runs. End-users who install via npm get this
	// for free, but dev-mode users (git pull) need it here.
	const rhoRoot = resolveRhoRootOnDisk();
	if (
		fs.existsSync(path.join(rhoRoot, ".git")) &&
		fs.existsSync(path.join(rhoRoot, "package.json"))
	) {
		const nodeModulesOk = fs.existsSync(path.join(rhoRoot, "node_modules"));
		const pkgJson = JSON.parse(
			fs.readFileSync(path.join(rhoRoot, "package.json"), "utf-8"),
		);
		const declaredDeps = Object.keys(pkgJson.dependencies || {});
		const missingDeps = declaredDeps.some(
			(dep) => !fs.existsSync(path.join(rhoRoot, "node_modules", dep)),
		);
		if (!nodeModulesOk || missingDeps) {
			if (verbose) console.log("  Installing npm dependencies (dev mode)...");
			const r = spawnSync("npm", ["install"], {
				cwd: rhoRoot,
				stdio: verbose ? "inherit" : "pipe",
				encoding: "utf-8",
			});
			if (r.status !== 0) {
				console.error("Warning: npm install failed in dev checkout");
				if (!verbose) {
					const msg = (r.stderr || r.stdout || "").trim();
					if (msg) console.error(msg);
				}
			} else if (verbose) {
				console.log("  npm dependencies installed.");
			}
		}
	}

	// ---- 8. Re-read settings.json after pi install/remove ----
	const settingsJsonAfter = readJsonFile(SETTINGS_PATH);

	// ---- 9. Re-plan using updated settings ----
	const plan = planSync({
		config,
		pkgConfig,
		settingsJson: settingsJsonAfter,
		syncLock: syncLockBefore,
		rhoRoot: rhoSource,
		rhoVersion: rhoVersion ?? undefined,
	});

	// ---- 10. Apply per-package filters for packages.toml managed packages ----
	applyPackagesTomlFilters(plan.settingsJson, pkgConfig.packages);

	// ---- 11. Write settings.json + sync.lock ----
	fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
	fs.writeFileSync(
		SETTINGS_PATH,
		`${JSON.stringify(plan.settingsJson, null, 2)}\n`,
	);

	fs.mkdirSync(RHO_DIR, { recursive: true });
	fs.writeFileSync(SYNC_LOCK, `${JSON.stringify(plan.newSyncLock, null, 2)}\n`);

	// ---- 12. Create data directories ----
	for (const dir of DATA_DIRS) {
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
			if (verbose) console.log(`  Created ${dir}`);
		}
	}

	// ---- 13. Apply module settings ----
	const hbInterval = config.settings?.heartbeat?.interval;
	if (typeof hbInterval === "string") {
		const ok = applyHeartbeatIntervalSetting(hbInterval, { verbose });
		if (!ok) {
			console.warn(
				`Warning: could not apply [settings.heartbeat].interval = ${JSON.stringify(hbInterval)}`,
			);
		}
	}

	// ---- 13b. Ask running daemon to reload web config (best-effort) ----
	signalDaemonReload({ verbose });

	// ---- 14. Print result summary ----
	const parts: string[] = [];
	const disabledNames = getDisabledModuleNames(config);
	if (disabledNames.length > 0)
		parts.push(`disabled: ${disabledNames.join(", ")}`);
	if (planBefore.packagesToInstall.length > 0)
		parts.push(`${planBefore.packagesToInstall.length} package(s) installed`);
	if (planBefore.packagesToRemove.length > 0)
		parts.push(`${planBefore.packagesToRemove.length} package(s) removed`);

	console.log(
		parts.length > 0
			? `Synced: ${parts.join(", ")}.`
			: "Synced: no changes needed.",
	);
}

function getDisabledModuleNames(
	config: ReturnType<typeof parseInitToml>,
): string[] {
	const names: string[] = [];
	for (const cat of Object.values(config.modules) as Record<
		string,
		boolean
	>[]) {
		for (const [name, enabled] of Object.entries(cat)) {
			if (!enabled) names.push(name);
		}
	}
	return names;
}

function resolveRhoRootOnDisk(): string {
	// This file is cli/commands/sync.ts
	const here = path.dirname(fileURLToPath(import.meta.url));
	return path.resolve(here, "..", "..");
}

function readPackageName(rhoRootOnDisk: string): string | null {
	try {
		const pkgPath = path.join(rhoRootOnDisk, "package.json");
		const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
		return typeof pkg.name === "string" ? pkg.name : null;
	} catch {
		return null;
	}
}

function readPackageVersion(rhoRootOnDisk: string): string | null {
	try {
		const pkgPath = path.join(rhoRootOnDisk, "package.json");
		const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
		return typeof pkg.version === "string" ? pkg.version : null;
	} catch {
		return null;
	}
}

function pickRhoSource(input: {
	settingsJson: JsonMap | null;
	rhoRootOnDisk: string;
	pkgName: string;
}): string {
	const npmSource = `npm:${input.pkgName}`;

	const packages = input.settingsJson?.packages;
	if (Array.isArray(packages)) {
		// Prefer an existing managed entry (marker), then source path match.
		const idx = findRhoEntryIndex(packages, input.rhoRootOnDisk);
		if (idx >= 0) {
			const entry = packages[idx];
			if (typeof entry === "string") return entry;
			if (
				entry &&
				typeof entry === "object" &&
				typeof entry.source === "string"
			)
				return entry.source;
		}

		// Back-compat: if user already uses npm source, keep it.
		if (findPackageIndex(packages, npmSource) >= 0) return npmSource;
		if (findPackageIndex(packages, input.rhoRootOnDisk) >= 0)
			return input.rhoRootOnDisk;
	}

	// If we're in a git checkout, prefer the path on disk (dev-friendly).
	if (fs.existsSync(path.join(input.rhoRootOnDisk, ".git"))) {
		return input.rhoRootOnDisk;
	}

	// Prefer npm:... only if it appears to exist on the registry.
	if (npmPackageExists(input.pkgName)) {
		return npmSource;
	}

	// Fallback: absolute path to the package directory we are running from.
	return input.rhoRootOnDisk;
}

function npmPackageExists(pkgName: string): boolean {
	try {
		const r = spawnSync("npm", ["view", pkgName, "version"], {
			encoding: "utf-8",
			timeout: 3000,
			stdio: ["ignore", "pipe", "pipe"],
		});
		return r.status === 0 && Boolean((r.stdout || "").trim());
	} catch {
		return false;
	}
}

function readJsonFile(filePath: string): JsonMap | null {
	try {
		if (!fs.existsSync(filePath)) return null;
		const raw = fs.readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(raw) as unknown;
		if (parsed && typeof parsed === "object") return parsed as JsonMap;
	} catch {
		// ignore
	}
	return null;
}

function readDaemonPid(): number | null {
	try {
		const content = fs.readFileSync(PID_PATH, "utf-8").trim();
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

function signalDaemonReload(opts: { verbose: boolean }): void {
	// Best-effort: if the daemon is running, ask it to reload init.toml.
	const pid = readDaemonPid();
	if (pid === null) return;
	if (!pidAlive(pid)) return;

	try {
		process.kill(pid, "SIGHUP");
		if (opts.verbose)
			console.log("  Signaled daemon to reload config (SIGHUP)");
	} catch {
		// ignore
	}
}

function ensurePiAvailable(): void {
	const r = spawnSync("pi", ["--help"], { encoding: "utf-8" });
	if (r.error || r.status !== 0) {
		console.error(
			"Error: `pi` not found or not working. Install: npm i -g @mariozechner/pi-coding-agent",
		);
		process.exit(1);
	}
}

function runPi(
	args: string[],
	opts: { verbose: boolean },
): {
	ok: boolean;
	status: number | null;
	stdout: string;
	stderr: string;
} {
	const r = spawnSync("pi", args, {
		stdio: opts.verbose ? "inherit" : "pipe",
		encoding: "utf-8",
	});

	return {
		ok: r.status === 0,
		status: r.status ?? null,
		stdout: typeof r.stdout === "string" ? r.stdout : "",
		stderr: typeof r.stderr === "string" ? r.stderr : "",
	};
}

function findPackageIndex(packages: unknown[], source: string): number {
	for (let i = 0; i < packages.length; i++) {
		const p = packages[i];
		if (typeof p === "string" && p === source) return i;
		if (p && typeof p === "object" && p.source === source) return i;
	}
	return -1;
}

function applyPackagesTomlFilters(
	settingsJson: JsonMap,
	packagesToml: PackageEntry[],
): void {
	const packages = Array.isArray(settingsJson.packages)
		? settingsJson.packages
		: null;
	if (!packages) return;

	for (const pkg of packagesToml) {
		const idx = findPackageIndex(packages, pkg.source);
		const hasFilters = pkg.extensions !== undefined || pkg.skills !== undefined;

		if (idx === -1) {
			if (!hasFilters) {
				packages.push(pkg.source);
			} else {
				const entry: ManagedPackageEntry = { source: pkg.source };
				if (pkg.extensions !== undefined) entry.extensions = pkg.extensions;
				if (pkg.skills !== undefined) entry.skills = pkg.skills;
				packages.push(entry);
			}
			continue;
		}

		const current = packages[idx];
		if (typeof current === "string") {
			if (!hasFilters) continue;
			const next: ManagedPackageEntry = { source: pkg.source };
			if (pkg.extensions !== undefined) next.extensions = pkg.extensions;
			if (pkg.skills !== undefined) next.skills = pkg.skills;
			packages[idx] = next;
			continue;
		}

		if (current && typeof current === "object") {
			const next: ManagedPackageEntry = {
				...(current as Record<string, unknown>),
				source: pkg.source,
			};

			if (pkg.extensions !== undefined) next.extensions = pkg.extensions;
			else next.extensions = undefined;

			if (pkg.skills !== undefined) next.skills = pkg.skills;
			else next.skills = undefined;

			packages[idx] = next;
		}
	}
}

function applyHeartbeatIntervalSetting(
	interval: string,
	opts: { verbose: boolean },
): boolean {
	const ms = parseIntervalToMs(interval);
	if (ms === null) return false;

	try {
		fs.mkdirSync(RHO_DIR, { recursive: true });

		const prev = readJsonFile(HB_STATE_PATH) ?? {};
		const next: JsonMap = { ...prev };

		next.intervalMs = ms;
		if (ms === 0) {
			next.enabled = false;
		} else {
			// Default to enabled true if missing; otherwise preserve user's explicit disable.
			if (typeof next.enabled !== "boolean") next.enabled = true;
		}

		fs.writeFileSync(HB_STATE_PATH, `${JSON.stringify(next, null, 2)}\n`);
		if (opts.verbose) {
			console.log(`  Applied heartbeat interval: ${interval} (${ms}ms)`);
		}
		return true;
	} catch {
		return false;
	}
}

function parseIntervalToMs(input: string): number | null {
	const trimmed = input.trim().toLowerCase();
	if (trimmed === "0") return 0;

	const match = trimmed.match(
		/^(\d+)\s*(m|min|minute|minutes|h|hr|hour|hours)?$/,
	);
	if (!match) return null;

	const value = Number.parseInt(match[1], 10);
	if (!Number.isFinite(value)) return null;

	const unit = match[2] || "m";
	if (unit.startsWith("h")) return value * 60 * 60 * 1000;
	return value * 60 * 1000;
}
