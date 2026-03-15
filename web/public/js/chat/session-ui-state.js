function normalizeSessionId(sessionId) {
	if (typeof sessionId !== "string") {
		return "";
	}
	return sessionId.trim();
}

function finiteOr(value, fallback) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function createDefaultSessionStats() {
	return {
		tokens: 0,
		cost: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheRead: 0,
		cacheWrite: 0,
	};
}

function normalizeSessionStats(stats) {
	const source = stats && typeof stats === "object" ? stats : {};
	const defaults = createDefaultSessionStats();
	return {
		tokens: finiteOr(source.tokens, defaults.tokens),
		cost: finiteOr(source.cost, defaults.cost),
		inputTokens: finiteOr(source.inputTokens, defaults.inputTokens),
		outputTokens: finiteOr(source.outputTokens, defaults.outputTokens),
		cacheRead: finiteOr(source.cacheRead, defaults.cacheRead),
		cacheWrite: finiteOr(source.cacheWrite, defaults.cacheWrite),
	};
}

function cloneCollection(value, fallbackFactory) {
	if (Array.isArray(value)) {
		return [...value];
	}
	if (value instanceof Map) {
		return new Map(value);
	}
	if (value instanceof Set) {
		return new Set(value);
	}
	return fallbackFactory();
}

function createSessionUiState(sessionId, meta = {}) {
	const normalizedId = normalizeSessionId(sessionId);
	const source = meta && typeof meta === "object" ? meta : {};

	return {
		sessionId: normalizedId,
		sessionFile:
			typeof source.sessionFile === "string" ? source.sessionFile : "",
		rpcSessionId:
			typeof source.rpcSessionId === "string" ? source.rpcSessionId : "",
		lastEventSeq: finiteOr(source.lastEventSeq, 0),
		status: typeof source.status === "string" ? source.status : "idle",
		unreadMilestone: Boolean(source.unreadMilestone),
		lastActivityAt: finiteOr(source.lastActivityAt, 0),
		sortAnchorAt: finiteOr(source.sortAnchorAt, 0),
		error: typeof source.error === "string" ? source.error : "",

		activeSession: source.activeSession ?? null,
		renderedMessages: cloneCollection(source.renderedMessages, () => []),
		allNormalizedMessages: cloneCollection(
			source.allNormalizedMessages,
			() => [],
		),
		hasEarlierMessages: Boolean(source.hasEarlierMessages),
		streamMessageId:
			typeof source.streamMessageId === "string" ? source.streamMessageId : "",
		isStreaming: Boolean(source.isStreaming),
		isSendingPrompt: Boolean(source.isSendingPrompt),

		promptText: typeof source.promptText === "string" ? source.promptText : "",
		pendingImages: cloneCollection(source.pendingImages, () => []),
		promptQueue: cloneCollection(source.promptQueue, () => []),
		showQueue: Boolean(source.showQueue),

		sessionStats: normalizeSessionStats(source.sessionStats),
		usageAccountedMessageIds: cloneCollection(
			source.usageAccountedMessageIds,
			() => new Set(),
		),
		pendingRpcCommands: cloneCollection(
			source.pendingRpcCommands,
			() => new Map(),
		),
		toolCallPartById: cloneCollection(source.toolCallPartById, () => new Map()),

		pendingSlashClassification: source.pendingSlashClassification ?? null,
		slashCommands: cloneCollection(source.slashCommands, () => []),
		slashCommandIndex: cloneCollection(
			source.slashCommandIndex,
			() => new Map(),
		),
		slashCommandsLoading: Boolean(source.slashCommandsLoading),
		slashCommandsLoaded: Boolean(source.slashCommandsLoaded),
		slashAcVisible: Boolean(source.slashAcVisible),
		slashAcItems: cloneCollection(source.slashAcItems, () => []),
		slashAcIndex: finiteOr(source.slashAcIndex, 0),

		availableModels: cloneCollection(source.availableModels, () => []),
		currentModel: source.currentModel ?? null,
		currentThinkingLevel:
			typeof source.currentThinkingLevel === "string"
				? source.currentThinkingLevel
				: "medium",
		pendingModelChange: source.pendingModelChange ?? null,
		extensionStatus:
			typeof source.extensionStatus === "string" ? source.extensionStatus : "",

		recoveringRpcSession: Boolean(source.recoveringRpcSession),
		replayingPendingRpc: Boolean(source.replayingPendingRpc),
		streamDisconnectedDuringResponse: Boolean(
			source.streamDisconnectedDuringResponse,
		),
		awaitingStreamReconnectState: Boolean(source.awaitingStreamReconnectState),
	};
}

function applySessionMeta(state, meta = {}) {
	if (!state || typeof state !== "object") {
		return;
	}
	if (!meta || typeof meta !== "object") {
		return;
	}

	for (const [key, value] of Object.entries(meta)) {
		if (key === "sessionId" || value === undefined) {
			continue;
		}
		if (!(key in state)) {
			continue;
		}
		if (Array.isArray(value)) {
			state[key] = [...value];
			continue;
		}
		if (value instanceof Map) {
			state[key] = new Map(value);
			continue;
		}
		if (value instanceof Set) {
			state[key] = new Set(value);
			continue;
		}
		state[key] = value;
	}
}

function ensureSessionStateById(
	sessionStateById,
	sessionId,
	meta = {},
	options = {},
) {
	const id = normalizeSessionId(sessionId);
	if (!id) {
		return null;
	}
	if (!(sessionStateById instanceof Map)) {
		return null;
	}

	let state = sessionStateById.get(id) ?? null;
	if (!state) {
		state = createSessionUiState(id, meta);
		const makeReactive = options.makeReactive;
		if (typeof makeReactive === "function") {
			state = makeReactive(state);
		}
		sessionStateById.set(id, state);
		return state;
	}

	applySessionMeta(state, meta);
	return state;
}

function getFocusedSessionStateById(sessionStateById, focusedSessionId) {
	if (!(sessionStateById instanceof Map)) {
		return null;
	}
	const id = normalizeSessionId(focusedSessionId);
	if (!id) {
		return null;
	}
	return sessionStateById.get(id) ?? null;
}

export {
	createDefaultSessionStats,
	createSessionUiState,
	applySessionMeta,
	ensureSessionStateById,
	getFocusedSessionStateById,
};
