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
	appendBrainEntry,
	type BehaviorEntry,
	BRAIN_PATH,
	type BrainEntry,
	type ContextEntry,
	foldBrain,
	type IdentityEntry,
	type LearningEntry,
	type PreferenceEntry,
	type ReminderEntry,
	readBrain,
	type TaskEntry,
	type UserEntry,
} from "../extensions/lib/brain-store.ts";
import { getRhoHome } from "./config.ts";
import {
	cancelReviewRecord,
	claimReviewRecord,
	createReviewRecord,
	getReviewRecord,
	listReviewRecords,
	type ReviewStatus,
	ReviewStoreError,
	resolveReviewRecord,
	type StoredReviewRecord,
	submitReviewRecord,
} from "./review-store.ts";
import {
	getRpcSessionFile,
	type RPCCommand,
	type RPCEvent,
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
export { injectWebSocket };

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

// --- Health ---

app.get("/api/health", (c) => c.json({ status: "ok" }));

// --- Review API ---

app.get("/api/review/sessions", (c) => {
	const sessions = [...reviewSessions.values()].map(toReviewSessionListItem);
	sessions.sort((a, b) => b.createdAt - a.createdAt);
	return c.json(sessions);
});

app.post("/api/review/sessions", async (c) => {
	let body: { files?: ReviewFile[]; warnings?: string[]; message?: string };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid JSON body" }, 400);
	}

	const files = Array.isArray(body.files) ? body.files : [];
	if (files.length === 0) {
		return c.json({ error: "files is required" }, 400);
	}

	const id = crypto.randomUUID();
	const token = crypto.randomUUID().replace(/-/g, "");
	const session: ReviewSession = {
		id,
		token,
		files,
		warnings: Array.isArray(body.warnings) ? body.warnings : [],
		message: typeof body.message === "string" ? body.message : undefined,
		createdAt: Date.now(),
		done: false,
		result: null,
		toolSockets: new Set(),
		uiSockets: new Set(),
	};

	reviewSessions.set(id, session);
	try {
		await persistOpenReviewSession(session, { source: "tool" });
	} catch (error) {
		reviewSessions.delete(id);
		return c.json(
			{ error: (error as Error).message ?? "Failed to persist review" },
			500,
		);
	}

	const openTtlMs = readNumericEnv(
		"RHO_REVIEW_OPEN_TTL_MS",
		24 * 60 * 60 * 1000,
	);
	setTimeout(() => {
		const current = reviewSessions.get(id);
		if (!current) return;
		if (!current.done && Date.now() - current.createdAt > openTtlMs) {
			current.done = true;
			current.result = { cancelled: true, comments: [] };
			void persistReviewCompletion(current).catch((error) => {
				console.warn(
					`Failed to persist review auto-cancel for ${id}: ${(error as Error).message}`,
				);
			});
			reviewSessions.delete(id);
		}
	}, openTtlMs).unref?.();

	const origin = new URL(c.req.url).origin;
	const url = `${origin}/review/${id}?token=${token}`;
	return c.json({ id, token, url });
});

app.get("/api/review/submissions", async (c) => {
	const status = parseReviewListStatus(c.req.query("status"));
	const claimedBy = c.req.query("claimedBy");
	const limitRaw = Number(c.req.query("limit") ?? "50");
	const limit = Number.isFinite(limitRaw)
		? Math.max(1, Math.min(Math.floor(limitRaw), 200))
		: 50;

	try {
		const records = await listReviewRecords({ status, claimedBy, limit });
		return c.json(records.map(toSubmissionSummary));
	} catch (error) {
		return c.json(
			{ error: (error as Error).message ?? "Failed to list submissions" },
			500,
		);
	}
});

app.get("/api/review/submissions/:id", async (c) => {
	const id = c.req.param("id");
	const record = await getReviewRecord(id);
	if (!record) {
		return c.json({ error: "not found" }, 404);
	}
	return c.json(record);
});

app.post("/api/review/submissions/:id/claim", async (c) => {
	const id = c.req.param("id");
	let body: { claimedBy?: string } = {};
	try {
		body = await c.req.json();
	} catch {
		// optional body
	}

	const claimedBy =
		typeof body.claimedBy === "string" && body.claimedBy.trim()
			? body.claimedBy.trim()
			: "agent";

	try {
		const record = await claimReviewRecord(id, claimedBy);
		return c.json(toSubmissionSummary(record));
	} catch (error) {
		const mapped = mapReviewStoreError(error);
		return c.json({ error: mapped.message }, mapped.status);
	}
});

app.post("/api/review/submissions/:id/resolve", async (c) => {
	const id = c.req.param("id");
	let body: { resolvedBy?: string } = {};
	try {
		body = await c.req.json();
	} catch {
		// optional body
	}

	try {
		const record = await resolveReviewRecord(id, body.resolvedBy);
		return c.json(toSubmissionSummary(record));
	} catch (error) {
		const mapped = mapReviewStoreError(error);
		return c.json({ error: mapped.message }, mapped.status);
	}
});

