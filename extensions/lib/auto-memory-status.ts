import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { withFileLock } from "./file-lock.ts";

const HOME = os.homedir();
const RHO_DIR = path.join(HOME, ".rho");
const BRAIN_DIR = path.join(RHO_DIR, "brain");

export const AUTO_MEMORY_LOG_PATH = path.join(
	BRAIN_DIR,
	"auto-memory-log.jsonl",
);
export const AUTO_MEMORY_LOG_LOCK_PATH = `${AUTO_MEMORY_LOG_PATH}.lock`;
export const AUTO_MEMORY_STATUS_PATH = path.join(
	BRAIN_DIR,
	"auto-memory-status.json",
);
export const AUTO_MEMORY_STATUS_LOCK_PATH = `${AUTO_MEMORY_STATUS_PATH}.lock`;
export const AUTO_MEMORY_CURSOR_PATH = path.join(
	BRAIN_DIR,
	"auto-memory-cursors.json",
);
export const AUTO_MEMORY_CURSOR_LOCK_PATH = `${AUTO_MEMORY_CURSOR_PATH}.lock`;

export type AutoMemoryStatusPhase = "idle" | "queued" | "running" | "error";

export interface AutoMemoryStatusSnapshot {
	phase: AutoMemoryStatusPhase;
	pendingCount: number;
	activeRunId: string | null;
	activeSessionId: string | null;
	activeLeafId: string | null;
	queuedAt: string | null;
	startedAt: string | null;
	finishedAt: string | null;
	lastRunId: string | null;
	lastStatus: "ok" | "no_response" | "parse_failed" | "error" | null;
	lastSavedTotal: number;
	lastError: string | null;
	updatedAt: string;
}

export interface AutoMemoryCursor {
	processedCount: number;
	lastProcessedHash: string | null;
	updatedAt: string;
}

function defaultStatusSnapshot(): AutoMemoryStatusSnapshot {
	return {
		phase: "idle",
		pendingCount: 0,
		activeRunId: null,
		activeSessionId: null,
		activeLeafId: null,
		queuedAt: null,
		startedAt: null,
		finishedAt: null,
		lastRunId: null,
		lastStatus: null,
		lastSavedTotal: 0,
		lastError: null,
		updatedAt: new Date().toISOString(),
	};
}

function parseStatusSnapshot(raw: string): AutoMemoryStatusSnapshot | null {
	try {
		const parsed = JSON.parse(raw) as Partial<AutoMemoryStatusSnapshot>;
		if (!parsed || typeof parsed !== "object") return null;
		const base = defaultStatusSnapshot();
		const phase =
			parsed.phase === "queued" ||
			parsed.phase === "running" ||
			parsed.phase === "error" ||
			parsed.phase === "idle"
				? parsed.phase
				: base.phase;
		const lastStatus =
			parsed.lastStatus === "ok" ||
			parsed.lastStatus === "no_response" ||
			parsed.lastStatus === "parse_failed" ||
			parsed.lastStatus === "error"
				? parsed.lastStatus
				: null;
		return {
			phase,
			pendingCount:
				typeof parsed.pendingCount === "number" &&
				Number.isFinite(parsed.pendingCount)
					? Math.max(0, Math.floor(parsed.pendingCount))
					: base.pendingCount,
			activeRunId:
				typeof parsed.activeRunId === "string" && parsed.activeRunId.trim()
					? parsed.activeRunId
					: null,
			activeSessionId:
				typeof parsed.activeSessionId === "string" &&
				parsed.activeSessionId.trim()
					? parsed.activeSessionId
					: null,
			activeLeafId:
				typeof parsed.activeLeafId === "string" && parsed.activeLeafId.trim()
					? parsed.activeLeafId
					: null,
			queuedAt:
				typeof parsed.queuedAt === "string" && parsed.queuedAt.trim()
					? parsed.queuedAt
					: null,
			startedAt:
				typeof parsed.startedAt === "string" && parsed.startedAt.trim()
					? parsed.startedAt
					: null,
			finishedAt:
				typeof parsed.finishedAt === "string" && parsed.finishedAt.trim()
					? parsed.finishedAt
					: null,
			lastRunId:
				typeof parsed.lastRunId === "string" && parsed.lastRunId.trim()
					? parsed.lastRunId
					: null,
			lastStatus,
			lastSavedTotal:
				typeof parsed.lastSavedTotal === "number" &&
				Number.isFinite(parsed.lastSavedTotal)
					? Math.max(0, Math.floor(parsed.lastSavedTotal))
					: base.lastSavedTotal,
			lastError:
				typeof parsed.lastError === "string" && parsed.lastError.trim()
					? parsed.lastError
					: null,
			updatedAt:
				typeof parsed.updatedAt === "string" && parsed.updatedAt.trim()
					? parsed.updatedAt
					: base.updatedAt,
		};
	} catch {
		return null;
	}
}

