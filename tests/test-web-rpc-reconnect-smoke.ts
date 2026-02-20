import { serve } from "@hono/node-server";
import * as net from "node:net";
import WebSocket from "ws";

import app, { disposeServerResources, injectWebSocket } from "../web/server.ts";
import {
	type RPCCommand,
	type RPCEvent,
	rpcManager,
} from "../web/rpc-manager.ts";

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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const probe = net.createServer();
		probe.once("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const addr = probe.address();
			if (!addr || typeof addr === "string") {
				reject(new Error("Failed to obtain free port"));
				return;
			}
			const { port } = addr;
			probe.close((err) => {
				if (err) reject(err);
				else resolve(port);
			});
		});
	});
}

type CapturedMessage = {
	raw: string;
	parsed: any;
};

function createWsClient(url: string): Promise<{
	ws: WebSocket;
	messages: CapturedMessage[];
}> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url);
		const messages: CapturedMessage[] = [];
		ws.on("open", () => {
			resolve({ ws, messages });
		});
		ws.on("message", (raw) => {
			const text = raw.toString();
			try {
				messages.push({ raw: text, parsed: JSON.parse(text) });
			} catch {
				messages.push({ raw: text, parsed: null });
			}
		});
		ws.on("error", (err) => {
			reject(err);
		});
	});
}

async function waitForMessage(
	messages: CapturedMessage[],
	matcher: (parsed: any) => boolean,
	timeoutMs: number,
): Promise<any> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		for (const msg of messages) {
			if (matcher(msg.parsed)) {
				return msg.parsed;
			}
		}
		await sleep(10);
	}
	throw new Error("Timed out waiting for message");
}

console.log("\n=== Web RPC Reconnect Smoke (real WS) ===\n");

const originalMethods = {
	startSession: rpcManager.startSession.bind(rpcManager),
	findSessionByFile: rpcManager.findSessionByFile.bind(rpcManager),
	onEvent: rpcManager.onEvent.bind(rpcManager),
	sendCommand: rpcManager.sendCommand.bind(rpcManager),
	hasSubscribers: rpcManager.hasSubscribers.bind(rpcManager),
	stopSession: rpcManager.stopSession.bind(rpcManager),
	dispose: rpcManager.dispose.bind(rpcManager),
};

type FakeSession = {
	id: string;
	sessionFile: string;
	handlers: Set<(event: RPCEvent) => void>;
	isStreaming: boolean;
	timers: Set<NodeJS.Timeout>;
};

const sessionsById = new Map<string, FakeSession>();
const sessionByFile = new Map<string, string>();
let nextSession = 0;
let promptExecutions = 0;
let stopCalls = 0;

function emit(sessionId: string, event: RPCEvent): void {
	const state = sessionsById.get(sessionId);
	if (!state) {
		return;
	}
	if (event.type === "agent_start") {
		state.isStreaming = true;
	}
	if (event.type === "agent_end") {
		state.isStreaming = false;
	}
	for (const handler of state.handlers) {
		handler(event);
	}
}

function schedule(state: FakeSession, delayMs: number, fn: () => void): void {
	const timer = setTimeout(() => {
		state.timers.delete(timer);
		fn();
	}, delayMs);
	state.timers.add(timer);
}

function buildStateResponse(state: FakeSession) {
	return {
		model: undefined,
		thinkingLevel: "medium",
		isStreaming: state.isStreaming,
		isCompacting: false,
		steeringMode: "all",
		followUpMode: "one-at-a-time",
		sessionFile: state.sessionFile,
		sessionId: state.id,
		sessionName: undefined,
		autoCompactionEnabled: false,
		messageCount: 0,
		pendingMessageCount: 0,
	};
}

