import path from "node:path";
import { pathToFileURL } from "node:url";

let PASS = 0;
let FAIL = 0;
let cachedFactory: (() => Record<string, unknown>) | null = null;

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
	const ok = Object.is(actual, expected);
	if (ok) {
		console.log(`  PASS: ${label}`);
		PASS++;
		return;
	}
	console.error(
		`  FAIL: ${label} (expected ${String(expected)}, got ${String(actual)})`,
	);
	FAIL++;
}

function asRecord(value: unknown): Record<string, unknown> {
	if (typeof value === "object" && value !== null) {
		return value as Record<string, unknown>;
	}
	return {};
}

type Listener = (event?: unknown) => void;

interface ChatVm extends Record<string, unknown> {
	activeSessionId: string;
	activeRpcSessionId: string;
	activeRpcSessionFile: string;
	lastRpcEventSeq: number;
	sessions: unknown[];
	isSendingPrompt: boolean;
	awaitingStreamReconnectState: boolean;
	streamDisconnectedDuringResponse: boolean;
	isStreaming: boolean;
	connectWebSocket: () => void;
	sendWs: (payload: Record<string, unknown>) => boolean;
	manualReconnect: () => void;
	handleStateUpdate: (state: Record<string, unknown>) => void;
	handleWsMessage: (event: { data: string }) => void;
	selectSession: (
		sessionId: string,
		options?: Record<string, unknown>,
	) => Promise<void>;
	startRpcSession: (sessionFile: string) => void;
}

class MockWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: MockWebSocket[] = [];

	readonly url: string;
	readyState = MockWebSocket.CONNECTING;
	sent: string[] = [];
	private listeners = new Map<string, Array<{ cb: Listener; once: boolean }>>();

	constructor(url: string) {
		this.url = url;
		MockWebSocket.instances.push(this);
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

	send(data: string): void {
		this.sent.push(data);
	}

	close(): void {
		if (this.readyState === MockWebSocket.CLOSED) return;
		this.readyState = MockWebSocket.CLOSED;
		this.emit("close", {});
	}

	open(): void {
		this.readyState = MockWebSocket.OPEN;
		this.emit("open", {});
	}

	message(payload: unknown): void {
		this.emit("message", { data: JSON.stringify(payload) });
	}

	error(): void {
		this.emit("error", {});
	}

	private emit(type: string, event: unknown): void {
		const handlers = this.listeners.get(type) ?? [];
		for (const entry of [...handlers]) {
			entry.cb(event);
		}
		this.listeners.set(
			type,
			handlers.filter((entry) => !entry.once),
		);
	}

	jsonSent(): Record<string, unknown>[] {
		return this.sent.map((line) => asRecord(JSON.parse(line)));
	}
}

async function loadChatVm(): Promise<ChatVm> {
	MockWebSocket.instances = [];
	let factory: (() => Record<string, unknown>) | null = cachedFactory;
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

	if (!cachedFactory) {
		const importDir = import.meta.dirname;
		if (!importDir) {
			throw new Error("import.meta.dirname is unavailable");
		}
		const chatPath = path.resolve(importDir, "../web/public/js/chat.js");
		await import(
			`${pathToFileURL(chatPath).href}?reconnect-test=${Date.now()}`
		);

		const init = listeners.get("alpine:init");
		if (!init) {
			throw new Error("chat.js did not register alpine:init listener");
		}
		init();
		cachedFactory = factory;
	}

	if (!factory) {
		factory = cachedFactory;
	}
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
	vm.loadSessions = () => {};
	vm.updateFooter = () => {};
	vm.scrollThreadToBottom = () => {};
	vm.reloadActiveSession = () => {};
	vm.focusComposer = () => {};
	vm.blurComposer = () => {};

	return vm;
}

console.log("\n=== Web Chat Reconnect Robustness Tests ===\n");

