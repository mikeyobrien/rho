import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { TelegramInboundEnvelope } from "./router.ts";

function getHome(): string {
  return process.env.HOME || homedir();
}

function defaultMapPath(): string {
  return join(getHome(), ".rho", "telegram", "session-map.json");
}

export type SessionMap = Record<string, string>;

export function sessionKeyForEnvelope(envelope: TelegramInboundEnvelope): string {
	const base = envelope.chatType === "private" ? `dm:${envelope.chatId}` : `group:${envelope.chatId}`;
	if (typeof envelope.messageThreadId === "number" && envelope.messageThreadId > 0) {
		return `${base}:topic:${envelope.messageThreadId}`;
	}
	return base;
}

export function loadSessionMap(mapPath: string = defaultMapPath()): SessionMap {
  mkdirSync(dirname(mapPath), { recursive: true });
  if (!existsSync(mapPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(mapPath, "utf-8")) as SessionMap;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed;
  } catch {
    return {};
  }
}

export function saveSessionMap(map: SessionMap, mapPath: string = defaultMapPath()): void {
  mkdirSync(dirname(mapPath), { recursive: true });
  writeFileSync(mapPath, JSON.stringify(map, null, 2));
}

function createSessionFile(baseDir?: string): string {
  const sessionId = randomUUID();
  const timestamp = new Date().toISOString();
  const safeTimestamp = timestamp.replace(/[:.]/g, "-");
  const cwd = process.env.HOME ?? process.cwd();
  const safeCwd = cwd.replace(/\//g, "-");
  const sessionDir = baseDir || join(getHome(), ".pi", "agent", "sessions", safeCwd);
  mkdirSync(sessionDir, { recursive: true });
  const sessionFile = join(sessionDir, `${safeTimestamp}_${sessionId}.jsonl`);
  const header = JSON.stringify({ type: "session", version: 1, id: sessionId, cwd, timestamp });
  writeFileSync(sessionFile, header + "\n", "utf-8");
  return sessionFile;
}

export function resolveSessionFile(
  envelope: TelegramInboundEnvelope,
  mapPath: string = defaultMapPath(),
  sessionDirOverride?: string,
): { sessionKey: string; sessionFile: string; created: boolean } {
  const map = loadSessionMap(mapPath);
  const key = sessionKeyForEnvelope(envelope);
  const existing = map[key];
  if (existing && existsSync(existing)) {
    return { sessionKey: key, sessionFile: existing, created: false };
  }

  const sessionFile = createSessionFile(sessionDirOverride);
  map[key] = sessionFile;
  saveSessionMap(map, mapPath);
  return { sessionKey: key, sessionFile, created: true };
}

export function resetSessionFile(
  envelope: TelegramInboundEnvelope,
  mapPath: string = defaultMapPath(),
  sessionDirOverride?: string,
): { sessionKey: string; sessionFile: string; previousSessionFile?: string } {
  const map = loadSessionMap(mapPath);
  const key = sessionKeyForEnvelope(envelope);
  const previousSessionFile = map[key];

  const sessionFile = createSessionFile(sessionDirOverride);
  map[key] = sessionFile;
  saveSessionMap(map, mapPath);

  return {
    sessionKey: key,
    sessionFile,
    previousSessionFile: typeof previousSessionFile === "string" ? previousSessionFile : undefined,
  };
}
