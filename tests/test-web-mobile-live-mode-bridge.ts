import path from "node:path";
import { pathToFileURL } from "node:url";

let PASS = 0;
let FAIL = 0;

function assert(condition: boolean, label: string): void {
	if (condition) {
		console.log(`  PASS: ${label}`);
		PASS += 1;
		return;
	}
	console.error(`  FAIL: ${label}`);
	FAIL += 1;
}

function assertEq(actual: unknown, expected: unknown, label: string): void {
	if (Object.is(actual, expected)) {
		console.log(`  PASS: ${label}`);
		PASS += 1;
		return;
	}
	console.error(
		`  FAIL: ${label} (expected ${String(expected)}, got ${String(actual)})`,
	);
	FAIL += 1;
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

type MockPlugin = {
	setCalls: number;
	clearCalls: number;
	setLiveContext: (context: unknown) => Promise<{ ok: boolean; state: string }>;
	clearLiveContext: () => Promise<{ ok: boolean; state: string }>;
};

function createPlugin(
	options: { failSetCalls?: number; failClearCalls?: number } = {},
): MockPlugin {
	const failSetCalls = Number(options.failSetCalls ?? 0);
	const failClearCalls = Number(options.failClearCalls ?? 0);

	let setCalls = 0;
	let clearCalls = 0;

	return {
		get setCalls() {
			return setCalls;
		},
		get clearCalls() {
			return clearCalls;
		},
		async setLiveContext() {
			setCalls += 1;
			if (setCalls <= failSetCalls) {
				throw new Error("setLiveContext transient failure");
			}
			return { ok: true, state: "live" };
		},
		async clearLiveContext() {
			clearCalls += 1;
			if (clearCalls <= failClearCalls) {
				throw new Error("clearLiveContext transient failure");
			}
			return { ok: true, state: "live" };
		},
	};
}

function buildStreamingVm(rpcSessionId = "rpc-live") {
	return {
		activeRpcSessionId: rpcSessionId,
		isStreaming: true,
		isSendingPrompt: false,
		recoveringRpcSession: false,
		awaitingStreamReconnectState: false,
		sessionStateById: new Map([
			[
				"sess-1",
				{
					rpcSessionId,
					isStreaming: true,
					status: "streaming",
				},
			],
		]),
		focusedSessionId: "sess-1",
		isLoadingSessions: false,
		isRestoringPersistedSessionState: false,
	};
}

function buildIdleVm() {
	return {
		activeRpcSessionId: "",
		isStreaming: false,
		isSendingPrompt: false,
		recoveringRpcSession: false,
		awaitingStreamReconnectState: false,
		sessionStateById: new Map([
			[
				"sess-1",
				{
					rpcSessionId: "",
					isStreaming: false,
					status: "idle",
				},
			],
		]),
		focusedSessionId: "sess-1",
		isLoadingSessions: false,
		isRestoringPersistedSessionState: false,
	};
}

type HarnessOptions = {
	mobileShell?: boolean;
	plugin?: MockPlugin | null;
};

type HarnessContext = {
	init: () => void;
	setPlugin: (plugin: MockPlugin | null) => void;
	setViewModel: (vm: Record<string, unknown> | null) => void;
	runIntervalTick: () => Promise<void>;
	intervalCount: () => number;
};

async function withHarness(
	options: HarnessOptions,
	run: (ctx: HarnessContext) => Promise<void>,
): Promise<void> {
	const globals = globalThis as Record<string, unknown>;

	const originalWindow = globals.window;
	const originalDocument = globals.document;
	const originalCapacitor = globals.Capacitor;
	const originalSetInterval = globals.setInterval;
	const originalClearInterval = globals.clearInterval;

	let host: Record<string, unknown> | null = null;
	let plugin: MockPlugin | null = options.plugin ?? null;
	const intervals = new Map<number, () => void>();
	let nextTimerId = 1;
	const windowListeners = new Map<string, Array<() => void>>();

	const windowMock = {
		location: {
			search: options.mobileShell === false ? "" : "?mobile_shell=1",
			origin: "https://rho.example",
		},
		addEventListener(type: string, listener: () => void) {
			const current = windowListeners.get(type) ?? [];
			current.push(listener);
			windowListeners.set(type, current);
		},
		removeEventListener() {
			// not needed for this harness
		},
	};

	const documentMock = {
		querySelector(selector: string) {
			if (selector !== '[x-data="rhoChat()"]') {
				return null;
			}
			return host;
		},
	};

	const setIntervalMock = (callback: () => void): number => {
		const id = nextTimerId++;
		intervals.set(id, callback);
		return id;
	};

	const clearIntervalMock = (id: number): void => {
		intervals.delete(id);
	};

	const applyPlugin = () => {
		globals.Capacitor = plugin
			? {
					Plugins: {
						LiveMode: plugin,
					},
				}
			: { Plugins: {} };
	};

	globals.window = windowMock;
	globals.document = documentMock;
	globals.setInterval = setIntervalMock;
	globals.clearInterval = clearIntervalMock;
	applyPlugin();

	try {
		const importDir = import.meta.dirname;
		if (!importDir) {
			throw new Error("import.meta.dirname is unavailable");
		}
		const modulePath = path.resolve(
			importDir,
			"../web/public/js/chat/mobile-live-mode-bridge.js",
		);
		const moduleUrl = `${pathToFileURL(modulePath).href}?bridge-test=${Date.now()}-${Math.random()}`;
		const mod = await import(moduleUrl);
		const init = mod.initMobileLiveModeBridge as () => void;

		await run({
			init,
			setPlugin(nextPlugin) {
				plugin = nextPlugin;
				applyPlugin();
			},
			setViewModel(vm) {
				host = vm ? { _x_dataStack: [vm] } : null;
			},
			async runIntervalTick() {
				for (const callback of [...intervals.values()]) {
					callback();
				}
				await flushMicrotasks();
			},
			intervalCount() {
				return intervals.size;
			},
		});
	} finally {
		if (originalWindow === undefined) {
			globals.window = undefined;
		} else {
			globals.window = originalWindow;
		}

		if (originalDocument === undefined) {
			globals.document = undefined;
		} else {
			globals.document = originalDocument;
		}

		if (originalCapacitor === undefined) {
			globals.Capacitor = undefined;
		} else {
			globals.Capacitor = originalCapacitor;
		}

		if (originalSetInterval === undefined) {
			globals.setInterval = undefined;
		} else {
			globals.setInterval = originalSetInterval;
		}

		if (originalClearInterval === undefined) {
			globals.clearInterval = undefined;
		} else {
			globals.clearInterval = originalClearInterval;
		}
	}
}

console.log("\n=== Web Mobile Live Mode Bridge Tests ===\n");

console.log(
	"-- unresolved runtime should not clear context during bootstrap --",
);
{
	const plugin = createPlugin();
	await withHarness({ plugin }, async (h) => {
		h.setViewModel(null);
		h.init();
		await flushMicrotasks();

		assertEq(
			plugin.clearCalls,
			0,
			"no eager clearLiveContext while vm is unresolved",
		);

		h.setViewModel(buildIdleVm());
		await h.runIntervalTick();
		assertEq(
			plugin.clearCalls,
			1,
			"clearLiveContext runs once vm state is known idle",
		);
	});
}

console.log("\n-- transient setLiveContext failures retry on next tick --");
{
	const plugin = createPlugin({ failSetCalls: 1 });
	await withHarness({ plugin }, async (h) => {
		h.setViewModel(buildStreamingVm("rpc-retry"));
		h.init();
		await flushMicrotasks();

		assertEq(plugin.setCalls, 1, "initial setLiveContext attempt is made");

		await h.runIntervalTick();
		assertEq(
			plugin.setCalls,
			2,
			"failed setLiveContext retries on subsequent tick",
		);

		await h.runIntervalTick();
		assertEq(plugin.setCalls, 2, "successful key sync avoids duplicate writes");
	});
}

console.log(
	"\n-- plugin discovery retries when Capacitor plugin appears late --",
);
await withHarness({ plugin: null }, async (h) => {
	const plugin = createPlugin();
	h.setViewModel(buildStreamingVm("rpc-late"));
	h.init();
	await flushMicrotasks();

	assertEq(
		h.intervalCount(),
		1,
		"bridge polling starts even before plugin exists",
	);
	assertEq(plugin.setCalls, 0, "no setLiveContext before plugin is available");

	h.setPlugin(plugin);
	await h.runIntervalTick();
	assertEq(
		plugin.setCalls,
		1,
		"late plugin availability is detected and synced",
	);
});

assert(PASS > 0, "at least one assertion executed");

console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
