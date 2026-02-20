import {
	type WSIncomingMessage,
	app,
	clearRpcSubscriptions,
	extractSessionFile,
	parseLastEventSeq,
	replayBufferedRpcEvents,
	rpcManager,
	rpcReliability,
	sendWsMessage,
	subscribeToRpcSession,
	upgradeWebSocket,
} from "./server-core.ts";
import { registerUiSocket, unregisterUiSocket } from "./server-ui-events.ts";

// --- WebSocket ---

app.get(
	"/ws",
	upgradeWebSocket(() => ({
		onOpen: (_, ws) => {
			registerUiSocket(ws);
		},
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
			unregisterUiSocket(ws);
		},
		onError: (_, ws) => {
			clearRpcSubscriptions(ws);
			unregisterUiSocket(ws);
		},
	})),
);
