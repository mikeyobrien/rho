import app from "../web/server.ts";
import {
	type TerminalSessionInfo,
	terminalManager,
} from "../web/terminal-manager.ts";

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

console.log("\n=== Web Terminal Route Tests ===\n");

console.log("-- /terminal is not exposed as a standalone route --");
{
	const response = await app.fetch(new Request("http://localhost/terminal"));
	assertEq(response.status, 404, "GET /terminal returns 404");
}

console.log("\n-- /api/terminal/sessions returns manager metadata --");
{
	const fakeSessions: TerminalSessionInfo[] = [
		{
			id: "term-a",
			shell: "bash",
			cwd: "/tmp/project",
			cols: 120,
			rows: 40,
			pid: 4242,
			startedAt: "2026-03-14T00:00:00.000Z",
			lastActivityAt: "2026-03-14T00:00:05.000Z",
		},
	];
	const originalListSessions =
		terminalManager.listSessions.bind(terminalManager);
	terminalManager.listSessions = () => fakeSessions;

	try {
		const response = await app.fetch(
			new Request("http://localhost/api/terminal/sessions"),
		);
		assertEq(response.status, 200, "GET /api/terminal/sessions returns 200");
		const payload = (await response.json()) as TerminalSessionInfo[];
		assertEq(
			payload,
			fakeSessions,
			"terminal sessions payload matches manager output",
		);
	} finally {
		terminalManager.listSessions = originalListSessions;
	}
}

console.log("\n-- terminal vendor assets are served locally --");
{
	const jsResponse = await app.fetch(
		new Request("http://localhost/vendor/ghostty-web.js"),
	);
	assertEq(jsResponse.status, 200, "ghostty-web module asset returns 200");
	assert(
		(jsResponse.headers.get("Content-Type") || "").includes("javascript"),
		"ghostty-web module asset is served as javascript",
	);

	const wasmResponse = await app.fetch(
		new Request("http://localhost/vendor/ghostty-vt.wasm"),
	);
	assertEq(wasmResponse.status, 200, "ghostty wasm asset returns 200");
	assertEq(
		wasmResponse.headers.get("Content-Type"),
		"application/wasm",
		"ghostty wasm asset is served as wasm",
	);
}

console.log("\n-- terminal sessions route surfaces manager failures --");
{
	const originalListSessions =
		terminalManager.listSessions.bind(terminalManager);
	terminalManager.listSessions = () => {
		throw new Error("simulated terminal route failure");
	};

	try {
		const response = await app.fetch(
			new Request("http://localhost/api/terminal/sessions"),
		);
		assertEq(response.status, 500, "route returns 500 on manager error");
		const payload = (await response.json()) as { error?: string };
		assertEq(
			payload.error,
			"simulated terminal route failure",
			"route returns manager failure reason",
		);
	} finally {
		terminalManager.listSessions = originalListSessions;
	}
}

console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
