/**
 * cli/registry.ts — Module registry mapping module names to paths.
 *
 * This is the source of truth for what modules Rho ships.
 * Used by config validation, sync, doctor, upgrade, and status.
 */

export interface ModuleEntry {
  category: "core" | "knowledge" | "tools" | "ui" | "skills";
  extensions: string[];   // paths relative to package root (empty for npm-backed modules)
  skills: string[];       // paths relative to package root (empty for npm-backed modules)
  description: string;    // one-line description for init.toml comments
  alwaysOn?: boolean;     // core modules that cannot be disabled
  npmPackage?: string;    // external npm package — installed/removed by sync based on enabled state
}

/**
 * Module registry. Keys are module names as they appear in init.toml.
 */
export const REGISTRY: Record<string, ModuleEntry> = {
  // ── Core (always on) ──────────────────────────────────
  heartbeat: {
    category: "core",
    extensions: ["extensions/rho"],
    skills: ["skills/memory-clean"],
    description: "Heartbeat daemon, check-ins, and memory consolidation",
    alwaysOn: true,
  },
  memory: {
    category: "core",
    extensions: ["extensions/memory-viewer"],
    skills: [],
    description: "Memory browser and viewer",
    alwaysOn: true,
  },

  // ── Knowledge ─────────────────────────────────────────
  vault: {
    category: "knowledge",
    extensions: ["extensions/vault-search"],
    skills: ["skills/vault-clean"],
    description: "Knowledge vault with full-text search and orphan cleanup",
  },

  // ── Tools ─────────────────────────────────────────────
  "brave-search": {
    category: "tools",
    extensions: ["extensions/brave-search"],
    skills: [],
    description: "Web search via Brave Search API",
  },
  "x-search": {
    category: "tools",
    extensions: ["extensions/x-search"],
    skills: [],
    description: "X/Twitter search via xAI Grok",
  },
  email: {
    category: "tools",
    extensions: ["extensions/email"],
    skills: ["skills/rho-cloud-email", "skills/rho-cloud-onboard"],
    description: "Agent email via Rho Cloud (rhobot.dev)",
  },

  // ── Skills ────────────────────────────────────────────
  "session-search": {
    category: "skills",
    extensions: [],
    skills: ["skills/session-search"],
    description: "Search across pi session logs",
  },
  "update-pi": {
    category: "skills",
    extensions: [],
    skills: ["skills/update-pi"],
    description: "Update pi coding agent to latest version",
  },
  "soul-update": {
    category: "skills",
    extensions: [],
    skills: ["skills/soul-update"],
    description: "Mine sessions to learn about the user and evolve identity/behavior entries in brain.jsonl",
  },

  subagents: {
    category: "tools",
    extensions: [],
    skills: [],
    npmPackage: "pi-subagents",
    description: "Subagent delegation with chains, parallel execution, and async support",
  },

  // ── Workflows ──────────────────────────────────────────
  "agent-sop": {
    category: "tools",
    extensions: ["extensions/agent-sop"],
    skills: [],
    description: "Standard Operating Procedures for structured agent workflows",
  },

  // ── UI ────────────────────────────────────────────────
  "usage-bars": {
    category: "ui",
    extensions: ["extensions/usage-bars"],
    skills: [],
    description: "Token usage display bars",
  },
  moltbook: {
    category: "ui",
    extensions: ["extensions/moltbook-viewer"],
    skills: [],
    description: "Moltbook viewer",
  },
};
