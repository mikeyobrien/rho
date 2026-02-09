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
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { execSync } from "node:child_process";
import { VaultSearch, parseFrontmatter, extractWikilinks, extractTitle } from "../lib/mod.ts";

export { parseFrontmatter, extractWikilinks };

// ─── Path Constants ───────────────────────────────────────────────────────────

const HOME = os.homedir();
const RHO_DIR = path.join(HOME, ".rho");
const BRAIN_DIR = path.join(RHO_DIR, "brain");
export const VAULT_DIR = path.join(RHO_DIR, "vault");
const RESULTS_DIR = path.join(RHO_DIR, "results");
const TASKS_PATH = path.join(RHO_DIR, "tasks.jsonl");
const STATE_PATH = path.join(RHO_DIR, "rho-state.json");
const CONFIG_PATH = path.join(RHO_DIR, "config.json");

const LEGACY_BRAIN_DIR = path.join(HOME, ".pi", "brain");
const LEGACY_STATE_PATH = path.join(HOME, ".pi", "agent", "rho-state.json");

const CORE_FILE = path.join(BRAIN_DIR, "core.jsonl");
const MEMORY_FILE = path.join(BRAIN_DIR, "memory.jsonl");
const CONTEXT_FILE = path.join(BRAIN_DIR, "context.jsonl");
const ARCHIVE_FILE = path.join(BRAIN_DIR, "archive.jsonl");
const DAILY_MEMORY_DIR = path.join(BRAIN_DIR, "memory");

const HEARTBEAT_PROMPT_FILE = path.join(RHO_DIR, "heartbeat-prompt.txt");

// ─── Shared Config ────────────────────────────────────────────────────────────

interface RhoConfig {
  autoMemory?: boolean;
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
      return { autoMemory };
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

function today(): string {
  return new Date().toISOString().split("T")[0];
}

function ensureRhoDir(): void {
  if (!fs.existsSync(RHO_DIR)) {
    fs.mkdirSync(RHO_DIR, { recursive: true });
  }
}

function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  const content = fs.readFileSync(file, "utf-8");
  const entries: T[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as T);
    } catch {
      // skip malformed lines
    }
  }
  return entries;
}

function appendJsonl<T>(file: string, entry: T): void {
  ensureRhoDir();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + "\n");
}

function writeJsonl<T>(file: string, entries: T[]): void {
  ensureRhoDir();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""));
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

// ─── Brain Types ──────────────────────────────────────────────────────────────

interface BaseEntry {
  id: string;
  type: string;
  created: string;
}

interface IdentityEntry extends BaseEntry {
  type: "identity";
  key: string;
  value: string;
}

interface BehaviorEntry extends BaseEntry {
  type: "behavior";
  category: "do" | "dont" | "value";
  text: string;
}

interface UserEntry extends BaseEntry {
  type: "user";
  key: string;
  value: string;
}

interface LearningEntry extends BaseEntry {
  type: "learning";
  text: string;
  used: number;
  last_used: string;
  source?: string;
}

interface PreferenceEntry extends BaseEntry {
  type: "preference";
  category: string;
  text: string;
}

interface ContextEntry extends BaseEntry {
  type: "context";
  project: string;
  path: string;
  content: string;
}

type Entry = IdentityEntry | BehaviorEntry | UserEntry | LearningEntry | PreferenceEntry | ContextEntry;

// ─── Brain Config ─────────────────────────────────────────────────────────────

const AUTO_MEMORY_DEBUG = process.env.RHO_AUTO_MEMORY_DEBUG === "1" || process.env.RHO_AUTO_MEMORY_DEBUG === "true";
const AUTO_MEMORY_MAX_ITEMS = 3;
const AUTO_MEMORY_MAX_TEXT = 200;
const AUTO_MEMORY_DEFAULT_CATEGORY = "General";
const AUTO_MEMORY_ALLOWED_CATEGORIES = new Set(["Communication", "Code", "Tools", "Workflow", "General"]);
const DAILY_MEMORY_ENABLED = process.env.RHO_DAILY_MEMORY !== "0";
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

// ─── Brain: Daily Memory Log ──────────────────────────────────────────────────