console.log("-- reconnect resumes existing rpc session with replay cursor --");
{
	const chat = await loadChatVm();
	chat.activeSessionId = "sess-1";
	chat.activeRpcSessionId = "rpc-1";
	chat.activeRpcSessionFile = "/tmp/sess-1.jsonl";
	chat.lastRpcEventSeq = 42;

	chat.connectWebSocket();
	const ws = MockWebSocket.instances[0];
	if (!ws) {
		throw new Error("expected websocket instance");
	}
	ws.open();

	const messages = ws.jsonSent();
	const resume = messages.find((m) => {
		const command = asRecord(m.command);
		return (
			m.type === "rpc_command" &&
			m.sessionId === "rpc-1" &&
			command.type === "get_state"
		);
	});

	assert(
		Boolean(resume),
		"open attempts get_state against existing rpc session id",
	);
	assertEq(
		resume?.lastEventSeq,
		42,
		"resume command includes last seen rpc event sequence",
	);
}

console.log(
	"\n-- resume fallback starts session by file when rpc session missing --",
);
{
	const chat = await loadChatVm();
	chat.activeSessionId = "sess-2";
	chat.activeRpcSessionId = "rpc-missing";
	chat.activeRpcSessionFile = "/tmp/sess-2.jsonl";

	chat.connectWebSocket();
	const ws = MockWebSocket.instances[0];
	if (!ws) {
		throw new Error("expected websocket instance");
	}
	ws.open();

	ws.message({
		type: "rpc_session_not_found",
		sessionId: "rpc-missing",
	});

	const messages = ws.jsonSent();
	const fallback = messages.find((m) => {
		const command = asRecord(m.command);
		return (
			m.type === "rpc_command" &&
			m.sessionFile === "/tmp/sess-2.jsonl" &&
			command.type === "switch_session"
		);
	});

	assert(
		Boolean(fallback),
		"missing session triggers switch_session fallback using sessionFile",
	);
}

console.log(
	"\n-- selecting a hashed session outside loaded page still resumes rpc --",
);
{
	const chat = await loadChatVm();
	let startedSessionFile = "";
	chat.startRpcSession = (sessionFile: string) => {
		startedSessionFile = sessionFile;
	};
	chat.sessions = [
		{
			id: "sess-visible",
			file: "/tmp/sess-visible.jsonl",
			cwd: "",
			timestamp: "2026-01-01T00:00:00.000Z",
			messageCount: 1,
			isActive: false,
		},
	];

	const globals = globalThis as unknown as Record<string, unknown>;
	globals.fetch = async (url: unknown) => {
		if (url === "/api/sessions/sess-missing") {
			return {
				ok: true,
				headers: { get: () => "0" },
				json: async () => ({
					header: {
						type: "session",
						id: "sess-missing",
						timestamp: "2026-01-01T00:00:00.000Z",
						cwd: "/tmp",
					},
					messages: [],
					forkPoints: [],
					stats: { messageCount: 0, tokenUsage: 0, cost: 0 },
					file: "/tmp/sess-missing.jsonl",
				}),
			};
		}
		return {
			ok: true,
			headers: { get: () => "0" },
			json: async () => [],
		};
	};

	await chat.selectSession("sess-missing", { updateHash: false });

	assertEq(
		chat.activeRpcSessionFile,
		"/tmp/sess-missing.jsonl",
		"selectSession stores file from session payload",
	);
	assertEq(
		startedSessionFile,
		"/tmp/sess-missing.jsonl",
		"selectSession starts rpc from payload file when summary page misses id",
	);
}

