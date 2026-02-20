import type { WSContext } from "hono/ws";
import type { WebSocket } from "ws";

const uiSockets = new Set<WSContext<WebSocket>>();

function pruneSocket(ws: WSContext<WebSocket>): void {
	try {
		uiSockets.delete(ws);
	} catch {
		// Ignore stale socket errors.
	}
}

export function registerUiSocket(ws: WSContext<WebSocket>): void {
	uiSockets.add(ws);
}

export function unregisterUiSocket(ws: WSContext<WebSocket>): void {
	pruneSocket(ws);
}

export function broadcastUiEvent(
	name: string,
	data?: Record<string, unknown>,
): void {
	const message = JSON.stringify({
		type: "ui_event",
		name,
		at: Date.now(),
		...(data ? { data } : {}),
	});

	for (const ws of uiSockets) {
		try {
			ws.send(message);
		} catch {
			pruneSocket(ws);
		}
	}
}
