import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import WebSocket, {
	WebSocketServer,
	type WebSocket as WSServerSocket,
} from "ws";

import type { ReviewFile } from "./files.ts";

// ── Interfaces ──────────────────────────────────────────────────────

export interface ReviewServerOptions {
	files: ReviewFile[];
	message?: string;
	warnings?: string[];
	signal?: AbortSignal;
	/** Called once the server is listening with the full URL */
	onReady?: (url: string) => void;
	/** @internal skip browser open in tests */
	_skipOpen?: boolean;
}

export interface ReviewResult {
	comments: ReviewComment[];
	cancelled: boolean;
}

export interface ReviewComment {
	file: string;
	startLine: number;
	endLine: number;
	selectedText: string;
	comment: string;
}

// ── MIME types ───────────────────────────────────────────────────────

const MIME_TYPES: Record<string, string> = {
	".html": "text/html",
	".css": "text/css",
	".js": "text/javascript",
	".json": "application/json",
	".svg": "image/svg+xml",
};

function mimeType(filePath: string): string {
	return (
		MIME_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream"
	);
}

// ── Static file serving ─────────────────────────────────────────────

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const WEB_DIR = join(__dirname, "web");

async function serveStatic(
	req: http.IncomingMessage,
	res: http.ServerResponse,
): Promise<boolean> {
	let urlPath = req.url ?? "/";
	if (urlPath === "/") urlPath = "/index.html";

	// Prevent directory traversal
	const safePath = join(WEB_DIR, urlPath);
	if (!safePath.startsWith(WEB_DIR)) {
		res.writeHead(403);
		res.end("Forbidden");
		return true;
	}

	try {
		const content = await readFile(safePath);
		res.writeHead(200, { "content-type": mimeType(safePath) });
		res.end(content);
		return true;
	} catch {
		return false;
	}
}

// ── Main export ─────────────────────────────────────────────────────

export interface ReviewServerPromise extends Promise<ReviewResult> {
	/** @internal port the server is listening on (set after bind) */
	_port?: number;
}

/** Max retries when port bind fails */
const MAX_LISTEN_RETRIES = 3;

export function startStandaloneReviewServer(
	options: ReviewServerOptions,
): ReviewServerPromise {
	const { files, signal, _skipOpen } = options;

	let resolveResult: (result: ReviewResult) => void;
	let settled = false;

	const promise = new Promise<ReviewResult>((resolve) => {
		resolveResult = resolve;
	}) as ReviewServerPromise;

	function settle(result: ReviewResult) {
		if (settled) return;
		settled = true;
		// Force-close all WebSocket connections
		for (const client of wss.clients) {
			try {
				client.terminate();
			} catch {}
		}
		wss.close();
		server.close();
		server.closeAllConnections();
		resolveResult(result);
	}

	// ── HTTP server ─────────────────────────────────────────────────

	const server = http.createServer(async (req, res) => {
		const url = req.url ?? "/";

		// API routes
		if (url === "/api/files" && req.method === "GET") {
			const body = JSON.stringify(files);
			res.writeHead(200, { "content-type": "application/json" });
			res.end(body);
			return;
		}

		if (url === "/api/warnings" && req.method === "GET") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(options.warnings ?? []));
			return;
		}

		if (url === "/api/config" && req.method === "GET") {
			const config: Record<string, string> = {};
			if (options.message) config.message = options.message;
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(config));
			return;
		}

		// Static files
		if (await serveStatic(req, res)) return;

		// 404
		res.writeHead(404);
		res.end("Not found");
	});

	// ── WebSocket server ───────────────────────────────────────────

	const wss = new WebSocketServer({ server });

	wss.on("connection", (ws: WSServerSocket) => {
		ws.send(JSON.stringify({ type: "init" }));

		ws.on("message", (raw) => {
			let msg: any;
			try {
				msg = JSON.parse(String(raw));
			} catch {
				return;
			}

			if (msg.type === "submit" && Array.isArray(msg.comments)) {
				settle({ comments: msg.comments, cancelled: false });
			} else if (msg.type === "cancel") {
				settle({ comments: [], cancelled: true });
			}
		});

		ws.on("close", () => settle({ comments: [], cancelled: true }));
		ws.on("error", () => settle({ comments: [], cancelled: true }));
	});

	// Bind to port 0 (random available). Retry on unlikely bind failure.
	let retries = 0;
	function tryListen() {
		server.listen(0, "127.0.0.1", () => {
			const addr = server.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			(promise as any)._port = port;

			const url = `http://127.0.0.1:${port}`;

			options.onReady?.(url);

			if (!_skipOpen) {
				execFile("open", [url], (err) => {
					if (err) console.warn(`Failed to open browser: ${err.message}`);
				});
			}
		});

		server.once("error", (err: NodeJS.ErrnoException) => {
			if (err.code === "EADDRINUSE" && retries < MAX_LISTEN_RETRIES) {
				retries++;
				console.warn(
					`Port bind failed (attempt ${retries}/${MAX_LISTEN_RETRIES}), retrying...`,
				);
				server.close();
				tryListen();
			} else {
				console.error(`Server listen error: ${err.message}`);
				settle({ comments: [], cancelled: true });
			}
		});
	}
	tryListen();

	// ── AbortSignal ─────────────────────────────────────────────────

	if (signal) {
		if (signal.aborted) {
			settle({ comments: [], cancelled: true });
		} else {
			signal.addEventListener(
				"abort",
				() => settle({ comments: [], cancelled: true }),
				{ once: true },
			);
		}
	}

	return promise;
}

