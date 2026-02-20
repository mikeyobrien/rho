import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { serve } from "@hono/node-server";
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

function wait(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomPort(): number {
	return 36000 + Math.floor(Math.random() * 2000);
}

console.log("\n=== Review Deferred Flow (API + WS) ===\n");

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "review-deferred-flow-"));
process.env.RHO_REVIEW_STORE_PATH = path.join(tmpDir, "reviews.jsonl");

const serverModule = await import("../web/server.ts");
const app = serverModule.default;
const injectWebSocket = serverModule.injectWebSocket;
const disposeServerResources = serverModule.disposeServerResources;

const port = randomPort();
const base = `http://127.0.0.1:${port}`;
const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
injectWebSocket(server);

try {
	const createRes = await fetch(`${base}/api/review/sessions`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			files: [
				{
					path: "/tmp/review-flow.ts",
					relativePath: "tmp/review-flow.ts",
					content: "const answer = 42;\n",
					language: "typescript",
				},
			],
			warnings: [],
			message: "deferred flow smoke",
		}),
	});
	assertEq(createRes.status, 200, "create review session succeeds");
	const created = (await createRes.json()) as {
		id: string;
		token: string;
		url: string;
	};
	assert(!!created.id, "session id returned");
	assert(!!created.token, "session token returned");

	const wsUrl = `ws://127.0.0.1:${port}/review/${created.id}/ws?token=${encodeURIComponent(created.token)}&role=ui`;
	await new Promise<void>((resolve, reject) => {
		const ws = new WebSocket(wsUrl);
		ws.on("open", () => {
			ws.send(
				JSON.stringify({
					type: "submit",
					comments: [
						{
							file: "tmp/review-flow.ts",
							startLine: 1,
							endLine: 1,
							selectedText: "const answer = 42;",
							comment: "extract constant",
						},
					],
				}),
			);
			setTimeout(() => {
				try {
					ws.close();
				} catch {}
				resolve();
			}, 120);
		});
		ws.on("error", reject);
	});

	await wait(80);

	const inboxRes = await fetch(`${base}/api/review/submissions?status=inbox`);
	assertEq(inboxRes.status, 200, "inbox list succeeds");
	const inbox = (await inboxRes.json()) as Array<{
		id: string;
		status: string;
		commentCount: number;
	}>;
	const inboxItem = inbox.find((item) => item.id === created.id);
	assert(!!inboxItem, "submitted review appears in inbox list");
	assertEq(inboxItem?.status, "submitted", "inbox item status is submitted");
	assertEq(inboxItem?.commentCount, 1, "inbox item comment count is 1");

	const detailRes = await fetch(`${base}/api/review/submissions/${created.id}`);
	assertEq(detailRes.status, 200, "submission detail succeeds");
	const detail = (await detailRes.json()) as {
		status: string;
		submission?: { comments?: Array<{ comment: string }> };
	};
	assertEq(detail.status, "submitted", "detail status is submitted");
	assertEq(
		detail.submission?.comments?.[0]?.comment,
		"extract constant",
		"detail includes submitted comment",
	);

	const claimRes = await fetch(
		`${base}/api/review/submissions/${created.id}/claim`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ claimedBy: "flow-agent" }),
		},
	);
	assertEq(claimRes.status, 200, "claim succeeds");
	const claim = (await claimRes.json()) as {
		status: string;
		claimedBy: string;
	};
	assertEq(claim.status, "claimed", "claim status is claimed");
	assertEq(claim.claimedBy, "flow-agent", "claim stores actor");

	const resolveRes = await fetch(
		`${base}/api/review/submissions/${created.id}/resolve`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ resolvedBy: "flow-agent" }),
		},
	);
	assertEq(resolveRes.status, 200, "resolve succeeds");
	const resolved = (await resolveRes.json()) as {
		status: string;
		resolvedBy: string;
	};
	assertEq(resolved.status, "resolved", "resolve status is resolved");
	assertEq(resolved.resolvedBy, "flow-agent", "resolve stores actor");

	const inboxAfterResolveRes = await fetch(
		`${base}/api/review/submissions?status=inbox`,
	);
	assertEq(inboxAfterResolveRes.status, 200, "inbox after resolve succeeds");
	const inboxAfterResolve = (await inboxAfterResolveRes.json()) as Array<{
		id: string;
	}>;
	assert(
		!inboxAfterResolve.some((entry) => entry.id === created.id),
		"resolved review no longer appears in inbox",
	);
} finally {
	server.close();
	disposeServerResources();
}

console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
