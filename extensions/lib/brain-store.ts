/**
 * extensions/lib/brain-store.ts
 *
 * Single source of truth for reading/writing brain.jsonl.
 * Append-only event log with schema validation, file locking,
 * and sequential fold into materialized state.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

import { withFileLock } from "./file-lock.ts";

// ── Entry Types ───────────────────────────────────────────────────

export interface BrainEntry {
  id: string;
  type: string;
  created: string;
}

export interface BehaviorEntry extends BrainEntry {
  type: "behavior";
  category: "do" | "dont" | "value";
  text: string;
}

export interface IdentityEntry extends BrainEntry {
  type: "identity";
  key: string;
  value: string;
}

export interface UserEntry extends BrainEntry {
  type: "user";
  key: string;
  value: string;
}

export interface LearningEntry extends BrainEntry {
  type: "learning";
  text: string;
  source?: string;
  scope?: "global" | "project";
  projectPath?: string;
}

export interface PreferenceEntry extends BrainEntry {
  type: "preference";
  category: string;
  text: string;
}

export interface ContextEntry extends BrainEntry {
  type: "context";
  project: string;
  path: string;
  content: string;
}

export interface TaskEntry extends BrainEntry {
  type: "task";
  description: string;
  status: "pending" | "done";
  priority: "urgent" | "high" | "normal" | "low";
  tags: string[];
  due: string | null;
  completedAt: string | null;
}

export interface ReminderEntry extends BrainEntry {
  type: "reminder";
  text: string;
  enabled: boolean;
  cadence: { kind: "interval"; every: string } | { kind: "daily"; at: string };
  priority: "urgent" | "high" | "normal" | "low";
  tags: string[];
  last_run: string | null;
  next_due: string | null;
  last_result: "ok" | "error" | "skipped" | null;
  last_error: string | null;
}

export interface TombstoneEntry extends BrainEntry {
  type: "tombstone";
  target_id: string;
  target_type: string;
  reason: string;
}

export interface MetaEntry extends BrainEntry {
  type: "meta";
  key: string;
  value: string;
}

// ── Materialized State ────────────────────────────────────────────

export interface MaterializedBrain {
  behaviors: BehaviorEntry[];
  identity: Map<string, IdentityEntry>;
  user: Map<string, UserEntry>;
  learnings: LearningEntry[];
  preferences: PreferenceEntry[];
  contexts: ContextEntry[];
  tasks: TaskEntry[];
  reminders: ReminderEntry[];
  meta: Map<string, MetaEntry>;
  tombstoned: Set<string>;
}

// ── Schema Registry ───────────────────────────────────────────────

export const SCHEMA_REGISTRY: Record<
  string,
  { required: string[]; enums?: Record<string, string[]> }
> = {
  behavior:   { required: ["category", "text"], enums: { category: ["do", "dont", "value"] } },
  identity:   { required: ["key", "value"] },
  user:       { required: ["key", "value"] },
  learning:   { required: ["text"] },
  preference: { required: ["text", "category"] },
  context:    { required: ["project", "path", "content"] },
  task:       { required: ["description"] },
  reminder:   { required: ["text", "cadence", "enabled"] },
  tombstone:  { required: ["target_id", "target_type", "reason"] },
  meta:       { required: ["key", "value"] },
};

// ── Constants ─────────────────────────────────────────────────────

const BRAIN_DIR = process.env.RHO_BRAIN_DIR ?? path.join(os.homedir(), ".rho", "brain");
const BRAIN_PATH = process.env.RHO_BRAIN_PATH ?? path.join(BRAIN_DIR, "brain.jsonl");

export { BRAIN_DIR, BRAIN_PATH };

// ── validateEntry ─────────────────────────────────────────────────

export function validateEntry(
  entry: any,
): { ok: true } | { ok: false; error: string } {
  if (!entry || typeof entry !== "object") {
    return { ok: false, error: "entry must be an object" };
  }
  if (typeof entry.id !== "string" || !entry.id) {
    return { ok: false, error: "entry requires id (string)" };
  }
  if (typeof entry.type !== "string" || !entry.type) {
    return { ok: false, error: "entry requires type (string)" };
  }
  if (typeof entry.created !== "string" || !entry.created) {
    return { ok: false, error: "entry requires created (ISO 8601 string)" };
  }

  const schema = SCHEMA_REGISTRY[entry.type];
  if (!schema) {
    return { ok: false, error: `unknown type "${entry.type}"` };
  }

  // Check required fields
  for (const field of schema.required) {
    const val = entry[field];
    if (val === undefined || val === null) {
      return {
        ok: false,
        error: `${entry.type} requires ${field}`,
      };
    }
  }

  // Check enum constraints
  if (schema.enums) {
    for (const [field, allowed] of Object.entries(schema.enums)) {
      const val = entry[field];
      if (val !== undefined && val !== null && !allowed.includes(val)) {
        return {
          ok: false,
          error: `${entry.type} field "${field}" must be one of: ${allowed.join(", ")} (got "${val}")`,
        };
      }
    }
  }

  return { ok: true };
}

// ── deterministicId ───────────────────────────────────────────────

export function deterministicId(type: string, naturalKey: string): string {
  return crypto
    .createHash("sha256")
    .update(`${type}:${naturalKey}`)
    .digest("hex")
    .slice(0, 8);
}

// ── readBrain ─────────────────────────────────────────────────────

export function readBrain(filePath: string): {
  entries: BrainEntry[];
  stats: { total: number; badLines: number; truncatedTail: boolean };
} {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf-8");
  } catch (err: any) {
    if (err?.code === "ENOENT") {
      return { entries: [], stats: { total: 0, badLines: 0, truncatedTail: false } };
    }
    throw err;
  }

  if (!raw || !raw.trim()) {
    return { entries: [], stats: { total: 0, badLines: 0, truncatedTail: false } };
  }

  const endsWithNewline = raw.endsWith("\n");
  const lines = raw.split("\n").filter((l) => l.trim() !== "");

  const entries: BrainEntry[] = [];
  let badLines = 0;
  let truncatedTail = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    try {
      const parsed = JSON.parse(line);
      entries.push(parsed as BrainEntry);
    } catch {
      // If this is the last line and file doesn't end with \n → truncated tail
      if (i === lines.length - 1 && !endsWithNewline) {
        truncatedTail = true;
      } else {
        badLines++;
      }
    }
  }

  return {
    entries,
    stats: { total: entries.length, badLines, truncatedTail },
  };
}

// ── foldBrain ─────────────────────────────────────────────────────

export function foldBrain(entries: BrainEntry[]): MaterializedBrain {
  const brain: MaterializedBrain = {
    behaviors: [],
    identity: new Map(),
    user: new Map(),
    learnings: [],
    preferences: [],
    contexts: [],
    tasks: [],
    reminders: [],
    meta: new Map(),
    tombstoned: new Set(),
  };

  for (const entry of entries) {
    if (entry.type === "tombstone") {
      const ts = entry as TombstoneEntry;
      brain.tombstoned.add(ts.target_id);
      // Remove from collections
      removeById(brain, ts.target_id, ts.target_type);
      continue;
    }

    // If this id was previously tombstoned, the new entry resurrects it
    if (brain.tombstoned.has(entry.id)) {
      brain.tombstoned.delete(entry.id);
    }

    switch (entry.type) {
      case "behavior":
        upsertArray(brain.behaviors, entry as BehaviorEntry);
        break;
      case "identity":
        brain.identity.set((entry as IdentityEntry).key, entry as IdentityEntry);
        break;
      case "user":
        brain.user.set((entry as UserEntry).key, entry as UserEntry);
        break;
      case "learning":
        upsertArray(brain.learnings, entry as LearningEntry);
        break;
      case "preference":
        upsertArray(brain.preferences, entry as PreferenceEntry);
        break;
      case "context":
        upsertArray(brain.contexts, entry as ContextEntry);
        break;
      case "task":
        upsertArray(brain.tasks, entry as TaskEntry);
        break;
      case "reminder":
        upsertArray(brain.reminders, entry as ReminderEntry);
        break;
      case "meta":
        brain.meta.set((entry as MetaEntry).key, entry as MetaEntry);
        break;
      // Unknown types silently ignored during fold
    }
  }

  return brain;
}

/** Replace entry with same id in array, or push if new. */
function upsertArray<T extends BrainEntry>(arr: T[], entry: T): void {
  const idx = arr.findIndex((e) => e.id === entry.id);
  if (idx >= 0) {
    arr[idx] = entry;
  } else {
    arr.push(entry);
  }
}