app.delete("/api/review/sessions/:id", (c) => {
	const id = c.req.param("id");
	const session = getReviewSession(id);
	if (!session) return c.json({ error: "not found" }, 404);
	if (!requireReviewToken(c, session))
		return c.json({ error: "forbidden" }, 403);

	if (!session.done) {
		session.done = true;
		session.result = { cancelled: true, comments: [] };
		void persistReviewCompletion(session).catch((error) => {
			console.warn(
				`Failed to persist review cancel for ${id}: ${(error as Error).message}`,
			);
		});

		for (const toolWs of session.toolSockets) {
			try {
				sendWsMessage(toolWs, { type: "review_result", ...session.result });
			} catch {}
		}

		for (const uiWs of session.uiSockets) {
			try {
				uiWs.close();
			} catch {}
		}
	}

	reviewSessions.delete(id);
	return c.json({ ok: true });
});

app.get("/review", (c) => {
	return c.redirect("/?view=review", 302);
});

app.get("/review/:id", async (c) => {
	const id = c.req.param("id");
	const session = getReviewSession(id);
	if (!session) return c.text("Review session not found", 404);
	if (!requireReviewToken(c, session)) return c.text("Forbidden", 403);

	try {
		const template = await readFile(
			path.join(publicDir, "review", "index.html"),
			"utf-8",
		);
		const html = template
			.replace(/__SESSION_ID__/g, id)
			.replace(/__TOKEN__/g, session.token);
		return c.html(html);
	} catch (error) {
		return c.text((error as Error).message ?? "Failed to load review UI", 500);
	}
});

app.get("/review/:id/api/files", (c) => {
	const id = c.req.param("id");
	const session = getReviewSession(id);
	if (!session) return c.json({ error: "not found" }, 404);
	if (!requireReviewToken(c, session))
		return c.json({ error: "forbidden" }, 403);
	return c.json(session.files);
});

app.get("/review/:id/api/warnings", (c) => {
	const id = c.req.param("id");
	const session = getReviewSession(id);
	if (!session) return c.json({ error: "not found" }, 404);
	if (!requireReviewToken(c, session))
		return c.json({ error: "forbidden" }, 403);
	return c.json(session.warnings ?? []);
});

app.get("/review/:id/api/config", (c) => {
	const id = c.req.param("id");
	const session = getReviewSession(id);
	if (!session) return c.json({ error: "not found" }, 404);
	if (!requireReviewToken(c, session))
		return c.json({ error: "forbidden" }, 403);
	const cfg: Record<string, string> = {};
	if (session.message) cfg.message = session.message;
	return c.json(cfg);
});

app.get(
	"/review/:id/ws",
	upgradeWebSocket((c) => {
		const id = c.req.param("id");
		const session = getReviewSession(id);
		const token = c.req.query("token");
		const role = c.req.query("role") === "tool" ? "tool" : "ui";

		if (!session || typeof token !== "string" || token !== session.token) {
			return {
				onOpen: (_, ws) => {
					try {
						ws.close();
					} catch {}
				},
			};
		}

		return {
			onOpen: (_, ws) => {
				if (role === "tool") {
					session.toolSockets.add(ws);
					// If already done, send result immediately
					if (session.done && session.result) {
						sendWsMessage(ws, { type: "review_result", ...session.result });
					} else {
						sendWsMessage(ws, { type: "init" });
					}
				} else {
					session.uiSockets.add(ws);
					sendWsMessage(ws, { type: "init" });
				}
			},
			onMessage: (event, _ws) => {
				if (typeof event.data !== "string") return;
				if (role !== "ui") return;

				let msg: { type?: string; comments?: unknown[] };
				try {
					msg = JSON.parse(event.data);
				} catch {
					return;
				}

				if (session.done) {
					return;
				}

				if (msg?.type === "submit" && Array.isArray(msg.comments)) {
					session.done = true;
					session.result = {
						cancelled: false,
						comments: msg.comments as ReviewComment[],
					};
				} else if (msg?.type === "cancel") {
					session.done = true;
					session.result = { cancelled: true, comments: [] };
				} else {
					return;
				}

				void persistReviewCompletion(session).catch((error) => {
					console.warn(
						`Failed to persist review completion for ${id}: ${(error as Error).message}`,
					);
				});

				for (const toolWs of session.toolSockets) {
					try {
						sendWsMessage(toolWs, { type: "review_result", ...session.result });
					} catch {}
				}

				for (const uiWs of session.uiSockets) {
					try {
						uiWs.close();
					} catch {}
				}

				setTimeout(
					() => {
						reviewSessions.delete(id);
					},
					30 * 60 * 1000,
				).unref?.();
			},
			onClose: (_, ws) => {
				session.toolSockets.delete(ws);
				session.uiSockets.delete(ws);
			},
			onError: (_, ws) => {
				session.toolSockets.delete(ws);
				session.uiSockets.delete(ws);
			},
		};
	}),
);

// --- Git API ---

const execFileAsync = promisify(execFileCb);

interface GitContextFile {
	cwd: string;
	updatedAt: number;
	sessionFiles: string[];
}

