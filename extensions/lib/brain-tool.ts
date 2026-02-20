/**
 * extensions/lib/brain-tool.ts
 *
 * Pure-function brain tool logic. Testable without the pi extension runtime.
 * The extension's pi.registerTool handler delegates to handleBrainAction().
 */

import * as crypto from "node:crypto";

import {
  readBrain,
  foldBrain,
  appendBrainEntry,
  appendBrainEntryWithDedup,
  validateEntry,
  deterministicId,
  type BrainEntry,
  type LearningEntry,
  type PreferenceEntry,
  type TaskEntry,
  type ReminderEntry,
  type TombstoneEntry,
  type MaterializedBrain,
} from "./brain-store.ts";

// ── Types ─────────────────────────────────────────────────────────

export interface BrainActionResult {
  ok: boolean;
  message: string;
  data?: any;
}

interface HandleOpts {
  decayAfterDays?: number;
  decayMinScore?: number;
  cwd?: string;
}

// ── Keyed types that auto-upsert ──────────────────────────────────

const KEYED_TYPES: Record<string, string> = {
  identity: "key",
  user: "key",
  meta: "key",
  context: "path",
};

// ── Dedup types ───────────────────────────────────────────────────

const DEDUP_TYPES = new Set(["learning", "preference"]);

// ── Interval parsing ──────────────────────────────────────────────

function parseInterval(s: string): number {
  const m = s.match(/^(\d+)(m|h|d)$/);
  if (!m) throw new Error(`Invalid interval: ${s}`);
  const n = parseInt(m[1], 10);
  switch (m[2]) {
    case "m": return n * 60 * 1000;
    case "h": return n * 3600 * 1000;
    case "d": return n * 24 * 3600 * 1000;
    default: throw new Error(`Invalid interval unit: ${m[2]}`);
  }
}

function computeNextDue(
  cadence: { kind: string; every?: string; at?: string },
  ranAt: Date,
): string {
  if (cadence.kind === "interval" && cadence.every) {
    const ms = parseInterval(cadence.every);
    return new Date(ranAt.getTime() + ms).toISOString();
  }
  if (cadence.kind === "daily" && cadence.at) {
    // Next occurrence of cadence.at (HH:MM) in local time
    const [hh, mm] = cadence.at.split(":").map(Number);
    const next = new Date(ranAt);
    next.setHours(hh, mm, 0, 0);
    if (next.getTime() <= ranAt.getTime()) {
      next.setDate(next.getDate() + 1);
    }
    return next.toISOString();
  }
  // Fallback: 24h from now
  return new Date(ranAt.getTime() + 24 * 3600 * 1000).toISOString();
}

// ── Tag normalization ─────────────────────────────────────────────

function normalizeTags(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((t) => String(t).trim().toLowerCase()).filter(Boolean);
  if (typeof raw === "string" && raw.trim()) return raw.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
  return [];
}

// ── Text normalization for dedup ──────────────────────────────────

function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function isDuplicateText(
  existing: BrainEntry[],
  candidate: BrainEntry,
): boolean {
  const candidateText = normalizeText(
    (candidate as any).text ?? (candidate as any).description ?? "",
  );
  if (!candidateText) return false;
  return existing.some((e) => {
    const eText = normalizeText(
      (e as any).text ?? (e as any).description ?? "",
    );
    return eText === candidateText;
  });
}

// ── Scoring for decay ─────────────────────────────────────────────

function daysSince(isoDate: string): number {
  const then = new Date(isoDate).getTime();
  const now = Date.now();
  return Math.max(0, Math.floor((now - then) / (1000 * 60 * 60 * 24)));
}

function scoreLearning(l: LearningEntry, cwd: string): number {
  const recency = Math.max(0, 10 - Math.floor(daysSince(l.created) / 7));
  const scopeBoost =
    l.scope === "project" && l.projectPath && cwd.startsWith(l.projectPath)
      ? 5
      : 0;
  const manualBoost = l.source === "manual" ? 2 : 0;
  return recency + scopeBoost + manualBoost;
}

