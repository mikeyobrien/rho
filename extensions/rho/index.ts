/**
 * Rho Core Extension
 *
 * The core runtime for Rho: persistent memory (brain), task queue,
 * knowledge vault, and heartbeat check-ins.
 *
 * Tools:  memory, tasks, vault, rho_control, rho_subagent
 * Commands: /brain, /tasks, /vault, /rho, /bootstrap, /status
 * Events: session_start, session_switch, session_fork, session_shutdown,
 *         before_agent_start, agent_end, session_before_compact
 */

// ─── Imports ──────────────────────────────────────────────────────────────────

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";
import { StringEnum, complete } from "@mariozechner/pi-ai";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { Text, visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
// tasks-core.ts kept for backward compat re-exports only
import {
  addTask,
  buildHeartbeatSection,
  clearDone,
  completeTask,
  findTaskById,
  formatTask,
  generateId,
  listTasks,
  loadTasks,
  removeTask,
  saveTasks,
  type Task,
  type TaskPriority,
  type TaskStatus,
} from "./tasks-core.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { execSync } from "node:child_process";
import { VaultSearch, parseFrontmatter, extractWikilinks, extractTitle } from "../lib/mod.ts";
import { handleBrainAction } from "../lib/brain-tool.ts";
import { readBrain, foldBrain, buildBrainPrompt, appendBrainEntryWithDedup, getInjectedIds, BRAIN_PATH } from "../lib/brain-store.ts";
import { detectMigration, runMigration } from "../lib/brain-migration.ts";
import { LeaseHandle, isLeaseStale, readLeaseMeta, tryAcquireLeaseLock } from "../lib/lease-lock.ts";
import { handleBootstrapSlash, runBootstrapCliFromExtension } from "./bootstrap/slash-bootstrap.ts";

export { parseFrontmatter, extractWikilinks };
export {
  addTask,
  buildHeartbeatSection,
  clearDone,
  completeTask,
  findTaskById,
  formatTask,
  generateId,
  listTasks,
  loadTasks,
  removeTask,
  saveTasks,
  type Task,
  type TaskPriority,
  type TaskStatus,
};

// ─── Path Constants ───────────────────────────────────────────────────────────

const HOME = os.homedir();
const RHO_DIR = path.join(HOME, ".rho");
const BRAIN_DIR = path.join(RHO_DIR, "brain");
export const VAULT_DIR = path.join(RHO_DIR, "vault");
const RESULTS_DIR = path.join(RHO_DIR, "results");
const STATE_PATH = path.join(RHO_DIR, "rho-state.json");
const CONFIG_PATH = path.join(RHO_DIR, "config.json");
const SETTINGS_PATH = path.join(RHO_DIR, "rho-settings.json");

const LEGACY_STATE_PATH = path.join(HOME, ".pi", "agent", "rho-state.json");

// ── Memory count cache (for footer status) ──
let cachedMemoryCount: number | null = null;
let memoryCacheMs = 0;
const MEMORY_CACHE_TTL = 30_000;

function getMemoryCount(): number {
  const now = Date.now();
  if (cachedMemoryCount !== null && now - memoryCacheMs < MEMORY_CACHE_TTL) {
    return cachedMemoryCount;
  }
  try {
    const { entries } = readBrain(BRAIN_PATH);
    const brain = foldBrain(entries);
    cachedMemoryCount = brain.learnings.length + brain.preferences.length;
  } catch {
    cachedMemoryCount = 0;
  }
  memoryCacheMs = now;
  return cachedMemoryCount;
}

const HEARTBEAT_PROMPT_FILE = path.join(RHO_DIR, "heartbeat-prompt.txt");

// ─── Shared Config ────────────────────────────────────────────────────────────

interface RhoConfig {
  autoMemory?: boolean;
  decayAfterDays?: number;
  decayMinScore?: number;
  promptBudget?: number;
}

function readConfig(): RhoConfig {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return {};
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const autoMemory =
        typeof obj.autoMemory === "boolean"
          ? obj.autoMemory
          : typeof obj.auto_memory === "boolean"
            ? obj.auto_memory
            : undefined;
      const decayAfterDays = typeof obj.decayAfterDays === "number" ? obj.decayAfterDays : undefined;
      const decayMinScore = typeof obj.decayMinScore === "number" ? obj.decayMinScore : undefined;
      const promptBudget = typeof obj.promptBudget === "number" ? obj.promptBudget : undefined;
      return { autoMemory, decayAfterDays, decayMinScore, promptBudget };
    }
  } catch {
    // ignore
  }
  return {};
}

function writeConfig(next: Partial<RhoConfig>): void {
  try {
    fs.mkdirSync(RHO_DIR, { recursive: true });
    let base: Record<string, unknown> = {};
    try {
      const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object") base = parsed as Record<string, unknown>;
    } catch {
      // ignore
    }
    if (typeof next.autoMemory === "boolean") base.autoMemory = next.autoMemory;
    if (typeof next.decayAfterDays === "number") base.decayAfterDays = next.decayAfterDays;
    if (typeof next.decayMinScore === "number") base.decayMinScore = next.decayMinScore;
    if (typeof next.promptBudget === "number") base.promptBudget = next.promptBudget;
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(base, null, 2));
  } catch {
    // ignore
  }
}

function getAutoMemoryEffective(): { enabled: boolean; source: "env" | "config" | "default" } {
  if (process.env.RHO_SUBAGENT === "1") return { enabled: false, source: "env" };

  const env = (process.env.RHO_AUTO_MEMORY || "").trim().toLowerCase();
  if (env === "0" || env === "false" || env === "off") return { enabled: false, source: "env" };
  if (env === "1" || env === "true" || env === "on") return { enabled: true, source: "env" };

  const cfg = readConfig();
  if (typeof cfg.autoMemory === "boolean") return { enabled: cfg.autoMemory, source: "config" };
  return { enabled: true, source: "default" };
}

// ─── Shared Helpers ───────────────────────────────────────────────────────────

function nanoid(size = 8): string {
  return crypto.randomBytes(size).toString("base64url").slice(0, size);
}

function ensureRhoDir(): void {
  if (!fs.existsSync(RHO_DIR)) {
    fs.mkdirSync(RHO_DIR, { recursive: true });
  }
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const match = trimmed.match(/\{[\s\S]*\}/);
  return match ? match[0] : null;
}

// ─── Top bar (header) ───────────────────────────────────────────────────────

function formatPathForHeader(cwd: string, maxWidth: number): string {
  let out = cwd || "";
  if (HOME && out.startsWith(HOME)) {
    out = "~" + out.slice(HOME.length);
    if (out === "") out = "~";
  }

  if (maxWidth <= 0) return "";
  if (out.length <= maxWidth) return out;
  if (maxWidth === 1) return "…";
  return "…" + out.slice(-(maxWidth - 1));
}

function setRhoHeader(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;

  ctx.ui.setHeader((_tui, theme) => ({
    invalidate() {},
    render(width: number): string[] {
      const left = theme.fg("accent", "rho");
      const maxRight = Math.max(0, width - visibleWidth(left) - 1);
      const rightPlain = formatPathForHeader(ctx.cwd, maxRight);
      const right = theme.fg("muted", rightPlain);
      const spaces = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
      return [truncateToWidth(left + " ".repeat(spaces) + right, width)];
    },
  }));
}

// ═══════════════════════════════════════════════════════════════════════════════
//  BRAIN (Persistent Memory)
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Brain Config ─────────────────────────────────────────────────────────────

const AUTO_MEMORY_DEBUG = process.env.RHO_AUTO_MEMORY_DEBUG === "1" || process.env.RHO_AUTO_MEMORY_DEBUG === "true";
const AUTO_MEMORY_MAX_ITEMS = 3;
const AUTO_MEMORY_MAX_TEXT = 200;
const AUTO_MEMORY_DEFAULT_CATEGORY = "General";
const AUTO_MEMORY_ALLOWED_CATEGORIES = new Set(["Communication", "Code", "Tools", "Workflow", "General"]);
const COMPACT_MEMORY_FLUSH_ENABLED = process.env.RHO_COMPACT_MEMORY_FLUSH !== "0";

// ─── Brain: Model Resolution ─────────────────────────────────────────────────

async function resolveSmallModel(
  ctx: ExtensionContext
): Promise<{ model: Model<Api>; apiKey: string } | null> {
  const currentModel = ctx.model;
  if (!currentModel) return null;

  const currentApiKey = await ctx.modelRegistry.getApiKey(currentModel);
  if (!currentApiKey) return null;

  const sameProvider = ctx.modelRegistry
    .getAll()
    .filter((m) => m.provider === currentModel.provider)
    .sort((a, b) => a.cost.output - b.cost.output);

  for (const candidate of sameProvider) {
    const apiKey = await ctx.modelRegistry.getApiKey(candidate);
    if (apiKey) {
      return { model: candidate, apiKey };
    }
  }

  return { model: currentModel, apiKey: currentApiKey };
}

// ─── Brain: Store Functions ───────────────────────────────────────────────────

type StoreResult = { stored: boolean; id?: string; reason?: "empty" | "duplicate" | "too_long" };

function normalizeMemoryText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function sanitizeCategory(category?: string): string {
  if (!category) return AUTO_MEMORY_DEFAULT_CATEGORY;
  const trimmed = category.trim();
  if (!trimmed) return AUTO_MEMORY_DEFAULT_CATEGORY;
  for (const allowed of AUTO_MEMORY_ALLOWED_CATEGORIES) {
    if (allowed.toLowerCase() === trimmed.toLowerCase()) return allowed;
  }
  return AUTO_MEMORY_DEFAULT_CATEGORY;
}

async function storeLearningEntry(text: string, options?: { source?: string; maxLength?: number }): Promise<StoreResult> {
  const normalized = normalizeMemoryText(text);
  if (!normalized) return { stored: false, reason: "empty" };
  if (options?.maxLength && normalized.length > options.maxLength) {
    return { stored: false, reason: "too_long" };
  }

  const entry = {
    id: crypto.randomBytes(4).toString("hex"),
    type: "learning" as const,
    text: normalized,
    source: options?.source,
    created: new Date().toISOString(),
  };

  const written = await appendBrainEntryWithDedup(
    BRAIN_PATH,
    entry,
    (existing) => existing.some(e =>
      e.type === "learning" &&
      normalizeMemoryText((e as any).text || "").toLowerCase() === normalized.toLowerCase()
    ),
  );

  if (!written) return { stored: false, reason: "duplicate" };
  brainCache = null;
  return { stored: true, id: entry.id };
}

async function storePreferenceEntry(
  text: string,
  category: string,
  options?: { maxLength?: number }
): Promise<StoreResult> {
  const normalized = normalizeMemoryText(text);
  if (!normalized) return { stored: false, reason: "empty" };
  if (options?.maxLength && normalized.length > options.maxLength) {
    return { stored: false, reason: "too_long" };
  }
  const normalizedCategory = sanitizeCategory(category);

  const entry = {
    id: crypto.randomBytes(4).toString("hex"),
    type: "preference" as const,
    category: normalizedCategory,
    text: normalized,
    created: new Date().toISOString(),
  };

  const written = await appendBrainEntryWithDedup(
    BRAIN_PATH,
    entry,
    (existing) => existing.some(e =>
      e.type === "preference" &&
      normalizeMemoryText((e as any).text || "").toLowerCase() === normalized.toLowerCase() &&
      (e as any).category === normalizedCategory
    ),
  );

  if (!written) return { stored: false, reason: "duplicate" };
  brainCache = null;
  return { stored: true, id: entry.id };
}

// ─── Brain: Auto-Memory Extraction ───────────────────────────────────────────

type AutoMemoryResponse = {
  learnings?: Array<{ text?: string }>;
  preferences?: Array<{ text?: string; category?: string }>;
};

function formatExistingMemories(entries: Array<{ type: string; text?: string; category?: string }>): string {
  const learnings = entries.filter((e) => e.type === "learning");
  const preferences = entries.filter((e) => e.type === "preference");
  const lines: string[] = [];
  for (const l of learnings) lines.push(`- ${l.text ?? ""}`);
  for (const p of preferences) lines.push(`- [${p.category ?? "General"}] ${p.text ?? ""}`);
  return lines.join("\n");
}

// Cache the auto-memory workflow content so we only read from disk once
let _autoMemorySkillCache: string | null = null;

function stripMarkdownFrontmatter(markdown: string): string {
  if (!markdown.startsWith("---\n")) return markdown;
  const end = markdown.indexOf("\n---\n", 4);
  if (end === -1) return markdown;
  return markdown.slice(end + 5).trimStart();
}

function loadAutoMemorySkill(): string {
  if (_autoMemorySkillCache) return _autoMemorySkillCache;
  const skillPath = path.join(__dirname, "..", "..", "skills", "auto-memory", "SKILL.md");
  try {
    const raw = fs.readFileSync(skillPath, "utf-8");
    _autoMemorySkillCache = stripMarkdownFrontmatter(raw);
  } catch {
    // Fallback if skill file is missing
    _autoMemorySkillCache = [
      "Extract durable learnings and user preferences from the conversation.",
      "Only extract final decisions, corrections, and verified facts.",
      "Skip intermediate discussion, transient states, and one-off tasks.",
      "Max 3 items. Return empty arrays if nothing worth extracting.",
    ].join("\n");
  }
  return _autoMemorySkillCache;
}

function buildAutoMemoryPrompt(conversationText: string, existingMemories?: string): string {
  const workflow = loadAutoMemorySkill();
  const parts = [
    "<workflow>",
    workflow,
    "</workflow>",
  ];

  if (existingMemories) {
    parts.push(
      "",
      "<existing_memories>",
      existingMemories,
      "</existing_memories>",
    );
  }

  parts.push(
    "",
    "<conversation>",
    conversationText,
    "</conversation>"
  );

  return parts.join("\n");
}

function parseAutoMemoryResponse(text: string): AutoMemoryResponse | null {
  const jsonText = extractJsonObject(text);
  if (!jsonText) return null;
  try {
    return JSON.parse(jsonText) as AutoMemoryResponse;
  } catch {
    return null;
  }
}

