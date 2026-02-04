/**
 * Brain Extension - JSONL-based persistent memory for agents
 *
 * Structure:
 *   ~/.pi/brain/core.jsonl     - identity, behavior, user (rarely changes)
 *   ~/.pi/brain/memory.jsonl   - learnings, preferences (grows, has lifecycle)
 *   ~/.pi/brain/context.jsonl  - project contexts (matched by cwd)
 *   ~/.pi/brain/archive.jsonl  - decayed entries
 *   ~/.pi/brain/memory/YYYY-MM-DD.md - daily markdown memory log
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { convertToLlm, serializeConversation } from "@mariozechner/pi-coding-agent";
import { StringEnum, complete } from "@mariozechner/pi-ai";
import type { Api, Model } from "@mariozechner/pi-ai";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

// Paths
const BRAIN_DIR = path.join(os.homedir(), ".pi", "brain");
const CORE_FILE = path.join(BRAIN_DIR, "core.jsonl");
const MEMORY_FILE = path.join(BRAIN_DIR, "memory.jsonl");
const CONTEXT_FILE = path.join(BRAIN_DIR, "context.jsonl");
const ARCHIVE_FILE = path.join(BRAIN_DIR, "archive.jsonl");
const DAILY_MEMORY_DIR = path.join(BRAIN_DIR, "memory");

// Auto-memory config — disabled for subagent/heartbeat sessions
const AUTO_MEMORY_ENABLED = process.env.RHO_AUTO_MEMORY !== "0" && process.env.RHO_SUBAGENT !== "1";
const AUTO_MEMORY_DEBUG = process.env.RHO_AUTO_MEMORY_DEBUG === "1" || process.env.RHO_AUTO_MEMORY_DEBUG === "true";
const AUTO_MEMORY_MAX_ITEMS = 3;
const AUTO_MEMORY_MAX_TEXT = 200;
const AUTO_MEMORY_DEFAULT_CATEGORY = "General";
const AUTO_MEMORY_ALLOWED_CATEGORIES = new Set(["Communication", "Code", "Tools", "Workflow", "General"]);

// Feature flags
const DAILY_MEMORY_ENABLED = process.env.RHO_DAILY_MEMORY !== "0";
const COMPACT_MEMORY_FLUSH_ENABLED = process.env.RHO_COMPACT_MEMORY_FLUSH !== "0";

/**
 * Resolve the cheapest model from the same provider as the current session model.
 * Picks the model with the lowest output cost that has auth configured.
 * Falls back to ctx.model if nothing cheaper is found.
 */
async function resolveSmallModel(
  ctx: ExtensionContext
): Promise<{ model: Model<Api>; apiKey: string } | null> {
  const currentModel = ctx.model;
  if (!currentModel) return null;

  const currentApiKey = await ctx.modelRegistry.getApiKey(currentModel);
  if (!currentApiKey) return null;

  // Get all available models from the same provider, sorted by output cost
  const sameProvider = ctx.modelRegistry
    .getAll()
    .filter((m) => m.provider === currentModel.provider)
    .sort((a, b) => a.cost.output - b.cost.output);

  // Pick the cheapest one that has auth (same provider = same key usually)
  for (const candidate of sameProvider) {
    const apiKey = await ctx.modelRegistry.getApiKey(candidate);
    if (apiKey) {
      return { model: candidate, apiKey };
    }
  }

  // Fallback: use the current model as-is
  return { model: currentModel, apiKey: currentApiKey };
}

// Types
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
  source?: string; // what triggered this learning
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

// Helpers
function nanoid(size = 8): string {
  return crypto.randomBytes(size).toString("base64url").slice(0, size);
}

function today(): string {
  return new Date().toISOString().split("T")[0];
}

function ensureDir(): void {
  if (!fs.existsSync(BRAIN_DIR)) {
    fs.mkdirSync(BRAIN_DIR, { recursive: true });
  }
}

function readJsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  const content = fs.readFileSync(file, "utf-8");
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as T);
}

function appendJsonl<T>(file: string, entry: T): void {
  ensureDir();
  fs.appendFileSync(file, JSON.stringify(entry) + "\n");
}

function writeJsonl<T>(file: string, entries: T[]): void {
  ensureDir();
  fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : ""));
}

