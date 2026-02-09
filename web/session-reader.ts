import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export interface SessionSummary {
  id: string;
  file: string;
  name?: string;
  cwd: string;
  timestamp: string;
  parentSession?: string;
  messageCount: number;
  lastMessage?: string;
  isActive: boolean;
}

export interface SessionHeader {
  type: "session";
  version?: number;
  id: string;
  timestamp?: string;
  cwd?: string;
  parentSession?: string;
}

export interface ParsedMessage {
  id: string;
  parentId: string | null;
  role: string;
  content: unknown;
  timestamp: string;
  usage?: Record<string, unknown>;
  model?: string;
}

export interface ForkPoint {
  id: string;
  text: string;
  timestamp: string;
}

export interface ParsedSession {
  header: SessionHeader;
  messages: ParsedMessage[];
  forkPoints: ForkPoint[];
  stats: { messageCount: number; tokenUsage: number; cost: number };
  name?: string;
}

const DEFAULT_SESSION_DIR = path.join(os.homedir(), ".pi", "agent", "sessions");

interface SessionEntryBase {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
}

interface MessageEntry extends SessionEntryBase {
  type: "message";
  message: {
    role?: string;
    content?: unknown;
    timestamp?: number | string;
    usage?: Record<string, unknown>;
    model?: string;
    modelId?: string;
  };
}

interface CompactionEntry extends SessionEntryBase {
  type: "compaction";
  summary?: string;
  firstKeptEntryId?: string;
  tokensBefore?: number;
  details?: Record<string, unknown>;
}

interface BranchSummaryEntry extends SessionEntryBase {
  type: "branch_summary";
  summary?: string;
  fromId?: string;
  details?: Record<string, unknown>;
}

interface CustomMessageEntry extends SessionEntryBase {
  type: "custom_message";
  content?: unknown;
  customType?: string;
  display?: boolean;
  details?: Record<string, unknown>;
}

interface SessionInfoEntry extends SessionEntryBase {
  type: "session_info";
  name?: string;
}

interface LabelEntry extends SessionEntryBase {
  type: "label";
  targetId?: string;
  label?: string;
}

export async function listSessions(cwd?: string, sessionDir = DEFAULT_SESSION_DIR): Promise<SessionSummary[]> {
  const files = await listSessionFiles(sessionDir);
  const summaries: SessionSummary[] = [];

  for (const file of files) {
    try {
      const info = await getSessionInfo(file);
      if (cwd && info.cwd !== cwd) {
        continue;
      }
      summaries.push({
        id: info.id,
        file,
        name: info.name,
        cwd: info.cwd,
        timestamp: info.timestamp,
        parentSession: info.parentSession,
        messageCount: info.messageCount,
        lastMessage: info.lastMessage,
        isActive: false,
      });
    } catch {
      // Skip invalid or unreadable session files.
    }
  }

  summaries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  return summaries;
}

export async function readSession(sessionFile: string): Promise<ParsedSession> {
  const entries = await loadSessionEntries(sessionFile);
  const header = normalizeHeader(entries.header, sessionFile);
  const { name } = entries;
  const parsed = buildSessionContext(entries.entries, entries.entryMap);

  return {
    header,
    messages: parsed.messages,
    forkPoints: parsed.forkPoints,
    stats: parsed.stats,
    name,
  };
}

export async function getSessionInfo(sessionFile: string): Promise<{
  id: string;
  cwd: string;
  timestamp: string;
  parentSession?: string;
  name?: string;
  messageCount: number;
  lastMessage?: string;
}> {
  const entries = await loadSessionEntries(sessionFile);
  const header = normalizeHeader(entries.header, sessionFile);
  const parsed = buildSessionContext(entries.entries, entries.entryMap);

  const lastMessage = parsed.messages.at(-1);
  return {
    id: header.id,
    cwd: header.cwd ?? "",
    timestamp: header.timestamp ?? "",
    parentSession: header.parentSession,
    name: entries.name,
    messageCount: parsed.messages.length,
    lastMessage: lastMessage ? extractPreview(lastMessage.content) : undefined,
  };
}