async function readGitContext(): Promise<GitContextFile | null> {
	try {
		const raw = await readFile(
			path.join(getRhoHome(), "git-context.json"),
			"utf-8",
		);
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

async function getGitCwd(): Promise<string | null> {
	const ctx = await readGitContext();
	if (ctx?.cwd) {
		try {
			await execFileAsync("git", ["rev-parse", "--git-dir"], {
				cwd: ctx.cwd,
				timeout: 2000,
			});
			return ctx.cwd;
		} catch {
			/* not a git repo anymore */
		}
	}
	try {
		await execFileAsync("git", ["rev-parse", "--git-dir"], {
			cwd: process.cwd(),
			timeout: 2000,
		});
		return process.cwd();
	} catch {
		return null;
	}
}

async function gitExec(args: string[], cwd: string): Promise<string> {
	const { stdout } = await execFileAsync("git", args, {
		cwd,
		timeout: 10000,
		maxBuffer: 10 * 1024 * 1024,
	});
	return stdout;
}

interface GitStatusFile {
	path: string;
	index: string;
	worktree: string;
	status: string;
	statusLabel: string;
	additions: number;
	deletions: number;
	isSession: boolean;
}

function parseStatusLine(
	line: string,
): { index: string; worktree: string; path: string } | null {
	if (line.length < 4) return null;
	const index = line[0];
	const worktree = line[1];
	let filePath = line.slice(3);
	const renameIdx = filePath.indexOf(" -> ");
	if (renameIdx !== -1) filePath = filePath.slice(renameIdx + 4);
	return { index, worktree, path: filePath };
}

function classifyFile(
	index: string,
	worktree: string,
): { status: string; statusLabel: string } {
	if (index === "?" && worktree === "?")
		return { status: "untracked", statusLabel: "?" };
	if (index === "A") return { status: "added", statusLabel: "A" };
	if (index === "D" || worktree === "D")
		return { status: "deleted", statusLabel: "D" };
	if (index === "R") return { status: "renamed", statusLabel: "R" };
	return { status: "modified", statusLabel: "M" };
}

function parseNumstat(
	output: string,
): Map<string, { add: number; del: number }> {
	const map = new Map<string, { add: number; del: number }>();
	for (const line of output.trim().split("\n")) {
		if (!line) continue;
		const parts = line.split("\t");
		if (parts.length >= 3) {
			const add = parts[0] === "-" ? 0 : parseInt(parts[0]) || 0;
			const del = parts[1] === "-" ? 0 : parseInt(parts[1]) || 0;
			map.set(parts[2], { add, del });
		}
	}
	return map;
}

const GIT_LANG_MAP: Record<string, string> = {
	".ts": "typescript",
	".tsx": "typescript",
	".js": "javascript",
	".jsx": "javascript",
	".mjs": "javascript",
	".py": "python",
	".rs": "rust",
	".go": "go",
	".css": "css",
	".html": "html",
	".json": "json",
	".yaml": "yaml",
	".yml": "yaml",
	".sh": "bash",
	".md": "markdown",
	".toml": "toml",
};

function detectLang(filePath: string): string {
	return GIT_LANG_MAP[path.extname(filePath).toLowerCase()] ?? "plaintext";
}

const MAX_REVIEW_FILE_BYTES = 500 * 1024;
const BINARY_SNIFF_BYTES = 8192;

function resolveRepoFilePath(
	repoRoot: string,
	relOrAbsPath: string,
): { absPath: string; relPath: string } | null {
	if (
		!relOrAbsPath ||
		relOrAbsPath.includes("\0") ||
		relOrAbsPath.includes("..")
	) {
		return null;
	}
	if (path.isAbsolute(relOrAbsPath)) {
		return null;
	}
	const absPath = path.resolve(repoRoot, relOrAbsPath);
	const relPath = path.relative(repoRoot, absPath);
	if (!relPath || relPath.startsWith("..") || path.isAbsolute(relPath)) {
		return null;
	}
	return { absPath, relPath };
}

async function isLikelyBinaryFile(filePath: string): Promise<boolean> {
	const content = await readFile(filePath);
	const sample = content.subarray(0, BINARY_SNIFF_BYTES);
	return sample.includes(0);
}

app.get("/api/git/status", async (c) => {
	const cwd = await getGitCwd();
	if (!cwd) return c.json({ error: "No git repository detected" }, 404);

	const ctx = await readGitContext();
	const sessionFiles = new Set(ctx?.sessionFiles ?? []);

	try {
		const [branch, porcelain, numstatRaw, cachedNumstatRaw, logRaw] =
			await Promise.all([
				gitExec(["rev-parse", "--abbrev-ref", "HEAD"], cwd).catch(() => "HEAD"),
				gitExec(["status", "--porcelain=v1"], cwd).catch(() => ""),
				gitExec(["diff", "--numstat"], cwd).catch(() => ""),
				gitExec(["diff", "--cached", "--numstat"], cwd).catch(() => ""),
				gitExec(["log", "--oneline", "--format=%h\t%s", "-10"], cwd).catch(
					() => "",
				),
			]);

		const numstat = parseNumstat(numstatRaw);
		const cachedNumstat = parseNumstat(cachedNumstatRaw);

		const files: GitStatusFile[] = [];
		for (const line of porcelain.split("\n")) {
			const parsed = parseStatusLine(line);
			if (!parsed) continue;

			const { status, statusLabel } = classifyFile(
				parsed.index,
				parsed.worktree,
			);
			const stats = numstat.get(parsed.path) ??
				cachedNumstat.get(parsed.path) ?? { add: 0, del: 0 };

			files.push({
				path: parsed.path,
				index: parsed.index,
				worktree: parsed.worktree,
				status,
				statusLabel,
				additions: stats.add,
				deletions: stats.del,
				isSession: sessionFiles.has(parsed.path),
			});
		}

		const log = logRaw
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((l) => {
				const [hash, ...rest] = l.split("\t");
				return { hash, message: rest.join("\t") };
			});

		return c.json({
			cwd,
			branch: branch.trim(),
			files,
			log,
			sessionFiles: [...sessionFiles],
		});
	} catch (err) {
		return c.json({ error: (err as Error).message }, 500);
	}
});

app.get("/api/git/diff", async (c) => {
	const cwd = await getGitCwd();
	if (!cwd) return c.json({ error: "No git repository" }, 404);

	const file = c.req.query("file");
	if (!file) return c.json({ error: "file parameter required" }, 400);

	const resolved = resolveRepoFilePath(cwd, file);
	if (!resolved) return c.json({ error: "Invalid path" }, 400);
	const { absPath, relPath } = resolved;

	try {
		// Try unstaged
		const unstaged = await gitExec(["diff", "--", relPath], cwd);
		if (unstaged.trim()) return c.text(unstaged);

		// Try staged
		const staged = await gitExec(["diff", "--cached", "--", relPath], cwd);
		if (staged.trim()) return c.text(staged);

		// Untracked / new: synthetic full-add diff
		const fileInfo = await stat(absPath);
		if (fileInfo.size > MAX_REVIEW_FILE_BYTES) {
			return c.text("");
		}
		if (await isLikelyBinaryFile(absPath)) {
			return c.text("");
		}

		const content = await readFile(absPath, "utf-8");
		const lines = content.split("\n");
		let diff = `--- /dev/null\n+++ b/${relPath}\n`;
		diff += `@@ -0,0 +1,${lines.length} @@\n`;
		diff += lines.map((l) => `+${l}`).join("\n");
		return c.text(diff);
	} catch (err) {
		return c.json({ error: (err as Error).message }, 500);
	}
});

app.post("/api/review/from-git", async (c) => {
	const cwd = await getGitCwd();
	if (!cwd) return c.json({ error: "No git repository" }, 404);

	let body: { files?: string[]; message?: string };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid JSON" }, 400);
	}

	const filePaths = Array.isArray(body.files) ? body.files : [];
	if (filePaths.length === 0)
		return c.json({ error: "No files specified" }, 400);

	const reviewFiles: ReviewFile[] = [];
	const warnings: string[] = [];

	for (const fp of filePaths) {
		const resolved = resolveRepoFilePath(cwd, fp);
		if (!resolved) {
			warnings.push(`Skipped: ${fp} (invalid path)`);
			continue;
		}

		const { absPath, relPath } = resolved;
		try {
			const fileInfo = await stat(absPath);
			if (!fileInfo.isFile()) {
				warnings.push(`Skipped: ${fp} (not a file)`);
				continue;
			}
			if (fileInfo.size > MAX_REVIEW_FILE_BYTES) {
				warnings.push(
					`Skipped: ${fp} (file too large: ${Math.round(fileInfo.size / 1024)}KB)`,
				);
				continue;
			}
			if (await isLikelyBinaryFile(absPath)) {
				warnings.push(`Skipped: ${fp} (binary file)`);
				continue;
			}

			const content = await readFile(absPath, "utf-8");
			reviewFiles.push({
				path: absPath,
				relativePath: relPath,
				content,
				language: detectLang(relPath),
			});
		} catch (err) {
			warnings.push(`Skipped: ${fp} (${(err as Error).message})`);
		}
	}

	if (reviewFiles.length === 0)
		return c.json({ error: "No readable files" }, 400);

	const id = crypto.randomUUID();
	const token = crypto.randomUUID().replace(/-/g, "");
	const session: ReviewSession = {
		id,
		token,
		files: reviewFiles,
		warnings,
		message: typeof body.message === "string" ? body.message : undefined,
		createdAt: Date.now(),
		done: false,
		result: null,
		toolSockets: new Set(),
		uiSockets: new Set(),
	};

	reviewSessions.set(id, session);

	let branch: string | undefined;
	let commit: string | undefined;
	try {
		branch = (await gitExec(["rev-parse", "--abbrev-ref", "HEAD"], cwd)).trim();
		if (!branch) branch = undefined;
	} catch {
		branch = undefined;
	}
	try {
		commit = (await gitExec(["rev-parse", "HEAD"], cwd)).trim();
		if (!commit) commit = undefined;
	} catch {
		commit = undefined;
	}

	try {
		await persistOpenReviewSession(session, {
			cwd,
			branch,
			commit,
			source: "git",
		});
	} catch (error) {
		reviewSessions.delete(id);
		return c.json(
			{ error: (error as Error).message ?? "Failed to persist review" },
			500,
		);
	}

	const openTtlMs = readNumericEnv(
		"RHO_REVIEW_OPEN_TTL_MS",
		24 * 60 * 60 * 1000,
	);
	setTimeout(() => {
		const current = reviewSessions.get(id);
		if (!current) return;
		if (!current.done && Date.now() - current.createdAt > openTtlMs) {
			current.done = true;
			current.result = { cancelled: true, comments: [] };
			void persistReviewCompletion(current).catch((error) => {
				console.warn(
					`Failed to persist review auto-cancel for ${id}: ${(error as Error).message}`,
				);
			});
			reviewSessions.delete(id);
		}
	}, openTtlMs).unref?.();

	const origin = new URL(c.req.url).origin;
	const url = `${origin}/review/${id}?token=${token}`;
	return c.json({ id, token, url });
});

// --- Config API ---

app.get("/api/config", async (c) => {
	try {
		const configPath = path.join(getRhoHome(), "init.toml");
		const content = await readFile(configPath, "utf-8");
		return c.json({ path: configPath, content });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return c.json({
				path: path.join(getRhoHome(), "init.toml"),
				content: "",
			});
		}
		return c.json({ error: (error as Error).message }, 500);
	}
});

