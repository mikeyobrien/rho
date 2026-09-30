/**
 * cli/init-core.ts — Pure init logic, no filesystem IO.
 *
 * Generates config file contents, plans init operations,
 * detects platform. All functions are pure and testable
 * (except detectPlatform which reads process.env/os).
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { platform as osPlatform, arch as osArch } from "node:os";

// ---- Types ----

export type Platform = "android" | "macos" | "linux";

export interface InitPlan {
  name: string;
  rhoDir: string;
  platform: Platform;
  filesToCreate: Map<string, string>;
  dirsToCreate: string[];
  existingConfigs: string[];
}

export interface PlanInitInput {
  name: string;
  rhoDir: string;
  existingFiles: Set<string>;
}

/** A file to symlink: source (absolute) -> target (absolute) */
export interface SymlinkEntry {
  source: string;
  target: string;
}

export interface BootstrapPlan {
  /** Config files to create in ~/.rho/ (filename -> content). Never overwrites. */
  filesToCreate: Map<string, string>;
  /** Brain default files to copy: source path -> target path. Never overwrites. */
  brainFilesToCopy: Map<string, string>;
  /** Tmux config: source -> target. Only if target doesn't exist. */
  tmuxConfig: { source: string; target: string } | null;
  /** Platform skill directories to symlink into ~/.pi/agent/skills/ */
  platformSkillLinks: SymlinkEntry[];
  /** Platform extension files/dirs to symlink into ~/.pi/agent/extensions/ */
  platformExtensionLinks: SymlinkEntry[];
  /** Files that already existed (skipped) */
  skipped: string[];
}

export interface PlanBootstrapInput {
  name: string;
  rhoDir: string;
  piDir: string;
  platform: Platform;
  /** Files already in ~/.rho/ */
  existingRhoFiles: Set<string>;
  /** Files already in ~/.rho/brain/ */
  existingBrainFiles: Set<string>;
  /** Whether ~/.rho/tmux.conf already exists */
  tmuxConfigExists: boolean;
  /** Force overwrite template files */
  force: boolean;
}

// ---- Paths ----

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const TEMPLATES_DIR = resolve(REPO_ROOT, "templates");

// ---- Config files that init manages ----

const CONFIG_FILES = ["init.toml", "packages.toml"] as const;
const DATA_DIRS = ["brain", "vault"] as const;

// ---- Platform detection ----

/**
 * Detect the current platform.
 * Checks for Termux/Android environment variables first,
 * then falls back to os.platform().
 */
export function detectPlatform(): Platform {
  // Termux / Android detection
  if (process.env.ANDROID_ROOT || process.env.PREFIX?.includes("com.termux")) {
    return "android";
  }

  const p = osPlatform();
  if (p === "darwin") return "macos";
  return "linux"; // Default to linux for all other unix-like
}

// ---- Template generation ----

/**
 * Generate init.toml content with the agent name substituted.
 * Reads the template file and replaces the placeholder name.
 */
export function generateInitToml(name: string): string {
  const template = readFileSync(resolve(TEMPLATES_DIR, "init.toml"), "utf-8");
  // Replace the default name "rho" in the agent.name field
  // The template has: name = "rho"
  return template.replace(
    /^(name\s*=\s*)"rho"/m,
    `$1"${escapeTomlString(name)}"`,
  );
}

/**
 * Generate packages.toml content. Currently just returns the template as-is
 * since it has no name-dependent content.
 */
function generatePackagesToml(): string {
  return readFileSync(resolve(TEMPLATES_DIR, "packages.toml"), "utf-8");
}

// ---- Plan ----

/**
 * Plan the init operation. Pure function that determines what files
 * to create and what directories to ensure exist.
 *
 * Never overwrites existing files — only creates missing ones.
 */