/** Remove an entry by id from the correct collection based on target_type. */
function removeById(brain: MaterializedBrain, id: string, targetType: string): void {
  switch (targetType) {
    case "behavior":
      brain.behaviors = brain.behaviors.filter((e) => e.id !== id);
      break;
    case "identity":
      for (const [k, v] of brain.identity) {
        if (v.id === id) { brain.identity.delete(k); break; }
      }
      break;
    case "user":
      for (const [k, v] of brain.user) {
        if (v.id === id) { brain.user.delete(k); break; }
      }
      break;
    case "learning":
      brain.learnings = brain.learnings.filter((e) => e.id !== id);
      break;
    case "preference":
      brain.preferences = brain.preferences.filter((e) => e.id !== id);
      break;
    case "context":
      brain.contexts = brain.contexts.filter((e) => e.id !== id);
      break;
    case "task":
      brain.tasks = brain.tasks.filter((e) => e.id !== id);
      break;
    case "reminder":
      brain.reminders = brain.reminders.filter((e) => e.id !== id);
      break;
    case "meta":
      for (const [k, v] of brain.meta) {
        if (v.id === id) { brain.meta.delete(k); break; }
      }
      break;
  }
}

// ── appendBrainEntry ──────────────────────────────────────────────

export async function appendBrainEntry(
  filePath: string,
  entry: BrainEntry,
): Promise<void> {
  const v = validateEntry(entry);
  if (!v.ok) {
    throw new Error(`Invalid brain entry: ${v.error}`);
  }

  const lockPath = filePath + ".lock";
  const dir = path.dirname(filePath);

  await withFileLock(lockPath, { purpose: "append" }, async () => {
    fs.mkdirSync(dir, { recursive: true });
    const fd = fs.openSync(
      filePath,
      fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY,
      0o644,
    );
    try {
      fs.writeSync(fd, JSON.stringify(entry) + "\n");
    } finally {
      fs.closeSync(fd);
    }
  });
}