// ── Rho web server integration (preferred) ───────────────────────

export interface CreatedReviewSession {
	id: string;
	token: string;
	url: string;
}

export const DEFAULT_RHO_WEB =
	process.env.RHO_REVIEW_BASE_URL ?? "http://127.0.0.1:3141";

async function fetchWithTimeout(
	url: string,
	init: RequestInit,
	timeoutMs: number,
): Promise<Response> {
	const controller = new AbortController();
	const t = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await fetch(url, { ...init, signal: controller.signal });
	} finally {
		clearTimeout(t);
	}
}

async function rhoWebHealthy(baseUrl: string): Promise<boolean> {
	try {
		const res = await fetchWithTimeout(
			`${baseUrl}/api/health`,
			{ method: "GET" },
			400,
		);
		return res.ok;
	} catch {
		return false;
	}
}

export async function ensureRhoWebRunning(
	baseUrl = DEFAULT_RHO_WEB,
): Promise<void> {
	if (await rhoWebHealthy(baseUrl)) return;

	// Try to start it (best-effort). This is intentionally fire-and-forget.
	try {
		const child = spawn("rho", ["web", "--port", "3141"], {
			detached: true,
			stdio: "ignore",
		});
		child.unref();
	} catch {
		// ignore
	}

	// Wait briefly for it to come up
	for (let i = 0; i < 10; i++) {
		if (await rhoWebHealthy(baseUrl)) return;
		await new Promise((r) => setTimeout(r, 200));
	}
}

function wsUrlFor(baseUrl: string, path: string): string {
	// baseUrl is http(s)://host:port
	if (baseUrl.startsWith("https://"))
		return "wss://" + baseUrl.slice("https://".length) + path;
	if (baseUrl.startsWith("http://"))
		return "ws://" + baseUrl.slice("http://".length) + path;
	// fallback
	return "ws://" + baseUrl.replace(/^\/+/, "") + path;
}

async function createReviewSessionOnRhoWeb(
	options: ReviewServerOptions,
): Promise<CreatedReviewSession> {
	const baseUrl = DEFAULT_RHO_WEB;
	await ensureRhoWebRunning(baseUrl);

	const createRes = await fetch(`${baseUrl}/api/review/sessions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			files: options.files,
			warnings: options.warnings ?? [],
			message: options.message,
		}),
	});

	if (!createRes.ok) {
		throw new Error(`Failed to create review session (${createRes.status})`);
	}

	const created = (await createRes.json()) as CreatedReviewSession;
	options.onReady?.(created.url);

	if (!options._skipOpen) {
		execFile("open", [created.url], (err) => {
			if (err) console.warn(`Failed to open browser: ${err.message}`);
		});
	}

	return created;
}

export async function createReviewSession(
	options: ReviewServerOptions,
): Promise<CreatedReviewSession> {
	return createReviewSessionOnRhoWeb(options);
}

async function startReviewOnRhoWeb(
	options: ReviewServerOptions,
): Promise<ReviewResult> {
	const created = await createReviewSessionOnRhoWeb(options);
	const wsUrl = wsUrlFor(
		DEFAULT_RHO_WEB,
		`/review/${created.id}/ws?token=${encodeURIComponent(created.token)}&role=tool`,
	);

	return await new Promise<ReviewResult>((resolve) => {
		let settled = false;
		let ws: WebSocket | null = null;

		function settle(result: ReviewResult) {
			if (settled) return;
			settled = true;
			try {
				ws?.close();
			} catch {}
			resolve(result);
		}

		const wsConn = new WebSocket(wsUrl);
		ws = wsConn;

		wsConn.on("message", (raw) => {
			let msg: any;
			try {
				msg = JSON.parse(String(raw));
			} catch {
				return;
			}

			if (msg?.type === "review_result") {
				settle({
					cancelled: !!msg.cancelled,
					comments: Array.isArray(msg.comments) ? msg.comments : [],
				});
			}
		});

		wsConn.on("close", () => {
			if (!settled) settle({ comments: [], cancelled: true });
		});
		wsConn.on("error", () => {
			if (!settled) settle({ comments: [], cancelled: true });
		});

		if (options.signal) {
			if (options.signal.aborted) {
				settle({ comments: [], cancelled: true });
			} else {
				options.signal.addEventListener(
					"abort",
					() => {
						settle({ comments: [], cancelled: true });
					},
					{ once: true },
				);
			}
		}
	});
}

/**
 * Start a review.
 *
 * Preferred: mount under the existing rho web UI at :3141 (path /review/:id).
 * Fallback: start a standalone ephemeral review server on a random port.
 */
export function startReviewServer(
	options: ReviewServerOptions,
): ReviewServerPromise {
	const p = (async () => {
		try {
			return await startReviewOnRhoWeb(options);
		} catch (err) {
			console.warn(
				`Falling back to standalone review server: ${(err as Error).message}`,
			);
			return await startStandaloneReviewServer(options);
		}
	})();

	return p as ReviewServerPromise;
}
