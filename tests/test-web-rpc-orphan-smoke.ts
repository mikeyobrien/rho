import { serve } from "@hono/node-server";
import * as net from "node:net";
import WebSocket from "ws";

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

async function waitFor(
	predicate: () => boolean,
	timeoutMs: number,
	stepMs: number = 10,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate()) {
			return;
		}
		await sleep(stepMs);
	}
	throw new Error("Timed out waiting for condition");
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

console.log("\n=== Web RPC Orphan Grace Smoke (real WS) ===\n");

// Keep grace short for deterministic smoke timing.
process.env.RHO_RPC_ORPHAN_GRACE_MS = "80";
process.env.RHO_RPC_ORPHAN_ABORT_DELAY_MS = "50";

const serverModule = await import("../web/server.ts");
const rpcModule = await import("../web/rpc-manager.ts");

const app = serverModule.default;
const disposeServerResources = serverModule.disposeServerResources;
const injectWebSocket = serverModule.injectWebSocket;
const rpcManager = rpcModule.rpcManager as any;

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
	handlers: Set<(event: any) => void>;
};

const sessionsById = new Map<string, FakeSession>();
const sessionByFile = new Map<string, string>();
let nextSession = 0;
let abortCalls = 0;
let stopCalls = 0;
let abortAt = 0;
let stopAt = 0;

function emit(sessionId: string, event: any): void {
	const state = sessionsById.get(sessionId);
	if (!state) return;
	for (const handler of state.handlers) {
		handler(event);
	}
}

try {
	rpcManager.startSession = (sessionFile: string): string => {
		nextSession += 1;
		const id = `fake-orphan-${nextSession}`;
		const state: FakeSession = {
			id,
			sessionFile,
			handlers: new Set(),
		};
		sessionsById.set(id, state);
		sessionByFile.set(sessionFile, id);
		return id;
	};

	rpcManager.findSessionByFile = (sessionFile: string): string | null => {
		const sessionId = sessionByFile.get(sessionFile);
		if (!sessionId) return null;
		return sessionsById.has(sessionId) ? sessionId : null;
	};

	rpcManager.onEvent = (
		sessionId: string,
		handler: (event: any) => void,
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

	rpcManager.sendCommand = (sessionId: string, command: any): void => {
		const state = sessionsById.get(sessionId);
		if (!state) {
			throw new Error(`Unknown fake session: ${sessionId}`);
		}

		if (command.type === "get_state") {
			emit(sessionId, {
				type: "response",
				id: command.id,
				command: "get_state",
				success: true,
				data: {
					isStreaming: false,
					thinkingLevel: "medium",
					sessionFile: state.sessionFile,
					sessionId: state.id,
				},
			});
			return;
		}

		if (command.type === "abort") {
			abortCalls += 1;
			if (!abortAt) {
				abortAt = Date.now();
			}
			return;
		}
	};

	rpcManager.hasSubscribers = (sessionId: string): boolean => {
		const state = sessionsById.get(sessionId);
		return Boolean(state && state.handlers.size > 0);
	};

	rpcManager.stopSession = (sessionId: string): void => {
		stopCalls += 1;
		if (!stopAt) {
			stopAt = Date.now();
		}
		const state = sessionsById.get(sessionId);
		if (!state) return;
		sessionsById.delete(sessionId);
		sessionByFile.delete(state.sessionFile);
	};

	rpcManager.dispose = (): void => {
		for (const sessionId of [...sessionsById.keys()]) {
			rpcManager.stopSession(sessionId);
		}
	};

	const port = await getFreePort();
	const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
	injectWebSocket(server);

	try {
		const wsUrl = `ws://127.0.0.1:${port}/ws`;
		const sessionFile = "/tmp/orphan-smoke.jsonl";
		const client = await createWsClient(wsUrl);

		client.ws.send(
			JSON.stringify({
				type: "rpc_command",
				sessionFile,
				command: {
					type: "switch_session",
					sessionPath: sessionFile,
					id: "switch-orphan",
				},
			}),
		);

		await waitForMessage(
			client.messages,
			(msg) => msg?.type === "session_started",
			2000,
		);
		assert(true, "session established over websocket");

		client.ws.close();

		await waitFor(() => abortCalls > 0, 2000);
		await waitFor(() => stopCalls > 0, 2000);

		assertEq(abortCalls, 1, "orphan grace emits exactly one abort before stop");
		assertEq(stopCalls, 1, "orphan grace emits exactly one stop");
		assert(abortAt > 0 && stopAt > 0, "orphan abort/stop timestamps captured");
		assert(abortAt <= stopAt, "abort happens before hard stop");
	} finally {
		disposeServerResources();
		server.close();
	}
} catch (error) {
	console.error("  FAIL: orphan smoke test crashed", error);
	FAIL++;
} finally {
	rpcManager.startSession = originalMethods.startSession;
	rpcManager.findSessionByFile = originalMethods.findSessionByFile;
	rpcManager.onEvent = originalMethods.onEvent;
	rpcManager.sendCommand = originalMethods.sendCommand;
	rpcManager.hasSubscribers = originalMethods.hasSubscribers;
	rpcManager.stopSession = originalMethods.stopSession;
	rpcManager.dispose = originalMethods.dispose;
}

console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