function ensureDailyDir(): void {
  if (!fs.existsSync(DAILY_MEMORY_DIR)) {
    fs.mkdirSync(DAILY_MEMORY_DIR, { recursive: true });
  }
}

function dailyMemoryPath(date = today()): string {
  return path.join(DAILY_MEMORY_DIR, `${date}.md`);
}

function appendDailyMemoryEntry(entry: LearningEntry | PreferenceEntry): void {
  if (!DAILY_MEMORY_ENABLED) return;
  ensureDailyDir();
  const date = entry.created || today();
  const file = dailyMemoryPath(date);
  const needsHeader = !fs.existsSync(file);
  const label =
    entry.type === "learning" ? "Learning" : `Preference (${(entry as PreferenceEntry).category})`;
  const header = needsHeader ? `# Memory ${date}\n\n` : "";
  fs.appendFileSync(file, `${header}- **${label}:** ${entry.text}\n`);
}

type StoreResult = { stored: boolean; id?: string; reason?: "empty" | "duplicate" | "too_long" };

type AutoMemoryResponse = {
  learnings?: Array<{ text?: string }>;
  preferences?: Array<{ text?: string; category?: string }>;
};

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

function extractJsonObject(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return trimmed;
  const match = trimmed.match(/\{[\s\S]*\}/);
  return match ? match[0] : null;
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

async function runAutoMemoryExtraction(
  messages: AgentMessage[],
  ctx: ExtensionContext,
  options?: { source?: string; signal?: AbortSignal; maxItems?: number; maxText?: number }
): Promise<{ storedLearnings: number; storedPrefs: number } | null> {
  if (!AUTO_MEMORY_ENABLED) return null;

  const resolved = await resolveSmallModel(ctx);
  if (!resolved) return null;
  const { model, apiKey } = resolved;

  const conversationText = serializeConversation(convertToLlm(messages));
  if (!conversationText.trim()) return null;

  if (AUTO_MEMORY_DEBUG && ctx.hasUI) {
    ctx.ui.notify(`Auto-memory: extracting via ${model.name}...`, "info");
  }

  // Feed existing memories so the LLM avoids duplicates
  const existing = readJsonl<Entry>(MEMORY_FILE);
  const existingText = existing.length > 0 ? formatExistingMemories(existing) : undefined;

  const prompt = buildAutoMemoryPrompt(conversationText, existingText);
  const response = await complete(
    model,
    {
      messages: [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: prompt }],
          timestamp: Date.now(),
        },
      ],
    },
    { apiKey, maxTokens: 512, signal: options?.signal }
  );

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

  const learnings = (parsed.learnings ?? [])
    .map((l) => normalizeMemoryText(l.text ?? ""))
    .filter(Boolean);
  const preferences = (parsed.preferences ?? [])
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

  for (const text of learnings) {
    if (remaining <= 0) break;
    const result = storeLearningEntry(text, { source, maxLength: maxText });
    if (result.stored) {
      storedLearnings += 1;
      remaining -= 1;
    }
  }

  for (const pref of preferences) {
    if (remaining <= 0) break;
    const result = storePreferenceEntry(pref.text, pref.category, { maxLength: maxText });
    if (result.stored) {
      storedPrefs += 1;
      remaining -= 1;
    }
  }

  if ((storedLearnings > 0 || storedPrefs > 0) && ctx.hasUI) {
    ctx.ui.notify(`Auto-memory stored: ${storedLearnings}L ${storedPrefs}P`, "info");
  }

  return { storedLearnings, storedPrefs };
}

// Memory consolidation
type ConsolidationResponse = {
  learnings: Array<{ id: string; text: string }>;
  preferences: Array<{ id: string; category: string; text: string }>;
};

