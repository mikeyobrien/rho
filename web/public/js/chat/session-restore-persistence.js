import { fetchJson } from "./rendering-and-usage.js";
import { resumeReconnectSessions } from "./rpc-reconnect-runtime.js";

const SESSION_RESTORE_STORAGE_KEY = "rho-chat-restore-v1";
const SESSION_RESTORE_VERSION = 1;
const SESSION_RESTORE_DRAFT_DEBOUNCE_MS = 220;

const MOBILE_CAPTURE_REPLAY_TYPE = "RHO_CAPTURE_REPLAY";
const MOBILE_REPLAY_STATE_TYPE = "RHO_REPLAY_STATE";
const MOBILE_REPLAY_RESUME_TYPE = "RHO_REPLAY_RESUME";

function normalizeSessionId(value) {
	if (typeof value !== "string") {
		return "";
	}
	return value.trim();
}

function normalizeDrafts(input) {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return null;
	}
	const drafts = {};
	for (const [rawSessionId, rawDraft] of Object.entries(input)) {
		const sessionId = normalizeSessionId(rawSessionId);
		if (!sessionId || typeof rawDraft !== "string") {
			continue;
		}
		drafts[sessionId] = rawDraft;
	}
	return drafts;
}

function uniqueSessionIds(ids) {
	const seen = new Set();
	const unique = [];
	for (const rawId of ids) {
		const sessionId = normalizeSessionId(rawId);
		if (!sessionId || seen.has(sessionId)) {
			continue;
		}
		seen.add(sessionId);
		unique.push(sessionId);
	}
	return unique;
}

function normalizeSavedAt(value) {
	const parsed = Number(value);
	if (Number.isFinite(parsed) && parsed > 0) {
		return parsed;
	}
	return Date.now();
}

function normalizeEventSeq(value) {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0) {
		return 0;
	}
	return Math.floor(parsed);
}

function hasReplayablePending(state) {
	if (!state || typeof state !== "object") {
		return false;
	}
	if (state.pendingRpcCommands instanceof Map) {
		return state.pendingRpcCommands.size > 0;
	}
	return false;
}

function isRuntimeActiveState(state) {
	if (!state || typeof state !== "object") {
		return false;
	}
	const rpcSessionId = normalizeSessionId(state.rpcSessionId);
	if (rpcSessionId) {
		return true;
	}
	if (state.status === "starting" || state.status === "streaming") {
		return true;
	}
	if (Boolean(state.isStreaming) || Boolean(state.isSendingPrompt)) {
		return true;
	}
	if (hasReplayablePending(state)) {
		return true;
	}
	return false;
}

function buildPersistedRestorePayload(vm, savedAt = Date.now()) {
	const focusedSessionId =
		normalizeSessionId(vm?.focusedSessionId) ||
		normalizeSessionId(vm?.activeSessionId);
	const activeSessionIds = [];
	const drafts = {};

	if (vm?.sessionStateById instanceof Map) {
		for (const [rawSessionId, state] of vm.sessionStateById.entries()) {
			const sessionId = normalizeSessionId(rawSessionId);
			if (!sessionId || !state || typeof state !== "object") {
				continue;
			}
			if (isRuntimeActiveState(state)) {
				activeSessionIds.push(sessionId);
			}
			if (typeof state.promptText === "string" && state.promptText.length > 0) {
				drafts[sessionId] = state.promptText;
			}
		}
	}

	return {
		version: SESSION_RESTORE_VERSION,
		focusedSessionId: focusedSessionId || null,
		activeSessionIds: uniqueSessionIds(activeSessionIds),
		drafts,
		savedAt: normalizeSavedAt(savedAt),
	};
}

function normalizePersistedRestorePayload(input) {
	if (!input || typeof input !== "object" || Array.isArray(input)) {
		return null;
	}

	if (input.version !== SESSION_RESTORE_VERSION) {
		return null;
	}
	if (!Array.isArray(input.activeSessionIds)) {
		return null;
	}

	const drafts = normalizeDrafts(input.drafts ?? {});
	if (!drafts) {
		return null;
	}

	const focused = normalizeSessionId(input.focusedSessionId);
	return {
		version: SESSION_RESTORE_VERSION,
		focusedSessionId: focused || null,
		activeSessionIds: uniqueSessionIds(input.activeSessionIds),
		drafts,
		savedAt: normalizeSavedAt(input.savedAt),
	};
}

