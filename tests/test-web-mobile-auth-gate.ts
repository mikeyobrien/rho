import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	SESSION_COOKIE_NAME,
	activeSessions,
} from "../web/server-mobile-auth-state.ts";
import app from "../web/server.ts";

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

console.log("\n=== Web Mobile Auth Gate Tests ===\n");

const RAW_TOKEN = "my-secret-token";
const TOKEN_HASH = crypto.createHash("sha256").update(RAW_TOKEN).digest("hex");

// Create temporary rho home with init.toml
const tempRhoHome = fs.mkdtempSync(path.join(os.tmpdir(), "rho-test-gate-"));
process.env.RHO_HOME = tempRhoHome;

function writeConfig(enabled: boolean) {
	const tomlContent = `
[settings.web]
auth_enabled = ${enabled}
auth_token_hashes = ["${TOKEN_HASH}"]
auth_session_ttl_seconds = 900
	`;
	fs.writeFileSync(path.join(tempRhoHome, "init.toml"), tomlContent);
}

const delay = (ms: number) => new Promise((res) => setTimeout(res, ms));

async function runTests() {
	// 1. Behavior when auth is DISABLED
	console.log("\n-- Mode: Auth Disabled --");
	writeConfig(false);

	{
		// Should allow /api/health
		const res = await app.fetch(new Request("http://localhost/api/health"));
		assertEq(res.status, 200, "/api/health allowed");

		// Should allow arbitrary API
		const res2 = await app.fetch(new Request("http://localhost/api/config"));
		assertEq(res2.status, 200, "/api/config allowed");

		const resUsage = await app.fetch(
			new Request("http://localhost/api/provider-usage"),
		);
		assertEq(resUsage.status, 200, "/api/provider-usage allowed");

		// Should allow WS connection attempt (might be 404 or 426 depending on node env, but not 401)
		const res3 = await app.fetch(new Request("http://localhost/ws"));
		assert(res3.status !== 401, "/ws is not blocked by auth");
	}

	// 2. Behavior when auth is ENABLED
	console.log("\n-- Mode: Auth Enabled --");
	writeConfig(true);

	let cookieStr = "";
	{
		// Exchange to get a valid session
		const response = await app.fetch(
			new Request("http://localhost/api/auth/exchange", {
				method: "POST",
				headers: { Authorization: `Bearer ${RAW_TOKEN}` },
			}),
		);
		assertEq(response.status, 200, "Got session token");
		cookieStr = response.headers.get("Set-Cookie") || "";
		const sessionId = cookieStr.split(";")[0].split("=")[1];
		assert(!!sessionId, "Session ID extracted");
	}

	const validAuthHeader = { Cookie: cookieStr };

	console.log("\n-- Route-level tests --");
	{
		// Exempt endpoints
		const res = await app.fetch(new Request("http://localhost/api/health"));
		assertEq(res.status, 200, "/api/health is exempt");

		const resStatus = await app.fetch(
			new Request("http://localhost/api/auth/status"),
		);
		assertEq(resStatus.status, 200, "/api/auth/status is exempt");

		// Protected API without auth
		const resNoAuth = await app.fetch(
			new Request("http://localhost/api/config"),
		);
		assertEq(resNoAuth.status, 401, "Protected API blocked without auth");

		const resUsageNoAuth = await app.fetch(
			new Request("http://localhost/api/provider-usage"),
		);
		assertEq(
			resUsageNoAuth.status,
			401,
			"Protected provider usage blocked without auth",
		);

		// Protected API with invalid auth
		const resInvalid = await app.fetch(
			new Request("http://localhost/api/config", {
				headers: { Cookie: `${SESSION_COOKIE_NAME}=bad-id` },
			}),
		);
		assertEq(resInvalid.status, 401, "Protected API blocked with invalid auth");

		// Protected API with valid auth
		const resValid = await app.fetch(
			new Request("http://localhost/api/config", {
				headers: validAuthHeader,
			}),
		);
		assertEq(resValid.status, 200, "Protected API allowed with valid auth");
		const configPayload = await resValid.json();
		assert(
			typeof configPayload.version === "string" &&
				configPayload.version.length > 0,
			"/api/config returns rho version",
		);

		const resUsageValid = await app.fetch(
			new Request("http://localhost/api/provider-usage", {
				headers: validAuthHeader,
			}),
		);
		assertEq(
			resUsageValid.status,
			200,
			"Protected provider usage allowed with valid auth",
		);
	}

	console.log("\n-- WS handshake tests --");
	{
		// Blocked without auth
		const resWsBlocked = await app.fetch(new Request("http://localhost/ws"));
		assertEq(resWsBlocked.status, 401, "/ws blocked without auth");

		const resTerminalWsBlocked = await app.fetch(
			new Request("http://localhost/terminal/ws"),
		);
		assertEq(
			resTerminalWsBlocked.status,
			401,
			"/terminal/ws blocked without auth",
		);

		// Allowed with auth
		const resWsAllowed = await app.fetch(
			new Request("http://localhost/ws", {
				headers: validAuthHeader,
			}),
		);
		assert(resWsAllowed.status !== 401, "/ws allowed with valid auth");

		const resTerminalWsAllowed = await app.fetch(
			new Request("http://localhost/terminal/ws", {
				headers: validAuthHeader,
			}),
		);
		assert(
			resTerminalWsAllowed.status !== 401,
			"/terminal/ws allowed with valid auth",
		);
	}

	console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===\n`);

	fs.rmSync(tempRhoHome, { recursive: true, force: true });
	process.exit(FAIL > 0 ? 1 : 0);
}

runTests().catch((err) => {
	console.error(err);
	fs.rmSync(tempRhoHome, { recursive: true, force: true });
	process.exit(1);
});