try {
	(rpcManager as any).startSession = (sessionFile: string): string => {
		nextSession += 1;
		const id = `fake-rpc-${nextSession}`;
		const state: FakeSession = {
			id,
			sessionFile,
			handlers: new Set(),
			isStreaming: false,
			timers: new Set(),
		};
		sessionsById.set(id, state);
		sessionByFile.set(sessionFile, id);
		return id;
	};

	(rpcManager as any).findSessionByFile = (
		sessionFile: string,
	): string | null => {
		const sessionId = sessionByFile.get(sessionFile);
		if (!sessionId) return null;
		return sessionsById.has(sessionId) ? sessionId : null;
	};

	(rpcManager as any).onEvent = (
		sessionId: string,
		handler: (event: RPCEvent) => void,
	): (() => void) => {
		const state = sessionsById.get(sessionId);
		if (!state) {
			throw new Error(`Unknown fake session: ${sessionId}`);
		}
		state.handlers.add(handler);
		return () => {
			state.handlers.delete(handler);
		};
	};

	(rpcManager as any).sendCommand = (
		sessionId: string,
		command: RPCCommand,
	): void => {
		const state = sessionsById.get(sessionId);
		if (!state) {
			throw new Error(`Unknown fake session: ${sessionId}`);
		}

		const commandId = typeof command.id === "string" ? command.id : undefined;

		if (command.type === "get_state") {
			emit(sessionId, {
				type: "response",
				command: "get_state",
				id: commandId,
				success: true,
				data: buildStateResponse(state),
			} as RPCEvent);
			return;
		}

		if (command.type === "abort") {
			emit(sessionId, {
				type: "response",
				command: "abort",
				id: commandId,
				success: true,
			} as RPCEvent);
			state.isStreaming = false;
			return;
		}

		if (command.type === "prompt") {
			promptExecutions += 1;
			emit(sessionId, {
				type: "response",
				command: "prompt",
				id: commandId,
				success: true,
			} as RPCEvent);

			schedule(state, 10, () =>
				emit(sessionId, { type: "agent_start" } as RPCEvent),
			);
			schedule(state, 20, () =>
				emit(sessionId, {
					type: "message_update",
					message: {
						id: "assistant-1",
						role: "assistant",
						timestamp: new Date().toISOString(),
						content: [{ type: "text", text: "Hello" }],
					},
					assistantMessageEvent: {
						type: "text_delta",
						contentIndex: 0,
						delta: "Hel",
					},
				} as RPCEvent),
			);
			schedule(state, 90, () =>
				emit(sessionId, {
					type: "message_update",
					message: {
						id: "assistant-1",
						role: "assistant",
						timestamp: new Date().toISOString(),
						content: [{ type: "text", text: "Hello world" }],
					},
					assistantMessageEvent: {
						type: "text_delta",
						contentIndex: 0,
						delta: "lo world",
					},
				} as RPCEvent),
			);
			schedule(state, 120, () =>
				emit(sessionId, {
					type: "message_end",
					message: {
						id: "assistant-1",
						role: "assistant",
						timestamp: new Date().toISOString(),
						content: [{ type: "text", text: "Hello world" }],
					},
				} as RPCEvent),
			);
			schedule(state, 150, () =>
				emit(sessionId, { type: "agent_end" } as RPCEvent),
			);
			return;
		}
	};

	(rpcManager as any).hasSubscribers = (sessionId: string): boolean => {
		const state = sessionsById.get(sessionId);
		return Boolean(state && state.handlers.size > 0);
	};

	(rpcManager as any).stopSession = (sessionId: string): void => {
		stopCalls += 1;
		const state = sessionsById.get(sessionId);
		if (!state) {
			return;
		}
		for (const timer of state.timers) {
			clearTimeout(timer);
		}
		sessionsById.delete(sessionId);
		sessionByFile.delete(state.sessionFile);
	};

	(rpcManager as any).dispose = (): void => {
		for (const sessionId of [...sessionsById.keys()]) {
			(rpcManager as any).stopSession(sessionId);
		}
	};

	const port = await getFreePort();
	const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
	injectWebSocket(server);

	try {
		const wsUrl = `ws://127.0.0.1:${port}/ws`;
		const sessionFile = "/tmp/reconnect-smoke.jsonl";

		const client1 = await createWsClient(wsUrl);
		client1.ws.send(
			JSON.stringify({
				type: "rpc_command",
				sessionFile,
				command: {
					type: "switch_session",
					sessionPath: sessionFile,
					id: "switch-1",
				},
			}),
		);

		const started = await waitForMessage(
			client1.messages,
			(msg) => msg?.type === "session_started",
			2000,
		);
		const sessionId = String(started.sessionId ?? "");
		assert(Boolean(sessionId), "session_started yields rpc session id");

		client1.ws.send(
			JSON.stringify({
				type: "rpc_command",
				sessionId,
				command: {
					type: "prompt",
					id: "prompt-1",
					message: "hello",
				},
			}),
		);

		const firstDelta = await waitForMessage(
			client1.messages,
			(msg) =>
				msg?.type === "rpc_event" && msg?.event?.type === "message_update",
			2000,
		);
		const lastSeqSeen = Number(firstDelta.seq ?? 0);
		assert(lastSeqSeen > 0, "first live stream event includes sequence number");

		client1.ws.close();
		await sleep(40);

		const client2 = await createWsClient(wsUrl);
		client2.ws.send(
			JSON.stringify({
				type: "rpc_command",
				sessionId,
				lastEventSeq: 0,
				command: {
					type: "get_state",
					id: "state-1",
				},
			}),
		);

		const replayed = await waitForMessage(
			client2.messages,
			(msg) => msg?.type === "rpc_event" && msg?.replay === true,
			2000,
		);
		assert(
			Number(replayed.seq ?? 0) >= 1,
			"reconnect can replay buffered stream events",
		);

		await waitForMessage(
			client2.messages,
			(msg) => msg?.type === "rpc_event" && msg?.event?.type === "agent_end",
			2000,
		);
		assert(true, "reconnected client receives completion event");

		client2.ws.send(
			JSON.stringify({
				type: "rpc_command",
				sessionId,
				command: {
					type: "prompt",
					id: "prompt-1",
					message: "hello again",
				},
			}),
		);

		await waitForMessage(
			client2.messages,
			(msg) =>
				msg?.type === "rpc_event" &&
				msg?.event?.type === "response" &&
				msg?.event?.id === "prompt-1",
			2000,
		);
		assertEq(
			promptExecutions,
			1,
			"duplicate prompt id is deduped server-side (single execution)",
		);

		assertEq(
			stopCalls,
			0,
			"session is not hard-stopped during short disconnect/reconnect window",
		);

		client2.ws.close();
	} finally {
		disposeServerResources();
		server.close();
	}
} catch (error) {
	console.error("  FAIL: reconnect smoke test crashed", error);
	FAIL++;
} finally {
	(rpcManager as any).startSession = originalMethods.startSession;
	(rpcManager as any).findSessionByFile = originalMethods.findSessionByFile;
	(rpcManager as any).onEvent = originalMethods.onEvent;
	(rpcManager as any).sendCommand = originalMethods.sendCommand;
	(rpcManager as any).hasSubscribers = originalMethods.hasSubscribers;
	(rpcManager as any).stopSession = originalMethods.stopSession;
	(rpcManager as any).dispose = originalMethods.dispose;
}

console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