app.put("/api/config", async (c) => {
	try {
		const content = await c.req.text();
		const configPath = path.join(getRhoHome(), "init.toml");
		await mkdir(path.dirname(configPath), { recursive: true });
		await writeFile(configPath, content, "utf-8");
		return c.json({ status: "ok", path: configPath });
	} catch (error) {
		return c.json({ error: (error as Error).message }, 500);
	}
});

// --- Sessions API ---

app.get("/api/sessions", async (c) => {
	const cwd = c.req.query("cwd");
	const limit = Math.min(parseInt(c.req.query("limit") ?? "20", 10) || 20, 100);
	const offset = parseInt(c.req.query("offset") ?? "0", 10) || 0;
	try {
		const { total, sessions } = await listSessions({
			cwd: cwd ?? undefined,
			offset,
			limit,
		});
		c.header("X-Total-Count", String(total));
		return c.json(sessions);
	} catch (error) {
		return c.json(
			{ error: (error as Error).message ?? "Failed to list sessions" },
			500,
		);
	}
});

app.get("/api/sessions/:id", async (c) => {
	const sessionId = c.req.param("id");
	try {
		const sessionFile = await findSessionFileById(sessionId);
		if (!sessionFile) {
			return c.json({ error: "Session not found" }, 404);
		}
		const session = await readSession(sessionFile);
		return c.json(session);
	} catch (error) {
		return c.json(
			{ error: (error as Error).message ?? "Failed to read session" },
			500,
		);
	}
});