function buildConsolidationPrompt(entries: Entry[]): string {
  const learnings = entries.filter((e): e is LearningEntry => e.type === "learning");
  const preferences = entries.filter((e): e is PreferenceEntry => e.type === "preference");

  let entriesText = "LEARNINGS:\n";
  for (const l of learnings) {
    entriesText += `[${l.id}] ${l.text}\n`;
  }
  entriesText += "\nPREFERENCES:\n";
  for (const p of preferences) {
    entriesText += `[${p.id}] [${p.category}] ${p.text}\n`;
  }

  return [
    "You are a memory consolidation system. Deduplicate and consolidate these memory entries.",
    "",
    "Rules:",
    "- Merge entries that express the same fact or preference into ONE clear entry.",
    "- When merging, use the ID of the OLDEST entry in the group.",
    "- Keep the most informative/complete version when merging.",
    "- Remove entries that are strict subsets of other entries.",
    "- Remove entries that are clearly obsolete or superseded.",
    "- Do NOT invent new information — only consolidate what exists.",
    "- Keep entries concise (under 200 characters).",
    "- For preferences, preserve the category. If merging preferences with different categories, use the most specific one.",
    "- Return ALL entries that should be kept — both merged and untouched ones.",
    "",
    entriesText,
    "",
    "Output strict JSON:",
    '{"learnings":[{"id":"kept-id","text":"consolidated text"}],"preferences":[{"id":"kept-id","category":"...","text":"consolidated text"}]}',
  ].join("\n");
}

function parseConsolidationResponse(text: string): ConsolidationResponse | null {
  const jsonText = extractJsonObject(text);
  if (!jsonText) return null;
  try {
    return JSON.parse(jsonText) as ConsolidationResponse;
  } catch {
    return null;
  }
}

async function runConsolidation(
  ctx: ExtensionContext,
  options?: { signal?: AbortSignal; dryRun?: boolean }
): Promise<{ before: number; after: number; removed: number } | null> {
  const resolved = await resolveSmallModel(ctx);
  if (!resolved) return null;
  const { model, apiKey } = resolved;

  const entries = readJsonl<Entry>(MEMORY_FILE);
  if (entries.length < 5) return null; // Not enough to bother

  if (AUTO_MEMORY_DEBUG) {
    console.error(`Consolidation using: ${model.name} (${model.provider})`);
  }

  const prompt = buildConsolidationPrompt(entries);

  const response = await complete(
    model,
    {
      messages: [
        {
          role: "user" as const,
          content: [{ type: "text" as const, text: prompt }],
          timestamp: Date.now(),
        },
      ],
    },
    { apiKey, maxTokens: 4096, signal: options?.signal }
  );

  const responseText = response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();

  const parsed = parseConsolidationResponse(responseText);
  if (!parsed) return null;

  // Build a lookup of existing entries by ID for metadata preservation
  const entryMap = new Map<string, Entry>();
  for (const e of entries) entryMap.set(e.id, e);

  const newEntries: Entry[] = [];

  // Process consolidated learnings
  for (const cl of parsed.learnings) {
    const existing = entryMap.get(cl.id) as LearningEntry | undefined;
    const normalized = normalizeMemoryText(cl.text);
    if (!normalized) continue;

    if (existing && existing.type === "learning") {
      // Preserve metadata, update text
      newEntries.push({
        ...existing,
        text: normalized,
        last_used: today(),
      });
    } else {
      // New consolidated entry (shouldn't happen often but handle it)
      newEntries.push({
        id: cl.id || nanoid(),
        type: "learning",
        text: normalized,
        used: 0,
        last_used: today(),
        created: today(),
      } as LearningEntry);
    }
  }

  // Process consolidated preferences
  for (const cp of parsed.preferences) {
    const existing = entryMap.get(cp.id) as PreferenceEntry | undefined;
    const normalized = normalizeMemoryText(cp.text);
    if (!normalized) continue;

    if (existing && existing.type === "preference") {
      newEntries.push({
        ...existing,
        text: normalized,
        category: sanitizeCategory(cp.category),
      });
    } else {
      newEntries.push({
        id: cp.id || nanoid(),
        type: "preference",
        category: sanitizeCategory(cp.category),
        text: normalized,
        created: today(),
      } as PreferenceEntry);
    }
  }

  const before = entries.length;
  const after = newEntries.length;

  if (options?.dryRun) {
    return { before, after, removed: before - after };
  }

  // Safety: don't write if consolidation removed more than 60% (LLM might have hallucinated)
  if (after < before * 0.4) {
    return null; // Too aggressive, abort
  }

  // Archive removed entries before overwriting
  const keptIds = new Set(newEntries.map((e) => e.id));
  const removed = entries.filter((e) => !keptIds.has(e.id));
  if (removed.length > 0) {
    ensureDir();
    for (const r of removed) {
      appendJsonl(ARCHIVE_FILE, { ...r, archived: today(), reason: "consolidation" });
    }
  }

  // Write consolidated memory
  writeJsonl(MEMORY_FILE, newEntries);

  return { before, after, removed: before - after };
}

