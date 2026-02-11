/**
 * rho doctor — Diagnose Rho installation health.
 *
 * Checks system dependencies, config files, module paths,
 * pi integration, data directories, and auth status.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { parseInitToml, parsePackagesToml } from "../config.ts";
import { REGISTRY } from "../registry.ts";
import { findRhoEntryIndex, buildRhoPackageEntry } from "../sync-core.ts";
import {
  runAllChecks,
  formatResults,
  summaryCounts,
  type DoctorInput,
} from "../doctor-core.ts";

const HOME = process.env.HOME || os.homedir();
const RHO_DIR = path.join(HOME, ".rho");
const SETTINGS_PATH = path.join(HOME, ".pi", "agent", "settings.json");
const PI_AUTH_PATH = path.join(HOME, ".pi", "agent", "auth.json");
const RHO_CLOUD_CREDS = path.join(HOME, ".config", "rho-cloud", "credentials.json");

export async function run(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`rho doctor

Check Rho installation health. Verifies system dependencies,
config files, module paths, pi integration, and auth status.

Options:
  --verbose    Show all checks including passing ones
  --json       Output results as JSON`);
    return;
  }

  const jsonOutput = args.includes("--json");

  const input = gatherDoctorInput();
  const results = runAllChecks(input);
  const counts = summaryCounts(results);

  if (jsonOutput) {
    console.log(JSON.stringify({ checks: results, summary: counts }, null, 2));
    return;
  }

  console.log(formatResults(results));
  console.log("");

  const RESET = "\x1b[0m";
  const parts: string[] = [];
  if (counts.ok > 0) parts.push(`\x1b[32m${counts.ok} ok${RESET}`);
  if (counts.warn > 0) parts.push(`\x1b[33m${counts.warn} warning${counts.warn > 1 ? "s" : ""}${RESET}`);
  if (counts.fail > 0) parts.push(`\x1b[31m${counts.fail} error${counts.fail > 1 ? "s" : ""}${RESET}`);
  console.log(parts.join(", "));

  if (counts.fail > 0) process.exit(1);
}

function gatherDoctorInput(): DoctorInput {
  // Try PATH first, fall back to node's bin directory (nvm support)
  const piInfo = getBinaryInfo("pi");
  return {
    nodeVersion: getVersion("node", "--version"),
    binaries: {
      tmux: getBinaryInfo("tmux"),
      git: getBinaryInfo("git"),
      pi: piInfo.exists ? piInfo : getBinaryInfo(path.join(path.dirname(process.execPath), "pi")),
    },
    configFiles: getConfigFileStatus(),
    moduleFiles: getModuleFileStatus(),
    piIntegration: getPiIntegrationStatus(),
    dataDirs: {
      brain: fs.existsSync(path.join(RHO_DIR, "brain")),
      vault: fs.existsSync(path.join(RHO_DIR, "vault")),
    },
    auth: {
      pi: fs.existsSync(PI_AUTH_PATH),
      "rho-cloud": fs.existsSync(RHO_CLOUD_CREDS),
    },
    emailModuleEnabled: isEmailModuleEnabled(),
  };
}

function getVersion(binary: string, flag: string): string | null {
  try {
    return execSync(`${binary} ${flag}`, {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

const VERSION_FLAGS: Record<string, string> = {
  tmux: "-V",
};

function getBinaryInfo(name: string): { version: string | null; exists: boolean } {
  const versionFlag = VERSION_FLAGS[name] ?? "--version";
  const version = getVersion(name, versionFlag);
  if (version === null) return { version: null, exists: false };
  const match = version.match(/(\d+[\d.]*\d+)/);
  return { version: match ? match[1] : version, exists: true };
}

function getConfigFileStatus(): Record<string, { exists: boolean; parseError: string | null }> {
  const result: Record<string, { exists: boolean; parseError: string | null }> = {};

  const initPath = path.join(RHO_DIR, "init.toml");
  if (fs.existsSync(initPath)) {
    try {
      parseInitToml(fs.readFileSync(initPath, "utf-8"));
      result["init.toml"] = { exists: true, parseError: null };
    } catch (err: any) {
      result["init.toml"] = { exists: true, parseError: err.message };
    }
  } else {
    result["init.toml"] = { exists: false, parseError: null };
  }

  const pkgPath = path.join(RHO_DIR, "packages.toml");
  if (fs.existsSync(pkgPath)) {
    try {
      parsePackagesToml(fs.readFileSync(pkgPath, "utf-8"));
      result["packages.toml"] = { exists: true, parseError: null };
    } catch (err: any) {
      result["packages.toml"] = { exists: true, parseError: err.message };
    }
  } else {
    result["packages.toml"] = { exists: false, parseError: null };
  }

  return result;
}

function getModuleFileStatus(): Map<string, { missing: string[] }> {
  const result = new Map<string, { missing: string[] }>();

  const rhoRootOnDisk = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const enabledModules = getEnabledModules();

  for (const name of enabledModules) {
    const reg = REGISTRY[name];
    if (!reg) continue;

    const missing: string[] = [];
    for (const ext of reg.extensions) {
      const fullPath = path.join(rhoRootOnDisk, ext);
      if (!fs.existsSync(fullPath)) missing.push(ext);
    }
    for (const skill of reg.skills) {
      const fullPath = path.join(rhoRootOnDisk, skill);
      if (!fs.existsSync(fullPath)) missing.push(skill);
    }

    result.set(name, { missing });
  }

  return result;
}

function getPiIntegrationStatus(): { settingsExists: boolean; rhoEntryFound: boolean; rhoEntryInSync: boolean | null } {
  if (!fs.existsSync(SETTINGS_PATH)) {
    return { settingsExists: false, rhoEntryFound: false, rhoEntryInSync: null };
  }

  try {
    const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf-8"));
    const packages = settings.packages ?? [];

    const rhoRootOnDisk = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
    const idx = findRhoEntryIndex(packages, rhoRootOnDisk);
    if (idx < 0) {
      return { settingsExists: true, rhoEntryFound: false, rhoEntryInSync: null };
    }

    const entry = packages[idx];
    const source = typeof entry === "string" ? entry : entry?.source;
    if (typeof source !== "string") {
      return { settingsExists: true, rhoEntryFound: true, rhoEntryInSync: null };
    }

    // Compare expected vs actual filters if init.toml parses.
    const initPath = path.join(RHO_DIR, "init.toml");
    if (!fs.existsSync(initPath)) {
      return { settingsExists: true, rhoEntryFound: true, rhoEntryInSync: null };
    }

    let config;
    try {
      config = parseInitToml(fs.readFileSync(initPath, "utf-8"));
    } catch {
      return { settingsExists: true, rhoEntryFound: true, rhoEntryInSync: null };
    }

    const expected = buildRhoPackageEntry(config, source);

    const actualObj = typeof entry === "string" ? { source: entry } : entry;
    const actual = {
      source: actualObj?.source,
      _managed_by: actualObj?._managed_by,
      extensions: actualObj?.extensions,
      skills: actualObj?.skills,
    };

    const inSync =
      actual._managed_by === "rho" &&
      deepEqual(expected.extensions, actual.extensions) &&
      deepEqual(expected.skills, actual.skills);

    return { settingsExists: true, rhoEntryFound: true, rhoEntryInSync: inSync };
  } catch {
    return { settingsExists: true, rhoEntryFound: false, rhoEntryInSync: null };
  }
}

function deepEqual(a: any, b: any): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function getEnabledModules(): string[] {
  const initPath = path.join(RHO_DIR, "init.toml");
  if (!fs.existsSync(initPath)) return Object.keys(REGISTRY);

  try {
    const config = parseInitToml(fs.readFileSync(initPath, "utf-8"));
    const enabled: string[] = [];

    for (const [name, reg] of Object.entries(REGISTRY)) {
      if (reg.alwaysOn) {
        enabled.push(name);
        continue;
      }
      const cat = reg.category as keyof typeof config.modules;
      const val = config.modules[cat]?.[name];
      if (val !== false) enabled.push(name);
    }

    return enabled;
  } catch {
    return Object.keys(REGISTRY);
  }
}

function isEmailModuleEnabled(): boolean {
  return getEnabledModules().includes("email");
}