app.post("/api/sessions/:id/fork", async (c) => {
	const sourceSessionId = c.req.param("id");
	let body: { entryId?: string } = {};
	try {
		body = await c.req.json();
	} catch {
		body = {};
	}

	try {
		const sourceSessionFile = await findSessionFileById(sourceSessionId);
		if (!sourceSessionFile) {
			return c.json({ error: "Session not found" }, 404);
		}

		const sourceSession = await readSession(sourceSessionFile);
		const requestedEntryId =
			typeof body.entryId === "string" ? body.entryId.trim() : "";
		const fallbackEntryId = sourceSession.forkPoints.at(-1)?.id ?? "";
		const entryId = requestedEntryId || fallbackEntryId;
		if (!entryId) {
			return c.json({ error: "No user message available to fork from" }, 400);
		}

		const validEntryIds = new Set(
			(sourceSession.forkPoints ?? []).map((point) => point.id),
		);
		if (!validEntryIds.has(entryId)) {
			return c.json({ error: "Invalid fork entryId" }, 400);
		}

		const { SessionManager } = await loadPiSessionManagerModule();
		const sourceManager = SessionManager.open(
			sourceSessionFile,
			path.dirname(sourceSessionFile),
		);
		const forkedSessionFile = sourceManager.createBranchedSession(entryId);
		if (!forkedSessionFile) {
			return c.json({ error: "Failed to create forked session" }, 500);
		}

		const forkedSession = await readSession(forkedSessionFile);
		return c.json({
			sourceSessionId,
			sourceSessionFile,
			entryId,
			sessionId: forkedSession.header.id,
			sessionFile: forkedSessionFile,
			session: forkedSession,
		});
	} catch (error) {
		return c.json(
			{ error: (error as Error).message ?? "Failed to fork session" },
			500,
		);
	}
});