function appendDailyMemoryEntry(entry: LearningEntry | PreferenceEntry): void {
  if (!DAILY_MEMORY_ENABLED) return;
  fs.mkdirSync(DAILY_MEMORY_DIR, { recursive: true });
  const date = entry.created || today();
  const file = path.join(DAILY_MEMORY_DIR, `${date}.md`);
  const needsHeader = !fs.existsSync(file);
  const label =
    entry.type === "learning" ? "Learning" : `Preference (${(entry as PreferenceEntry).category})`;
  const header = needsHeader ? `# Memory ${date}\n\n` : "";
  fs.appendFileSync(file, `${header}- **${label}:** ${entry.text}\n`);
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

function isDuplicateLearning(existing: Entry[], text: string): boolean {
  const normalized = normalizeMemoryText(text).toLowerCase();
  return existing.some(
    (e) => e.type === "learning" && normalizeMemoryText((e as LearningEntry).text).toLowerCase() === normalized
  );
}

function isDuplicatePreference(existing: Entry[], text: string, category: string): boolean {
  const normalized = normalizeMemoryText(text).toLowerCase();
  return existing.some(
    (e) =>
      e.type === "preference" &&
      normalizeMemoryText((e as PreferenceEntry).text).toLowerCase() === normalized &&
      (e as PreferenceEntry).category === category
  );
}

function storeLearningEntry(text: string, options?: { source?: string; maxLength?: number }): StoreResult {
  const normalized = normalizeMemoryText(text);
  if (!normalized) return { stored: false, reason: "empty" };
  if (options?.maxLength && normalized.length > options.maxLength) {
    return { stored: false, reason: "too_long" };
  }
  const existing = readJsonl<Entry>(MEMORY_FILE);
  if (isDuplicateLearning(existing, normalized)) {
    return { stored: false, reason: "duplicate" };
  }
  const entry: LearningEntry = {
    id: nanoid(),
    type: "learning",
    text: normalized,
    used: 0,
    last_used: today(),
    created: today(),
    source: options?.source,
  };
  appendJsonl(MEMORY_FILE, entry);
  appendDailyMemoryEntry(entry);
  return { stored: true, id: entry.id };
}

function storePreferenceEntry(
  text: string,
  category: string,
  options?: { maxLength?: number }
): StoreResult {
  const normalized = normalizeMemoryText(text);
  if (!normalized) return { stored: false, reason: "empty" };
  if (options?.maxLength && normalized.length > options.maxLength) {
    return { stored: false, reason: "too_long" };
  }
  const normalizedCategory = sanitizeCategory(category);
  const existing = readJsonl<Entry>(MEMORY_FILE);
  if (isDuplicatePreference(existing, normalized, normalizedCategory)) {
    return { stored: false, reason: "duplicate" };
  }
  const entry: PreferenceEntry = {
    id: nanoid(),
    type: "preference",
    category: normalizedCategory,
    text: normalized,
    created: today(),
  };
  appendJsonl(MEMORY_FILE, entry);
  appendDailyMemoryEntry(entry);
  return { stored: true, id: entry.id };
}

// ─── Brain: Context Builder ───────────────────────────────────────────────────

function buildBrainContext(cwd: string): string {
  const sections: string[] = [];

  const core = readJsonl<Entry>(CORE_FILE);

  const identity = core.filter((e): e is IdentityEntry => e.type === "identity");
  if (identity.length > 0) {
    sections.push("## Identity\n" + identity.map((e) => `- ${e.key}: ${e.value}`).join("\n"));
  }

  const user = core.filter((e): e is UserEntry => e.type === "user");
  if (user.length > 0) {
    sections.push("## User\n" + user.map((e) => `- ${e.key}: ${e.value}`).join("\n"));
  }

  const behaviors = core.filter((e): e is BehaviorEntry => e.type === "behavior");
  if (behaviors.length > 0) {
    const dos = behaviors.filter((b) => b.category === "do").map((b) => b.text);
    const donts = behaviors.filter((b) => b.category === "dont").map((b) => b.text);
    const values = behaviors.filter((b) => b.category === "value").map((b) => b.text);

    let behaviorSection = "## Behavior\n";
    if (dos.length > 0) behaviorSection += `**Do:** ${dos.join(". ")}.\n`;
    if (donts.length > 0) behaviorSection += `**Don't:** ${donts.join(". ")}.\n`;
    if (values.length > 0) behaviorSection += `**Values:** ${values.join(". ")}.`;
    sections.push(behaviorSection.trim());
  }

  const memory = readJsonl<Entry>(MEMORY_FILE);
  const learnings = memory.filter((e): e is LearningEntry => e.type === "learning");
  const preferences = memory.filter((e): e is PreferenceEntry => e.type === "preference");

  if (learnings.length > 0) {
    const sorted = [...learnings].sort((a, b) => {
      if (b.used !== a.used) return b.used - a.used;
      return b.last_used.localeCompare(a.last_used);
    });
    sections.push("## Learnings\n" + sorted.map((l) => `- ${l.text}`).join("\n"));
  }

  if (preferences.length > 0) {
    const byCategory = new Map<string, string[]>();
    for (const p of preferences) {
      const list = byCategory.get(p.category) || [];
      list.push(p.text);
      byCategory.set(p.category, list);
    }
    let prefSection = "## Preferences\n";
    for (const [cat, items] of byCategory) {
      prefSection += `**${cat}:** ${items.join(". ")}.\n`;
    }
    sections.push(prefSection.trim());
  }

  const contexts = readJsonl<ContextEntry>(CONTEXT_FILE);
  const matched = contexts.find((c) => cwd.startsWith(c.path));
  if (matched) {
    sections.push(`## Project: ${matched.project}\n\n${matched.content}`);
  }

  return sections.join("\n\n");
}

const MEMORY_INSTRUCTIONS = `## Memory

You have persistent memory via the \`memory\` tool. Store insights that help future sessions.

**Store when:**
- User corrects you → learning
- You discover a pattern/convention → learning  
- User states a preference → preference with category

**Good learnings:** "User prefers early returns over nested ifs", "This repo uses pnpm not npm", "API uses snake_case"
**Bad learnings:** "User asked about X", "Fixed a bug", "Session went well"

**Don't store:** obvious things, duplicates, session-specific details.`.trim();

// ─── Brain: Auto-Memory Extraction ───────────────────────────────────────────

type AutoMemoryResponse = {
  learnings?: Array<{ text?: string }>;
  preferences?: Array<{ text?: string; category?: string }>;
};

function formatExistingMemories(entries: Entry[]): string {
  const learnings = entries.filter((e): e is LearningEntry => e.type === "learning");
  const preferences = entries.filter((e): e is PreferenceEntry => e.type === "preference");
  const lines: string[] = [];
  for (const l of learnings) lines.push(`- ${l.text}`);
  for (const p of preferences) lines.push(`- [${p.category}] ${p.text}`);
  return lines.join("\n");
}

function buildAutoMemoryPrompt(conversationText: string, existingMemories?: string): string {
  const parts = [
    "You are a memory extraction system for a personal assistant.",
    "Extract durable learnings and user preferences that will remain useful across sessions.",
    "Only include stable facts or clear preferences. Skip one-off tasks, transient requests, and generic facts.",
    "Keep each entry concise (under 120 characters).",
  ];

  if (existingMemories) {
    parts.push(
      "",
      "IMPORTANT: These memories are already stored. Do NOT extract anything that restates, overlaps with, or is a subset of these:",
      "<existing_memories>",
      existingMemories,
      "</existing_memories>",
      "",
      "Only extract genuinely NEW information not covered above."
    );
  }

  parts.push(
    "Output strict JSON only with this shape:",
    '{"learnings":[{"text":"..."}],"preferences":[{"category":"Communication|Code|Tools|Workflow|General","text":"..."}]}',
    "If there are no NEW items to add, return {\"learnings\":[],\"preferences\":[]}.",
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

  const existing = readJsonl<Entry>(MEMORY_FILE);
  const existingText = existing.length > 0 ? formatExistingMemories(existing) : undefined;
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
    const result = storeLearningEntry(text, { source, maxLength: maxText });
    if (result.stored) {
      storedLearnings += 1;
      remaining -= 1;
      storedItems.push(text);
    }
  }

  for (const pref of extractedPreferences) {
    if (remaining <= 0) break;
    const result = storePreferenceEntry(pref.text, pref.category, { maxLength: maxText });
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

  return { storedLearnings, storedPrefs };
}

// ─── Brain: Remove Entry ──────────────────────────────────────────────────────

function removeMemoryEntry(id: string): { ok: boolean; message: string } {
  const entries = readJsonl<Entry>(MEMORY_FILE);
  const idx = entries.findIndex((e) => e.id === id);
  if (idx === -1) return { ok: false, message: `Entry '${id}' not found` };

  const entry = entries[idx];
  const text = (entry as LearningEntry | PreferenceEntry).text || "(unknown)";

  // Archive before removing
  appendJsonl(ARCHIVE_FILE, { ...entry, archived: today(), reason: "manual" });

  entries.splice(idx, 1);
  writeJsonl(MEMORY_FILE, entries);
  return { ok: true, message: `Removed [${id}]: ${text}` };
}

// ─── Brain: Legacy Migration ──────────────────────────────────────────────────

function migrateLegacyBrain(): void {
  if (!fs.existsSync(LEGACY_BRAIN_DIR)) return;
  if (fs.existsSync(BRAIN_DIR) && fs.readdirSync(BRAIN_DIR).length > 0) return;

  fs.mkdirSync(BRAIN_DIR, { recursive: true });

  for (const entry of fs.readdirSync(LEGACY_BRAIN_DIR, { withFileTypes: true })) {
    const src = path.join(LEGACY_BRAIN_DIR, entry.name);
    const dst = path.join(BRAIN_DIR, entry.name);
    if (entry.isDirectory()) {
      if (!fs.existsSync(dst)) fs.mkdirSync(dst, { recursive: true });
      for (const sub of fs.readdirSync(src)) {
        fs.copyFileSync(path.join(src, sub), path.join(dst, sub));
      }
    } else {
      fs.copyFileSync(src, dst);
    }
  }
}

function bootstrapBrainDefaults(extensionDir: string): void {
  const defaultsDir = path.join(path.dirname(extensionDir), "brain");
  if (!fs.existsSync(defaultsDir)) return;

  fs.mkdirSync(BRAIN_DIR, { recursive: true });
  for (const file of fs.readdirSync(defaultsDir)) {
    if (!file.endsWith(".jsonl.default")) continue;
    const target = path.join(BRAIN_DIR, file.replace(".default", ""));
    if (!fs.existsSync(target)) {
      fs.copyFileSync(path.join(defaultsDir, file), target);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
//  TASKS (Lightweight Task Queue)
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Task Types ───────────────────────────────────────────────────────────────

export type TaskPriority = "urgent" | "high" | "normal" | "low";
export type TaskStatus = "pending" | "done";

export interface Task {
  id: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  tags: string[];
  created: string;
  due: string | null;
  completedAt: string | null;
}

interface TaskAddParams {
  description: string;
  priority?: TaskPriority;
  tags?: string;
  due?: string;
}

interface TaskResult {
  ok: boolean;
  message: string;
  task?: Task;
  tasks?: Task[];
  count?: number;
}

const PRIORITY_ORDER: Record<TaskPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
const VALID_PRIORITIES: TaskPriority[] = ["urgent", "high", "normal", "low"];

// ─── Task ID Generation ──────────────────────────────────────────────────────

export function generateId(existing: Task[]): string {
  const ids = new Set(existing.map((t) => t.id));
  for (let i = 0; i < 100; i++) {
    const id = crypto.randomBytes(4).toString("hex");
    if (!ids.has(id)) return id;
  }
  return crypto.randomBytes(8).toString("hex");
}

// ─── Task Persistence ─────────────────────────────────────────────────────────

export function loadTasks(filePath: string = TASKS_PATH): Task[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, "utf-8").trim();
    if (!raw) return [];
    return raw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        const parsed = JSON.parse(line) as Task;
        if (!parsed.tags) parsed.tags = [];
        if (!parsed.due) parsed.due = null;
        if (!parsed.completedAt) parsed.completedAt = null;
        if (!parsed.priority) parsed.priority = "normal";
        if (!parsed.status) parsed.status = "pending";
        return parsed;
      });
  } catch {
    return [];
  }
}

export function saveTasks(tasks: Task[], filePath: string = TASKS_PATH): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = tasks.map((t) => JSON.stringify(t));
  fs.writeFileSync(filePath, lines.join("\n") + "\n", "utf-8");
}