// ── Relative time formatting ──────────────────────────────────────

function relativeAge(isoDate: string): string {
  const d = daysSince(isoDate);
  if (d === 0) return "today";
  if (d === 1) return "1d ago";
  if (d < 30) return `${d}d ago`;
  const months = Math.floor(d / 30);
  return `${months}mo ago`;
}

// ── Compact formatting ────────────────────────────────────────────

function formatCompact(entries: BrainEntry[], typeName: string): string {
  if (entries.length === 0) return `[${typeName}] (0)\n  (none)`;

  const lines = [`[${typeName}] (${entries.length})`];
  for (const e of entries) {
    const summary = entryOneLiner(e);
    const age = relativeAge(e.created);
    const source = (e as any).source ?? "";
    const meta = [source, age].filter(Boolean).join(", ");
    lines.push(`  ${e.id}: ${summary} (${meta})`);
  }
  return lines.join("\n");
}

function entryOneLiner(e: BrainEntry): string {
  switch (e.type) {
    case "learning":
      return (e as LearningEntry).text;
    case "preference":
      return `[${(e as PreferenceEntry).category}] ${(e as PreferenceEntry).text}`;
    case "behavior":
      return `[${(e as any).category}] ${(e as any).text}`;
    case "identity":
    case "user":
    case "meta":
      return `${(e as any).key} = ${(e as any).value}`;
    case "context":
      return `${(e as any).project} (${(e as any).path})`;
    case "task": {
      const t = e as TaskEntry;
      const pri = t.priority !== "normal" ? ` [${t.priority}]` : "";
      const status = t.status === "done" ? " ✓" : "";
      return `${t.description}${pri}${status}`;
    }
    case "reminder": {
      const r = e as ReminderEntry;
      const enabled = r.enabled ? "" : " [disabled]";
      return `${r.text}${enabled}`;
    }
    default:
      return JSON.stringify(e);
  }
}

// ── Collect all entries from MaterializedBrain by type ─────────────

function getCollection(brain: MaterializedBrain, type: string): BrainEntry[] {
  switch (type) {
    case "behavior":   return brain.behaviors;
    case "identity":   return [...brain.identity.values()];
    case "user":       return [...brain.user.values()];
    case "learning":   return brain.learnings;
    case "preference": return brain.preferences;
    case "context":    return brain.contexts;
    case "task":       return brain.tasks;
    case "reminder":   return brain.reminders;
    case "meta":       return [...brain.meta.values()];
    default:           return [];
  }
}

