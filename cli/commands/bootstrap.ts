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

import { BRAIN_PATH, readBrain, deterministicId } from "../../extensions/lib/brain-store.ts";
import {
  BOOTSTRAP_META_KEYS,
  AGENTIC_BOOTSTRAP_ID,
} from "../../extensions/lib/brain-bootstrap-schema.ts";
import { getBootstrapState } from "../../extensions/lib/brain-bootstrap-state.ts";

const HOME = process.env.HOME || os.homedir();
const RHO_DIR = path.join(HOME, ".rho");
const LOG_DIR = path.join(RHO_DIR, "logs");
const AUDIT_PATH = process.env.RHO_BOOTSTRAP_AUDIT_PATH || path.join(LOG_DIR, "bootstrap-events.jsonl");

const BOOTSTRAP_ID = AGENTIC_BOOTSTRAP_ID;
const AGENTIC_BOOTSTRAP_VERSION = "agentic-v1";
const AGENTIC_BOOTSTRAP_SEED_PATH = "bootstrap/agentic.seed";
const RESET_CONFIRM_TOKEN = "RESET_BOOTSTRAP";

interface AuditEvent {
  eventId: string;
  ts: string;
  op: string;
  phase: "start" | "plan" | "apply" | "complete" | "fail";
  bootstrapId?: string;
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

function upsertKeyedEntry(
  entries: Record<string, unknown>[],
  type: string,
  naturalKey: string,
  row: Record<string, unknown>,
): Record<string, unknown>[] {
  const id = deterministicId(type, naturalKey);
  const next = entries.map((e) => ({ ...e }));
  const idx = next.findIndex((e) => e.id === id || (e.type === type && (type === "context" ? e.path === naturalKey : e.key === naturalKey)));
  const normalized: Record<string, unknown> = {
    id,
    type,
    ...row,
  };

  if (idx >= 0) next[idx] = { ...next[idx], ...normalized };
  else next.push(normalized);

  return next;
}

function upsertMetaEntry(
  entries: Record<string, unknown>[],
  key: string,
  value: unknown,
  now: string,
): Record<string, unknown>[] {
  return upsertKeyedEntry(entries, "meta", key, {
    key,
    value,
    created: now,
  });
}

function upsertContextEntry(
  entries: Record<string, unknown>[],
  args: {
    path: string;
    project?: string;
    content: string;
    key?: string;
    value?: unknown;
    text?: string;
    source?: string;
    sourceVersion?: string;
    managed?: boolean;
  },
  now: string,
): Record<string, unknown>[] {
  return upsertKeyedEntry(entries, "context", args.path, {
    project: args.project ?? "rho",
    path: args.path,
    content: args.content,
    key: args.key,
    value: args.value,
    text: args.text,
    source: args.source,
    sourceVersion: args.sourceVersion,
    managed: args.managed,
    created: now,
  });
}

function getLatestMetaValue(entries: Record<string, unknown>[], key: string): unknown {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === "meta" && e.key === key) return e.value;
  }
  return undefined;
}

function parseMetaBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "true" || v === "1" || v === "yes" || v === "on") return true;
    if (v === "false" || v === "0" || v === "no" || v === "off") return false;
  }
  return false;
}

const AGENTIC_BOOTSTRAP_PROMPT = [
  "You just woke up. Time to figure out who you are.",
  "There is no memory yet. This is normal.",
  "",
  "The conversation:",
  "- Don't interrogate. Don't be robotic. Just talk.",
  "- Open with: I’m online with a fresh context. Help me set my starter identity: name, vibe, and how you want me to work with you.",
  "- Discover together: a starter identity (name and vibe).",
  "- Identity develops over time from interactions — don't force a fixed mode during bootstrap.",
  "- Then capture user details: name, address preference, timezone.",
  "- Then discuss values/boundaries and store as behavior/preference.",
  "",
  "Persist outcomes in rho memory categories (behavior/identity/user/learning/preference).",
  "When complete, set meta keys:",
  "- bootstrap.phase = completed",
  "- bootstrap.inject = off",
  "- bootstrap.completed = true",
  "- bootstrap.completedAt = <UTC ISO>",
].join("\n");

