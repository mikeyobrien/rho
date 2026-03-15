import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { WSContext } from "hono/ws";
import type { WebSocket } from "ws";
import { app, sendWsMessage, upgradeWebSocket } from "./server-core.ts";
import {
	type TerminalSessionEvent,
	terminalManager,
} from "./terminal-manager.ts";

const require = createRequire(import.meta.url);
const ghosttyPackageDir = path.dirname(
	require.resolve("ghostty-web/ghostty-vt.wasm"),
);
const ghosttyJsPath = path.join(ghosttyPackageDir, "dist", "ghostty-web.js");
const ghosttyWasmPath = path.join(ghosttyPackageDir, "ghostty-vt.wasm");

type TerminalMessage = {
	type?: string;
	sessionId?: string;
	cols?: number;
	rows?: number;
	ts?: number;
	data?: string;
};

type TerminalSocketState = {
	sessionId: string | null;
	unsubscribe: (() => void) | null;
};

const socketStates = new WeakMap<WSContext<WebSocket>, TerminalSocketState>();

function getSocketState(ws: WSContext<WebSocket>): TerminalSocketState {
	let state = socketStates.get(ws);
	if (!state) {
		state = { sessionId: null, unsubscribe: null };
		socketStates.set(ws, state);
	}
	return state;
}

function detachTerminalSocket(ws: WSContext<WebSocket>): string | null {
	const state = getSocketState(ws);
	const sessionId = state.sessionId;
	state.unsubscribe?.();
	state.unsubscribe = null;
	state.sessionId = null;
	return sessionId;
}

function closeAttachedSession(ws: WSContext<WebSocket>): void {
	const sessionId = detachTerminalSocket(ws);
	if (sessionId) {
		terminalManager.close(sessionId);
	}
}

function attachSession(ws: WSContext<WebSocket>, sessionId: string): void {
	detachTerminalSocket(ws);
	const state = getSocketState(ws);
	state.unsubscribe = terminalManager.subscribe(
		sessionId,
		(event: TerminalSessionEvent) => {
			if (event.type === "data") {
				// Send PTY output as raw binary frame — avoids JSON overhead
				// on the hottest path. Client detects binary vs text by frame type.
				// ws.send with a Buffer triggers a binary WebSocket frame.
				ws.send(Buffer.from(event.data, "utf8"));
				return;
			}
			sendWsMessage(ws, {
				type: "terminal_exit",
				sessionId: event.sessionId,
				exitCode: event.exitCode,
				signal: event.signal,
			});
			detachTerminalSocket(ws);
		},
	);
	state.sessionId = sessionId;
}

function sendTerminalError(ws: WSContext<WebSocket>, message: string): void {
	sendWsMessage(ws, {
		type: "terminal_error",
		message,
	});
}

async function serveAsset(
	filePath: string,
	contentType: string,
	immutable = false,
) {
	const body = await readFile(filePath);
	return new Response(body, {
		headers: {
			"Content-Type": contentType,
			"Cache-Control": immutable
				? "public, max-age=31536000, immutable"
				: "no-cache",
		},
	});
}

app.get("/api/terminal/sessions", (c) => {
	try {
		return c.json(terminalManager.listSessions());
	} catch (error) {
		return c.json(
			{ error: (error as Error).message ?? "Failed to list terminal sessions" },
			500,
		);
	}
});

app.get("/vendor/ghostty-web.js", async () => {
	return serveAsset(ghosttyJsPath, "text/javascript; charset=utf-8", true);
});

app.get("/vendor/ghostty-vt.wasm", async () => {
	return serveAsset(ghosttyWasmPath, "application/wasm", true);
});

app.get("/ghostty-vt.wasm", async () => {
	return serveAsset(ghosttyWasmPath, "application/wasm", true);
});

app.get(
	"/terminal/ws",
	upgradeWebSocket(() => ({
		onOpen: (_, ws) => {
			getSocketState(ws);
			sendWsMessage(ws, { type: "terminal_ready" });
		},
		onMessage: (event, ws) => {
			// Binary frames are raw terminal input — skip JSON parsing.
			if (event.data instanceof ArrayBuffer) {
				const state = getSocketState(ws);
				if (state.sessionId) {
					const text = new TextDecoder().decode(event.data);
					terminalManager.write(state.sessionId, text);
				}
				return;
			}

			if (typeof event.data !== "string") {
				return;
			}

			let payload: TerminalMessage | null = null;
			try {
				payload = JSON.parse(event.data) as TerminalMessage;
			} catch {
				sendTerminalError(ws, "Invalid terminal websocket payload");
				return;
			}

			if (!payload?.type) {
				sendTerminalError(ws, "Terminal websocket payload requires a type");
				return;
			}

			if (payload.type === "ping") {
				sendWsMessage(ws, {
					type: "pong",
					ts:
						typeof payload.ts === "number" && Number.isFinite(payload.ts)
							? payload.ts
							: Date.now(),
				});
				return;
			}

			if (payload.type === "create") {
				closeAttachedSession(ws);
				try {
					const session = terminalManager.createSession({
						cols: payload.cols,
						rows: payload.rows,
					});
					attachSession(ws, session.id);
					sendWsMessage(ws, {
						type: "terminal_session_created",
						session,
					});
				} catch (error) {
					sendTerminalError(
						ws,
						(error as Error).message ?? "Failed to create terminal session",
					);
				}
				return;
			}

			const sessionId =
				typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
			if (!sessionId) {
				sendTerminalError(
					ws,
					`Terminal message ${payload.type} requires sessionId`,
				);
				return;
			}

			try {
				switch (payload.type) {
					case "attach": {
						const session = terminalManager.getSession(sessionId);
						if (!session) {
							sendWsMessage(ws, {
								type: "terminal_session_missing",
								sessionId,
							});
							break;
						}
						attachSession(ws, sessionId);
						sendWsMessage(ws, {
							type: "terminal_session_attached",
							session,
							replay: terminalManager.getReplay(sessionId),
						});
						break;
					}
					case "input":
						terminalManager.write(sessionId, payload.data ?? "");
						break;
					case "resize": {
						const session = terminalManager.resize(
							sessionId,
							payload.cols ?? 0,
							payload.rows ?? 0,
						);
						sendWsMessage(ws, {
							type: "terminal_resized",
							session,
						});
						break;
					}
					case "close":
						terminalManager.close(sessionId);
						break;
					default:
						sendTerminalError(
							ws,
							`Unknown terminal websocket type: ${payload.type}`,
						);
				}
			} catch (error) {
				sendTerminalError(
					ws,
					(error as Error).message ?? "Terminal websocket command failed",
				);
			}
		},
		onClose: (_, ws) => {
			detachTerminalSocket(ws);
		},
		onError: (_, ws) => {
			detachTerminalSocket(ws);
		},
	})),
);