function parsePersistedRestorePayload(rawValue) {
	if (typeof rawValue !== "string" || rawValue.length === 0) {
		return null;
	}
	try {
		const parsed = JSON.parse(rawValue);
		return normalizePersistedRestorePayload(parsed);
	} catch {
		return null;
	}
}

function restoreStorage() {
	if (typeof localStorage === "undefined") {
		return null;
	}
	if (
		typeof localStorage.getItem !== "function" ||
		typeof localStorage.setItem !== "function"
	) {
		return null;
	}
	return localStorage;
}

function formatRestoreFailure(error) {
	const message =
		error instanceof Error
			? error.message
			: typeof error === "string"
				? error
				: "unknown restore error";
	return `Failed to restore session: ${message}`;
}

export const rhoChatSessionRestoreMethods = {
	sessionRestoreStorageKey: SESSION_RESTORE_STORAGE_KEY,
	sessionRestoreDraftDebounceMs: SESSION_RESTORE_DRAFT_DEBOUNCE_MS,
	persistedRestoreTimer: null,
	isRestoringPersistedSessionState: false,
	mobileReplayBridgeBound: false,
	mobileReplayMessageHandler: null,

	setupMobileReplayBridge() {
		if (this.mobileReplayBridgeBound || typeof window === "undefined") {
			return;
		}

		const messageHandler = (event) => {
			const payload = event?.data;
			if (!payload || typeof payload !== "object") {
				return;
			}

			if (payload.type === MOBILE_CAPTURE_REPLAY_TYPE) {
				const replayState = this.buildReplayStateForMobile(payload.sessionId);
				const source = event?.source;
				if (source && typeof source.postMessage === "function") {
					source.postMessage(
						{
							type: MOBILE_REPLAY_STATE_TYPE,
							...replayState,
						},
						"*",
					);
				}
				return;
			}

			if (payload.type === MOBILE_REPLAY_RESUME_TYPE) {
				this.handleMobileReplayResume(payload);
			}
		};

		window.addEventListener("message", messageHandler);
		this.mobileReplayBridgeBound = true;
		this.mobileReplayMessageHandler = messageHandler;
	},

	buildReplayStateForMobile(requestedSessionId = "") {
		const preferredSessionId =
			normalizeSessionId(requestedSessionId) ||
			normalizeSessionId(this.activeSessionId) ||
			normalizeSessionId(this.focusedSessionId);

		const fallbackState =
			typeof this.getFocusedSessionState === "function"
				? this.getFocusedSessionState()
				: null;

		const targetState = preferredSessionId
			? this.ensureSessionState(preferredSessionId)
			: fallbackState;

		const sessionId =
			preferredSessionId || normalizeSessionId(this.focusedSessionId);
		const rpcSessionId = normalizeSessionId(targetState?.rpcSessionId);
		const lastEventSeq = normalizeEventSeq(
			targetState?.lastEventSeq ?? this.lastRpcEventSeq,
		);

		return {
			sessionId,
			rpcSessionId,
			lastEventSeq,
		};
	},

	handleMobileReplayResume(payload) {
		if (!payload || typeof payload !== "object") {
			return;
		}

		const sessionId = normalizeSessionId(payload.sessionId);
		const rpcSessionId = normalizeSessionId(payload.rpcSessionId);
		const lastEventSeq = normalizeEventSeq(payload.lastEventSeq);
		const targetSessionId =
			sessionId ||
			normalizeSessionId(this.activeSessionId) ||
			normalizeSessionId(this.focusedSessionId);

		if (!targetSessionId) {
			if (!this.isWsConnected && typeof this.manualReconnect === "function") {
				this.manualReconnect();
			}
			return;
		}

		const state = this.ensureSessionState(targetSessionId);
		if (state) {
			if (rpcSessionId) {
				state.rpcSessionId = rpcSessionId;
			}
			state.lastEventSeq = lastEventSeq;
			state.recoveringRpcSession = true;
		}

		const resume = () => {
			if (this.ws && this.ws.readyState === WebSocket.OPEN && this.isWsConnected) {
				resumeReconnectSessions(this);
				return;
			}
			if (typeof this.manualReconnect === "function") {
				this.manualReconnect();
			}
		};

		if (
			targetSessionId &&
			targetSessionId !== this.activeSessionId &&
			typeof this.selectSession === "function"
		) {
			this.selectSession(targetSessionId, { updateHash: false })
				.catch(() => {})
				.finally(resume);
			return;
		}

		resume();
	},

	preparePersistedRestoreSnapshot(hashSessionId = "") {
		this.setupMobileReplayBridge();
		const storage = restoreStorage();
		if (!storage) {
			return null;
		}

		const raw = storage.getItem(this.sessionRestoreStorageKey);
		const snapshot = parsePersistedRestorePayload(raw);
		if (!snapshot) {
			return null;
		}

		if (
			normalizeSessionId(hashSessionId) ||
			!normalizeSessionId(snapshot.focusedSessionId)
		) {
			return snapshot;
		}

		this.isRestoringPersistedSessionState = true;
		try {
			this.activeSessionId = snapshot.focusedSessionId;
		} finally {
			this.isRestoringPersistedSessionState = false;
		}

		return snapshot;
	},

	persistSessionRestoreSnapshot() {
		if (this.isRestoringPersistedSessionState) {
			return;
		}
		const storage = restoreStorage();
		if (!storage) {
			return;
		}

		const payload = buildPersistedRestorePayload(this);
		try {
			storage.setItem(this.sessionRestoreStorageKey, JSON.stringify(payload));
		} catch {
			// Ignore localStorage write failures.
		}
	},

	schedulePersistSessionRestoreSnapshot() {
		if (this.isRestoringPersistedSessionState) {
			return;
		}
		if (this.persistedRestoreTimer) {
			clearTimeout(this.persistedRestoreTimer);
			this.persistedRestoreTimer = null;
		}
		const delay = Number(this.sessionRestoreDraftDebounceMs);
		const debounceMs =
			Number.isFinite(delay) && delay >= 0
				? delay
				: SESSION_RESTORE_DRAFT_DEBOUNCE_MS;
		this.persistedRestoreTimer = setTimeout(() => {
			this.persistedRestoreTimer = null;
			this.persistSessionRestoreSnapshot();
		}, debounceMs);
	},

	clearPersistedRestoreTimer() {
		if (!this.persistedRestoreTimer) {
			return;
		}
		clearTimeout(this.persistedRestoreTimer);
		this.persistedRestoreTimer = null;
	},

	async resolveSessionFileForRestore(sessionId) {
		const normalizedId = normalizeSessionId(sessionId);
		if (!normalizedId) {
			return "";
		}
		const knownState = this.ensureSessionState(normalizedId);
		if (typeof knownState?.sessionFile === "string" && knownState.sessionFile) {
			return knownState.sessionFile;
		}

		if (typeof this.getSessionFile === "function") {
			const knownFile = this.getSessionFile(normalizedId);
			if (typeof knownFile === "string" && knownFile.trim()) {
				this.ensureSessionState(normalizedId, { sessionFile: knownFile });
				return knownFile;
			}
		}

		const session = await fetchJson(`/api/sessions/${normalizedId}`);
		const sessionFile =
			typeof session?.file === "string" ? session.file.trim() : "";
		if (!sessionFile) {
			throw new Error("session file unavailable");
		}
		this.ensureSessionState(normalizedId, {
			sessionFile,
			activeSession: session,
		});
		return sessionFile;
	},

	async restorePersistedSessionRuntime(snapshot) {
		const normalized = normalizePersistedRestorePayload(snapshot);
		if (!normalized) {
			return;
		}

		this.isRestoringPersistedSessionState = true;
		try {
			for (const [sessionId, draft] of Object.entries(normalized.drafts)) {
				const state = this.ensureSessionState(sessionId);
				if (!state) {
					continue;
				}
				state.promptText = draft;
			}

			for (const sessionId of normalized.activeSessionIds) {
				const state = this.ensureSessionState(sessionId);
				if (!state) {
					continue;
				}
				if (
					normalizeSessionId(state.rpcSessionId) ||
					state.status === "starting"
				) {
					continue;
				}
				try {
					const sessionFile =
						await this.resolveSessionFileForRestore(sessionId);
					if (!sessionFile) {
						throw new Error("session file unavailable");
					}
					if (typeof this.startRpcSession === "function") {
						this.startRpcSession(sessionFile, { sessionId });
					}
				} catch (error) {
					state.status = "error";
					state.error = formatRestoreFailure(error);
					state.lastActivityAt = Date.now();
				}
			}
		} finally {
			this.isRestoringPersistedSessionState = false;
		}

		this.persistSessionRestoreSnapshot();
	},
};

export {
	SESSION_RESTORE_STORAGE_KEY,
	SESSION_RESTORE_VERSION,
	buildPersistedRestorePayload,
	parsePersistedRestorePayload,
	normalizePersistedRestorePayload,
	isRuntimeActiveState,
};
