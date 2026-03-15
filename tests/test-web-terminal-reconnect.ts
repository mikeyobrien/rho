import * as net from "node:net";
import { serve } from "@hono/node-server";
import WebSocket from "ws";
import app, { disposeServerResources, injectWebSocket } from "../web/server.ts";

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
	parsed: unknown;
};

function createWsClient(url: string): Promise<{
	ws: WebSocket;
	messages: CapturedMessage[];
}> {
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url);
		const messages: CapturedMessage[] = [];
		ws.on("open", () => resolve({ ws, messages }));
		ws.on("message", (raw) => {
			const text = raw.toString();
			try {
				messages.push({ raw: text, parsed: JSON.parse(text) as unknown });
			} catch {
				messages.push({ raw: text, parsed: null });
			}
		});
		ws.on("error", reject);
	});
}

async function waitForMessage<T>(
	messages: CapturedMessage[],
	matcher: (parsed: unknown) => parsed is T,
	timeoutMs: number,
): Promise<T> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		for (const message of messages) {
			if (matcher(message.parsed)) {
				return message.parsed;
			}
		}
		await sleep(10);
	}
	throw new Error("Timed out waiting for websocket message");
}

type SessionEnvelope = {
	type: string;
	session?: { id?: string };
	replay?: string;
	data?: string;
};

console.log("\n=== Web Terminal Reconnect Smoke ===\n");

const port = await getFreePort();
const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
injectWebSocket(server);

try {
	const url = `ws://127.0.0.1:${port}/terminal/ws`;
	const marker = `rho-terminal-reconnect-${Date.now()}`;

	const firstClient = await createWsClient(url);
	await waitForMessage(
		firstClient.messages,
		(parsed): parsed is { type: string } =>
			typeof parsed === "object" &&
			parsed !== null &&
			(parsed as { type?: unknown }).type === "terminal_ready",
		1000,
	);
	firstClient.ws.send(JSON.stringify({ type: "create", cols: 80, rows: 24 }));
	const created = await waitForMessage(
		firstClient.messages,
		(parsed): parsed is SessionEnvelope =>
			typeof parsed === "object" &&
			parsed !== null &&
			(parsed as { type?: unknown }).type === "terminal_session_created",
		2000,
	);
	const sessionId = created.session?.id;
	assert(
		typeof sessionId === "string" && sessionId.length > 0,
		"terminal session is created over websocket",
	);

	firstClient.ws.send(
		JSON.stringify({
			type: "input",
			sessionId,
			data: `printf '${marker}\\n'\r`,
		}),
	);
	await waitForMessage(
		firstClient.messages,
		(parsed): parsed is SessionEnvelope =>
			typeof parsed === "object" &&
			parsed !== null &&
			(parsed as { type?: unknown }).type === "terminal_data" &&
			typeof (parsed as { data?: unknown }).data === "string" &&
			((parsed as { data: string }).data.includes(marker) || false),
		3000,
	);
	firstClient.ws.close();
	await sleep(100);

	const secondClient = await createWsClient(url);
	await waitForMessage(
		secondClient.messages,
		(parsed): parsed is { type: string } =>
			typeof parsed === "object" &&
			parsed !== null &&
			(parsed as { type?: unknown }).type === "terminal_ready",
		1000,
	);
	secondClient.ws.send(JSON.stringify({ type: "attach", sessionId }));
	const attached = await waitForMessage(
		secondClient.messages,
		(parsed): parsed is SessionEnvelope =>
			typeof parsed === "object" &&
			parsed !== null &&
			(parsed as { type?: unknown }).type === "terminal_session_attached",
		2000,
	);
	assert(
		typeof attached.replay === "string" && attached.replay.includes(marker),
		"reattach returns replay data containing prior terminal output",
	);

	secondClient.ws.send(JSON.stringify({ type: "close", sessionId }));
	await waitForMessage(
		secondClient.messages,
		(parsed): parsed is { type: string } =>
			typeof parsed === "object" &&
			parsed !== null &&
			(parsed as { type?: unknown }).type === "terminal_exit",
		2000,
	);
	assert(true, "terminal session can be explicitly closed after reattach");
	secondClient.ws.close();
} finally {
	disposeServerResources();
	server.close();
}

console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
