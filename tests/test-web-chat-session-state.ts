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

function assertEq(actual: unknown, expected: unknown, label: string): void {
	if (Object.is(actual, expected)) {
		console.log(`  PASS: ${label}`);
		PASS++;
		return;
	}
	console.error(
		`  FAIL: ${label} (expected ${String(expected)}, got ${String(actual)})`,
	);
	FAIL++;
}

type Listener = (event?: unknown) => void;

interface ChatVm extends Record<string, unknown> {
	focusedSessionId: string;
	sessionStateById: Map<string, Record<string, unknown>>;
	sessions: Array<Record<string, unknown>>;
	activeSessionId: string;
	activeRpcSessionId: string;
	promptText: string;
	isSendingPrompt: boolean;
	ensureSessionState: (
		sessionId: string,
		meta?: Record<string, unknown>,
	) => Record<string, unknown> | null;
	getFocusedSessionState: () => Record<string, unknown> | null;
	selectSession: (
		sessionId: string,
		options?: Record<string, unknown>,
	) => Promise<void>;
	startRpcSession: (sessionFile: string) => void;
	requestState: () => void;
	requestAvailableModels: () => void;
	requestSlashCommands: (force?: boolean) => void;
}

class MockWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	readonly url: string;
	readyState = MockWebSocket.CONNECTING;
	private listeners = new Map<string, Array<{ cb: Listener; once: boolean }>>();

	constructor(url: string) {
		this.url = url;
	}

	addEventListener(
		type: string,
		cb: Listener,
		options?: { once?: boolean },
	): void {
		const current = this.listeners.get(type) ?? [];
		current.push({ cb, once: Boolean(options?.once) });
		this.listeners.set(type, current);
	}

	send(_data: string): void {}

	close(): void {
		this.readyState = MockWebSocket.CLOSED;
	}
}

