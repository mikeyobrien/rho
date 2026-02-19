import { RpcSessionReliability } from "../web/rpc-reliability.ts";

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

console.log("\n=== Web RPC Reliability Tests ===\n");

console.log("-- event sequencing + replay --");
{
	const reliability = new RpcSessionReliability({ eventBufferSize: 3 });

	const seq1 = reliability.recordEvent("sess-a", { type: "agent_start" });
	const seq2 = reliability.recordEvent("sess-a", {
		type: "message_update",
		delta: "a",
	});
	const seq3 = reliability.recordEvent("sess-a", {
		type: "message_update",
		delta: "b",
	});
	const seq4 = reliability.recordEvent("sess-a", { type: "agent_end" });

	assertEq(seq1, 1, "first event seq starts at 1");
	assertEq(seq2, 2, "second event seq increments");
	assertEq(seq3, 3, "third event seq increments");
	assertEq(seq4, 4, "fourth event seq increments");

	const replayFrom2 = reliability.getReplay("sess-a", 2);
	assertEq(
		replayFrom2.events.length,
		2,
		"replay returns events newer than last seen seq",
	);
	assertEq(replayFrom2.events[0]?.seq, 3, "replay starts from seq=3");
	assertEq(replayFrom2.events[1]?.seq, 4, "replay includes latest seq");
	assertEq(
		replayFrom2.gap,
		false,
		"no replay gap when client is within buffer window",
	);

	const replayGap = reliability.getReplay("sess-a", 0);
	assertEq(replayGap.events.length, 3, "buffer keeps most recent N events");
	assertEq(
		replayGap.events[0]?.seq,
		2,
		"oldest buffered event advances with cap",
	);
	assertEq(
		replayGap.gap,
		true,
		"gap detected when last seen falls behind retained window",
	);

	reliability.dispose();
}

console.log("\n-- command dedupe + cached response --");
{
	const reliability = new RpcSessionReliability({
		commandRetentionMs: 5 * 60_000,
	});

	const first = reliability.registerCommand("sess-b", "cmd-1");
	assertEq(first.duplicate, false, "first command id is not a duplicate");

	const dupeBeforeResponse = reliability.registerCommand("sess-b", "cmd-1");
	assertEq(
		dupeBeforeResponse.duplicate,
		true,
		"duplicate command id detected before response",
	);
	assertEq(
		dupeBeforeResponse.cachedResponse,
		undefined,
		"duplicate without response has no cached response payload",
	);

	reliability.recordEvent("sess-b", {
		type: "response",
		id: "cmd-1",
		command: "prompt",
		success: true,
	});

	const dupeAfterResponse = reliability.registerCommand("sess-b", "cmd-1");
	assertEq(
		dupeAfterResponse.duplicate,
		true,
		"duplicate command id stays deduped after response",
	);
	assertEq(
		(dupeAfterResponse.cachedResponse as any)?.type,
		"response",
		"duplicate command returns cached response event",
	);
	assertEq(
		(dupeAfterResponse.cachedResponse as any)?.id,
		"cmd-1",
		"cached response preserves original command id",
	);

	reliability.dispose();
}

console.log("\n-- orphan grace: abort then stop --");
{
	const actions: string[] = [];
	const subscribed = new Set<string>();

	const reliability = new RpcSessionReliability({
		orphanGraceMs: 15,
		orphanAbortDelayMs: 15,
		hasSubscribers: (sessionId) => subscribed.has(sessionId),
		onAbort: (sessionId) => actions.push(`abort:${sessionId}`),
		onStop: (sessionId) => actions.push(`stop:${sessionId}`),
	});

	reliability.scheduleOrphan("sess-c");
	await sleep(20);
	assert(
		actions.includes("abort:sess-c"),
		"orphan grace emits abort before hard stop",
	);

	await sleep(20);
	assert(
		actions.includes("stop:sess-c"),
		"orphan cleanup emits stop after abort delay",
	);

	reliability.dispose();
}

console.log("\n-- orphan cancellation when subscriber returns --");
{
	const actions: string[] = [];
	const subscribed = new Set<string>();

	const reliability = new RpcSessionReliability({
		orphanGraceMs: 15,
		orphanAbortDelayMs: 15,
		hasSubscribers: (sessionId) => subscribed.has(sessionId),
		onAbort: (sessionId) => actions.push(`abort:${sessionId}`),
		onStop: (sessionId) => actions.push(`stop:${sessionId}`),
	});

	reliability.scheduleOrphan("sess-d");
	subscribed.add("sess-d");
	reliability.cancelOrphan("sess-d");

	await sleep(40);
	assertEq(
		actions.length,
		0,
		"cancelled orphan timer does not abort/stop active session",
	);

	reliability.dispose();
}

console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
