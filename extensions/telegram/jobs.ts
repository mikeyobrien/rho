import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export type TelegramJobStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface TelegramJobRecord {
  id: string;
  updateId: number;
  chatId: number;
  userId: number | null;
  messageId: number;
  messageThreadId?: number;
  sessionKey: string;
  sessionFile: string;
  promptText: string;
  createdAtMs: number;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  status: TelegramJobStatus;
  resultText?: string;
  error?: string;
  completionNotifiedAtMs?: number | null;
  cancelRequestedAtMs?: number | null;
}

function getHome(): string {
  return process.env.HOME || homedir();
}

export function getTelegramJobsPath(homeDir = getHome()): string {
  return join(homeDir, ".rho", "telegram", "jobs.json");
}

function normalizeJob(input: unknown): TelegramJobRecord | null {
  if (!input || typeof input !== "object") return null;
  const raw = input as Record<string, unknown>;

  const id = String(raw.id || "").trim();
  if (!id) return null;

  const updateId = Number(raw.updateId);
  const chatId = Number(raw.chatId);
  const messageId = Number(raw.messageId);
  const createdAtMs = Number(raw.createdAtMs);

  if (
    !Number.isInteger(updateId) ||
    !Number.isInteger(chatId) ||
    !Number.isInteger(messageId) ||
    !Number.isFinite(createdAtMs)
  ) {
    return null;
  }

  const statusRaw = String(raw.status || "")
    .trim()
    .toLowerCase();
  const status: TelegramJobStatus =
    statusRaw === "queued" ||
    statusRaw === "running" ||
    statusRaw === "completed" ||
    statusRaw === "failed" ||
    statusRaw === "cancelled"
      ? (statusRaw as TelegramJobStatus)
      : "queued";

  const userRaw = raw.userId;
  const userId = Number.isInteger(userRaw) ? Number(userRaw) : null;

  const threadRaw = raw.messageThreadId;
  const messageThreadId = Number.isInteger(threadRaw)
    ? Number(threadRaw)
    : undefined;

  const startedRaw = raw.startedAtMs;
  const finishedRaw = raw.finishedAtMs;
  const completionNotifiedRaw = raw.completionNotifiedAtMs;
  const cancelRequestedRaw = raw.cancelRequestedAtMs;

  return {
    id,
    updateId,
    chatId,
    userId,
    messageId,
    messageThreadId,
    sessionKey: String(raw.sessionKey || "").trim() || `dm:${chatId}`,
    sessionFile: String(raw.sessionFile || "").trim(),
    promptText: String(raw.promptText || ""),
    createdAtMs,
    startedAtMs: Number.isFinite(Number(startedRaw))
      ? Number(startedRaw)
      : null,
    finishedAtMs: Number.isFinite(Number(finishedRaw))
      ? Number(finishedRaw)
      : null,
    status,
    resultText: typeof raw.resultText === "string" ? raw.resultText : undefined,
    error: typeof raw.error === "string" ? raw.error : undefined,
    completionNotifiedAtMs: Number.isFinite(Number(completionNotifiedRaw))
      ? Number(completionNotifiedRaw)
      : null,
    cancelRequestedAtMs: Number.isFinite(Number(cancelRequestedRaw))
      ? Number(cancelRequestedRaw)
      : null,
  };
}

export function loadTelegramJobs(
  path = getTelegramJobsPath(),
): TelegramJobRecord[] {
  if (!existsSync(path)) return [];

  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!Array.isArray(parsed)) return [];

    const jobs: TelegramJobRecord[] = [];
    for (const item of parsed) {
      const normalized = normalizeJob(item);
      if (!normalized) continue;
      jobs.push(normalized);
    }

    return jobs.sort((a, b) => a.createdAtMs - b.createdAtMs);
  } catch {
    return [];
  }
}

export function saveTelegramJobs(
  jobs: TelegramJobRecord[],
  path = getTelegramJobsPath(),
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(jobs, null, 2));
}

export function createTelegramJobId(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `J${ts}${suffix}`;
}

export function summarizeTelegramJobs(jobs: TelegramJobRecord[]): {
  total: number;
  queued: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
} {
  let queued = 0;
  let running = 0;
  let completed = 0;
  let failed = 0;
  let cancelled = 0;

  for (const job of jobs) {
    if (job.status === "queued") queued += 1;
    else if (job.status === "running") running += 1;
    else if (job.status === "completed") completed += 1;
    else if (job.status === "failed") failed += 1;
    else if (job.status === "cancelled") cancelled += 1;
  }

  return {
    total: jobs.length,
    queued,
    running,
    completed,
    failed,
    cancelled,
  };
}
