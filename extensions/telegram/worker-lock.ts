import {
  LeaseHandle,
  isLeaseStale,
  readLeaseMeta,
  readLeasePayload,
  tryAcquireLeaseLock,
} from "../lib/lease-lock.ts";

export const TELEGRAM_WORKER_LEASE_PURPOSE = "rho-telegram-worker";

export interface TelegramWorkerLockState {
  isOwner: boolean;
  ownerPid: number | null;
  lease: LeaseHandle | null;
}

export interface TelegramWorkerLockStepParams {
  lockPath: string;
  nonce: string;
  now: number;
  staleMs: number;
  purpose?: string;
}

export interface TelegramWorkerLockStepResult {
  isOwner: boolean;
  ownerPid: number | null;
  acquired: boolean;
  lost: boolean;
}

export interface TelegramWorkerLockOwnerInfo {
  pid: number;
  nonce: string;
  purpose: string;
  hostname: string;
  acquiredAt: number;
  refreshedAt: number;
}

export function createTelegramWorkerLockState(): TelegramWorkerLockState {
  return {
    isOwner: false,
    ownerPid: null,
    lease: null,
  };
}

export function releaseTelegramWorkerLock(
  state: TelegramWorkerLockState,
): void {
  state.isOwner = false;
  state.ownerPid = null;
  state.lease?.release();
  state.lease = null;
}

export function readTelegramWorkerLockOwner(
  lockPath: string,
): TelegramWorkerLockOwnerInfo | null {
  const payload = readLeasePayload(lockPath);
  if (!payload) return null;
  return {
    pid: payload.pid,
    nonce: payload.nonce,
    purpose: payload.purpose,
    hostname: payload.hostname,
    acquiredAt: payload.acquiredAt,
    refreshedAt: payload.refreshedAt,
  };
}

export function stepTelegramWorkerLock(
  state: TelegramWorkerLockState,
  params: TelegramWorkerLockStepParams,
): TelegramWorkerLockStepResult {
  const purpose = params.purpose ?? TELEGRAM_WORKER_LEASE_PURPOSE;

  if (state.isOwner) {
    const refreshed = state.lease ? state.lease.refresh(params.now) : false;
    if (refreshed) {
      state.ownerPid = process.pid;
      return {
        isOwner: true,
        ownerPid: state.ownerPid,
        acquired: false,
        lost: false,
      };
    }

    state.lease?.release();
    state.lease = null;
    state.isOwner = false;
    state.ownerPid = readLeaseMeta(params.lockPath).payload?.pid ?? null;
    return {
      isOwner: false,
      ownerPid: state.ownerPid,
      acquired: false,
      lost: true,
    };
  }

  const meta = readLeaseMeta(params.lockPath);
  state.ownerPid = meta.payload?.pid ?? null;

  if (!meta.payload || isLeaseStale(meta, params.staleMs, params.now)) {
    const acquired = tryAcquireLeaseLock(
      params.lockPath,
      params.nonce,
      params.now,
      {
        staleMs: params.staleMs,
        purpose,
      },
    );
    state.ownerPid = acquired.ownerPid;
    if (acquired.ok) {
      state.isOwner = true;
      state.lease = acquired.lease;
      state.ownerPid = process.pid;
      return {
        isOwner: true,
        ownerPid: state.ownerPid,
        acquired: true,
        lost: false,
      };
    }
  }

  return {
    isOwner: false,
    ownerPid: state.ownerPid,
    acquired: false,
    lost: false,
  };
}
