import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import {
	listSessionFiles,
	loadSessionEntries,
	normalizeHeader,
	readSessionHeader,
} from "./session-reader-io.ts";
import {
	buildSessionContext,
	extractPreview,
	parseTimestampFromFilename,
} from "./session-reader-parse.ts";
import {
	DEFAULT_SESSION_DIR,
	type MessageEntry,
	type ParsedSession,
	type SessionHeader,
	type SessionInfo,
	type SessionInfoEntry,
	type SessionSummary,
} from "./session-reader-types.ts";

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
		} catch {
			// ignore unreadable files
		}
	}

	return null;
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
