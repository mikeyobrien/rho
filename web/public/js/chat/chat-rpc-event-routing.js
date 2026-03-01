import * as primitives from "./constants-and-primitives.js";
import * as modelThinking from "./model-thinking-and-toast.js";
import * as renderingUsage from "./rendering-and-usage.js";

// biome-ignore lint: ANSI escape code pattern is intentionally complex
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]|\x1b\].*?(?:\x07|\x1b\\)/g;
function stripAnsi(text) {
	return typeof text === "string" ? text.replace(ANSI_RE, "") : text;
}
import {
	recoverSessionByFile,
	replayPendingRpcCommandsForSession,
} from "./rpc-reconnect-runtime.js";
import {
	applyRpcLifecycleToSessionState,
	findSessionRouteByRpcSessionId,
	findSessionRouteBySessionFile,
	markSessionActivity,
	normalizeRpcSessionKey,
} from "./rpc-session-routing.js";
import * as toolSemantics from "./tool-semantics.js";

const { slashContract, normalizeThinkingLevel } = {
	...primitives,
	...toolSemantics,
	...renderingUsage,
	...modelThinking,
};

export const rhoChatRpcEventMethods = {
	replayPendingRpcCommands(sessionId = "") {
		replayPendingRpcCommandsForSession(this, sessionId);
	},

	sendWs(payload, options = {}) {
		const preparedPayload = this.prepareRpcPayload(payload);

		if (!this.ws) {
			this.error = "WebSocket not connected";
			return false;
		}

		if (this.ws.readyState === WebSocket.CONNECTING) {
			this.trackPendingRpcCommand(preparedPayload, options);
			this.ws.addEventListener(
				"open",
				() => {
					this.ws?.send(JSON.stringify(preparedPayload));
				},
				{ once: true },
			);
			return true;
		}

		if (this.ws.readyState !== WebSocket.OPEN) {
			this.error = "WebSocket not connected";
			return false;
		}

		this.trackPendingRpcCommand(preparedPayload, options);
		this.ws.send(JSON.stringify(preparedPayload));
		return true;
	},

	handleBackgroundRpcEvent(route, event) {
		if (!route || !event || event.type !== "response") {
			return;
		}
		if (event.command !== "get_state") {
			return;
		}
		if (event.success) {
			if (route.state.recoveringRpcSession) {
				route.state.recoveringRpcSession = false;
				this.replayPendingRpcCommands(route.sessionId);
			}
			return;
		}
		if (!route.state.recoveringRpcSession) {
			return;
		}
		route.state.recoveringRpcSession = false;
		recoverSessionByFile(this, route.sessionId, route.state);
	},

	handleWsMessage(event) {
		let payload = null;
		try {
			payload = JSON.parse(event.data);
		} catch {
			return;
		}

		if (!payload || typeof payload !== "object") {
			return;
		}

		if (payload.type === "rpc_pong") {
			return;
		}

		if (payload.type === "ui_event") {
			window.dispatchEvent(
				new CustomEvent("rho:ui-event", { detail: payload }),
			);
			return;
		}

		if (payload.type === "error") {
			this.error = payload.message ?? "WebSocket error";
			this.isForking = false;
			this.isSendingPrompt = false;
			return;
		}

		if (payload.type === "rpc_session_not_found") {
			const route = findSessionRouteByRpcSessionId(this, payload.sessionId);
			if (!route) {
				return;
			}

			const { sessionId, state, isFocused } = route;
			markSessionActivity(state);
			state.status = "error";
			state.error =
				payload.message ?? `Unknown RPC session: ${payload.sessionId ?? ""}`;
			state.recoveringRpcSession = false;
			state.rpcSessionId = "";
			state.lastEventSeq = 0;
			this.persistSessionRestoreSnapshot();

			if (!recoverSessionByFile(this, sessionId, state)) {
				return;
			}
			if (!isFocused) {
				state.unreadMilestone = true;
			}
			return;
		}

		if (payload.type === "rpc_replay_gap") {
			const route = findSessionRouteByRpcSessionId(this, payload.sessionId);
			if (route) {
				markSessionActivity(route.state);
				route.state.status = "error";
				route.state.error = "Replay gap detected. Resync required.";
				recoverSessionByFile(this, route.sessionId, route.state);
				if (!route.isFocused) {
					route.state.unreadMilestone = true;
					return;
				}
			}
			this.showReconnectBanner = true;
			this.reconnectBannerMessage =
				"Connection resumed, but some live events were missed. Reloading…";
			this.$nextTick(() => this.reloadActiveSession());
			return;
		}

		if (payload.type === "session_started") {
			const routeByFile = findSessionRouteBySessionFile(
				this,
				payload.sessionFile,
			);
			const focusedSessionId =
				typeof this.focusedSessionId === "string"
					? this.focusedSessionId.trim()
					: "";
			const targetSessionId = routeByFile?.sessionId ?? focusedSessionId;
			if (!targetSessionId) {
				return;
			}

			const targetState = this.ensureSessionState(targetSessionId, {
				sessionFile:
					typeof payload.sessionFile === "string" ? payload.sessionFile : "",
			});
			if (!targetState) {
				return;
			}

			targetState.rpcSessionId = normalizeRpcSessionKey(payload.sessionId);
			if (typeof payload.sessionFile === "string") {
				targetState.sessionFile = payload.sessionFile;
			}
			targetState.lastEventSeq = 0;
			targetState.status = "idle";
			targetState.error = "";
			targetState.isStreaming = false;
			targetState.isSendingPrompt = false;
			targetState.recoveringRpcSession = false;
			markSessionActivity(targetState);
			this.persistSessionRestoreSnapshot();

			if (targetSessionId === this.focusedSessionId) {
				this.isForking = false;
				this.requestState();
				this.requestAvailableModels();
				this.requestSlashCommands(true);
				return;
			}
			if (targetState.rpcSessionId) {
				this.sendWs(
					{
						type: "rpc_command",
						sessionId: targetState.rpcSessionId,
						lastEventSeq: targetState.lastEventSeq,
						command: { type: "get_state" },
					},
					{ replayable: false },
				);
			}
			return;
		}

		if (payload.type !== "rpc_event") {
			return;
		}

		const route = findSessionRouteByRpcSessionId(this, payload.sessionId);
		if (!route) {
			return;
		}

		const seq = Number(payload.seq ?? 0);
		if (Number.isFinite(seq) && seq > 0) {
			const lastSeq = Number(route.state.lastEventSeq ?? 0);
			if (seq <= lastSeq) {
				return;
			}
			route.state.lastEventSeq = seq;
		}

		const rpcEvent = payload.event;
		if (!rpcEvent || typeof rpcEvent !== "object") {
			return;
		}

		applyRpcLifecycleToSessionState(route, rpcEvent);
		if (route.isFocused) {
			this.handleRpcEvent(rpcEvent);
			return;
		}
		this.handleBackgroundRpcEvent(route, rpcEvent);
	},

	handleRpcEvent(event) {
		if (event.type === "response") {
			const responseId = typeof event.id === "string" ? event.id : "";
			if (responseId) {
				this.pendingRpcCommands.delete(responseId);
			}

			if (!event.success) {
				if (
					event.command === "prompt" &&
					this.pendingSlashClassification?.isSlash
				) {
					const rawError =
						event.error ?? `RPC command failed: ${event.command ?? "unknown"}`;
					this.error = slashContract.formatPromptFailure(
						this.pendingSlashClassification.raw ?? this.promptText,
						rawError,
					);
				} else {
					this.error =
						event.error ?? `RPC command failed: ${event.command ?? "unknown"}`;
				}
			}
			// Clear sending flag once RPC acknowledges the prompt.
			// For normal prompts, isStreaming (agent_start/agent_end) gates the UI.
			// For slash commands that bypass the LLM, this prevents a permanent lock.
			if (event.command === "prompt") {
				this.isSendingPrompt = false;
				this.pendingSlashClassification = null;
			}
			if (event.command === "switch_session" && event.success) {
				this.requestSessionStats();
			}
			// Handle get_state response
			if (event.command === "get_state") {
				if (event.success) {
					const state = event.state ?? event.data ?? {};
					this.handleStateUpdate(state);
					this.requestSessionStats();
					if (this.recoveringRpcSession) {
						this.recoveringRpcSession = false;
						this.replayPendingRpcCommands();
					}
				} else if (this.recoveringRpcSession) {
					this.recoveringRpcSession = false;
					const sessionFile =
						this.activeRpcSessionFile ||
						this.getSessionFile(this.activeSessionId);
					if (sessionFile) {
						this.activeRpcSessionId = "";
						this.startRpcSession(sessionFile);
					}
				}
			}
			// Handle get_available_models response
			if (event.command === "get_available_models" && event.success) {
				const models = event.models ?? event.data?.models ?? [];
				this.availableModels = models;
				this.syncThinkingLevels();
			}
			// Handle get_session_stats response
			if (event.command === "get_session_stats" && event.success) {
				const stats = event.stats ?? event.data ?? {};
				this.handleSessionStatsUpdate(stats);
			}
			// Handle get_commands response
			if (event.command === "get_commands") {
				this.slashCommandsLoading = false;
				if (event.success) {
					const commands = slashContract.normalizeCommandsPayload(
						event.data ?? event.commands ?? [],
					);
					this.slashCommands = commands;
					this.slashCommandIndex = slashContract.buildCommandIndex(commands);
					this.slashCommandsLoaded = true;
				}
			}
			return;
		}

		if (event.type === "agent_start") {
			this.isStreaming = true;
			this.updateFooter();
			return;
		}

		if (event.type === "agent_end") {
			this.isStreaming = false;
			this.isSendingPrompt = false;
			if (this.streamDisconnectedDuringResponse && this.isWsConnected) {
				this.streamDisconnectedDuringResponse = false;
				this.showReconnectBanner = false;
				this.reconnectBannerMessage = "";
			}
			this.updateFooter();
			// Refresh stats after agent completes
			this.requestSessionStats();
			// Auto-send next queued message
			if (this.promptQueue.length > 0) {
				const next = this.promptQueue.shift();
				this.promptText = next.text;
				this.pendingImages = next.images || [];
				this.$nextTick(() => this.sendPrompt());
			}
			return;
		}

		if (event.type === "state_changed" || event.type === "state_update") {
			if (event.state) {
				this.handleStateUpdate(event.state);
			}
			return;
		}

		if (event.type === "model_changed") {
			if (event.model) {
				this.currentModel = event.model;
			}
			this.syncThinkingLevels();
			this.updateFooter();
			return;
		}

		if (event.type === "thinking_level_changed") {
			if (event.thinkingLevel) {
				this.currentThinkingLevel = normalizeThinkingLevel(event.thinkingLevel);
			}
			this.syncThinkingLevels();
			this.updateFooter();
			return;
		}

		if (event.type === "message_start") {
			this.upsertMessage(event.message);
			return;
		}

		if (event.type === "message_update") {
			this.handleAssistantDelta(event);
			return;
		}

		if (event.type === "tool_execution_start") {
			this.handleToolExecutionStart(event);
			return;
		}

		if (event.type === "tool_execution_update") {
			this.handleToolExecutionUpdate(event);
			return;
		}

		if (event.type === "tool_execution_end") {
			this.handleToolExecutionEnd(event);
			return;
		}

		if (event.type === "message_end") {
			this.handleMessageEnd(event);
			return;
		}

		if (event.type === "auto_compaction_start") {
			this.appendBanner(
				"compaction",
				`Compaction started (${event.reason ?? "threshold"})`,
			);
			return;
		}

		if (event.type === "auto_compaction_end") {
			const summary =
				event.result?.summary ??
				event.errorMessage ??
				(event.aborted ? "Compaction aborted" : "Compaction complete");
			this.appendBanner("compaction", summary);
			return;
		}

		if (event.type === "auto_retry_start") {
			const attempt = Number(event.attempt ?? 0);
			const maxAttempts = Number(event.maxAttempts ?? 0);
			const line = `Retry ${attempt}/${maxAttempts} in ${Math.round(Number(event.delayMs ?? 0) / 1000)}s`;
			this.appendBanner("retry", line);
			return;
		}

		if (event.type === "auto_retry_end") {
			const status = event.success
				? "Retry succeeded"
				: `Retry failed: ${event.finalError ?? "unknown error"}`;
			this.appendBanner("retry", status);
			return;
		}

		if (event.type === "extension_error") {
			const line = `${event.extensionPath ?? "extension"}: ${event.error ?? "unknown error"}`;
			this.appendBanner("error", line);
			return;
		}

		if (event.type === "rpc_error" || event.type === "rpc_process_crashed") {
			this.error = event.message ?? "RPC process error";
			this.isSendingPrompt = false;
			return;
		}

		// Extension UI events
		if (event.type === "extension_ui_request") {
			this.handleExtensionUIRequest(event);
			return;
		}

		// Fire-and-forget extension events
		if (event.type === "notify" || event.type === "extension_notify") {
			this.showToast(
				stripAnsi(event.message ?? event.text ?? ""),
				event.level ?? "info",
				event.duration,
			);
			return;
		}

		if (event.type === "setStatus" || event.type === "extension_status") {
			this.extensionStatus = stripAnsi(event.text ?? event.message ?? "");
			this.updateFooter();
			return;
		}

		if (event.type === "setWidget" || event.type === "extension_widget") {
			this.extensionWidget = event.widget ?? event.content ?? null;
			return;
		}

		if (event.type === "setTitle" || event.type === "extension_title") {
			const title = event.title ?? event.text ?? "";
			if (title) {
				document.title = `${title} - Rho Web UI`;
			} else {
				document.title = "Rho Web UI";
			}
			return;
		}
	},
};
