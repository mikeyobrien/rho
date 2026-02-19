import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { readSession } from "../web/session-reader.ts";

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

function assertApprox(
	actual: number,
	expected: number,
	epsilon: number,
	label: string,
): void {
	if (Math.abs(actual - expected) <= epsilon) {
		console.log(`  PASS: ${label}`);
		PASS++;
		return;
	}
	console.error(
		`  FAIL: ${label} (expected ${expected}, got ${actual}, ε=${epsilon})`,
	);
	FAIL++;
}

console.log("\n=== Web Session Usage Regression Tests ===\n");

console.log("-- session-reader usage aggregation variants --");
{
	const tmpDir = await mkdtemp(path.join(os.tmpdir(), "rho-web-usage-"));
	const sessionFile = path.join(tmpDir, "session.jsonl");
	const now = new Date().toISOString();

	const entries = [
		{
			type: "session",
			id: "sess-usage",
			timestamp: now,
			cwd: "/tmp/rho",
		},
		{
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: now,
			message: {
				role: "user",
				content: [{ type: "text", text: "hello" }],
			},
		},
		{
			type: "message",
			id: "a1",
			parentId: "u1",
			timestamp: now,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "turn 1" }],
				usage: {
					prompt_tokens: 10,
					completion_tokens: 5,
					cache_read_input_tokens: 2,
					cache_creation_input_tokens: 1,
					cost: {
						input: 0.01,
						output: 0.02,
						cache_read: 0.003,
						cache_write: 0.004,
					},
				},
			},
		},
		{
			type: "message",
			id: "u2",
			parentId: "a1",
			timestamp: now,
			message: {
				role: "user",
				content: [{ type: "text", text: "next" }],
			},
		},
		{
			type: "message",
			id: "a2",
			parentId: "u2",
			timestamp: now,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "turn 2" }],
				usage: {
					inputTokens: 4,
					outputTokens: 6,
					cacheReadTokens: 1,
					cacheCreation: 3,
					total_tokens: 14,
					costTotal: 0.05,
				},
			},
		},
	];

	await writeFile(
		sessionFile,
		`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
		"utf-8",
	);

	const parsed = await readSession(sessionFile);
	assertEq(
		parsed.stats.messageCount,
		4,
		"message count excludes session header",
	);
	assertEq(
		parsed.stats.tokenUsage,
		32,
		"token usage sums mixed usage field variants",
	);
	assertApprox(
		parsed.stats.cost,
		0.087,
		1e-9,
		"cost sums total + cost-part fallbacks",
	);

	await rm(tmpDir, { recursive: true, force: true });
}

console.log("\n-- chat footer accumulation per assistant turn --");

async function loadChatVm(): Promise<any> {
	const listeners = new Map<string, (...args: any[]) => void>();
	let factory: (() => any) | null = null;

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
	});
	(globalThis as any).requestAnimationFrame = (cb: () => void) => {
		cb();
		return 0;
	};
	(globalThis as any).Alpine = {
		data: (_name: string, fn: () => any) => {
			factory = fn;
		},
	};

	const chatPath = path.resolve(
		import.meta.dirname!,
		"../web/public/js/chat.js",
	);
	await import(pathToFileURL(chatPath).href + `?test=${Date.now()}`);

	const init = listeners.get("alpine:init");
	if (!init) {
		throw new Error("chat.js did not register alpine:init listener");
	}
	init();

	if (!factory) {
		throw new Error("chat.js did not register Alpine.data factory");
	}

	const vm = factory();
	vm.$refs = { thread: null };
	vm.$root = null;
	vm.$nextTick = (fn: (() => void) | undefined) => {
		if (typeof fn === "function") {
			fn();
		}
	};
	vm.loadSessions = () => {};
	vm.updateFooter = () => {};

	return vm;
}

{
	const chat = await loadChatVm();

	const loadedMessages = [
		{
			id: "a1",
			role: "assistant",
			usage: {
				input: 3,
				output: 4,
				totalTokens: 7,
				cost: { total: 0.02 },
			},
		},
		{
			id: "a2",
			role: "assistant",
			usage: {
				prompt_tokens: 2,
				completion_tokens: 3,
				cache_read_input_tokens: 1,
				cache_creation_input_tokens: 2,
				cost: {
					input: 0.01,
					output: 0.02,
					cache_read: 0.003,
					cache_write: 0.004,
				},
			},
		},
	];

	chat.sessionStats = {
		tokens: 0,
		cost: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheRead: 0,
		cacheWrite: 0,
	};
	chat.renderedMessages = [];
	chat.usageAccountedMessageIds = new Set();

	chat.syncSessionStatsFromSession({}, loadedMessages);
	chat.seedUsageAccumulator(loadedMessages);

	assertEq(chat.sessionStats.tokens, 15, "loaded session seeds token totals");
	assertApprox(
		chat.sessionStats.cost,
		0.057,
		1e-9,
		"loaded session seeds cost totals",
	);
	assertEq(
		chat.usageAccountedMessageIds.size,
		2,
		"loaded assistant turns are marked as accounted",
	);

	const turn3 = {
		message: {
			id: "a3",
			role: "assistant",
			timestamp: new Date().toISOString(),
			content: [{ type: "text", text: "turn 3" }],
			usage: {
				input: 5,
				output: 5,
				totalTokens: 10,
				cost: { total: 0.05 },
			},
			model: "anthropic/claude",
		},
	};

	chat.handleMessageEnd(turn3);
	assertEq(
		chat.sessionStats.tokens,
		25,
		"new assistant turn increments tokens",
	);
	assertApprox(
		chat.sessionStats.cost,
		0.107,
		1e-9,
		"new assistant turn increments cost",
	);

	chat.handleMessageEnd(turn3);
	assertEq(
		chat.sessionStats.tokens,
		25,
		"duplicate message_end does not double-count tokens",
	);
	assertApprox(
		chat.sessionStats.cost,
		0.107,
		1e-9,
		"duplicate message_end does not double-count cost",
	);

	chat.handleMessageEnd({
		message: {
			id: "a4",
			role: "assistant",
			timestamp: new Date().toISOString(),
			content: [{ type: "text", text: "turn 4" }],
			usage: {
				input_tokens: "1",
				output_tokens: "2",
				cache_read: "3",
				cache_write: "4",
				cost: {
					input: "0.001",
					output: "0.002",
					cache_read: "0.003",
					cache_write: "0.004",
				},
			},
			model: "anthropic/claude",
		},
	});

	assertEq(
		chat.sessionStats.tokens,
		35,
		"alternate token field names are accumulated on new turns",
	);
	assertApprox(
		chat.sessionStats.cost,
		0.117,
		1e-9,
		"cost-part fallback is accumulated on new turns",
	);

	chat.clearSelectedSession();
	assertEq(
		chat.usageAccountedMessageIds.size,
		0,
		"switching/clearing session resets accounted message IDs",
	);
}

console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
