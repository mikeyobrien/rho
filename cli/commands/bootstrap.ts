/**
 * rho bootstrap
 *
 * Brain-native bootstrap lifecycle commands.
 *
 * BT-04 scope: command surface + status/audit/reset safety + basic run wiring.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { createInterface } from "node:readline/promises";

import { BRAIN_PATH, readBrain, deterministicId } from "../../extensions/lib/brain-store.ts";
import {
  BOOTSTRAP_META_KEYS,
  PERSONAL_ASSISTANT_PROFILE_ID,
} from "../../extensions/lib/brain-bootstrap-schema.ts";
import { getBootstrapState, markBootstrapCompleted } from "../../extensions/lib/brain-bootstrap-state.ts";
import { planProfile, applyProfilePlan } from "../../extensions/rho/bootstrap/engine.ts";
import { getLatestProfileVersion, getProfilePack } from "../../extensions/rho/bootstrap/profile-pack.ts";
import {
  validateOnboardingAnswers,
  shouldMarkBootstrapComplete,
} from "../../extensions/rho/bootstrap/onboarding.ts";
import { mapOnboardingAnswersToEntries } from "../../extensions/rho/bootstrap/mapping.ts";

const HOME = process.env.HOME || os.homedir();
const RHO_DIR = path.join(HOME, ".rho");
const LOG_DIR = path.join(RHO_DIR, "logs");
const AUDIT_PATH = process.env.RHO_BOOTSTRAP_AUDIT_PATH || path.join(LOG_DIR, "bootstrap-events.jsonl");

const DEFAULT_PROFILE = PERSONAL_ASSISTANT_PROFILE_ID;
const DEFAULT_VERSION = getLatestProfileVersion(DEFAULT_PROFILE) ?? "pa-v1";
const RESET_CONFIRM_TOKEN = "RESET_BOOTSTRAP";

interface AuditEvent {
  eventId: string;
  ts: string;
  op: string;
  phase: "start" | "plan" | "apply" | "complete" | "fail";
  profileId?: string;
  fromVersion?: string | null;
  toVersion?: string | null;
  counts?: Record<string, number>;
  result?: "ok" | "warning" | "error";
  errorCode?: string;
  message?: string;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function getOption(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  if (idx < 0) return undefined;
  if (idx + 1 >= args.length) return undefined;
  const value = args[idx + 1];
  if (value.startsWith("--")) return undefined;
  return value;
}

function nowIso(): string {
  return new Date().toISOString();
}

function makeEventId(): string {
  const rand = crypto.randomBytes(4).toString("hex");
  return `bevt_${Date.now()}_${rand}`;
}

function appendAudit(event: Omit<AuditEvent, "eventId" | "ts">): void {
  const full: AuditEvent = {
    eventId: makeEventId(),
    ts: nowIso(),
    ...event,
  };
  fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true });
  fs.appendFileSync(AUDIT_PATH, JSON.stringify(full) + "\n", "utf-8");
}

function readAuditEvents(limit = 50): AuditEvent[] {
  if (!fs.existsSync(AUDIT_PATH)) return [];
  const raw = fs.readFileSync(AUDIT_PATH, "utf-8");
  if (!raw.trim()) return [];

  const rows: AuditEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as AuditEvent);
    } catch {
      // ignore malformed log lines
    }
  }

  if (limit <= 0) return rows;
  return rows.slice(-limit);
}

function readBrainEntries(): Record<string, unknown>[] {
  const { entries } = readBrain(BRAIN_PATH);
  return entries as Record<string, unknown>[];
}

function writeBrainEntries(entries: Record<string, unknown>[]): void {
  fs.mkdirSync(path.dirname(BRAIN_PATH), { recursive: true });
  if (entries.length === 0) {
    fs.writeFileSync(BRAIN_PATH, "", "utf-8");
    return;
  }
  const body = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  fs.writeFileSync(BRAIN_PATH, body, "utf-8");
}

function getLastTerminalEvent(events: AuditEvent[]): AuditEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.phase === "complete" || e.phase === "fail") return e;
  }
  return null;
}

function zeroPlanCounts(): Record<string, number> {
  return {
    ADD: 0,
    UPDATE: 0,
    NOOP: 0,
    SKIP_USER_EDITED: 0,
    SKIP_CONFLICT: 0,
    DEPRECATE: 0,
  };
}

function normalizePlanCounts(counts?: Record<string, number>): Record<string, number> {
  return {
    ...zeroPlanCounts(),
    ...(counts ?? {}),
  };
}

function resolveVersionForOperation(explicit?: string, fallback?: string): string {
  if (explicit && explicit.trim()) return explicit.trim();
  if (fallback && fallback.trim()) return fallback.trim();
  return DEFAULT_VERSION;
}

function assertKnownPackOrThrow(version: string): void {
  const pack = getProfilePack(DEFAULT_PROFILE, version);
  if (!pack) {
    throw new Error(`Unknown profile pack version: ${DEFAULT_PROFILE}@${version}`);
  }
}

function getLatestUserValue(entries: Record<string, unknown>[], key: string): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === "user" && e.key === key && typeof e.value === "string" && e.value.trim()) {
      return e.value.trim();
    }
  }
  return undefined;
}

function defaultTimezone(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (typeof tz === "string" && tz.trim()) return tz.trim();
  } catch {
    // ignore
  }
  return "UTC";
}

function parseBooleanOption(args: string[], yesFlag: string, noFlag: string): boolean | undefined {
  if (hasFlag(args, yesFlag)) return true;
  if (hasFlag(args, noFlag)) return false;
  return undefined;
}

function baseOnboardingAnswers(
  args: string[],
  existingEntries: Record<string, unknown>[],
): Record<string, unknown> {
  const existingName = getLatestUserValue(existingEntries, "name");
  const existingTimezone = getLatestUserValue(existingEntries, "timezone");

  const name = getOption(args, "--name") ?? existingName ?? "User";
  const timezone = getOption(args, "--timezone") ?? existingTimezone ?? defaultTimezone();
  const style = getOption(args, "--style") ?? "balanced";
  const externalActionPolicy = getOption(args, "--external-action-policy") ?? "ask-risky-only";
  const codingTaskFirst = parseBooleanOption(args, "--coding-task-first", "--no-coding-task-first") ?? false;
  const quietHours = getOption(args, "--quiet-hours");
  const proactiveCadence = getOption(args, "--proactive-cadence") ?? "off";

  return {
    name,
    timezone,
    style,
    externalActionPolicy,
    codingTaskFirst,
    quietHours,
    proactiveCadence,
  };
}

function isInteractivePromptAllowed(args: string[]): boolean {
  if (hasFlag(args, "--non-interactive")) return false;
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function normalizeAnswer(value: string, fallback: string): string {
  const v = value.trim();
  return v ? v : fallback;
}

async function maybePromptOnboardingAnswers(
  args: string[],
  initial: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (!isInteractivePromptAllowed(args)) {
    return initial;
  }

  const defaults = {
    name: typeof initial.name === "string" ? initial.name : "User",
    timezone: typeof initial.timezone === "string" ? initial.timezone : defaultTimezone(),
    style: typeof initial.style === "string" ? initial.style : "balanced",
    externalActionPolicy:
      typeof initial.externalActionPolicy === "string" ? initial.externalActionPolicy : "ask-risky-only",
    codingTaskFirst: typeof initial.codingTaskFirst === "boolean" ? initial.codingTaskFirst : false,
    quietHours: typeof initial.quietHours === "string" ? initial.quietHours : "",
    proactiveCadence: typeof initial.proactiveCadence === "string" ? initial.proactiveCadence : "off",
  };

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const name = normalizeAnswer(
      await rl.question(`What should I call you? [${defaults.name}] `),
      defaults.name,
    );

    const timezone = normalizeAnswer(
      await rl.question(`Timezone (IANA)? [${defaults.timezone}] `),
      defaults.timezone,
    );

    const style = normalizeAnswer(
      await rl.question(`Response style (concise|balanced|detailed) [${defaults.style}] `),
      defaults.style,
    );

    const externalActionPolicy = normalizeAnswer(
      await rl.question(`External action policy (always-ask|ask-risky-only) [${defaults.externalActionPolicy}] `),
      defaults.externalActionPolicy,
    );

    const codingRaw = normalizeAnswer(
      await rl.question(`Require code-task proposal before implementation? (yes|no) [${defaults.codingTaskFirst ? "yes" : "no"}] `),
      defaults.codingTaskFirst ? "yes" : "no",
    ).toLowerCase();

    const quietHoursRaw = await rl.question(
      `Quiet hours (HH:mm-HH:mm, blank to skip) [${defaults.quietHours}] `,
    );

    const cadence = normalizeAnswer(
      await rl.question(`Proactive cadence (off|light|standard) [${defaults.proactiveCadence}] `),
      defaults.proactiveCadence,
    );

    return {
      name,
      timezone,
      style,
      externalActionPolicy,
      codingTaskFirst: codingRaw === "yes" || codingRaw === "y" || codingRaw === "true",
      quietHours: quietHoursRaw.trim() || defaults.quietHours || undefined,
      proactiveCadence: cadence,
    };
  } finally {
    rl.close();
  }
}

function materializeOnboardingEntries(
  mapped: Record<string, Array<Record<string, unknown>>>,
  now: string,
  version: string,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];

  const allDrafts = [
    ...(mapped.user ?? []),
    ...(mapped.preference ?? []),
    ...(mapped.context ?? []),
    ...(mapped.behavior ?? []),
    ...(mapped.reminder ?? []),
  ];

  for (let i = 0; i < allDrafts.length; i++) {
    const draft = allDrafts[i];
    const type = typeof draft.type === "string" ? draft.type : "context";

    const naturalKey =
      (typeof draft.key === "string" && draft.key) ||
      (typeof draft.path === "string" && draft.path) ||
      (typeof draft.text === "string" && draft.text) ||
      `${type}:${i}`;

    const id = deterministicId(type, `onboarding:${naturalKey}`);

    const base: Record<string, unknown> = {
      id,
      type,
      created: now,
      source: "onboarding",
      sourceVersion: version,
    };

    if (type === "user") {
      out.push({
        ...base,
        key: typeof draft.key === "string" ? draft.key : `onboarding.${i}`,
        value: draft.value ?? "",
      });
      continue;
    }

    if (type === "preference") {
      out.push({
        ...base,
        category: typeof draft.category === "string" ? draft.category : "general",
        text: typeof draft.text === "string" ? draft.text : `${draft.key ?? `preference.${i}`}`,
        key: draft.key,
        value: draft.value,
      });
      continue;
    }

    if (type === "context") {
      const project = typeof draft.project === "string" ? draft.project : "rho";
      const cpath = typeof draft.path === "string" ? draft.path : `bootstrap/${draft.key ?? i}`;
      const content =
        typeof draft.content === "string"
          ? draft.content
          : typeof draft.value === "string"
            ? draft.value
            : typeof draft.text === "string"
              ? draft.text
              : "";

      out.push({
        ...base,
        project,
        path: cpath,
        content,
        key: draft.key,
        value: draft.value,
        text: draft.text,
      });
      continue;
    }

    if (type === "behavior") {
      out.push({
        ...base,
        category: typeof draft.category === "string" ? draft.category : "do",
        text: typeof draft.text === "string" ? draft.text : "",
      });
      continue;
    }

    if (type === "reminder") {
      const cadence =
        draft.value && typeof draft.value === "object"
          ? draft.value
          : { kind: "daily", at: "09:00" };

      out.push({
        ...base,
        text: typeof draft.text === "string" ? draft.text : "Reminder",
        enabled: true,
        cadence,
        priority: "normal",
        tags: [],
        last_run: null,
        next_due: null,
        last_result: null,
        last_error: null,
      });
      continue;
    }
  }

  return out;
}

function countManagedEntries(entries: Record<string, unknown>[]): number {
  let count = 0;
  for (const e of entries) {
    if (e.managed === true) count++;
  }
  return count;
}

function buildStatusPayload(): Record<string, unknown> {
  const entries = readBrainEntries();
  const state = getBootstrapState(entries);
  const events = readAuditEvents(100);
  const last = getLastTerminalEvent(events);

  return {
    ok: true,
    status: state.status,
    profile: DEFAULT_PROFILE,
    version: state.version ?? null,
    completedAt: state.completedAt ?? null,
    managedCount: countManagedEntries(entries),
    lastResult: last?.result ?? null,
    lastOperation: last?.op ?? null,
    lastOperationAt: last?.ts ?? null,
  };
}

function printHelp(): void {
  console.log(`rho bootstrap

Manage brain-native bootstrap lifecycle.

Usage:
  rho bootstrap status [--json]
  rho bootstrap run [--force] [--to pa-v1] [--name NAME] [--timezone TZ] [--style concise|balanced|detailed]
                     [--external-action-policy always-ask|ask-risky-only] [--coding-task-first|--no-coding-task-first]
                     [--quiet-hours HH:mm-HH:mm] [--proactive-cadence off|light|standard] [--non-interactive] [--json]
  rho bootstrap reapply [--to pa-v1] [--dry-run] [--json]
  rho bootstrap upgrade --to pa-v2 [--dry-run] [--json]
  rho bootstrap diff [--to pa-v2] [--json]
  rho bootstrap reset --confirm ${RESET_CONFIRM_TOKEN} [--purge-managed] [--json]
  rho bootstrap audit [--limit N] [--json]

Options:
  --json       Output machine-readable JSON
  -h, --help   Show this help`);
}

function printStatus(jsonMode: boolean): void {
  const payload = buildStatusPayload();
  if (jsonMode) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`Bootstrap status: ${payload.status}`);
  console.log(`Profile: ${payload.profile}`);
  console.log(`Version: ${payload.version ?? "(none)"}`);
  if (payload.completedAt) console.log(`Completed at: ${payload.completedAt}`);
  if (payload.lastOperation) {
    console.log(`Last op: ${payload.lastOperation} (${payload.lastResult ?? "unknown"}) at ${payload.lastOperationAt}`);
  }
}

async function runBootstrap(args: string[]): Promise<void> {
  const jsonMode = hasFlag(args, "--json");
  const force = hasFlag(args, "--force");

  const current = readBrainEntries();
  const state = getBootstrapState(current);
  const version = resolveVersionForOperation(getOption(args, "--to"), state.version ?? undefined);

  try {
    assertKnownPackOrThrow(version);
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    console.error(msg);
    process.exitCode = 1;
    appendAudit({
      op: "run",
      phase: "fail",
      profileId: DEFAULT_PROFILE,
      toVersion: version,
      result: "error",
      errorCode: "BOOTSTRAP_PROFILE_NOT_FOUND",
      message: msg,
    });
    return;
  }

  appendAudit({
    op: "run",
    phase: "start",
    profileId: DEFAULT_PROFILE,
    fromVersion: state.version ?? null,
    toVersion: version,
    result: "ok",
  });

  if (state.status === "completed" && !force) {
    const payload = {
      ok: true,
      message: `Bootstrap already completed at version ${state.version ?? "unknown"}.`,
      status: state.status,
      version: state.version ?? null,
      planCounts: normalizePlanCounts({ NOOP: 1 }),
    };

    appendAudit({
      op: "run",
      phase: "complete",
      profileId: DEFAULT_PROFILE,
      fromVersion: state.version ?? null,
      toVersion: state.version ?? null,
      counts: payload.planCounts,
      result: "ok",
      message: "already-completed",
    });

    if (jsonMode) console.log(JSON.stringify(payload, null, 2));
    else console.log(payload.message);
    return;
  }

  const onboardingBase = baseOnboardingAnswers(args, current);
  const onboardingAnswers = await maybePromptOnboardingAnswers(args, onboardingBase);
  const onboardingValidation = validateOnboardingAnswers(onboardingAnswers);

  if (!onboardingValidation.ok) {
    const msg = `Invalid onboarding answers: ${onboardingValidation.errors.join("; ")}`;
    console.error(msg);
    process.exitCode = 1;
    appendAudit({
      op: "run",
      phase: "fail",
      profileId: DEFAULT_PROFILE,
      fromVersion: state.version ?? null,
      toVersion: version,
      result: "error",
      errorCode: "BOOTSTRAP_INVALID_ONBOARDING",
      message: msg,
    });
    return;
  }

  const planned = planProfile({
    currentRawEntries: current,
    profileId: DEFAULT_PROFILE,
    version,
    mode: state.status === "completed" ? "reapply" : "run",
  });

  appendAudit({
    op: "run",
    phase: "plan",
    profileId: DEFAULT_PROFILE,
    fromVersion: state.version ?? null,
    toVersion: version,
    counts: normalizePlanCounts(planned.plan.counts),
    result: "ok",
  });

  const now = nowIso();
  const applied = applyProfilePlan({
    currentRawEntries: current,
    plan: planned.plan,
    nowIso: now,
  });

  const mappedOnboarding = mapOnboardingAnswersToEntries(onboardingAnswers);
  const onboardingEntries = materializeOnboardingEntries(mappedOnboarding as Record<string, Array<Record<string, unknown>>>, now, version);

  let nextEntries = [...applied.nextRawEntries, ...onboardingEntries];
  if (shouldMarkBootstrapComplete("applied")) {
    nextEntries = markBootstrapCompleted(nextEntries, version, now);
  }

  writeBrainEntries(nextEntries);

  const nextState = getBootstrapState(nextEntries);
  const payload = {
    ok: true,
    message: "Bootstrap applied and marked as completed.",
    status: nextState.status,
    version: nextState.version ?? null,
    completedAt: nextState.completedAt ?? null,
    onboardingApplied: onboardingEntries.length,
    planCounts: normalizePlanCounts(planned.plan.counts),
    appliedCounts: normalizePlanCounts(applied.appliedCounts),
  };

  appendAudit({
    op: "run",
    phase: "complete",
    profileId: DEFAULT_PROFILE,
    fromVersion: state.version ?? null,
    toVersion: nextState.version ?? null,
    counts: {
      ...payload.appliedCounts,
      ONBOARDING: onboardingEntries.length,
    },
    result: "ok",
  });

  if (jsonMode) console.log(JSON.stringify(payload, null, 2));
  else console.log(payload.message);
}

function runReapply(args: string[]): void {
  const jsonMode = hasFlag(args, "--json");
  const dryRun = hasFlag(args, "--dry-run");

  const current = readBrainEntries();
  const state = getBootstrapState(current);
  const version = resolveVersionForOperation(getOption(args, "--to"), state.version ?? undefined);

  try {
    assertKnownPackOrThrow(version);
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    console.error(msg);
    process.exitCode = 1;
    appendAudit({
      op: "reapply",
      phase: "fail",
      profileId: DEFAULT_PROFILE,
      toVersion: version,
      result: "error",
      errorCode: "BOOTSTRAP_PROFILE_NOT_FOUND",
      message: msg,
    });
    return;
  }

  appendAudit({
    op: "reapply",
    phase: "start",
    profileId: DEFAULT_PROFILE,
    fromVersion: state.version ?? null,
    toVersion: version,
    result: "ok",
  });

  const planned = planProfile({
    currentRawEntries: current,
    profileId: DEFAULT_PROFILE,
    version,
    mode: "reapply",
  });

  const planCounts = normalizePlanCounts(planned.plan.counts);

  appendAudit({
    op: "reapply",
    phase: "plan",
    profileId: DEFAULT_PROFILE,
    fromVersion: state.version ?? null,
    toVersion: version,
    counts: planCounts,
    result: "ok",
  });

  if (dryRun) {
    const payload = {
      ok: true,
      status: "planned",
      profile: DEFAULT_PROFILE,
      version,
      dryRun: true,
      planCounts,
      actions: planned.plan.actions,
    };

    appendAudit({
      op: "reapply",
      phase: "complete",
      profileId: DEFAULT_PROFILE,
      fromVersion: state.version ?? null,
      toVersion: version,
      counts: planCounts,
      result: "ok",
      message: "dry-run",
    });

    if (jsonMode) console.log(JSON.stringify(payload, null, 2));
    else console.log("Reapply dry-run complete.");
    return;
  }

  const now = nowIso();
  const applied = applyProfilePlan({
    currentRawEntries: current,
    plan: planned.plan,
    nowIso: now,
  });

  const withMeta = markBootstrapCompleted(applied.nextRawEntries, version, now);
  writeBrainEntries(withMeta);

  const nextState = getBootstrapState(withMeta);
  const appliedCounts = normalizePlanCounts(applied.appliedCounts);

  const payload = {
    ok: true,
    status: nextState.status,
    profile: DEFAULT_PROFILE,
    version: nextState.version ?? null,
    completedAt: nextState.completedAt ?? null,
    dryRun: false,
    planCounts,
    appliedCounts,
  };

  appendAudit({
    op: "reapply",
    phase: "complete",
    profileId: DEFAULT_PROFILE,
    fromVersion: state.version ?? null,
    toVersion: nextState.version ?? null,
    counts: appliedCounts,
    result: "ok",
  });

  if (jsonMode) console.log(JSON.stringify(payload, null, 2));
  else console.log("Reapply complete.");
}

function runUpgrade(args: string[]): void {
  const jsonMode = hasFlag(args, "--json");
  const toVersion = getOption(args, "--to");
  const dryRun = hasFlag(args, "--dry-run");

  if (!toVersion) {
    const msg = "Missing required option: --to <version>";
    console.error(msg);
    process.exitCode = 1;
    return;
  }

  try {
    assertKnownPackOrThrow(toVersion);
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    console.error(msg);
    process.exitCode = 1;
    appendAudit({
      op: "upgrade",
      phase: "fail",
      profileId: DEFAULT_PROFILE,
      toVersion,
      result: "error",
      errorCode: "BOOTSTRAP_PROFILE_NOT_FOUND",
      message: msg,
    });
    return;
  }

  const current = readBrainEntries();
  const state = getBootstrapState(current);

  appendAudit({
    op: "upgrade",
    phase: "start",
    profileId: DEFAULT_PROFILE,
    fromVersion: state.version ?? null,
    toVersion,
    result: "ok",
  });

  const planned = planProfile({
    currentRawEntries: current,
    profileId: DEFAULT_PROFILE,
    version: toVersion,
    mode: "upgrade",
  });

  const planCounts = normalizePlanCounts(planned.plan.counts);

  appendAudit({
    op: "upgrade",
    phase: "plan",
    profileId: DEFAULT_PROFILE,
    fromVersion: state.version ?? null,
    toVersion,
    counts: planCounts,
    result: "ok",
  });

  if (dryRun) {
    const payload = {
      ok: true,
      status: "planned",
      profile: DEFAULT_PROFILE,
      fromVersion: state.version ?? null,
      toVersion,
      dryRun: true,
      planCounts,
      actions: planned.plan.actions,
    };

    appendAudit({
      op: "upgrade",
      phase: "complete",
      profileId: DEFAULT_PROFILE,
      fromVersion: state.version ?? null,
      toVersion,
      counts: planCounts,
      result: "ok",
      message: "dry-run",
    });

    if (jsonMode) console.log(JSON.stringify(payload, null, 2));
    else console.log("Upgrade dry-run complete.");
    return;
  }

  const now = nowIso();
  const applied = applyProfilePlan({
    currentRawEntries: current,
    plan: planned.plan,
    nowIso: now,
  });

  const withMeta = markBootstrapCompleted(applied.nextRawEntries, toVersion, now);
  writeBrainEntries(withMeta);

  const nextState = getBootstrapState(withMeta);
  const appliedCounts = normalizePlanCounts(applied.appliedCounts);

  const payload = {
    ok: true,
    status: nextState.status,
    profile: DEFAULT_PROFILE,
    fromVersion: state.version ?? null,
    toVersion: nextState.version ?? null,
    completedAt: nextState.completedAt ?? null,
    dryRun: false,
    planCounts,
    appliedCounts,
  };

  appendAudit({
    op: "upgrade",
    phase: "complete",
    profileId: DEFAULT_PROFILE,
    fromVersion: state.version ?? null,
    toVersion: nextState.version ?? null,
    counts: appliedCounts,
    result: "ok",
  });

  if (jsonMode) console.log(JSON.stringify(payload, null, 2));
  else console.log(`Upgrade complete: ${state.version ?? "(none)"} -> ${nextState.version ?? "(none)"}`);
}

function runDiff(args: string[]): void {
  const jsonMode = hasFlag(args, "--json");

  const current = readBrainEntries();
  const state = getBootstrapState(current);
  const toVersion = resolveVersionForOperation(getOption(args, "--to"), state.version ?? undefined);

  try {
    assertKnownPackOrThrow(toVersion);
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    console.error(msg);
    process.exitCode = 1;
    return;
  }

  const mode = state.version && state.version !== toVersion ? "upgrade" : "reapply";
  const planned = planProfile({
    currentRawEntries: current,
    profileId: DEFAULT_PROFILE,
    version: toVersion,
    mode,
  });

  const payload = {
    ok: true,
    profile: DEFAULT_PROFILE,
    fromVersion: state.version ?? null,
    toVersion,
    mode,
    planCounts: normalizePlanCounts(planned.plan.counts),
    actions: planned.plan.actions,
  };

  if (jsonMode) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`Diff target version: ${toVersion}`);
  console.log(`Mode: ${mode}`);
  console.log(`Actions: ${planned.plan.actions.length}`);
}

function runReset(args: string[]): void {
  const jsonMode = hasFlag(args, "--json");
  const confirm = getOption(args, "--confirm");
  const purgeManaged = hasFlag(args, "--purge-managed");

  if (confirm !== RESET_CONFIRM_TOKEN) {
    const msg = `Confirmation required. Re-run with: --confirm ${RESET_CONFIRM_TOKEN}`;
    console.error(msg);
    process.exitCode = 1;
    appendAudit({
      op: "reset",
      phase: "fail",
      profileId: DEFAULT_PROFILE,
      result: "error",
      errorCode: "BOOTSTRAP_CONFIRM_REQUIRED",
      message: msg,
    });
    return;
  }

  appendAudit({
    op: "reset",
    phase: "start",
    profileId: DEFAULT_PROFILE,
    result: "ok",
  });

  const current = readBrainEntries();
  const before = current.length;

  const filtered = current.filter((entry) => {
    if (entry.type === "meta" && typeof entry.key === "string") {
      if (
        entry.key === BOOTSTRAP_META_KEYS.completed ||
        entry.key === BOOTSTRAP_META_KEYS.version ||
        entry.key === BOOTSTRAP_META_KEYS.completedAt
      ) {
        return false;
      }
    }

    if (purgeManaged) {
      if (entry.managed === true) return false;
      if (typeof entry.source === "string" && entry.source.startsWith("profile:")) return false;
    }

    return true;
  });

  writeBrainEntries(filtered);

  const removed = before - filtered.length;
  const payload = {
    ok: true,
    removed,
    purgeManaged,
    status: getBootstrapState(filtered).status,
    message: `Bootstrap reset complete (${removed} entries removed).`,
  };

  appendAudit({
    op: "reset",
    phase: "complete",
    profileId: DEFAULT_PROFILE,
    counts: { removed },
    result: "ok",
  });

  if (jsonMode) console.log(JSON.stringify(payload, null, 2));
  else console.log(payload.message);
}

function runAudit(args: string[]): void {
  const jsonMode = hasFlag(args, "--json");
  const limitRaw = getOption(args, "--limit");
  const limit = limitRaw ? Math.max(0, Number.parseInt(limitRaw, 10) || 0) : 50;

  const events = readAuditEvents(limit);
  if (jsonMode) {
    console.log(JSON.stringify({ ok: true, events }, null, 2));
    return;
  }

  if (events.length === 0) {
    console.log("No bootstrap audit events.");
    return;
  }

  console.log(`Bootstrap audit events (${events.length}):`);
  for (const e of events) {
    console.log(`- ${e.ts} ${e.op}.${e.phase} ${e.result ?? ""}`.trim());
  }
}

export async function run(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const command = (sub || "status").toLowerCase();

  if (command === "--help" || command === "-h" || command === "help") {
    printHelp();
    return;
  }

  if (command === "status") {
    printStatus(hasFlag(rest, "--json"));
    return;
  }

  if (command === "run") {
    await runBootstrap(rest);
    return;
  }

  if (command === "reapply") {
    runReapply(rest);
    return;
  }

  if (command === "upgrade") {
    runUpgrade(rest);
    return;
  }

  if (command === "diff") {
    runDiff(rest);
    return;
  }

  if (command === "reset") {
    runReset(rest);
    return;
  }

  if (command === "audit") {
    runAudit(rest);
    return;
  }

  console.error(`Unknown bootstrap subcommand: ${command}`);
  process.exitCode = 1;
}