export function planInit(input: PlanInitInput): InitPlan {
  const { name, rhoDir, existingFiles } = input;

  const filesToCreate = new Map<string, string>();
  const existingConfigs: string[] = [];

  // Generate each config file if not already present
  if (existingFiles.has("init.toml")) {
    existingConfigs.push("init.toml");
  } else {
    filesToCreate.set("init.toml", generateInitToml(name));
  }

  if (existingFiles.has("packages.toml")) {
    existingConfigs.push("packages.toml");
  } else {
    filesToCreate.set("packages.toml", generatePackagesToml());
  }

  // Data directories are always in the plan (mkdir -p is idempotent)
  const dirsToCreate = [...DATA_DIRS];

  return {
    name,
    rhoDir,
    platform: detectPlatform(),
    filesToCreate,
    dirsToCreate,
    existingConfigs,
  };
}

// ---- Bootstrap Plan ----

/**
 * Plan the full bootstrap: templates, brain defaults, tmux config, platform symlinks.
 * This is everything `install.sh` used to do after `rho init` + `rho sync`.
 * Now it lives here so `rho init` alone is sufficient for the npm install route.
 */
export function planBootstrap(input: PlanBootstrapInput): BootstrapPlan {
  const {
    name,
    rhoDir,
    piDir,
    platform,
    existingRhoFiles,
    existingBrainFiles,
    tmuxConfigExists,
    force,
  } = input;

  const filesToCreate = new Map<string, string>();
  const skipped: string[] = [];

  // Config files (init.toml, packages.toml) are handled by planInit
  // AGENTS.md, SOUL.md, RHO.md, HEARTBEAT.md removed — brain.jsonl is now the single source of truth.
  // Identity/behavior/principles live as entries in brain.jsonl.

  // ---- Brain defaults ----
  const brainFilesToCopy = new Map<string, string>();
  const brainDefaultsDir = resolve(REPO_ROOT, "brain");
  if (existsSync(brainDefaultsDir)) {
    for (const f of readdirSync(brainDefaultsDir)) {
      if (!f.endsWith(".default")) continue;
      const targetName = f.replace(".default", "");
      if (!existingBrainFiles.has(targetName)) {
        brainFilesToCopy.set(
          resolve(brainDefaultsDir, f),
          resolve(rhoDir, "brain", targetName),
        );
      }
    }
  }

  // ---- Tmux config ----
  let tmuxConfig: BootstrapPlan["tmuxConfig"] = null;
  const tmuxSrc = resolve(REPO_ROOT, "configs", "tmux-rho.conf");
  if (existsSync(tmuxSrc) && !tmuxConfigExists) {
    tmuxConfig = { source: tmuxSrc, target: resolve(rhoDir, "tmux.conf") };
  }

  // ---- Platform skills ----
  const platformSkillLinks: SymlinkEntry[] = [];
  const platSkillsDir = resolve(REPO_ROOT, "platforms", platform, "skills");
  if (existsSync(platSkillsDir)) {
    const skillsDest = resolve(piDir, "skills");
    for (const d of readdirSync(platSkillsDir)) {
      const skillDir = resolve(platSkillsDir, d);
      const skillMd = resolve(skillDir, "SKILL.md");
      if (existsSync(skillMd)) {
        platformSkillLinks.push({
          source: skillDir,
          target: resolve(skillsDest, d),
        });
      }
    }
  }

  // ---- Platform extensions ----
  const platformExtensionLinks: SymlinkEntry[] = [];
  const platExtDir = resolve(REPO_ROOT, "platforms", platform, "extensions");
  if (existsSync(platExtDir)) {
    const extDest = resolve(piDir, "extensions");
    for (const entry of readdirSync(platExtDir)) {
      const entryPath = resolve(platExtDir, entry);
      // Single .ts file or directory with index.ts
      if (entry.endsWith(".ts")) {
        platformExtensionLinks.push({
          source: entryPath,
          target: resolve(extDest, entry),
        });
      } else if (
        existsSync(resolve(entryPath, "index.ts")) ||
        existsSync(resolve(entryPath, "index.js"))
      ) {
        platformExtensionLinks.push({
          source: entryPath,
          target: resolve(extDest, entry),
        });
      }
    }
  }

  return {
    filesToCreate,
    brainFilesToCopy,
    tmuxConfig,
    platformSkillLinks,
    platformExtensionLinks,
    skipped,
  };
}

// ---- Helpers ----

/**
 * Escape a string for use in a TOML quoted string value.
 * Handles backslashes and quotes.
 */
function escapeTomlString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