// Bootstrap from defaults
function bootstrapDefaults(extensionDir: string): void {
  const defaultsDir = path.join(path.dirname(extensionDir), "brain");
  if (!fs.existsSync(defaultsDir)) return;

  ensureDir();
  for (const file of fs.readdirSync(defaultsDir)) {
    if (!file.endsWith(".jsonl.default")) continue;
    const target = path.join(BRAIN_DIR, file.replace(".default", ""));
    if (!fs.existsSync(target)) {
      fs.copyFileSync(path.join(defaultsDir, file), target);
    }
  }
}

// Build context for system prompt
function buildBrainContext(cwd: string): string {
  const sections: string[] = [];

  // Core entries
  const core = readJsonl<Entry>(CORE_FILE);

  // Identity
  const identity = core.filter((e): e is IdentityEntry => e.type === "identity");
  if (identity.length > 0) {
    sections.push("## Identity\n" + identity.map((e) => `- ${e.key}: ${e.value}`).join("\n"));
  }

  // User
  const user = core.filter((e): e is UserEntry => e.type === "user");
  if (user.length > 0) {
    sections.push("## User\n" + user.map((e) => `- ${e.key}: ${e.value}`).join("\n"));
  }

  // Behavior - compact format
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

  // Memory (learnings + preferences) - only if non-empty
  const memory = readJsonl<Entry>(MEMORY_FILE);
  const learnings = memory.filter((e): e is LearningEntry => e.type === "learning");
  const preferences = memory.filter((e): e is PreferenceEntry => e.type === "preference");

  if (learnings.length > 0) {
    // Sort by usage (most used first), then by recency
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

  // Context (matched by cwd)
  const contexts = readJsonl<ContextEntry>(CONTEXT_FILE);
  const matched = contexts.find((c) => cwd.startsWith(c.path));
  if (matched) {
    sections.push(`## Project: ${matched.project}\n\n${matched.content}`);
  }

  return sections.join("\n\n");
}

// Concise memory instructions with examples
const MEMORY_INSTRUCTIONS = `## Memory

You have persistent memory via the \`memory\` tool. Store insights that help future sessions.

**Store when:**
- User corrects you → learning
- You discover a pattern/convention → learning  
- User states a preference → preference with category

**Good learnings:** "User prefers early returns over nested ifs", "This repo uses pnpm not npm", "API uses snake_case"
**Bad learnings:** "User asked about X", "Fixed a bug", "Session went well"

**Don't store:** obvious things, duplicates, session-specific details.`.trim();

export default function (pi: ExtensionAPI) {
  // Bootstrap on load
  bootstrapDefaults(__dirname);

  let autoMemoryInFlight = false;
  let compactMemoryInFlight = false;

  // Cache brain context at session start (stable for the session) and update widget
  let cachedBrainPrompt: string | null = null;

  pi.on("session_start", async (_event, ctx) => {
    const brainContext = buildBrainContext(ctx.cwd);
    cachedBrainPrompt = brainContext.trim()
      ? "\n\n# Memory\n\n" + MEMORY_INSTRUCTIONS + "\n\n" + brainContext
      : null;
    updateBrainWidget(ctx);
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    if (cachedBrainPrompt) {
      return { systemPrompt: event.systemPrompt + cachedBrainPrompt };
    }
  });

  // LLM-based auto-memory extraction
  pi.on("agent_end", async (event, ctx) => {
    if (!AUTO_MEMORY_ENABLED || autoMemoryInFlight) return;
    autoMemoryInFlight = true;
    try {
      const result = await runAutoMemoryExtraction(event.messages, ctx, { source: "auto" });
      if (result && (result.storedLearnings > 0 || result.storedPrefs > 0)) {
        updateBrainWidget(ctx);
      }
    } catch (error) {
      if (AUTO_MEMORY_DEBUG && ctx.hasUI) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Auto-memory error: ${message}`, "error");
      }
    } finally {
      autoMemoryInFlight = false;
    }
  });

  // Pre-compaction memory flush
  pi.on("session_before_compact", async (event, ctx) => {
    if (!AUTO_MEMORY_ENABLED || !COMPACT_MEMORY_FLUSH_ENABLED || compactMemoryInFlight) return;
    if (event.signal.aborted) return;

    const messages = Array.from(
      new Set([...event.preparation.messagesToSummarize, ...event.preparation.turnPrefixMessages])
    );
    if (messages.length === 0) return;

    compactMemoryInFlight = true;
    try {
      if (AUTO_MEMORY_DEBUG && ctx.hasUI) {
        ctx.ui.notify("Auto-memory: flushing before compaction...", "info");
      }
      const result = await runAutoMemoryExtraction(messages, ctx, {
        source: "compaction",
        signal: event.signal,
      });
      if (result && (result.storedLearnings > 0 || result.storedPrefs > 0)) {
        updateBrainWidget(ctx);
      }
    } catch (error) {
      if (AUTO_MEMORY_DEBUG && ctx.hasUI) {
        const message = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Auto-memory error: ${message}`, "error");
      }
    } finally {
      compactMemoryInFlight = false;
    }
  });

  // Helper to update brain widget
  function updateBrainWidget(ctx: { ui?: { setStatus?: (id: string, text: string | undefined) => void } }) {
    if (!ctx?.ui?.setStatus) return;
    
    const memory = readJsonl<Entry>(MEMORY_FILE);
    const contexts = readJsonl<ContextEntry>(CONTEXT_FILE);
    const learnings = memory.filter((e) => e.type === "learning").length;
    const prefs = memory.filter((e) => e.type === "preference").length;
    const matched = contexts.find((c) => process.cwd().startsWith(c.path));

    let status = `🧠 ${learnings}L ${prefs}P`;
    if (matched) {
      status += ` · ${matched.project}`;
    }
    ctx.ui.setStatus("brain", status);
  }

  // Register memory tool with clear, specific description
  pi.registerTool({
    name: "memory",
    label: "Memory",
    description:
      "Store learnings (corrections, patterns, conventions) or preferences (user likes/dislikes with category). Use after user corrections or when discovering something future sessions need. Actions: add_learning, add_preference, reinforce, search, list, consolidate.",
    parameters: Type.Object({
      action: StringEnum(["add_learning", "add_preference", "reinforce", "search", "list", "consolidate"] as const),
      content: Type.Optional(Type.String({ description: "Concise, actionable text" })),
      category: Type.Optional(Type.String({ description: "Category: Communication, Code, Tools, Workflow, General" })),
      query: Type.Optional(Type.String({ description: "Search query" })),
      id: Type.Optional(Type.String({ description: "Entry ID for reinforce" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      switch (params.action) {
        case "add_learning": {
          if (!params.content) {
            return { content: [{ type: "text", text: "Error: content required" }], details: { error: true } };
          }
          const result = storeLearningEntry(params.content);
          if (!result.stored) {
            const message = result.reason === "duplicate" ? "Already stored" : "Not stored";
            return {
              content: [{ type: "text", text: message }],
              details: { duplicate: result.reason === "duplicate" },
            };
          }
          updateBrainWidget(ctx);
          return {
            content: [{ type: "text", text: `Stored: ${params.content}` }],
            details: { id: result.id },
          };
        }

        case "add_preference": {
          if (!params.content) {
            return { content: [{ type: "text", text: "Error: content required" }], details: { error: true } };
          }
          const category = sanitizeCategory(params.category);
          const result = storePreferenceEntry(params.content, category);
          if (!result.stored) {
            const message = result.reason === "duplicate" ? "Already stored" : "Not stored";
            return {
              content: [{ type: "text", text: message }],
              details: { duplicate: result.reason === "duplicate" },
            };
          }
          updateBrainWidget(ctx);
          return {
            content: [{ type: "text", text: `Stored [${category}]: ${params.content}` }],
            details: { id: result.id },
          };
        }

        case "reinforce": {
          if (!params.id) {
            return { content: [{ type: "text", text: "Error: id required" }], details: { error: true } };
          }
          const entries = readJsonl<Entry>(MEMORY_FILE);
          const idx = entries.findIndex((e) => e.id === params.id);
          if (idx === -1) {
            return { content: [{ type: "text", text: "Entry not found" }], details: { error: true } };
          }
          const entry = entries[idx];
          if (entry.type === "learning") {
            (entry as LearningEntry).used++;
            (entry as LearningEntry).last_used = today();
          }
          writeJsonl(MEMORY_FILE, entries);
          return {
            content: [{ type: "text", text: `Reinforced: ${(entry as LearningEntry).text}` }],
            details: { id: entry.id, used: (entry as LearningEntry).used },
          };
        }

        case "search": {
          const query = (params.query || "").toLowerCase();
          const memory = readJsonl<Entry>(MEMORY_FILE);
          const matches = memory.filter((e) => {
            if (e.type === "learning") return (e as LearningEntry).text.toLowerCase().includes(query);
            if (e.type === "preference") return (e as PreferenceEntry).text.toLowerCase().includes(query);
            return false;
          });
          return {
            content: [
              {
                type: "text",
                text: matches.length
                  ? matches.map((m) => `[${m.id}] ${(m as LearningEntry | PreferenceEntry).text}`).join("\n")
                  : "No matches",
              },
            ],
            details: { count: matches.length },
          };
        }

        case "list": {
          const memory = readJsonl<Entry>(MEMORY_FILE);
          const learnings = memory.filter((e) => e.type === "learning") as LearningEntry[];
          const prefs = memory.filter((e) => e.type === "preference") as PreferenceEntry[];
          let text = `**Learnings (${learnings.length}):**\n`;
          text += learnings.map((l) => `- ${l.text}`).join("\n") || "(none)";
          text += `\n\n**Preferences (${prefs.length}):**\n`;
          text += prefs.map((p) => `- [${p.category}] ${p.text}`).join("\n") || "(none)";
          return { content: [{ type: "text", text }], details: { learnings: learnings.length, preferences: prefs.length } };
        }

        case "consolidate": {
          try {
            const result = await runConsolidation(ctx);
            if (!result) {
              return {
                content: [{ type: "text", text: "Consolidation failed or not enough entries to consolidate." }],
                details: { error: true },
              };
            }
            updateBrainWidget(ctx);
            return {
              content: [
                {
                  type: "text",
                  text: `Consolidated: ${result.before} → ${result.after} entries (removed ${result.removed}). Removed entries archived.`,
                },
              ],
              details: result,
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
              content: [{ type: "text", text: `Consolidation error: ${message}` }],
              details: { error: true },
            };
          }
        }

        default:
          return { content: [{ type: "text", text: `Unknown action` }], details: { error: true } };
      }
    },
  });

  // Register /brain command
  pi.registerCommand("brain", {
    description: "View brain stats or search (usage: /brain [stats|search <query>])",
    handler: async (args, ctx) => {
      const parts = args?.trim().split(/\s+/) || [];
      const subcmd = parts[0] || "stats";

      if (subcmd === "stats" || !subcmd) {
        const core = readJsonl<Entry>(CORE_FILE);
        const memory = readJsonl<Entry>(MEMORY_FILE);
        const learnings = memory.filter((e) => e.type === "learning").length;
        const prefs = memory.filter((e) => e.type === "preference").length;
        const identity = core.filter((e) => e.type === "identity").length;
        const behaviors = core.filter((e) => e.type === "behavior").length;
        ctx.ui.notify(`🧠 ${learnings}L ${prefs}P | core: ${identity}id ${behaviors}beh`, "info");
      } else if (subcmd === "search") {
        const query = parts.slice(1).join(" ").toLowerCase();
        if (!query) {
          ctx.ui.notify("Usage: /brain search <query>", "error");
          return;
        }
        const memory = readJsonl<Entry>(MEMORY_FILE);
        const matches = memory.filter((e) => {
          if (e.type === "learning") return (e as LearningEntry).text.toLowerCase().includes(query);
          if (e.type === "preference") return (e as PreferenceEntry).text.toLowerCase().includes(query);
          return false;
        });
        ctx.ui.notify(matches.length ? `Found ${matches.length} matches` : "No matches", "info");
      } else if (subcmd === "consolidate") {
        ctx.ui.notify("🧠 Consolidating memories (small model)...", "info");
        try {
          const result = await runConsolidation(ctx);
          if (result) {
            ctx.ui.notify(
              `🧠 Consolidated: ${result.before} → ${result.after} (removed ${result.removed})`,
              "info"
            );
            updateBrainWidget(ctx);
          } else {
            ctx.ui.notify("🧠 Consolidation failed or too few entries", "warning");
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ctx.ui.notify(`🧠 Error: ${message}`, "error");
        }
      } else {
        ctx.ui.notify("Usage: /brain [stats|search <query>|consolidate]", "error");
      }
    },
  });
}
