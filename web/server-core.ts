import { execFile as execFileCb } from "node:child_process";
import crypto from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import type { Context } from "hono";
import { Hono } from "hono";
import { compress } from "hono/compress";
import type { WSContext } from "hono/ws";
import type { WebSocket } from "ws";
import {
	BRAIN_PATH,
	type BehaviorEntry,
	type BrainEntry,
	type ContextEntry,
	type IdentityEntry,
	type LearningEntry,
	type PreferenceEntry,
	type ReminderEntry,
	type TaskEntry,
	type UserEntry,
	appendBrainEntry,
	foldBrain,
	readBrain,
} from "../extensions/lib/brain-store.ts";
import { getRhoHome } from "./config.ts";
import {
	type ReviewStatus,
	ReviewStoreError,
	type StoredReviewRecord,
	cancelReviewRecord,
	claimReviewRecord,
	createReviewRecord,
	getReviewRecord,
	listReviewRecords,
	resolveReviewRecord,
	submitReviewRecord,
} from "./review-store.ts";
import {
	type RPCCommand,
	type RPCEvent,
	getRpcSessionFile,
	rpcManager,
} from "./rpc-manager.ts";
import { RpcSessionReliability } from "./rpc-reliability.ts";
import {
	findSessionFileById,
	listSessions,
	readSession,
} from "./session-reader.ts";
import {
	createTask,
	deleteTask,
	listAllTasks,
	updateTask,
} from "./task-api.ts";

const app = new Hono();
app.use(compress());

// Optional timing middleware when RHO_DEBUG=1
if (process.env.RHO_DEBUG === "1") {
	app.use("*", async (c, next) => {
		const start = Date.now();
		await next();
		const duration = Date.now() - start;
		console.log(`${c.req.method} ${c.req.path} ${duration}ms`);
	});
}

const publicDir = path.resolve(
	path.dirname(new URL(import.meta.url).pathname),
	"public",
);
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });

const rpcSessionSubscribers = new Map<
	WSContext<WebSocket>,
	Map<string, () => void>
>();

function readNumericEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) {
		return fallback;
	}
	const parsed = Number(raw);
	if (!Number.isFinite(parsed)) {
		return fallback;
	}
	return parsed;
}

const rpcReliability = new RpcSessionReliability({
	eventBufferSize: readNumericEnv("RHO_RPC_EVENT_BUFFER_SIZE", 800),
	commandRetentionMs: readNumericEnv("RHO_RPC_COMMAND_RETENTION_MS", 300000),
	orphanGraceMs: readNumericEnv("RHO_RPC_ORPHAN_GRACE_MS", 60000),
	orphanAbortDelayMs: readNumericEnv("RHO_RPC_ORPHAN_ABORT_DELAY_MS", 5000),
	hasSubscribers: (sessionId) => rpcManager.hasSubscribers(sessionId),
	onAbort: (sessionId) => {
		try {
			rpcManager.sendCommand(sessionId, {
				type: "abort",
				id: `orphan-abort-${Date.now()}`,
			});
		} catch {
			// Ignore abort delivery failures.
		}
	},
	onStop: (sessionId) => {
		rpcManager.stopSession(sessionId);
	},
});

let sessionManagerModulePromise: Promise<{
	SessionManager: {
		open(path: string): {
			createBranchedSession(leafId: string): string | undefined;
		};
	};
}> | null = null;

type WSIncomingMessage = {
	type?: string;
	sessionId?: string;
	sessionIdHint?: string;
	sessionFile?: string;
	lastEventSeq?: number;
	ts?: number;
	command?: RPCCommand;
};

// --- Review (line-level commenting) ---

type ReviewFile = {
	path: string;
	relativePath: string;
	content: string;
	language: string;
};

type ReviewComment = {
	file: string;
	startLine: number;
	endLine: number;
	selectedText: string;
	comment: string;
};

type ReviewSession = {
	id: string;
	token: string;
	files: ReviewFile[];
	warnings: string[];
	message?: string;
	createdAt: number;
	done: boolean;
	result: { cancelled: boolean; comments: ReviewComment[] } | null;
	toolSockets: Set<WSContext<WebSocket>>;
	uiSockets: Set<WSContext<WebSocket>>;
};

const reviewSessions = new Map<string, ReviewSession>();