// ─── Task Operations ──────────────────────────────────────────────────────────

export function addTask(params: TaskAddParams, filePath: string = TASKS_PATH): TaskResult {
  const desc = params.description?.trim();
  if (!desc) return { ok: false, message: "Error: description is required" };

  const priority = params.priority || "normal";
  if (!VALID_PRIORITIES.includes(priority)) {
    return { ok: false, message: `Error: invalid priority '${priority}'. Must be: ${VALID_PRIORITIES.join(", ")}` };
  }

  const tags = params.tags
    ? params.tags.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean)
    : [];

  const due = params.due?.trim() || null;
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) {
    return { ok: false, message: `Error: invalid due date '${due}'. Use YYYY-MM-DD format.` };
  }

  const tasks = loadTasks(filePath);
  const task: Task = {
    id: generateId(tasks),
    description: desc,
    status: "pending",
    priority,
    tags,
    created: new Date().toISOString(),
    due,
    completedAt: null,
  };

  tasks.push(task);
  saveTasks(tasks, filePath);
  return { ok: true, message: `Task added: [${task.id}] ${desc}`, task };
}

export function listTasks(filter?: string, filePath: string = TASKS_PATH): TaskResult {
  const tasks = loadTasks(filePath);

  let filtered: Task[];
  if (!filter || filter === "pending") {
    filtered = tasks.filter((t) => t.status === "pending");
  } else if (filter === "all") {
    filtered = tasks;
  } else if (filter === "done") {
    filtered = tasks.filter((t) => t.status === "done");
  } else {
    const tag = filter.toLowerCase();
    filtered = tasks.filter((t) => t.status === "pending" && t.tags.includes(tag));
  }

  filtered.sort((a, b) => {
    const pa = PRIORITY_ORDER[a.priority] ?? 2;
    const pb = PRIORITY_ORDER[b.priority] ?? 2;
    if (pa !== pb) return pa - pb;
    return a.created > b.created ? -1 : a.created < b.created ? 1 : 0;
  });

  if (filtered.length === 0) {
    const label = filter === "all" ? "tasks" : filter === "done" ? "completed tasks" : "pending tasks";
    return { ok: true, message: `No ${label}.`, tasks: [], count: 0 };
  }

  const lines = filtered.map((t) => formatTask(t));
  const header =
    filter === "all"
      ? `${filtered.length} task(s):`
      : filter === "done"
        ? `${filtered.length} completed task(s):`
        : `${filtered.length} pending task(s):`;

  return { ok: true, message: `${header}\n${lines.join("\n")}`, tasks: filtered, count: filtered.length };
}

