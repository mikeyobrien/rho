import {
  LeaseHandle,
  isLeaseStale,
  readLeaseMeta,
  readLeasePayload,
  tryAcquireLeaseLock,
} from "../lib/lease-lock.ts";

export const TELEGRAM_POLL_LEASE_PURPOSE = "rho-telegram-poll-leadership";

export interface TelegramPollLeadershipState {
  isLeader: boolean;
  ownerPid: number | null;
  lease: LeaseHandle | null;
}

export interface TelegramPollLeadershipStepParams {
  lockPath: string;
  nonce: string;
  now: number;
  staleMs: number;
  purpose?: string;
}

export interface TelegramPollLeadershipStepResult {
  isLeader: boolean;
  ownerPid: number | null;
  becameLeader: boolean;
  lostLeadership: boolean;
}

export interface TelegramPollLockOwnerInfo {
  pid: number;
  nonce: string;
  purpose: string;
  hostname: string;
  acquiredAt: number;
  refreshedAt: number;
}

export function createTelegramPollLeadershipState(): TelegramPollLeadershipState {
  return {
    isLeader: false,
    ownerPid: null,
    lease: null,
  };
}

export function releaseTelegramPollLeadership(
  state: TelegramPollLeadershipState,
): void {
  state.isLeader = false;
  state.ownerPid = null;
  state.lease?.release();
  state.lease = null;
}

export function readTelegramPollLockOwner(
  lockPath: string,
): TelegramPollLockOwnerInfo | null {
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

export function stepTelegramPollLeadership(
  state: TelegramPollLeadershipState,
  params: TelegramPollLeadershipStepParams,
): TelegramPollLeadershipStepResult {
  const purpose = params.purpose ?? TELEGRAM_POLL_LEASE_PURPOSE;

  if (state.isLeader) {
    const refreshed = state.lease ? state.lease.refresh(params.now) : false;
    if (refreshed) {
      state.ownerPid = process.pid;
      return {
        isLeader: true,
        ownerPid: state.ownerPid,
        becameLeader: false,
        lostLeadership: false,
      };
    }

    state.lease?.release();
    state.lease = null;
    state.isLeader = false;
    state.ownerPid = readLeaseMeta(params.lockPath).payload?.pid ?? null;
    return {
      isLeader: false,
      ownerPid: state.ownerPid,
      becameLeader: false,
      lostLeadership: true,
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
      state.isLeader = true;
      state.lease = acquired.lease;
      state.ownerPid = process.pid;
      return {
        isLeader: true,
        ownerPid: state.ownerPid,
        becameLeader: true,
        lostLeadership: false,
      };
    }
  }

  return {
    isLeader: false,
    ownerPid: state.ownerPid,
    becameLeader: false,
    lostLeadership: false,
  };
}
