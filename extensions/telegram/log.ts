import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const HOME = process.env.HOME || homedir();
const LOG_PATH = join(HOME, ".rho", "telegram", "log.jsonl");
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;

function parsePositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Ignore.
  }
}

function safeRename(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch {
    // Ignore.
  }
}

function rotateLogFiles(
  logPath: string,
  maxBytes: number,
  maxFiles: number,
): void {
  if (maxFiles < 2 || maxBytes <= 0) {
    return;
  }

  try {
    const currentSize = statSync(logPath).size;
    if (!Number.isFinite(currentSize) || currentSize <= maxBytes) return;
  } catch {
    return;
  }

  for (let i = maxFiles - 1; i >= 1; i--) {
    const source = `${logPath}.${i}`;
    const target = `${logPath}.${i + 1}`;

    if (!existsSync(source)) {
      continue;
    }

    if (i + 1 === maxFiles) {
      safeUnlink(target);
    }
    safeRename(source, target);
  }

  safeRename(logPath, `${logPath}.1`);
}

function normalizeLogEvent(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const { type: _legacyType, event, ...rest } = input;
  const normalizedEvent =
    typeof event === "string" && event.trim().length > 0 ? event : "unknown";

  return {
    source: "telegram",
    schema_version: 1,
    event: normalizedEvent,
    ...rest,
  };
}

export function appendTelegramLog(
  event: Record<string, unknown>,
  logPath: string = LOG_PATH,
): void {
  mkdirSync(dirname(logPath), { recursive: true });

  const maxBytes = parsePositiveInt(
    "RHO_TELEGRAM_LOG_MAX_BYTES",
    DEFAULT_MAX_BYTES,
  );
  const maxFiles = parsePositiveInt(
    "RHO_TELEGRAM_LOG_MAX_FILES",
    DEFAULT_MAX_FILES,
  );
  rotateLogFiles(logPath, maxBytes, maxFiles);

  const line = JSON.stringify({
    ts: new Date().toISOString(),
    ...normalizeLogEvent(event),
  });
  appendFileSync(logPath, line + "\n");
}
