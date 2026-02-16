/**
 * extensions/rho/bootstrap/merge-policy.ts
 *
 * Merge planner for managed bootstrap profile entries.
 *
 * BT-03 scope: plan-only logic (no disk writes) with clear action classes.
 */

import * as crypto from "node:crypto";
import { buildManagedKey } from "../../lib/brain-bootstrap-schema.ts";

export const MERGE_ACTIONS = [
  "ADD",
  "UPDATE",
  "NOOP",
  "SKIP_USER_EDITED",
  "SKIP_CONFLICT",
  "DEPRECATE",
] as const;

export type MergeAction = (typeof MERGE_ACTIONS)[number];

export interface MergeEntry {
  managedKey?: string;
  managed?: boolean;
  managedBaselineHash?: string;
  contentHash?: string;
  type?: string;
  category?: string;
  key?: string;
  text?: string;
  [k: string]: unknown;
}

export interface MergePlanAction {
  managedKey: string;
  action: MergeAction;
  reason?: string;
  current?: MergeEntry;
  desired?: MergeEntry;
}

export interface MergePlan {
  actions: MergePlanAction[];
  counts: Record<string, number>;
}

export interface PlanMergeArgs {
  current: MergeEntry[];
  desired: MergeEntry[];
  mode?: string;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
  return `{${parts.join(",")}}`;
}

function stripMetaForHash(entry: MergeEntry): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const ignore = new Set([
    "id",
    "created",
    "updated",
    "managed",
    "managedKey",
    "managedBaselineHash",
    "contentHash",
    "source",
    "sourceVersion",
    "managedAppliedAt",
    "managedLastSeenVersion",
  ]);

  for (const [k, v] of Object.entries(entry)) {
    if (ignore.has(k)) continue;
    out[k] = v;
  }

  return out;
}

export function computeEntryContentHash(entry: MergeEntry): string {
  const canonical = stripMetaForHash(entry);
  const body = stableStringify(canonical);
  return crypto.createHash("sha256").update(body).digest("hex");
}

function deriveManagedKey(entry: MergeEntry): string {
  const explicit = typeof entry.managedKey === "string" ? entry.managedKey.trim() : "";
  if (explicit) return explicit;

  return buildManagedKey({
    type: typeof entry.type === "string" ? entry.type : "entry",
    category: typeof entry.category === "string" ? entry.category : undefined,
    key: typeof entry.key === "string" ? entry.key : undefined,
    text: typeof entry.text === "string" ? entry.text : undefined,
  });
}

function isManagedEntry(entry: MergeEntry): boolean {
  if (entry.managed === true) return true;
  return typeof entry.managedKey === "string" && entry.managedKey.trim().length > 0;
}

function isUserEditedManagedEntry(entry: MergeEntry): boolean {
  if (!isManagedEntry(entry)) return false;

  const baseline = typeof entry.managedBaselineHash === "string" ? entry.managedBaselineHash.trim() : "";
  if (!baseline) return false;

  const storedCurrent = typeof entry.contentHash === "string" ? entry.contentHash.trim() : "";
  if (storedCurrent) {
    return baseline !== storedCurrent;
  }

  const computedCurrent = computeEntryContentHash(entry);
  return baseline !== computedCurrent;
}

function equivalentUnmanagedEntryExists(current: MergeEntry[], desired: MergeEntry, desiredHash: string): boolean {
  for (const row of current) {
    if (isManagedEntry(row)) continue;
    if (computeEntryContentHash(row) === desiredHash) return true;
  }
  return false;
}

function bump(counts: Record<string, number>, action: MergeAction): void {
  counts[action] = (counts[action] ?? 0) + 1;
}

/**
 * Create a merge/upgrade plan for managed profile entries.
 */
export function planMergeActions(args: PlanMergeArgs): MergePlan {
  const current = Array.isArray(args.current) ? args.current : [];
  const desired = Array.isArray(args.desired) ? args.desired : [];
  const mode = (args.mode ?? "reapply").toLowerCase();

  const currentByKey = new Map<string, MergeEntry>();
  for (const row of current) {
    if (!isManagedEntry(row)) continue;
    const key = deriveManagedKey(row);
    if (!currentByKey.has(key)) {
      currentByKey.set(key, row);
    }
  }

  const desiredByKey = new Map<string, MergeEntry>();
  for (const row of desired) {
    const key = deriveManagedKey(row);
    if (!desiredByKey.has(key)) {
      desiredByKey.set(key, row);
    }
  }

  const actions: MergePlanAction[] = [];
  const counts: Record<string, number> = {};

  // Plan desired entries.
  for (const [managedKey, desiredEntry] of desiredByKey) {
    const currentEntry = currentByKey.get(managedKey);
    const desiredHash = computeEntryContentHash(desiredEntry);

    if (!currentEntry) {
      if (equivalentUnmanagedEntryExists(current, desiredEntry, desiredHash)) {
        const action: MergePlanAction = {
          managedKey,
          action: "SKIP_CONFLICT",
          reason: "semantic-duplicate-unmanaged",
          desired: desiredEntry,
        };
        actions.push(action);
        bump(counts, action.action);
      } else {
        const action: MergePlanAction = {
          managedKey,
          action: "ADD",
          desired: desiredEntry,
        };
        actions.push(action);
        bump(counts, action.action);
      }
      continue;
    }

    if (isUserEditedManagedEntry(currentEntry)) {
      const action: MergePlanAction = {
        managedKey,
        action: "SKIP_USER_EDITED",
        reason: "managed-entry-modified-by-user",
        current: currentEntry,
        desired: desiredEntry,
      };
      actions.push(action);
      bump(counts, action.action);
      continue;
    }

    const currentHash = computeEntryContentHash(currentEntry);
    if (currentHash === desiredHash) {
      const action: MergePlanAction = {
        managedKey,
        action: "NOOP",
        current: currentEntry,
        desired: desiredEntry,
      };
      actions.push(action);
      bump(counts, action.action);
      continue;
    }

    const action: MergePlanAction = {
      managedKey,
      action: "UPDATE",
      reason: mode === "upgrade" ? "version-delta" : "reapply-delta",
      current: currentEntry,
      desired: desiredEntry,
    };
    actions.push(action);
    bump(counts, action.action);
  }

  // Plan deprecations: managed current keys not present in desired.
  for (const [managedKey, currentEntry] of currentByKey) {
    if (desiredByKey.has(managedKey)) continue;

    const action: MergePlanAction = {
      managedKey,
      action: "DEPRECATE",
      reason: mode === "upgrade" ? "removed-in-target-version" : "absent-in-reapply-set",
      current: currentEntry,
    };
    actions.push(action);
    bump(counts, action.action);
  }

  return { actions, counts };
}