app.post("/api/sessions/new", async (c) => {
	try {
		const sessionId = crypto.randomUUID();
		const timestamp = new Date().toISOString();
		const safeTimestamp = timestamp.replace(/[:.]/g, "-");
		const cwd = process.env.HOME ?? process.cwd();
		const safeCwd = cwd.replace(/\//g, "-");
		const sessionDir = path.join(
			process.env.HOME ?? "",
			".pi",
			"agent",
			"sessions",
			safeCwd,
		);
		await mkdir(sessionDir, { recursive: true });
		const sessionFile = path.join(
			sessionDir,
			`${safeTimestamp}_${sessionId}.jsonl`,
		);
		const header = JSON.stringify({
			type: "session",
			version: 1,
			id: sessionId,
			cwd,
			timestamp,
		});
		await writeFile(sessionFile, `${header}\n`, "utf-8");

		const session = await readSession(sessionFile);
		return c.json({
			sessionId,
			sessionFile,
			session,
		});
	} catch (error) {
		return c.json(
			{ error: (error as Error).message ?? "Failed to create session" },
			500,
		);
	}
});

// --- Tasks API ---

app.get("/api/tasks", async (c) => {
	try {
		const filter = c.req.query("filter");
		const tasks = listAllTasks(filter ?? undefined);
		return c.json(tasks);
	} catch (error) {
		return c.json(
			{ error: (error as Error).message ?? "Failed to list tasks" },
			500,
		);
	}
});

app.post("/api/tasks", async (c) => {
	let payload: {
		description?: string;
		priority?: string;
		tags?: string[];
		due?: string | null;
	};
	try {
		payload = await c.req.json();
	} catch {
		return c.json({ error: "Invalid JSON body" }, 400);
	}

	const result = await createTask({
		description: payload.description,
		priority: payload.priority as
			| "urgent"
			| "high"
			| "normal"
			| "low"
			| undefined,
		tags: payload.tags,
		due: payload.due ?? undefined,
	});

	if (!result.ok || !result.task) {
		return c.json({ error: result.message }, 400);
	}
	return c.json(result.task);
});

app.patch("/api/tasks/:id", async (c) => {
	const taskId = c.req.param("id");
	let payload: {
		description?: string;
		priority?: string;
		status?: string;
		tags?: string[];
		due?: string | null;
	};
	try {
		payload = await c.req.json();
	} catch {
		return c.json({ error: "Invalid JSON body" }, 400);
	}

	const result = await updateTask(taskId, {
		description: payload.description,
		priority: payload.priority as
			| "urgent"
			| "high"
			| "normal"
			| "low"
			| undefined,
		status: payload.status as "pending" | "done" | undefined,
		tags: payload.tags,
		due: payload.due ?? undefined,
	});

	if (!result.ok || !result.task) {
		const status = result.message.includes("not found") ? 404 : 400;
		return c.json({ error: result.message }, status);
	}
	return c.json(result.task);
});

app.delete("/api/tasks/:id", async (c) => {
	const taskId = c.req.param("id");
	const result = await deleteTask(taskId);
	if (!result.ok) {
		const status = result.message.includes("not found") ? 404 : 400;
		return c.json({ error: result.message }, status);
	}
	return c.json({ status: "ok" });
});

/** Safely access an optional field on a brain entry union. */
function field(e: BrainEntry, key: string): unknown {
	return (e as Record<string, unknown>)[key];
}

// --- Memory API ---

type MemoryEntries = {
	behaviors: BehaviorEntry[];
	identity: IdentityEntry[];
	user: UserEntry[];
	learnings: LearningEntry[];
	preferences: PreferenceEntry[];
	contexts: ContextEntry[];
	tasks: TaskEntry[];
	reminders: ReminderEntry[];
};

let memoryCache: { mtimeMs: number; data: MemoryEntries } | null = null;

async function readMemoryEntries(): Promise<MemoryEntries> {
	let mtimeMs = 0;
	try {
		mtimeMs = (await stat(BRAIN_PATH)).mtimeMs;
	} catch {
		// Missing brain file or unreadable.
		mtimeMs = 0;
	}

	if (memoryCache && memoryCache.mtimeMs === mtimeMs) {
		return memoryCache.data;
	}

	const { entries } = readBrain(BRAIN_PATH);
	const brain = foldBrain(entries);
	const data: MemoryEntries = {
		behaviors: brain.behaviors,
		identity: [...brain.identity.values()],
		user: [...brain.user.values()],
		learnings: brain.learnings,
		preferences: brain.preferences,
		contexts: brain.contexts,
		tasks: brain.tasks,
		reminders: brain.reminders,
	};

	memoryCache = { mtimeMs, data };
	return data;
}

app.get("/api/memory", async (c) => {
	try {
		const all = await readMemoryEntries();

		const total =
			all.behaviors.length +
			all.identity.length +
			all.user.length +
			all.learnings.length +
			all.preferences.length +
			all.contexts.length +
			all.tasks.length +
			all.reminders.length;

		const typeFilter = c.req.query("type");
		const categoryFilter = c.req.query("category");
		const q = c.req.query("q")?.toLowerCase();

		let baseEntries: BrainEntry[];
		if (typeFilter) {
			switch (typeFilter) {
				case "behavior":
					baseEntries = all.behaviors;
					break;
				case "identity":
					baseEntries = all.identity;
					break;
				case "user":
					baseEntries = all.user;
					break;
				case "learning":
					baseEntries = all.learnings;
					break;
				case "preference":
					baseEntries = all.preferences;
					break;
				case "context":
					baseEntries = all.contexts;
					break;
				case "task":
					baseEntries = all.tasks;
					break;
				case "reminder":
					baseEntries = all.reminders;
					break;
				default:
					baseEntries = [];
			}
		} else {
			baseEntries = [
				...all.behaviors,
				...all.identity,
				...all.user,
				...all.learnings,
				...all.preferences,
				...all.contexts,
				...all.tasks,
				...all.reminders,
			];
		}

		let filtered = baseEntries;
		if (categoryFilter)
			filtered = filtered.filter(
				(e) => field(e, "category") === categoryFilter,
			);
		if (q)
			filtered = filtered.filter((e) => {
				const searchable = [
					field(e, "text"),
					field(e, "category"),
					field(e, "key"),
					field(e, "value"),
					field(e, "content"),
					field(e, "description"),
					field(e, "path"),
					field(e, "project"),
				]
					.filter(Boolean)
					.join(" ")
					.toLowerCase();
				return searchable.includes(q);
			});

		const categories = [
			...new Set(all.preferences.map((p) => p.category)),
		].sort();

		return c.json({
			total,
			behaviors: all.behaviors.length,
			identity: all.identity.length,
			user: all.user.length,
			learnings: all.learnings.length,
			preferences: all.preferences.length,
			contexts: all.contexts.length,
			tasks: all.tasks.length,
			reminders: all.reminders.length,
			categories,
			entries: filtered,
		});
	} catch (error) {
		return c.json(
			{ error: (error as Error).message ?? "Failed to read memory" },
			500,
		);
	}
});

app.put("/api/memory/:id", async (c) => {
	const entryId = c.req.param("id");
	try {
		let body: { text?: string; category?: string };
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		if (!body.text || typeof body.text !== "string" || !body.text.trim()) {
			return c.json({ error: "text is required" }, 400);
		}

		const all = await readMemoryEntries();
		const allMemory = [
			...all.behaviors,
			...all.identity,
			...all.user,
			...all.learnings,
			...all.preferences,
			...all.contexts,
			...all.tasks,
			...all.reminders,
		];
		const target = allMemory.find((e) => e.id === entryId);
		if (!target) return c.json({ error: "Entry not found" }, 404);

		// Build updated entry preserving all original fields
		const updated = {
			...target,
			text: body.text.trim(),
			created: new Date().toISOString(),
		};
		if (body.category !== undefined && target.type === "preference") {
			(updated as Record<string, unknown>).category = body.category;
		}

		await appendBrainEntry(BRAIN_PATH, updated as BrainEntry);
		memoryCache = null;
		return c.json({ status: "ok", entry: updated });
	} catch (error) {
		return c.json(
			{ error: (error as Error).message ?? "Failed to update entry" },
			500,
		);
	}
});

app.post("/api/memory", async (c) => {
	try {
		let body: { type?: string; text?: string; category?: string };
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		const entryType = body.type;
		const text = body.text?.trim();

		if (!text) return c.json({ error: "text is required" }, 400);
		if (
			!entryType ||
			!["learning", "preference", "behavior", "context"].includes(entryType)
		) {
			return c.json(
				{
					error: "type must be one of: learning, preference, behavior, context",
				},
				400,
			);
		}

		const id = crypto.randomUUID().slice(0, 8);
		const created = new Date().toISOString();
		let entry: BrainEntry | undefined;

		switch (entryType) {
			case "learning":
				entry = { id, type: "learning", text, source: "web-ui", created };
				break;
			case "preference":
				entry = {
					id,
					type: "preference",
					text,
					category: body.category?.trim() || "General",
					created,
				};
				break;
			case "behavior": {
				// Parse do/dont/values from text
				let category: "do" | "dont" | "value" = "do";
				let cleanText = text;
				if (
					text.toLowerCase().startsWith("don't:") ||
					text.toLowerCase().startsWith("dont:")
				) {
					category = "dont";
					cleanText = text.replace(/^don'?t:\s*/i, "");
				} else if (text.toLowerCase().startsWith("do:")) {
					category = "do";
					cleanText = text.replace(/^do:\s*/i, "");
				} else if (
					text.toLowerCase().startsWith("value:") ||
					text.toLowerCase().startsWith("values:")
				) {
					category = "value";
					cleanText = text.replace(/^values?:\s*/i, "");
				}
				entry = { id, type: "behavior", category, text: cleanText, created };
				break;
			}
			case "context":
				return c.json(
					{
						error:
							"Context entries require project and path fields; use the CLI instead",
					},
					400,
				);
		}

		if (!entry) return c.json({ error: "Failed to construct entry" }, 500);
		await appendBrainEntry(BRAIN_PATH, entry);
		memoryCache = null;
		return c.json({ status: "ok", entry });
	} catch (error) {
		return c.json(
			{ error: (error as Error).message ?? "Failed to create entry" },
			500,
		);
	}
});

app.delete("/api/memory/:id", async (c) => {
	const entryId = c.req.param("id");
	try {
		// Find the entry across all types
		const all = await readMemoryEntries();
		const allMemory = [
			...all.behaviors,
			...all.identity,
			...all.user,
			...all.learnings,
			...all.preferences,
			...all.contexts,
			...all.tasks,
			...all.reminders,
		];
		const target = allMemory.find((e) => e.id === entryId);
		if (!target) return c.json({ error: "Entry not found" }, 404);

		// Append tombstone
		const tombstone = {
			id: crypto.randomUUID().slice(0, 8),
			type: "tombstone" as const,
			target_id: entryId,
			target_type: target.type,
			reason: "deleted via web UI",
			created: new Date().toISOString(),
		};
		await appendBrainEntry(BRAIN_PATH, tombstone);
		memoryCache = null;
		return c.json({ status: "ok" });
	} catch (error) {
		return c.json(
			{ error: (error as Error).message ?? "Failed to delete entry" },
			500,
		);
	}
});

// --- WebSocket ---

app.get(
	"/ws",
	upgradeWebSocket(() => ({
		onOpen: () => {},
		onMessage: async (event, ws) => {
			if (typeof event.data !== "string") {
				return;
			}

			let payload: WSIncomingMessage | null = null;
			try {
				payload = JSON.parse(event.data) as WSIncomingMessage;
			} catch {
				return;
			}

			if (payload?.type === "rpc_ping") {
				sendWsMessage(ws, {
					type: "rpc_pong",
					ts:
						typeof payload.ts === "number" && Number.isFinite(payload.ts)
							? payload.ts
							: Date.now(),
				});
				return;
			}

			if (payload?.type !== "rpc_command") {
				return;
			}

			const command = payload.command;
			if (
				!command ||
				typeof command !== "object" ||
				typeof command.type !== "string"
			) {
				sendWsMessage(ws, {
					type: "error",
					message: "rpc_command requires a command object with a type field",
				});
				return;
			}

			let sessionId =
				typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
			const shouldReplayFromSeq = Object.hasOwn(payload, "lastEventSeq");
			const lastEventSeq = parseLastEventSeq(payload);

			if (!sessionId) {
				const sessionFile = extractSessionFile(payload);
				if (!sessionFile) {
					sendWsMessage(ws, {
						type: "error",
						message:
							"rpc_command requires sessionId or sessionFile (or command session path)",
					});
					return;
				}

				const existingId = rpcManager.findSessionByFile(sessionFile);
				if (existingId) {
					sessionId = existingId;
				} else {
					try {
						sessionId = rpcManager.startSession(sessionFile);
					} catch (error) {
						sendWsMessage(ws, {
							type: "error",
							message:
								(error as Error).message ?? "Failed to start RPC session",
						});
						return;
					}
				}

				subscribeToRpcSession(ws, sessionId);
				sendWsMessage(ws, { type: "session_started", sessionId, sessionFile });
				if (existingId) {
					rpcManager.sendCommand(sessionId, {
						type: "get_state",
						id: `server-get-state-${Date.now()}`,
					});
				}
				if (command.type === "switch_session") {
					return;
				}
			} else {
				try {
					subscribeToRpcSession(ws, sessionId);
				} catch {
					sendWsMessage(ws, {
						type: "rpc_session_not_found",
						sessionId,
						message: `Unknown RPC session: ${sessionId}`,
					});
					return;
				}
			}

			if (shouldReplayFromSeq) {
				replayBufferedRpcEvents(ws, sessionId, lastEventSeq);
			}

			const commandId = typeof command.id === "string" ? command.id.trim() : "";
			if (commandId) {
				const dedupe = rpcReliability.registerCommand(sessionId, commandId);
				if (dedupe.duplicate) {
					if (dedupe.cachedResponse) {
						sendWsMessage(ws, {
							type: "rpc_event",
							sessionId,
							seq: dedupe.cachedResponseSeq,
							event: dedupe.cachedResponse,
						});
					}
					return;
				}
			}

			try {
				rpcManager.sendCommand(sessionId, command);
			} catch (error) {
				sendWsMessage(ws, {
					type: "error",
					message: (error as Error).message ?? "Failed to send RPC command",
				});
			}
		},
		onClose: (_, ws) => {
			clearRpcSubscriptions(ws);
		},
		onError: (_, ws) => {
			clearRpcSubscriptions(ws);
		},
	})),
);

// --- Static files ---

app.get("/", async (c) => {
	const html = await readFile(path.join(publicDir, "index.html"), "utf-8");
	return c.html(html);
});

// PWA root assets
app.get(
	"/manifest.json",
	serveStatic({ root: publicDir, path: "manifest.json" }),
);
app.use("/sw.js", async (c, next) => {
	await next();
	// Service workers need no-cache and root scope
	c.res.headers.set("Cache-Control", "no-cache");
	c.res.headers.set("Service-Worker-Allowed", "/");
});
app.get("/sw.js", serveStatic({ root: publicDir, path: "sw.js" }));
app.get("/favicon.svg", serveStatic({ root: publicDir, path: "favicon.svg" }));
app.get(
	"/icon-192.png",
	serveStatic({ root: publicDir, path: "icon-192.png" }),
);
app.get(
	"/icon-512.png",
	serveStatic({ root: publicDir, path: "icon-512.png" }),
);

// Cache headers for static assets (5 minutes)

app.use(
	"/css/*",
	async (c, next) => {
		await next();
		c.res.headers.set("Cache-Control", "public, max-age=300");
	},
	serveStatic({ root: publicDir }),
);
app.use(
	"/js/*",
	async (c, next) => {
		await next();
		c.res.headers.set("Cache-Control", "public, max-age=300");
	},
	serveStatic({ root: publicDir }),
);
app.use(
	"/assets/*",
	async (c, next) => {
		await next();
		c.res.headers.set("Cache-Control", "public, max-age=300");
	},
	serveStatic({ root: publicDir }),
);
app.use(
	"/review/css/*",
	async (c, next) => {
		await next();
		c.res.headers.set("Cache-Control", "public, max-age=300");
	},
	serveStatic({ root: publicDir }),
);
app.use(
	"/review/js/*",
	async (c, next) => {
		await next();
		c.res.headers.set("Cache-Control", "public, max-age=300");
	},
	serveStatic({ root: publicDir }),
);

// --- Cleanup ---

export function disposeServerResources(): void {
	for (const ws of rpcSessionSubscribers.keys()) {
		clearRpcSubscriptions(ws);
	}
	rpcReliability.dispose();
	rpcManager.dispose();
}

export default app;
