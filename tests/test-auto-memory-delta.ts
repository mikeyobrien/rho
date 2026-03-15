/**
 * Tests for auto-memory delta cursor resolution.
 * Run: npx tsx tests/test-auto-memory-delta.ts
 */

import { resolveAutoMemoryRange } from "../extensions/lib/auto-memory-delta.ts";

let PASS = 0;
let FAIL = 0;

function assertEq(actual: unknown, expected: unknown, label: string): void {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (ok) {
		console.log(`  PASS: ${label}`);
		PASS++;
	} else {
		console.error(
			`  FAIL: ${label} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
		);
		FAIL++;
	}
}

const messages = [
	{ role: "system", content: [{ type: "text", text: "meta" }] },
	{ role: "user", content: [{ type: "text", text: "hello" }] },
	{ role: "assistant", content: [{ type: "text", text: "hi" }] },
	{ role: "user", content: [{ type: "text", text: "prefer terse replies" }] },
	{ role: "assistant", content: [{ type: "text", text: "ok" }] },
];

console.log("\n-- resolveAutoMemoryRange defaults --");
{
	const range = resolveAutoMemoryRange(messages, null, 2);
	assertEq(
		{
			startIndex: range.startIndex,
			contextStartIndex: range.contextStartIndex,
			newMessageCount: range.newMessageCount,
		},
		{ startIndex: 0, contextStartIndex: 0, newMessageCount: 5 },
		"no cursor processes full conversation",
	);
}

console.log("\n-- resolveAutoMemoryRange keeps cursor when hash matches --");
{
	const firstRange = resolveAutoMemoryRange(messages.slice(0, 3), null, 2);
	const secondRange = resolveAutoMemoryRange(
		messages,
		{
			processedCount: 3,
			lastProcessedHash: firstRange.lastMessageHash,
		},
		2,
	);
	assertEq(
		{
			startIndex: secondRange.startIndex,
			contextStartIndex: secondRange.contextStartIndex,
			newMessageCount: secondRange.newMessageCount,
		},
		{ startIndex: 3, contextStartIndex: 1, newMessageCount: 2 },
		"matching cursor advances to unprocessed suffix with context window",
	);
}

console.log("\n-- resolveAutoMemoryRange relocates cursor by hash --");
{
	const base = resolveAutoMemoryRange(messages.slice(0, 3), null, 1);
	const compacted = messages.slice(1);
	const range = resolveAutoMemoryRange(
		compacted,
		{
			processedCount: 3,
			lastProcessedHash: base.lastMessageHash,
		},
		1,
	);
	assertEq(
		{
			startIndex: range.startIndex,
			contextStartIndex: range.contextStartIndex,
			newMessageCount: range.newMessageCount,
		},
		{ startIndex: 2, contextStartIndex: 1, newMessageCount: 2 },
		"hash relocation survives trimmed prefixes",
	);
}

console.log(
	"\n-- resolveAutoMemoryRange falls back to full scan when hash missing --",
);
{
	const range = resolveAutoMemoryRange(
		messages,
		{ processedCount: 4, lastProcessedHash: "deadbeefdeadbeef" },
		2,
	);
	assertEq(
		{
			startIndex: range.startIndex,
			contextStartIndex: range.contextStartIndex,
			newMessageCount: range.newMessageCount,
		},
		{ startIndex: 0, contextStartIndex: 0, newMessageCount: 5 },
		"missing hash forces conservative rescan",
	);
}

console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