function getReviewSession(id: string): ReviewSession | null {
	return reviewSessions.get(id) ?? null;
}

function requireReviewToken(c: Context, session: ReviewSession): boolean {
	const token = c.req.query("token");
	return typeof token === "string" && token === session.token;
}

function toReviewSessionListItem(session: ReviewSession) {
	return {
		id: session.id,
		fileCount: session.files.length,
		files: session.files.map((f) => f.relativePath),
		message: session.message ?? null,
		createdAt: session.createdAt,
		done: session.done,
		cancelled: session.result?.cancelled ?? null,
		commentCount: session.result?.comments?.length ?? 0,
		token: session.token,
	};
}

function toSubmissionSummary(record: StoredReviewRecord) {
	return {
		id: record.id,
		status: record.status,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		submittedAt: record.submittedAt,
		claimedAt: record.claimedAt,
		claimedBy: record.claimedBy,
		resolvedAt: record.resolvedAt,
		resolvedBy: record.resolvedBy,
		fileCount: record.request.files.length,
		files: record.request.files,
		message: record.request.message ?? null,
		commentCount: record.resultSummary.commentCount,
	};
}

function parseReviewListStatus(
	raw: string | undefined,
): ReviewStatus | "inbox" | "all" {
	if (!raw) return "inbox";
	const status = raw.toLowerCase();
	if (
		status === "open" ||
		status === "submitted" ||
		status === "cancelled" ||
		status === "claimed" ||
		status === "resolved" ||
		status === "all" ||
		status === "inbox"
	) {
		return status;
	}
	return "inbox";
}

async function persistOpenReviewSession(
	session: ReviewSession,
	request: {
		cwd?: string;
		branch?: string;
		commit?: string;
		source?: "tool" | "git" | "manual";
	},
): Promise<void> {
	await createReviewRecord({
		id: session.id,
		createdAt: session.createdAt,
		request: {
			files: session.files.map((f) => f.relativePath),
			warnings: session.warnings,
			message: session.message,
			cwd: request.cwd,
			branch: request.branch,
			commit: request.commit,
			source: request.source,
		},
	});
}

async function persistReviewCompletion(session: ReviewSession): Promise<void> {
	if (!session.result) return;
	if (session.result.cancelled) {
		await cancelReviewRecord(session.id);
		return;
	}
	await submitReviewRecord(session.id, session.result.comments);
}

function mapReviewStoreError(error: unknown): {
	status: number;
	message: string;
} {
	if (!(error instanceof ReviewStoreError)) {
		return {
			status: 500,
			message: (error as Error).message || "Internal review store error",
		};
	}
	if (error.code === "NOT_FOUND") {
		return { status: 404, message: error.message };
	}
	if (error.code === "CONFLICT") {
		return { status: 409, message: error.message };
	}
	if (error.code === "INVALID_STATE" || error.code === "INVALID_INPUT") {
		return { status: 400, message: error.message };
	}
	return { status: 500, message: error.message };
}

function sendWsMessage(
	ws: WSContext<WebSocket>,
	message: Record<string, unknown>,
): void {
	ws.send(JSON.stringify(message));
}

function subscribeToRpcSession(
	ws: WSContext<WebSocket>,
	sessionId: string,
): void {
	rpcReliability.cancelOrphan(sessionId);

	let subscriptions = rpcSessionSubscribers.get(ws);
	if (!subscriptions) {
		subscriptions = new Map<string, () => void>();
		rpcSessionSubscribers.set(ws, subscriptions);
	}

	if (subscriptions.has(sessionId)) {
		return;
	}

	const unsubscribe = rpcManager.onEvent(sessionId, (event: RPCEvent) => {
		const seq = rpcReliability.recordEvent(sessionId, event);
		try {
			sendWsMessage(ws, { type: "rpc_event", sessionId, seq, event });
			if (
				event.type === "rpc_session_stopped" ||
				event.type === "rpc_process_crashed"
			) {
				rpcReliability.clearSession(sessionId);
			}
		} catch {
			const wsSubscriptions = rpcSessionSubscribers.get(ws);
			wsSubscriptions?.get(sessionId)?.();
			wsSubscriptions?.delete(sessionId);
			if (wsSubscriptions && wsSubscriptions.size === 0) {
				rpcSessionSubscribers.delete(ws);
			}
			if (!rpcManager.hasSubscribers(sessionId)) {
				rpcReliability.scheduleOrphan(sessionId);
			}
		}
	});

	subscriptions.set(sessionId, unsubscribe);
}

