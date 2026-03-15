import * as primitives from "./constants-and-primitives.js";
import { buildWsUrl } from "./rendering-and-usage.js";
import {
	bumpPendingRpcQueuedAt,
	hasStalePendingRpcCommands,
} from "./rpc-health-watchdog.js";
import { resumeReconnectSessions } from "./rpc-reconnect-runtime.js";

export const rhoChatWsRpcMethods = {
	connectWebSocket(force = false) {
		if (force && this.ws) {
			const staleWs = this.ws;
			this.ws = null;
			this.isWsConnected = false;
			this.stopWsHeartbeat();
			try {
				staleWs.close();
			} catch {}
		}
		if (
			this.ws &&
			(this.ws.readyState === WebSocket.OPEN ||
				this.ws.readyState === WebSocket.CONNECTING)
		) {
			return;
		}

		if (this.wsReconnectTimer) {
			clearTimeout(this.wsReconnectTimer);
			this.wsReconnectTimer = null;
		}

		const ws = new WebSocket(buildWsUrl());

		ws.addEventListener("open", () => {
			if (this.ws !== ws) {
				return;
			}
			this.isWsConnected = true;
			this.wsReconnectAttempts = 0;
			this.error = "";
			this.wsLastPongAt = Date.now();
			this.startWsHeartbeat();

			if (this.awaitingStreamReconnectState) {
				this.showReconnectBanner = true;
				this.reconnectBannerMessage = "Reconnected. Checking stream status…";
			} else {
				this.showReconnectBanner = false;
				this.reconnectBannerMessage = "";
			}

			if (resumeReconnectSessions(this)) {
				return;
			}
			// Only start a session if one isn't already in flight (e.g. from
			// selectSession during loadSessions which queued a switch_session
			// while the WS was still connecting).
			const focusedState = this.getFocusedSessionState?.();
			if (focusedState?.status === "starting" || focusedState?.rpcSessionId) {
				return;
			}
			const sessionFile =
				this.activeRpcSessionFile || this.getSessionFile(this.activeSessionId);
			if (sessionFile) {
				this.startRpcSession(sessionFile);
			}
		});

		ws.addEventListener("message", (event) => {
			if (this.ws !== ws) {
				return;
			}
			this.handleWsMessage(event);
		});

		ws.addEventListener("close", () => {
			if (this.ws === ws) {
				this.stopWsHeartbeat();
				this.wsLastPongAt = 0;
				const lostDuringResponse = this.isStreaming || this.isSendingPrompt;
				if (lostDuringResponse) {
					this.streamDisconnectedDuringResponse = true;
					this.awaitingStreamReconnectState = true;
					this.reconnectBannerMessage =
						"Connection lost while agent was responding. Reconnecting…";
				} else if (!this.awaitingStreamReconnectState) {
					this.reconnectBannerMessage = "Connection lost. Reconnecting…";
				}
				this.ws = null;
				this.isWsConnected = false;
				this.showReconnectBanner = true;
				this.scheduleReconnect();
			}
		});

		ws.addEventListener("error", () => {
			if (this.ws !== ws) {
				return;
			}
			this.stopWsHeartbeat();
			this.wsLastPongAt = 0;
			this.isWsConnected = false;
		});

		this.ws = ws;
	},

	scheduleReconnect() {
		this.wsReconnectAttempts++;
		this.showReconnectBanner = true;

		const delay = Math.min(
			this.wsBaseReconnectDelay * 2 ** (this.wsReconnectAttempts - 1),
			this.wsMaxReconnectDelay,
		);

		this.wsReconnectTimer = setTimeout(() => {
			this.connectWebSocket();
		}, delay);
	},

	manualReconnect() {
		this.wsReconnectAttempts = 0;
		if (this.wsReconnectTimer) {
			clearTimeout(this.wsReconnectTimer);
			this.wsReconnectTimer = null;
		}
		this.showReconnectBanner = true;
		this.reconnectBannerMessage = "Retrying connection…";
		this.connectWebSocket(true);
	},

	isWsConnectionStale(now = Date.now()) {
		const lastPongAt = Number(this.wsLastPongAt ?? 0);
		if (!Number.isFinite(lastPongAt) || lastPongAt <= 0) {
			return false;
		}
		const staleAfterMs = Number(this.wsHeartbeatStaleMs ?? 45_000);
		const threshold =
			Number.isFinite(staleAfterMs) && staleAfterMs > 0 ? staleAfterMs : 45_000;
		return now - lastPongAt >= threshold;
	},

	startWsHeartbeat() {
		this.stopWsHeartbeat();
		this.wsPingTimer = setInterval(() => {
			if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
				return;
			}
			if (this.isWsConnectionStale()) {
				this.reconnectBannerMessage = "Connection stalled. Reconnecting…";
				this.showReconnectBanner = true;
				this.connectWebSocket(true);
				return;
			}
			if (hasStalePendingRpcCommands(this)) {
				bumpPendingRpcQueuedAt(this);
				this.reconnectBannerMessage =
					"Command response timed out. Reconnecting…";
				this.showReconnectBanner = true;
				this.connectWebSocket(true);
				return;
			}
			this.ws.send(
				JSON.stringify({
					type: "rpc_ping",
					ts: Date.now(),
				}),
			);
		}, 15000);
	},

	stopWsHeartbeat() {
		if (this.wsPingTimer) {
			clearInterval(this.wsPingTimer);
			this.wsPingTimer = null;
		}
	},

	nextRpcCommandId() {
		this.rpcCommandCounter += 1;
		return `rpc-${Date.now()}-${this.rpcCommandCounter}`;
	},

	isReplayableRpcCommand(commandType) {
		return (
			commandType === "prompt" ||
			commandType === "steer" ||
			commandType === "follow_up"
		);
	},

	prepareRpcPayload(payload) {
		if (
			!payload ||
			typeof payload !== "object" ||
			payload.type !== "rpc_command" ||
			!payload.command ||
			typeof payload.command !== "object"
		) {
			return payload;
		}

		const nextPayload = {
			...payload,
			command: {
				...payload.command,
			},
		};

		const commandId =
			typeof nextPayload.command.id === "string"
				? nextPayload.command.id.trim()
				: "";
		if (!commandId) {
			nextPayload.command.id = this.nextRpcCommandId();
		} else {
			nextPayload.command.id = commandId;
		}

		return nextPayload;
	},

	trackPendingRpcCommand(payload, options = {}) {
		if (
			!payload ||
			typeof payload !== "object" ||
			payload.type !== "rpc_command" ||
			!payload.command ||
			typeof payload.command !== "object" ||
			options.trackPending === false
		) {
			return;
		}

		const commandId =
			typeof payload.command.id === "string" ? payload.command.id : "";
		if (!commandId) {
			return;
		}
		const replayable =
			typeof options.replayable === "boolean"
				? options.replayable
				: this.isReplayableRpcCommand(payload.command.type);
		if (!replayable) {
			return;
		}

		let pendingMap = this.pendingRpcCommands;
		const rpcSessionId =
			typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
		const sessionFile =
			typeof payload.sessionFile === "string" ? payload.sessionFile.trim() : "";
		if ((rpcSessionId || sessionFile) && this.sessionStateById instanceof Map) {
			for (const state of this.sessionStateById.values()) {
				const matchesRpc = rpcSessionId && state?.rpcSessionId === rpcSessionId;
				const matchesFile = !rpcSessionId && sessionFile === state?.sessionFile;
				if (!matchesRpc && !matchesFile) {
					continue;
				}
				if (state.pendingRpcCommands instanceof Map) {
					pendingMap = state.pendingRpcCommands;
				}
				break;
			}
		}

		pendingMap.set(commandId, {
			payload: JSON.parse(JSON.stringify(payload)),
			queuedAt: Date.now(),
		});
	},
};