async function loadChatVm(): Promise<ChatVm> {
	let factory: (() => Record<string, unknown>) | null = null;
	const listeners = new Map<string, () => void>();
	const globals = globalThis as unknown as Record<string, unknown>;

	globals.document = {
		addEventListener: (type: string, cb: () => void) => {
			listeners.set(type, cb);
		},
		querySelector: () => null,
		querySelectorAll: () => [],
		body: {
			classList: {
				add: () => {},
				toggle: () => {},
				remove: () => {},
			},
		},
		hidden: false,
		title: "",
	};

	globals.window = {
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

	globals.history = { replaceState: () => {} };
	globals.localStorage = {
		getItem: () => null,
		setItem: () => {},
	};
	globals.marked = {
		setOptions: () => {},
		parse: (text: string) => text,
	};
	globals.hljs = undefined;
	globals.fetch = async () => ({
		ok: true,
		json: async () => [],
		headers: { get: () => "0" },
	});
	globals.requestAnimationFrame = (cb: () => void) => {
		cb();
		return 0;
	};
	globals.WebSocket = MockWebSocket;
	globals.Alpine = {
		data: (_name: string, fn: () => Record<string, unknown>) => {
			factory = fn;
		},
	};

	const importDir = import.meta.dirname;
	if (!importDir) {
		throw new Error("import.meta.dirname is unavailable");
	}
	const chatPath = path.resolve(importDir, "../web/public/js/chat.js");
	await import(`${pathToFileURL(chatPath).href}?state-test=${Date.now()}`);

	const init = listeners.get("alpine:init");
	if (!init) {
		throw new Error("chat.js did not register alpine:init listener");
	}
	init();

	if (!factory) {
		throw new Error("chat.js did not register Alpine.data factory");
	}

	const vm = factory() as ChatVm;
	vm.$refs = { thread: null, composerInput: null };
	vm.$root = null;
	vm.$nextTick = (fn: (() => void) | undefined) => {
		if (typeof fn === "function") {
			fn();
		}
	};

	return vm;
}

console.log("\n=== Web Chat Session UI State Tests ===\n");

console.log("-- state factory defaults --");
{
	const importDir = import.meta.dirname;
	if (!importDir) {
		throw new Error("import.meta.dirname is unavailable");
	}
	const modulePath = path.resolve(
		importDir,
		"../web/public/js/chat/session-ui-state.js",
	);
	const stateModule = await import(
		`${pathToFileURL(modulePath).href}?factory-test=${Date.now()}`
	);
	const first = stateModule.createSessionUiState("sess-a");
	const second = stateModule.createSessionUiState("sess-b");

	assertEq(first.sessionId, "sess-a", "factory sets session id");
	assertEq(first.rpcSessionId, "", "factory defaults rpc session id");
	assertEq(first.sessionFile, "", "factory defaults session file");
	assertEq(first.status, "idle", "factory defaults status to idle");
	assertEq(first.unreadMilestone, false, "factory defaults unread milestone");
	assertEq(first.promptText, "", "factory defaults prompt text");
	assert(
		first.pendingRpcCommands instanceof Map,
		"factory creates pending RPC map",
	);
	assert(first.toolCallPartById instanceof Map, "factory creates tool-call map");
	assert(
		first.usageAccountedMessageIds instanceof Set,
		"factory creates usage-accounted set",
	);

	first.pendingRpcCommands.set("rpc-1", { id: "rpc-1" });
	assertEq(
		second.pendingRpcCommands.size,
		0,
		"factory creates isolated mutable collections",
	);
}

console.log("\n-- ensureSessionState/getFocusedSessionState helpers --");
{
	const chat = await loadChatVm();
	assert(
		chat.sessionStateById instanceof Map,
		"chat vm exposes session state map",
	);
	assertEq(
		chat.getFocusedSessionState(),
		null,
		"focused selector returns null before focus is set",
	);

	const created = chat.ensureSessionState("sess-a", {
		sessionFile: "/tmp/sess-a.jsonl",
	});
	assert(Boolean(created), "ensureSessionState creates state");
	assertEq(
		chat.sessionStateById.size,
		1,
		"ensureSessionState stores state in sessionStateById",
	);
	assertEq(
		created?.sessionFile,
		"/tmp/sess-a.jsonl",
		"ensureSessionState applies provided metadata on first create",
	);

	chat.activeSessionId = "sess-a";
	assertEq(
		chat.getFocusedSessionState(),
		created,
		"focused selector returns state for focused session",
	);

	chat.promptText = "hello from a";
	chat.isSendingPrompt = true;
	assertEq(
		chat.sessionStateById.get("sess-a")?.promptText,
		"hello from a",
		"compat setter writes prompt text into focused state",
	);
	assertEq(
		chat.sessionStateById.get("sess-a")?.isSendingPrompt,
		true,
		"compat setter writes sending state into focused state",
	);

	chat.activeSessionId = "sess-b";
	assertEq(
		chat.promptText,
		"",
		"switching focus exposes independent prompt state defaults",
	);
	chat.promptText = "hello from b";

	chat.activeSessionId = "sess-a";
	assertEq(
		chat.promptText,
		"hello from a",
		"switching back restores prior focused session state",
	);
}

console.log(
	"\n-- selectSession preserves runtime state across focus switches --",
);
{
	const chat = await loadChatVm();
	chat.sessions = [
		{
			id: "sess-a",
			file: "/tmp/sess-a.jsonl",
			timestamp: "2026-01-01T00:00:00.000Z",
			messageCount: 1,
			isActive: true,
		},
		{
			id: "sess-b",
			file: "/tmp/sess-b.jsonl",
			timestamp: "2026-01-01T00:00:00.000Z",
			messageCount: 0,
			isActive: false,
		},
	];

	const stateA = chat.ensureSessionState("sess-a", {
		sessionFile: "/tmp/sess-a.jsonl",
		rpcSessionId: "rpc-a",
		promptText: "draft A",
		isSendingPrompt: true,
		lastEventSeq: 17,
		pendingRpcCommands: new Map([["cmd-a", { payload: { ok: true } }]]),
	});
	const stateB = chat.ensureSessionState("sess-b", {
		sessionFile: "/tmp/sess-b.jsonl",
		rpcSessionId: "rpc-b",
		promptText: "draft B",
		lastEventSeq: 3,
	});
	if (!stateA || !stateB) {
		throw new Error("failed to initialize session state fixtures");
	}

	let requestStateCalls = 0;
	const startedSessionFiles: string[] = [];
	chat.requestState = () => {
		requestStateCalls += 1;
	};
	chat.requestAvailableModels = () => {};
	chat.requestSlashCommands = () => {};
	chat.startRpcSession = (sessionFile: string) => {
		startedSessionFiles.push(sessionFile);
	};

	const sessionA = {
		header: { id: "sess-a", timestamp: "2026-01-01T00:00:00.000Z" },
		messages: [],
		stats: {},
		file: "/tmp/sess-a.jsonl",
	};
	const sessionB = {
		header: { id: "sess-b", timestamp: "2026-01-01T00:00:00.000Z" },
		messages: [],
		stats: {},
		file: "/tmp/sess-b.jsonl",
	};

	await chat.selectSession("sess-a", {
		updateHash: false,
		session: sessionA,
		sessionFile: "/tmp/sess-a.jsonl",
	});
	await chat.selectSession("sess-b", {
		updateHash: false,
		session: sessionB,
		sessionFile: "/tmp/sess-b.jsonl",
	});
	await chat.selectSession("sess-a", {
		updateHash: false,
		session: sessionA,
		sessionFile: "/tmp/sess-a.jsonl",
	});

	assertEq(
		requestStateCalls,
		3,
		"selectSession requests rpc state for already-active sessions",
	);
	assertEq(
		startedSessionFiles.length,
		0,
		"selectSession does not restart runtime for sessions with rpc ids",
	);

	const refreshedA = chat.sessionStateById.get("sess-a");
	assertEq(
		refreshedA?.promptText,
		"draft A",
		"switching focus preserves per-session draft text",
	);
	assertEq(
		refreshedA?.rpcSessionId,
		"rpc-a",
		"switching focus preserves rpc session binding",
	);
	assertEq(
		refreshedA?.lastEventSeq,
		17,
		"switching focus preserves replay cursor",
	);
	assertEq(
		(refreshedA?.pendingRpcCommands as Map<string, unknown>)?.size,
		1,
		"switching focus preserves pending rpc replay state",
	);
}

console.log("\n-- selectSession auto-starts rpc for historical sessions --");
{
	const chat = await loadChatVm();
	chat.sessions = [
		{
			id: "sess-history",
			file: "/tmp/sess-history.jsonl",
			timestamp: "2026-01-01T00:00:00.000Z",
			messageCount: 0,
			isActive: false,
		},
	];
	chat.ensureSessionState("sess-history", {
		sessionFile: "/tmp/sess-history.jsonl",
		rpcSessionId: "",
		promptText: "draft history",
	});

	let startedSessionFile = "";
	chat.requestState = () => {
		throw new Error("should not request state when rpc session id is missing");
	};
	chat.requestAvailableModels = () => {};
	chat.requestSlashCommands = () => {};
	chat.startRpcSession = (sessionFile: string) => {
		startedSessionFile = sessionFile;
	};

	await chat.selectSession("sess-history", {
		updateHash: false,
		session: {
			header: { id: "sess-history", timestamp: "2026-01-01T00:00:00.000Z" },
			messages: [],
			stats: {},
			file: "/tmp/sess-history.jsonl",
		},
		sessionFile: "/tmp/sess-history.jsonl",
	});

	assertEq(
		startedSessionFile,
		"/tmp/sess-history.jsonl",
		"historical session selection boots rpc runtime",
	);
}

console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
