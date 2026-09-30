/**
 * extensions/lib/lease-lock.ts
 *
 * Long-held "lease" lock backed by a file on disk.
 *
 * Key properties:
 * - Acquisition is atomic (O_CREAT|O_EXCL).
 * - While holding the lease, we keep an fd open and refresh the lease by
 *   writing in-place via that fd (no rename-based refresh).
 * - Refresh/release verify the lock file inode matches the path inode so a
 *   former leader cannot clobber or delete a newly acquired lock (TOCTOU-safe).
 *
 * This is intended for leadership / coordinator roles (e.g. heartbeat leader),
 * not short critical sections (see file-lock.ts for that).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { isPidRunning } from "./file-lock.ts";

export interface LeasePayloadV1 {
  version: 1;
  purpose: string;
  pid: number;
  nonce: string;
  acquiredAt: number;
  refreshedAt: number;
  hostname: string;
}

// Back-compat: older rho versions wrote a lock without version/purpose.
type LegacyLeasePayload = {
  pid: number;
  nonce: string;
  acquiredAt: number;
  refreshedAt: number;
  hostname: string;
};

export interface LeaseMeta {
  payload: LeasePayloadV1 | null;
  mtimeMs: number | null;
  inode: number | null;
}

export interface AcquireLeaseOpts {
  staleMs: number;
  purpose: string;
}

function safeStat(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

export function readLeasePayload(lockPath: string): LeasePayloadV1 | null {
  try {
    const raw = fs.readFileSync(lockPath, "utf-8");
    const parsed = JSON.parse(raw) as any;
    if (!parsed || typeof parsed !== "object") return null;

    // v1 payload
    if (parsed.version === 1) {
      const p = parsed as Partial<LeasePayloadV1>;
      if (typeof p.purpose !== "string") return null;
      if (typeof p.pid !== "number") return null;
      if (typeof p.nonce !== "string") return null;
      if (typeof p.acquiredAt !== "number") return null;
      if (typeof p.refreshedAt !== "number") return null;
      if (typeof p.hostname !== "string") return null;
      return p as LeasePayloadV1;
    }

    // legacy payload (no version/purpose)
    const l = parsed as Partial<LegacyLeasePayload>;
    if (typeof l.pid !== "number") return null;
    if (typeof l.nonce !== "string") return null;
    if (typeof l.acquiredAt !== "number") return null;
    if (typeof l.refreshedAt !== "number") return null;
    if (typeof l.hostname !== "string") return null;
    return {
      version: 1,
      purpose: "legacy",
      pid: l.pid,
      nonce: l.nonce,
      acquiredAt: l.acquiredAt,
      refreshedAt: l.refreshedAt,
      hostname: l.hostname,
    };
  } catch {
    return null;
  }
}

export function readLeaseMeta(lockPath: string): LeaseMeta {
  const st = safeStat(lockPath);
  const inode = st
    ? typeof (st as any).ino === "number"
      ? (st as any).ino
      : null
    : null;
  const mtimeMs = st ? (st.mtimeMs ?? null) : null;
  return { payload: readLeasePayload(lockPath), mtimeMs, inode };
}

export function isLeaseStale(
  meta: LeaseMeta,
  staleMs: number,
  now: number,
): boolean {
  const p = meta.payload;
  if (p) {
    if (!isPidRunning(p.pid)) return true;
    if (!Number.isFinite(p.refreshedAt)) return true;
    return now - p.refreshedAt > staleMs;
  }
  // Unparseable lock file: fall back to mtime
  if (meta.mtimeMs == null) return true; // file gone
  return now - meta.mtimeMs > staleMs;
}

function ensureDirForFile(filePath: string): void {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } catch {
    // ignore
  }
}

function tryCreateExclusiveFd(
  lockPath: string,
  content: string,
): { ok: true; fd: number; inode: number } | { ok: false; code?: string } {
  try {
    ensureDirForFile(lockPath);
    const fd = fs.openSync(
      lockPath,
      fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL,
      0o600,
    );
    try {
      fs.writeSync(fd, content, 0, "utf-8");
      // Best-effort: flush so other processes see a complete JSON payload.
      try {
        fs.fsyncSync(fd);
      } catch {
        /* ignore */
      }
      const st = fs.fstatSync(fd);
      const inode = typeof (st as any).ino === "number" ? (st as any).ino : -1;
      return { ok: true, fd, inode };
    } catch (err) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
      throw err;
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    return { ok: false, code };
  }
}

function writeLeaseInPlace(fd: number, content: string): boolean {
  try {
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, content, 0, "utf-8");
    try {
      fs.fsyncSync(fd);
    } catch {
      /* ignore */
    }
    return true;
  } catch {
    return false;
  }
}