function clearRpcSubscriptions(ws: WSContext<WebSocket>): void {
	const subscriptions = rpcSessionSubscribers.get(ws);
	if (!subscriptions) {
		return;
	}

	const sessionIds = [...subscriptions.keys()];
	for (const unsubscribe of subscriptions.values()) {
		unsubscribe();
	}
	rpcSessionSubscribers.delete(ws);

	for (const sessionId of sessionIds) {
		if (!rpcManager.hasSubscribers(sessionId)) {
			rpcReliability.scheduleOrphan(sessionId);
		}
	}
}

function extractSessionFile(payload: WSIncomingMessage): string | null {
	if (typeof payload.sessionFile === "string" && payload.sessionFile.trim()) {
		return payload.sessionFile.trim();
	}

	return getRpcSessionFile(payload.command);
}

function parseLastEventSeq(payload: WSIncomingMessage): number {
	if (typeof payload.lastEventSeq !== "number") {
		return 0;
	}
	if (!Number.isFinite(payload.lastEventSeq)) {
		return 0;
	}
	return Math.max(0, Math.floor(payload.lastEventSeq));
}

function replayBufferedRpcEvents(
	ws: WSContext<WebSocket>,
	sessionId: string,
	lastEventSeq: number,
): void {
	const replay = rpcReliability.getReplay(sessionId, lastEventSeq);
	if (replay.gap) {
		sendWsMessage(ws, {
			type: "rpc_replay_gap",
			sessionId,
			oldestSeq: replay.oldestSeq,
			latestSeq: replay.latestSeq,
		});
	}

	for (const buffered of replay.events) {
		sendWsMessage(ws, {
			type: "rpc_event",
			sessionId,
			seq: buffered.seq,
			replay: true,
			event: buffered.event,
		});
	}
}

async function loadPiSessionManagerModule(): Promise<{
	SessionManager: {
		open(path: string): {
			createBranchedSession(leafId: string): string | undefined;
		};
	};
}> {
	if (!sessionManagerModulePromise) {
		sessionManagerModulePromise = (async () => {
			try {
				const mod = await import("@mariozechner/pi-coding-agent");
				if (mod?.SessionManager) {
					return mod as {
						SessionManager: {
							open(path: string): {
								createBranchedSession(leafId: string): string | undefined;
							};
						};
					};
				}
			} catch {
				// Fall through to global install fallback.
			}

			const homeDir = process.env.HOME ?? "";
			// Resolve actual npm prefix (supports nvm), fall back to ~/.npm-global
			let prefix = path.join(homeDir, ".npm-global");
			try {
				const { execSync } = await import("node:child_process");
				prefix = execSync("npm config get prefix", {
					encoding: "utf-8",
				}).trim();
			} catch {
				// npm not available, use default prefix
			}
			const fallbackPath = path.join(
				prefix,
				"lib",
				"node_modules",
				"@mariozechner",
				"pi-coding-agent",
				"dist",
				"index.js",
			);
			const mod = await import(pathToFileURL(fallbackPath).href);
			if (!mod?.SessionManager) {
				throw new Error(
					"SessionManager export not found in pi-coding-agent module",
				);
			}
			return mod as {
				SessionManager: {
					open(path: string): {
						createBranchedSession(leafId: string): string | undefined;
					};
				};
			};
		})();
	}

	return sessionManagerModulePromise;
}

export {
	app,
	publicDir,
	upgradeWebSocket,
	rpcReliability,
	rpcSessionSubscribers,
	readNumericEnv,
	reviewSessions,
	getReviewSession,
	requireReviewToken,
	toReviewSessionListItem,
	toSubmissionSummary,
	parseReviewListStatus,
	persistOpenReviewSession,
	persistReviewCompletion,
	mapReviewStoreError,
	sendWsMessage,
	subscribeToRpcSession,
	clearRpcSubscriptions,
	extractSessionFile,
	parseLastEventSeq,
	replayBufferedRpcEvents,
	loadPiSessionManagerModule,
	rpcManager,
	injectWebSocket,
};

export type { WSIncomingMessage, ReviewFile, ReviewComment, ReviewSession };

export default app;