// ── appendBrainEntryWithDedup ─────────────────────────────────────

export async function appendBrainEntryWithDedup(
  filePath: string,
  entry: BrainEntry,
  isDuplicate: (existing: BrainEntry[], candidate: BrainEntry) => boolean,
): Promise<boolean> {
  const v = validateEntry(entry);
  if (!v.ok) {
    throw new Error(`Invalid brain entry: ${v.error}`);
  }

  const lockPath = filePath + ".lock";
  const dir = path.dirname(filePath);

  return await withFileLock(lockPath, { purpose: "dedup-append" }, async () => {
    fs.mkdirSync(dir, { recursive: true });

    // Read + fold current state inside the lock
    const { entries } = readBrain(filePath);
    const brain = foldBrain(entries);

    // Collect all non-tombstoned entries from materialized state
    const allEntries: BrainEntry[] = [
      ...brain.behaviors,
      ...brain.identity.values(),
      ...brain.user.values(),
      ...brain.learnings,
      ...brain.preferences,
      ...brain.contexts,
      ...brain.tasks,
      ...brain.reminders,
      ...brain.meta.values(),
    ];

    if (isDuplicate(allEntries, entry)) {
      return false;
    }

    // Append
    const fd = fs.openSync(
      filePath,
      fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY,
      0o644,
    );
    try {
      fs.writeSync(fd, JSON.stringify(entry) + "\n");
    } finally {
      fs.closeSync(fd);
    }

    return true;
  });
}

