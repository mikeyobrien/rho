/**
 * Regression test: slash command notify-before-response race condition.
 *
 * When a slash command (e.g., /usage) emits a `notify` event BEFORE the
 * `response` event, the RPC runner must still resolve the promise.
 *
 * Bug: the slashAckTimer sees lastAssistantText is set and returns early
 * (assuming someone else already resolved), but nobody did — the notify
 * handler didn't resolve because sawPromptResponse was still false.
 *
 * Run: npx tsx tests/test-rpc-slash-notify-race.ts
 */

import { EventEmitter } from "node:events";
import { TelegramRpcRunner } from "../extensions/telegram/rpc.ts";

let PASS = 0;
let FAIL = 0;

function assert(condition: boolean, label: string): void {
	if (condition) {
		console.log(`  PASS: ${label}`);
		PASS++;
	} else {
		console.error(`  FAIL: ${label}`);
		FAIL++;
	}
}

/**
 * Creates a fake child process that emits JSON lines on stdout.
 * The `emit` helper sends events in order, simulating pi --mode rpc.
 */
function createMockProcess() {
	const stdout = new EventEmitter();
	const stderr = new EventEmitter();
	const stdin = {
		write: (_data: string, _enc?: string) => true,
		writable: true,
		destroyed: false,
	};

	// biome-ignore lint/suspicious/noExplicitAny: mock needs to match ChildProcess shape
	(stdout as any).setEncoding = () => {};
	// biome-ignore lint/suspicious/noExplicitAny: mock needs to match ChildProcess shape
	(stderr as any).setEncoding = () => {};

	const proc = Object.assign(new EventEmitter(), {
		stdout,
		stderr,
		stdin,
		pid: 99999,
		killed: false,
		kill: () => {},
	});

	const emitLine = (obj: Record<string, unknown>) => {
		stdout.emit("data", `${JSON.stringify(obj)}\n`);
	};

	return { proc, emitLine };
}

console.log(
	"\n=== RPC slash notify-before-response race condition tests ===\n",
);

// ── Test 1: notify BEFORE response (the bug) ──────────────────────────
console.log("-- notify arrives before response for slash command --");

{
	const { proc, emitLine } = createMockProcess();

	// Mock spawn to return our fake process and auto-send get_commands response
	const mockSpawn = (() => {
		// Intercept stdin writes to detect get_commands requests
		const originalWrite = proc.stdin.write;
		proc.stdin.write = (data: string, enc?: string) => {
			try {
				const parsed = JSON.parse(data.trim());
				if (parsed.type === "get_commands") {
					// Reply with a commands list that includes "usage"
					setTimeout(() => {
						emitLine({
							type: "response",
							command: "get_commands",
							id: parsed.id,
							success: true,
							data: [
								{
									name: "usage",
									source: "extension",
									description: "Refresh API usage bars",
								},
							],
						});
					}, 5);
				}
				if (parsed.type === "prompt") {
					// Simulate /usage handler:
					// 1. First emit notify (ui.notify fires during handler execution)
					// 2. Then emit response (pi sends after handler completes)
					setTimeout(() => {
						emitLine({
							type: "notify",
							method: "notify",
							message: "Usage refreshed",
							level: "info",
						});
					}, 10);

					setTimeout(() => {
						emitLine({
							type: "response",
							command: "prompt",
							id: parsed.id,
							success: true,
						});
					}, 15);

					// No agent_start, no agent_end, no message_end
					// (slash commands that don't invoke LLM)
				}
			} catch {
				// ignore non-JSON
			}
			return originalWrite.call(proc.stdin, data, enc);
		};

		return () => proc;
	})();

	const runner = // biome-ignore lint/suspicious/noExplicitAny: mock spawn factory
		new TelegramRpcRunner(mockSpawn as any);

	// Run prompt with a 5s timeout (plenty of time, bug causes 60s hang)
	const resultPromise = runner.runPrompt(
		"/tmp/test-session.jsonl",
		"/usage",
		5_000,
	);

	try {
		const result = await Promise.race([
			resultPromise,
			new Promise<string>((_, reject) =>
				setTimeout(
					() =>
						reject(
							new Error("Test timed out after 3s — prompt never resolved"),
						),
					3_000,
				),
			),
		]);
		assert(
			typeof result === "string" && result.length > 0,
			`slash /usage resolved with text: "${result}"`,
		);
		assert(
			result.includes("Usage refreshed") || result.includes("✅"),
			"resolved text contains notify message or ack",
		);
	} catch (error) {
		const msg = (error as Error).message;
		assert(false, `slash /usage should resolve but got: ${msg}`);
	}

	runner.dispose();
}