function getAllEntries(brain: MaterializedBrain): BrainEntry[] {
  return [
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
}

function findEntryById(brain: MaterializedBrain, id: string): BrainEntry | undefined {
  return getAllEntries(brain).find((e) => e.id === id);
}

// ── Main dispatch ─────────────────────────────────────────────────

export async function handleBrainAction(
  brainPath: string,
  params: { action: string; [key: string]: any },
  opts?: HandleOpts,
): Promise<BrainActionResult> {
  const action = params.action;

  switch (action) {
    case "add":
      return handleAdd(brainPath, params);
    case "update":
      return handleUpdate(brainPath, params);
    case "remove":
      return handleRemove(brainPath, params);
    case "list":
      return handleList(brainPath, params);
    case "decay":
      return handleDecay(brainPath, opts);
    case "task_done":
      return handleTaskDone(brainPath, params);
    case "task_clear":
      return handleTaskClear(brainPath);
    case "reminder_run":
      return handleReminderRun(brainPath, params);
    default:
      return { ok: false, message: `Unknown action: "${action}"` };
  }
}

// ── Add ───────────────────────────────────────────────────────────

async function handleAdd(
  brainPath: string,
  params: Record<string, any>,
): Promise<BrainActionResult> {
  const type = params.type;
  if (!type) return { ok: false, message: "add requires type" };

  const now = new Date().toISOString();

  // Build the entry
  const entry: Record<string, any> = { ...params };
  delete entry.action;
  entry.created = now;

  // Parse cadence if passed as JSON string
  if (typeof entry.cadence === "string") {
    try { entry.cadence = JSON.parse(entry.cadence); } catch { /* leave as-is */ }
  }

  // Generate id
  const keyField = KEYED_TYPES[type];
  if (keyField) {
    const naturalKey = entry[keyField];
    if (!naturalKey) {
      return { ok: false, message: `${type} requires ${keyField}` };
    }
    entry.id = deterministicId(type, naturalKey);
  } else {
    entry.id = crypto.randomBytes(4).toString("hex");
  }

  // Apply defaults for task
  if (type === "task") {
    entry.status = entry.status ?? "pending";
    entry.priority = entry.priority ?? "normal";
    entry.tags = normalizeTags(entry.tags);
    entry.due = entry.due ?? null;
    entry.completedAt = entry.completedAt ?? null;
  }

  // Apply defaults for reminder
  if (type === "reminder") {
    entry.priority = entry.priority ?? "normal";
    entry.tags = normalizeTags(entry.tags);
    entry.last_run = entry.last_run ?? null;
    entry.next_due = entry.next_due ?? null;
    entry.last_result = entry.last_result ?? null;
    entry.last_error = entry.last_error ?? null;
  }

  // Validate before writing
  const validation = validateEntry(entry as BrainEntry);
  if (!validation.ok) {
    return { ok: false, message: validation.error };
  }

  // Dedup for learning/preference
  if (DEDUP_TYPES.has(type)) {
    const written = await appendBrainEntryWithDedup(
      brainPath,
      entry as BrainEntry,
      isDuplicateText,
    );
    if (!written) {
      return { ok: false, message: `Duplicate ${type}: already stored` };
    }
    return { ok: true, message: `Added ${type}: ${entryOneLiner(entry as BrainEntry)}`, data: { id: entry.id } };
  }

  // For keyed types, just append (fold handles upsert via same id)
  // For other types, just append
  await appendBrainEntry(brainPath, entry as BrainEntry);
  return { ok: true, message: `Added ${type}: ${entryOneLiner(entry as BrainEntry)}`, data: { id: entry.id } };
}

// ── Update ────────────────────────────────────────────────────────

async function handleUpdate(
  brainPath: string,
  params: Record<string, any>,
): Promise<BrainActionResult> {
  const { id } = params;
  if (!id) return { ok: false, message: "update requires id" };

  const { entries } = readBrain(brainPath);
  const brain = foldBrain(entries);
  const existing = findEntryById(brain, id);
  if (!existing) {
    return { ok: false, message: `No entry with id "${id}"` };
  }

  // Merge params over existing, preserving type, id, and created date
  const merged: Record<string, any> = { ...existing };
  for (const [k, v] of Object.entries(params)) {
    if (k === "action") continue;
    merged[k] = v;
  }
  // Parse cadence if passed as JSON string
  if (typeof merged.cadence === "string") {
    try { merged.cadence = JSON.parse(merged.cadence); } catch { /* leave as-is */ }
  }
  if ("tags" in merged) merged.tags = normalizeTags(merged.tags);
  // Preserve original created date - only update it for new entries

  const validation = validateEntry(merged as BrainEntry);
  if (!validation.ok) {
    return { ok: false, message: validation.error };
  }

  await appendBrainEntry(brainPath, merged as BrainEntry);
  return { ok: true, message: `Updated ${existing.type} ${id}`, data: { id } };
}

// ── Remove ────────────────────────────────────────────────────────

async function handleRemove(
  brainPath: string,
  params: Record<string, any>,
): Promise<BrainActionResult> {
  let targetId: string;
  let targetType: string;

  let targetEntry: BrainEntry | undefined;

  if (params.id) {
    // Direct id lookup — need to find the type
    const { entries } = readBrain(brainPath);
    const brain = foldBrain(entries);
    const existing = findEntryById(brain, params.id);
    if (!existing) {
      return { ok: false, message: `No entry with id "${params.id}"` };
    }
    targetId = params.id;
    targetType = existing.type;
    targetEntry = existing;
  } else if (params.type && KEYED_TYPES[params.type]) {
    // Natural key lookup
    const keyField = KEYED_TYPES[params.type];
    const keyValue = params[keyField];
    if (!keyValue) {
      return { ok: false, message: `remove by natural key requires ${keyField} for type ${params.type}` };
    }
    targetId = deterministicId(params.type, keyValue);
    targetType = params.type;
    const { entries } = readBrain(brainPath);
    const brain = foldBrain(entries);
    targetEntry = findEntryById(brain, targetId);
  } else {
    return { ok: false, message: "remove requires id, or type + natural key" };
  }

  const tombstone: TombstoneEntry = {
    id: crypto.randomBytes(4).toString("hex"),
    type: "tombstone",
    target_id: targetId,
    target_type: targetType,
    reason: "manual",
    created: new Date().toISOString(),
  };

  await appendBrainEntry(brainPath, tombstone);
  const summary = targetEntry ? `: ${entryOneLiner(targetEntry)}` : "";
  return { ok: true, message: `Removed ${targetType} ${targetId}${summary}` };
}

// ── List ──────────────────────────────────────────────────────────

async function handleList(
  brainPath: string,
  params: Record<string, any>,
): Promise<BrainActionResult> {
  const { entries } = readBrain(brainPath);
  const brain = foldBrain(entries);

  const type = params.type as string | undefined;
  const query = params.query as string | undefined;
  const filter = params.filter as string | undefined;
  const verbose = params.verbose === true;

  // Determine which collections to show
  let collections: Array<{ name: string; entries: BrainEntry[] }>;

  if (type) {
    collections = [{ name: type, entries: getCollection(brain, type) }];
  } else {
    // Show all non-empty types
    const types = [
      "behavior", "identity", "user", "learning",
      "preference", "context", "task", "reminder", "meta",
    ];
    collections = types
      .map((t) => ({ name: t, entries: getCollection(brain, t) }))
      .filter((c) => c.entries.length > 0);
  }

  // Apply query filter (substring match across text fields)
  if (query) {
    const q = query.toLowerCase();
    collections = collections.map((c) => ({
      ...c,
      entries: c.entries.filter((e) => {
        const text = [
          (e as any).text,
          (e as any).description,
          (e as any).content,
          (e as any).key,
          (e as any).value,
          (e as any).project,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return text.includes(q);
      }),
    }));
  }

  // Apply type-specific filters
  if (filter) {
    collections = collections.map((c) => {
      if (c.name === "task") {
        if (filter === "pending") {
          return { ...c, entries: c.entries.filter((e) => (e as TaskEntry).status === "pending") };
        }
        if (filter === "done") {
          return { ...c, entries: c.entries.filter((e) => (e as TaskEntry).status === "done") };
        }
      }
      if (c.name === "reminder") {
        if (filter === "active" || filter === "enabled") {
          return { ...c, entries: c.entries.filter((e) => (e as ReminderEntry).enabled) };
        }
      }
      return c;
    });
  }

  // Render
  if (verbose) {
    const parts = collections.map((c) => {
      if (c.entries.length === 0) return `[${c.name}] (0)`;
      return `[${c.name}] (${c.entries.length})\n` +
        c.entries.map((e) => JSON.stringify(e, null, 2)).join("\n");
    });
    return { ok: true, message: parts.join("\n\n") };
  }

  // Compact
  const parts = collections
    .filter((c) => c.entries.length > 0)
    .map((c) => formatCompact(c.entries, c.name));

  if (parts.length === 0) {
    const what = type ? `${type} entries` : "entries";
    return { ok: true, message: `No ${what} found.` };
  }

  return { ok: true, message: parts.join("\n\n") };
}

// ── Decay ─────────────────────────────────────────────────────────

async function handleDecay(
  brainPath: string,
  opts?: HandleOpts,
): Promise<BrainActionResult> {
  const decayAfterDays = opts?.decayAfterDays ?? 90;
  const decayMinScore = opts?.decayMinScore ?? 3;
  const cwd = opts?.cwd ?? "";

  const { entries } = readBrain(brainPath);
  const brain = foldBrain(entries);

  const toDecay: LearningEntry[] = [];
  for (const l of brain.learnings) {
    const age = daysSince(l.created);
    const score = scoreLearning(l, cwd);
    if (age > decayAfterDays && score < decayMinScore) {
      toDecay.push(l);
    }
  }

  if (toDecay.length === 0) {
    return { ok: true, message: "No learnings to decay." };
  }

  const now = new Date().toISOString();
  for (const l of toDecay) {
    const tombstone: TombstoneEntry = {
      id: crypto.randomBytes(4).toString("hex"),
      type: "tombstone",
      target_id: l.id,
      target_type: "learning",
      reason: "decay",
      created: now,
    };
    await appendBrainEntry(brainPath, tombstone);
  }

  return {
    ok: true,
    message: `Decayed ${toDecay.length} stale learning(s).`,
    data: { decayed: toDecay.map((l) => l.id) },
  };
}

// ── Task Done ─────────────────────────────────────────────────────

async function handleTaskDone(
  brainPath: string,
  params: Record<string, any>,
): Promise<BrainActionResult> {
  const { id } = params;
  if (!id) return { ok: false, message: "task_done requires id" };

  const { entries } = readBrain(brainPath);
  const brain = foldBrain(entries);
  const task = brain.tasks.find((t) => t.id === id);
  if (!task) {
    return { ok: false, message: `No task with id "${id}"` };
  }

  const updated: TaskEntry = {
    ...task,
    status: "done",
    completedAt: new Date().toISOString(),
    // Preserve original created date for age tracking
  };

  await appendBrainEntry(brainPath, updated);
  return { ok: true, message: `Completed: ${task.description}`, data: { id } };
}

// ── Task Clear ────────────────────────────────────────────────────

async function handleTaskClear(
  brainPath: string,
): Promise<BrainActionResult> {
  const { entries } = readBrain(brainPath);
  const brain = foldBrain(entries);
  const doneTasks = brain.tasks.filter((t) => t.status === "done");

  if (doneTasks.length === 0) {
    return { ok: true, message: "No done tasks to clear." };
  }

  const now = new Date().toISOString();
  for (const t of doneTasks) {
    const tombstone: TombstoneEntry = {
      id: crypto.randomBytes(4).toString("hex"),
      type: "tombstone",
      target_id: t.id,
      target_type: "task",
      reason: "manual",
      created: now,
    };
    await appendBrainEntry(brainPath, tombstone);
  }

  return {
    ok: true,
    message: `Cleared ${doneTasks.length} done task(s).`,
    data: { cleared: doneTasks.map((t) => t.id) },
  };
}

// ── Reminder Run ──────────────────────────────────────────────────

async function handleReminderRun(
  brainPath: string,
  params: Record<string, any>,
): Promise<BrainActionResult> {
  const { id, result, error } = params;
  if (!id) return { ok: false, message: "reminder_run requires id" };
  if (!result) return { ok: false, message: "reminder_run requires result (ok|error|skipped)" };

  const { entries } = readBrain(brainPath);
  const brain = foldBrain(entries);
  const reminder = brain.reminders.find((r) => r.id === id);
  if (!reminder) {
    return { ok: false, message: `No reminder with id "${id}"` };
  }

  const now = new Date();
  const updated: ReminderEntry = {
    ...reminder,
    last_run: now.toISOString(),
    last_result: result,
    last_error: error ?? null,
    next_due: computeNextDue(reminder.cadence, now),
    // Preserve original created date for age tracking
  };

  await appendBrainEntry(brainPath, updated);
  return {
    ok: true,
    message: `Reminder run recorded: ${reminder.text} → ${result}`,
    data: { id, next_due: updated.next_due },
  };
}
