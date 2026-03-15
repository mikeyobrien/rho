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

type SessionState = {
	sessionId: string;
	rpcSessionId: string;
	sessionFile: string;
	status: string;
	unreadMilestone: boolean;
	lastActivityAt: number;
	isStreaming: boolean;
	isSendingPrompt: boolean;
	pendingRpcCommands: Map<string, { payload: unknown; queuedAt: number }>;
	renderedMessages: Array<{ id: string }>;
};

interface ChatVm extends Record<string, unknown> {
	activeSessionId: string;
	activeRpcSessionId: string;
	ws: { readyState: number; send: (payload: string) => void } | null;
	sessionStateById: Map<string, SessionState>;
	sessions: Array<Record<string, unknown>>;
	ensureSessionState: (
		sessionId: string,
		meta?: Record<string, unknown>,
	) => SessionState | null;
	sendWs: (
		payload: Record<string, unknown>,
		options?: Record<string, unknown>,
	) => boolean;
	sendPromptMessage: (
		message: string,
		promptOptions?: Record<string, unknown>,
		slashClassification?: Record<string, unknown> | null,
	) => void;
	orderedSessions: () => Array<Record<string, unknown>>;
	sessionRowUnread: (session: Record<string, unknown>) => boolean;
	sessionRowStatus: (session: Record<string, unknown>) => string;
	handleWsMessage: (event: { data: string }) => void;
}

class MockWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;

	readonly url: string;
	readyState = MockWebSocket.CONNECTING;
	sent: string[] = [];
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

	send(data: string): void {
		this.sent.push(data);
	}

	close(): void {
		this.readyState = MockWebSocket.CLOSED;
	}

	jsonSent(): Array<Record<string, unknown>> {
		return this.sent.map((line) => JSON.parse(line) as Record<string, unknown>);
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
	await import(`${pathToFileURL(chatPath).href}?ws-routing-test=${Date.now()}`);

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
	vm.loadSessions = () => {};
	vm.updateFooter = () => {};
	vm.scrollThreadToBottom = () => {};

	return vm;
}

console.log("\n=== Web Chat Session-Keyed WS Routing Tests ===\n");

console.log(
	"-- interleaved rpc events route by session and isolate transcripts --",
);
{
	const chat = await loadChatVm();
	chat.activeSessionId = "sess-a";
	const stateA = chat.ensureSessionState("sess-a", {
		rpcSessionId: "rpc-a",
		sessionFile: "/tmp/sess-a.jsonl",
	});
	const stateB = chat.ensureSessionState("sess-b", {
		rpcSessionId: "rpc-b",
		sessionFile: "/tmp/sess-b.jsonl",
	});
	if (!stateA || !stateB) {
		throw new Error("failed to initialize session states");
	}
	chat.activeSessionId = "sess-a";

	const focusedBefore = stateA.renderedMessages.length;
	const backgroundBefore = stateB.renderedMessages.length;

	chat.handleWsMessage({
		data: JSON.stringify({
			type: "rpc_event",
			sessionId: "rpc-b",
			seq: 1,
			event: { type: "agent_start" },
		}),
	});

	assertEq(
		stateB.status,
		"streaming",
		"background session status updates from interleaved agent_start",
	);
	assertEq(
		stateB.isStreaming,
		true,
		"background session marks streaming while unfocused",
	);
	assert(
		stateB.lastActivityAt > 0,
		"background session tracks last activity timestamp",
	);
	assertEq(
		stateA.renderedMessages.length,
		focusedBefore,
		"background status event does not mutate focused transcript",
	);

	chat.handleWsMessage({
		data: JSON.stringify({
			type: "rpc_event",
			sessionId: "rpc-a",
			seq: 1,
			event: {
				type: "message_update",
				message: {
					id: "assistant-a",
					role: "assistant",
					timestamp: new Date().toISOString(),
					content: [{ type: "text", text: "Alpha" }],
				},
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 0,
					delta: "Alpha",
				},
			},
		}),
	});

	assertEq(
		stateA.renderedMessages.length,
		focusedBefore + 1,
		"focused session still performs full render updates",
	);

	chat.handleWsMessage({
		data: JSON.stringify({
			type: "rpc_event",
			sessionId: "rpc-b",
			seq: 2,
			event: {
				type: "message_update",
				message: {
					id: "assistant-b",
					role: "assistant",
					timestamp: new Date().toISOString(),
					content: [{ type: "text", text: "Beta" }],
				},
				assistantMessageEvent: {
					type: "text_delta",
					contentIndex: 0,
					delta: "Beta",
				},
			},
		}),
	});

	assertEq(
		stateB.renderedMessages.length,
		backgroundBefore,
		"background message deltas do not mutate unfocused transcript",
	);
	assertEq(
		stateA.renderedMessages.length,
		focusedBefore + 1,
		"background message deltas never leak into focused transcript",
	);

	chat.handleWsMessage({
		data: JSON.stringify({
			type: "rpc_event",
			sessionId: "rpc-b",
			seq: 3,
			event: { type: "agent_end" },
		}),
	});

	assertEq(
		stateB.status,
		"idle",
		"background session returns to idle on agent_end",
	);
	assertEq(
		stateB.unreadMilestone,
		true,
		"background completion marks unread milestone",
	);
	assertEq(
		stateB.isStreaming,
		false,
		"background session clears streaming flag on agent_end",
	);
}

