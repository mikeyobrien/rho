/**
 * extensions/rho/bootstrap/engine.ts
 *
 * Profile-pack planning/apply helpers for brain-native bootstrap.
 */

import {
  deterministicId,
  foldBrain,
  type BrainEntry,
  type MaterializedBrain,
} from "../../lib/brain-store.ts";
import { buildManagedKey } from "../../lib/brain-bootstrap-schema.ts";

import {
  planMergeActions,
  computeEntryContentHash,
  type MergeEntry,
  type MergePlan,
  type MergePlanAction,
} from "./merge-policy.ts";
import { getProfilePack } from "./profile-pack.ts";

export interface PlanProfileArgs {
  currentRawEntries: Record<string, unknown>[];
  profileId: string;
  version: string;
  mode?: "run" | "reapply" | "upgrade";
}

export interface PlanProfileResult {
  plan: MergePlan;
  desiredEntries: MergeEntry[];
  currentEntries: MergeEntry[];
}

export interface ApplyProfileArgs {
  currentRawEntries: Record<string, unknown>[];
  plan: MergePlan;
  nowIso: string;
}

export interface ApplyProfileResult {
  nextRawEntries: Record<string, unknown>[];
  appliedActions: MergePlanAction[];
  appliedCounts: Record<string, number>;
}

function flattenMaterialized(brain: MaterializedBrain): MergeEntry[] {
  const out: MergeEntry[] = [];

  out.push(...(brain.behaviors as unknown as MergeEntry[]));
  out.push(...(brain.learnings as unknown as MergeEntry[]));
  out.push(...(brain.preferences as unknown as MergeEntry[]));
  out.push(...(brain.contexts as unknown as MergeEntry[]));
  out.push(...(brain.tasks as unknown as MergeEntry[]));
  out.push(...(brain.reminders as unknown as MergeEntry[]));

  for (const row of brain.identity.values()) out.push(row as unknown as MergeEntry);
  for (const row of brain.user.values()) out.push(row as unknown as MergeEntry);
  for (const row of brain.meta.values()) out.push(row as unknown as MergeEntry);

  return out;
}

export function normalizeCurrentEntries(currentRawEntries: Record<string, unknown>[]): MergeEntry[] {
  const folded = foldBrain(currentRawEntries as unknown as BrainEntry[]);
  return flattenMaterialized(folded);
}

function normalizeManagedDesiredEntry(
  entry: MergeEntry,
  profileId: string,
  version: string,
): MergeEntry {
  const managedKey =
    typeof entry.managedKey === "string" && entry.managedKey.trim()
      ? entry.managedKey.trim()
      : buildManagedKey({
          type: typeof entry.type === "string" ? entry.type : "entry",
          category: typeof entry.category === "string" ? entry.category : undefined,
          key: typeof entry.key === "string" ? entry.key : undefined,
          text: typeof entry.text === "string" ? entry.text : undefined,
        });

  const base: MergeEntry = {
    ...entry,
    managed: true,
    source: `profile:${profileId}`,
    sourceVersion: version,
    managedKey,
  };

  const hash = computeEntryContentHash(base);
  return {
    ...base,
    managedBaselineHash: hash,
    contentHash: hash,
    managedLastSeenVersion: version,
  };
}

export function buildDesiredEntries(profileId: string, version: string): MergeEntry[] {
  const pack = getProfilePack(profileId, version);
  if (!pack) {
    throw new Error(`Unknown profile pack: ${profileId}@${version}`);
  }

  return pack.entries.map((e) => normalizeManagedDesiredEntry(e, profileId, version));
}

export function planProfile(args: PlanProfileArgs): PlanProfileResult {
  const currentEntries = normalizeCurrentEntries(args.currentRawEntries);
  const desiredEntries = buildDesiredEntries(args.profileId, args.version);
  const mode = args.mode ?? "reapply";

  const plan = planMergeActions({
    current: currentEntries,
    desired: desiredEntries,
    mode,
  });

  return { plan, desiredEntries, currentEntries };
}

function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function ensurePersistableEntry(entry: MergeEntry, nowIso: string): Record<string, unknown> {
  const type = typeof entry.type === "string" && entry.type ? entry.type : "context";
  const managedKey =
    typeof entry.managedKey === "string" && entry.managedKey.trim()
      ? entry.managedKey.trim()
      : buildManagedKey({
          type,
          category: typeof entry.category === "string" ? entry.category : undefined,
          key: typeof entry.key === "string" ? entry.key : undefined,
          text: typeof entry.text === "string" ? entry.text : undefined,
        });

  const id = deterministicId(type, `managed:${managedKey}`);

  const base: Record<string, unknown> = {
    ...entry,
    id,
    type,
    created: nowIso,
    managedKey,
  };

  // Keep content hash in sync with semantic payload.
  const contentHash = computeEntryContentHash(base as MergeEntry);
  base.contentHash = contentHash;
  if (typeof base.managedBaselineHash !== "string" || !String(base.managedBaselineHash).trim()) {
    base.managedBaselineHash = contentHash;
  }

  return base;
}

export function applyProfilePlan(args: ApplyProfileArgs): ApplyProfileResult {
  const nextRawEntries = [...args.currentRawEntries.map((e) => ({ ...e }))];
  const appliedActions: MergePlanAction[] = [];
  const appliedCounts: Record<string, number> = {};

  for (const action of args.plan.actions) {
    if (action.action === "ADD" || action.action === "UPDATE") {
      if (!action.desired) continue;
      const row = ensurePersistableEntry(action.desired, args.nowIso);
      nextRawEntries.push(row);
      appliedActions.push(action);
      bump(appliedCounts, action.action);
      continue;
    }

    // Non-mutating actions are still useful for reporting.
    appliedActions.push(action);
    bump(appliedCounts, action.action);
  }

  return {
    nextRawEntries,
    appliedActions,
    appliedCounts,
  };
}
