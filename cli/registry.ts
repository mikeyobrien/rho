/**
 * cli/registry.ts — Module registry mapping module names to paths.
 *
 * This is the source of truth for what modules Rho ships.
 * Used by config validation, sync, doctor, upgrade, and status.
 */

export interface ModuleEntry {
	category: "core" | "knowledge" | "tools" | "ui" | "skills";
	extensions: string[]; // paths relative to package root (empty for npm-backed modules)
	skills: string[]; // paths relative to package root (empty for npm-backed modules)
	description: string; // one-line description for init.toml comments
	alwaysOn?: boolean; // core modules that cannot be disabled
	npmPackage?: string; // external npm package name (legacy shorthand)
	packageSource?: string; // external package source (e.g., npm:foo, git:github.com/user/repo)
}

/**
 * Module registry. Keys are module names as they appear in init.toml.
 */
export const REGISTRY: Record<string, ModuleEntry> = {
	// ── Core (always on) ──────────────────────────────────
	heartbeat: {
		category: "core",
		extensions: ["extensions/rho"],
		skills: ["skills/memory-consolidate", "skills/auto-memory"],
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
	telegram: {
		category: "tools",
		extensions: ["extensions/telegram"],
		skills: [],
		description: "Telegram channel adapter for chatting with your agent",
	},
	email: {
		category: "tools",
		extensions: ["extensions/email"],
		skills: ["skills/rho-cloud-email", "skills/rho-cloud-onboard"],
		description: "Agent email via Rho Cloud (rhobot.dev)",
	},
	subagents: {
		category: "tools",
		extensions: [],
		skills: [],
		npmPackage: "pi-subagents",
		description:
			"Subagent delegation with chains, parallel execution, and async support",
	},
	messenger: {
		category: "tools",
		extensions: [],
		skills: [],
		npmPackage: "pi-messenger",
		description: "Multi-agent communication extension for pi coding agent",
	},
	"interactive-shell": {
		category: "tools",
		extensions: [],
		skills: [],
		npmPackage: "pi-interactive-shell",
		description: "Observable PTY shell control for interactive CLI workflows",
	},
	"web-access": {
		category: "tools",
		extensions: [],
		skills: [],
		npmPackage: "pi-web-access",
		description: "Web search and content extraction extension for pi",
	},
	"mcp-adapter": {
		category: "tools",
		extensions: [],
		skills: [],
		npmPackage: "pi-mcp-adapter",
		description: "Token-efficient adapter for MCP server integration",
	},
	"interview-tool": {
		category: "tools",
		extensions: [],
		skills: [],
		npmPackage: "pi-interview",
		description: "Structured interview assistant for discovery workflows",
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
	"visual-explainer": {
		category: "skills",
		extensions: [],
		skills: [],
		packageSource: "git:github.com/nicobailon/visual-explainer",
		description:
			"Generate polished HTML diagrams, reviews, and comparison tables",
	},

	// ── Workflow Skills (SOP subtype) ─────────────────────
	workflows: {
		category: "skills",
		extensions: [],
		skills: [
			"skills/code-assist",
			"skills/code-task-generator",
			"skills/codebase-summary",
			"skills/create-sop",
			"skills/eval",
			"skills/pdd",
			"skills/pdd-build",
			"skills/release-changelog",
			"skills/small-improvement",
		],
		description: "SOP-style workflow skills executed via /skill run",
	},

	// ── UI ────────────────────────────────────────────────
	"usage-bars": {
		category: "ui",
		extensions: ["extensions/usage-bars"],
		skills: [],
		description: "Token usage display bars",
	},
};
