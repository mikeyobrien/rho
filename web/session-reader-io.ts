import { createReadStream, existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

import { parseTimestampFromFilename } from "./session-reader-parse.ts";
import type {
	SessionEntryBase,
	SessionHeader,
	SessionInfoEntry,
} from "./session-reader-types.ts";

const SKIP_SESSION_DIR_NAMES = new Set([
	"subagent-artifacts",
	".git",
	"node_modules",
]);

export async function listSessionFiles(dir: string): Promise<string[]> {
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

		const baseName = path.basename(entry.name, ".jsonl");
		const [timestampPart] = baseName.split("_");
		if (!parseTimestampFromFilename(timestampPart)) {
			continue;
		}

		files.push(fullPath);
	}

	return files;
}

export async function loadSessionEntries(sessionFile: string): Promise<{
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

export async function readSessionHeader(
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

export function normalizeHeader(
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
