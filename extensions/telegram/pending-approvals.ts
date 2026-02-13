import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface TelegramPendingApproval {
  id: string;
  pin: string;
  chatId: number;
  userId: number | null;
  firstSeenAt: number;
  lastSeenAt: number;
  fromName?: string;
  textPreview?: string;
}

interface PendingState {
  requests: TelegramPendingApproval[];
}

function getHome(): string {
  return process.env.HOME || homedir();
}

export function getPendingApprovalsPath(homeDir = getHome()): string {
  return join(homeDir, ".rho", "telegram", "pending-approvals.json");
}

function normalize(input: unknown): PendingState {
  const raw = (input && typeof input === "object") ? (input as any) : {};
  const list = Array.isArray(raw.requests) ? raw.requests : [];
  const requests: TelegramPendingApproval[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const chatId = Number((item as any).chatId);
    if (!Number.isInteger(chatId)) continue;
    const userRaw = (item as any).userId;
    const userId = Number.isInteger(userRaw) ? Number(userRaw) : null;
    const pin = String((item as any).pin || "").trim();
    if (!/^\d{6}$/.test(pin)) continue;
    const id = String((item as any).id || `${chatId}:${userId ?? "null"}`);
    requests.push({
      id,
      pin,
      chatId,
      userId,
      firstSeenAt: Number((item as any).firstSeenAt) || Date.now(),
      lastSeenAt: Number((item as any).lastSeenAt) || Date.now(),
      fromName: typeof (item as any).fromName === "string" ? (item as any).fromName : undefined,
      textPreview: typeof (item as any).textPreview === "string" ? (item as any).textPreview : undefined,
    });
  }
  return { requests };
}

function loadState(path = getPendingApprovalsPath()): PendingState {
  if (!existsSync(path)) return { requests: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    return normalize(parsed);
  } catch {
    return { requests: [] };
  }
}

function saveState(state: PendingState, path = getPendingApprovalsPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

function makeId(chatId: number, userId: number | null): string {
  return `${chatId}:${userId ?? "null"}`;
}

function nextPin(existing: Set<string>): string {
  for (let i = 0; i < 1000; i++) {
    const pin = String(Math.floor(100000 + Math.random() * 900000));
    if (!existing.has(pin)) return pin;
  }
  return String(Math.floor(100000 + Math.random() * 900000));
}

export function listPendingApprovals(path = getPendingApprovalsPath()): TelegramPendingApproval[] {
  return loadState(path).requests.sort((a, b) => a.firstSeenAt - b.firstSeenAt);
}

export function upsertPendingApproval(
  params: { chatId: number; userId: number | null; fromName?: string; textPreview?: string },
  path = getPendingApprovalsPath(),
): { request: TelegramPendingApproval; created: boolean } {
  const state = loadState(path);
  const id = makeId(params.chatId, params.userId);
  const now = Date.now();

  const existing = state.requests.find((r) => r.id === id);
  if (existing) {
    existing.lastSeenAt = now;
    if (params.fromName) existing.fromName = params.fromName;
    if (params.textPreview) existing.textPreview = params.textPreview;
    saveState(state, path);
    return { request: existing, created: false };
  }

  const usedPins = new Set(state.requests.map((r) => r.pin));
  const request: TelegramPendingApproval = {
    id,
    pin: nextPin(usedPins),
    chatId: params.chatId,
    userId: params.userId,
    firstSeenAt: now,
    lastSeenAt: now,
    fromName: params.fromName,
    textPreview: params.textPreview,
  };

  state.requests.push(request);
  saveState(state, path);
  return { request, created: true };
}

export function approvePendingByPin(pin: string, path = getPendingApprovalsPath()): TelegramPendingApproval | null {
  const state = loadState(path);
  const normalizedPin = String(pin || "").trim();
  const idx = state.requests.findIndex((r) => r.pin === normalizedPin);
  if (idx < 0) return null;
  const [request] = state.requests.splice(idx, 1);
  saveState(state, path);
  return request;
}

export function approvePendingByChatId(chatId: number, path = getPendingApprovalsPath()): TelegramPendingApproval | null {
  const state = loadState(path);
  const idx = state.requests.findIndex((r) => r.chatId === chatId);
  if (idx < 0) return null;
  const [request] = state.requests.splice(idx, 1);
  saveState(state, path);
  return request;
}

export function rejectPendingByPin(pin: string, path = getPendingApprovalsPath()): TelegramPendingApproval | null {
  return approvePendingByPin(pin, path);
}

export function rejectPendingByChatId(chatId: number, path = getPendingApprovalsPath()): TelegramPendingApproval | null {
  return approvePendingByChatId(chatId, path);
}