console.log(
	"\n-- concurrent prompts track pending commands per target session --",
);
{
	const chat = await loadChatVm();
	const stateA = chat.ensureSessionState("sess-a", {
		rpcSessionId: "rpc-a",
		sessionFile: "/tmp/sess-a.jsonl",
	});
	const stateB = chat.ensureSessionState("sess-b", {
		rpcSessionId: "rpc-b",
		sessionFile: "/tmp/sess-b.jsonl",
	});
	if (!stateA || !stateB) {
		throw new Error("failed to initialize concurrent session fixtures");
	}

	const ws = new MockWebSocket("ws://localhost:3141/ws");
	ws.readyState = MockWebSocket.OPEN;
	chat.ws = ws;

	chat.activeSessionId = "sess-a";
	chat.sendPromptMessage("alpha prompt");
	chat.activeSessionId = "sess-b";
	chat.sendPromptMessage("beta prompt");

	assertEq(stateA.isSendingPrompt, true, "session A enters sending state");
	assertEq(stateB.isSendingPrompt, true, "session B enters sending state");
	assertEq(
		stateA.pendingRpcCommands.size,
		1,
		"session A tracks its own pending prompt command",
	);
	assertEq(
		stateB.pendingRpcCommands.size,
		1,
		"session B tracks its own pending prompt command",
	);

	const sent = ws.jsonSent();
	const sentPrompts = sent.filter((payload) => {
		const command = payload.command as Record<string, unknown> | undefined;
		return payload.type === "rpc_command" && command?.type === "prompt";
	});
	assertEq(sentPrompts.length, 2, "both prompts are sent over websocket");
	assertEq(
		sentPrompts[0]?.sessionId,
		"rpc-a",
		"first prompt binds to session A rpc id",
	);
	assertEq(
		sentPrompts[1]?.sessionId,
		"rpc-b",
		"second prompt binds to session B rpc id",
	);

	const followUpSent = chat.sendWs({
		type: "rpc_command",
		sessionId: "rpc-a",
		command: { type: "follow_up", message: "continue alpha" },
	});
	assertEq(followUpSent, true, "background follow-up dispatch succeeds");
	assertEq(
		stateA.pendingRpcCommands.size,
		2,
		"background-targeted command is tracked on session A",
	);
	assertEq(
		stateB.pendingRpcCommands.size,
		1,
		"background-targeted command does not leak into session B pending map",
	);
}