function activateAgenticBootstrap(
  current: Record<string, unknown>[],
  now: string,
  opts?: { resetPhase?: boolean },
): Record<string, unknown>[] {
  let next = current.map((e) => ({ ...e }));
  const existingPhaseRaw = getLatestMetaValue(next, "bootstrap.phase");
  const existingPhase = typeof existingPhaseRaw === "string" ? existingPhaseRaw.trim() : "";
  const nextPhase = opts?.resetPhase ? "identity_discovery" : (existingPhase || "identity_discovery");

  next = upsertMetaEntry(next, BOOTSTRAP_META_KEYS.completed, false, now);
  next = upsertMetaEntry(next, BOOTSTRAP_META_KEYS.version, AGENTIC_BOOTSTRAP_VERSION, now);
  next = upsertMetaEntry(next, "bootstrap.mode", "agentic", now);
  next = upsertMetaEntry(next, "bootstrap.phase", nextPhase, now);
  next = upsertMetaEntry(next, "bootstrap.inject", "on", now);
  next = upsertMetaEntry(next, "bootstrap.lastActivatedAt", now, now);

  if (getLatestMetaValue(next, "bootstrap.startedAt") === undefined) {
    next = upsertMetaEntry(next, "bootstrap.startedAt", now, now);
  }

  next = upsertContextEntry(
    next,
    {
      project: "rho",
      path: AGENTIC_BOOTSTRAP_SEED_PATH,
      key: "bootstrap.seedPrompt",
      value: "agentic",
      text: "bootstrap mission: identity + user + behavior/preference alignment",
      content: AGENTIC_BOOTSTRAP_PROMPT,
      source: "bootstrap",
      sourceVersion: AGENTIC_BOOTSTRAP_VERSION,
      managed: true,
    },
    now,
  );

  return next;
}

function getLastTerminalEvent(events: AuditEvent[]): AuditEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.phase === "complete" || e.phase === "fail") return e;
  }
  return null;
}