export function readAutoMemoryStatus(): AutoMemoryStatusSnapshot | null {
	try {
		return parseStatusSnapshot(
			fs.readFileSync(AUTO_MEMORY_STATUS_PATH, "utf-8"),
		);
	} catch {
		return null;
	}
}

export async function updateAutoMemoryStatus(
	patch: Partial<AutoMemoryStatusSnapshot>,
): Promise<AutoMemoryStatusSnapshot> {
	return withFileLock(
		AUTO_MEMORY_STATUS_LOCK_PATH,
		{ purpose: "auto-memory-status" },
		async () => {
			const current = readAutoMemoryStatus() ?? defaultStatusSnapshot();
			const next: AutoMemoryStatusSnapshot = {
				...current,
				...patch,
				updatedAt: new Date().toISOString(),
			};
			fs.mkdirSync(path.dirname(AUTO_MEMORY_STATUS_PATH), { recursive: true });
			fs.writeFileSync(
				AUTO_MEMORY_STATUS_PATH,
				`${JSON.stringify(next, null, 2)}\n`,
				"utf-8",
			);
			return next;
		},
	);
}

export async function appendAutoMemoryLog(
	entry: Record<string, unknown>,
): Promise<void> {
	try {
		await withFileLock(
			AUTO_MEMORY_LOG_LOCK_PATH,
			{ purpose: "auto-memory-log" },
			async () => {
				fs.mkdirSync(path.dirname(AUTO_MEMORY_LOG_PATH), { recursive: true });
				const fd = fs.openSync(
					AUTO_MEMORY_LOG_PATH,
					fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY,
					0o644,
				);
				try {
					fs.writeSync(fd, `${JSON.stringify(entry)}\n`);
				} finally {
					fs.closeSync(fd);
				}
			},
		);
	} catch {
		// Best effort.
	}
}

export function readRecentAutoMemoryRuns(
	limit = 10,
): Array<Record<string, unknown>> {
	if (limit <= 0) return [];
	let raw = "";
	try {
		raw = fs.readFileSync(AUTO_MEMORY_LOG_PATH, "utf-8");
	} catch {
		return [];
	}

	const out: Array<Record<string, unknown>> = [];
	const lines = raw.split("\n").filter((line) => line.trim().length > 0);
	for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
		try {
			const parsed = JSON.parse(lines[i]) as Record<string, unknown>;
			if (parsed?.type === "auto_memory_run") out.push(parsed);
		} catch {
			// Skip bad lines.
		}
	}
	return out;
}

function parseCursorMap(raw: string): Record<string, AutoMemoryCursor> {
	try {
		const parsed = JSON.parse(raw) as Record<string, Partial<AutoMemoryCursor>>;
		if (!parsed || typeof parsed !== "object") return {};
		const out: Record<string, AutoMemoryCursor> = {};
		for (const [key, value] of Object.entries(parsed)) {
			if (!value || typeof value !== "object") continue;
			const processedCount =
				typeof value.processedCount === "number" &&
				Number.isFinite(value.processedCount)
					? Math.max(0, Math.floor(value.processedCount))
					: 0;
			const lastProcessedHash =
				typeof value.lastProcessedHash === "string" &&
				value.lastProcessedHash.trim()
					? value.lastProcessedHash
					: null;
			const updatedAt =
				typeof value.updatedAt === "string" && value.updatedAt.trim()
					? value.updatedAt
					: new Date(0).toISOString();
			out[key] = { processedCount, lastProcessedHash, updatedAt };
		}
		return out;
	} catch {
		return {};
	}
}

export function readAutoMemoryCursors(): Record<string, AutoMemoryCursor> {
	try {
		return parseCursorMap(fs.readFileSync(AUTO_MEMORY_CURSOR_PATH, "utf-8"));
	} catch {
		return {};
	}
}

export async function writeAutoMemoryCursor(
	key: string,
	cursor: AutoMemoryCursor,
): Promise<void> {
	if (!key.trim()) return;
	await withFileLock(
		AUTO_MEMORY_CURSOR_LOCK_PATH,
		{ purpose: "auto-memory-cursor" },
		async () => {
			const current = readAutoMemoryCursors();
			current[key] = cursor;
			fs.mkdirSync(path.dirname(AUTO_MEMORY_CURSOR_PATH), { recursive: true });
			fs.writeFileSync(
				AUTO_MEMORY_CURSOR_PATH,
				`${JSON.stringify(current, null, 2)}\n`,
				"utf-8",
			);
		},
	);
}