console.log(
	"\n-- session row status + unread update during concurrent background runs --",
);
{
	const chat = await loadChatVm();
	chat.sessions = [
		{
			id: "sess-a",
			timestamp: "2026-02-20T10:00:00.000Z",
			messageCount: 2,
		},
		{
			id: "sess-b",
			timestamp: "2026-02-20T09:00:00.000Z",
			messageCount: 3,
		},
		{
			id: "sess-history",
			timestamp: "2026-02-20T11:00:00.000Z",
			messageCount: 1,
		},
	];

	chat.ensureSessionState("sess-a", {
		rpcSessionId: "rpc-a",
		sessionFile: "/tmp/sess-a.jsonl",
		status: "idle",
	});
	chat.ensureSessionState("sess-b", {
		rpcSessionId: "rpc-b",
		sessionFile: "/tmp/sess-b.jsonl",
		status: "idle",
	});
	chat.activeSessionId = "sess-b";

	chat.handleWsMessage({
		data: JSON.stringify({
			type: "rpc_event",
			sessionId: "rpc-a",
			seq: 1,
			event: { type: "agent_start" },
		}),
	});

	const orderedStreaming = chat.orderedSessions();
	assertEq(
		orderedStreaming[0]?.id,
		"sess-a",
		"streaming background session sorts to top",
	);
	const rowAStreaming = orderedStreaming.find((row) => row.id === "sess-a");
	if (!rowAStreaming) {
		throw new Error("missing sess-a row while streaming");
	}
	assertEq(
		chat.sessionRowStatus(rowAStreaming),
		"streaming",
		"row status exposes streaming state",
	);
	assertEq(
		chat.sessionRowUnread(rowAStreaming),
		false,
		"agent start alone does not set unread badge",
	);

	chat.handleWsMessage({
		data: JSON.stringify({
			type: "rpc_event",
			sessionId: "rpc-a",
			seq: 2,
			event: { type: "tool_execution_start", toolUseId: "tool-1" },
		}),
	});

	const orderedAfterTool = chat.orderedSessions();
	const rowAAfterTool = orderedAfterTool.find((row) => row.id === "sess-a");
	if (!rowAAfterTool) {
		throw new Error("missing sess-a row after tool activity");
	}
	assertEq(
		chat.sessionRowUnread(rowAAfterTool),
		true,
		"background tool activity sets unread badge",
	);

	chat.handleWsMessage({
		data: JSON.stringify({
			type: "rpc_event",
			sessionId: "rpc-a",
			seq: 3,
			event: { type: "agent_end" },
		}),
	});

	const orderedAfterMilestone = chat.orderedSessions();
	const topTwo = orderedAfterMilestone
		.slice(0, 2)
		.map((row) => String(row.id))
		.sort()
		.join(",");
	assertEq(
		topTwo,
		"sess-a,sess-b",
		"active non-streaming rows remain above inactive history",
	);
	const rowAAfterMilestone = orderedAfterMilestone.find(
		(row) => row.id === "sess-a",
	);
	if (!rowAAfterMilestone) {
		throw new Error("missing sess-a row after milestone");
	}
	assertEq(
		chat.sessionRowStatus(rowAAfterMilestone),
		"idle",
		"row status transitions back to idle on agent_end",
	);
	assertEq(
		chat.sessionRowUnread(rowAAfterMilestone),
		true,
		"background milestone sets unread badge state",
	);
}

console.log("\n-- malformed rpc events without sessionId are dropped --");
{
	const chat = await loadChatVm();
	chat.activeSessionId = "sess-x";
	chat.ensureSessionState("sess-x", { rpcSessionId: "rpc-x" });

	const sizeBefore = chat.sessionStateById.size;
	chat.handleWsMessage({
		data: JSON.stringify({
			type: "rpc_event",
			seq: 1,
			event: { type: "agent_start" },
		}),
	});

	assertEq(
		chat.sessionStateById.size,
		sizeBefore,
		"missing sessionId rpc events are ignored",
	);
}

console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