async function runAutoMemoryExtraction(
  messages: AgentMessage[],
  ctx: ExtensionContext,
  options?: { source?: string; signal?: AbortSignal; maxItems?: number; maxText?: number }
): Promise<{ storedLearnings: number; storedPrefs: number } | null> {
  if (!getAutoMemoryEffective().enabled) return null;

  const resolved = await resolveSmallModel(ctx);
  if (!resolved) return null;
  const { model } = resolved;

  const conversationText = serializeConversation(convertToLlm(messages));
  if (!conversationText.trim()) return null;

  if (AUTO_MEMORY_DEBUG && ctx.hasUI) {
    ctx.ui.notify(`Auto-memory: extracting via ${model.name}...`, "info");
  }

  const { entries: brainEntries } = readBrain(BRAIN_PATH);
  const existingBrain = foldBrain(brainEntries);
  const existingForPrompt = [
    ...existingBrain.learnings.map(l => ({ type: "learning" as const, text: l.text })),
    ...existingBrain.preferences.map(p => ({ type: "preference" as const, text: p.text, category: p.category })),
  ];
  const existingText = existingForPrompt.length > 0 ? formatExistingMemories(existingForPrompt) : undefined;
  const prompt = buildAutoMemoryPrompt(conversationText, existingText);

  let response;
  const candidates = [resolved];
  if (resolved.model.id !== ctx.model?.id && ctx.model) {
    const fallbackKey = await ctx.modelRegistry.getApiKey(ctx.model);
    if (fallbackKey) candidates.push({ model: ctx.model, apiKey: fallbackKey });
  }

  for (const { model, apiKey } of candidates) {
    try {
      const maxTokens = Math.min(512, model.maxTokens || 512);
      const result = await complete(
        model,
        {
          messages: [
            { role: "user" as const, content: [{ type: "text" as const, text: prompt }], timestamp: Date.now() },
          ],
        },
        { apiKey, maxTokens, signal: options?.signal }
      );
      if (result.stopReason === "error") {
        if (AUTO_MEMORY_DEBUG) {
          console.error(`Auto-memory error from ${model.id}: ${result.errorMessage}`);
        }
        continue;
      }
      response = result;
      break;
    } catch (e) {
      if (AUTO_MEMORY_DEBUG) {
        console.error(`Auto-memory failed with ${model.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  if (!response) return null;

  const responseText = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();

  const parsed = parseAutoMemoryResponse(responseText);
  if (!parsed) {
    if (AUTO_MEMORY_DEBUG && ctx.hasUI) {
      ctx.ui.notify("Auto-memory: no JSON response", "warning");
    }
    return null;
  }

  const extractedLearnings = (parsed.learnings ?? [])
    .map((l) => normalizeMemoryText(l.text ?? ""))
    .filter(Boolean);
  const extractedPreferences = (parsed.preferences ?? [])
    .map((p) => ({
      text: normalizeMemoryText(p.text ?? ""),
      category: sanitizeCategory(p.category),
    }))
    .filter((p) => p.text.length > 0);

  const maxItems = options?.maxItems ?? AUTO_MEMORY_MAX_ITEMS;
  const maxText = options?.maxText ?? AUTO_MEMORY_MAX_TEXT;
  const source = options?.source ?? "auto";
  let remaining = maxItems;
  let storedLearnings = 0;
  let storedPrefs = 0;
  const storedItems: string[] = [];

  for (const text of extractedLearnings) {
    if (remaining <= 0) break;
    const result = await storeLearningEntry(text, { source, maxLength: maxText });
    if (result.stored) {
      storedLearnings += 1;
      remaining -= 1;
      storedItems.push(text);
    }
  }

  for (const pref of extractedPreferences) {
    if (remaining <= 0) break;
    const result = await storePreferenceEntry(pref.text, pref.category, { maxLength: maxText });
    if (result.stored) {
      storedPrefs += 1;
      remaining -= 1;
      storedItems.push(`[${pref.category}] ${pref.text}`);
    }
  }

  if ((storedLearnings > 0 || storedPrefs > 0) && ctx.hasUI) {
    const total = storedLearnings + storedPrefs;
    const prefix = `Auto-memory (${total}): `;
    const maxLen = 120 - prefix.length;
    const truncated: string[] = [];
    let len = 0;
    for (const item of storedItems) {
      const short = item.length > 60 ? item.slice(0, 57) + "..." : item;
      const quoted = `"${short}"`;
      const added = len === 0 ? quoted.length : quoted.length + 3; // " | " separator
      if (len + added > maxLen && truncated.length > 0) break;
      truncated.push(quoted);
      len += added;
    }
    const suffix = truncated.length < storedItems.length ? ` +${storedItems.length - truncated.length} more` : "";
    ctx.ui.notify(`${prefix}${truncated.join(" | ")}${suffix}`, "info");
  }

  // Bust footer memory count cache so it updates immediately
  memoryCacheMs = 0;

  return { storedLearnings, storedPrefs };
}

function bootstrapBrainDefaults(extensionDir: string): void {
  const brainTarget = path.join(BRAIN_DIR, "brain.jsonl");
  if (fs.existsSync(brainTarget)) return;

  const defaultsDir = path.join(path.dirname(extensionDir), "brain");
  const defaultFile = path.join(defaultsDir, "brain.jsonl.default");
  if (!fs.existsSync(defaultFile)) return;

  fs.mkdirSync(BRAIN_DIR, { recursive: true });
  fs.copyFileSync(defaultFile, brainTarget);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  VAULT (Knowledge Graph)
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Vault Types ──────────────────────────────────────────────────────────────

export const VAULT_SUBDIRS = ["concepts", "projects", "patterns", "references", "log"] as const;

const TYPES_REQUIRING_CONNECTIONS = new Set(["concept", "project", "pattern", "reference", "moc"]);

export interface VaultNote {
  slug: string;
  path: string;
  title: string;
  type: string;
  tags: string[];
  created: string;
  updated: string;
  source: string;
  links: Set<string>;
  backlinks: Set<string>;
  size: number;
}

export type VaultGraph = Map<string, VaultNote>;

export type { Frontmatter } from "../lib/mod.ts";

interface ValidationResult {
  valid: boolean;
  reason?: string;
}

interface VaultStatus {
  totalNotes: number;
  byType: Record<string, number>;
  orphanCount: number;
  inboxItems: number;
  avgLinksPerNote: number;
}

interface NoteListEntry {
  slug: string;
  title: string;
  type: string;
  linkCount: number;
  backlinkCount: number;
  updated: string;
  tags: string[];
}

// ─── Vault: Frontmatter / Wikilinks / Title helpers ──────────────────────────
// Implemented in vault-lib.ts (shared with vault-search-lib.ts)

function slugFromPath(filePath: string): string {
  return path.basename(filePath, ".md");
}

const TYPE_DIR_MAP: Record<string, string> = {
  concept: "concepts",
  project: "projects",
  pattern: "patterns",
  reference: "references",
  log: "log",
};

export function typeToDir(type: string): string {
  return TYPE_DIR_MAP[type] ?? "";
}

// ─── Vault: Directory Setup ───────────────────────────────────────────────────

export function ensureVaultDirs(vaultDir: string = VAULT_DIR): void {
  fs.mkdirSync(vaultDir, { recursive: true });
  for (const sub of VAULT_SUBDIRS) {
    fs.mkdirSync(path.join(vaultDir, sub), { recursive: true });
  }
}

export function createDefaultFiles(vaultDir: string = VAULT_DIR): void {
  const indexPath = path.join(vaultDir, "_index.md");
  const inboxPath = path.join(vaultDir, "_inbox.md");
  const dateStr = new Date().toISOString().split("T")[0];

  if (!fs.existsSync(indexPath)) {
    fs.writeFileSync(indexPath, `---\ntype: moc\ncreated: ${dateStr}\nupdated: ${dateStr}\ntags: []\n---\n\n# Vault Index\n\n## Connections\n\nThis is the root map of content for the vault.\n\n## Body\n\nStart linking notes here as the vault grows.\n`);
  }
  if (!fs.existsSync(inboxPath)) {
    fs.writeFileSync(inboxPath, "# Inbox\n\nCaptured items waiting to be processed into notes.\n");
  }
}

// ─── Vault: Graph Builder ─────────────────────────────────────────────────────

function findMdFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findMdFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(full);
    }
  }
  return results;
}

export function buildGraph(vaultDir: string = VAULT_DIR): VaultGraph {
  const graph: VaultGraph = new Map();
  const files = findMdFiles(vaultDir);

  for (const file of files) {
    const slug = slugFromPath(file);
    const content = fs.readFileSync(file, "utf-8");
    const fm = parseFrontmatter(content);
    const links = extractWikilinks(content);
    const stat = fs.statSync(file);

    graph.set(slug, {
      slug,
      path: file,
      title: extractTitle(content, slug),
      type: (fm.type as string) || "unknown",
      tags: (fm.tags as string[]) || [],
      created: (fm.created as string) || "",
      updated: (fm.updated as string) || "",
      source: (fm.source as string) || "",
      links: new Set(links),
      backlinks: new Set(),
      size: stat.size,
    });
  }

  for (const [slug, note] of graph) {
    for (const target of note.links) {
      const targetNote = graph.get(target);
      if (targetNote) targetNote.backlinks.add(slug);
    }
  }

  return graph;
}

// ─── Vault: Note Operations ───────────────────────────────────────────────────

export function captureToInbox(vaultDir: string, text: string, source?: string, context?: string): string {
  const inboxPath = path.join(vaultDir, "_inbox.md");
  const timestamp = new Date().toISOString();

  const lines: string[] = ["", "---", "", `**${timestamp}**`];
  if (source) lines.push(`> Source: ${source}`);
  if (context) lines.push(`> Context: ${context}`);
  lines.push("", text, "");

  const entry = lines.join("\n");
  fs.appendFileSync(inboxPath, entry);
  return entry.trim();
}

export function readNote(
  vaultDir: string,
  slug: string,
  graph: VaultGraph
): { content: string; backlinks: string[] } | null {
  const note = graph.get(slug);
  if (!note) {
    const candidates = findNoteFile(vaultDir, slug);
    if (!candidates) return null;
    const content = fs.readFileSync(candidates, "utf-8");
    return { content, backlinks: [] };
  }

  const content = fs.readFileSync(note.path, "utf-8");
  return { content, backlinks: Array.from(note.backlinks) };
}

function findNoteFile(vaultDir: string, slug: string): string | null {
  const filename = `${slug}.md`;
  const rootPath = path.join(vaultDir, filename);
  if (fs.existsSync(rootPath)) return rootPath;

  for (const sub of VAULT_SUBDIRS) {
    const subPath = path.join(vaultDir, sub, filename);
    if (fs.existsSync(subPath)) return subPath;
  }
  return null;
}

export function writeNote(
  vaultDir: string,
  slug: string,
  content: string,
  type: string
): ValidationResult & { path?: string } {
  const validation = validateNote(content, type);
  if (!validation.valid) return validation;

  const subdir = typeToDir(type);
  const targetDir = subdir ? path.join(vaultDir, subdir) : vaultDir;
  fs.mkdirSync(targetDir, { recursive: true });

  const filePath = path.join(targetDir, `${slug}.md`);
  fs.writeFileSync(filePath, content);
  return { valid: true, path: filePath };
}

export function validateNote(content: string, type: string): ValidationResult {
  const fm = parseFrontmatter(content);
  if (!fm.type) {
    return { valid: false, reason: "Missing frontmatter. Expected format:\n---\ntype: concept\ncreated: YYYY-MM-DD\nupdated: YYYY-MM-DD\ntags: []\n---" };
  }

  if (type === "log") return { valid: true };

  if (TYPES_REQUIRING_CONNECTIONS.has(type)) {
    const hasConnections = /^##\s+Connections/m.test(content);
    if (!hasConnections) {
      return { valid: false, reason: "Missing '## Connections' section with [[wikilinks]]. Add:\n\n## Connections\n\n- [[related-note]]" };
    }

    const links = extractWikilinks(content);
    if (links.length === 0) {
      return { valid: false, reason: "No [[wikilinks]] found in Connections section. Add at least one: [[note-slug]]" };
    }
  }

  return { valid: true };
}

// ─── Vault: Status & Listing ──────────────────────────────────────────────────

function countInboxItems(vaultDir: string): number {
  const inboxPath = path.join(vaultDir, "_inbox.md");
  if (!fs.existsSync(inboxPath)) return 0;
  const content = fs.readFileSync(inboxPath, "utf-8");
  const separators = content.match(/^---$/gm);
  return separators ? separators.length : 0;
}

export function getVaultStatus(vaultDir: string, graph: VaultGraph): VaultStatus {
  const byType: Record<string, number> = {};
  let orphanCount = 0;
  let totalLinks = 0;

  for (const note of graph.values()) {
    byType[note.type] = (byType[note.type] || 0) + 1;
    totalLinks += note.links.size;
    if (note.backlinks.size === 0 && !note.slug.startsWith("_")) orphanCount++;
  }

  return {
    totalNotes: graph.size,
    byType,
    orphanCount,
    inboxItems: countInboxItems(vaultDir),
    avgLinksPerNote: graph.size > 0 ? totalLinks / graph.size : 0,
  };
}

export function listNotes(graph: VaultGraph, type?: string, query?: string): NoteListEntry[] {
  const results: NoteListEntry[] = [];
  const q = query?.toLowerCase();

  for (const note of graph.values()) {
    if (type && note.type !== type) continue;
    if (q) {
      const matchesSlug = note.slug.toLowerCase().includes(q);
      const matchesTitle = note.title.toLowerCase().includes(q);
      if (!matchesSlug && !matchesTitle) continue;
    }

    results.push({
      slug: note.slug,
      title: note.title,
      type: note.type,
      linkCount: note.links.size,
      backlinkCount: note.backlinks.size,
      updated: note.updated,
      tags: note.tags,
    });
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════════════════════
//  HEARTBEAT (Periodic Check-ins)
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Heartbeat Types ──────────────────────────────────────────────────────────

interface RhoState {
  enabled: boolean;
  intervalMs: number;
  lastCheckAt: number | null;
  nextCheckAt: number | null;
  checkCount: number;
  heartbeatModel: string | null;
}

interface ResolvedModel {
  provider: string;
  model: string;
  cost: number;
  resolvedAt: number;
}

interface RhoDetails {
  action: "enable" | "disable" | "trigger" | "interval" | "status" | "model";
  intervalMs?: number;
  enabled?: boolean;
  lastCheckAt?: number | null;
  nextCheckAt?: number | null;
  checkCount?: number;
  wasTriggered?: boolean;
  heartbeatModel?: string | null;
  heartbeatModelSource?: "auto" | "pinned";
  heartbeatModelCost?: number;
}

// ─── Heartbeat Constants ──────────────────────────────────────────────────────

const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
const MIN_INTERVAL_MS = 5 * 60 * 1000;
const MAX_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SESSION_NAME = readAgentName();
const HEARTBEAT_WINDOW_NAME = "heartbeat";
const MAX_WINDOW_NAME = 50;
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

// Heartbeat leader election (multi-process safety)
const HEARTBEAT_LOCK_PATH = path.join(RHO_DIR, "heartbeat.lock.json");
const HEARTBEAT_TRIGGER_PATH = path.join(RHO_DIR, "heartbeat.trigger");
const HEARTBEAT_LOCK_REFRESH_MS = 15 * 1000;
// Stale threshold should comfortably exceed refresh cadence to avoid spurious takeovers.
const HEARTBEAT_LOCK_STALE_MS = 90 * 1000;

// DEPRECATED: RHO_PROMPT was the old heartbeat prompt template that read from MD files.
// Heartbeat now builds prompts from brain.jsonl reminders + tasks. Kept for reference only.

// ─── Heartbeat Helpers ────────────────────────────────────────────────────────

function normalizeInterval(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value)) return DEFAULT_INTERVAL_MS;
  if (value === 0) return 0;
  if (value < MIN_INTERVAL_MS || value > MAX_INTERVAL_MS) return DEFAULT_INTERVAL_MS;
  return Math.floor(value);
}

