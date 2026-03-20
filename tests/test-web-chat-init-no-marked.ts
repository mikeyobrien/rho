import path from "node:path";
import { pathToFileURL } from "node:url";

let PASS = 0;
let FAIL = 0;

function assert(condition: boolean, label: string): void {
	if (condition) {
		console.log(`  PASS: ${label}`);
		PASS++;
		return;
	}
	console.error(`  FAIL: ${label}`);
	FAIL++;
}

console.log("\n=== Web Chat Init Missing marked Guard Test ===\n");

type Listener = () => void;
type ChatVm = {
	init: () => Promise<void>;
	$refs: Record<string, unknown>;
	$root: unknown;
	$nextTick: (fn?: (() => void) | undefined) => void;
	[key: string]: unknown;
};

const listeners = new Map<string, Listener>();
let factory: null | (() => Record<string, unknown>) = null;

const doc = {
	addEventListener: (name: string, fn: Listener) => {
		listeners.set(name, fn);
	},
	removeEventListener: () => {},
	body: {
		classList: {
			add: () => {},
			remove: () => {},
			toggle: () => {},
		},
	},
	hidden: false,
	title: "",
};

const win = {
	location: {
		protocol: "http:",
		host: "localhost:3141",
		hash: "",
		pathname: "/",
		search: "",
	},
	addEventListener: () => {},
	removeEventListener: () => {},
};

Object.assign(globalThis, {
	document: doc,
	window: win,
	history: { replaceState: () => {} },
	localStorage: {
		getItem: () => null,
		setItem: () => {},
	},
	fetch: async () => ({
		ok: true,
		json: async () => [],
		headers: { get: () => "0" },
	}),
	requestAnimationFrame: (cb: () => void) => {
		cb();
		return 0;
	},
	setInterval: () => 0,
	clearInterval: () => {},
	setTimeout: () => 0,
	clearTimeout: () => {},
	WebSocket: class {},
	Alpine: {
		data: (_name: string, fn: () => Record<string, unknown>) => {
			factory = fn;
		},
	},
});

const globals = globalThis as typeof globalThis & {
	marked?: unknown;
	hljs?: unknown;
};
globals.marked = undefined;
globals.hljs = undefined;

const importDir = import.meta.dirname;
if (!importDir) {
	throw new Error("import.meta.dirname is unavailable");
}
const chatIndexPath = path.resolve(importDir, "../web/public/js/chat/index.js");
const chatModule = await import(
	`${pathToFileURL(chatIndexPath).href}?no-marked=${Date.now()}`
);
chatModule.registerRhoChat();

const init = listeners.get("alpine:init");
if (!init) {
	throw new Error("chat/index.js did not register alpine:init listener");
}
init();

if (!factory) {
	throw new Error("chat/index.js did not register Alpine.data factory");
}

const vm = factory() as ChatVm;
vm.$refs = { thread: null, composerInput: null };
vm.$root = null;
vm.$nextTick = (fn) => {
	if (typeof fn === "function") {
		fn();
	}
};

vm.connectWebSocket = () => {};
vm.preparePersistedRestoreSnapshot = () => null;
vm.setupIdleDetection = () => {};
vm.setupVisibilityDetection = () => {};
vm.bindGitFooterPickerTrigger = () => {};
vm.refreshGitProject = () => {};
vm.loadSessions = async () => {};
vm.restorePersistedSessionRuntime = async () => {};
vm.startPolling = () => {};
vm.setupKeyboardShortcuts = () => {};
vm.setupPullToRefresh = () => {};
vm.setupScrollIntentDetection = () => {};

try {
	await vm.init();
	assert(true, "chat init survives when marked global is missing");
} catch (error) {
	console.error(error);
	assert(false, "chat init survives when marked global is missing");
}

console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
