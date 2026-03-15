function normalizeSessionId(value) {
	if (typeof value !== "string") {
		return "";
	}
	return value.trim();
}

function normalizeSessionFile(value) {
	if (typeof value !== "string") {
		return "";
	}
	return value.trim();
}

function normalizeEventSeq(value) {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) {
		return 0;
	}
	return Math.floor(parsed);
}

function pendingReplayCount(state) {
	if (state?.pendingRpcCommands instanceof Map) {
		return state.pendingRpcCommands.size;
	}
	return 0;
}

function shouldReconnectState(state) {
	if (!state || typeof state !== "object") {
		return false;
	}
	if (normalizeSessionId(state.rpcSessionId)) {
		return true;
	}
	if (state.recoveringRpcSession) {
		return true;
	}
	if (state.status === "starting" || state.status === "streaming") {
		return true;
	}
	if (Boolean(state.isStreaming) || Boolean(state.isSendingPrompt)) {
		return true;
	}
	return pendingReplayCount(state) > 0;
}

function resolveStateForSession(vm, sessionId) {
	const normalizedSessionId = normalizeSessionId(sessionId);
	if (normalizedSessionId && vm?.sessionStateById instanceof Map) {
		const state = vm.sessionStateById.get(normalizedSessionId);
		if (state && typeof state === "object") {
			return state;
		}
	}
	if (typeof vm?.getFocusedSessionState === "function") {
		const focusedState = vm.getFocusedSessionState();
		if (focusedState && typeof focusedState === "object") {
			return focusedState;
		}
	}
	return null;
}

function buildReconnectTarget(sessionId, state) {
	if (!state || typeof state !== "object" || !shouldReconnectState(state)) {
		return null;
	}
	return {
		sessionId: normalizeSessionId(sessionId),
		state,
		rpcSessionId: normalizeSessionId(state.rpcSessionId),
		sessionFile: normalizeSessionFile(state.sessionFile),
		lastEventSeq: normalizeEventSeq(state.lastEventSeq),
	};
}

export function collectReconnectSessionTargets(vm) {
	const targets = [];
	const seen = new Set();

	if (vm?.sessionStateById instanceof Map) {
		for (const [sessionId, state] of vm.sessionStateById.entries()) {
			const target = buildReconnectTarget(sessionId, state);
			if (!target) {
				continue;
			}
			const dedupeKey =
				target.sessionId || target.rpcSessionId || target.sessionFile;
			if (!dedupeKey || seen.has(dedupeKey)) {
				continue;
			}
			seen.add(dedupeKey);
			targets.push(target);
		}
	}

	if (targets.length > 0) {
		return targets;
	}

	const fallbackState = resolveStateForSession(
		vm,
		normalizeSessionId(vm?.focusedSessionId ?? vm?.activeSessionId),
	);
	if (!fallbackState) {
		return targets;
	}

	const fallbackRpcSessionId =
		normalizeSessionId(fallbackState.rpcSessionId) ||
		normalizeSessionId(vm?.activeRpcSessionId);
	const fallbackSessionFile =
		normalizeSessionFile(fallbackState.sessionFile) ||
		normalizeSessionFile(vm?.activeRpcSessionFile);
	const fallbackSeq =
		normalizeEventSeq(fallbackState.lastEventSeq) ||
		normalizeEventSeq(vm?.lastRpcEventSeq);
	if (fallbackRpcSessionId) {
		fallbackState.rpcSessionId = fallbackRpcSessionId;
	}
	if (fallbackSessionFile) {
		fallbackState.sessionFile = fallbackSessionFile;
	}
	fallbackState.lastEventSeq = fallbackSeq;

	const target = buildReconnectTarget(
		normalizeSessionId(vm?.focusedSessionId ?? vm?.activeSessionId),
		fallbackState,
	);

	if (target) {
		targets.push(target);
	}
	return targets;
}

export function resumeReconnectSessions(vm) {
	const reconnectTargets = collectReconnectSessionTargets(vm);
	let resumedAnySession = false;
	for (const target of reconnectTargets) {
		const { sessionId, state, rpcSessionId, sessionFile, lastEventSeq } =
			target;
		// Skip if already starting — a switch_session command is already in flight
		// and the stale rpcSessionId would just trigger rpc_session_not_found.
		if (state.status === "starting") {
			continue;
		}
		if (rpcSessionId) {
			state.recoveringRpcSession = true;
			const resumed = vm.sendWs(
				{
					type: "rpc_command",
					sessionId: rpcSessionId,
					lastEventSeq,
					command: { type: "get_state" },
				},
				{ replayable: false },
			);
			if (resumed) {
				resumedAnySession = true;
				continue;
			}
			state.recoveringRpcSession = false;
		}
		if (sessionFile) {
			state.recoveringRpcSession = true;
			vm.startRpcSession(sessionFile, { sessionId });
			resumedAnySession = true;
		}
	}
	if (
		resumedAnySession &&
		typeof vm.persistSessionRestoreSnapshot === "function"
	) {
		vm.persistSessionRestoreSnapshot();
	}
	return resumedAnySession;
}

export function replayPendingRpcCommandsForSession(vm, sessionId = "") {
	const state = resolveStateForSession(vm, sessionId);
	if (!state || state.replayingPendingRpc) {
		return false;
	}
	if (!vm?.ws || vm.ws.readyState !== WebSocket.OPEN || !vm?.isWsConnected) {
		return false;
	}

	const rpcSessionId = normalizeSessionId(state.rpcSessionId);
	if (!rpcSessionId) {
		return false;
	}
	const pendingMap = state.pendingRpcCommands;
	if (!(pendingMap instanceof Map) || pendingMap.size === 0) {
		return false;
	}

	state.replayingPendingRpc = true;
	try {
		for (const [commandId, entry] of pendingMap.entries()) {
			const pendingPayload = JSON.parse(JSON.stringify(entry.payload));
			pendingPayload.sessionId = rpcSessionId;
			if (!pendingPayload.command?.id) {
				pendingPayload.command = {
					...(pendingPayload.command ?? {}),
					id: commandId,
				};
			}
			vm.ws.send(JSON.stringify(pendingPayload));
		}
		return true;
	} finally {
		state.replayingPendingRpc = false;
	}
}

export function recoverSessionByFile(vm, sessionId, state = null) {
	const targetSessionId = normalizeSessionId(sessionId);
	const targetState = state ?? resolveStateForSession(vm, targetSessionId);
	if (!targetState) {
		return false;
	}

	// If the session already acquired a fresh rpcSessionId (e.g. from a
	// session_started that arrived before this recovery path ran), don't
	// clobber it with another startRpcSession — that causes thrashing.
	if (normalizeSessionId(targetState.rpcSessionId)) {
		targetState.recoveringRpcSession = false;
		return false;
	}

	let sessionFile = normalizeSessionFile(targetState.sessionFile);
	if (
		!sessionFile &&
		typeof vm?.getSessionFile === "function" &&
		targetSessionId
	) {
		sessionFile = normalizeSessionFile(vm.getSessionFile(targetSessionId));
	}
	if (!sessionFile || typeof vm?.startRpcSession !== "function") {
		return false;
	}

	targetState.recoveringRpcSession = true;
	targetState.rpcSessionId = "";
	targetState.lastEventSeq = 0;
	vm.startRpcSession(sessionFile, { sessionId: targetSessionId });
	if (typeof vm.persistSessionRestoreSnapshot === "function") {
		vm.persistSessionRestoreSnapshot();
	}
	return true;
}