export function completeTask(id: string, filePath: string = TASKS_PATH): TaskResult {
  if (!id?.trim()) return { ok: false, message: "Error: task ID is required" };

  const tasks = loadTasks(filePath);
  const task = findTaskById(tasks, id.trim());
  if (!task) return { ok: false, message: `Error: task '${id}' not found` };
  if (task.status === "done") return { ok: true, message: `Task [${task.id}] is already done.`, task };

  task.status = "done";
  task.completedAt = new Date().toISOString();
  saveTasks(tasks, filePath);
  return { ok: true, message: `Done: [${task.id}] ${task.description}`, task };
}

export function removeTask(id: string, filePath: string = TASKS_PATH): TaskResult {
  if (!id?.trim()) return { ok: false, message: "Error: task ID is required" };

  const tasks = loadTasks(filePath);
  const task = findTaskById(tasks, id.trim());
  if (!task) return { ok: false, message: `Error: task '${id}' not found` };

  const remaining = tasks.filter((t) => t.id !== task.id);
  saveTasks(remaining, filePath);
  return { ok: true, message: `Removed: [${task.id}] ${task.description}`, task };
}

export function clearDone(filePath: string = TASKS_PATH): TaskResult {
  const tasks = loadTasks(filePath);
  const done = tasks.filter((t) => t.status === "done");
  const remaining = tasks.filter((t) => t.status !== "done");

  if (done.length === 0) return { ok: true, message: "No completed tasks to clear.", count: 0 };

  saveTasks(remaining, filePath);
  return { ok: true, message: `Cleared ${done.length} completed task(s).`, count: done.length };
}

