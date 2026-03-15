import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listSessions } from "../web/session-reader-api.ts";

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

async function writeSessionFile(
	dir: string,
	name: string,
	id: string,
	cwd: string,
): Promise<string> {
	const file = path.join(dir, name);
	await writeFile(
		file,
		`${JSON.stringify({ type: "session", version: 1, id, cwd })}\n`,
		"utf8",
	);
	return file;
}

console.log("\n=== Web Session Reader API Tests ===\n");

const tmp = await mkdtemp(path.join(os.tmpdir(), "rho-session-reader-"));

try {
	const sessionDir = path.join(tmp, "sessions");
	await mkdir(sessionDir, { recursive: true });

	const olderStart = await writeSessionFile(
		sessionDir,
		"2026-03-14T10-00-00-000Z_old-active.jsonl",
		"old-active",
		"/tmp/project",
	);
	const newerStart = await writeSessionFile(
		sessionDir,
		"2026-03-14T11-00-00-000Z_newer-stale.jsonl",
		"newer-stale",
		"/tmp/project",
	);

	await utimes(
		newerStart,
		new Date("2026-03-14T11:05:00.000Z"),
		new Date("2026-03-14T11:05:00.000Z"),
	);
	await utimes(
		olderStart,
		new Date("2026-03-14T12:30:00.000Z"),
		new Date("2026-03-14T12:30:00.000Z"),
	);

	const { total, sessions } = await listSessions({
		sessionDir,
		cwd: "/tmp/project",
		limit: 20,
		offset: 0,
	});

	assertEq(total, 2, "listSessions counts matching sessions");
	assertEq(
		sessions[0]?.id,
		"old-active",
		"mtime sorts sessions ahead of filename timestamp",
	);
	assertEq(
		sessions[0]?.updatedAt,
		"2026-03-14T12:30:00.000Z",
		"updatedAt exposes file modification time for UI ordering",
	);
	assertEq(
		sessions[1]?.id,
		"newer-stale",
		"older activity falls behind newer filename when mtime is older",
	);
	assert(
		(sessions[0]?.timestamp || "") < (sessions[1]?.timestamp || ""),
		"test fixture proves reordered result differs from session start timestamps",
	);
} finally {
	await rm(tmp, { recursive: true, force: true });
}

console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