console.log(
	"\n-- pending rpc commands replay with stable command ids after reconnect --",
);
{
	const chat = await loadChatVm();
	chat.activeSessionId = "sess-3";
	chat.activeRpcSessionId = "rpc-3";
	chat.activeRpcSessionFile = "/tmp/sess-3.jsonl";

	chat.connectWebSocket();
	const ws1 = MockWebSocket.instances[0];
	if (!ws1) {
		throw new Error("expected websocket instance");
	}
	ws1.open();

	const sent = chat.sendWs({
		type: "rpc_command",
		sessionId: "rpc-3",
		command: { type: "prompt", message: "hello" },
	});
	assertEq(sent, true, "prompt command sent over websocket");

	const promptSend = ws1
		.jsonSent()
		.filter((m) => {
			const command = asRecord(m.command);
			return m.type === "rpc_command" && command.type === "prompt";
		})
		.pop();
	const promptId = asRecord(promptSend?.command).id;
	assert(Boolean(promptId), "client assigns command id to outbound prompt");

	ws1.close();
	chat.manualReconnect();

	const ws2 = MockWebSocket.instances[1];
	if (!ws2) {
		throw new Error("expected second websocket instance");
	}
	ws2.open();

	const resumeCmd = ws2.jsonSent().find((m) => {
		const command = asRecord(m.command);
		return m.type === "rpc_command" && command.type === "get_state";
	});
	assert(
		Boolean(resumeCmd),
		"reconnect sends get_state resume command before replay",
	);

	ws2.message({
		type: "rpc_event",
		sessionId: "rpc-3",
		seq: 1,
		event: {
			type: "response",
			id: asRecord(resumeCmd?.command).id,
			command: "get_state",
			success: true,
			data: { isStreaming: false, thinkingLevel: "medium" },
		},
	});

	const resentPrompt = ws2
		.jsonSent()
		.filter((m) => {
			const command = asRecord(m.command);
			return m.type === "rpc_command" && command.type === "prompt";
		})
		.pop();

	assert(
		Boolean(resentPrompt),
		"pending prompt replays after reconnect state recovery",
	);
	assertEq(
		asRecord(resentPrompt?.command).id,
		promptId,
		"replayed prompt keeps original command id for dedupe safety",
	);
}

console.log("\n-- manual reconnect replaces an open websocket immediately --");
{
	const chat = await loadChatVm();
	chat.activeSessionId = "sess-4";
	chat.activeRpcSessionId = "rpc-4";
	chat.activeRpcSessionFile = "/tmp/sess-4.jsonl";

	chat.connectWebSocket();
	const ws1 = MockWebSocket.instances[0];
	if (!ws1) {
		throw new Error("expected websocket instance");
	}
	ws1.open();

	chat.manualReconnect();
	const ws2 = MockWebSocket.instances[1];

	assert(
		Boolean(ws2),
		"manual reconnect creates a new websocket even when one is open",
	);
	assertEq(
		ws1.readyState,
		MockWebSocket.CLOSED,
		"manual reconnect closes the previous open websocket",
	);

	ws2?.open();
	assertEq(
		chat.showReconnectBanner,
		false,
		"new websocket open clears reconnect banner",
	);
}

console.log("\n-- reconnect state reconciliation clears stale send-lock --");
{
	const chat = await loadChatVm();
	chat.isSendingPrompt = true;
	chat.awaitingStreamReconnectState = true;
	chat.streamDisconnectedDuringResponse = true;

	chat.handleStateUpdate({ isStreaming: false, thinkingLevel: "medium" });

	assertEq(
		chat.isSendingPrompt,
		false,
		"non-streaming reconnect state clears stuck sending flag",
	);
}

console.log(
	"\n-- rpc event sequence dedupe ignores replayed/duplicate events --",
);
{
	const chat = await loadChatVm();
	chat.activeRpcSessionId = "rpc-4";
	chat.lastRpcEventSeq = 10;
	chat.isStreaming = false;

	chat.handleWsMessage({
		data: JSON.stringify({
			type: "rpc_event",
			sessionId: "rpc-4",
			seq: 10,
			event: { type: "agent_start" },
		}),
	});
	assertEq(chat.isStreaming, false, "duplicate sequence event is ignored");

	chat.handleWsMessage({
		data: JSON.stringify({
			type: "rpc_event",
			sessionId: "rpc-4",
			seq: 11,
			event: { type: "agent_start" },
		}),
	});
	assertEq(chat.isStreaming, true, "next sequence event is applied once");
}

console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
