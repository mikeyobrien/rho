/**
 * Rho Core Extension
 *
 * The core runtime for Rho: persistent memory (brain), task queue,
 * knowledge vault, and heartbeat check-ins.
 *
 * Tools:  memory, tasks, vault, rho_control, rho_subagent
 * Commands: /brain, /tasks, /vault, /rho
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
import { readBrain, foldBrain, buildBrainPrompt, appendBrainEntryWithDedup, BRAIN_PATH } from "../lib/brain-store.ts";
import { detectMigration, runMigration } from "../lib/brain-migration.ts";

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

// Cache the SOP content so we only read from disk once
let _autoMemorySopCache: string | null = null;
function loadAutoMemorySop(): string {
  if (_autoMemorySopCache) return _autoMemorySopCache;
  const sopPath = path.join(__dirname, "..", "..", "sops", "auto-memory.sop.md");
  try {
    _autoMemorySopCache = fs.readFileSync(sopPath, "utf-8");
  } catch {
    // Fallback if SOP file is missing (e.g., npm install without sops dir)
    _autoMemorySopCache = [
      "Extract durable learnings and user preferences from the conversation.",
      "Only extract final decisions, corrections, and verified facts.",
      "Skip intermediate discussion, transient states, and one-off tasks.",
      "Max 3 items. Return empty arrays if nothing worth extracting.",
    ].join("\n");
  }
  return _autoMemorySopCache;
}

function buildAutoMemoryPrompt(conversationText: string, existingMemories?: string): string {
  const sop = loadAutoMemorySop();
  const parts = [
    "<sop>",
    sop,
    "</sop>",
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
const DEFAULT_SESSION_NAME = "rho";
const HEARTBEAT_WINDOW_NAME = "heartbeat";
const MAX_WINDOW_NAME = 50;
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

// Heartbeat leader election (multi-process safety)
const HEARTBEAT_LOCK_PATH = path.join(RHO_DIR, "heartbeat.lock.json");
const HEARTBEAT_TRIGGER_PATH = path.join(RHO_DIR, "heartbeat.trigger");
const HEARTBEAT_LOCK_REFRESH_MS = 15 * 1000;
const HEARTBEAT_LOCK_STALE_MS = 60 * 1000;

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

// ─── Heartbeat: Multi-process leadership (first PID wins) ────────────────────

interface HeartbeatLockFile {
  pid: number;
  nonce: string;
  acquiredAt: number;
  refreshedAt: number;
  hostname: string;
}

function isPidRunning(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    // EPERM means the PID exists, we just can't signal it.
    if (code === "EPERM") return true;
    return false;
  }
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

function isLockStale(lock: HeartbeatLockFile, now: number): boolean {
  if (!lock) return true;
  if (!isPidRunning(lock.pid)) return true;
  if (!Number.isFinite(lock.refreshedAt)) return true;
  return (now - lock.refreshedAt) > HEARTBEAT_LOCK_STALE_MS;
}

function fileMtimeMs(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs || null;
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

function createExclusiveTextFile(filePath: string, content: string): { ok: boolean; errorCode?: string } {
  let tmpPath: string | null = null;
  try {
    ensureRhoDir();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    tmpPath = `${filePath}.tmp-create-${process.pid}-${nanoid(4)}`;
    fs.writeFileSync(tmpPath, content, { encoding: "utf-8", mode: 0o600 });
    try {
      fs.linkSync(tmpPath, filePath); // atomic, fails with EEXIST if lock already present
    } catch (linkErr) {
      const linkCode = (linkErr as NodeJS.ErrnoException | undefined)?.code;
      if (linkCode === "EEXIST") throw linkErr; // re-throw: another process holds the lock
      // Hard links unsupported (EPERM on Android/Termux, ENOSYS, EXDEV, etc.)
      // Fall back to O_CREAT|O_EXCL which is also atomic for creation.
      const fd = fs.openSync(filePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
      fs.writeSync(fd, content);
      fs.closeSync(fd);
    }
    try { if (tmpPath) fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    tmpPath = null;
    return { ok: true };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    try {
      if (tmpPath) fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    return { ok: false, errorCode: code };
  }
}

function readHeartbeatLockMeta(): { lock: HeartbeatLockFile | null; mtimeMs: number | null } {
  return { lock: readHeartbeatLock(), mtimeMs: fileMtimeMs(HEARTBEAT_LOCK_PATH) };
}

function writeHeartbeatLock(lock: HeartbeatLockFile): boolean {
  return atomicWriteTextFile(HEARTBEAT_LOCK_PATH, JSON.stringify(lock, null, 2));
}

function tryAcquireHeartbeatLock(nonce: string, now: number): { ok: boolean; ownerPid: number | null } {
  const lock: HeartbeatLockFile = {
    pid: process.pid,
    nonce,
    acquiredAt: now,
    refreshedAt: now,
    hostname: os.hostname(),
  };
  const payload = JSON.stringify(lock, null, 2);

  // Create with full content, atomically, without an intermediate empty file.
  for (let attempt = 0; attempt < 2; attempt++) {
    const created = createExclusiveTextFile(HEARTBEAT_LOCK_PATH, payload);
    if (created.ok) return { ok: true, ownerPid: process.pid };
    if (created.errorCode && created.errorCode !== "EEXIST") return { ok: false, ownerPid: null };

    const meta = readHeartbeatLockMeta();
    if (meta.lock) {
      if (isLockStale(meta.lock, now)) {
        try { fs.unlinkSync(HEARTBEAT_LOCK_PATH); } catch { /* ignore */ }
        continue;
      }
      return { ok: false, ownerPid: meta.lock.pid };
    }

    // Unparseable lock file: treat as "locked" unless it is stale by mtime.
    if (meta.mtimeMs && (now - meta.mtimeMs) > HEARTBEAT_LOCK_STALE_MS) {
      try { fs.unlinkSync(HEARTBEAT_LOCK_PATH); } catch { /* ignore */ }
      continue;
    }

    return { ok: false, ownerPid: null };
  }

  const after = readHeartbeatLock();
  return { ok: false, ownerPid: after?.pid ?? null };
}

