/**
 * extensions/lib/brain-migration.ts
 *
 * Detects legacy brain files (core.jsonl, memory.jsonl, context.jsonl, tasks.jsonl)
 * and migrates their entries into the unified brain.jsonl format.
 *
 * Legacy files are only read during migration. After migration completes,
 * cleanupLegacyFiles() can be called to remove them.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { readBrain, foldBrain, appendBrainEntry, BRAIN_PATH } from "./brain-store.ts";

const HOME = os.homedir();
const RHO_DIR = path.join(HOME, ".rho");
const BRAIN_DIR = path.join(RHO_DIR, "brain");

// Legacy file paths
const LEGACY_CORE = path.join(BRAIN_DIR, "core.jsonl");
const LEGACY_MEMORY = path.join(BRAIN_DIR, "memory.jsonl");
const LEGACY_CONTEXT = path.join(BRAIN_DIR, "context.jsonl");
const LEGACY_TASKS = path.join(RHO_DIR, "tasks.jsonl");

// ── Types ─────────────────────────────────────────────────────────

export interface MigrationPaths {
  brainPath: string;
  legacyCore: string;
  legacyMemory: string;
  legacyContext: string;
  legacyTasks: string;
}

export interface MigrationStatus {
  hasLegacy: boolean;
  alreadyMigrated: boolean;
  legacyFiles: string[];
}

export interface MigrationStats {
  behaviors: number;
  identity: number;
  user: number;
  learnings: number;
  preferences: number;
  contexts: number;
  tasks: number;
  skipped: number;
}

// ── Helpers ───────────────────────────────────────────────────────

function readLegacyJsonl(filePath: string): any[] {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return content
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function genId(): string {
  return crypto.randomBytes(4).toString("hex");
}

// ── Default paths ─────────────────────────────────────────────────

function defaultPaths(): MigrationPaths {
  return {
    brainPath: BRAIN_PATH,
    legacyCore: LEGACY_CORE,
    legacyMemory: LEGACY_MEMORY,
    legacyContext: LEGACY_CONTEXT,
    legacyTasks: LEGACY_TASKS,
  };
}

// ── Detection ─────────────────────────────────────────────────────

/**
 * Check if migration is needed. Accepts optional paths for testing.
 */
export function detectMigrationWithPaths(paths: MigrationPaths): MigrationStatus {
  const legacyFiles: string[] = [];
  for (const f of [paths.legacyCore, paths.legacyMemory, paths.legacyContext, paths.legacyTasks]) {
    if (fs.existsSync(f)) {
      // Only count files that have actual content
      try {
        const content = fs.readFileSync(f, "utf-8").trim();
        if (content) legacyFiles.push(f);
      } catch {
        // unreadable → skip
      }
    }
  }

  const { entries } = readBrain(paths.brainPath);
  const brain = foldBrain(entries);
  const alreadyMigrated = brain.meta.get("migration.v2")?.value === "done" ||
    brain.meta.get("migration.v2")?.value === "skip";

  return {
    hasLegacy: legacyFiles.length > 0,
    alreadyMigrated,
    legacyFiles,
  };
}

/** Convenience wrapper using real paths. */
export function detectMigration(): MigrationStatus {
  return detectMigrationWithPaths(defaultPaths());
}

// ── Migration ─────────────────────────────────────────────────────

/**
 * Run the migration. Accepts optional paths for testing.
 * Returns a summary of what was migrated.
 */
