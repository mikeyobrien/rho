/**
 * cli/sync-core.ts — Pure sync logic, no filesystem IO.
 *
 * Builds the Rho package entry, plans sync operations,
 * generates sync locks. All functions are pure and testable.
 */

import { REGISTRY } from "./registry.ts";
import type { RhoConfig, PackagesConfig } from "./config.ts";

// ---- Types ----

export interface RhoPackageEntry {
  source: string;
  _managed_by: "rho";
  extensions?: string[];
  skills?: string[];
}

export interface SyncLock {
  /** The package source string for Rho in pi settings.json (path or npm:...) */
  rho_source?: string;
  /** Rho package version at the time of sync (best-effort). */
  rho_version?: string;
  /** Package sources managed from ~/.rho/packages.toml */
  managed_packages: string[];
  /** ISO timestamp when sync last ran */
  last_sync: string;
}

export interface SyncPlan {
  rhoEntry: RhoPackageEntry;
  packagesToInstall: string[];
  packagesToRemove: string[];
  settingsJson: Record<string, any>;
  newSyncLock: SyncLock;
}

// ---- Build the Rho package entry ----

/**
 * Build the pi package entry for Rho based on which modules are enabled/disabled.
 * Uses exclusion-based filtering: includes known entrypoints and adds
 * `!path` patterns for disabled modules.
 *
 * Core (alwaysOn) modules are never excluded regardless of config.
 */
export function buildRhoPackageEntry(config: RhoConfig, rhoRoot: string): RhoPackageEntry {
  const extExclusions: string[] = [];
  const skillExclusions: string[] = [];

  const toExtensionExcludePattern = (p: string): string => {
    // Pi filters match discovered extension entrypoints (files), e.g.
    //   extensions/<name>/index.ts
    // Our registry uses extension directories (extensions/<name>), so exclude
    // everything under that directory.
    if (p.endsWith(".ts") || p.endsWith(".js")) return `!${p}`;
    return `!${p}/**`;
  };

  const toSkillExcludePattern = (p: string): string => {
    // Skills are discovered as skills/<name>/SKILL.md.
    // Pi's matcher special-cases SKILL.md to also match the parent directory,
    // so excluding skills/<name> works.
    return `!${p}`;
  };

  // Iterate all module categories
  const allCategories = ["core", "knowledge", "tools", "ui", "skills"] as const;
  for (const cat of allCategories) {
    const mods = config.modules[cat] ?? {};
    for (const [name, enabled] of Object.entries(mods)) {
      if (enabled) continue;

      const reg = REGISTRY[name];
      if (!reg) continue;

      // Core/alwaysOn modules cannot be disabled
      if (reg.alwaysOn) continue;

      for (const ext of reg.extensions) {
        extExclusions.push(toExtensionExcludePattern(ext));
      }
      for (const skill of reg.skills) {
        skillExclusions.push(toSkillExcludePattern(skill));
      }
    }
  }

  const entry: RhoPackageEntry = {
    source: rhoRoot,
    _managed_by: "rho",
  };

  if (extExclusions.length > 0) {
    // Include discovered extension entrypoints (index.ts + any direct .ts/.js).
    // Then layer on exclusions for disabled modules.
    entry.extensions = [
      "extensions/**/*.ts",
      "extensions/**/*.js",
      ...extExclusions,
    ];
  }

  if (skillExclusions.length > 0) {
    // Skills are directories with SKILL.md.
    entry.skills = [
      "skills/*",
      ...skillExclusions,
    ];
  }

  return entry;
}

// ---- Find Rho entry in settings.json packages ----

/**
 * Find the index of the Rho entry in a settings.json packages array.
 * Prefers `_managed_by: "rho"` marker, falls back to source path match.
 * Returns -1 if not found.
 */
export function findRhoEntryIndex(packages: any[], rhoRoot?: string): number {
  // First pass: look for _managed_by marker
  for (let i = 0; i < packages.length; i++) {
    const pkg = packages[i];
    if (typeof pkg === "object" && pkg !== null && pkg._managed_by === "rho") {
      return i;
    }
  }

  // Second pass: look for source path match
  if (rhoRoot) {
    for (let i = 0; i < packages.length; i++) {
      const pkg = packages[i];
      if (typeof pkg === "string" && pkg === rhoRoot) {
        return i;
      }
      if (typeof pkg === "object" && pkg !== null && pkg.source === rhoRoot) {
        return i;
      }
    }
  }

  return -1;
}

// ---- Build sync lock ----

/**
 * Build a sync.lock from the current packages.toml config.
 * Tracks which packages are managed by rho (from packages.toml).
 */
export function buildSyncLock(
  pkgConfig: PackagesConfig,
  meta?: { rho_source?: string; rho_version?: string; now?: string },
): SyncLock {
  return {
    rho_source: meta?.rho_source,
    rho_version: meta?.rho_version,
    managed_packages: pkgConfig.packages.map((p) => p.source),
    last_sync: meta?.now ?? new Date().toISOString(),
  };
}

// ---- Plan the full sync operation ----

interface PlanSyncInput {
  config: RhoConfig;
  pkgConfig: PackagesConfig;
  settingsJson: Record<string, any> | null;
  syncLock: SyncLock | null;
  rhoRoot: string;
  rhoVersion?: string;
}

/**
 * Plan all sync operations without performing any IO.
 * Returns the new rho entry, packages to install/remove,
 * updated settings.json, and new sync lock.
 */
export function planSync(input: PlanSyncInput): SyncPlan {
  const { config, pkgConfig, syncLock, rhoRoot } = input;

  // Build the new Rho package entry
  const rhoEntry = buildRhoPackageEntry(config, rhoRoot);

  // Start with existing settings or create fresh
  const settingsJson: Record<string, any> = input.settingsJson
    ? JSON.parse(JSON.stringify(input.settingsJson)) // deep clone
    : {};

  if (!settingsJson.packages) {
    settingsJson.packages = [];
  }

  // Find and replace/insert the Rho entry
  const existingIdx = findRhoEntryIndex(settingsJson.packages, rhoRoot);
  if (existingIdx >= 0) {
    settingsJson.packages[existingIdx] = rhoEntry;
  } else {
    settingsJson.packages.push(rhoEntry);
  }

  // Determine packages to install (in packages.toml but not in settings)
  const currentSources = new Set(
    settingsJson.packages.map((p: any) =>
      typeof p === "string" ? p : p.source
    )
  );
  const packagesToInstall = pkgConfig.packages
    .filter((p) => !currentSources.has(p.source))
    .map((p) => p.source);

  // Determine packages to remove (in previous sync.lock but not in packages.toml)
  const newManagedSources = new Set(pkgConfig.packages.map((p) => p.source));
  const prevManagedSources = syncLock?.managed_packages ?? [];
  const packagesToRemove = prevManagedSources.filter(
    (src) => !newManagedSources.has(src)
  );

  // Remove packages flagged for removal from settings.json
  if (packagesToRemove.length > 0) {
    const removeSet = new Set(packagesToRemove);
    settingsJson.packages = settingsJson.packages.filter((p: any) => {
      const src = typeof p === "string" ? p : p.source;
      return !removeSet.has(src);
    });
  }

  // Build new sync lock
  const newSyncLock = buildSyncLock(pkgConfig, { rho_source: rhoRoot, rho_version: input.rhoVersion });

  return {
    rhoEntry,
    packagesToInstall,
    packagesToRemove,
    settingsJson,
    newSyncLock,
  };
}
