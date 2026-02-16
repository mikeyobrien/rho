/**
 * extensions/lib/brain-bootstrap-state.ts
 *
 * Pure helpers for deriving and mutating bootstrap state from in-memory brain entries.
 */

import { deterministicId } from "./brain-store.ts";
import {
  BOOTSTRAP_META_KEYS,
  BOOTSTRAP_STATUS_COMPLETED,
  BOOTSTRAP_STATUS_NOT_STARTED,
  BOOTSTRAP_STATUS_PARTIAL,
  isIsoTimestamp,
  validateBootstrapMeta,
  type BootstrapStatus,
} from "./brain-bootstrap-schema.ts";

export interface BrainLikeEntry {
  id?: string;
  type?: unknown;
  key?: unknown;
  value?: unknown;
  created?: unknown;
  [k: string]: unknown;
}

export interface BootstrapState {
  status: BootstrapStatus;
  version?: string;
  completedAt?: string;
}

function isMetaEntry(entry: BrainLikeEntry): boolean {
  return entry?.type === "meta" && typeof entry?.key === "string";
}

function normalizeBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (lowered === "true") return true;
    if (lowered === "false") return false;
  }
  return undefined;
}

function upsertMeta(
  entries: BrainLikeEntry[],
  args: { key: string; value: unknown; created: string },
): BrainLikeEntry[] {
  const next = entries.map((e) => ({ ...e }));
  const idx = next.findIndex((e) => e.type === "meta" && e.key === args.key);
  const id = deterministicId("meta", args.key);

  const row: BrainLikeEntry = {
    id,
    type: "meta",
    key: args.key,
    value: args.value,
    created: args.created,
  };

  if (idx >= 0) {
    next[idx] = { ...next[idx], ...row };
  } else {
    next.push(row);
  }

  return next;
}

export function getBootstrapState(entries: BrainLikeEntry[]): BootstrapState {
  const byKey = new Map<string, unknown>();

  for (const entry of entries) {
    if (!isMetaEntry(entry)) continue;
    byKey.set(entry.key as string, entry.value);
  }

  const completed = normalizeBoolean(byKey.get(BOOTSTRAP_META_KEYS.completed));
  const versionRaw = byKey.get(BOOTSTRAP_META_KEYS.version);
  const completedAtRaw = byKey.get(BOOTSTRAP_META_KEYS.completedAt);

  const version = typeof versionRaw === "string" && versionRaw.trim() ? versionRaw.trim() : undefined;
  const completedAt =
    typeof completedAtRaw === "string" && isIsoTimestamp(completedAtRaw)
      ? completedAtRaw
      : undefined;

  const validation = validateBootstrapMeta({ completed, version, completedAt });

  if (completed === true && validation.ok) {
    return {
      status: BOOTSTRAP_STATUS_COMPLETED,
      version,
      completedAt,
    };
  }

  const hasBootstrapKeys =
    byKey.has(BOOTSTRAP_META_KEYS.completed) ||
    byKey.has(BOOTSTRAP_META_KEYS.version) ||
    byKey.has(BOOTSTRAP_META_KEYS.completedAt);

  if (hasBootstrapKeys) {
    return {
      status: BOOTSTRAP_STATUS_PARTIAL,
      version,
      completedAt,
    };
  }

  return { status: BOOTSTRAP_STATUS_NOT_STARTED };
}

export function markBootstrapCompleted(
  entries: BrainLikeEntry[],
  version: string,
  nowIso: string,
): BrainLikeEntry[] {
  let next = entries.map((e) => ({ ...e }));

  next = upsertMeta(next, {
    key: BOOTSTRAP_META_KEYS.completed,
    value: true,
    created: nowIso,
  });

  next = upsertMeta(next, {
    key: BOOTSTRAP_META_KEYS.version,
    value: version,
    created: nowIso,
  });

  next = upsertMeta(next, {
    key: BOOTSTRAP_META_KEYS.completedAt,
    value: nowIso,
    created: nowIso,
  });

  return next;
}
