/**
 * Mobile Parity Smoke Tests — Step 9
 *
 * Validates that all major rho-web routes behave correctly under mobile auth,
 * providing a traceable pass/fail parity matrix for the Capacitor native app.
 *
 * Sections:
 *   0. Auth gate (unauthenticated rejection)
 *   1. Auth exchange flow (valid / invalid / missing)
 *   2. Sessions/new/fork parity
 *   3. WS handshake parity
 *   4. Tasks / memory / config parity
 *   5. Review flows parity
 *   6. Session lifecycle (status, logout, post-logout rejection)
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { activeSessions, SESSION_COOKIE_NAME } from "../web/server-mobile-auth-state.ts";
import app from "../web/server.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let PASS = 0;
let FAIL = 0;
const results: { label: string; pass: boolean }[] = [];

function assert(condition: boolean, label: string): void {
	results.push({ label, pass: condition });
	if (condition) {
		console.log(`  PASS  ${label}`);
		PASS++;
	} else {
		console.error(`  FAIL  ${label}`);
		FAIL++;
	}
}

function assertEq(actual: unknown, expected: unknown, label: string): void {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	results.push({ label, pass: ok });
	if (ok) {
		console.log(`  PASS  ${label}`);
		PASS++;
	} else {
		console.error(`  FAIL  ${label}  (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
		FAIL++;
	}
}

function section(title: string): void {
	console.log(`\n-- ${title} --`);
}

// ---------------------------------------------------------------------------
// Environment setup
// ---------------------------------------------------------------------------

const RAW_TOKEN = "parity-secret-token";
const TOKEN_HASH = crypto.createHash("sha256").update(RAW_TOKEN).digest("hex");

const tempRhoHome = fs.mkdtempSync(path.join(os.tmpdir(), "rho-parity-test-"));
process.env.RHO_HOME = tempRhoHome;

fs.writeFileSync(
	path.join(tempRhoHome, "init.toml"),
	[
		"[settings.web]",
		"auth_enabled = true",
		`auth_token_hashes = ["${TOKEN_HASH}"]`,
		"auth_session_ttl_seconds = 900",
	].join("\n"),
);

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

async function runTests(): Promise<void> {
	console.log("\n=== Mobile Parity Smoke Tests ===\n");

	// -------------------------------------------------------------------------
	// Section 0 — Auth gate: unauthenticated requests must be rejected
	// -------------------------------------------------------------------------
	section("0 · Auth gate — unauthenticated rejection");

	const protectedRoutes: [string, RequestInit?][] = [
		["/api/sessions"],
		["/api/config"],
		["/api/tasks"],
		["/api/memory"],
		["/api/review/sessions"],
		["/api/review/submissions"],
		["/api/sessions/new", { method: "POST", headers: { "Content-Type": "application/json" } }],
	];

	for (const [route, init] of protectedRoutes) {
		const res = await app.fetch(new Request(`http://localhost${route}`, init));
		assertEq(res.status, 401, `${init?.method ?? "GET"} ${route} rejected without auth`);
	}

	// Public endpoints must remain accessible without auth
	const healthRes = await app.fetch(new Request("http://localhost/api/health"));
	assertEq(healthRes.status, 200, "GET /api/health accessible without auth");

	const authStatusRes = await app.fetch(new Request("http://localhost/api/auth/status"));
	assertEq(authStatusRes.status, 200, "GET /api/auth/status accessible without auth");

	// -------------------------------------------------------------------------
	// Section 1 — Auth exchange flow
	// -------------------------------------------------------------------------
	section("1 · Auth exchange — valid / invalid / missing");

	const missingAuthRes = await app.fetch(
		new Request("http://localhost/api/auth/exchange", { method: "POST" }),
	);
	assertEq(missingAuthRes.status, 401, "Exchange: missing Authorization header → 401");

	const badTokenRes = await app.fetch(
		new Request("http://localhost/api/auth/exchange", {
			method: "POST",
			headers: { Authorization: "Bearer wrong-token" },
		}),
	);
	assertEq(badTokenRes.status, 401, "Exchange: invalid token → 401");

	const authRes = await app.fetch(
		new Request("http://localhost/api/auth/exchange", {
			method: "POST",
			headers: { Authorization: `Bearer ${RAW_TOKEN}` },
		}),
	);
	assertEq(authRes.status, 200, "Exchange: valid token → 200");

	const cookieStr = authRes.headers.get("Set-Cookie") ?? "";
	assert(cookieStr.includes(SESSION_COOKIE_NAME), "Exchange: session cookie issued");
	assert(cookieStr.includes("HttpOnly"), "Exchange: cookie is HttpOnly");

	// Extract cookie for subsequent requests
	const authHeaders = { Cookie: cookieStr };
	const authHeadersJson = { Cookie: cookieStr, "Content-Type": "application/json" };

	// -------------------------------------------------------------------------
	// Section 2 — Sessions / new / fork parity
	// -------------------------------------------------------------------------
	section("2 · Sessions/new/fork parity");

	const sessionsRes = await app.fetch(
		new Request("http://localhost/api/sessions", { headers: authHeaders }),
	);
	assertEq(sessionsRes.status, 200, "GET /api/sessions with auth → 200");

	const newSessionRes = await app.fetch(
		new Request("http://localhost/api/sessions/new", {
			method: "POST",
			headers: authHeadersJson,
		}),
	);
	assertEq(newSessionRes.status, 200, "POST /api/sessions/new with auth → 200");

	if (newSessionRes.status === 200) {
		const body = (await newSessionRes.json()) as { sessionId?: string };
		assert(typeof body.sessionId === "string" && body.sessionId.length > 0, "New session has sessionId");

		// Fork on a brand-new empty session has no fork points → 400.
		// The important invariant is that auth passes (not 401/403).
		const forkRes = await app.fetch(
			new Request(`http://localhost/api/sessions/${body.sessionId}/fork`, {
				method: "POST",
				headers: authHeadersJson,
			}),
		);
		assert(
			forkRes.status !== 401 && forkRes.status !== 403,
			`POST /api/sessions/${body.sessionId}/fork — auth gate passes (status ${forkRes.status})`,
		);
	} else {
		assert(false, "POST /api/sessions/:id/fork — skipped (new session failed)");
	}

	// -------------------------------------------------------------------------
	// Section 3 — WS handshake parity
	// -------------------------------------------------------------------------
	section("3 · WS handshake parity");

	// app.fetch cannot perform a real WS upgrade in this unit context, so this
	// validates auth-gate behavior on the /ws route without upgrade headers.
	const wsNoAuthRes = await app.fetch(new Request("http://localhost/ws"));
	assertEq(wsNoAuthRes.status, 401, "WS route without auth → 401");

	const wsAuthRes = await app.fetch(
		new Request("http://localhost/ws", {
			headers: authHeaders,
		}),
	);
	assert(
		wsAuthRes.status !== 401 && wsAuthRes.status !== 403,
		"WS route with auth — not rejected by auth gate",
	);

	// -------------------------------------------------------------------------
	// Section 4 — Tasks / memory / config parity
	// -------------------------------------------------------------------------
	section("4 · Tasks/memory/config parity");

	const configRes = await app.fetch(
		new Request("http://localhost/api/config", { headers: authHeaders }),
	);
	assertEq(configRes.status, 200, "GET /api/config with auth → 200");

	const tasksRes = await app.fetch(
		new Request("http://localhost/api/tasks", { headers: authHeaders }),
	);
	assertEq(tasksRes.status, 200, "GET /api/tasks with auth → 200");

	const memoryRes = await app.fetch(
		new Request("http://localhost/api/memory", { headers: authHeaders }),
	);
	assertEq(memoryRes.status, 200, "GET /api/memory with auth → 200");

	// -------------------------------------------------------------------------
	// Section 5 — Review flows parity
	// -------------------------------------------------------------------------
	section("5 · Review flows parity");

	const reviewSessionsRes = await app.fetch(
		new Request("http://localhost/api/review/sessions", { headers: authHeaders }),
	);
	assertEq(reviewSessionsRes.status, 200, "GET /api/review/sessions with auth → 200");

	const reviewSubmissionsRes = await app.fetch(
		new Request("http://localhost/api/review/submissions", { headers: authHeaders }),
	);
	assertEq(reviewSubmissionsRes.status, 200, "GET /api/review/submissions with auth → 200");

	// Create a review session and verify submission lookup
	const createReviewRes = await app.fetch(
		new Request("http://localhost/api/review/sessions", {
			method: "POST",
			headers: authHeadersJson,
			body: JSON.stringify({ files: ["/tmp/fake.ts"], message: "parity test" }),
		}),
	);
	assertEq(createReviewRes.status, 200, "POST /api/review/sessions with auth → 200");

	if (createReviewRes.status === 200) {
		const reviewBody = (await createReviewRes.json()) as { id?: string };
		assert(typeof reviewBody.id === "string", "Review session created with id");
	} else {
		assert(false, "Review session creation — skipped (create failed)");
	}

	// -------------------------------------------------------------------------
	// Section 6 — Session lifecycle: status, logout, post-logout rejection
	// -------------------------------------------------------------------------
	section("6 · Session lifecycle — status / logout / post-logout");

	const statusActiveRes = await app.fetch(
		new Request("http://localhost/api/auth/status", { headers: authHeaders }),
	);
	assertEq(statusActiveRes.status, 200, "GET /api/auth/status with valid session → 200");
	if (statusActiveRes.status === 200) {
		const statusBody = (await statusActiveRes.json()) as { active?: boolean };
		assert(statusBody.active === true, "Auth status reports active=true");
	}

	const logoutRes = await app.fetch(
		new Request("http://localhost/api/auth/logout", {
			method: "POST",
			headers: authHeaders,
		}),
	);
	assertEq(logoutRes.status, 200, "POST /api/auth/logout → 200");

	// After logout the session should be invalidated
	const postLogoutRes = await app.fetch(
		new Request("http://localhost/api/sessions", { headers: authHeaders }),
	);
	assertEq(postLogoutRes.status, 401, "GET /api/sessions after logout → 401");

	// Expired session should be rejected
	const expiredId = "expired-session-id";
	activeSessions.set(expiredId, { expiresAt: Date.now() - 1000 });
	const expiredHeaders = { Cookie: `${SESSION_COOKIE_NAME}=${expiredId}` };
	const expiredRes = await app.fetch(
		new Request("http://localhost/api/sessions", { headers: expiredHeaders }),
	);
	assertEq(expiredRes.status, 401, "GET /api/sessions with expired session → 401");

	// -------------------------------------------------------------------------
	// Summary
	// -------------------------------------------------------------------------
	console.log(`\n=== Parity Results: ${PASS} passed, ${FAIL} failed ===\n`);

	if (FAIL > 0) {
		console.error("FAILED checks:");
		for (const r of results.filter((r) => !r.pass)) {
			console.error(`  - ${r.label}`);
		}
	}
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

runTests()
	.catch((err: unknown) => {
		console.error("Unexpected error:", err);
		FAIL++;
	})
	.finally(() => {
		fs.rmSync(tempRhoHome, { recursive: true, force: true });
		process.exit(FAIL > 0 ? 1 : 0);
	});
