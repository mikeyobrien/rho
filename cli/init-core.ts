/**
 * cli/init-core.ts — Pure init logic, no filesystem IO.
 *
 * Generates config file contents, plans init operations,
 * detects platform. All functions are pure and testable
 * (except detectPlatform which reads process.env/os).
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { platform as osPlatform, homedir, arch as osArch } from "node:os";

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
  /** Template files to create in ~/.rho/ (filename -> content). Never overwrites. */
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
const SOUL_TEMPLATE = resolve(REPO_ROOT, "SOUL.md.template");

// ---- Config files that init manages ----

const CONFIG_FILES = ["init.toml", "packages.toml", "SOUL.md"] as const;
const DATA_DIRS = ["brain", "vault"] as const;

// ---- Platform detection ----

/**
 * Detect the current platform.
 * Checks for Termux/Android environment variables first,
 * then falls back to os.platform().
 */
export function detectPlatform(): Platform {
  // Termux / Android detection
  if (
    process.env.ANDROID_ROOT ||
    process.env.PREFIX?.includes("com.termux")
  ) {
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
 * Generate SOUL.md content with the agent name substituted.
 * Reads the SOUL.md.template and replaces {{NAME}} placeholders.
 */
export function generateSoulMd(name: string): string {
  const template = readFileSync(SOUL_TEMPLATE, "utf-8");
  return template.replace(/\{\{NAME\}\}/g, name);
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
  if (!existingFiles.has("init.toml")) {
    filesToCreate.set("init.toml", generateInitToml(name));
  } else {
    existingConfigs.push("init.toml");
  }

  if (!existingFiles.has("packages.toml")) {
    filesToCreate.set("packages.toml", generatePackagesToml());
  } else {
    existingConfigs.push("packages.toml");
  }

  if (!existingFiles.has("SOUL.md")) {
    filesToCreate.set("SOUL.md", generateSoulMd(name));
  } else {
    existingConfigs.push("SOUL.md");
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
    name, rhoDir, piDir, platform,
    existingRhoFiles, existingBrainFiles, tmuxConfigExists, force,
  } = input;

  const filesToCreate = new Map<string, string>();
  const skipped: string[] = [];

  // AGENTS.md, RHO.md, HEARTBEAT.md removed — brain.jsonl is now the single source of truth.
  // Identity/behavior data lives in brain entries; heartbeat reads reminders/tasks from brain.

  // ---- Brain defaults ----
  const brainFilesToCopy = new Map<string, string>();
  const brainDefaultsDir = resolve(REPO_ROOT, "brain");
  if (existsSync(brainDefaultsDir)) {
    for (const f of readdirSync(brainDefaultsDir)) {
      if (!f.endsWith(".jsonl.default")) continue;
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

// ---- Template generation (AGENTS.md) ----

/**
 * Generate AGENTS.md content with environment-specific variable substitution.
 */
export function generateAgentsMd(name: string, piDir: string, rhoDir: string): string {
  const HOME = process.env.HOME || homedir();
  const brainDir = resolve(rhoDir, "brain");
  const skillsDir = resolve(piDir, "skills");

  let osString: string;
  const platform = detectPlatform();
  if (platform === "android") {
    osString = `Android / Termux ${process.env.TERMUX_VERSION || ""}`.trim();
  } else {
    try {
      const osRelease = readFileSync("/etc/os-release", "utf-8");
      const match = osRelease.match(/^PRETTY_NAME="?([^"\n]*)"?/m);
      osString = match?.[1] || process.platform;
    } catch {
      osString = process.platform === "darwin" ? "macOS" : process.platform;
    }
  }

  const desc = "An AI agent powered by rho: persistent memory, heartbeat check-ins, and a knowledge vault.";
  const shell = basename(process.env.SHELL || "sh");

  const template = readFileSync(resolve(REPO_ROOT, "AGENTS.md.template"), "utf-8");
  return template
    .replace(/\{\{NAME\}\}/g, name)
    .replace(/\{\{DESCRIPTION\}\}/g, desc)
    .replace(/\{\{OS\}\}/g, osString)
    .replace(/\{\{ARCH\}\}/g, osArch())
    .replace(/\{\{SHELL\}\}/g, shell)
    .replace(/\{\{HOME\}\}/g, HOME)
    .replace(/\{\{CONFIG_PATH\}\}/g, piDir)
    .replace(/\{\{BRAIN_PATH\}\}/g, brainDir)
    .replace(/\{\{RHO_DIR\}\}/g, rhoDir)
    .replace(/\{\{SKILLS_PATH\}\}/g, skillsDir);
}

// ---- Helpers ----

/**
 * Escape a string for use in a TOML quoted string value.
 * Handles backslashes and quotes.
 */
function escapeTomlString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