// ── buildBrainPrompt ──────────────────────────────────────────────

const DEFAULT_BUDGET = 2000;

const SECTION_WEIGHTS = {
  behavior: 0.15,
  preferences: 0.20,
  context: 0.25,
  learnings: 0.40,
};

function approxTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

export function daysSince(isoDate: string): number {
  const then = new Date(isoDate).getTime();
  const now = Date.now();
  return Math.max(0, Math.floor((now - then) / (1000 * 60 * 60 * 24)));
}

export function scoreLearning(l: LearningEntry, cwd: string): number {
  const recency = Math.max(0, 10 - Math.floor(daysSince(l.created) / 7));
  const scopeBoost = l.scope === "project" && l.projectPath && cwd.startsWith(l.projectPath) ? 5 : 0;
  const manualBoost = l.source === "manual" ? 2 : 0;
  return recency + scopeBoost + manualBoost;
}

function takeLinesUntilBudget(lines: string[], budgetTokens: number): { taken: string[]; omitted: number } {
  const taken: string[] = [];
  let used = 0;
  for (const line of lines) {
    const t = approxTokens(line + "\n");
    if (used + t > budgetTokens && taken.length > 0) {
      return { taken, omitted: lines.length - taken.length };
    }
    taken.push(line);
    used += t;
  }
  return { taken, omitted: 0 };
}