export async function findSessionFileById(sessionId: string, sessionDir = DEFAULT_SESSION_DIR): Promise<string | null> {
  if (!sessionId) {
    return null;
  }

  if (sessionId.includes(path.sep) || sessionId.endsWith(".jsonl")) {
    const resolved = path.resolve(sessionId);
    if (existsSync(resolved)) {
      return resolved;
    }
  }

  const files = await listSessionFiles(sessionDir);
  for (const file of files) {
    try {
      const header = await readSessionHeader(file);
      if (header?.id === sessionId) {
        return file;
      }
      if (path.basename(file).includes(sessionId)) {
        return file;
      }
    } catch {
      continue;
    }
  }

  return null;
}

async function listSessionFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  if (!existsSync(dir)) {
    return files;
  }

  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await listSessionFiles(fullPath);
      files.push(...nested);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath);
    }
  }

  return files;
}

async function loadSessionEntries(sessionFile: string): Promise<{
  header: SessionHeader | null;
  entries: SessionEntryBase[];
  entryMap: Map<string, SessionEntryBase>;
  name?: string;
}> {
  const content = await readFile(sessionFile, "utf-8");
  const lines = content.split("\n").filter((line) => line.trim().length > 0);

  const entries: SessionEntryBase[] = [];
  let header: SessionHeader | null = null;
  let name: string | undefined;
  const entryMap = new Map<string, SessionEntryBase>();

  for (const line of lines) {
    let parsed: SessionEntryBase | null = null;
    try {
      parsed = JSON.parse(line) as SessionEntryBase;
    } catch {
      continue;
    }

    if (parsed.type === "session") {
      header = parsed as SessionHeader;
      continue;
    }

    if (parsed.type === "session_info") {
      const info = parsed as SessionInfoEntry;
      if (info.name) {
        name = info.name;
      }
    }

    entries.push(parsed);
    if (parsed.id) {
      entryMap.set(parsed.id, parsed);
    }
  }

  return { header, entries, entryMap, name };
}

