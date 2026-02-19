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

type Listener = (event?: any) => void;

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
		if (!this.listeners.has(type)) {
			this.listeners.set(type, []);
		}
		this.listeners.get(type)!.push({ cb, once: Boolean(options?.once) });
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

	jsonSent(): any[] {
		return this.sent.map((line) => JSON.parse(line));
	}
}

async function loadChatVm(): Promise<any> {
	MockWebSocket.instances = [];
	let factory: (() => any) | null = null;
	const listeners = new Map<string, (...args: any[]) => void>();

	(globalThis as any).document = {
		addEventListener: (type: string, cb: (...args: any[]) => void) => {
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

	(globalThis as any).window = {
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

	(globalThis as any).history = { replaceState: () => {} };
	(globalThis as any).localStorage = {
		getItem: () => null,
		setItem: () => {},
	};
	(globalThis as any).marked = {
		setOptions: () => {},
		parse: (text: string) => text,
	};
	(globalThis as any).hljs = undefined;
	(globalThis as any).fetch = async () => ({
		ok: true,
		json: async () => [],
		headers: { get: () => "0" },
	});
	(globalThis as any).requestAnimationFrame = (cb: () => void) => {
		cb();
		return 0;
	};
	(globalThis as any).WebSocket = MockWebSocket;
	(globalThis as any).Alpine = {
		data: (_name: string, fn: () => any) => {
			factory = fn;
		},
	};

	const chatPath = path.resolve(
		import.meta.dirname!,
		"../web/public/js/chat.js",
	);
	await import(pathToFileURL(chatPath).href + `?reconnect-test=${Date.now()}`);

	const init = listeners.get("alpine:init");
	if (!init) {
		throw new Error("chat.js did not register alpine:init listener");
	}
	init();

	if (!factory) {
		throw new Error("chat.js did not register Alpine.data factory");
	}

	const vm = factory();
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
	const ws = MockWebSocket.instances[0]!;
	ws.open();

	const messages = ws.jsonSent();
	const resume = messages.find(
		(m) =>
			m.type === "rpc_command" &&
			m.sessionId === "rpc-1" &&
			m.command?.type === "get_state",
	);

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
	const ws = MockWebSocket.instances[0]!;
	ws.open();

	ws.message({
		type: "rpc_session_not_found",
		sessionId: "rpc-missing",
	});

	const messages = ws.jsonSent();
	const fallback = messages.find(
		(m) =>
			m.type === "rpc_command" &&
			m.sessionFile === "/tmp/sess-2.jsonl" &&
			m.command?.type === "switch_session",
	);

	assert(
		Boolean(fallback),
		"missing session triggers switch_session fallback using sessionFile",
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
	const ws1 = MockWebSocket.instances[0]!;
	ws1.open();

	const sent = chat.sendWs({
		type: "rpc_command",
		sessionId: "rpc-3",
		command: { type: "prompt", message: "hello" },
	});
	assertEq(sent, true, "prompt command sent over websocket");

	const promptSend = ws1
		.jsonSent()
		.filter((m) => m.type === "rpc_command" && m.command?.type === "prompt")
		.pop();
	const promptId = promptSend?.command?.id;
	assert(Boolean(promptId), "client assigns command id to outbound prompt");

	ws1.close();
	chat.manualReconnect();

	const ws2 = MockWebSocket.instances[1]!;
	ws2.open();

	const resumeCmd = ws2
		.jsonSent()
		.find((m) => m.type === "rpc_command" && m.command?.type === "get_state");
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
			id: resumeCmd?.command?.id,
			command: "get_state",
			success: true,
			data: { isStreaming: false, thinkingLevel: "medium" },
		},
	});

	const resentPrompt = ws2
		.jsonSent()
		.filter((m) => m.type === "rpc_command" && m.command?.type === "prompt")
		.pop();

	assert(
		Boolean(resentPrompt),
		"pending prompt replays after reconnect state recovery",
	);
	assertEq(
		resentPrompt?.command?.id,
		promptId,
		"replayed prompt keeps original command id for dedupe safety",
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
