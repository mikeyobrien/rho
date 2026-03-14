const CONTEXT_POLL_INTERVAL_MS = 2000;
const LEASE_TTL_MS = 3 * 60_000;
const UNKNOWN_RUNTIME_CLEAR_GRACE_MS = 30_000;

function normalizeRpcSessionId(value) {
	if (typeof value !== "string") {
		return "";
	}
	return value.trim();
}

function isMobileShellRoute() {
	if (typeof window === "undefined") {
		return false;
	}
	try {
		return (
			new URLSearchParams(window.location.search).get("mobile_shell") === "1"
		);
	} catch {
		return false;
	}
}

function getLiveModePlugin() {
	const plugins = globalThis?.Capacitor?.Plugins;
	const liveMode = plugins?.LiveMode;
	if (!liveMode || typeof liveMode !== "object") {
		return null;
	}
	if (
		typeof liveMode.setLiveContext !== "function" ||
		typeof liveMode.clearLiveContext !== "function"
	) {
		return null;
	}
	return liveMode;
}

function resolveChatViewModel() {
	if (typeof document === "undefined") {
		return null;
	}
	const host = document.querySelector('[x-data="rhoChat()"]');
	if (!host) {
		return null;
	}

	const stack = host._x_dataStack;
	if (Array.isArray(stack) && stack.length > 0 && stack[0]) {
		return stack[0];
	}

	const legacy = host.__x?.$data;
	if (legacy && typeof legacy === "object") {
		return legacy;
	}

	return null;
}

function stateLooksStreaming(state) {
	if (!state || typeof state !== "object") {
		return false;
	}
	return Boolean(
		state.isStreaming ||
			state.isSendingPrompt ||
			state.recoveringRpcSession ||
			state.status === "streaming" ||
			state.status === "starting",
	);
}

function resolveActiveRuntime(vm) {
	if (!vm || typeof vm !== "object") {
		return { ready: false, rpcSessionId: "", streaming: false };
	}

	const rpcSessionId = normalizeRpcSessionId(vm.activeRpcSessionId);
	const streaming = Boolean(
		vm.isStreaming ||
			vm.isSendingPrompt ||
			vm.recoveringRpcSession ||
			vm.awaitingStreamReconnectState,
	);

	if (rpcSessionId) {
		return { ready: true, rpcSessionId, streaming };
	}

	const map = vm.sessionStateById instanceof Map ? vm.sessionStateById : null;
	const focused =
		typeof vm.focusedSessionId === "string" ? vm.focusedSessionId.trim() : "";
	const bootstrapping = Boolean(
		vm.isLoadingSessions || vm.isRestoringPersistedSessionState,
	);

	if (!map) {
		return {
			ready: !bootstrapping && Boolean(focused),
			rpcSessionId: "",
			streaming: false,
		};
	}

	if (focused) {
		const state = map.get(focused);
		return {
			ready: !bootstrapping,
			rpcSessionId: normalizeRpcSessionId(state?.rpcSessionId),
			streaming: stateLooksStreaming(state),
		};
	}

	const hasAnySessionState = map.size > 0;
	return {
		ready: !bootstrapping && hasAnySessionState,
		rpcSessionId: "",
		streaming: false,
	};
}

async function syncLiveContext(state) {
	if (state.syncing) {
		return;
	}
	state.syncing = true;

	try {
		if (!state.plugin) {
			state.plugin = getLiveModePlugin();
			if (!state.plugin) {
				return;
			}
		}

		const vm = resolveChatViewModel();
		const runtime = resolveActiveRuntime(vm);
		if (!runtime.ready) {
			const elapsedMs = Date.now() - state.startedAt;
			if (elapsedMs < UNKNOWN_RUNTIME_CLEAR_GRACE_MS) {
				return;
			}
			if (state.lastAppliedKey === "") {
				return;
			}
			try {
				await state.plugin.clearLiveContext();
				state.lastAppliedKey = "";
			} catch (error) {
				console.debug("[mobile-live-mode] clearLiveContext failed", error);
			}
			return;
		}

		const nextKey =
			runtime.streaming && runtime.rpcSessionId ? runtime.rpcSessionId : "";
		if (nextKey === state.lastAppliedKey) {
			return;
		}

		if (!nextKey) {
			try {
				await state.plugin.clearLiveContext();
				state.lastAppliedKey = "";
			} catch (error) {
				console.debug("[mobile-live-mode] clearLiveContext failed", error);
			}
			return;
		}

		try {
			await state.plugin.setLiveContext({
				baseUrl: window.location.origin,
				rpcSessionId: nextKey,
				ttlMs: LEASE_TTL_MS,
			});
			state.lastAppliedKey = nextKey;
		} catch (error) {
			console.debug("[mobile-live-mode] setLiveContext failed", error);
		}
	} finally {
		state.syncing = false;
	}
}

export function initMobileLiveModeBridge() {
	if (!isMobileShellRoute()) {
		return;
	}

	const state = {
		plugin: getLiveModePlugin(),
		lastAppliedKey: null,
		timer: null,
		syncing: false,
		startedAt: Date.now(),
	};

	const tick = () => {
		void syncLiveContext(state);
	};

	tick();
	state.timer = setInterval(tick, CONTEXT_POLL_INTERVAL_MS);

	if (typeof window !== "undefined") {
		window.addEventListener("visibilitychange", tick);
		window.addEventListener("beforeunload", () => {
			if (state.timer) {
				clearInterval(state.timer);
				state.timer = null;
			}
		});
	}
}
