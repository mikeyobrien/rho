import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	cancelReviewRecord,
	claimReviewRecord,
	createReviewRecord,
	getReviewRecord,
	listReviewRecords,
	ReviewStoreError,
	resolveReviewRecord,
	submitReviewRecord,
} from "../web/review-store.ts";

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
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a === e) {
		console.log(`  PASS: ${label}`);
		PASS++;
		return;
	}
	console.error(`  FAIL: ${label} (expected ${e}, got ${a})`);
	FAIL++;
}

function mkTempStorePath(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-store-test-"));
	return path.join(dir, "reviews.jsonl");
}

console.log("\n=== Review Store Tests ===\n");

console.log("-- create + list defaults --");
{
	const storePath = mkTempStorePath();
	const created = await createReviewRecord(
		{
			id: "rev-1",
			request: {
				files: ["web/public/js/chat.js"],
				warnings: [],
				message: "refactor review",
				source: "tool",
			},
		},
		storePath,
	);

	assertEq(created.id, "rev-1", "created record has id");
	assertEq(created.status, "open", "created status is open");

	const inbox = await listReviewRecords({}, storePath);
	assertEq(inbox.length, 0, "default inbox excludes open records");

	const all = await listReviewRecords({ status: "all" }, storePath);
	assertEq(all.length, 1, "all includes open records");
	assertEq(
		all[0].request.files[0],
		"web/public/js/chat.js",
		"file path persisted",
	);
}

console.log("\n-- submit + claim + resolve lifecycle --");
{
	const storePath = mkTempStorePath();
	await createReviewRecord(
		{
			id: "rev-2",
			request: { files: ["a.ts"], warnings: [], source: "tool" },
		},
		storePath,
	);

	const submitted = await submitReviewRecord(
		"rev-2",
		[
			{
				file: "a.ts",
				startLine: 1,
				endLine: 1,
				selectedText: "const x = 1;",
				comment: "extract constant",
			},
		],
		storePath,
	);
	assertEq(submitted.status, "submitted", "submit transitions to submitted");
	assertEq(
		submitted.resultSummary.commentCount,
		1,
		"submit stores comment count",
	);

	const inbox = await listReviewRecords({ status: "inbox" }, storePath);
	assertEq(inbox.length, 1, "submitted review appears in inbox");
	assertEq(inbox[0].id, "rev-2", "inbox contains submitted review id");

	const claimed = await claimReviewRecord("rev-2", "agent-a", storePath);
	assertEq(claimed.status, "claimed", "claim transitions to claimed");
	assertEq(claimed.claimedBy, "agent-a", "claim stores actor");

	let conflictCaught = false;
	try {
		await claimReviewRecord("rev-2", "agent-b", storePath);
	} catch (error) {
		conflictCaught =
			error instanceof ReviewStoreError && error.code === "CONFLICT";
	}
	assert(conflictCaught, "claim by another actor is rejected with conflict");

	const resolved = await resolveReviewRecord("rev-2", "agent-a", storePath);
	assertEq(resolved.status, "resolved", "resolve transitions to resolved");
	assertEq(resolved.resolvedBy, "agent-a", "resolve stores actor");

	const inboxAfterResolve = await listReviewRecords(
		{ status: "inbox" },
		storePath,
	);
	assertEq(inboxAfterResolve.length, 0, "resolved review no longer in inbox");
}

console.log("\n-- cancel lifecycle + invalid transitions --");
{
	const storePath = mkTempStorePath();
	await createReviewRecord(
		{ id: "rev-3", request: { files: ["b.ts"], warnings: [] } },
		storePath,
	);

	const cancelled = await cancelReviewRecord("rev-3", storePath);
	assertEq(
		cancelled.status,
		"cancelled",
		"cancel transitions open -> cancelled",
	);

	await createReviewRecord(
		{ id: "rev-4", request: { files: ["c.ts"], warnings: [] } },
		storePath,
	);
	await submitReviewRecord(
		"rev-4",
		[
			{
				file: "c.ts",
				startLine: 2,
				endLine: 2,
				selectedText: "return c;",
				comment: "improve naming",
			},
		],
		storePath,
	);

	let invalidCancel = false;
	try {
		await cancelReviewRecord("rev-4", storePath);
	} catch (error) {
		invalidCancel =
			error instanceof ReviewStoreError && error.code === "INVALID_STATE";
	}
	assert(invalidCancel, "cannot cancel after submit");
}

console.log("\n-- persistence across reloads --");
{
	const storePath = mkTempStorePath();
	await createReviewRecord(
		{
			id: "rev-5",
			request: { files: ["d.ts"], warnings: ["Skipped: x.bin (binary)"] },
		},
		storePath,
	);
	await submitReviewRecord(
		"rev-5",
		[
			{
				file: "d.ts",
				startLine: 10,
				endLine: 12,
				selectedText: "if (ok) {\n  go();\n}",
				comment: "handle error path",
			},
		],
		storePath,
	);

	const fetched = await getReviewRecord("rev-5", storePath);
	assert(!!fetched, "get returns persisted review");
	assertEq(fetched?.status, "submitted", "fetched status persisted");
	assertEq(
		fetched?.submission?.comments?.[0]?.comment,
		"handle error path",
		"fetched comments persisted",
	);

	const listed = await listReviewRecords({ status: "submitted" }, storePath);
	assertEq(listed.length, 1, "submitted list finds persisted record");
	assertEq(
		listed[0].request.warnings[0],
		"Skipped: x.bin (binary)",
		"warnings persisted",
	);
}

console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
