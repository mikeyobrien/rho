import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { activeSessions, SESSION_COOKIE_NAME } from "../web/server-mobile-auth-state.ts";
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

console.log("\n=== Web Mobile Auth API Tests ===\n");

const RAW_TOKEN = "my-secret-token";
const TOKEN_HASH = crypto.createHash("sha256").update(RAW_TOKEN).digest("hex");
const RAW_TOKEN_2 = "my-secret-token-2";
const TOKEN_HASH_2 = crypto.createHash("sha256").update(RAW_TOKEN_2).digest("hex");

// Create temporary rho home with init.toml
const tempRhoHome = fs.mkdtempSync(path.join(os.tmpdir(), "rho-test-"));
process.env.RHO_HOME = tempRhoHome;

function writeConfig(enabled: boolean, ttl: number = 900) {
    const tomlContent = `
[settings.web]
auth_enabled = ${enabled}
auth_token_hashes = ["${TOKEN_HASH}", "${TOKEN_HASH_2}"]
auth_session_ttl_seconds = ${ttl}
    `;
    fs.writeFileSync(path.join(tempRhoHome, "init.toml"), tomlContent);
}

writeConfig(true);

const delay = (ms: number) => new Promise(res => setTimeout(res, ms));

async function runTests() {
	console.log("-- /api/auth/exchange fails without token --");
	{
		const response = await app.fetch(
			new Request("http://localhost/api/auth/exchange", { method: "POST" })
		);
		assertEq(response.status, 401, "POST returns 401");
	}

	console.log("\n-- /api/auth CORS preflight for Capacitor shell origin --");
	{
		const preflight = await app.fetch(
			new Request("http://localhost/api/auth/exchange", {
				method: "OPTIONS",
				headers: {
					Origin: "http://localhost",
					"Access-Control-Request-Method": "POST",
					"Access-Control-Request-Headers": "Authorization"
				}
			})
		);
		assertEq(preflight.status, 204, "OPTIONS preflight returns 204");
		assertEq(
			preflight.headers.get("Access-Control-Allow-Origin"),
			"http://localhost",
			"Preflight allow-origin echoes mobile shell origin"
		);
		assertEq(
			preflight.headers.get("Access-Control-Allow-Credentials"),
			"true",
			"Preflight allows credentials"
		);
	}

	console.log("\n-- /api/auth/exchange fails with invalid token --");
	{
		const response = await app.fetch(
			new Request("http://localhost/api/auth/exchange", { 
				method: "POST",
				headers: { "Authorization": "Bearer wrong-token" }
			})
		);
		assertEq(response.status, 401, "POST returns 401 for invalid token");
	}

	let cookieStr = "";
	let bootstrapToken = "";

	console.log("\n-- /api/auth/exchange succeeds with valid token --");
	{
		const response = await app.fetch(
			new Request("http://localhost/api/auth/exchange", {
				method: "POST",
				headers: {
					"Authorization": `Bearer ${RAW_TOKEN}`,
					"Origin": "http://localhost"
				}
			})
		);
		assertEq(response.status, 200, "POST returns 200 for valid token");
		assertEq(
			response.headers.get("Access-Control-Allow-Origin"),
			"http://localhost",
			"Exchange response includes allow-origin for shell"
		);
		const exchangeBody = await response.json() as any;
		assert(typeof exchangeBody?.bootstrapToken === "string", "Exchange returns bootstrapToken");
		if (typeof exchangeBody?.bootstrapToken === "string") {
			bootstrapToken = exchangeBody.bootstrapToken;
		}
		
		const setCookieHeader = response.headers.get("Set-Cookie");
		assert(setCookieHeader !== null, "Set-Cookie header is present");
		if (setCookieHeader) {
			cookieStr = setCookieHeader;
			assert(setCookieHeader.includes(`${SESSION_COOKIE_NAME}=`), "Cookie has correct name");
			assert(setCookieHeader.includes("HttpOnly"), "Cookie is HttpOnly");
			assert(!setCookieHeader.includes("Secure"), "Cookie is not Secure for localhost HTTP");
			assert(setCookieHeader.includes("SameSite=Lax"), "Cookie is SameSite=Lax");
			assert(setCookieHeader.includes("Path=/"), "Cookie is Path=/");
			assert(setCookieHeader.includes("Max-Age=900"), "Cookie has expected Max-Age");
		}
	}

	console.log("\n-- /?auth_bootstrap sets first-party cookie and redirects --");
	{
		const response = await app.fetch(
			new Request(`http://localhost/?auth_bootstrap=${bootstrapToken}`)
		);
		assertEq(response.status, 302, "Bootstrap redirect returns 302");
		assertEq(response.headers.get("Location"), "/", "Bootstrap redirects to root");
		const setCookieHeader = response.headers.get("Set-Cookie");
		assert(setCookieHeader !== null, "Bootstrap sets session cookie");
	}

	console.log("\n-- /api/auth/exchange succeeds with second valid token --");
	{
		const response = await app.fetch(
			new Request("http://localhost/api/auth/exchange", { 
				method: "POST",
				headers: { "Authorization": `Bearer ${RAW_TOKEN_2}` }
			})
		);
		assertEq(response.status, 200, "POST returns 200 for second valid token");
	}

	console.log("\n-- /api/auth/status checks valid session --");
	{
		const sessionId = cookieStr.split(";")[0].split("=")[1];
		const response = await app.fetch(
			new Request("http://localhost/api/auth/status", {
				headers: { "Cookie": `${SESSION_COOKIE_NAME}=${sessionId}` }
			})
		);
		assertEq(response.status, 200, "GET returns 200");
		const body = await response.json() as any;
		assertEq(body.enabled, true, "Auth is enabled");
		assertEq(body.active, true, "Session is active");
	}

	console.log("\n-- /api/auth/status checks invalid session --");
	{
		const response = await app.fetch(
			new Request("http://localhost/api/auth/status", {
				headers: { "Cookie": `${SESSION_COOKIE_NAME}=invalid-session` }
			})
		);
		assertEq(response.status, 200, "GET returns 200");
		const body = await response.json() as any;
		assertEq(body.enabled, true, "Auth is enabled");
		assertEq(body.active, false, "Session is not active");
		assertEq(body.reason, "revoked", "Reason is revoked for missing session");
	}

	console.log("\n-- /api/auth/logout revokes session --");
	{
		const sessionId = cookieStr.split(";")[0].split("=")[1];
		const response = await app.fetch(
			new Request("http://localhost/api/auth/logout", {
				method: "POST",
				headers: { "Cookie": `${SESSION_COOKIE_NAME}=${sessionId}` }
			})
		);
		assertEq(response.status, 200, "POST returns 200");
		
		const setCookieHeader = response.headers.get("Set-Cookie");
		assert(setCookieHeader !== null, "Set-Cookie header is present on logout");
		
		// Ensure it was actually deleted from activeSessions
		assert(!activeSessions.has(sessionId), "Session ID removed from active sessions");
		
		const statusResponse = await app.fetch(
			new Request("http://localhost/api/auth/status", {
				headers: { "Cookie": `${SESSION_COOKIE_NAME}=${sessionId}` }
			})
		);
		const body = await statusResponse.json() as any;
		assertEq(body.active, false, "Session is no longer active");
		assertEq(body.reason, "revoked", "Reason is revoked");
	}

	console.log("\n-- Expired session scenario --");
	{
		writeConfig(true, 1); // 1 second TTL
		const response = await app.fetch(
			new Request("http://localhost/api/auth/exchange", { 
				method: "POST",
				headers: { "Authorization": `Bearer ${RAW_TOKEN}` }
			})
		);
		const cookieHeader = response.headers.get("Set-Cookie");
		const sessionId = cookieHeader!.split(";")[0].split("=")[1];

		// Wait 1.1s
		await delay(1100);

		const statusResponse = await app.fetch(
			new Request("http://localhost/api/auth/status", {
				headers: { "Cookie": `${SESSION_COOKIE_NAME}=${sessionId}` }
			})
		);
		const body = await statusResponse.json() as any;
		assertEq(body.active, false, "Session expired server-side");
		assertEq(body.reason, "expired", "Reason is expired");
	}

	console.log("\n-- Optional: disabled behavior --");
	{
		writeConfig(false);
		const response = await app.fetch(
			new Request("http://localhost/api/auth/exchange", { method: "POST" })
		);
		assertEq(response.status, 403, "POST returns 403 when disabled");
		
		const statusResponse = await app.fetch(
			new Request("http://localhost/api/auth/status")
		);
		const body = await statusResponse.json() as any;
		assertEq(body.enabled, false, "Status reports disabled");
	}

	console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===\n`);
	
	// Cleanup
	fs.rmSync(tempRhoHome, { recursive: true, force: true });
	
	process.exit(FAIL > 0 ? 1 : 0);
}

runTests().catch(err => {
	console.error(err);
	fs.rmSync(tempRhoHome, { recursive: true, force: true });
	process.exit(1);
});