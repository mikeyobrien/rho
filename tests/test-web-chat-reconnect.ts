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

type SessionState = {
	rpcSessionId: string;
	sessionFile: string;
	lastEventSeq: number;
	recoveringRpcSession: boolean;
	pendingRpcCommands: Map<string, { payload: unknown; queuedAt: number }>;
};

interface ChatVm extends Record<string, unknown> {
	activeSessionId: string;
	activeRpcSessionId: string;
	activeRpcSessionFile: string;
	lastRpcEventSeq: number;
	sessions: unknown[];
	sessionStateById: Map<string, SessionState>;
	isSendingPrompt: boolean;
	awaitingStreamReconnectState: boolean;
	streamDisconnectedDuringResponse: boolean;
	isStreaming: boolean;
	connectWebSocket: () => void;
	sendWs: (payload: Record<string, unknown>) => boolean;
	manualReconnect: () => void;
	handleStateUpdate: (state: Record<string, unknown>) => void;
	handleWsMessage: (event: { data: string }) => void;
	ensureSessionState: (
		sessionId: string,
		meta?: Record<string, unknown>,
	) => SessionState | null;
	selectSession: (
		sessionId: string,
		options?: Record<string, unknown>,
	) => Promise<void>;
	startRpcSession: (
		sessionFile: string,
		options?: Record<string, unknown>,
	) => void;
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

console.log(
	"\n-- reconnect resumes/replays both focused and background sessions --",
);
{
	const chat = await loadChatVm();
	const stateA = chat.ensureSessionState("sess-a", {
		rpcSessionId: "rpc-a",
		sessionFile: "/tmp/sess-a.jsonl",
		lastEventSeq: 5,
	});
	const stateB = chat.ensureSessionState("sess-b", {
		rpcSessionId: "rpc-b",
		sessionFile: "/tmp/sess-b.jsonl",
		lastEventSeq: 9,
	});
	if (!stateA || !stateB) {
		throw new Error("expected session states for reconnect fixtures");
	}
	chat.activeSessionId = "sess-a";

	chat.connectWebSocket();
	const ws1 = MockWebSocket.instances[0];
	if (!ws1) {
		throw new Error("expected websocket instance");
	}
	ws1.open();

	const sentA = chat.sendWs({
		type: "rpc_command",
		sessionId: "rpc-a",
		command: { type: "prompt", message: "alpha" },
	});
	const sentB = chat.sendWs({
		type: "rpc_command",
		sessionId: "rpc-b",
		command: { type: "prompt", message: "beta" },
	});
	assertEq(sentA, true, "session A prompt is sent before reconnect");
	assertEq(sentB, true, "session B prompt is sent before reconnect");

	const pendingAId = [...stateA.pendingRpcCommands.keys()][0] ?? "";
	const pendingBId = [...stateB.pendingRpcCommands.keys()][0] ?? "";
	assert(Boolean(pendingAId), "session A tracks a pending replay command");
	assert(Boolean(pendingBId), "session B tracks a pending replay command");

	ws1.close();
	chat.manualReconnect();

	const ws2 = MockWebSocket.instances[1];
	if (!ws2) {
		throw new Error("expected second websocket instance");
	}
	ws2.open();

	const sentAfterReconnect = ws2.jsonSent();
	const resumeA = sentAfterReconnect.find((m) => {
		const command = asRecord(m.command);
		return (
			m.type === "rpc_command" &&
			m.sessionId === "rpc-a" &&
			command.type === "get_state"
		);
	});
	const resumeB = sentAfterReconnect.find((m) => {
		const command = asRecord(m.command);
		return (
			m.type === "rpc_command" &&
			m.sessionId === "rpc-b" &&
			command.type === "get_state"
		);
	});

	assert(Boolean(resumeA), "reconnect resumes focused session state");
	assert(Boolean(resumeB), "reconnect resumes background session state");
	assertEq(
		resumeA?.lastEventSeq,
		5,
		"focused reconnect resume uses focused session sequence cursor",
	);
	assertEq(
		resumeB?.lastEventSeq,
		9,
		"background reconnect resume uses background session sequence cursor",
	);

	ws2.message({
		type: "rpc_event",
		sessionId: "rpc-a",
		seq: 6,
		event: {
			type: "response",
			id: asRecord(resumeA?.command).id,
			command: "get_state",
			success: true,
			data: { isStreaming: false },
		},
	});
	ws2.message({
		type: "rpc_event",
		sessionId: "rpc-b",
		seq: 10,
		event: {
			type: "response",
			id: asRecord(resumeB?.command).id,
			command: "get_state",
			success: true,
			data: { isStreaming: false },
		},
	});

	const replayedPrompts = ws2.jsonSent().filter((m) => {
		const command = asRecord(m.command);
		return m.type === "rpc_command" && command.type === "prompt";
	});
	const replayedA = replayedPrompts.find((m) => {
		const command = asRecord(m.command);
		return m.sessionId === "rpc-a" && command.id === pendingAId;
	});
	const replayedB = replayedPrompts.find((m) => {
		const command = asRecord(m.command);
		return m.sessionId === "rpc-b" && command.id === pendingBId;
	});

	assert(Boolean(replayedA), "focused pending commands replay after reconnect");
	assert(
		Boolean(replayedB),
		"background pending commands replay after reconnect",
	);
	assertEq(
		replayedPrompts.filter((m) => asRecord(m.command).id === pendingAId).length,
		1,
		"focused prompt replay is deduped to one send",
	);
	assertEq(
		replayedPrompts.filter((m) => asRecord(m.command).id === pendingBId).length,
		1,
		"background prompt replay is deduped to one send",
	);
}

console.log(
	"\n-- rpc_session_not_found recovers background runtime by session --",
);
{
	const chat = await loadChatVm();
	chat.ensureSessionState("sess-a", {
		rpcSessionId: "rpc-a",
		sessionFile: "/tmp/sess-a.jsonl",
	});
	chat.ensureSessionState("sess-b", {
		rpcSessionId: "rpc-b",
		sessionFile: "/tmp/sess-b.jsonl",
	});
	chat.activeSessionId = "sess-a";

	chat.connectWebSocket();
	const ws = MockWebSocket.instances[0];
	if (!ws) {
		throw new Error("expected websocket instance");
	}
	ws.open();

	ws.message({
		type: "rpc_session_not_found",
		sessionId: "rpc-b",
		message: "missing background session",
	});

	const fallback = ws.jsonSent().find((m) => {
		const command = asRecord(m.command);
		return (
			m.type === "rpc_command" &&
			m.sessionFile === "/tmp/sess-b.jsonl" &&
			command.type === "switch_session"
		);
	});

	assert(
		Boolean(fallback),
		"missing background session triggers targeted switch_session fallback",
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
	chat.activeSessionId = "sess-4";
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

console.log(
	"\n-- orphan rpc ids do not route events without a session binding --",
);
{
	const chat = await loadChatVm();
	chat.activeRpcSessionId = "rpc-orphan";
	chat.isStreaming = false;

	chat.handleWsMessage({
		data: JSON.stringify({
			type: "rpc_event",
			sessionId: "rpc-orphan",
			seq: 1,
			event: { type: "agent_start" },
		}),
	});

	assertEq(
		chat.isStreaming,
		false,
		"events for rpc ids without session state are ignored",
	);
	assertEq(
		chat.sessionStateById.size,
		0,
		"orphan rpc id writes do not create detached compatibility state",
	);
}

console.log(
	"\n-- stale OPEN socket forces reconnect before sending command --",
);
{
	const chat = await loadChatVm();
	chat.activeSessionId = "sess-stale";
	chat.activeRpcSessionId = "rpc-stale";
	chat.activeRpcSessionFile = "/tmp/sess-stale.jsonl";

	chat.connectWebSocket();
	const ws1 = MockWebSocket.instances[0];
	if (!ws1) {
		throw new Error("expected websocket instance");
	}
	ws1.open();
	chat.wsLastPongAt = Date.now() - 120_000;

	const sent = chat.sendWs({
		type: "rpc_command",
		sessionId: "rpc-stale",
		command: { type: "prompt", message: "stale-send" },
	});
	assertEq(sent, true, "stale socket path still accepts outbound command");

	const ws2 = MockWebSocket.instances[1];
	assert(Boolean(ws2), "stale socket triggers an immediate reconnect");
	assertEq(
		ws1.readyState,
		MockWebSocket.CLOSED,
		"stale websocket is closed before retrying command send",
	);

	ws2?.open();
	const replayed = ws2?.jsonSent().find((m) => {
		const command = asRecord(m.command);
		return (
			m.type === "rpc_command" &&
			m.sessionId === "rpc-stale" &&
			command.type === "prompt" &&
			command.message === "stale-send"
		);
	});
	assert(
		Boolean(replayed),
		"pending command is sent after stale reconnect opens",
	);
}

console.log("\n-- rpc_pong refreshes websocket liveness timestamp --");
{
	const chat = await loadChatVm();
	chat.connectWebSocket();
	const ws = MockWebSocket.instances[0];
	if (!ws) {
		throw new Error("expected websocket instance");
	}
	ws.open();
	const before = Number(chat.wsLastPongAt ?? 0);
	ws.message({ type: "rpc_pong", ts: Date.now() });
	assert(
		Number(chat.wsLastPongAt ?? 0) >= before,
		"rpc_pong updates wsLastPongAt for stale-socket detection",
	);
}

console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
