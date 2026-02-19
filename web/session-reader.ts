import { createReadStream, existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

export interface SessionSummary {
	id: string;
	file: string;
	name?: string;
	firstPrompt?: string;
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

type SessionInfo = {
	id: string;
	cwd: string;
	timestamp: string;
	parentSession?: string;
	name?: string;
	firstPrompt?: string;
	messageCount: number;
	lastMessage?: string;
};

const SESSION_INFO_CACHE = new Map<
	string,
	{ mtimeMs: number; info: SessionInfo }
>();

export async function listSessions(
	options: {
		cwd?: string;
		sessionDir?: string;
		offset?: number;
		limit?: number;
	} = {},
): Promise<{ total: number; sessions: SessionSummary[] }> {
	const {
		cwd,
		sessionDir = DEFAULT_SESSION_DIR,
		offset = 0,
		limit = 20,
	} = options;

	const files = await listSessionFiles(sessionDir);

	const sorted = files
		.map((file) => {
			const baseName = path.basename(file, ".jsonl");
			const [timestampPart] = baseName.split("_");
			const timestamp = parseTimestampFromFilename(timestampPart) ?? "";
			return { file, timestamp };
		})
		.filter((item) => Boolean(item.timestamp))
		.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

	const matchingFiles: string[] = [];
	for (const item of sorted) {
		if (cwd) {
			try {
				const header = normalizeHeader(
					await readSessionHeader(item.file),
					item.file,
				);
				if ((header.cwd ?? "") !== cwd) {
					continue;
				}
			} catch {
				continue;
			}
		}
		matchingFiles.push(item.file);
	}

	const total = matchingFiles.length;
	const pageFiles = matchingFiles.slice(offset, offset + limit);

	const sessions: SessionSummary[] = [];
	for (const file of pageFiles) {
		try {
			const info = await getSessionInfo(file);
			sessions.push({
				id: info.id,
				file,
				name: info.name,
				firstPrompt: info.firstPrompt,
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

	return { total, sessions };
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

export async function getSessionInfo(
	sessionFile: string,
): Promise<SessionInfo> {
	let mtimeMs = 0;
	try {
		const info = await stat(sessionFile);
		mtimeMs = info.mtimeMs;
		const cached = SESSION_INFO_CACHE.get(sessionFile);
		if (cached && cached.mtimeMs === mtimeMs) {
			return cached.info;
		}
	} catch {
		// File might not exist or be unreadable — fall through.
	}

	const parsed = await computeSessionInfo(sessionFile);
	if (mtimeMs) {
		SESSION_INFO_CACHE.set(sessionFile, { mtimeMs, info: parsed });
	}
	return parsed;
}

async function computeSessionInfo(sessionFile: string): Promise<SessionInfo> {
	let header: SessionHeader | null = null;
	let name: string | undefined;
	let firstPrompt: string | undefined;
	let messageCount = 0;
	let lastMessageLine: string | null = null;

	const stream = createReadStream(sessionFile, { encoding: "utf8" });
	const rl = createInterface({ input: stream, crlfDelay: Infinity });

	try {
		for await (const line of rl) {
			const trimmed = line.trim();
			if (!trimmed) {
				continue;
			}

			if (!header) {
				try {
					const parsedHeader = JSON.parse(trimmed);
					if (parsedHeader?.type === "session") {
						header = parsedHeader as SessionHeader;
						continue;
					}
				} catch {
					// ignore
				}
			}

			if (
				!name &&
				trimmed.startsWith('{"type":"session_info"') &&
				trimmed.includes('"name"')
			) {
				try {
					const parsedInfo = JSON.parse(trimmed) as SessionInfoEntry;
					if (parsedInfo.type === "session_info" && parsedInfo.name) {
						name = parsedInfo.name;
					}
				} catch {
					// ignore
				}
				continue;
			}

			if (trimmed.startsWith('{"type":"message"')) {
				messageCount += 1;
				lastMessageLine = trimmed;

				if (!firstPrompt && trimmed.includes('"role":"user"')) {
					try {
						const parsedMessage = JSON.parse(trimmed) as MessageEntry;
						if (
							parsedMessage.type === "message" &&
							parsedMessage.message?.role === "user"
						) {
							const preview = extractPreview(parsedMessage.message.content);
							if (preview) {
								firstPrompt = preview;
							}
						}
					} catch {
						// ignore
					}
				}
			}
		}
	} finally {
		rl.close();
		stream.destroy();
	}

	const normalized = normalizeHeader(header, sessionFile);

	let lastMessage: string | undefined;
	if (lastMessageLine) {
		try {
			const parsedMessage = JSON.parse(lastMessageLine) as MessageEntry;
			if (parsedMessage.type === "message") {
				const preview = extractPreview(parsedMessage.message?.content);
				if (preview) {
					lastMessage = preview;
				}
			}
		} catch {
			// ignore
		}
	}

	return {
		id: normalized.id,
		cwd: normalized.cwd ?? "",
		timestamp: normalized.timestamp ?? "",
		parentSession: normalized.parentSession,
		name,
		firstPrompt,
		messageCount,
		lastMessage,
	};
}

export async function findSessionFileById(
	sessionId: string,
	sessionDir = DEFAULT_SESSION_DIR,
): Promise<string | null> {
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
		} catch {}
	}

	return null;
}

const SKIP_SESSION_DIR_NAMES = new Set([
	"subagent-artifacts",
	".git",
	"node_modules",
]);

async function listSessionFiles(dir: string): Promise<string[]> {
	const files: string[] = [];
	if (!existsSync(dir)) {
		return files;
	}

	const entries = await readdir(dir, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = path.join(dir, entry.name);

		if (entry.isDirectory()) {
			if (SKIP_SESSION_DIR_NAMES.has(entry.name)) {
				continue;
			}
			const nested = await listSessionFiles(fullPath);
			files.push(...nested);
			continue;
		}

		if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
			continue;
		}

		// Only include actual session logs (timestamp-prefixed filenames) and skip subagent artifacts.
		const baseName = path.basename(entry.name, ".jsonl");
		const [timestampPart] = baseName.split("_");
		if (!parseTimestampFromFilename(timestampPart)) {
			continue;
		}

		files.push(fullPath);
	}

	return files;
}

async function loadSessionEntries(sessionFile: string): Promise<{
	header: SessionHeader | null;
	entries: SessionEntryBase[];
	entryMap: Map<string, SessionEntryBase>;
	name?: string;
}> {
	const entries: SessionEntryBase[] = [];
	let header: SessionHeader | null = null;
	let name: string | undefined;
	const entryMap = new Map<string, SessionEntryBase>();

	const stream = createReadStream(sessionFile, { encoding: "utf8" });
	const rl = createInterface({ input: stream, crlfDelay: Infinity });

	try {
		for await (const line of rl) {
			const trimmed = line.trim();
			if (!trimmed) {
				continue;
			}

			let parsed: SessionEntryBase | null = null;
			try {
				parsed = JSON.parse(trimmed) as SessionEntryBase;
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
	} finally {
		rl.close();
		stream.destroy();
	}

	return { header, entries, entryMap, name };
}

async function readFirstNonEmptyLine(filePath: string): Promise<string | null> {
	const stream = createReadStream(filePath, { encoding: "utf8" });
	const rl = createInterface({ input: stream, crlfDelay: Infinity });

	try {
		for await (const line of rl) {
			const trimmed = line.trim();
			if (trimmed.length > 0) {
				return trimmed;
			}
		}
	} finally {
		rl.close();
		stream.destroy();
	}

	return null;
}

async function readSessionHeader(
	sessionFile: string,
): Promise<SessionHeader | null> {
	const line = await readFirstNonEmptyLine(sessionFile);
	if (!line) {
		return null;
	}
	try {
		const parsed = JSON.parse(line);
		if (parsed?.type === "session") {
			return parsed as SessionHeader;
		}
	} catch {
		// ignore
	}
	return null;
}

function normalizeHeader(
	header: SessionHeader | null,
	sessionFile?: string,
): SessionHeader {
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

function buildSessionContext(
	entries: SessionEntryBase[],
	entryMap: Map<string, SessionEntryBase>,
): {
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

	const entryPath = buildPath(entryMap, leaf.id);
	const compactionIndex = findLastIndex(
		entryPath,
		(entry) => entry.type === "compaction",
	);
	let startIndex = 0;
	let compactionSummary: ParsedMessage | null = null;

	if (compactionIndex >= 0) {
		const compaction = entryPath[compactionIndex] as CompactionEntry;
		compactionSummary = formatCompaction(compaction);
		if (compaction.firstKeptEntryId) {
			const keptIndex = entryPath.findIndex(
				(entry) => entry.id === compaction.firstKeptEntryId,
			);
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

	const pathSlice = entryPath.slice(startIndex);
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
			const input =
				asNumber(usage.input) ??
				asNumber(usage.promptTokens) ??
				asNumber(usage.prompt_tokens) ??
				asNumber(usage.inputTokens) ??
				asNumber(usage.input_tokens) ??
				0;
			const output =
				asNumber(usage.output) ??
				asNumber(usage.completionTokens) ??
				asNumber(usage.completion_tokens) ??
				asNumber(usage.outputTokens) ??
				asNumber(usage.output_tokens) ??
				0;
			const cacheRead =
				asNumber(usage.cacheRead) ??
				asNumber(usage.cache_read) ??
				asNumber(usage.cacheReadTokens) ??
				asNumber(usage.cache_read_input_tokens) ??
				0;
			const cacheWrite =
				asNumber(usage.cacheWrite) ??
				asNumber(usage.cache_write) ??
				asNumber(usage.cacheCreation) ??
				asNumber(usage.cacheCreationInputTokens) ??
				asNumber(usage.cache_creation_input_tokens) ??
				0;

			const totalTokens =
				asNumber(usage.totalTokens) ??
				asNumber(usage.total_tokens) ??
				asNumber(usage.total) ??
				asNumber(usage.tokens);
			tokenUsage += totalTokens ?? input + output + cacheRead + cacheWrite;

			const costObj =
				typeof usage.cost === "object" && usage.cost
					? (usage.cost as Record<string, unknown>)
					: undefined;
			const costValue =
				asNumber(costObj?.total) ??
				asNumber(usage.costTotal) ??
				asNumber(usage.totalCost) ??
				asNumber(usage.usd) ??
				asNumber(usage.cost);
			if (costValue != null) {
				cost += costValue;
			} else if (costObj) {
				cost +=
					(asNumber(costObj.input) ?? 0) +
					(asNumber(costObj.output) ?? 0) +
					(asNumber(costObj.cacheRead ?? costObj.cache_read) ?? 0) +
					(asNumber(costObj.cacheWrite ?? costObj.cache_write) ?? 0);
			}
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

function buildPath(
	entryMap: Map<string, SessionEntryBase>,
	leafId: string,
): SessionEntryBase[] {
	const path: SessionEntryBase[] = [];
	const visited = new Set<string>();
	let current = entryMap.get(leafId);

	while (current?.id && !visited.has(current.id)) {
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
	if (
		typeof content === "object" &&
		"text" in (content as { text?: unknown })
	) {
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
	const match = value.match(
		/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
	);
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