// ─── Task Helpers ─────────────────────────────────────────────────────────────

export function findTaskById(tasks: Task[], idPrefix: string): Task | null {
  const prefix = idPrefix.toLowerCase();
  const exact = tasks.find((t) => t.id === prefix);
  if (exact) return exact;
  if (prefix.length < 4) return null;
  const matches = tasks.filter((t) => t.id.startsWith(prefix));
  return matches.length === 1 ? matches[0] : null;
}

export function formatTask(task: Task): string {
  const status = task.status === "done" ? "[x]" : "[ ]";
  let line = `${status} [${task.id}] ${task.description}`;
  if (task.priority !== "normal") line += ` (${task.priority})`;
  if (task.due) line += ` due:${task.due}`;
  if (task.tags.length > 0) line += ` #${task.tags.join(" #")}`;
  if (task.completedAt) line += ` done:${task.completedAt.slice(0, 10)}`;
  return line;
}

export function buildHeartbeatSection(filePath: string = TASKS_PATH): string | null {
  const tasks = loadTasks(filePath);
  const pending = tasks.filter((t) => t.status === "pending");
  if (pending.length === 0) return null;

  pending.sort((a, b) => {
    const pa = PRIORITY_ORDER[a.priority] ?? 2;
    const pb = PRIORITY_ORDER[b.priority] ?? 2;
    return pa - pb;
  });

  const now = new Date().toISOString().slice(0, 10);
  const lines = pending.map((t) => {
    let line = `- [${t.id}] ${t.description}`;
    if (t.priority !== "normal") line += ` (${t.priority})`;
    if (t.due) {
      if (t.due < now) line += ` **OVERDUE** (due ${t.due})`;
      else line += ` (due ${t.due})`;
    }
    if (t.tags.length > 0) line += ` [${t.tags.join(", ")}]`;
    return line;
  });

  return `Pending tasks (${pending.length}):\n${lines.join("\n")}`;
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

const RHO_PROMPT = `This is a rho check-in. Review the following:

1. Read RHO.md and HEARTBEAT.md from the workspace if they exist - follow any checklists or scheduled tasks there
2. Check for any outstanding tasks, TODOs, or follow-ups from our conversation
3. Review any long-running operations or background processes
4. Surface anything urgent that needs attention

If nothing needs attention, reply with exactly: RHO_OK
If something needs attention, reply with the alert (do NOT include RHO_OK).
If the user asks for scheduled tasks or recurring reminders, add them to HEARTBEAT.md.`;

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
    fs.linkSync(tmpPath, filePath); // atomic, fails with EEXIST if lock already present
    fs.unlinkSync(tmpPath);
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
    }
    execSync(`tmux send-keys -t ${shellEscape(target)} C-c`, { stdio: "ignore" });
    execSync(`tmux send-keys -t ${shellEscape(target)} ${shellEscape(command)} C-m`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function readMarkdownFile(paths: string[]): string | null {
  for (const filePath of paths) {
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, "utf-8").trim();
        const hasContent = content
          .split("\n")
          .some((line) => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) return false;
            if (trimmed.startsWith("-")) return /^-\s*\[[ xX]\]/.test(trimmed);
            return true;
          });
        return hasContent ? content : null;
      } catch {
        continue;
      }
    }
  }
  return null;
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

  migrateLegacyBrain();
  bootstrapBrainDefaults(__dirname);
  ensureVaultDirs();
  createDefaultFiles();

  // ── Brain state ────────────────────────────────────────────────────────────

  let autoMemoryInFlight = false;
  let compactMemoryInFlight = false;
  let cachedBrainPrompt: string | null = null;

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
    return hbIsLeader ? "ρ lead" : "ρ follow";
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

          let left = pctPlain;
          if (pct !== null) {
            if (pct > 90) left = theme.fg("error", pctPlain);
            else if (pct > 70) left = theme.fg("warning", pctPlain);
          }

          const usage = formatUsageBars();
          const rhoRole = formatRhoRole();
          const rightPlain = [usage, rhoRole].filter(Boolean).join("  ");
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

    let fullPrompt = RHO_PROMPT;
    const rhoMd = readMarkdownFile([
      // Project-local overrides
      path.join(ctx.cwd, "RHO.md"),
      path.join(ctx.cwd, ".pi", "RHO.md"),
      path.join(ctx.cwd, ".rho.md"),

      // Canonical rho location
      path.join(RHO_DIR, "RHO.md"),

      // Back-compat: older installs used $HOME
      path.join(HOME, "RHO.md"),
    ]);
    const heartbeatMd = readMarkdownFile([
      // Project-local overrides
      path.join(ctx.cwd, "HEARTBEAT.md"),
      path.join(ctx.cwd, ".pi", "HEARTBEAT.md"),
      path.join(ctx.cwd, ".heartbeat.md"),
      path.join(ctx.cwd, ".rho-heartbeat.md"),

      // Canonical rho location
      path.join(RHO_DIR, "HEARTBEAT.md"),

      // Back-compat: older installs used $HOME
      path.join(HOME, "HEARTBEAT.md"),
    ]);

    let tasksSection: string | null = null;
    try { tasksSection = buildHeartbeatSection(); } catch { /* ignore */ }

    if (!rhoMd && !heartbeatMd && !tasksSection) {
      if (ctx.hasUI) ctx.ui.notify("ρ: skipped (nothing to do)", "info");
      scheduleNext(ctx);
      return;
    }
    if (rhoMd) fullPrompt += `\n\n---\n\nRHO.md content:\n${rhoMd}`;
    if (heartbeatMd) fullPrompt += `\n\n---\n\nHEARTBEAT.md content:\n${heartbeatMd}`;
    if (tasksSection) fullPrompt += `\n\n---\n\n${tasksSection}`;

    // Include identity context so heartbeat agent has personality/voice guidance
    const agentsMdContent = readMarkdownFile([path.join(RHO_DIR, "AGENTS.md")]);
    const soulMdContent = readMarkdownFile([path.join(RHO_DIR, "SOUL.md")]);
    if (agentsMdContent || soulMdContent) {
      fullPrompt += "\n\n---\n\nIdentity context:";
      if (agentsMdContent) fullPrompt += "\n\n" + agentsMdContent;
      if (soulMdContent) fullPrompt += "\n\n" + soulMdContent;
    }

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
    if (!IS_SUBAGENT) {
      setRhoHeader(ctx);
      setRhoFooter(ctx);
    }

    // Cache context for system prompt
    //
    // Goal: keep the user's home directory clean. Canonical config lives under ~/.rho,
    // but we still want AGENTS/SOUL guidance available no matter where pi starts.
    let extra: string[] = [];

    const agentsMd = readMarkdownFile([path.join(RHO_DIR, "AGENTS.md")]);
    if (agentsMd) extra.push("# AGENTS.md\n\n" + agentsMd);

    const soulMd = readMarkdownFile([path.join(RHO_DIR, "SOUL.md")]);
    if (soulMd) extra.push("# SOUL.md\n\n" + soulMd);

    const brainContext = buildBrainContext(ctx.cwd);
    if (brainContext.trim()) {
      extra.push("# Memory\n\n" + MEMORY_INSTRUCTIONS + "\n\n" + brainContext);
    }

    cachedBrainPrompt = extra.length > 0 ? "\n\n" + extra.join("\n\n") : null;

    // Vault: rebuild graph
    rebuildVaultGraph();

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

  // ── Tool: memory ───────────────────────────────────────────────────────────

  pi.registerTool({
    name: "memory",
    label: "Memory",
    description:
      "Store learnings (corrections, patterns, conventions) or preferences (user likes/dislikes with category). " +
      "Use after user corrections or when discovering something future sessions need. " +
      "Actions: add_learning, add_preference, reinforce, remove (by ID), search, list.",
    parameters: Type.Object({
      action: StringEnum(["add_learning", "add_preference", "reinforce", "remove", "search", "list"] as const),
      content: Type.Optional(Type.String({ description: "Concise, actionable text" })),
      category: Type.Optional(Type.String({ description: "Category: Communication, Code, Tools, Workflow, General" })),
      query: Type.Optional(Type.String({ description: "Search query" })),
      id: Type.Optional(Type.String({ description: "Entry ID for reinforce" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      switch (params.action) {
        case "add_learning": {
          if (!params.content) return { content: [{ type: "text", text: "Error: content required" }], details: { error: true } };
          const result = storeLearningEntry(params.content);
          if (!result.stored) {
            return { content: [{ type: "text", text: result.reason === "duplicate" ? "Already stored" : "Not stored" }], details: { duplicate: result.reason === "duplicate" } };
          }
          return { content: [{ type: "text", text: `Stored: ${params.content}` }], details: { id: result.id } };
        }

        case "add_preference": {
          if (!params.content) return { content: [{ type: "text", text: "Error: content required" }], details: { error: true } };
          const category = sanitizeCategory(params.category);
          const result = storePreferenceEntry(params.content, category);
          if (!result.stored) {
            return { content: [{ type: "text", text: result.reason === "duplicate" ? "Already stored" : "Not stored" }], details: { duplicate: result.reason === "duplicate" } };
          }
          return { content: [{ type: "text", text: `Stored [${category}]: ${params.content}` }], details: { id: result.id } };
        }

        case "reinforce": {
          if (!params.id) return { content: [{ type: "text", text: "Error: id required" }], details: { error: true } };
          const entries = readJsonl<Entry>(MEMORY_FILE);
          const idx = entries.findIndex((e) => e.id === params.id);
          if (idx === -1) return { content: [{ type: "text", text: "Entry not found" }], details: { error: true } };
          const entry = entries[idx];
          if (entry.type === "learning") {
            (entry as LearningEntry).used++;
            (entry as LearningEntry).last_used = today();
          }
          writeJsonl(MEMORY_FILE, entries);
          return { content: [{ type: "text", text: `Reinforced: ${(entry as LearningEntry).text}` }], details: { id: entry.id, used: (entry as LearningEntry).used } };
        }

        case "search": {
          const queryWords = (params.query || "").toLowerCase().split(/\s+/).filter(Boolean);
          if (queryWords.length === 0) {
            return { content: [{ type: "text", text: "Error: query required" }], details: { count: 0 } };
          }
          const memory = readJsonl<Entry>(MEMORY_FILE);

          const scored: Array<{ entry: Entry; score: number }> = [];
          for (const e of memory) {
            let text = "";
            if (e.type === "learning") text = (e as LearningEntry).text.toLowerCase();
            else if (e.type === "preference") text = (e as PreferenceEntry).text.toLowerCase();
            else continue;

            // All query words must appear
            const allMatch = queryWords.every(w => text.includes(w));
            if (!allMatch) continue;

            // Score: word boundary matches count more
            let score = 0;
            for (const w of queryWords) {
              const re = new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i");
              score += re.test(text) ? 2 : 1;
            }
            // Boost by usage count for learnings
            if (e.type === "learning") score += Math.min((e as LearningEntry).used, 3);

            scored.push({ entry: e, score });
          }

          scored.sort((a, b) => b.score - a.score);
          const matches = scored.map(s => s.entry);

          return {
            content: [{ type: "text", text: matches.length ? matches.map((m) => `[${m.id}] ${(m as LearningEntry | PreferenceEntry).text}`).join("\n") : "No matches" }],
            details: { count: matches.length },
          };
        }

        case "list": {
          const memory = readJsonl<Entry>(MEMORY_FILE);
          const ls = memory.filter((e) => e.type === "learning") as LearningEntry[];
          const ps = memory.filter((e) => e.type === "preference") as PreferenceEntry[];
          let text = `**Learnings (${ls.length}):**\n`;
          text += ls.map((l) => `- ${l.text}`).join("\n") || "(none)";
          text += `\n\n**Preferences (${ps.length}):**\n`;
          text += ps.map((p) => `- [${p.category}] ${p.text}`).join("\n") || "(none)";
          return { content: [{ type: "text", text }], details: { learnings: ls.length, preferences: ps.length } };
        }

        case "remove": {
          if (!params.id) return { content: [{ type: "text", text: "Error: id required" }], details: { error: true } };
          const result = removeMemoryEntry(params.id);
          return { content: [{ type: "text", text: result.message }], details: { ok: result.ok } };
        }

        default:
          return { content: [{ type: "text", text: "Unknown action" }], details: { error: true } };
      }
    },
  });

  // ── Tool: tasks ────────────────────────────────────────────────────────────

  if (!IS_SUBAGENT) {
    pi.registerTool({
      name: "tasks",
      label: "Tasks",
      description:
        "Lightweight task queue. Actions: add (create task), list (show tasks), done (complete task), remove (delete task), update (edit description/priority/due/tags), clear (remove all done tasks). " +
        "Tasks persist across sessions and are surfaced during heartbeat check-ins.",
      parameters: Type.Object({
        action: StringEnum(["add", "list", "done", "remove", "update", "clear"] as const),
        description: Type.Optional(Type.String({ description: "Task description (for add action)" })),
        id: Type.Optional(Type.String({ description: "Task ID or prefix (for done/remove actions)" })),
        priority: Type.Optional(Type.String({ description: "Priority: urgent, high, normal, low (default: normal)" })),
        due: Type.Optional(Type.String({ description: "Due date in YYYY-MM-DD format" })),
        tags: Type.Optional(Type.String({ description: "Comma-separated tags (e.g. 'code,rho')" })),
        filter: Type.Optional(Type.String({ description: "Filter for list: 'pending' (default), 'all', 'done', or a tag name" })),
      }),

      async execute(_toolCallId, params) {
        switch (params.action) {
          case "add": {
            const result = addTask({ description: params.description || "", priority: params.priority as TaskPriority | undefined, due: params.due, tags: params.tags });
            return { content: [{ type: "text", text: result.message }], details: { action: "add", ok: result.ok, task: result.task } };
          }
          case "list": {
            const result = listTasks(params.filter);
            return { content: [{ type: "text", text: result.message }], details: { action: "list", ok: result.ok, count: result.count } };
          }
          case "done": {
            const result = completeTask(params.id || "");
            return { content: [{ type: "text", text: result.message }], details: { action: "done", ok: result.ok, task: result.task } };
          }
          case "remove": {
            const result = removeTask(params.id || "");
            return { content: [{ type: "text", text: result.message }], details: { action: "remove", ok: result.ok, task: result.task } };
          }
          case "update": {
            if (!params.id?.trim()) return { content: [{ type: "text", text: "Error: task ID is required" }], details: { action: "update", ok: false } };
            const tasks = loadTasks();
            const task = findTaskById(tasks, params.id.trim());
            if (!task) return { content: [{ type: "text", text: `Error: task '${params.id}' not found` }], details: { action: "update", ok: false } };

            let changed = false;
            if (params.description?.trim()) { task.description = params.description.trim(); changed = true; }
            if (params.priority && ["urgent", "high", "normal", "low"].includes(params.priority)) { task.priority = params.priority as TaskPriority; changed = true; }
            if (params.due !== undefined) {
              if (params.due && !/^\d{4}-\d{2}-\d{2}$/.test(params.due)) {
                return { content: [{ type: "text", text: `Error: invalid due date '${params.due}'` }], details: { action: "update", ok: false } };
              }
              task.due = params.due || null;
              changed = true;
            }
            if (params.tags !== undefined) {
              task.tags = params.tags ? params.tags.split(",").map(t => t.trim().toLowerCase()).filter(Boolean) : [];
              changed = true;
            }

            if (!changed) return { content: [{ type: "text", text: "Nothing to update. Provide description, priority, due, or tags." }], details: { action: "update", ok: false } };

            saveTasks(tasks);
            return { content: [{ type: "text", text: `Updated: [${task.id}] ${task.description}` }], details: { action: "update", ok: true, task } };
          }
          case "clear": {
            const result = clearDone();
            return { content: [{ type: "text", text: result.message }], details: { action: "clear", ok: result.ok, count: result.count } };
          }
          default:
            return { content: [{ type: "text", text: "Error: Unknown action. Use: add, list, done, remove, update, clear" }], details: { error: true } };
        }
      },

      renderCall(args, theme) {
        let text = theme.fg("toolTitle", theme.bold("tasks ")) + theme.fg("muted", args.action);
        if (args.description) {
          const desc = args.description.length > 50 ? args.description.slice(0, 47) + "..." : args.description;
          text += " " + theme.fg("accent", desc);
        }
        if (args.id) text += " " + theme.fg("accent", args.id);
        return new Text(text, 0, 0);
      },

      renderResult(result, _options, theme) {
        const details = result.details as { action: string; ok: boolean; count?: number } | undefined;
        if (!details) {
          const text = result.content[0];
          return new Text(text?.type === "text" ? text.text : "", 0, 0);
        }
        if (!details.ok) {
          const text = result.content[0];
          return new Text(theme.fg("error", text?.type === "text" ? text.text : "Error"), 0, 0);
        }
        if (details.action === "list") {
          if (details.count === 0) return new Text(theme.fg("dim", "No pending tasks."), 0, 0);
          const text = result.content[0];
          return new Text(text?.type === "text" ? text.text : "", 0, 0);
        }
        const text = result.content[0];
        return new Text(theme.fg("success", ">> ") + (text?.type === "text" ? text.text : ""), 0, 0);
      },
    });
  }

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
            const rhoMd = readMarkdownFile([
              path.join(ctx.cwd, "RHO.md"),
              path.join(ctx.cwd, ".pi", "RHO.md"),
              path.join(ctx.cwd, ".rho.md"),
              path.join(RHO_DIR, "RHO.md"),
              path.join(HOME, "RHO.md"),
            ]);
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
            text += `- RHO.md: ${rhoMd ? "found" : "not found"}`;

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

      if (subcmd === "stats" || !subcmd) {
        const core = readJsonl<Entry>(CORE_FILE);
        const memory = readJsonl<Entry>(MEMORY_FILE);
        const lCount = memory.filter((e) => e.type === "learning").length;
        const pCount = memory.filter((e) => e.type === "preference").length;
        const identity = core.filter((e) => e.type === "identity").length;
        const behaviors = core.filter((e) => e.type === "behavior").length;
        ctx.ui.notify(`🧠 ${lCount}L ${pCount}P | core: ${identity}id ${behaviors}beh`, "info");
      } else if (subcmd === "search") {
        const query = parts.slice(1).join(" ").toLowerCase();
        if (!query) { ctx.ui.notify("Usage: /brain search <query>", "error"); return; }
        const memory = readJsonl<Entry>(MEMORY_FILE);
        const matches = memory.filter((e) => {
          if (e.type === "learning") return (e as LearningEntry).text.toLowerCase().includes(query);
          if (e.type === "preference") return (e as PreferenceEntry).text.toLowerCase().includes(query);
          return false;
        });
        ctx.ui.notify(matches.length ? `Found ${matches.length} matches` : "No matches", "info");
      } else {
        ctx.ui.notify("Usage: /brain [stats|search <query>]", "error");
      }
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
            const result = listTasks("pending");
            ctx.ui.notify(result.count === 0 ? "No pending tasks." : result.message, "info");
            break;
          }
          case "all": {
            const result = listTasks("all");
            ctx.ui.notify(result.count === 0 ? "No tasks." : result.message, "info");
            break;
          }
          case "add": {
            if (!rest.trim()) { ctx.ui.notify("Usage: /tasks add <description>", "warning"); return; }
            const result = addTask({ description: rest });
            ctx.ui.notify(result.message, result.ok ? "success" : "error");
            break;
          }
          case "done": {
            if (!rest.trim()) { ctx.ui.notify("Usage: /tasks done <id>", "warning"); return; }
            const result = completeTask(rest.trim());
            ctx.ui.notify(result.message, result.ok ? "success" : "error");
            break;
          }
          case "remove":
          case "rm": {
            if (!rest.trim()) { ctx.ui.notify("Usage: /tasks remove <id>", "warning"); return; }
            const result = removeTask(rest.trim());
            ctx.ui.notify(result.message, result.ok ? "success" : "error");
            break;
          }
          case "update": {
            const updateId = parts[1];
            const newDesc = parts.slice(2).join(" ");
            if (!updateId) { ctx.ui.notify("Usage: /tasks update <id> [new description]", "warning"); return; }
            const tasks = loadTasks();
            const task = findTaskById(tasks, updateId.trim());
            if (!task) { ctx.ui.notify(`Task '${updateId}' not found`, "error"); return; }
            if (newDesc.trim()) task.description = newDesc.trim();
            saveTasks(tasks);
            ctx.ui.notify(`Updated: [${task.id}] ${task.description}`, "success");
            break;
          }
          case "clear": {
            const result = clearDone();
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