export function buildBrainPrompt(
  brain: MaterializedBrain,
  cwd: string,
  opts?: { promptBudget?: number },
): string {
  const totalBudget = opts?.promptBudget ?? DEFAULT_BUDGET;

  // Reserve tokens for the wrapper header "## Memory\n\n"
  const headerOverhead = approxTokens("## Memory\n\n");
  const budget = totalBudget - headerOverhead;

  // Check if there's anything to render
  const hasContent =
    brain.behaviors.length > 0 ||
    brain.preferences.length > 0 ||
    brain.contexts.some((c) => cwd.startsWith(c.path)) ||
    brain.learnings.length > 0 ||
    brain.identity.size > 0 ||
    brain.user.size > 0;

  if (!hasContent) return "";

  // ── Fixed-cost sections (identity, user) — rendered first, subtracted from budget ──
  let remainingBudget = budget;
  const sections: string[] = [];

  if (brain.identity.size > 0) {
    const lines = [...brain.identity.values()]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((e) => `**${e.key}:** ${e.value}`);
    const rendered = "## Identity\n" + lines.join("\n");
    sections.push(rendered);
    remainingBudget -= approxTokens(rendered + "\n\n");
  }

  if (brain.user.size > 0) {
    const lines = [...brain.user.values()]
      .sort((a, b) => a.key.localeCompare(b.key))
      .map((e) => `**${e.key}:** ${e.value}`);
    const rendered = "## User\n" + lines.join("\n");
    sections.push(rendered);
    remainingBudget -= approxTokens(rendered + "\n\n");
  }

  // Compute weighted section budgets from remaining space
  let behaviorBudget = Math.floor(remainingBudget * SECTION_WEIGHTS.behavior);
  let prefsBudget = Math.floor(remainingBudget * SECTION_WEIGHTS.preferences);
  let contextBudget = Math.floor(remainingBudget * SECTION_WEIGHTS.context);
  let learningsBudget = Math.floor(remainingBudget * SECTION_WEIGHTS.learnings);

  // ── Behavior ──
  const behaviorLines: string[] = [];
  const dos = brain.behaviors.filter((b) => b.category === "do").map((b) => b.text);
  const donts = brain.behaviors.filter((b) => b.category === "dont").map((b) => b.text);
  const values = brain.behaviors.filter((b) => b.category === "value").map((b) => b.text);
  if (dos.length > 0) behaviorLines.push(`**Do:** ${dos.join(". ")}`);
  if (donts.length > 0) behaviorLines.push(`**Don't:** ${donts.join(". ")}`);
  if (values.length > 0) behaviorLines.push(`**Values:** ${values.join(". ")}`);

  if (behaviorLines.length > 0) {
    const header = "## Behavior";
    const { taken, omitted } = takeLinesUntilBudget(behaviorLines, behaviorBudget - approxTokens(header + "\n"));
    const lines = [header, ...taken];
    if (omitted > 0) lines.push(`(…${omitted} more omitted)`);
    const rendered = lines.join("\n");
    sections.push(rendered);
    const used = approxTokens(rendered);
    learningsBudget += Math.max(0, behaviorBudget - used); // surplus → learnings
  } else {
    learningsBudget += behaviorBudget;
  }

  // ── Preferences ──
  const prefLines: string[] = [];
  const prefsByCategory = new Map<string, string[]>();
  for (const p of brain.preferences) {
    const arr = prefsByCategory.get(p.category) || [];
    arr.push(p.text);
    prefsByCategory.set(p.category, arr);
  }
  for (const [cat, items] of [...prefsByCategory.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    prefLines.push(`**${cat}:** ${items.join(". ")}`);
  }

  if (prefLines.length > 0) {
    const header = "## Preferences";
    const { taken, omitted } = takeLinesUntilBudget(prefLines, prefsBudget - approxTokens(header + "\n"));
    const lines = [header, ...taken];
    if (omitted > 0) lines.push(`(…${omitted} more omitted)`);
    const rendered = lines.join("\n");
    sections.push(rendered);
    const used = approxTokens(rendered);
    learningsBudget += Math.max(0, prefsBudget - used);
  } else {
    learningsBudget += prefsBudget;
  }

  // ── Context (longest prefix match) ──
  const matchingContexts = brain.contexts
    .filter((c) => cwd.startsWith(c.path))
    .sort((a, b) => b.path.length - a.path.length);
  const bestContext = matchingContexts[0];

  if (bestContext) {
    const header = `## Project: ${bestContext.project}`;
    const contentLines = bestContext.content.split("\n");
    const { taken, omitted } = takeLinesUntilBudget(contentLines, contextBudget - approxTokens(header + "\n"));
    const lines = [header, ...taken];
    if (omitted > 0) lines.push(`(…${omitted} more omitted)`);
    const rendered = lines.join("\n");
    sections.push(rendered);
    const used = approxTokens(rendered);
    learningsBudget += Math.max(0, contextBudget - used);
  } else {
    learningsBudget += contextBudget;
  }

  // ── Learnings (ranked) ──
  if (brain.learnings.length > 0) {
    const scored = brain.learnings
      .map((l) => ({ entry: l, score: scoreLearning(l, cwd) }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        // Tiebreaker: newest first
        return b.entry.created.localeCompare(a.entry.created);
      });

    const learningLines = scored.map((s) => `- ${s.entry.text}`);
    const header = "## Learnings";
    const { taken, omitted } = takeLinesUntilBudget(learningLines, learningsBudget - approxTokens(header + "\n"));
    const lines = [header, ...taken];
    if (omitted > 0) lines.push(`(…${omitted} more omitted)`);
    sections.push(lines.join("\n"));
  }

  if (sections.length === 0) return "";

  return "## Memory\n\n" + sections.join("\n\n");
}

/**
 * Compute which entry IDs would be included in the prompt.
 * Mirrors buildBrainPrompt logic without rendering the actual text.
 */
export function getInjectedIds(
  brain: MaterializedBrain,
  cwd: string,
  opts?: { promptBudget?: number },
): Set<string> {
  const ids = new Set<string>();
  const totalBudget = opts?.promptBudget ?? DEFAULT_BUDGET;
  const headerOverhead = approxTokens("## Memory\n\n");
  let remainingBudget = totalBudget - headerOverhead;

  // ── Fixed-cost: identity, user ──
  for (const e of brain.identity.values()) {
    ids.add(e.id);
    remainingBudget -= approxTokens(`**${e.key}:** ${e.value}\n`);
  }
  if (brain.identity.size > 0) remainingBudget -= approxTokens("## Identity\n");

  for (const e of brain.user.values()) {
    ids.add(e.id);
    remainingBudget -= approxTokens(`**${e.key}:** ${e.value}\n`);
  }
  if (brain.user.size > 0) remainingBudget -= approxTokens("## User\n");

  let behaviorBudget = Math.floor(remainingBudget * SECTION_WEIGHTS.behavior);
  let prefsBudget = Math.floor(remainingBudget * SECTION_WEIGHTS.preferences);
  let contextBudget = Math.floor(remainingBudget * SECTION_WEIGHTS.context);
  let learningsBudget = Math.floor(remainingBudget * SECTION_WEIGHTS.learnings);

  // ── Behaviors ──
  const behaviorLines = brain.behaviors.map((b) => ({ id: b.id, text: b.text }));
  if (behaviorLines.length > 0) {
    const header = "## Behavior";
    let used = approxTokens(header + "\n");
    for (const b of behaviorLines) {
      const t = approxTokens(b.text + "\n");
      if (used + t > behaviorBudget && ids.size > 0) break;
      ids.add(b.id);
      used += t;
    }
    learningsBudget += Math.max(0, behaviorBudget - used);
  } else {
    learningsBudget += behaviorBudget;
  }

  // ── Preferences ──
  const prefByCat = new Map<string, typeof brain.preferences>();
  for (const p of brain.preferences) {
    const arr = prefByCat.get(p.category) || [];
    arr.push(p);
    prefByCat.set(p.category, arr);
  }
  if (prefByCat.size > 0) {
    const header = "## Preferences";
    let used = approxTokens(header + "\n");
    // Add preferences one by one, like buildBrainPrompt renders them
    for (const [cat, prefs] of [...prefByCat.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const line = `**${cat}:** ${prefs.map((p) => p.text).join(". ")}`;
      const t = approxTokens(line + "\n");
      if (used + t > prefsBudget && used > approxTokens(header + "\n")) break;
      for (const p of prefs) ids.add(p.id);
      used += t;
    }
    learningsBudget += Math.max(0, prefsBudget - used);
  } else {
    learningsBudget += prefsBudget;
  }

  // ── Context (longest prefix match) ──
  const matchingContexts = brain.contexts
    .filter((c) => cwd.startsWith(c.path))
    .sort((a, b) => b.path.length - a.path.length);
  if (matchingContexts[0]) {
    ids.add(matchingContexts[0].id);
    const rendered = `## Project: ${matchingContexts[0].project}\n${matchingContexts[0].content}`;
    const used = approxTokens(rendered);
    learningsBudget += Math.max(0, contextBudget - used);
  } else {
    learningsBudget += contextBudget;
  }

  // ── Learnings (ranked by score, budget-trimmed) ──
  if (brain.learnings.length > 0) {
    const scored = brain.learnings
      .map((l) => ({ entry: l, score: scoreLearning(l, cwd) }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return b.entry.created.localeCompare(a.entry.created);
      });

    const header = "## Learnings";
    let used = approxTokens(header + "\n");
    for (const s of scored) {
      const t = approxTokens(`- ${s.entry.text}\n`);
      if (used + t > learningsBudget && ids.size > 0) break;
      ids.add(s.entry.id);
      used += t;
    }
  }

  return ids;
}