async function readSessionHeader(sessionFile: string): Promise<SessionHeader | null> {
  const content = await readFile(sessionFile, "utf-8");
  const line = content.split("\n").find((entry) => entry.trim().length > 0);
  if (!line) {
    return null;
  }
  try {
    const parsed = JSON.parse(line);
    if (parsed?.type === "session") {
      return parsed as SessionHeader;
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeHeader(header: SessionHeader | null, sessionFile?: string): SessionHeader {
  const normalized: SessionHeader = {
    type: "session",
    id: header?.id ?? "",
    version: header?.version ?? 1,
    timestamp: header?.timestamp,
    cwd: header?.cwd,
    parentSession: header?.parentSession,
  };

  if (sessionFile) {
    const baseName = path.basename(sessionFile, ".jsonl");
    const [timestampPart, idPart] = baseName.split("_");
    if (!normalized.id) {
      normalized.id = idPart ?? baseName;
    }
    if (!normalized.timestamp && timestampPart) {
      const parsedTimestamp = parseTimestampFromFilename(timestampPart);
      if (parsedTimestamp) {
        normalized.timestamp = parsedTimestamp;
      }
    }
  }

  return normalized;
}

function buildSessionContext(entries: SessionEntryBase[], entryMap: Map<string, SessionEntryBase>): {
  messages: ParsedMessage[];
  forkPoints: ForkPoint[];
  stats: { messageCount: number; tokenUsage: number; cost: number };
} {
  const leaf = findLeafEntry(entries);
  if (!leaf?.id) {
    return {
      messages: [],
      forkPoints: [],
      stats: { messageCount: 0, tokenUsage: 0, cost: 0 },
    };
  }

  const path = buildPath(entryMap, leaf.id);
  const compactionIndex = findLastIndex(path, (entry) => entry.type === "compaction");
  let startIndex = 0;
  let compactionSummary: ParsedMessage | null = null;

  if (compactionIndex >= 0) {
    const compaction = path[compactionIndex] as CompactionEntry;
    compactionSummary = formatCompaction(compaction);
    if (compaction.firstKeptEntryId) {
      const keptIndex = path.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
      startIndex = keptIndex >= 0 ? keptIndex : compactionIndex + 1;
    } else {
      startIndex = compactionIndex + 1;
    }
  }

  const messages: ParsedMessage[] = [];
  const forkPoints: ForkPoint[] = [];
  let tokenUsage = 0;
  let cost = 0;

  if (compactionSummary) {
    messages.push(compactionSummary);
  }

  const pathSlice = path.slice(startIndex);
  for (const entry of pathSlice) {
    const parsed = toParsedMessage(entry);
    if (!parsed) {
      continue;
    }
    if (compactionSummary && entry.type === "compaction") {
      continue;
    }

    messages.push(parsed);

    if (parsed.role === "user") {
      const text = extractPreview(parsed.content);
      if (text) {
        forkPoints.push({ id: parsed.id, text, timestamp: parsed.timestamp });
      }
    }

    const usage = parsed.usage as Record<string, unknown> | undefined;
    if (usage) {
      const totalTokens = asNumber(usage.totalTokens);
      const fallbackTotal =
        (asNumber(usage.input) ?? 0) +
        (asNumber(usage.output) ?? 0) +
        (asNumber(usage.cacheRead) ?? 0) +
        (asNumber(usage.cacheWrite) ?? 0);
      tokenUsage += totalTokens ?? fallbackTotal;
      const costValue = asNumber((usage.cost as Record<string, unknown> | undefined)?.total) ?? 0;
      cost += costValue;
    }
  }

  return {
    messages,
    forkPoints,
    stats: { messageCount: messages.length, tokenUsage, cost },
  };
}

function findLeafEntry(entries: SessionEntryBase[]): SessionEntryBase | null {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (!entry.id) {
      continue;
    }
    if (entry.type === "label") {
      continue;
    }
    return entry;
  }
  return null;
}

function buildPath(entryMap: Map<string, SessionEntryBase>, leafId: string): SessionEntryBase[] {
  const path: SessionEntryBase[] = [];
  const visited = new Set<string>();
  let current = entryMap.get(leafId);

  while (current && current.id && !visited.has(current.id)) {
    visited.add(current.id);
    path.push(current);
    const parentId = current.parentId ?? null;
    if (!parentId) {
      break;
    }
    current = entryMap.get(parentId) ?? null;
  }

  return path.reverse();
}

function toParsedMessage(entry: SessionEntryBase): ParsedMessage | null {
  if (!entry.id) {
    return null;
  }

  switch (entry.type) {
    case "message": {
      const messageEntry = entry as MessageEntry;
      return {
        id: messageEntry.id,
        parentId: messageEntry.parentId ?? null,
        role: messageEntry.message?.role ?? "assistant",
        content: messageEntry.message?.content ?? messageEntry.message ?? null,
        timestamp: messageEntry.timestamp ?? "",
        usage: messageEntry.message?.usage,
        model: messageEntry.message?.model ?? messageEntry.message?.modelId,
      };
    }
    case "custom_message": {
      const custom = entry as CustomMessageEntry;
      return {
        id: custom.id,
        parentId: custom.parentId ?? null,
        role: "custom",
        content: custom.content ?? null,
        timestamp: custom.timestamp ?? "",
      };
    }
    case "branch_summary": {
      const summary = entry as BranchSummaryEntry;
      return {
        id: summary.id,
        parentId: summary.parentId ?? null,
        role: "summary",
        content: {
          type: "branch_summary",
          summary: summary.summary ?? "",
          fromId: summary.fromId,
          details: summary.details,
        },
        timestamp: summary.timestamp ?? "",
      };
    }
    case "compaction": {
      return formatCompaction(entry as CompactionEntry);
    }
    default:
      return null;
  }
}

function formatCompaction(entry: CompactionEntry): ParsedMessage {
  return {
    id: entry.id ?? "",
    parentId: entry.parentId ?? null,
    role: "summary",
    content: {
      type: "compaction",
      summary: entry.summary ?? "",
      firstKeptEntryId: entry.firstKeptEntryId,
      tokensBefore: entry.tokensBefore,
      details: entry.details,
    },
    timestamp: entry.timestamp ?? "",
  };
}

function extractPreview(content: unknown): string {
  if (content == null) {
    return "";
  }
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    const textParts = content
      .map((part) => {
        if (typeof part === "string") {
          return part;
        }
        if (part && typeof part === "object" && "text" in part) {
          return String((part as { text?: unknown }).text ?? "");
        }
        return "";
      })
      .filter(Boolean);
    return textParts.join(" ").trim();
  }
  if (typeof content === "object" && "text" in (content as { text?: unknown })) {
    return String((content as { text?: unknown }).text ?? "").trim();
  }
  return "";
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (predicate(items[i])) {
      return i;
    }
  }
  return -1;
}

function parseTimestampFromFilename(value: string): string | undefined {
  const match = value.match(/^(\\d{4}-\\d{2}-\\d{2})T(\\d{2})-(\\d{2})-(\\d{2})-(\\d{3})Z$/);
  if (!match) {
    return undefined;
  }
  return `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}
