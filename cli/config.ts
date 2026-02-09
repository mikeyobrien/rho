/**
 * cli/config.ts — TOML config parser and validator for Rho.
 *
 * Parses ~/.rho/init.toml and ~/.rho/packages.toml into typed structures.
 * Validates config against the module registry.
 */

import { parse as parseToml } from "smol-toml";
import { REGISTRY } from "./registry.ts";

// ---- Types ----

export interface WebConfig {
  enabled: boolean;
  port: number;
}

export interface RhoConfig {
  agent: {
    name: string;
  };
  modules: {
    core: Record<string, boolean>;
    knowledge: Record<string, boolean>;
    tools: Record<string, boolean>;
    ui: Record<string, boolean>;
    skills: Record<string, boolean>;
  };
  settings: Record<string, Record<string, unknown>>;
  web: WebConfig;
}

export interface PackageEntry {
  source: string;
  extensions?: string[];
  skills?: string[];
}

export interface PackagesConfig {
  packages: PackageEntry[];
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// ---- Module categories ----

const MODULE_CATEGORIES = ["core", "knowledge", "tools", "ui", "skills"] as const;
type ModuleCategory = (typeof MODULE_CATEGORIES)[number];

// ---- Parsing ----

/**
 * Parse an init.toml string into a typed RhoConfig.
 * Throws on invalid TOML, missing required fields, or type mismatches.
 */
export function parseInitToml(content: string): RhoConfig {
  const raw = parseToml(content) as Record<string, unknown>;

  // Require [agent] section
  if (!raw.agent || typeof raw.agent !== "object") {
    throw new Error("Missing required [agent] section in init.toml");
  }
  const agent = raw.agent as Record<string, unknown>;
  if (typeof agent.name !== "string") {
    throw new Error("Missing required agent.name (string) in init.toml");
  }

  // Parse [modules.*] sections
  const rawModules = (raw.modules ?? {}) as Record<string, unknown>;
  const modules: RhoConfig["modules"] = {
    core: {},
    knowledge: {},
    tools: {},
    ui: {},
    skills: {},
  };

  for (const cat of MODULE_CATEGORIES) {
    const section = rawModules[cat];
    if (section == null) continue;
    if (typeof section !== "object") {
      throw new Error(`[modules.${cat}] must be a table`);
    }
    const entries = section as Record<string, unknown>;
    for (const [key, val] of Object.entries(entries)) {
      if (typeof val !== "boolean") {
        throw new Error(
          `Module "${key}" in [modules.${cat}] must be boolean, got ${typeof val}`
        );
      }
      modules[cat][key] = val;
    }
  }

  // Parse [settings.*] sections
  const rawSettings = (raw.settings ?? {}) as Record<string, unknown>;
  const settings: RhoConfig["settings"] = {};
  for (const [key, val] of Object.entries(rawSettings)) {
    if (typeof val === "object" && val !== null) {
      settings[key] = val as Record<string, unknown>;
    }
  }

  // Parse [settings.web] section for web config
  const rawWebSettings = rawSettings.web as Record<string, unknown> | undefined;
  const web: WebConfig = {
    enabled: typeof rawWebSettings?.enabled === "boolean" ? rawWebSettings.enabled : false,
    port: typeof rawWebSettings?.port === "number" ? rawWebSettings.port : 3141,
  };

  return { agent: { name: agent.name }, modules, settings, web };
}

/**
 * Parse a packages.toml string into a typed PackagesConfig.
 * Throws on invalid TOML or missing required fields.
 */
export function parsePackagesToml(content: string): PackagesConfig {
  const raw = parseToml(content) as Record<string, unknown>;

  const rawPackages = raw.packages;
  if (rawPackages == null) {
    return { packages: [] };
  }

  if (!Array.isArray(rawPackages)) {
    throw new Error("[[packages]] must be an array of tables");
  }

  const packages: PackageEntry[] = rawPackages.map((entry, i) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`packages[${i}] must be a table`);
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.source !== "string") {
      throw new Error(`packages[${i}].source is required and must be a string`);
    }
    const result: PackageEntry = { source: e.source };
    if (e.extensions != null) {
      if (!Array.isArray(e.extensions) || !e.extensions.every((x) => typeof x === "string")) {
        throw new Error(`packages[${i}].extensions must be an array of strings`);
      }
      result.extensions = e.extensions as string[];
    }
    if (e.skills != null) {
      if (!Array.isArray(e.skills) || !e.skills.every((x) => typeof x === "string")) {
        throw new Error(`packages[${i}].skills must be an array of strings`);
      }
      result.skills = e.skills as string[];
    }
    return result;
  });

  return { packages };
}

/**
 * Validate a parsed RhoConfig against the module registry.
 * Returns errors (invalid) and warnings (non-fatal).
 */
export function validateConfig(config: RhoConfig): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Validate agent name
  if (!config.agent.name || config.agent.name.trim() === "") {
    errors.push("agent.name must not be empty");
  }

  // Build lookup: module name -> expected category
  const registryByName = new Map<string, ModuleCategory>();
  for (const [name, entry] of Object.entries(REGISTRY)) {
    registryByName.set(name, entry.category as ModuleCategory);
  }

  // Validate each module entry
  for (const cat of MODULE_CATEGORIES) {
    for (const [modName, enabled] of Object.entries(config.modules[cat])) {
      const expectedCat = registryByName.get(modName);

      if (!expectedCat) {
        // Unknown module
        errors.push(
          `Unknown module "${modName}" in [modules.${cat}]. Check spelling or remove it.`
        );
        continue;
      }

      if (expectedCat !== cat) {
        // Module in wrong category
        errors.push(
          `Module "${modName}" is in [modules.${cat}] but belongs in [modules.${expectedCat}]`
        );
        continue;
      }

      // Core modules forced on
      const regEntry = REGISTRY[modName];
      if (regEntry.alwaysOn && !enabled) {
        warnings.push(
          `Core module "${modName}" cannot be disabled. It will be enabled regardless.`
        );
      }
    }
  }

  // Validate settings reference known modules
  for (const settingsKey of Object.keys(config.settings)) {
    if (!registryByName.has(settingsKey)) {
      warnings.push(
        `Settings for unknown module "${settingsKey}". It will be ignored.`
      );
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
