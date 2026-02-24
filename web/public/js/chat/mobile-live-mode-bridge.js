const CONTEXT_POLL_INTERVAL_MS = 2000;
const LEASE_TTL_MS = 3 * 60_000;

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
		return new URLSearchParams(window.location.search).get("mobile_shell") === "1";
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

function resolveActiveRuntime(vm) {
	if (!vm || typeof vm !== "object") {
		return { rpcSessionId: "", streaming: false };
	}

	const rpcSessionId = normalizeRpcSessionId(vm.activeRpcSessionId);
	const streaming = Boolean(
		vm.isStreaming ||
			vm.isSendingPrompt ||
			vm.recoveringRpcSession ||
			vm.awaitingStreamReconnectState,
	);

	if (rpcSessionId) {
		return { rpcSessionId, streaming };
	}

	if (!(vm.sessionStateById instanceof Map)) {
		return { rpcSessionId: "", streaming: false };
	}

	const focused = typeof vm.focusedSessionId === "string" ? vm.focusedSessionId.trim() : "";
	if (!focused) {
		return { rpcSessionId: "", streaming: false };
	}

	const state = vm.sessionStateById.get(focused);
	return {
		rpcSessionId: normalizeRpcSessionId(state?.rpcSessionId),
		streaming: Boolean(
			state?.isStreaming ||
				state?.isSendingPrompt ||
				state?.recoveringRpcSession ||
				state?.status === "streaming" ||
				state?.status === "starting",
		),
	};
}

async function syncLiveContext(state) {
	const vm = resolveChatViewModel();
	const runtime = resolveActiveRuntime(vm);
	const nextKey = runtime.streaming && runtime.rpcSessionId ? runtime.rpcSessionId : "";

	if (nextKey === state.lastKey) {
		return;
	}

	state.lastKey = nextKey;

	if (!nextKey) {
		try {
			await state.plugin.clearLiveContext();
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
	} catch (error) {
		console.debug("[mobile-live-mode] setLiveContext failed", error);
	}
}

export function initMobileLiveModeBridge() {
	if (!isMobileShellRoute()) {
		return;
	}

	const plugin = getLiveModePlugin();
	if (!plugin) {
		return;
	}

	const state = {
		plugin,
		lastKey: null,
		timer: null,
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