export async function runMigrationWithPaths(paths: MigrationPaths): Promise<MigrationStats> {
  const stats: MigrationStats = {
    behaviors: 0,
    identity: 0,
    user: 0,
    learnings: 0,
    preferences: 0,
    contexts: 0,
    tasks: 0,
    skipped: 0,
  };
  const now = new Date().toISOString();

  // Read existing brain to check for duplicates
  const { entries: existingEntries } = readBrain(paths.brainPath);
  const existing = foldBrain(existingEntries);

  // Build dedup sets from existing materialized state
  const existingTexts = new Set<string>();
  for (const l of existing.learnings) existingTexts.add(l.text.toLowerCase().trim());
  for (const p of existing.preferences) existingTexts.add(p.text.toLowerCase().trim());

  // ── Migrate core.jsonl (behaviors, identity, user) ──
  if (fs.existsSync(paths.legacyCore)) {
    const lines = readLegacyJsonl(paths.legacyCore);
    for (const entry of lines) {
      try {
        if (entry.type === "behavior") {
          if (existing.behaviors.some((b) => b.text === entry.text && b.category === entry.category)) {
            stats.skipped++;
            continue;
          }
          await appendBrainEntry(paths.brainPath, {
            id: genId(),
            type: "behavior",
            category: entry.category,
            text: entry.text,
            created: entry.created || now,
          });
          stats.behaviors++;
        } else if (entry.type === "identity") {
          if (existing.identity.has(entry.key)) {
            stats.skipped++;
            continue;
          }
          await appendBrainEntry(paths.brainPath, {
            id: genId(),
            type: "identity",
            key: entry.key,
            value: entry.value,
            created: entry.created || now,
          });
          stats.identity++;
        } else if (entry.type === "user") {
          if (existing.user.has(entry.key)) {
            stats.skipped++;
            continue;
          }
          await appendBrainEntry(paths.brainPath, {
            id: genId(),
            type: "user",
            key: entry.key,
            value: entry.value,
            created: entry.created || now,
          });
          stats.user++;
        }
      } catch {
        stats.skipped++;
      }
    }
  }

  // ── Migrate memory.jsonl (learnings, preferences) ──
  // Legacy learnings may have `used`/`last_used` fields — we drop them.
  if (fs.existsSync(paths.legacyMemory)) {
    const lines = readLegacyJsonl(paths.legacyMemory);
    for (const entry of lines) {
      try {
        if (entry.type === "learning") {
          const text = (entry.text || "").trim();
          if (!text || existingTexts.has(text.toLowerCase())) {
            stats.skipped++;
            continue;
          }
          await appendBrainEntry(paths.brainPath, {
            id: genId(),
            type: "learning",
            text,
            source: "migration",
            created: entry.created || now,
          });
          existingTexts.add(text.toLowerCase());
          stats.learnings++;
        } else if (entry.type === "preference") {
          const text = (entry.text || "").trim();
          const category = entry.category || "General";
          if (!text || existingTexts.has(text.toLowerCase())) {
            stats.skipped++;
            continue;
          }
          await appendBrainEntry(paths.brainPath, {
            id: genId(),
            type: "preference",
            text,
            category,
            created: entry.created || now,
          });
          existingTexts.add(text.toLowerCase());
          stats.preferences++;
        }
      } catch {
        stats.skipped++;
      }
    }
  }

  // ── Migrate context.jsonl ──
  if (fs.existsSync(paths.legacyContext)) {
    const lines = readLegacyJsonl(paths.legacyContext);
    for (const entry of lines) {
      try {
        if (entry.type === "context" && entry.path && entry.content) {
          if (existing.contexts.some((c) => c.path === entry.path)) {
            stats.skipped++;
            continue;
          }
          await appendBrainEntry(paths.brainPath, {
            id: genId(),
            type: "context",
            project: entry.project || path.basename(entry.path),
            path: entry.path,
            content: entry.content,
            created: entry.created || now,
          });
          stats.contexts++;
        }
      } catch {
        stats.skipped++;
      }
    }
  }

  // ── Migrate tasks.jsonl ──
  // Legacy tasks may lack `type` field — we add it.
  if (fs.existsSync(paths.legacyTasks)) {
    const lines = readLegacyJsonl(paths.legacyTasks);
    for (const entry of lines) {
      try {
        if (entry.description) {
          if (existing.tasks.some((t) => t.description === entry.description)) {
            stats.skipped++;
            continue;
          }
          await appendBrainEntry(paths.brainPath, {
            id: entry.id || genId(),
            type: "task",
            description: entry.description,
            status: entry.status || "pending",
            priority: entry.priority || "normal",
            tags: entry.tags || [],
            due: entry.due || null,
            completedAt: entry.completedAt || null,
            created: entry.created || now,
          });
          stats.tasks++;
        }
      } catch {
        stats.skipped++;
      }
    }
  }

  // ── Write migration marker ──
  await appendBrainEntry(paths.brainPath, {
    id: genId(),
    type: "meta",
    key: "migration.v2",
    value: "done",
    created: now,
  });

  return stats;
}

/** Convenience wrapper using real paths. */
export async function runMigration(): Promise<MigrationStats> {
  return runMigrationWithPaths(defaultPaths());
}

// ── Cleanup ───────────────────────────────────────────────────────

/**
 * Remove legacy files after successful migration.
 * Only removes files that exist and are listed as legacy paths.
 * Returns the list of files that were deleted.
 */
export function cleanupLegacyFilesWithPaths(paths: MigrationPaths): string[] {
  const status = detectMigrationWithPaths(paths);
  if (!status.alreadyMigrated) {
    throw new Error("Cannot cleanup: migration has not been completed yet");
  }

  const removed: string[] = [];
  for (const f of [paths.legacyCore, paths.legacyMemory, paths.legacyContext, paths.legacyTasks]) {
    if (fs.existsSync(f)) {
      fs.unlinkSync(f);
      removed.push(f);
    }
  }
  return removed;
}

/** Convenience wrapper using real paths. */
export function cleanupLegacyFiles(): string[] {
  return cleanupLegacyFilesWithPaths(defaultPaths());
}