function parseInterval(input: string): number | null {
  const match = input.trim().toLowerCase().match(/^(\d+)\s*(m|min|minute|minutes|h|hr|hour|hours)?$/);
  if (!match) return null;
  const value = parseInt(match[1], 10);
  const unit = match[2] || "m";
  if (unit.startsWith("h")) return value * 60 * 60 * 1000;
  return value * 60 * 1000;
}

function formatInterval(ms: number): string {
  if (ms >= 60 * 60 * 1000) return `${ms / (60 * 60 * 1000)}h`;
  return `${ms / (60 * 1000)}m`;
}

function sanitizeWindowName(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, MAX_WINDOW_NAME);
  return cleaned || "subagent";
}

// ─── Heartbeat: Multi-process leadership (lease lock) ───────────────────────

interface HeartbeatLockFile {
  // Legacy shape (kept for backward compat / observability).
  pid: number;
  nonce: string;
  acquiredAt: number;
  refreshedAt: number;
  hostname: string;
}

function readHeartbeatLock(): HeartbeatLockFile | null {
  try {
    if (!fs.existsSync(HEARTBEAT_LOCK_PATH)) return null;
    const raw = fs.readFileSync(HEARTBEAT_LOCK_PATH, "utf-8");
    const parsed = JSON.parse(raw) as Partial<HeartbeatLockFile>;
    if (!parsed || typeof parsed !== "object") return null;
    if (typeof parsed.pid !== "number") return null;
    if (typeof parsed.nonce !== "string") return null;
    if (typeof parsed.acquiredAt !== "number") return null;
    if (typeof parsed.refreshedAt !== "number") return null;
    if (typeof parsed.hostname !== "string") return null;
    return parsed as HeartbeatLockFile;
  } catch {
    return null;
  }
}

