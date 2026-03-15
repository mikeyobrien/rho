export function normalizeRpcSessionKey(sessionId) {
	if (typeof sessionId !== "string") {
		return "";
	}
	return sessionId.trim();
}

export function findSessionRouteByRpcSessionId(vm, rpcSessionId) {
	const targetRpcSessionId = normalizeRpcSessionKey(rpcSessionId);
	if (!targetRpcSessionId) {
		return null;
	}
	if (!(vm?.sessionStateById instanceof Map)) {
		return null;
	}

	for (const [sessionId, state] of vm.sessionStateById.entries()) {
		if (!state || typeof state !== "object") {
			continue;
		}
		if (state.rpcSessionId !== targetRpcSessionId) {
			continue;
		}
		return {
			sessionId,
			rpcSessionId: targetRpcSessionId,
			state,
			isFocused: sessionId === vm.focusedSessionId,
		};
	}

	return null;
}

export function findSessionRouteBySessionFile(vm, sessionFile) {
	const targetSessionFile =
		typeof sessionFile === "string" ? sessionFile.trim() : "";
	if (!targetSessionFile) {
		return null;
	}
	if (!(vm?.sessionStateById instanceof Map)) {
		return null;
	}

	for (const [sessionId, state] of vm.sessionStateById.entries()) {
		if (!state || typeof state !== "object") {
			continue;
		}
		if (state.sessionFile !== targetSessionFile) {
			continue;
		}
		return {
			sessionId,
			state,
			isFocused: sessionId === vm.focusedSessionId,
		};
	}

	return null;
}

export function markSessionActivity(state) {
	if (!state || typeof state !== "object") {
		return;
	}
	state.lastActivityAt = Date.now();
}

export function bumpSessionSortAnchor(state) {
	if (!state || typeof state !== "object") {
		return;
	}
	state.sortAnchorAt = Date.now();
}

function shouldMarkUnreadBackgroundActivity(eventType) {
	return (
		eventType === "message_start" ||
		eventType === "message_end" ||
		eventType === "tool_execution_start"
	);
}

export function applyRpcLifecycleToSessionState(route, event) {
	if (!route || !route.state || !event || typeof event !== "object") {
		return;
	}

	const state = route.state;
	const isFocused = Boolean(route.isFocused);

	markSessionActivity(state);
	if (!isFocused && shouldMarkUnreadBackgroundActivity(event.type)) {
		state.unreadMilestone = true;
	}

	if (event.type === "agent_start") {
		state.status = "streaming";
		state.isStreaming = true;
		state.error = "";
		bumpSessionSortAnchor(state);
		return;
	}

	if (event.type === "agent_end") {
		state.status = "idle";
		state.isStreaming = false;
		state.isSendingPrompt = false;
		bumpSessionSortAnchor(state);
		if (!isFocused) {
			state.unreadMilestone = true;
		}
		return;
	}

	if (event.type === "rpc_error" || event.type === "rpc_process_crashed") {
		state.status = "error";
		state.isStreaming = false;
		state.isSendingPrompt = false;
		state.error = event.message ?? "RPC process error";
		bumpSessionSortAnchor(state);
		if (!isFocused) {
			state.unreadMilestone = true;
		}
		return;
	}

	if (
		event.type === "rpc_session_stopped" ||
		event.type === "rpc_idle_timeout"
	) {
		state.status = "idle";
		state.rpcSessionId = "";
		state.isStreaming = false;
		state.isSendingPrompt = false;
		state.recoveringRpcSession = false;
		state.replayingPendingRpc = false;
		state.error = "";
		bumpSessionSortAnchor(state);
		if (state.pendingRpcCommands instanceof Map) {
			state.pendingRpcCommands.clear();
		}
		return;
	}

	if (event.type === "response") {
		const responseId = typeof event.id === "string" ? event.id : "";
		if (responseId && state.pendingRpcCommands instanceof Map) {
			state.pendingRpcCommands.delete(responseId);
		}
		if (event.command === "prompt") {
			state.isSendingPrompt = false;
		}
		if (!event.success) {
			state.status = "error";
			state.error =
				event.error ?? `RPC command failed: ${event.command ?? "unknown"}`;
			if (event.command === "prompt") {
				bumpSessionSortAnchor(state);
			}
			if (!isFocused && event.command === "prompt") {
				state.unreadMilestone = true;
			}
			return;
		}

		if (isFocused && event.command === "get_state") {
			state.unreadMilestone = false;
		}

		const responseState = event.state ?? event.data ?? null;
		if (responseState && typeof responseState === "object") {
			if (typeof responseState.isStreaming === "boolean") {
				const previousIsStreaming = Boolean(state.isStreaming);
				state.isStreaming = responseState.isStreaming;
				state.status = responseState.isStreaming ? "streaming" : "idle";
				if (previousIsStreaming !== responseState.isStreaming) {
					bumpSessionSortAnchor(state);
				}
			}
			return;
		}
		if (state.status === "starting") {
			state.status = "idle";
			bumpSessionSortAnchor(state);
		}
		return;
	}

	if (event.type === "state_changed" || event.type === "state_update") {
		if (isFocused) {
			state.unreadMilestone = false;
		}
		const snapshot = event.state;
		if (snapshot && typeof snapshot === "object") {
			if (typeof snapshot.isStreaming === "boolean") {
				const previousIsStreaming = Boolean(state.isStreaming);
				state.isStreaming = snapshot.isStreaming;
				state.status = snapshot.isStreaming ? "streaming" : "idle";
				if (previousIsStreaming !== snapshot.isStreaming) {
					bumpSessionSortAnchor(state);
				}
			}
		}
		return;
	}

	if (
		event.type === "message_start" ||
		event.type === "message_update" ||
		event.type === "tool_execution_start" ||
		event.type === "tool_execution_update" ||
		event.type === "tool_execution_end"
	) {
		state.isStreaming = true;
		if (state.status !== "error") {
			state.status = "streaming";
		}
	}
}