function refreshHeartbeatLock(nonce: string, now: number): boolean {
  const lock = readHeartbeatLock();
  if (!lock) return false;
  if (lock.pid !== process.pid) return false;
  if (lock.nonce !== nonce) return false;
  lock.refreshedAt = now;
  return writeHeartbeatLock(lock);
}

function releaseHeartbeatLock(nonce: string): void {
  try {
    const lock = readHeartbeatLock();
    if (!lock) return;
    if (lock.pid !== process.pid) return;
    if (lock.nonce !== nonce) return;
    fs.unlinkSync(HEARTBEAT_LOCK_PATH);
  } catch {
    // ignore
  }
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
  const command = `clear; RHO_SUBAGENT=1 pi --no-session${flags} ${shellEscape(promptArg)}; rm -f ${shellEscape(HEARTBEAT_PROMPT_FILE)}`;

  try {
    if (!heartbeatWindowExists(sessionName)) {
      execSync(`tmux new-window -d -t ${shellEscape(sessionName)} -n ${shellEscape(HEARTBEAT_WINDOW_NAME)}`, { stdio: "ignore" });
    } else if (heartbeatPaneBusy(sessionName)) {
      // Previous heartbeat still running — kill it and respawn a fresh shell
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
  let hbLockOwnerPid: number | null = null;
  let hbLeadershipTimer: NodeJS.Timeout | null = null;
  let hbLeadershipCtx: ExtensionContext | null = null;
  let hbTriggerSeenMtimeMs = 0;
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
          const rhoRole = formatRhoRole();
          const rightPlain = [usage, mem, rhoRole].filter(Boolean).join("  ");
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
    const lock = readHeartbeatLock();
    if (!lock || lock.pid !== process.pid || lock.nonce !== hbLockNonce) {
      hbIsLeader = false;
      hbLockOwnerPid = lock?.pid ?? null;
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
      releaseHeartbeatLock(hbLockNonce);
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
    const initial = tryAcquireHeartbeatLock(hbLockNonce, Date.now());
    hbLockOwnerPid = initial.ownerPid;
    if (initial.ok) {
      hbIsLeader = true;
      hbLastSettingsFingerprint = null;
    }

    hbLeadershipTimer = setInterval(() => {
      const liveCtx = hbLeadershipCtx;
      if (!liveCtx || !liveCtx.hasUI) return;
      const now = Date.now();

      if (hbIsLeader) {
        const stillLeader = refreshHeartbeatLock(hbLockNonce, now);
        if (!stillLeader) {
          hbIsLeader = false;
          hbLockOwnerPid = readHeartbeatLock()?.pid ?? null;
          stopHeartbeatTimers();
          updateStatusLine(liveCtx);
          return;
        }

        // Pull settings changes written by other processes.
        const before = hbLastSettingsFingerprint ?? heartbeatSettingsFingerprint();
        loadHbState();
        const after = heartbeatSettingsFingerprint();
        hbLastSettingsFingerprint = after;
        if (before !== after || (!hbTimer && hbState.enabled && hbState.intervalMs > 0)) {
          scheduleNext(liveCtx);
        }

        // Cross-process trigger requests.
        const trig = consumeHeartbeatTrigger(hbTriggerSeenMtimeMs);
        hbTriggerSeenMtimeMs = trig.nextSeen;
        if (trig.triggered) triggerCheck(liveCtx);
        return;
      }

      // Follower: opportunistically take leadership if lock is missing/stale.
      const lock = readHeartbeatLock();
      hbLockOwnerPid = lock?.pid ?? null;
      if (!lock || isLockStale(lock, now)) {
        const res = tryAcquireHeartbeatLock(hbLockNonce, now);
        hbLockOwnerPid = res.ownerPid;
        if (res.ok) {
          hbIsLeader = true;
          hbLastSettingsFingerprint = null;
          // Schedule immediately on takeover.
          loadHbState();
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

  const saveHbState = (mode: "full" | "settings" = "full") => {
    try {
      fs.mkdirSync(RHO_DIR, { recursive: true });

      if (mode === "settings") {
        // Preserve leader-owned scheduling fields when we're not the leader.
        // If we can't parse the existing state, do NOT write (avoid stomping).
        let base: Partial<RhoState> | null = {};
        try {
          if (fs.existsSync(STATE_PATH)) {
            const raw = fs.readFileSync(STATE_PATH, "utf-8");
            base = JSON.parse(raw) as Partial<RhoState>;
          }
        } catch {
          base = null;
        }
        if (!base) return;

        atomicWriteTextFile(
          STATE_PATH,
          JSON.stringify(
            {
              enabled: hbState.enabled,
              intervalMs: hbState.intervalMs,
              lastCheckAt: (base.lastCheckAt ?? null) as number | null,
              nextCheckAt: (base.nextCheckAt ?? null) as number | null,
              checkCount: (typeof base.checkCount === "number" ? base.checkCount : 0) as number,
              heartbeatModel: hbState.heartbeatModel,
            },
            null,
            2,
          ),
        );
        return;
      }

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

    if (ctx.model) {
      const apiKey = await ctx.modelRegistry.getApiKey(ctx.model);
      if (apiKey) return `--provider ${shellEscape(ctx.model.provider)} --model ${shellEscape(ctx.model.id)} --thinking off`;
    }

    try {
      const resolved = await resolveHeartbeatModel(ctx);
      if (resolved) return `--provider ${shellEscape(resolved.provider)} --model ${shellEscape(resolved.model)} --thinking off`;
    } catch { /* ignore */ }

    return "";
  };

  const scheduleNext = (ctx: ExtensionContext, options?: { reloadFromDisk?: boolean }) => {
    if (options?.reloadFromDisk) {
      try { loadHbState(); } catch { /* ignore */ }
    }

    if (hbTimer) { clearTimeout(hbTimer); hbTimer = null; }

    // If we think we're the leader, confirm we still own the lock.
    if (hbIsLeader) verifyHeartbeatLeadership(ctx);

    // Disabled: persist settings, clear nextCheckAt locally.
    if (!hbState.enabled || hbState.intervalMs === 0) {
      hbState.nextCheckAt = null;
      saveHbState(hbIsLeader ? "full" : "settings");
      updateStatusLine(ctx);
      return;
    }

    // Follower: never schedule timers (and never overwrite leader-owned fields).
    if (!hbIsLeader) {
      hbState.nextCheckAt = null;
      saveHbState("settings");
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
    saveHbState("full");
    updateStatusLine(ctx);
  };

  const triggerCheck = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    if (!verifyHeartbeatLeadership(ctx)) return;

    hbState.lastCheckAt = Date.now();
    hbState.checkCount++;

    // Read brain and extract due reminders + pending tasks
    const { entries } = readBrain(BRAIN_PATH);
    const brain = foldBrain(entries);

    const now = new Date();
    const dueReminders = brain.reminders.filter(r => {
      if (!r.enabled) return false;
      if (!r.next_due) return true; // never run → due immediately
      return new Date(r.next_due) <= now;
    });

    const pendingTasks = brain.tasks.filter(t => t.status === "pending");

    // Skip if nothing to do
    if (dueReminders.length === 0 && pendingTasks.length === 0) {
      if (ctx.hasUI) ctx.ui.notify("ρ: skipped (nothing to do)", "info");
      scheduleNext(ctx);
      return;
    }

    // Build heartbeat prompt
    let remindersSection = "None due.";
    if (dueReminders.length > 0) {
      remindersSection = dueReminders.map(r => {
        const priority = r.priority !== "normal" ? ` (${r.priority})` : "";
        const tags = r.tags.length > 0 ? ` [${r.tags.join(", ")}]` : "";
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
        if (t.tags.length > 0) line += ` [${t.tags.join(", ")}]`;
        return line;
      }).join("\n");
    }

    const fullPrompt = `You are rho performing a scheduled check-in.

## Due Reminders
${remindersSection}

## Pending Tasks
${tasksSection}

Instructions:
- Execute each due reminder. Use the brain tool's reminder_run action to record results.
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
      const lastConsolidation = brain.meta.get("memory.last_consolidation");
      const lastTs = lastConsolidation ? new Date(lastConsolidation.value).getTime() : 0;
      const daysSince = (Date.now() - lastTs) / (1000 * 60 * 60 * 24);
      if (daysSince > 1) {
        const ago = lastTs === 0 ? "never" : `${Math.floor(daysSince)}d ago`;
        ctx.ui.notify(`🧹 Memory consolidation available (last: ${ago}). Run /consolidate`, "info");
      }
    }

    // Heartbeat: restore state, acquire leadership, and schedule
    if (!IS_SUBAGENT) {
      startHeartbeatLeadership(ctx);
      loadHbState();
      reconstructHbState(ctx);
      scheduleNext(ctx);
      startStatusUpdates(ctx);
    }
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    // Rebuild brain cache if the file changed (e.g. another session wrote to it)
    if (isBrainCacheStale()) {
      rebuildBrainCache(currentCwd);
    }

    if (cachedBrainPrompt) {
      return { systemPrompt: event.systemPrompt + cachedBrainPrompt };
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
      scheduleNext(ctx);
      startStatusUpdates(ctx);
    });

    pi.on("session_fork", async (_event, ctx) => {
      setRhoHeader(ctx);
      setRhoFooter(ctx);
      startHeartbeatLeadership(ctx);
      loadHbState();
      reconstructHbState(ctx);
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
      releaseHeartbeatLock(hbLockNonce);
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
            if (r.tags?.length > 0) line += ` {${r.tags.join(", ")}}`;
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
            scheduleNext(ctx);
            return { content: [{ type: "text", text: "Rho enabled" }], details: { action: "enable", enabled: hbState.enabled } as RhoDetails };

          case "disable":
            hbState.enabled = false;
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
            triggerCheck(ctx);
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
            } else if (ctx.model) {
              hbModelText = `${ctx.model.provider}/${ctx.model.id} (session)`;
              hbModelCost = ctx.model.cost.output;
            } else {
              hbModelText = "auto";
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
              saveHbState(hbIsLeader ? "full" : "settings");
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
            saveHbState(hbIsLeader ? "full" : "settings");
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
      description: "Run a pi subagent in a new tmux window (session 'rho' by default). Default mode is interactive; print mode writes results to ~/.rho/results.",
      parameters: Type.Object({
        prompt: Type.String({ description: "Prompt to run in the subagent" }),
        session: Type.Optional(Type.String({ description: "tmux session name (default: rho)" })),
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

  // ── Command: /consolidate ────────────────────────────────────────────────────

  pi.registerCommand("consolidate", {
    description: "Run memory consolidation — deduplicate, merge, and clean stale entries",
    handler: async (_args, ctx) => {
      ctx.ui.setEditorText("Run the memory consolidation SOP at ~/.rho/project/sops/memory-consolidate.sop.md");
    },
  });

  // ── Command: /tasks ────────────────────────────────────────────────────────

  if (!IS_SUBAGENT) {
    pi.registerCommand("tasks", {
      description: "Task queue: /tasks (list), /tasks add <desc>, /tasks done <id>, /tasks update <id> <desc>, /tasks clear, /tasks all",
      handler: async (args, ctx) => {
        const parts = args.trim().split(/\s+/);
        const subcmd = parts[0] || "";
        const rest = parts.slice(1).join(" ");

        switch (subcmd) {
          case "":
          case "list": {
            const result = await handleBrainAction(BRAIN_PATH, { action: "list", type: "task", filter: "pending" });
            ctx.ui.notify(result.message || "No pending tasks.", "info");
            break;
          }
          case "all": {
            const result = await handleBrainAction(BRAIN_PATH, { action: "list", type: "task" });
            ctx.ui.notify(result.message || "No tasks.", "info");
            break;
          }
          case "add": {
            if (!rest.trim()) { ctx.ui.notify("Usage: /tasks add <description>", "warning"); return; }
            const result = await handleBrainAction(BRAIN_PATH, { action: "add", type: "task", description: rest });
            brainCache = null;
            ctx.ui.notify(result.message, result.ok ? "success" : "error");
            break;
          }
          case "done": {
            if (!rest.trim()) { ctx.ui.notify("Usage: /tasks done <id>", "warning"); return; }
            const result = await handleBrainAction(BRAIN_PATH, { action: "task_done", id: rest.trim() });
            brainCache = null;
            ctx.ui.notify(result.message, result.ok ? "success" : "error");
            break;
          }
          case "remove":
          case "rm": {
            if (!rest.trim()) { ctx.ui.notify("Usage: /tasks remove <id>", "warning"); return; }
            const result = await handleBrainAction(BRAIN_PATH, { action: "remove", id: rest.trim(), type: "task", reason: "removed via /tasks" });
            brainCache = null;
            ctx.ui.notify(result.message, result.ok ? "success" : "error");
            break;
          }
          case "update": {
            const updateId = parts[1];
            const newDesc = parts.slice(2).join(" ");
            if (!updateId) { ctx.ui.notify("Usage: /tasks update <id> [new description]", "warning"); return; }
            const result = await handleBrainAction(BRAIN_PATH, { action: "update", id: updateId.trim(), description: newDesc.trim() || undefined });
            brainCache = null;
            ctx.ui.notify(result.message, result.ok ? "success" : "error");
            break;
          }
          case "clear": {
            const result = await handleBrainAction(BRAIN_PATH, { action: "task_clear" });
            brainCache = null;
            ctx.ui.notify(result.message, result.ok ? "success" : "error");
            break;
          }
          default:
            ctx.ui.notify("Usage: /tasks [add <desc> | done <id> | remove <id> | update <id> <desc> | clear | all]", "warning");
        }
      },
    });
  }

  // ── Command: /vault ────────────────────────────────────────────────────────

  pi.registerCommand("vault", {
    description: "Vault dashboard & inbox (usage: /vault [inbox])",
    handler: async (_args, ctx) => {
      const [subcmd] = _args.trim().split(/\s+/);

      switch (subcmd) {
        case "inbox": {
          const inboxPath = path.join(VAULT_DIR, "_inbox.md");
          if (!fs.existsSync(inboxPath)) {
            ctx.ui.notify("Inbox empty.", "info");
            break;
          }
          const content = fs.readFileSync(inboxPath, "utf-8");
          // Split on --- separators, skip the header
          const entries = content.split(/^---$/m).slice(1).map(e => e.trim()).filter(Boolean);
          if (entries.length === 0) {
            ctx.ui.notify("Inbox empty.", "info");
            break;
          }
          // Show count and first few items truncated
          const preview = entries.slice(0, 5).map((e, i) => {
            const firstLine = e.split("\n").find(l => l.trim() && !l.startsWith(">") && !l.startsWith("**")) || e.split("\n")[0];
            const text = firstLine.trim();
            return `${i + 1}. ${text.length > 60 ? text.slice(0, 57) + "..." : text}`;
          });
          const more = entries.length > 5 ? `\n  (+${entries.length - 5} more)` : "";
          ctx.ui.notify(`Inbox (${entries.length}):\n${preview.join("\n")}${more}`, "info");
          break;
        }
        case "":
        case undefined: {
          rebuildVaultGraph();
          const status = getVaultStatus(VAULT_DIR, vaultGraph);
          const typeCounts = Object.entries(status.byType).map(([t, n]) => `${n} ${t}`).join(", ");
          const parts = [
            `${status.totalNotes} notes`,
            typeCounts ? `(${typeCounts})` : "",
            `${status.orphanCount} orphans`,
            `${status.inboxItems} inbox`,
            `avg ${status.avgLinksPerNote.toFixed(1)} links/note`,
          ].filter(Boolean);
          ctx.ui.notify(`Vault: ${parts.join(" | ")}`, "info");
          break;
        }
        default:
          ctx.ui.notify("Usage: /vault [inbox]", "info");
          break;
      }
    },
  });

  // ── Command: /subagents ──────────────────────────────────────────────────────

  if (!IS_SUBAGENT) {
    pi.registerCommand("subagents", {
      description: "List active subagent tmux windows",
      handler: async (_args, ctx) => {
        try {
          const sessionName = "rho";
          // List windows in the rho session, using the dedicated socket
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

  // ── Command: /rho ──────────────────────────────────────────────────────────

  if (!IS_SUBAGENT) {
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
            scheduleNext(ctx);
            ctx.ui.notify("Rho enabled", "success");
            break;
          case "disable":
            hbState.enabled = false;
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
            triggerCheck(ctx);
            ctx.ui.notify("Rho check-in triggered", "success");
            break;
          case "interval": {
            if (!arg) { ctx.ui.notify(`Current interval: ${formatInterval(hbState.intervalMs)}`, "info"); return; }
            const intervalMs = parseInterval(arg);
            if (intervalMs === null) { ctx.ui.notify("Invalid interval. Use format: 30m, 1h, or 0 to disable", "error"); return; }
            if (intervalMs !== 0 && (intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS)) { ctx.ui.notify("Interval must be between 5m and 24h", "error"); return; }
            hbState.intervalMs = intervalMs;
            if (intervalMs === 0) hbState.enabled = false;
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
              saveHbState(hbIsLeader ? "full" : "settings");
              ctx.ui.notify("Heartbeat model set to auto (uses session model)", "success");
              return;
            }
            const parts = arg.split("/");
            if (parts.length !== 2) { ctx.ui.notify("Usage: /rho model auto  OR  /rho model provider/model-id", "error"); return; }
            const model = ctx.modelRegistry.find(parts[0], parts[1]);
            if (!model) { ctx.ui.notify(`Model '${arg}' not found`, "error"); return; }
            hbState.heartbeatModel = arg;
            saveHbState(hbIsLeader ? "full" : "settings");
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