export class LeaseHandle {
  readonly lockPath: string;
  readonly fd: number;
  readonly inode: number;
  readonly pid: number;
  readonly nonce: string;
  readonly purpose: string;
  private closed = false;

  constructor(args: {
    lockPath: string;
    fd: number;
    inode: number;
    pid: number;
    nonce: string;
    purpose: string;
  }) {
    this.lockPath = args.lockPath;
    this.fd = args.fd;
    this.inode = args.inode;
    this.pid = args.pid;
    this.nonce = args.nonce;
    this.purpose = args.purpose;
  }

  /**
   * Verify the path still points to the same inode we hold.
   * If it doesn't, we've lost leadership (someone replaced the lock file).
   */
  isCurrent(): boolean {
    if (this.closed) return false;
    const st = safeStat(this.lockPath);
    if (!st) return false;
    const ino = typeof (st as any).ino === "number" ? (st as any).ino : null;
    return ino === this.inode;
  }

  /**
   * Refresh the lease by updating refreshedAt, writing in-place via fd.
   * Returns false if we no longer own the lock path (inode mismatch) or on IO errors.
   */
  refresh(now: number): boolean {
    if (!this.isCurrent()) return false;
    // If the on-disk payload no longer matches our pid/nonce/purpose, treat as lost.
    const onDisk = readLeasePayload(this.lockPath);
    if (
      onDisk &&
      (onDisk.pid !== this.pid ||
        onDisk.nonce !== this.nonce ||
        onDisk.purpose !== this.purpose)
    ) {
      return false;
    }
    const payload: LeasePayloadV1 = {
      version: 1,
      purpose: this.purpose,
      pid: this.pid,
      nonce: this.nonce,
      acquiredAt: now, // overwritten below if we can read our original, best-effort
      refreshedAt: now,
      hostname: os.hostname(),
    };
    // Best-effort preserve acquiredAt from existing file so it doesn't drift.
    try {
      const existing = readLeasePayload(this.lockPath);
      if (
        existing &&
        existing.pid === this.pid &&
        existing.nonce === this.nonce &&
        existing.purpose === this.purpose
      ) {
        payload.acquiredAt = existing.acquiredAt;
      }
    } catch {
      // ignore
    }
    const content = JSON.stringify(payload, null, 2);
    return writeLeaseInPlace(this.fd, content);
  }

  /**
   * Release the lease. Only unlinks the path if it still points to our inode.
   */
  release(): void {
    if (this.closed) return;
    try {
      if (this.isCurrent()) {
        try {
          fs.unlinkSync(this.lockPath);
        } catch {
          /* ignore */
        }
      }
    } finally {
      try {
        fs.closeSync(this.fd);
      } catch {
        /* ignore */
      }
      this.closed = true;
    }
  }
}

/**
 * Attempt to acquire a lease. If an existing lease is stale, it is removed and we retry.
 *
 * Returns:
 * - ok: true with a LeaseHandle if acquired
 * - ok: false with ownerPid if another live process holds it
 */
export function tryAcquireLeaseLock(
  lockPath: string,
  nonce: string,
  now: number,
  opts: AcquireLeaseOpts,
):
  | { ok: true; lease: LeaseHandle; ownerPid: number }
  | { ok: false; ownerPid: number | null } {
  const basePayload: LeasePayloadV1 = {
    version: 1,
    purpose: opts.purpose,
    pid: process.pid,
    nonce,
    acquiredAt: now,
    refreshedAt: now,
    hostname: os.hostname(),
  };
  const content = JSON.stringify(basePayload, null, 2);

  for (let attempt = 0; attempt < 3; attempt++) {
    const created = tryCreateExclusiveFd(lockPath, content);
    if (created.ok) {
      const lease = new LeaseHandle({
        lockPath,
        fd: created.fd,
        inode: created.inode,
        pid: process.pid,
        nonce,
        purpose: opts.purpose,
      });
      return { ok: true, lease, ownerPid: process.pid };
    }

    // Unexpected FS error: treat as not acquired.
    if (created.code && created.code !== "EEXIST")
      return { ok: false, ownerPid: null };

    // Existing lock: decide if stale.
    const meta = readLeaseMeta(lockPath);
    if (isLeaseStale(meta, opts.staleMs, now)) {
      try {
        fs.unlinkSync(lockPath);
      } catch {
        /* ignore */
      }
      continue;
    }
    return { ok: false, ownerPid: meta.payload?.pid ?? null };
  }

  const after = readLeasePayload(lockPath);
  return { ok: false, ownerPid: after?.pid ?? null };
}
