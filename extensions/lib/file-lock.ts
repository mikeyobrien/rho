/**
 * extensions/lib/file-lock.ts
 *
 * Exclusive file lock with stale-detection, exponential backoff, and
 * automatic release. Extracted from the heartbeat lock in rho/index.ts
 * so it can be reused (e.g. brain.jsonl writes).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

// ── Types ──────────────────────────────────────────────────────────

export interface LockPayload {
  pid: number;
  nonce: string;
  acquiredAt: number;
  refreshedAt: number;
  hostname: string;
  purpose: string;
}

export interface FileLockOpts {
  /** How long before a lock is considered stale (ms). Default 30 000. */
  staleMs?: number;
  /** How long to wait before giving up (ms). Default 5 000. */
  timeoutMs?: number;
  /** Human-readable label written into the lock. Default "append". */
  purpose?: string;
}

// ── Helpers ────────────────────────────────────────────────────────

function nanoid(size = 8): string {
  return crypto.randomBytes(size).toString("base64url").slice(0, size);
}

/** Returns true if the given PID is alive (or exists but we can't signal it). */
export function isPidRunning(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EPERM") return true; // exists, just can't signal
    return false;
  }
}

function readLock(lockPath: string): LockPayload | null {
  try {
    const raw = fs.readFileSync(lockPath, "utf-8");
    const p = JSON.parse(raw) as Partial<LockPayload>;
    if (
      typeof p?.pid === "number" &&
      typeof p?.nonce === "string" &&
      typeof p?.acquiredAt === "number" &&
      typeof p?.refreshedAt === "number" &&
      typeof p?.hostname === "string"
    ) {
      return p as LockPayload;
    }
    return null;
  } catch {
    return null;
  }
}

function mtimeMs(filePath: string): number | null {
  try {
    return fs.statSync(filePath).mtimeMs ?? null;
  } catch {
    return null;
  }
}

function isStale(
  lock: LockPayload | null,
  lockPath: string,
  staleMs: number,
  now: number,
): boolean {
  if (lock) {
    if (!isPidRunning(lock.pid)) return true;
    if (!Number.isFinite(lock.refreshedAt)) return true;
    return now - lock.refreshedAt > staleMs;
  }
  // Unparseable: fall back to mtime
  const mt = mtimeMs(lockPath);
  if (mt == null) return true; // file gone
  return now - mt > staleMs;
}

/**
 * Attempt an exclusive create of `lockPath`.
 * Returns true if we created it, false if it already exists.
 * Throws on unexpected FS errors.
 */
function tryCreate(lockPath: string, content: string): boolean {
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const fd = fs.openSync(
      lockPath,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    fs.writeSync(fd, content);
    fs.closeSync(fd);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EEXIST") return false;
    throw err;
  }
}

/** Best-effort unlink only if we still own the lock (pid + nonce match). */
function releaseIfOwned(lockPath: string, pid: number, nonce: string): void {
  try {
    const current = readLock(lockPath);
    if (current && current.pid === pid && current.nonce === nonce) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    // best-effort
  }
}

// ── Main API ───────────────────────────────────────────────────────

/**
 * Acquire an exclusive file lock, run `fn`, then release.
 *
 * - Uses `O_CREAT | O_EXCL` for atomic creation.
 * - Detects stale locks via PID liveness, `refreshedAt` age, or mtime fallback.
 * - Retries with exponential backoff + jitter until `timeoutMs`.
 * - On timeout throws an Error whose message contains `LOCK_TIMEOUT`.
 * - Lock is released (unlinked) in a finally block even if `fn` throws.
 */
export async function withFileLock<T>(
  lockPath: string,
  opts: FileLockOpts,
  fn: () => Promise<T>,
): Promise<T> {
  const staleMs = opts.staleMs ?? 30_000;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const purpose = opts.purpose ?? "append";

  const nonce = nanoid(12);
  const pid = process.pid;
  const deadline = Date.now() + timeoutMs;

  let backoff = 10; // ms, grows exponentially
  const MAX_BACKOFF = 250;

  // Spin until we acquire or timeout
  while (true) {
    const now = Date.now();
    const payload: LockPayload = {
      pid,
      nonce,
      acquiredAt: now,
      refreshedAt: now,
      hostname: os.hostname(),
      purpose,
    };
    const content = JSON.stringify(payload, null, 2);

    if (tryCreate(lockPath, content)) {
      // We own it
      try {
        return await fn();
      } finally {
        releaseIfOwned(lockPath, pid, nonce);
      }
    }

    // Lock file exists — check if stale
    const existing = readLock(lockPath);
    if (isStale(existing, lockPath, staleMs, now)) {
      // Remove stale lock and retry immediately
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* race: someone else cleaned it */
      }
      continue;
    }

    // Not stale — wait and retry
    if (Date.now() >= deadline) {
      throw new Error(
        `LOCK_TIMEOUT: could not acquire ${lockPath} within ${timeoutMs}ms` +
          (existing ? ` (held by pid ${existing.pid})` : ""),
      );
    }

    // Exponential backoff with jitter
    const jitter = Math.random() * backoff * 0.5;
    const delay = Math.min(backoff + jitter, MAX_BACKOFF);
    await new Promise((r) => setTimeout(r, delay));
    backoff = Math.min(backoff * 2, MAX_BACKOFF);
  }
}