// ── Test 2: response BEFORE notify (should already work) ──────────────
console.log("\n-- response arrives before notify for slash command --");

{
	const { proc, emitLine } = createMockProcess();

	const mockSpawn = (() => {
		const originalWrite = proc.stdin.write;
		proc.stdin.write = (data: string, enc?: string) => {
			try {
				const parsed = JSON.parse(data.trim());
				if (parsed.type === "get_commands") {
					setTimeout(() => {
						emitLine({
							type: "response",
							command: "get_commands",
							id: parsed.id,
							success: true,
							data: [
								{
									name: "usage",
									source: "extension",
									description: "Refresh API usage bars",
								},
							],
						});
					}, 5);
				}
				if (parsed.type === "prompt") {
					// Response FIRST, then notify
					setTimeout(() => {
						emitLine({
							type: "response",
							command: "prompt",
							id: parsed.id,
							success: true,
						});
					}, 10);

					setTimeout(() => {
						emitLine({
							type: "notify",
							method: "notify",
							message: "Usage refreshed",
							level: "info",
						});
					}, 15);
				}
			} catch {
				// ignore
			}
			return originalWrite.call(proc.stdin, data, enc);
		};

		return () => proc;
	})();

	const runner = // biome-ignore lint/suspicious/noExplicitAny: mock spawn factory
		new TelegramRpcRunner(mockSpawn as any);

	const resultPromise = runner.runPrompt(
		"/tmp/test-session-2.jsonl",
		"/usage",
		5_000,
	);

	try {
		const result = await Promise.race([
			resultPromise,
			new Promise<string>((_, reject) =>
				setTimeout(() => reject(new Error("Test timed out after 3s")), 3_000),
			),
		]);
		assert(
			typeof result === "string" && result.length > 0,
			`response-first resolved with: "${result}"`,
		);
	} catch (error) {
		const msg = (error as Error).message;
		assert(false, `response-first should resolve but got: ${msg}`);
	}

	runner.dispose();
}

// ── Test 3: slash command with NO notify, NO agent_end (pure ack) ─────
console.log(
	"\n-- slash command with only response (no notify, no agent output) --",
);

{
	const { proc, emitLine } = createMockProcess();

	const mockSpawn = (() => {
		const originalWrite = proc.stdin.write;
		proc.stdin.write = (data: string, enc?: string) => {
			try {
				const parsed = JSON.parse(data.trim());
				if (parsed.type === "get_commands") {
					setTimeout(() => {
						emitLine({
							type: "response",
							command: "get_commands",
							id: parsed.id,
							success: true,
							data: [
								{ name: "ping", source: "extension", description: "Ping" },
							],
						});
					}, 5);
				}
				if (parsed.type === "prompt") {
					// Only response, nothing else
					setTimeout(() => {
						emitLine({
							type: "response",
							command: "prompt",
							id: parsed.id,
							success: true,
						});
					}, 10);
				}
			} catch {
				// ignore
			}
			return originalWrite.call(proc.stdin, data, enc);
		};

		return () => proc;
	})();

	const runner = // biome-ignore lint/suspicious/noExplicitAny: mock spawn factory
		new TelegramRpcRunner(mockSpawn as any);

	const resultPromise = runner.runPrompt(
		"/tmp/test-session-3.jsonl",
		"/ping",
		5_000,
	);

	try {
		const result = await Promise.race([
			resultPromise,
			new Promise<string>((_, reject) =>
				setTimeout(() => reject(new Error("Test timed out after 3s")), 3_000),
			),
		]);
		assert(
			typeof result === "string" && result.includes("✅"),
			`pure ack resolved: "${result}"`,
		);
	} catch (error) {
		const msg = (error as Error).message;
		assert(false, `pure ack should resolve but got: ${msg}`);
	}

	runner.dispose();
}

// ── Summary ───────────────────────────────────────────────────────────
console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===`);
process.exit(FAIL > 0 ? 1 : 0);
