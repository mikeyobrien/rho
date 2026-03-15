function toFiniteNumber(value, fallback = 0) {
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : fallback;
}

function parseTimestampMs(value) {
	if (typeof value === "number") {
		return Number.isFinite(value) ? value : 0;
	}
	if (typeof value !== "string") {
		return 0;
	}
	const trimmed = value.trim();
	if (!trimmed) {
		return 0;
	}
	const parsed = Date.parse(trimmed);
	return Number.isFinite(parsed) ? parsed : 0;
}

function sessionRecencyMs(session) {
	return Math.max(
		parseTimestampMs(session?.updatedAt),
		parseTimestampMs(session?.timestamp),
	);
}

function normalizeStatus(rawStatus, isStreaming) {
	if (isStreaming) {
		return "streaming";
	}
	const status =
		typeof rawStatus === "string" ? rawStatus.trim().toLowerCase() : "";
	if (status === "starting" || status === "streaming" || status === "error") {
		return status;
	}
	return "idle";
}

function getSessionState(session, sessionStateById) {
	if (!(sessionStateById instanceof Map)) {
		return null;
	}
	const sessionId = typeof session?.id === "string" ? session.id.trim() : "";
	if (!sessionId) {
		return null;
	}
	return sessionStateById.get(sessionId) ?? null;
}

function hasRuntimeBinding(state) {
	if (!state || typeof state !== "object") {
		return false;
	}
	const rpcSessionId =
		typeof state.rpcSessionId === "string" ? state.rpcSessionId.trim() : "";
	if (rpcSessionId) {
		return true;
	}
	if (
		state.pendingRpcCommands instanceof Map &&
		state.pendingRpcCommands.size > 0
	) {
		return true;
	}
	if (state.status === "starting") {
		return true;
	}
	if (state.isStreaming || state.isSendingPrompt) {
		return true;
	}
	return false;
}

export function getSessionRowMeta(session, sessionStateById) {
	const state = getSessionState(session, sessionStateById);
	const status = normalizeStatus(state?.status, Boolean(state?.isStreaming));
	const lastActivityAt = toFiniteNumber(state?.lastActivityAt, 0);
	const sortAnchorAt = toFiniteNumber(state?.sortAnchorAt, 0);
	const unreadMilestone = Boolean(state?.unreadMilestone);
	const isActiveRuntime =
		hasRuntimeBinding(state) || Boolean(session?.isActive);

	return {
		status,
		unreadMilestone,
		lastActivityAt,
		sortAnchorAt,
		isActiveRuntime,
	};
}

function sessionSortGroup(meta) {
	if (meta.status === "streaming") {
		return 0;
	}
	if (meta.isActiveRuntime) {
		return 1;
	}
	return 2;
}

export function compareSessionsForSidebar(a, b, sessionStateById) {
	const metaA = getSessionRowMeta(a, sessionStateById);
	const metaB = getSessionRowMeta(b, sessionStateById);

	const groupDiff = sessionSortGroup(metaA) - sessionSortGroup(metaB);
	if (groupDiff !== 0) {
		return groupDiff;
	}

	const sortAnchorDiff = metaB.sortAnchorAt - metaA.sortAnchorAt;
	if (sortAnchorDiff !== 0) {
		return sortAnchorDiff;
	}

	const recencyDiff = sessionRecencyMs(b) - sessionRecencyMs(a);
	if (recencyDiff !== 0) {
		return recencyDiff;
	}

	const idA = typeof a?.id === "string" ? a.id : "";
	const idB = typeof b?.id === "string" ? b.id : "";
	return idB.localeCompare(idA);
}

export function sortSessionsForSidebar(sessions, sessionStateById) {
	if (!Array.isArray(sessions)) {
		return [];
	}
	return [...sessions].sort((a, b) =>
		compareSessionsForSidebar(a, b, sessionStateById),
	);
}

export function sessionStatusBadgeText(meta) {
	if (!meta || typeof meta !== "object") {
		return "";
	}
	if (meta.status === "streaming") {
		return "live";
	}
	if (meta.status === "starting") {
		return "starting";
	}
	if (meta.status === "error") {
		return "error";
	}
	if (meta.isActiveRuntime) {
		return "active";
	}
	return "";
}