function clipText(value: string, max = 72): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 1)}…`;
}

function managedEntrySummary(entry: Record<string, unknown>): string {
  const type = typeof entry.type === "string" ? entry.type : "unknown";
  const key = typeof entry.key === "string" ? entry.key.trim() : "";
  const pathValue = typeof entry.path === "string" ? entry.path.trim() : "";
  const category = typeof entry.category === "string" ? entry.category.trim() : "";
  const text = typeof entry.text === "string" ? clipText(entry.text) : "";
  const description = typeof entry.description === "string" ? clipText(entry.description) : "";

  if ((type === "meta" || type === "identity" || type === "user") && key) return `${type}:${key}`;
  if (type === "context" && pathValue) return `context:${pathValue}`;
  if (key) return `${type}:${key}`;
  if (pathValue) return `${type}:${pathValue}`;

  if (type === "behavior") {
    if (category && text) return `behavior:${category} ${text}`;
    if (text) return `behavior:${text}`;
  }

  if (type === "preference" && text) {
    if (category) return `preference:${category} ${text}`;
    return `preference:${text}`;
  }

  if ((type === "task" || type === "learning" || type === "reminder") && (text || description)) {
    return `${type}:${text || description}`;
  }

  return type;
}

const BOOTSTRAP_EXPOSED_TYPES = new Set(["behavior", "identity", "user", "learning", "preference"]);

function listManagedEntries(entries: Record<string, unknown>[]): string[] {
  const out: string[] = [];
  for (const e of entries) {
    const type = typeof e.type === "string" ? e.type : "";
    if (e.managed === true && BOOTSTRAP_EXPOSED_TYPES.has(type)) {
      out.push(managedEntrySummary(e));
    }
  }
  return out;
}

function buildStatusPayload(): Record<string, unknown> {
  const entries = readBrainEntries();
  const state = getBootstrapState(entries);
  const events = readAuditEvents(100);
  const last = getLastTerminalEvent(events);
  const managedEntries = listManagedEntries(entries);

  const modeRaw = getLatestMetaValue(entries, "bootstrap.mode");
  const phaseRaw = getLatestMetaValue(entries, "bootstrap.phase");
  const injectRaw = getLatestMetaValue(entries, "bootstrap.inject");

  const mode = typeof modeRaw === "string" ? modeRaw : null;
  const phase = typeof phaseRaw === "string" ? phaseRaw : null;
  const inject = parseMetaBool(injectRaw);
  const active = mode === "agentic" && inject && state.status !== "completed";

  return {
    ok: true,
    status: state.status,
    bootstrapId: BOOTSTRAP_ID,
    version: state.version ?? null,
    completedAt: state.completedAt ?? null,
    mode,
    phase,
    inject,
    active,
    managedCount: managedEntries.length,
    managedEntries,
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
  rho bootstrap run [--force] [--json]
  rho bootstrap reapply [--json]
  rho bootstrap upgrade [--json]
  rho bootstrap diff [--json]
  rho bootstrap reset --confirm ${RESET_CONFIRM_TOKEN} [--purge-managed] [--json]
  rho bootstrap audit [--limit N] [--json]

Notes:
  - Bootstrap is agentic (conversation-driven) by default.
  - run/reapply/upgrade activate or restart in-loop identity discovery.
  - diff reports agentic mode/phase instead of deterministic pack diffs.

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

  const managedEntries = Array.isArray(payload.managedEntries)
    ? payload.managedEntries.filter((value): value is string => typeof value === "string")
    : [];

  console.log(`Bootstrap status: ${payload.status}`);
  console.log(`Bootstrap ID: ${payload.bootstrapId}`);
  console.log(`Version: ${payload.version ?? "(none)"}`);
  if (payload.mode) console.log(`Mode: ${payload.mode}`);
  if (payload.phase) console.log(`Phase: ${payload.phase}`);
  if (typeof payload.active === "boolean") console.log(`Active injection: ${payload.active ? "on" : "off"}`);
  console.log(`Managed entries: ${payload.managedCount ?? 0}`);
  if (managedEntries.length > 0) {
    console.log("Managed entry keys/paths:");
    for (const item of managedEntries) {
      console.log(`  - ${item}`);
    }
  }
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

  appendAudit({
    op: "run",
    phase: "start",
    bootstrapId: BOOTSTRAP_ID,
    fromVersion: state.version ?? null,
    toVersion: AGENTIC_BOOTSTRAP_VERSION,
    result: "ok",
  });

  const alreadyCompleted = state.status === "completed";
  if (alreadyCompleted && !force) {
    const payload = {
      ok: true,
      status: state.status,
      version: state.version ?? null,
      mode: "agentic",
      active: false,
      message: "Bootstrap is completed. Re-run with --force to reopen identity discovery.",
    };

    appendAudit({
      op: "run",
      phase: "complete",
      bootstrapId: BOOTSTRAP_ID,
      fromVersion: state.version ?? null,
      toVersion: state.version ?? null,
      counts: { NOOP: 1 },
      result: "ok",
      message: "already-completed",
    });

    if (jsonMode) console.log(JSON.stringify(payload, null, 2));
    else console.log(payload.message);
    return;
  }

  const now = nowIso();
  const nextEntries = activateAgenticBootstrap(current, now, { resetPhase: force || alreadyCompleted });
  writeBrainEntries(nextEntries);

  const nextState = getBootstrapState(nextEntries);
  const phase = getLatestMetaValue(nextEntries, "bootstrap.phase");

  const payload = {
    ok: true,
    status: nextState.status,
    version: nextState.version ?? AGENTIC_BOOTSTRAP_VERSION,
    mode: "agentic",
    active: true,
    phase: typeof phase === "string" ? phase : "identity_discovery",
    message: "Agentic bootstrap activated. Continue the conversation and I will resolve behavior/identity/user/learning/preference in-loop.",
  };

  appendAudit({
    op: "run",
    phase: "complete",
    bootstrapId: BOOTSTRAP_ID,
    fromVersion: state.version ?? null,
    toVersion: payload.version,
    counts: { ACTIVATE: 1 },
    result: "ok",
  });

  if (jsonMode) console.log(JSON.stringify(payload, null, 2));
  else console.log(payload.message);
}

function runReapply(args: string[]): void {
  const jsonMode = hasFlag(args, "--json");
  const current = readBrainEntries();
  const state = getBootstrapState(current);
  const now = nowIso();
  const nextEntries = activateAgenticBootstrap(current, now, { resetPhase: true });
  writeBrainEntries(nextEntries);

  const payload = {
    ok: true,
    status: getBootstrapState(nextEntries).status,
    version: AGENTIC_BOOTSTRAP_VERSION,
    mode: "agentic",
    active: true,
    phase: "identity_discovery",
    message: "Agentic bootstrap restarted from identity discovery.",
  };

  appendAudit({
    op: "reapply",
    phase: "complete",
    bootstrapId: BOOTSTRAP_ID,
    fromVersion: state.version ?? null,
    toVersion: AGENTIC_BOOTSTRAP_VERSION,
    counts: { RESTART: 1 },
    result: "ok",
  });

  if (jsonMode) console.log(JSON.stringify(payload, null, 2));
  else console.log(payload.message);
}

function runUpgrade(args: string[]): void {
  const jsonMode = hasFlag(args, "--json");
  const current = readBrainEntries();
  const state = getBootstrapState(current);
  const now = nowIso();
  const nextEntries = activateAgenticBootstrap(current, now, { resetPhase: true });
  writeBrainEntries(nextEntries);

  const payload = {
    ok: true,
    status: getBootstrapState(nextEntries).status,
    version: AGENTIC_BOOTSTRAP_VERSION,
    mode: "agentic",
    active: true,
    phase: "identity_discovery",
    message: "Bootstrap is fully agentic now. Upgrade maps to restarting the bootstrap conversation.",
  };

  appendAudit({
    op: "upgrade",
    phase: "complete",
    bootstrapId: BOOTSTRAP_ID,
    fromVersion: state.version ?? null,
    toVersion: AGENTIC_BOOTSTRAP_VERSION,
    counts: { RESTART: 1 },
    result: "ok",
  });

  if (jsonMode) console.log(JSON.stringify(payload, null, 2));
  else console.log(payload.message);
}

function runDiff(args: string[]): void {
  const jsonMode = hasFlag(args, "--json");

  const entries = readBrainEntries();
  const state = getBootstrapState(entries);
  const modeRaw = getLatestMetaValue(entries, "bootstrap.mode");
  const phaseRaw = getLatestMetaValue(entries, "bootstrap.phase");
  const injectRaw = getLatestMetaValue(entries, "bootstrap.inject");

  const payload = {
    ok: true,
    bootstrapId: BOOTSTRAP_ID,
    deterministic: false,
    mode: typeof modeRaw === "string" ? modeRaw : null,
    phase: typeof phaseRaw === "string" ? phaseRaw : null,
    inject: parseMetaBool(injectRaw),
    status: state.status,
    message: "Bootstrap is agentic; no deterministic diff is computed.",
  };

  if (jsonMode) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(payload.message);
  console.log(`Mode: ${payload.mode ?? "(unset)"}`);
  console.log(`Phase: ${payload.phase ?? "(unset)"}`);
  console.log(`Inject: ${payload.inject ? "on" : "off"}`);
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
      bootstrapId: BOOTSTRAP_ID,
      result: "error",
      errorCode: "BOOTSTRAP_CONFIRM_REQUIRED",
      message: msg,
    });
    return;
  }

  appendAudit({
    op: "reset",
    phase: "start",
    bootstrapId: BOOTSTRAP_ID,
    result: "ok",
  });

  const current = readBrainEntries();
  const before = current.length;

  const filtered = current.filter((entry) => {
    if (entry.type === "meta" && typeof entry.key === "string") {
      if (
        entry.key === BOOTSTRAP_META_KEYS.completed ||
        entry.key === BOOTSTRAP_META_KEYS.version ||
        entry.key === BOOTSTRAP_META_KEYS.completedAt ||
        entry.key === "bootstrap.mode" ||
        entry.key === "bootstrap.phase" ||
        entry.key === "bootstrap.inject" ||
        entry.key === "bootstrap.startedAt" ||
        entry.key === "bootstrap.lastActivatedAt"
      ) {
        return false;
      }
    }

    if (entry.type === "context" && entry.path === AGENTIC_BOOTSTRAP_SEED_PATH) {
      return false;
    }

    if (purgeManaged) {
      if (entry.managed === true) return false;
      if (typeof entry.source === "string" && entry.source.startsWith("bootstrap:")) return false;
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
    bootstrapId: BOOTSTRAP_ID,
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