function atomicWriteTextFile(filePath: string, content: string): boolean {
  let tmpPath: string | null = null;
  try {
    ensureRhoDir();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    tmpPath = `${filePath}.tmp-${process.pid}-${nanoid(4)}`;
    fs.writeFileSync(tmpPath, content, { encoding: "utf-8", mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
    tmpPath = null;
    return true;
  } catch {
    try {
      if (tmpPath) fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    return false;
  }
}

function tryAcquireHeartbeatLease(nonce: string, now: number): { ok: true; lease: LeaseHandle; ownerPid: number } | { ok: false; ownerPid: number | null } {
  return tryAcquireLeaseLock(HEARTBEAT_LOCK_PATH, nonce, now, {
    staleMs: HEARTBEAT_LOCK_STALE_MS,
    purpose: "rho-heartbeat-leadership",
  });
}

function requestHeartbeatTrigger(now: number): void {
  // Atomic write to avoid readers seeing partial content.
  atomicWriteTextFile(HEARTBEAT_TRIGGER_PATH, String(now));
}

function consumeHeartbeatTrigger(lastSeenMtimeMs: number): { triggered: boolean; nextSeen: number } {
  try {
    if (!fs.existsSync(HEARTBEAT_TRIGGER_PATH)) return { triggered: false, nextSeen: lastSeenMtimeMs };
    const st = fs.statSync(HEARTBEAT_TRIGGER_PATH);
    const mtime = st.mtimeMs || Date.now();
    if (mtime <= lastSeenMtimeMs) return { triggered: false, nextSeen: lastSeenMtimeMs };
    try { fs.unlinkSync(HEARTBEAT_TRIGGER_PATH); } catch { /* ignore */ }
    return { triggered: true, nextSeen: mtime };
  } catch {
    return { triggered: false, nextSeen: lastSeenMtimeMs };
  }
}

const HEARTBEAT_SETTINGS_TRIGGER_PATH = path.join(RHO_DIR, "heartbeat.settings.trigger");

function requestHeartbeatSettingsReload(now: number): void {
  atomicWriteTextFile(HEARTBEAT_SETTINGS_TRIGGER_PATH, String(now));
}

function consumeHeartbeatSettingsReload(lastSeenMtimeMs: number): { triggered: boolean; nextSeen: number } {
  try {
    if (!fs.existsSync(HEARTBEAT_SETTINGS_TRIGGER_PATH)) return { triggered: false, nextSeen: lastSeenMtimeMs };
    const st = fs.statSync(HEARTBEAT_SETTINGS_TRIGGER_PATH);
    const mtime = st.mtimeMs || Date.now();
    if (mtime <= lastSeenMtimeMs) return { triggered: false, nextSeen: lastSeenMtimeMs };
    try { fs.unlinkSync(HEARTBEAT_SETTINGS_TRIGGER_PATH); } catch { /* ignore */ }
    return { triggered: true, nextSeen: mtime };
  } catch {
    return { triggered: false, nextSeen: lastSeenMtimeMs };
  }
}

// ─── Heartbeat: Tmux Integration ──────────────────────────────────────────────

function getTmuxSessionName(): string {
  if (!process.env.TMUX) return DEFAULT_SESSION_NAME;
  try {
    return execSync("tmux display-message -p '#S'", { encoding: "utf-8" }).trim() || DEFAULT_SESSION_NAME;
  } catch {
    return DEFAULT_SESSION_NAME;
  }
}

function heartbeatWindowExists(sessionName: string): boolean {
  try {
    const output = execSync(`tmux list-windows -t ${shellEscape(sessionName)} -F "#{window_name}"`, { encoding: "utf-8" });
    return output.split("\n").map((name) => name.trim()).filter(Boolean).includes(HEARTBEAT_WINDOW_NAME);
  } catch {
    return false;
  }
}

/**
 * Check if the heartbeat pane is dead (process exited, remain-on-exit kept it visible).
 */
function heartbeatPaneDead(sessionName: string): boolean {
  const target = `${sessionName}:${HEARTBEAT_WINDOW_NAME}`;
  try {
    const dead = execSync(`tmux list-panes -t ${shellEscape(target)} -F "#{pane_dead}"`, { encoding: "utf-8" }).trim();
    return dead === "1";
  } catch {
    return false;
  }
}

/**
 * Check if the heartbeat pane is running a shell (idle) or something else (busy).
 * Returns true if the pane has a non-shell process (e.g., pi) still running.
 */
function heartbeatPaneBusy(sessionName: string): boolean {
  const target = `${sessionName}:${HEARTBEAT_WINDOW_NAME}`;
  try {
    const cmd = execSync(`tmux list-panes -t ${shellEscape(target)} -F "#{pane_current_command}"`, { encoding: "utf-8" }).trim();
    // Shell names that indicate the pane is idle and ready for a command
    const shells = ["bash", "sh", "zsh", "fish", "dash", "-bash", "-sh", "-zsh"];
    return !shells.includes(cmd);
  } catch {
    return false;
  }
}

function ensureTmuxSession(sessionName: string): boolean {
  try {
    execSync(`tmux has-session -t ${shellEscape(sessionName)}`, { stdio: "ignore" });
    return true;
  } catch {
    try {
      execSync(`tmux new-session -d -s ${shellEscape(sessionName)}`, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }
}

function runHeartbeatInTmux(prompt: string, modelFlags?: string): boolean {
  try {
    execSync("command -v tmux", { stdio: "ignore" });
  } catch {
    return false;
  }

  const sessionName = getTmuxSessionName();
  if (!ensureTmuxSession(sessionName)) return false;

  try {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    fs.writeFileSync(HEARTBEAT_PROMPT_FILE, prompt, "utf-8");
  } catch {
    return false;
  }

  const target = `${sessionName}:${HEARTBEAT_WINDOW_NAME}`;
  const promptArg = `@${HEARTBEAT_PROMPT_FILE}`;
  const flags = modelFlags ? ` ${modelFlags}` : "";
  // -p: pi exits after the prompt completes (no lingering interactive session).
  // remain-on-exit (set below) keeps the output visible in tmux until the next heartbeat.
  const command = `clear; RHO_SUBAGENT=1 pi -p --no-session${flags} ${shellEscape(promptArg)}; rm -f ${shellEscape(HEARTBEAT_PROMPT_FILE)}`;

  try {
    if (!heartbeatWindowExists(sessionName)) {
      execSync(`tmux new-window -d -t ${shellEscape(sessionName)} -n ${shellEscape(HEARTBEAT_WINDOW_NAME)}`, { stdio: "ignore" });
      // Keep output visible after pi exits so users can inspect heartbeat results.
      execSync(`tmux set-option -t ${shellEscape(target)} remain-on-exit on`, { stdio: "ignore" });
    } else if (heartbeatPaneDead(sessionName) || heartbeatPaneBusy(sessionName)) {
      // Previous heartbeat finished (dead pane) or still running — respawn a fresh shell
      execSync(`tmux respawn-pane -k -t ${shellEscape(target)}`, { stdio: "ignore" });
      // Small delay for the shell to initialize
      execSync("sleep 0.3", { stdio: "ignore" });
    }
    execSync(`tmux send-keys -t ${shellEscape(target)} ${shellEscape(command)} C-m`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  META PROMPT (Runtime Environment Context)
// ═══════════════════════════════════════════════════════════════════════════════

function readAgentName(): string {
  try {
    const initToml = path.join(RHO_DIR, "init.toml");
    if (fs.existsSync(initToml)) {
      const content = fs.readFileSync(initToml, "utf-8");
      const match = content.match(/^\s*name\s*=\s*"([^"]+)"/m);
      if (match) return match[1];
    }
  } catch { /* ignore */ }
  return "rho";
}

function detectPlatform(): string {
  const platform = os.platform();
  const release = os.release();

  // Detect Termux
  if (process.env.PREFIX?.includes("com.termux")) {
    const termuxVersion = process.env.TERMUX_VERSION || "unknown";
    return `Android / Termux ${termuxVersion}`;
  }

  switch (platform) {
    case "darwin": return `macOS ${release}`;
    case "linux": return `Linux ${release}`;
    case "win32": return `Windows ${release}`;
    default: return `${platform} ${release}`;
  }
}

interface MetaPromptOptions {
  agentName?: string;
  hbState: RhoState;
  hbIsLeader: boolean;
  vaultNoteCount: number;
  ctx: ExtensionContext;
  isSubagent: boolean;
}

function buildMetaPrompt(opts: MetaPromptOptions): string {
  const { agentName, hbState, hbIsLeader, vaultNoteCount, ctx, isSubagent } = opts;

  const sections: string[] = [];

  // ── Runtime Environment ──
  const name = agentName || "rho";
  const platform = detectPlatform();
  const arch = os.arch();
  const shell = process.env.SHELL ? path.basename(process.env.SHELL) : "bash";
  const mode = isSubagent ? "subagent" : "interactive";

  const runtimeLines = [
    `## Runtime`,
    `- **Agent**: ${name}`,
    `- **OS**: ${platform}`,
    `- **Arch**: ${arch}`,
    `- **Shell**: ${shell}`,
    `- **Home**: ${HOME}`,
    `- **Brain**: ~/.rho/brain/brain.jsonl`,
    `- **Vault**: ~/.rho/vault (${vaultNoteCount} notes)`,
    `- **Mode**: ${mode}`,
  ];

  // Heartbeat status
  if (!isSubagent) {
    if (!hbState.enabled || hbState.intervalMs === 0) {
      runtimeLines.push(`- **Heartbeat**: disabled`);
    } else if (!hbIsLeader) {
      runtimeLines.push(`- **Heartbeat**: follower (another process leads)`);
    } else if (hbState.nextCheckAt) {
      const remaining = Math.max(0, hbState.nextCheckAt - Date.now());
      const mins = Math.ceil(remaining / 60000);
      runtimeLines.push(`- **Heartbeat**: ${formatInterval(hbState.intervalMs)} interval, next in ${mins}m`);
    } else {
      runtimeLines.push(`- **Heartbeat**: ${formatInterval(hbState.intervalMs)} interval`);
    }
  }

  sections.push(runtimeLines.join("\n"));

  // ── Brain Tool Usage ──
  sections.push(`## Brain Tool

Persistent memory in brain.jsonl. Actions: add, update, remove, list, decay, task_done, task_clear, reminder_run.

Types: behavior (category:do/dont/value, text), learning (text), preference (text, category), identity (key, value), user (key, value), context (project, path, content), task (description), reminder (text, cadence, enabled).

Add: \`brain action=add type=<type> <fields>\`
List: \`brain action=list type=<type> filter=<pending|done|all|active|disabled> query="..."\`
Update: \`brain action=update id=<id> <fields>\`
Remove: \`brain action=remove id=<id> reason="..."\`

Reminders: cadence is \`{"kind":"interval","every":"30m"}\` or \`{"kind":"daily","at":"08:00"}\`. Process with: \`brain action=reminder_run id=<id> result=ok|error|skipped\`. On error add: \`error="msg"\`.
Tasks: \`brain action=task_done id=<id>\`, \`brain action=task_clear\` (removes done).`);

  // ── Brain vs Vault ──
  sections.push(`## Brain vs Vault

Brain: short durable facts, preferences, corrections (<200 chars). High-frequency, auto-injected every session.
Vault: longer reference material, concepts, research, linked knowledge. Searched on demand.`);

  // ── Approach Hierarchy ──
  sections.push(`## Approach Hierarchy

Prefer the simplest mechanism that works:
1. Brain entry (reminder, task, learning) — for recurring or one-off work
2. Skill (including kind:sop workflows) — for multi-step runbooks
3. Bash command — for immediate system actions
4. Code change — only when the above can't do the job`);

  return sections.join("\n\n");
}

// ═══════════════════════════════════════════════════════════════════════════════
//  EXTENSION ENTRY POINT
// ═══════════════════════════════════════════════════════════════════════════════

export default function (pi: ExtensionAPI) {
  const IS_SUBAGENT = process.env.RHO_SUBAGENT === "1";

  // ── Bootstrap ──────────────────────────────────────────────────────────────

  // Listen for usage-bars updates (extensions/usage-bars emits these)
  const unsubscribeUsage = pi.events.on("usage:update", (data: any) => {
    if (!data || typeof data !== "object") return;
    const session = (data as any).session;
    const weekly = (data as any).weekly;
    if (typeof session !== "number" || typeof weekly !== "number") return;
    usageBars = { session, weekly };
    footerTui?.requestRender?.();
  });

  bootstrapBrainDefaults(__dirname);
  ensureVaultDirs();
  createDefaultFiles();

  // ── Brain state ────────────────────────────────────────────────────────────

  let autoMemoryInFlight = false;
  let compactMemoryInFlight = false;
  let cachedBrainPrompt: string | null = null;

  // ── Brain cache (mtime-based invalidation for brain.jsonl) ─────────────
  interface BrainCache {
    prompt: string;
    mtimeMs: number;
    builtAt: number;
  }

  let brainCache: BrainCache | null = null;
  let currentCwd: string = process.cwd();

  const memorySettings = (() => {
    const cfg = readConfig();
    return {
      decayAfterDays: cfg.decayAfterDays ?? 90,
      decayMinScore: cfg.decayMinScore ?? 3,
      promptBudget: cfg.promptBudget ?? 2000,
    };
  })();

  function isBrainCacheStale(): boolean {
    if (!brainCache) return true;
    try {
      const stat = fs.statSync(BRAIN_PATH);
      return stat.mtimeMs !== brainCache.mtimeMs;
    } catch {
      return true;
    }
  }

  function rebuildBrainCache(cwd: string, promptBudget?: number): string {
    const { entries } = readBrain(BRAIN_PATH);
    const brain = foldBrain(entries);
    const prompt = buildBrainPrompt(brain, cwd, { promptBudget: promptBudget ?? memorySettings.promptBudget });
    try {
      const stat = fs.statSync(BRAIN_PATH);
      brainCache = { prompt, mtimeMs: stat.mtimeMs, builtAt: Date.now() };
    } catch {
      brainCache = { prompt, mtimeMs: 0, builtAt: Date.now() };
    }
    return prompt;
  }

  // ── Vault state ────────────────────────────────────────────────────────────

  let vaultGraph: VaultGraph = buildGraph();
  const vaultSearcher = new VaultSearch(VAULT_DIR);

  function rebuildVaultGraph(): void {
    vaultGraph = buildGraph();
  }

  // ── Heartbeat state ────────────────────────────────────────────────────────

  let hbState: RhoState = {
    enabled: true,
    intervalMs: DEFAULT_INTERVAL_MS,
    lastCheckAt: null,
    nextCheckAt: null,
    checkCount: 0,
    heartbeatModel: null,
  };

  let hbTimer: NodeJS.Timeout | null = null;
  let hbStatusTimer: NodeJS.Timeout | null = null;
  let hbCachedModel: ResolvedModel | null = null;

  // Heartbeat leadership: only the first live PID schedules the heartbeat.
  let hbIsLeader = false;
  const hbLockNonce = nanoid(8);
  let hbLease: LeaseHandle | null = null;
  let hbLockOwnerPid: number | null = null;
  let hbLeadershipTimer: NodeJS.Timeout | null = null;
  let hbLeadershipCtx: ExtensionContext | null = null;
  let hbTriggerSeenMtimeMs = 0;
  let hbSettingsTriggerSeenMtimeMs = 0;
  let hbLastSettingsFingerprint: string | null = null;
  let hbExitHandlersInstalled = false;

  // ── Footer: usage + rho status on second line ─────────────────────────────

  const CUSTOM_FOOTER_ENABLED = process.env.RHO_FOOTER !== "0";
  let footerTui: any | null = null;
  let usageBars: { session: number; weekly: number } | null = null;

  const formatUsageBars = (): string => {
    if (!usageBars) return "";
    const s = Math.round(usageBars.session);
    const w = Math.round(usageBars.weekly);
    return `5h:${s}% 7d:${w}%`;
  };

  const formatRhoRole = (): string => {
    if (!hbState.enabled || hbState.intervalMs === 0) return "ρ off";
    if (!hbIsLeader) return "ρ follow";
    if (!hbState.nextCheckAt) return "ρ --m";
    const remaining = Math.max(0, hbState.nextCheckAt - Date.now());
    const mins = Math.ceil(remaining / 60000);
    return `ρ ${mins}m`;
  };

  const formatMemoryCount = (): string => {
    const count = getMemoryCount();
    return count > 0 ? `mem:${count}` : "";
  };

  const formatVaultCount = (): string => {
    try {
      return `vault:${vaultGraph.size}`;
    } catch {
      return "";
    }
  };

  const formatBytes = (bytes: number | null | undefined): string => {
    if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return "n/a";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let idx = 0;
    while (value >= 1024 && idx < units.length - 1) {
      value /= 1024;
      idx += 1;
    }
    const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
    return `${value.toFixed(digits)}${units[idx]}`;
  };

  const formatPercent = (used: number, total: number): string => {
    if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return "n/a";
    return `${Math.max(0, Math.min(100, Math.round((used / total) * 100)))}%`;
  };

  const formatTs = (value: number | null): string => {
    if (!value || !Number.isFinite(value)) return "never";
    return new Date(value).toISOString();
  };

  const formatAge = (value: number | null): string => {
    if (!value || !Number.isFinite(value)) return "never";
    const ms = Math.max(0, Date.now() - value);
    const mins = Math.floor(ms / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  };

  const readDiskStats = (targetPath: string): { total: number; free: number; used: number } | null => {
    try {
      const stat = fs.statfsSync(targetPath);
      const bsize = Number(stat.bsize);
      const blocks = Number(stat.blocks);
      const bavail = Number(stat.bavail);
      if (!Number.isFinite(bsize) || !Number.isFinite(blocks) || bsize <= 0 || blocks <= 0) return null;
      const total = bsize * blocks;
      const free = Math.max(0, bsize * (Number.isFinite(bavail) ? bavail : 0));
      const used = Math.max(0, total - free);
      return { total, free, used };
    } catch {
      return null;
    }
  };

  const buildStatusSnapshot = async (ctx: ExtensionContext): Promise<string> => {
    const cu = ctx.getContextUsage();
    const contextTokens = typeof cu?.tokens === "number" ? cu.tokens : null;
    const contextWindow = typeof cu?.contextWindow === "number" ? cu.contextWindow : null;
    const contextPercent = typeof cu?.percent === "number" ? cu.percent : null;

    const { entries } = readBrain(BRAIN_PATH);
    const brain = foldBrain(entries);
    const memoryCount = getMemoryCount();
    const pendingTasks = brain.tasks.filter((t) => t.status === "pending").length;
    const activeReminders = brain.reminders.filter((r) => r.enabled).length;

    const vaultStatus = getVaultStatus(VAULT_DIR, vaultGraph);

    let hbModelText: string;
    if (hbState.heartbeatModel) {
      hbModelText = `${hbState.heartbeatModel} (pinned)`;
    } else {
      const autoResolved = await resolveHeartbeatModel(ctx);
      if (autoResolved) hbModelText = `${autoResolved.provider}/${autoResolved.model} (auto)`;
      else if (ctx.model) hbModelText = `${ctx.model.provider}/${ctx.model.id} (session fallback)`;
      else hbModelText = "auto (no model available)";
    }

    const leadership = hbIsLeader
      ? `leader (pid ${process.pid})`
      : hbLockOwnerPid
        ? `follower (leader pid ${hbLockOwnerPid})`
        : "follower";

    const usageText = usageBars
      ? `5h ${Math.round(usageBars.session)}%, 7d ${Math.round(usageBars.weekly)}%`
      : "unavailable (run /usage)";

    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = Math.max(0, totalMem - freeMem);
    const procMem = process.memoryUsage();
    const disk = readDiskStats(RHO_DIR);
    const load = os.loadavg().map((n) => n.toFixed(2)).join(", ");

    const lines: string[] = [];
    lines.push("Status:");
    lines.push(`- Time: ${new Date().toISOString()}`);
    lines.push("");
    lines.push("Session:");
    lines.push(`- Model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none"}`);
    lines.push(`- Context: ${contextTokens ?? "unknown"}/${contextWindow ?? "unknown"} tokens (${contextPercent === null ? "n/a" : `${Math.round(contextPercent)}%`})`);
    lines.push(`- Usage: ${usageText}`);
    lines.push("");
    lines.push("Heartbeat:");
    lines.push(`- Enabled: ${hbState.enabled}`);
    lines.push(`- Leadership: ${leadership}`);
    lines.push(`- Interval: ${formatInterval(hbState.intervalMs)}`);
    lines.push(`- Model: ${hbModelText}`);
    lines.push(`- Last check-in: ${formatAge(hbState.lastCheckAt)} (${formatTs(hbState.lastCheckAt)})`);
    lines.push(`- Next check-in: ${hbState.enabled && hbState.nextCheckAt ? `in ${Math.max(0, Math.ceil((hbState.nextCheckAt - Date.now()) / 60000))}m (${formatTs(hbState.nextCheckAt)})` : "not scheduled"}`);
    lines.push(`- Check-ins this session: ${hbState.checkCount}`);
    lines.push("");
    lines.push("Memory + Vault:");
    lines.push(`- Memory count: ${memoryCount} (learnings + preferences)`);
    lines.push(`- Brain: ${pendingTasks} pending tasks, ${activeReminders} active reminders`);
    lines.push(`- Vault: ${vaultStatus.totalNotes} notes, ${vaultStatus.orphanCount} orphans, ${vaultStatus.inboxItems} inbox`);
    lines.push("");
    lines.push("System:");
    lines.push(`- Host uptime: ${Math.floor(os.uptime() / 3600)}h`);
    lines.push(`- Load avg (1m,5m,15m): ${load}`);
    lines.push(`- CPU cores: ${os.cpus().length}`);
    lines.push(`- Memory: ${formatBytes(usedMem)}/${formatBytes(totalMem)} used (${formatPercent(usedMem, totalMem)})`);
    lines.push(`- Process RSS/heap: ${formatBytes(procMem.rss)} / ${formatBytes(procMem.heapUsed)}`);
    lines.push(`- Disk (${RHO_DIR}): ${disk ? `${formatBytes(disk.used)}/${formatBytes(disk.total)} used (${formatPercent(disk.used, disk.total)})` : "n/a"}`);

    return lines.join("\n");
  };

  const setRhoFooter = (ctx: ExtensionContext): void => {
    if (!CUSTOM_FOOTER_ENABLED) return;
    if (!ctx.hasUI) return;

    ctx.ui.setFooter((tui, theme) => {
      footerTui = tui;
      return {
        invalidate() {},
        render(width: number): string[] {
          const cwdPlain = formatPathForHeader(ctx.cwd, width);
          const line1 = theme.fg("dim", truncateToWidth(cwdPlain, width));

          const cu = ctx.getContextUsage();
          const pct = cu ? Math.round(cu.percent) : null;
          const pctPlain = pct === null ? "--%" : `${pct}%`;

          const modelId = ctx.model?.id ?? "";
          let left = pctPlain;
          if (pct !== null) {
            if (pct > 90) left = theme.fg("error", pctPlain);
            else if (pct > 70) left = theme.fg("warning", pctPlain);
          }
          if (modelId) left = theme.fg("dim", modelId) + "  " + left;

          const usage = formatUsageBars();
          const mem = formatMemoryCount();
          const vlt = formatVaultCount();
          const rhoRole = formatRhoRole();
          const rightPlain = [usage, mem, vlt, rhoRole].filter(Boolean).join("  ");
          const right = theme.fg("dim", rightPlain);

          const spaces = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
          const line2 = truncateToWidth(left + " ".repeat(spaces) + right, width);

          return [line1, line2];
        },
      };
    });
  };

  const heartbeatSettingsFingerprint = (): string => {
    return JSON.stringify({ enabled: hbState.enabled, intervalMs: hbState.intervalMs, heartbeatModel: hbState.heartbeatModel });
  };

  const stopHeartbeatTimers = () => {
    if (hbTimer) { clearTimeout(hbTimer); hbTimer = null; }
  };

  const verifyHeartbeatLeadership = (ctx: ExtensionContext): boolean => {
    if (!hbIsLeader) return false;
    if (!hbLease || !hbLease.isCurrent()) {
      hbIsLeader = false;
      hbLease?.release();
      hbLease = null;
      hbLockOwnerPid = readHeartbeatLock()?.pid ?? null;
      stopHeartbeatTimers();
      updateStatusLine(ctx);
      return false;
    }
    return true;
  };

  const installHeartbeatExitHandlers = () => {
    if (hbExitHandlersInstalled) return;
    hbExitHandlersInstalled = true;

    const cleanup = () => {
      stopHeartbeatTimers();
      hbIsLeader = false;
      hbLease?.release();
      hbLease = null;
    };

    process.once("exit", cleanup);
    // Don't terminate the pi process here. Just release the lock so another process can take over.
    process.once("SIGINT", cleanup);
    process.once("SIGTERM", cleanup);
  };

  const startHeartbeatLeadership = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    hbLeadershipCtx = ctx;
    installHeartbeatExitHandlers();

    if (hbLeadershipTimer) return;

    // Attempt leadership immediately.
    const initial = tryAcquireHeartbeatLease(hbLockNonce, Date.now());
    hbLockOwnerPid = initial.ownerPid;
    if (initial.ok) {
      hbIsLeader = true;
      hbLease = initial.lease;
      hbLastSettingsFingerprint = null;
    }

    hbLeadershipTimer = setInterval(() => {
      const liveCtx = hbLeadershipCtx;
      if (!liveCtx || !liveCtx.hasUI) return;
      const now = Date.now();

      if (hbIsLeader) {
        const stillLeader = hbLease ? hbLease.refresh(now) : false;
        if (!stillLeader) {
          hbIsLeader = false;
          hbLease?.release();
          hbLease = null;
          hbLockOwnerPid = readHeartbeatLock()?.pid ?? null;
          stopHeartbeatTimers();
          updateStatusLine(liveCtx);
          return;
        }

        // Pull settings changes written by other processes.
        const before = hbLastSettingsFingerprint ?? heartbeatSettingsFingerprint();
        // Fast-path: if someone touched settings trigger, reload immediately.
        const st = consumeHeartbeatSettingsReload(hbSettingsTriggerSeenMtimeMs);
        hbSettingsTriggerSeenMtimeMs = st.nextSeen;
        if (st.triggered) {
          try { loadHbSettings(); } catch { /* ignore */ }
        } else {
          try { loadHbSettings(); } catch { /* ignore */ }
        }
        const after = heartbeatSettingsFingerprint();
        hbLastSettingsFingerprint = after;
        if (before !== after || (!hbTimer && hbState.enabled && hbState.intervalMs > 0)) {
          scheduleNext(liveCtx);
        }

        // Cross-process trigger requests.
        const trig = consumeHeartbeatTrigger(hbTriggerSeenMtimeMs);
        hbTriggerSeenMtimeMs = trig.nextSeen;
        if (trig.triggered) triggerCheck(liveCtx, { force: true });
        return;
      }

      // Follower: opportunistically take leadership if lock is missing/stale.
      const meta = readLeaseMeta(HEARTBEAT_LOCK_PATH);
      hbLockOwnerPid = meta.payload?.pid ?? null;
      if (!meta.payload || isLeaseStale(meta, HEARTBEAT_LOCK_STALE_MS, now)) {
        const res = tryAcquireHeartbeatLease(hbLockNonce, now);
        hbLockOwnerPid = res.ownerPid;
        if (res.ok) {
          hbIsLeader = true;
          hbLease = res.lease;
          hbLastSettingsFingerprint = null;
          // Schedule immediately on takeover.
          loadHbState();
          // Ensure settings file exists; then apply it.
          loadHbSettings({ createIfMissing: true });
          scheduleNext(liveCtx);
        }
      }
    }, HEARTBEAT_LOCK_REFRESH_MS);
  };

  const updateStatusLine = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    const theme = ctx.ui.theme;

    if (!hbState.enabled || hbState.intervalMs === 0) {
      ctx.ui.setStatus("rho-heartbeat", theme.fg("dim", "ρ off"));
      return;
    }

    if (!hbIsLeader) {
      ctx.ui.setStatus("rho-heartbeat", theme.fg("dim", "ρ follow"));
      return;
    }

    if (!hbState.nextCheckAt) {
      ctx.ui.setStatus("rho-heartbeat", theme.fg("dim", "ρ --m"));
      return;
    }

    const remaining = Math.max(0, hbState.nextCheckAt - Date.now());
    const mins = Math.ceil(remaining / 60000);
    ctx.ui.setStatus("rho-heartbeat", theme.fg("dim", `ρ ${mins}m`));
  };

  const startStatusUpdates = (ctx: ExtensionContext) => {
    if (hbStatusTimer) clearInterval(hbStatusTimer);
    if (!IS_SUBAGENT && ctx.hasUI) {
      updateStatusLine(ctx);
      hbStatusTimer = setInterval(() => updateStatusLine(ctx), 60000);
    }
  };

  const loadHbState = () => {
    // Migrate legacy state
    try {
      if (!fs.existsSync(STATE_PATH) && fs.existsSync(LEGACY_STATE_PATH)) {
        fs.mkdirSync(RHO_DIR, { recursive: true });
        fs.writeFileSync(STATE_PATH, fs.readFileSync(LEGACY_STATE_PATH, "utf-8"));
      }
    } catch { /* ignore */ }

    try {
      const raw = fs.readFileSync(STATE_PATH, "utf-8");
      const parsed = JSON.parse(raw) as Partial<RhoState>;
      // NOTE: Settings are now sourced from rho-settings.json. We still read
      // them from rho-state.json as a fallback for first-run migrations.
      if (typeof parsed.enabled === "boolean") hbState.enabled = parsed.enabled;
      if (parsed.intervalMs !== undefined) hbState.intervalMs = normalizeInterval(parsed.intervalMs);
      if (typeof parsed.lastCheckAt === "number") hbState.lastCheckAt = parsed.lastCheckAt;
      if (typeof parsed.nextCheckAt === "number") hbState.nextCheckAt = parsed.nextCheckAt;
      if (typeof parsed.checkCount === "number" && parsed.checkCount >= 0) hbState.checkCount = parsed.checkCount;
      if (parsed.heartbeatModel === null || typeof parsed.heartbeatModel === "string") {
        hbState.heartbeatModel = parsed.heartbeatModel;
      }
    } catch {
      // ignore
    }
    if (hbState.intervalMs === 0) hbState.enabled = false;
  };

  type HbSettingsFile = {
    version: 1;
    enabled: boolean;
    intervalMs: number;
    heartbeatModel: string | null;
    updatedAt: number;
    writerPid: number;
  };

  const readHbSettingsFile = (): HbSettingsFile | null => {
    try {
      if (!fs.existsSync(SETTINGS_PATH)) return null;
      const raw = fs.readFileSync(SETTINGS_PATH, "utf-8");
      const parsed = JSON.parse(raw) as Partial<HbSettingsFile>;
      if (!parsed || typeof parsed !== "object") return null;
      if (parsed.version !== 1) return null;
      if (typeof parsed.enabled !== "boolean") return null;
      if (typeof parsed.intervalMs !== "number") return null;
      if (!(parsed.heartbeatModel === null || typeof parsed.heartbeatModel === "string")) return null;
      if (typeof parsed.updatedAt !== "number") return null;
      if (typeof parsed.writerPid !== "number") return null;
      return parsed as HbSettingsFile;
    } catch {
      return null;
    }
  };

  const writeHbSettingsFile = (next: { enabled: boolean; intervalMs: number; heartbeatModel: string | null }) => {
    try {
      fs.mkdirSync(RHO_DIR, { recursive: true });
      const payload: HbSettingsFile = {
        version: 1,
        enabled: next.enabled,
        intervalMs: normalizeInterval(next.intervalMs),
        heartbeatModel: next.heartbeatModel,
        updatedAt: Date.now(),
        writerPid: process.pid,
      };
      atomicWriteTextFile(SETTINGS_PATH, JSON.stringify(payload, null, 2));
    } catch {
      // ignore
    }
  };

  const loadHbSettings = (opts?: { createIfMissing?: boolean }) => {
    const settings = readHbSettingsFile();
    if (!settings) {
      if (opts?.createIfMissing) {
        writeHbSettingsFile({
          enabled: hbState.enabled,
          intervalMs: hbState.intervalMs,
          heartbeatModel: hbState.heartbeatModel,
        });
      }
      return;
    }

    hbState.enabled = settings.enabled;
    hbState.intervalMs = normalizeInterval(settings.intervalMs);
    hbState.heartbeatModel = settings.heartbeatModel;
    if (hbState.intervalMs === 0) hbState.enabled = false;
  };

  const saveHbState = () => {
    try {
      fs.mkdirSync(RHO_DIR, { recursive: true });
      // Single-writer: only the heartbeat leader writes rho-state.json.
      if (!hbIsLeader) return;

      atomicWriteTextFile(
        STATE_PATH,
        JSON.stringify(
          {
            enabled: hbState.enabled,
            intervalMs: hbState.intervalMs,
            lastCheckAt: hbState.lastCheckAt,
            nextCheckAt: hbState.nextCheckAt,
            checkCount: hbState.checkCount,
            heartbeatModel: hbState.heartbeatModel,
          },
          null,
          2,
        ),
      );
    } catch {
      /* ignore */
    }
  };

  const reconstructHbState = (ctx: ExtensionContext) => {
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const msg = entry.message;
      if (msg.role !== "toolResult" || msg.toolName !== "rho_control") continue;
      const details = msg.details as RhoDetails | undefined;
      if (details) {
        if (details.enabled !== undefined) hbState.enabled = details.enabled;
        if (details.intervalMs !== undefined) hbState.intervalMs = details.intervalMs;
        if (details.lastCheckAt !== undefined) hbState.lastCheckAt = details.lastCheckAt;
        if (details.nextCheckAt !== undefined) hbState.nextCheckAt = details.nextCheckAt;
        if (details.checkCount !== undefined) hbState.checkCount = details.checkCount;
        if (details.heartbeatModel !== undefined) hbState.heartbeatModel = details.heartbeatModel;
      }
    }
  };

  const resolveHeartbeatModel = async (ctx: ExtensionContext): Promise<ResolvedModel | null> => {
    if (hbState.heartbeatModel) {
      const parts = hbState.heartbeatModel.split("/");
      if (parts.length === 2) {
        const model = ctx.modelRegistry.find(parts[0], parts[1]);
        if (model) {
          const apiKey = await ctx.modelRegistry.getApiKey(model);
          if (apiKey) {
            return { provider: parts[0], model: parts[1], cost: model.cost.output, resolvedAt: Date.now() };
          }
        }
      }
    }

    if (hbCachedModel && (Date.now() - hbCachedModel.resolvedAt) < MODEL_CACHE_TTL_MS) {
      return hbCachedModel;
    }

    try {
      const available = ctx.modelRegistry.getAvailable();
      if (!available.length) return null;
      const sorted = [...available].sort((a, b) => a.cost.output - b.cost.output);
      for (const candidate of sorted) {
        const apiKey = await ctx.modelRegistry.getApiKey(candidate);
        if (apiKey) {
          hbCachedModel = { provider: candidate.provider, model: candidate.id, cost: candidate.cost.output, resolvedAt: Date.now() };
          return hbCachedModel;
        }
      }
    } catch { /* ignore */ }

    return null;
  };

  const buildModelFlags = async (ctx: ExtensionContext): Promise<string> => {
    // 1. Pinned model (explicit user override via rho_control model)
    if (hbState.heartbeatModel) {
      const parts = hbState.heartbeatModel.split("/");
      if (parts.length === 2) {
        const model = ctx.modelRegistry.find(parts[0], parts[1]);
        if (model) {
          const apiKey = await ctx.modelRegistry.getApiKey(model);
          if (apiKey) return `--provider ${shellEscape(parts[0])} --model ${shellEscape(parts[1])} --thinking off`;
        }
      }
    }

    // 2. Auto-resolve cheapest available model (heartbeats don't need frontier)
    try {
      const resolved = await resolveHeartbeatModel(ctx);
      if (resolved) return `--provider ${shellEscape(resolved.provider)} --model ${shellEscape(resolved.model)} --thinking off`;
    } catch { /* ignore */ }

    // 3. Fall back to session model (last resort — expensive but works)
    if (ctx.model) {
      const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
      if (apiKey) return `--provider ${shellEscape(ctx.model.provider)} --model ${shellEscape(ctx.model.id)} --thinking off`;
    }

    return "";
  };

  const scheduleNext = (ctx: ExtensionContext, options?: { reloadFromDisk?: boolean }) => {
    if (options?.reloadFromDisk) {
      try { loadHbState(); } catch { /* ignore */ }
      try { loadHbSettings(); } catch { /* ignore */ }
    }

    if (hbTimer) { clearTimeout(hbTimer); hbTimer = null; }

    // If we think we're the leader, confirm we still own the lock.
    if (hbIsLeader) verifyHeartbeatLeadership(ctx);

    // Disabled: persist settings, clear nextCheckAt locally.
    if (!hbState.enabled || hbState.intervalMs === 0) {
      hbState.nextCheckAt = null;
      saveHbState();
      updateStatusLine(ctx);
      return;
    }

    // Follower: never schedule timers (and never overwrite leader-owned fields).
    if (!hbIsLeader) {
      hbState.nextCheckAt = null;
      updateStatusLine(ctx);
      return;
    }

    const now = Date.now();
    const base = hbState.lastCheckAt && hbState.lastCheckAt <= now ? hbState.lastCheckAt : now;
    let nextAt = base + hbState.intervalMs;
    if (nextAt <= now) nextAt = now + 1000;
    hbState.nextCheckAt = nextAt;

    hbTimer = setTimeout(() => {
      if (!verifyHeartbeatLeadership(ctx)) return;
      triggerCheck(ctx);
    }, Math.max(0, nextAt - now));
    saveHbState();
    updateStatusLine(ctx);
  };

  const triggerCheck = (ctx: ExtensionContext, options?: { force?: boolean }) => {
    if (!ctx.hasUI) return;
    if (!verifyHeartbeatLeadership(ctx)) return;

    const force = options?.force ?? false;

    hbState.lastCheckAt = Date.now();
    hbState.checkCount++;

    // Read brain and extract due reminders + pending tasks
    const { entries } = readBrain(BRAIN_PATH);
    const brain = foldBrain(entries);

    const now = new Date();
    const dueReminders = brain.reminders.filter(r => {
      if (!r.enabled) return false;
      if (force) return true; // force: include all active reminders
      if (!r.next_due) return true; // never run → due immediately
      return new Date(r.next_due) <= now;
    });

    const pendingTasks = brain.tasks.filter(t => t.status === "pending");

    // Skip if nothing to do (only for scheduled checks, not forced)
    if (!force && dueReminders.length === 0 && pendingTasks.length === 0) {
      if (ctx.hasUI) ctx.ui.notify("ρ: skipped (nothing to do)", "info");
      scheduleNext(ctx);
      return;
    }

    // Build heartbeat prompt
    let remindersSection = "None due.";
    if (dueReminders.length > 0) {
      remindersSection = dueReminders.map(r => {
        const priority = r.priority !== "normal" ? ` (${r.priority})` : "";
        const rTags = Array.isArray(r.tags) ? r.tags : [];
        const tags = rTags.length > 0 ? ` [${rTags.join(", ")}]` : "";
        return `- [${r.id}] ${r.text}${priority}${tags}`;
      }).join("\n");
    }

    let tasksSection = "No pending tasks.";
    if (pendingTasks.length > 0) {
      const nowStr = now.toISOString().slice(0, 10);
      tasksSection = pendingTasks.map(t => {
        let line = `- [${t.id}] ${t.description}`;
        if (t.priority !== "normal") line += ` (${t.priority})`;
        if (t.due) {
          if (t.due < nowStr) line += ` **OVERDUE** (due ${t.due})`;
          else line += ` (due ${t.due})`;
        }
        const tTags = Array.isArray(t.tags) ? t.tags : [];
        if (tTags.length > 0) line += ` [${tTags.join(", ")}]`;
        return line;
      }).join("\n");
    }

    const fullPrompt = `You are rho performing a ${force ? "manual" : "scheduled"} check-in.
This is a background process — no user is watching. Output is a log, not a conversation.
Write concise English. No greetings, no conversational tone.

## ${force ? "Active" : "Due"} Reminders
${remindersSection}

## Pending Tasks
${tasksSection}

Instructions:
- Execute each ${force ? "" : "due "}reminder. Use the brain tool's reminder_run action to record results.
- Review pending tasks and act on any that are actionable.
- If nothing needs attention, respond with RHO_OK.`;

    buildModelFlags(ctx).then((modelFlags) => {
      const sentToTmux = runHeartbeatInTmux(fullPrompt, modelFlags || undefined);
      if (!sentToTmux) pi.sendUserMessage(fullPrompt, { deliverAs: "followUp" });
    }).catch(() => {
      const sentToTmux = runHeartbeatInTmux(fullPrompt);
      if (!sentToTmux) pi.sendUserMessage(fullPrompt, { deliverAs: "followUp" });
    });

    scheduleNext(ctx);
  };



  // ── Event Handlers ─────────────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    currentCwd = ctx.cwd;

    if (!IS_SUBAGENT) {
      setRhoHeader(ctx);
      setRhoFooter(ctx);
    }

    // Build brain prompt from brain.jsonl (single source of truth)
    const brainPrompt = rebuildBrainCache(ctx.cwd);
    cachedBrainPrompt = brainPrompt ? "\n\n" + brainPrompt : null;

    // Vault: rebuild graph
    rebuildVaultGraph();

    // Migration detection
    if (!IS_SUBAGENT) {
      const migration = detectMigration();
      if (migration.hasLegacy && !migration.alreadyMigrated) {
        const msg =
          `🧠 Brain migration available: Found legacy files (${migration.legacyFiles.map((f) => path.basename(f)).join(", ")}). ` +
          `Run /migrate to import them into brain.jsonl. ` +
          `Legacy files will be left untouched. Use the brain tool: brain action=add type=meta key=migration.v2 value=skip to dismiss.`;
        if (ctx.hasUI) {
          ctx.ui.notify(msg, "warning");
        }
      }
    }

    // Consolidation suggestion
    if (!IS_SUBAGENT && ctx.hasUI) {
      const { entries } = readBrain(BRAIN_PATH);
      const brain = foldBrain(entries);
      const lastConsolidation = brain.meta.get("memory_consolidate.last_consolidated_at");
      const lastTs = lastConsolidation ? new Date(lastConsolidation.value).getTime() : 0;
      const daysSince = (Date.now() - lastTs) / (1000 * 60 * 60 * 24);

      // Check if entries are being dropped from prompt budget
      const injected = getInjectedIds(brain, ctx.cwd);
      const totalBudgetable = brain.behaviors.length + brain.preferences.length + brain.learnings.length + brain.contexts.length;
      const omitted = totalBudgetable - injected.size;

      if (omitted > 0) {
        const ago = lastTs === 0 ? "never" : `${Math.floor(daysSince)}d ago`;
        ctx.ui.notify(`🧹 ${omitted} entries over budget (last consolidation: ${ago}). Ask the agent to run the memory-consolidate skill`, "warning");
      } else if (daysSince > 1) {
        const ago = lastTs === 0 ? "never" : `${Math.floor(daysSince)}d ago`;
        ctx.ui.notify(`🧹 Memory consolidation available (last: ${ago}). Ask the agent to run the memory-consolidate skill`, "info");
      }
    }

    // Heartbeat: restore state, acquire leadership, and schedule
    if (!IS_SUBAGENT) {
      startHeartbeatLeadership(ctx);
      loadHbState();
      reconstructHbState(ctx);
      loadHbSettings({ createIfMissing: hbIsLeader });
      scheduleNext(ctx);
      startStatusUpdates(ctx);
    }
  });

  pi.on("before_agent_start", async (event, ctx) => {
    // Rebuild brain cache if the file changed (e.g. another session wrote to it)
    if (isBrainCacheStale()) {
      rebuildBrainCache(currentCwd);
    }

    // Build meta prompt (runtime environment + tool usage instructions)
    const metaPrompt = buildMetaPrompt({
      agentName: readAgentName(),
      hbState,
      hbIsLeader,
      vaultNoteCount: vaultGraph.size,
      ctx,
      isSubagent: IS_SUBAGENT,
    });

    const sections = [metaPrompt, cachedBrainPrompt].filter(Boolean);
    if (sections.length > 0) {
      return { systemPrompt: event.systemPrompt + "\n\n" + sections.join("\n\n") };
    }
  });

  pi.on("agent_end", async (event, ctx) => {
    // Auto-memory extraction
    if (!IS_SUBAGENT && !autoMemoryInFlight && getAutoMemoryEffective().enabled) {
      autoMemoryInFlight = true;
      try {
        const result = await runAutoMemoryExtraction(event.messages, ctx, { source: "auto" });
        if (result && (result.storedLearnings > 0 || result.storedPrefs > 0)) {
        }
      } catch (error) {
        if (AUTO_MEMORY_DEBUG && ctx.hasUI) {
          ctx.ui.notify(`Auto-memory error: ${error instanceof Error ? error.message : String(error)}`, "error");
        }
      } finally {
        autoMemoryInFlight = false;
      }
    }

    // Heartbeat: detect RHO_OK
    if (!IS_SUBAGENT) {
      const lastMessage = event.messages[event.messages.length - 1];
      if (lastMessage?.role === "assistant" && lastMessage.content) {
        const text = lastMessage.content
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("");
        const lines = text.split("\n").map(l => l.trim()).filter(Boolean);
        const lastLine = lines[lines.length - 1] ?? "";
        const isRhoOk = /\bRHO_OK\b/.test(lastLine);
        if (isRhoOk) {
          ctx.ui.notify("ρ: OK (no alerts)", "info");
        }
      }
    }
  });

  pi.on("session_before_compact", async (event, ctx) => {
    if (!getAutoMemoryEffective().enabled || !COMPACT_MEMORY_FLUSH_ENABLED || compactMemoryInFlight) return;
    if (event.signal.aborted) return;

    const messages = Array.from(
      new Set([...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages])
    );
    if (messages.length === 0) return;

    compactMemoryInFlight = true;
    try {
      const result = await runAutoMemoryExtraction(messages, ctx, { source: "compaction", signal: event.signal });
    } catch (error) {
      if (AUTO_MEMORY_DEBUG && ctx.hasUI) {
        ctx.ui.notify(`Auto-memory error: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    } finally {
      compactMemoryInFlight = false;
    }
  });

  if (!IS_SUBAGENT) {
    pi.on("session_switch", async (_event, ctx) => {
      setRhoHeader(ctx);
      setRhoFooter(ctx);
      startHeartbeatLeadership(ctx);
      loadHbState();
      reconstructHbState(ctx);
      loadHbSettings({ createIfMissing: hbIsLeader });
      scheduleNext(ctx);
      startStatusUpdates(ctx);
    });

    pi.on("session_fork", async (_event, ctx) => {
      setRhoHeader(ctx);
      setRhoFooter(ctx);
      startHeartbeatLeadership(ctx);
      loadHbState();
      reconstructHbState(ctx);
      loadHbSettings({ createIfMissing: hbIsLeader });
      scheduleNext(ctx);
      startStatusUpdates(ctx);
    });

    pi.on("session_shutdown", async () => {
      unsubscribeUsage();
      footerTui = null;
      usageBars = null;

      if (hbTimer) { clearTimeout(hbTimer); hbTimer = null; }
      if (hbStatusTimer) { clearInterval(hbStatusTimer); hbStatusTimer = null; }
      if (hbLeadershipTimer) { clearInterval(hbLeadershipTimer); hbLeadershipTimer = null; }
      hbIsLeader = false;
      hbLeadershipCtx = null;
      hbLease?.release();
      hbLease = null;
    });
  }

  // ── Tool: brain (unified memory/tasks/reminders) ────────────────────────────

  pi.registerTool({
    name: "brain",
    label: "Brain",
    description:
      "Manage persistent memory, tasks, and reminders. " +
      "Actions: add, update, remove, list, decay, task_done, task_clear, reminder_run",
    parameters: Type.Object({
      action: Type.String({ description: "Action: add, update, remove, list, decay, task_done, task_clear, reminder_run" }),
      // All other params are optional — schema registry validates per-type
      type: Type.Optional(Type.String({ description: "Entry type for add/list/remove: behavior, identity, user, learning, preference, context, task, reminder" })),
      id: Type.Optional(Type.String({ description: "Entry id for update/remove/task_done/reminder_run" })),
      text: Type.Optional(Type.String()),
      category: Type.Optional(Type.String()),
      key: Type.Optional(Type.String()),
      value: Type.Optional(Type.String()),
      description: Type.Optional(Type.String()),
      project: Type.Optional(Type.String()),
      path: Type.Optional(Type.String()),
      content: Type.Optional(Type.String()),
      priority: Type.Optional(Type.String()),
      tags: Type.Optional(Type.String({ description: "Comma-separated tags" })),
      due: Type.Optional(Type.String()),
      enabled: Type.Optional(Type.Boolean()),
      cadence: Type.Optional(Type.Any({ description: "Cadence object: {kind:'interval',every:'2h'} or {kind:'daily',at:'08:00'}" })),
      query: Type.Optional(Type.String({ description: "Search query for list action" })),
      filter: Type.Optional(Type.String({ description: "Filter for list: pending, done, all, active, disabled" })),
      verbose: Type.Optional(Type.Boolean({ description: "Show full JSON in list output" })),
      result: Type.Optional(Type.String({ description: "Result for reminder_run: ok, error, skipped" })),
      error: Type.Optional(Type.String({ description: "Error message for reminder_run" })),
      reason: Type.Optional(Type.String({ description: "Reason for remove" })),
      source: Type.Optional(Type.String()),
      scope: Type.Optional(Type.String()),
      projectPath: Type.Optional(Type.String()),
      status: Type.Optional(Type.String()),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await handleBrainAction(BRAIN_PATH, params, {
        cwd: ctx.cwd,
        decayAfterDays: memorySettings.decayAfterDays,
        decayMinScore: memorySettings.decayMinScore,
      });
      if (result.ok) brainCache = null; // invalidate on writes
      return {
        content: [{ type: "text", text: result.message }],
        details: { ok: result.ok, data: result.data },
      };
    },

    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("brain ")) + theme.fg("muted", args.action);
      if (args.type) text += " " + theme.fg("accent", args.type);
      if (args.text) {
        const desc = args.text.length > 50 ? args.text.slice(0, 47) + "..." : args.text;
        text += " " + theme.fg("dim", desc);
      }
      if (args.description) {
        const desc = args.description.length > 50 ? args.description.slice(0, 47) + "..." : args.description;
        text += " " + theme.fg("dim", desc);
      }
      if (args.id) text += " " + theme.fg("accent", args.id);
      return new Text(text, 0, 0);
    },

    renderResult(result, _options, theme) {
      const details = result.details as { ok: boolean; data?: any } | undefined;
      if (!details?.ok) {
        const text = result.content[0];
        return new Text(theme.fg("error", text?.type === "text" ? text.text : "Error"), 0, 0);
      }
      const text = result.content[0];
      return new Text(theme.fg("success", ">> ") + (text?.type === "text" ? text.text : ""), 0, 0);
    },
  });

  // ── Tool: vault ────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "vault",
    label: "Vault",
    description:
      "Knowledge graph for persistent notes with wikilinks. " +
      "Actions: capture (quick inbox entry), read (note + backlinks), write (create/update with quality gate), " +
      "status (vault stats), list (filter by type/query), search (FTS5 with ripgrep fallback). " +
      "Notes require frontmatter, a ## Connections section with [[wikilinks]], except log type.",
    parameters: Type.Object({
      action: StringEnum(["capture", "read", "write", "status", "list", "search"] as const),
      slug: Type.Optional(Type.String({ description: "Note slug (kebab-case filename without .md)" })),
      content: Type.Optional(Type.String({ description: "Note content (full markdown for write, text for capture)" })),
      type: Type.Optional(Type.String({ description: "Note type: concept, project, pattern, reference, log, moc" })),
      source: Type.Optional(Type.String({ description: "Source of the note (conversation, url, etc)" })),
      context: Type.Optional(Type.String({ description: "Additional context for capture entries" })),
      query: Type.Optional(Type.String({ description: "Query for list/search actions" })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "(search) Filter to notes containing ALL of these tags." })),
      limit: Type.Optional(Type.Number({ description: "(search) Max results (default 10, max 30)." })),
      mode: Type.Optional(StringEnum(["fts", "grep"] as const, { description: "(search) Force search mode." })),
      include_content: Type.Optional(Type.Boolean({ description: "(search) Include full note content (truncated). Default false." })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      switch (params.action) {
        case "capture": {
          if (!params.content) return { content: [{ type: "text", text: "Error: content required for capture" }], details: { error: true } };
          const entry = captureToInbox(VAULT_DIR, params.content, params.source, params.context);
          return { content: [{ type: "text", text: `Captured to inbox:\n${entry}` }], details: { action: "capture" } };
        }

        case "read": {
          if (!params.slug) return { content: [{ type: "text", text: "Error: slug required for read" }], details: { error: true } };
          const result = readNote(VAULT_DIR, params.slug, vaultGraph);
          if (!result) return { content: [{ type: "text", text: `Note not found: ${params.slug}` }], details: { error: true, slug: params.slug } };
          let text = result.content;
          if (result.backlinks.length > 0) {
            text += "\n\n---\n**Backlinks:** " + result.backlinks.map((b) => `[[${b}]]`).join(", ");
          }
          return { content: [{ type: "text", text }], details: { action: "read", slug: params.slug, backlinks: result.backlinks } };
        }

        case "write": {
          if (!params.slug) return { content: [{ type: "text", text: "Error: slug required for write" }], details: { error: true } };
          if (!params.content) return { content: [{ type: "text", text: "Error: content required for write" }], details: { error: true } };
          const noteType = params.type || "concept";
          const result = writeNote(VAULT_DIR, params.slug, params.content, noteType);
          if (!result.valid) return { content: [{ type: "text", text: `Rejected: ${result.reason}` }], details: { error: true, reason: result.reason } };
          rebuildVaultGraph();
          return { content: [{ type: "text", text: `Written: ${params.slug} -> ${result.path}` }], details: { action: "write", slug: params.slug, path: result.path, type: noteType } };
        }

        case "status": {
          const status = getVaultStatus(VAULT_DIR, vaultGraph);
          const typeCounts = Object.entries(status.byType).map(([t, n]) => `${t}: ${n}`).join(", ");
          const text = [
            `Vault Status`,
            `  Total notes: ${status.totalNotes}`,
            `  By type: ${typeCounts || "none"}`,
            `  Orphans: ${status.orphanCount}`,
            `  Inbox items: ${status.inboxItems}`,
            `  Avg links/note: ${status.avgLinksPerNote.toFixed(1)}`,
          ].join("\n");
          return { content: [{ type: "text", text }], details: { action: "status", ...status } };
        }

        case "list": {
          const notes = listNotes(vaultGraph, params.type, params.query);
          if (notes.length === 0) {
            const filters = [params.type ? `type=${params.type}` : "", params.query ? `query="${params.query}"` : ""].filter(Boolean).join(", ");
            return { content: [{ type: "text", text: filters ? `No notes found matching: ${filters}` : "Vault is empty." }], details: { action: "list", count: 0 } };
          }
          const lines = notes.map((n) => `- **${n.title}** (${n.slug}) [${n.type}] ${n.linkCount}L/${n.backlinkCount}BL${n.updated ? ` updated:${n.updated}` : ""}`);
          const header = params.type ? `${notes.length} ${params.type} note(s)` : `${notes.length} note(s)`;
          return { content: [{ type: "text", text: `${header}${params.query ? ` matching "${params.query}"` : ""}:\n${lines.join("\n")}` }], details: { action: "list", count: notes.length } };
        }

        case "search": {
          if (!params.query) {
            return { content: [{ type: "text", text: "Error: query required for search" }], details: { error: true } };
          }

          const res = await vaultSearcher.search({
            query: params.query,
            type: params.type,
            tags: params.tags,
            limit: params.limit,
            mode: params.mode,
            include_content: params.include_content,
          } as any);

          if (res.results.length === 0) {
            return {
              content: [{ type: "text", text: `No results for "${params.query}" (searched ${res.indexed} notes).` }],
              details: { action: "search", query: params.query, mode: res.mode, total: 0, indexed: res.indexed },
            };
          }

          const lines = res.results.map((r, i) => {
            let line = `${i + 1}. **${r.title}** (${r.path}) [${r.type}]`;
            if (Array.isArray(r.tags) && r.tags.length > 0) line += ` {${r.tags.join(", ")}}`;
            if (r.score) line += ` score:${Number(r.score).toFixed(3)}`;
            if (r.snippet) line += `\n   ${r.snippet}`;
            if (r.wikilinks?.length > 0) line += `\n   links: ${r.wikilinks.map((l) => `[[${l}]]`).join(", ")}`;
            if (r.content) line += `\n---\n${r.content}\n---`;
            return line;
          });

          const header = `${res.results.length} result(s) for "${params.query}" (${res.mode}, ${res.indexed} notes)`;
          return {
            content: [{ type: "text", text: `${header}\n\n${lines.join("\n\n")}` }],
            details: { action: "search", query: params.query, mode: res.mode, total: res.results.length, indexed: res.indexed },
          };
        }

        default:
          return { content: [{ type: "text", text: "Unknown action" }], details: { error: true } };
      }
    },
  });

  // ── Tool: rho_control ──────────────────────────────────────────────────────

  if (!IS_SUBAGENT) {
    pi.registerTool({
      name: "rho_control",
      label: "Rho",
      description: "Control the rho check-in system. Actions: enable, disable, trigger (immediate), status (get info), interval (set with interval string like '30m' or '1h'), model (set heartbeat model: 'auto' or 'provider/model-id')",
      parameters: Type.Object({
        action: StringEnum(["enable", "disable", "trigger", "status", "interval", "model"] as const),
        interval: Type.Optional(Type.String({ description: "Interval string for 'interval' action (e.g., '30m', '1h', '15min'). Use '0' to disable." })),
        model: Type.Optional(Type.String({ description: "Model for 'model' action. 'auto' to use session model, or 'provider/model-id' to pin." })),
      }),

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        switch (params.action) {
          case "enable":
            hbState.enabled = true;
            if (hbState.intervalMs === 0) hbState.intervalMs = DEFAULT_INTERVAL_MS;
            writeHbSettingsFile({ enabled: hbState.enabled, intervalMs: hbState.intervalMs, heartbeatModel: hbState.heartbeatModel });
            requestHeartbeatSettingsReload(Date.now());
            scheduleNext(ctx);
            return { content: [{ type: "text", text: "Rho enabled" }], details: { action: "enable", enabled: hbState.enabled } as RhoDetails };

          case "disable":
            hbState.enabled = false;
            writeHbSettingsFile({ enabled: hbState.enabled, intervalMs: hbState.intervalMs, heartbeatModel: hbState.heartbeatModel });
            requestHeartbeatSettingsReload(Date.now());
            scheduleNext(ctx);
            return { content: [{ type: "text", text: "Rho disabled" }], details: { action: "disable", enabled: hbState.enabled } as RhoDetails };

          case "trigger":
            if (!ctx.hasUI) {
              return { content: [{ type: "text", text: "Error: Cannot trigger rho in non-interactive mode" }], details: { action: "trigger", wasTriggered: false } as RhoDetails };
            }
            if (!hbIsLeader) {
              requestHeartbeatTrigger(Date.now());
              const leaderText = hbLockOwnerPid ? ` (leader pid ${hbLockOwnerPid})` : "";
              return { content: [{ type: "text", text: `Requested rho check-in${leaderText}` }], details: { action: "trigger", wasTriggered: false } as RhoDetails };
            }
            triggerCheck(ctx, { force: true });
            return { content: [{ type: "text", text: "Rho check-in triggered" }], details: { action: "trigger", wasTriggered: true, lastCheckAt: hbState.lastCheckAt, checkCount: hbState.checkCount } as RhoDetails };

          case "interval": {
            if (!params.interval) {
              return { content: [{ type: "text", text: `Current interval: ${formatInterval(hbState.intervalMs)}` }], details: { action: "interval", intervalMs: hbState.intervalMs } as RhoDetails };
            }
            const intervalMs = parseInterval(params.interval);
            if (intervalMs === null) {
              return { content: [{ type: "text", text: `Error: Invalid interval '${params.interval}'. Use format like '30m', '1h', or '0' to disable.` }], details: { action: "interval", intervalMs: hbState.intervalMs } as RhoDetails };
            }
            if (intervalMs !== 0 && (intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS)) {
              return { content: [{ type: "text", text: "Error: Interval must be between 5m and 24h (or 0 to disable)" }], details: { action: "interval", intervalMs: hbState.intervalMs } as RhoDetails };
            }
            hbState.intervalMs = intervalMs;
            if (intervalMs === 0) hbState.enabled = false;
            writeHbSettingsFile({ enabled: hbState.enabled, intervalMs: hbState.intervalMs, heartbeatModel: hbState.heartbeatModel });
            requestHeartbeatSettingsReload(Date.now());
            scheduleNext(ctx);
            const status = intervalMs === 0 ? "disabled" : `set to ${formatInterval(intervalMs)}`;
            return { content: [{ type: "text", text: `Rho interval ${status}` }], details: { action: "interval", intervalMs: hbState.intervalMs, enabled: hbState.enabled } as RhoDetails };
          }

          case "status": {
            // Read brain for reminder/task counts
            const { entries: statusEntries } = readBrain(BRAIN_PATH);
            const statusBrain = foldBrain(statusEntries);
            const activeReminders = statusBrain.reminders.filter(r => r.enabled).length;
            const pendingTaskCount = statusBrain.tasks.filter(t => t.status === "pending").length;

            let hbModelText: string;
            let hbModelSource: "auto" | "pinned" = "auto";
            let hbModelCost: number | undefined;
            if (hbState.heartbeatModel) {
              hbModelSource = "pinned";
              hbModelText = `${hbState.heartbeatModel} (pinned)`;
              const parts = hbState.heartbeatModel.split("/");
              if (parts.length === 2) { const m = ctx.modelRegistry.find(parts[0], parts[1]); if (m) hbModelCost = m.cost.output; }
            } else {
              // Show what auto-resolve would actually pick
              const autoResolved = await resolveHeartbeatModel(ctx);
              if (autoResolved) {
                hbModelText = `${autoResolved.provider}/${autoResolved.model} (auto)`;
                hbModelCost = autoResolved.cost;
              } else if (ctx.model) {
                hbModelText = `${ctx.model.provider}/${ctx.model.id} (session fallback)`;
                hbModelCost = ctx.model.cost.output;
              } else {
                hbModelText = "auto (no model available)";
              }
            }

            let text = `Rho status:\n`;
            text += `- Enabled: ${hbState.enabled}\n`;
            const leaderLine = hbIsLeader
              ? `leader (pid ${process.pid})`
              : hbLockOwnerPid
                ? `follower (leader pid ${hbLockOwnerPid})`
                : "follower";
            text += `- Leadership: ${leaderLine}\n`;
            text += `- Interval: ${formatInterval(hbState.intervalMs)}\n`;
            text += `- Heartbeat model: ${hbModelText}\n`;
            text += `- Total check-ins this session: ${hbState.checkCount}\n`;
            if (hbState.lastCheckAt) {
              text += `- Last check-in: ${Math.floor((Date.now() - hbState.lastCheckAt) / (60 * 1000))}m ago\n`;
            } else {
              text += `- Last check-in: never\n`;
            }
            if (hbState.nextCheckAt && hbState.enabled && hbState.intervalMs > 0) {
              text += `- Next check-in: in ${Math.ceil((hbState.nextCheckAt - Date.now()) / (60 * 1000))}m\n`;
            }
            text += `- Brain: ${activeReminders} active reminders, ${pendingTaskCount} pending tasks`;

            return { content: [{ type: "text", text }], details: { action: "status", enabled: hbState.enabled, intervalMs: hbState.intervalMs, lastCheckAt: hbState.lastCheckAt, nextCheckAt: hbState.nextCheckAt, checkCount: hbState.checkCount, heartbeatModel: hbState.heartbeatModel, heartbeatModelSource: hbModelSource, heartbeatModelCost: hbModelCost } as RhoDetails };
          }

          case "model": {
            const modelArg = params.model?.trim();
            if (!modelArg) {
              const source = hbState.heartbeatModel ? "pinned" : "auto";
              return { content: [{ type: "text", text: `Heartbeat model: ${hbState.heartbeatModel || "auto"} (${source})` }], details: { action: "model", heartbeatModel: hbState.heartbeatModel, heartbeatModelSource: source } as RhoDetails };
            }
            if (modelArg === "auto") {
              hbState.heartbeatModel = null;
              hbCachedModel = null;
              writeHbSettingsFile({ enabled: hbState.enabled, intervalMs: hbState.intervalMs, heartbeatModel: hbState.heartbeatModel });
              requestHeartbeatSettingsReload(Date.now());
              return { content: [{ type: "text", text: "Heartbeat model set to auto (uses session model)" }], details: { action: "model", heartbeatModel: null, heartbeatModelSource: "auto" } as RhoDetails };
            }
            const parts = modelArg.split("/");
            if (parts.length !== 2) {
              return { content: [{ type: "text", text: `Error: Model must be 'provider/model-id' or 'auto'. Got: '${modelArg}'` }], details: { action: "model" } as RhoDetails };
            }
            const model = ctx.modelRegistry.find(parts[0], parts[1]);
            if (!model) {
              return { content: [{ type: "text", text: `Error: Model '${modelArg}' not found. Use --list-models to see available models.` }], details: { action: "model" } as RhoDetails };
            }
            hbState.heartbeatModel = modelArg;
            writeHbSettingsFile({ enabled: hbState.enabled, intervalMs: hbState.intervalMs, heartbeatModel: hbState.heartbeatModel });
            requestHeartbeatSettingsReload(Date.now());
            return { content: [{ type: "text", text: `Heartbeat model pinned to ${modelArg} ($${model.cost.output}/M output)` }], details: { action: "model", heartbeatModel: modelArg, heartbeatModelSource: "pinned", heartbeatModelCost: model.cost.output } as RhoDetails };
          }
        }
      },

      renderCall(args, theme) {
        let text = theme.fg("toolTitle", theme.bold("rho ")) + theme.fg("muted", args.action);
        if (args.interval) text += ` ${theme.fg("accent", args.interval)}`;
        if (args.model) text += ` ${theme.fg("accent", args.model)}`;
        return new Text(text, 0, 0);
      },

      renderResult(result, _options, theme) {
        const details = result.details as RhoDetails | undefined;
        if (!details) {
          const text = result.content[0];
          return new Text(text?.type === "text" ? text.text : "", 0, 0);
        }
        if (details.action === "status") return new Text(theme.fg("dim", `ρ ${formatInterval(details.intervalMs || DEFAULT_INTERVAL_MS)}`), 0, 0);
        if (details.action === "trigger") return new Text(theme.fg("success", "✓ Triggered"), 0, 0);
        const st = details.enabled ? theme.fg("success", "on") : theme.fg("dim", "off");
        return new Text(theme.fg("success", "✓ ") + theme.fg("muted", `${details.action} `) + st, 0, 0);
      },
    });

    // ── Tool: rho_subagent ─────────────────────────────────────────────────────

    pi.registerTool({
      name: "rho_subagent",
      label: "Subagent",
      description: `Run a pi subagent in a new tmux window (session '${DEFAULT_SESSION_NAME}' by default). Default mode is interactive; print mode writes results to ~/.rho/results.`,
      parameters: Type.Object({
        prompt: Type.String({ description: "Prompt to run in the subagent" }),
        session: Type.Optional(Type.String({ description: `tmux session name (default: ${DEFAULT_SESSION_NAME})` })),
        window: Type.Optional(Type.String({ description: "tmux window name (auto-generated if omitted)" })),
        mode: Type.Optional(StringEnum(["interactive", "print"] as const)),
        outputFile: Type.Optional(Type.String({ description: "Output file path (print mode only; default: ~/.rho/results/<timestamp>.json)" })),
      }),

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const prompt = params.prompt?.trim();
        if (!prompt) return { content: [{ type: "text", text: "Error: prompt required" }], details: { error: true } };

        try { execSync("command -v tmux", { stdio: "ignore" }); } catch {
          return { content: [{ type: "text", text: "Error: tmux not installed" }], details: { error: true } };
        }

        const sessionName = (params.session || DEFAULT_SESSION_NAME).trim() || DEFAULT_SESSION_NAME;
        const mode = (params.mode || "interactive").trim().toLowerCase();
        if (mode !== "interactive" && mode !== "print") {
          return { content: [{ type: "text", text: "Error: mode must be 'interactive' or 'print'" }], details: { error: true } };
        }

        try { execSync(`tmux -L ${shellEscape(sessionName)} has-session -t ${shellEscape(sessionName)}`, { stdio: "ignore" }); } catch {
          return { content: [{ type: "text", text: `Error: tmux session '${sessionName}' not found` }], details: { error: true } };
        }

        fs.mkdirSync(RESULTS_DIR, { recursive: true });

        const windowSeed = new Date().toISOString().slice(11, 16).replace(":", "");
        const windowName = sanitizeWindowName(params.window?.trim() || `subagent-${windowSeed}`);

        const outputFileRaw = params.outputFile?.trim();
        const outputFile = outputFileRaw
          ? outputFileRaw.startsWith("/") ? outputFileRaw : path.join(ctx.cwd, outputFileRaw)
          : path.join(RESULTS_DIR, `${Date.now()}.json`);

        let modelFlags = "";
        if (ctx.model) modelFlags = ` --provider ${shellEscape(ctx.model.provider)} --model ${shellEscape(ctx.model.id)}`;

        const shellPath = process.env.SHELL || "bash";
        const script =
          mode === "print"
            ? `RHO_SUBAGENT=1 pi -p --no-session${modelFlags} ${shellEscape(prompt)} 2>&1 | tee ${shellEscape(outputFile)}; exec ${shellEscape(shellPath)}`
            : `RHO_SUBAGENT=1 pi --no-session${modelFlags} ${shellEscape(prompt)}; exec ${shellEscape(shellPath)}`;
        const innerCommand = `bash -lc ${shellEscape(script)}`;
        const tmuxCommand = `tmux -L ${shellEscape(sessionName)} new-window -d -P -F "#{session_name}:#{window_index}" -t ${shellEscape(sessionName)} -n ${shellEscape(windowName)} ${shellEscape(innerCommand)}`;

        let windowId = "";
        try {
          windowId = execSync(tmuxCommand, { encoding: "utf-8" }).trim();
          if (windowId) execSync(`tmux -L ${shellEscape(sessionName)} set-option -t ${shellEscape(windowId)} remain-on-exit on`, { stdio: "ignore" });
        } catch {
          return { content: [{ type: "text", text: "Error: failed to create tmux window" }], details: { error: true } };
        }

        const message = mode === "print"
          ? `Started subagent in ${windowId} (output: ${outputFile})`
          : `Started subagent in ${windowId} (interactive mode)`;
        return { content: [{ type: "text", text: message }], details: { session: sessionName, window: windowId, outputFile: mode === "print" ? outputFile : undefined, mode } };
      },
    });
  }

  // ── Command: /brain ────────────────────────────────────────────────────────

  pi.registerCommand("brain", {
    description: "View brain stats or search (usage: /brain [stats|search <query>])",
    handler: async (args, ctx) => {
      const parts = args?.trim().split(/\s+/) || [];
      const subcmd = parts[0] || "stats";

      const { entries } = readBrain(BRAIN_PATH);
      const brain = foldBrain(entries);

      if (subcmd === "stats" || !subcmd) {
        const lCount = brain.learnings.length;
        const pCount = brain.preferences.length;
        const tCount = brain.tasks.length;
        const rCount = brain.reminders.length;
        const idCount = brain.identity.size;
        const uCount = brain.user.size;
        const bCount = brain.behaviors.length;
        ctx.ui.notify(`🧠 ${lCount}L ${pCount}P ${tCount}T ${rCount}R | ${bCount}beh ${idCount}id ${uCount}usr`, "info");
      } else if (subcmd === "search") {
        const query = parts.slice(1).join(" ").toLowerCase();
        if (!query) { ctx.ui.notify("Usage: /brain search <query>", "error"); return; }

        // Search across all text fields in all entry types
        const allSearchable: Array<{ type: string; id: string; text: string }> = [];
        for (const b of brain.behaviors) allSearchable.push({ type: "behavior", id: b.id, text: b.text });
        for (const l of brain.learnings) allSearchable.push({ type: "learning", id: l.id, text: l.text });
        for (const p of brain.preferences) allSearchable.push({ type: "preference", id: p.id, text: `[${p.category}] ${p.text}` });
        for (const t of brain.tasks) allSearchable.push({ type: "task", id: t.id, text: t.description });
        for (const r of brain.reminders) allSearchable.push({ type: "reminder", id: r.id, text: r.text });
        for (const [, v] of brain.identity) allSearchable.push({ type: "identity", id: v.id, text: `${v.key}: ${v.value}` });
        for (const [, v] of brain.user) allSearchable.push({ type: "user", id: v.id, text: `${v.key}: ${v.value}` });

        const matches = allSearchable.filter(e => e.text.toLowerCase().includes(query));
        if (matches.length === 0) {
          ctx.ui.notify("No matches", "info");
        } else {
          const lines = matches.slice(0, 10).map(m => `[${m.type}:${m.id}] ${m.text}`);
          const more = matches.length > 10 ? `\n(+${matches.length - 10} more)` : "";
          ctx.ui.notify(`Found ${matches.length} matches:\n${lines.join("\n")}${more}`, "info");
        }
      } else {
        ctx.ui.notify("Usage: /brain [stats|search <query>]", "error");
      }
    },
  });

  // ── Command: /migrate ────────────────────────────────────────────────────

  pi.registerCommand("migrate", {
    description: "Migrate legacy brain files to brain.jsonl",
    handler: async (_args, ctx) => {
      const migration = detectMigration();
      if (migration.alreadyMigrated) {
        ctx.ui.notify("Migration already completed.", "info");
        return;
      }
      if (!migration.hasLegacy) {
        ctx.ui.notify("No legacy files to migrate.", "info");
        return;
      }
      ctx.ui.notify("Starting migration...", "info");
      const stats = await runMigration();
      brainCache = null; // invalidate
      const parts: string[] = [];
      if (stats.behaviors) parts.push(`${stats.behaviors} behaviors`);
      if (stats.identity) parts.push(`${stats.identity} identity`);
      if (stats.user) parts.push(`${stats.user} user`);
      if (stats.learnings) parts.push(`${stats.learnings} learnings`);
      if (stats.preferences) parts.push(`${stats.preferences} preferences`);
      if (stats.contexts) parts.push(`${stats.contexts} contexts`);
      if (stats.tasks) parts.push(`${stats.tasks} tasks`);
      const summary = parts.length ? parts.join(", ") : "nothing new";
      ctx.ui.notify(`✅ Migration complete: ${summary} (${stats.skipped} skipped)`, "success");
    },
  });

  // /tasks and /vault commands owned by their TUI extensions (extensions/tasks, extensions/vault-search-tui)

  // ── Workflow command shortcuts ───────────────────────────────────────────────

  pi.registerCommand("plan", {
    description: "Shortcut for /skill:pdd",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const command = trimmed ? `/skill:pdd ${trimmed}` : "/skill:pdd";
      pi.sendUserMessage(command);
      if (ctx.hasUI) ctx.ui.notify(`Forwarded to ${command}`, "info");
    },
  });

  pi.registerCommand("code", {
    description: "Shortcut for /skill:code-assist",
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      const command = trimmed ? `/skill:code-assist ${trimmed}` : "/skill:code-assist";
      pi.sendUserMessage(command);
      if (ctx.hasUI) ctx.ui.notify(`Forwarded to ${command}`, "info");
    },
  });

  // ── Command: /subagents ──────────────────────────────────────────────────────

  if (!IS_SUBAGENT) {
    pi.registerCommand("subagents", {
      description: "List active subagent tmux windows",
      handler: async (_args, ctx) => {
        try {
          const sessionName = DEFAULT_SESSION_NAME;
          // List windows in the agent session, using the dedicated socket
          const result = execSync(
            `tmux -L ${shellEscape(sessionName)} list-windows -t ${shellEscape(sessionName)} -F "#{window_index}:#{window_name}:#{pane_dead}"`,
            { encoding: "utf-8" }
          );
          const windows = result.trim().split("\n").filter(Boolean);
          const subagents = windows
            .map(line => {
              const [idx, name, dead] = line.split(":");
              return { idx, name, dead: dead === "1" };
            })
            .filter(w => w.name.startsWith("subagent") || w.name === "heartbeat");

          if (subagents.length === 0) {
            ctx.ui.notify("No active subagent windows.", "info");
            return;
          }

          const lines = subagents.map(w => {
            const status = w.dead ? "done" : "running";
            return `${w.name} (window ${w.idx}): ${status}`;
          });
          ctx.ui.notify(`Subagents (${subagents.length}):\n${lines.join("\n")}`, "info");
        } catch {
          ctx.ui.notify("No tmux session found.", "info");
        }
      },
    });
  }

  // ── Command: /bootstrap ─────────────────────────────────────────────────────

  if (!IS_SUBAGENT) {
    pi.registerCommand("bootstrap", {
      description: "Brain bootstrap lifecycle: status, run, reapply, upgrade, diff, reset, audit",
      handler: async (args, ctx) => {
        const result = handleBootstrapSlash(args, (cliArgs) => runBootstrapCliFromExtension(__dirname, cliArgs));
        const level = result.notify.level;
        const text = result.notify.text;

        if (ctx.hasUI) ctx.ui.notify(text, level);

        if (!result.ok && !ctx.hasUI) {
          // In headless mode, still surface failures.
          console.error(text);
        }
      },
    });
  }

  // ── Command: /status ───────────────────────────────────────────────────────

  if (!IS_SUBAGENT) {
    pi.registerCommand("status", {
      description: "Show full runtime status (model, context, usage, heartbeat, memory/vault, system metrics)",
      handler: async (_args, ctx) => {
        const text = await buildStatusSnapshot(ctx);
        ctx.ui.notify(text, "info");
      },
    });

    // ── Command: /rho ──────────────────────────────────────────────────────────

    pi.registerCommand("rho", {
      description: "Control rho check-in system: status, enable, disable, now, interval <time>, model <auto|provider/model>, automemory <on|off|toggle>",
      handler: async (args, ctx) => {
        const [subcmd, ...rest] = args.trim().split(/\s+/);
        const arg = rest.join(" ");

        switch (subcmd) {
          case "status":
          case "": {
            let modelInfo: string;
            if (hbState.heartbeatModel) modelInfo = `${hbState.heartbeatModel} (pinned)`;
            else if (ctx.model) modelInfo = `${ctx.model.provider}/${ctx.model.id} (session)`;
            else modelInfo = "auto";
            const am = getAutoMemoryEffective();
            ctx.ui.notify(
              `Rho: ${hbState.enabled ? "enabled" : "disabled"}, ` +
              `interval: ${formatInterval(hbState.intervalMs)}, ` +
              `model: ${modelInfo}, ` +
              `auto-memory: ${am.enabled ? "on" : "off"} (${am.source}), ` +
              `leader: ${hbIsLeader ? "yes" : hbLockOwnerPid ? "no (pid " + hbLockOwnerPid + ")" : "no"}, ` +
              `count: ${hbState.checkCount}`, 
              "info"
            );
            break;
          }
          case "enable":
            hbState.enabled = true;
            if (hbState.intervalMs === 0) hbState.intervalMs = DEFAULT_INTERVAL_MS;
            writeHbSettingsFile({ enabled: hbState.enabled, intervalMs: hbState.intervalMs, heartbeatModel: hbState.heartbeatModel });
            requestHeartbeatSettingsReload(Date.now());
            scheduleNext(ctx);
            ctx.ui.notify("Rho enabled", "success");
            break;
          case "disable":
            hbState.enabled = false;
            writeHbSettingsFile({ enabled: hbState.enabled, intervalMs: hbState.intervalMs, heartbeatModel: hbState.heartbeatModel });
            requestHeartbeatSettingsReload(Date.now());
            scheduleNext(ctx);
            ctx.ui.notify("Rho disabled", "info");
            break;
          case "now":
            if (!ctx.hasUI) { ctx.ui.notify("Rho requires interactive mode", "error"); return; }
            if (!hbIsLeader) {
              requestHeartbeatTrigger(Date.now());
              const leaderText = hbLockOwnerPid ? ` (leader pid ${hbLockOwnerPid})` : "";
              ctx.ui.notify(`Requested rho check-in${leaderText}`, "info");
              break;
            }
            triggerCheck(ctx, { force: true });
            ctx.ui.notify("Rho check-in triggered", "success");
            break;
          case "interval": {
            if (!arg) { ctx.ui.notify(`Current interval: ${formatInterval(hbState.intervalMs)}`, "info"); return; }
            const intervalMs = parseInterval(arg);
            if (intervalMs === null) { ctx.ui.notify("Invalid interval. Use format: 30m, 1h, or 0 to disable", "error"); return; }
            if (intervalMs !== 0 && (intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS)) { ctx.ui.notify("Interval must be between 5m and 24h", "error"); return; }
            hbState.intervalMs = intervalMs;
            if (intervalMs === 0) hbState.enabled = false;
            writeHbSettingsFile({ enabled: hbState.enabled, intervalMs: hbState.intervalMs, heartbeatModel: hbState.heartbeatModel });
            requestHeartbeatSettingsReload(Date.now());
            scheduleNext(ctx);
            ctx.ui.notify(intervalMs === 0 ? "Rho disabled (interval = 0)" : `Rho interval set to ${formatInterval(intervalMs)}`, "success");
            break;
          }
          case "automemory": {
            const mode = arg.trim().toLowerCase();
            const current = getAutoMemoryEffective();
            const cfg = readConfig();
            const cfgVal = typeof cfg.autoMemory === "boolean" ? cfg.autoMemory : undefined;

            if (!mode || mode === "status") {
              let text = `Auto-memory: ${current.enabled ? "on" : "off"} (${current.source})`;
              if (cfgVal !== undefined) text += `, config=${cfgVal ? "on" : "off"}`;
              const envRaw = (process.env.RHO_AUTO_MEMORY || "").trim();
              if (envRaw) text += `, env=${envRaw}`;
              ctx.ui.notify(text, "info");
              return;
            }

            let nextConfig: boolean;
            if (mode === "on") nextConfig = true;
            else if (mode === "off") nextConfig = false;
            else if (mode === "toggle") nextConfig = !(typeof cfgVal === "boolean" ? cfgVal : true);
            else { ctx.ui.notify("Usage: /rho automemory [on|off|toggle|status]", "warning"); return; }

            writeConfig({ autoMemory: nextConfig });
            const after = getAutoMemoryEffective();
            if (after.source === "env") ctx.ui.notify("Note: RHO_AUTO_MEMORY env var overrides config", "warning");
            ctx.ui.notify(`Auto-memory: ${after.enabled ? "on" : "off"} (${after.source})`, "success");
            break;
          }
          case "model": {
            if (!arg) {
              let modelDisplay: string;
              if (hbState.heartbeatModel) modelDisplay = `${hbState.heartbeatModel} (pinned)`;
              else if (ctx.model) modelDisplay = `${ctx.model.provider}/${ctx.model.id} (session)`;
              else modelDisplay = "auto";
              ctx.ui.notify(`Heartbeat model: ${modelDisplay}`, "info");
              return;
            }
            if (arg === "auto") {
              hbState.heartbeatModel = null;
              hbCachedModel = null;
              writeHbSettingsFile({ enabled: hbState.enabled, intervalMs: hbState.intervalMs, heartbeatModel: hbState.heartbeatModel });
              requestHeartbeatSettingsReload(Date.now());
              ctx.ui.notify("Heartbeat model set to auto (uses session model)", "success");
              return;
            }
            const parts = arg.split("/");
            if (parts.length !== 2) { ctx.ui.notify("Usage: /rho model auto  OR  /rho model provider/model-id", "error"); return; }
            const model = ctx.modelRegistry.find(parts[0], parts[1]);
            if (!model) { ctx.ui.notify(`Model '${arg}' not found`, "error"); return; }
            hbState.heartbeatModel = arg;
            writeHbSettingsFile({ enabled: hbState.enabled, intervalMs: hbState.intervalMs, heartbeatModel: hbState.heartbeatModel });
            requestHeartbeatSettingsReload(Date.now());
            ctx.ui.notify(`Heartbeat model pinned to ${arg} ($${model.cost.output}/M output)`, "success");
            break;
          }
          default:
            ctx.ui.notify("Usage: /rho [status|enable|disable|now|interval|model|automemory]", "warning");
            ctx.ui.notify("Examples: /rho now, /rho interval 30m, /rho model auto, /rho automemory toggle", "info");
        }
      },
    });
  }
}
