import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export interface TelegramCheckTriggerRequestV1 {
  version: 1;
  requestedAt: number;
  requesterPid: number;
  requesterRole: "leader" | "follower";
  source: string;
}

export interface TelegramCheckTriggerState {
  pending: boolean;
  requesterPid: number | null;
  requestedAt: number | null;
  request: TelegramCheckTriggerRequestV1 | null;
  mtimeMs: number | null;
}

function ensureDirForFile(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

function parseTriggerPayload(
  raw: string,
): TelegramCheckTriggerRequestV1 | null {
  try {
    const parsed = JSON.parse(raw) as Partial<TelegramCheckTriggerRequestV1>;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.version !== 1) return null;
    if (typeof parsed.requestedAt !== "number") return null;
    if (typeof parsed.requesterPid !== "number") return null;
    if (
      parsed.requesterRole !== "leader" &&
      parsed.requesterRole !== "follower"
    )
      return null;
    if (typeof parsed.source !== "string" || parsed.source.trim().length === 0)
      return null;
    return parsed as TelegramCheckTriggerRequestV1;
  } catch {
    return null;
  }
}

function atomicWriteTextFile(filePath: string, content: string): boolean {
  let tmpPath: string | null = null;
  try {
    ensureDirForFile(filePath);
    tmpPath = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    writeFileSync(tmpPath, content, { encoding: "utf-8", mode: 0o600 });
    renameSync(tmpPath, filePath);
    tmpPath = null;
    return true;
  } catch {
    try {
      if (tmpPath) unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    return false;
  }
}

export function requestTelegramCheckTrigger(
  triggerPath: string,
  request: Omit<TelegramCheckTriggerRequestV1, "version">,
): boolean {
  const payload: TelegramCheckTriggerRequestV1 = {
    version: 1,
    requestedAt: request.requestedAt,
    requesterPid: request.requesterPid,
    requesterRole: request.requesterRole,
    source: request.source,
  };
  return atomicWriteTextFile(triggerPath, JSON.stringify(payload, null, 2));
}

export function readTelegramCheckTrigger(
  triggerPath: string,
): TelegramCheckTriggerRequestV1 | null {
  try {
    if (!existsSync(triggerPath)) return null;
    return parseTriggerPayload(readFileSync(triggerPath, "utf-8"));
  } catch {
    return null;
  }
}

export function getTelegramCheckTriggerState(
  triggerPath: string,
  _lastSeenMtimeMs: number,
): TelegramCheckTriggerState {
  try {
    if (!existsSync(triggerPath)) {
      return {
        pending: false,
        requesterPid: null,
        requestedAt: null,
        request: null,
        mtimeMs: null,
      };
    }

    const st = statSync(triggerPath);
    const request = readTelegramCheckTrigger(triggerPath);
    return {
      pending: true,
      requesterPid: request?.requesterPid ?? null,
      requestedAt: request?.requestedAt ?? null,
      request,
      mtimeMs: st.mtimeMs ?? null,
    };
  } catch {
    return {
      pending: false,
      requesterPid: null,
      requestedAt: null,
      request: null,
      mtimeMs: null,
    };
  }
}

export function consumeTelegramCheckTrigger(
  triggerPath: string,
  lastSeenMtimeMs: number,
): {
  triggered: boolean;
  nextSeen: number;
  request: TelegramCheckTriggerRequestV1 | null;
} {
  try {
    if (!existsSync(triggerPath))
      return { triggered: false, nextSeen: lastSeenMtimeMs, request: null };
    const st = statSync(triggerPath);
    const mtime = st.mtimeMs || Date.now();
    if (mtime <= lastSeenMtimeMs)
      return { triggered: false, nextSeen: lastSeenMtimeMs, request: null };
    const request = readTelegramCheckTrigger(triggerPath);
    try {
      unlinkSync(triggerPath);
    } catch {
      /* ignore */
    }
    return { triggered: true, nextSeen: mtime, request };
  } catch {
    return { triggered: false, nextSeen: lastSeenMtimeMs, request: null };
  }
}
