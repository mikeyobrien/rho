import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { RpcLiveModeLeaseRegistry, rpcLiveModeLeases } from "../web/rpc-live-mode-lease.ts";
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

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (predicate()) {
			return true;
		}
		await sleep(10);
	}
	return false;
}

console.log("\n=== Web RPC Live Mode Lease Tests ===\n");

console.log("-- lease registry parsing + TTL clamping --");
{
	let now = 1_000;
	const registry = new RpcLiveModeLeaseRegistry(() => now);

	assertEq(registry.upsert("", 60_000), null, "empty rpcSessionId rejected");

	const minLease = registry.upsert("rpc-a", -1);
	assert(Boolean(minLease), "lease created for rpc-a");
	assertEq(minLease?.ttlMs, 30_000, "negative ttl clamps to minimum 30000ms");

	const clampedLow = registry.upsert("rpc-b", 1000);
	assertEq(clampedLow?.ttlMs, 30_000, "ttl clamps to minimum 30000ms");

	const clampedHigh = registry.upsert("rpc-c", 99 * 60_000);
	assertEq(clampedHigh?.ttlMs, 30 * 60_000, "ttl clamps to maximum 1800000ms");

	assert(registry.hasActive("rpc-b"), "rpc-b lease is active");
	now += 31_000;
	assert(!registry.hasActive("rpc-b"), "rpc-b lease expires after ttl window");
}

console.log("\n-- orphan scheduling is deferred while live lease is active --");
{
	let aborted = false;
	let stopped = false;
	let leaseActive = true;

	const reliability = new RpcSessionReliability({
		orphanGraceMs: 40,
		orphanAbortDelayMs: 20,
		hasSubscribers: () => false,
		hasLiveLease: () => leaseActive,
		liveLeaseRemainingMs: () => 300,
		onAbort: () => {
			aborted = true;
		},
		onStop: () => {
			stopped = true;
		},
	});

	reliability.scheduleOrphan("rpc-live-1");
	await sleep(150);
	assert(!aborted, "orphan abort suppressed while lease is active");
	assert(!stopped, "orphan hard-stop suppressed while lease is active");

	leaseActive = false;
	const abortedAfterLease = await waitFor(() => aborted, 400);
	const stoppedAfterLease = await waitFor(() => stopped, 400);
	assert(abortedAfterLease, "orphan abort fires after lease is removed");
	assert(stoppedAfterLease, "orphan hard-stop fires after lease is removed");

	reliability.dispose();
}

console.log("\n-- /api/mobile/live-mode/lease routes (auth-protected) --");
{
	const rawToken = "lease-route-token";
	const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");

	const tempRhoHome = fs.mkdtempSync(path.join(os.tmpdir(), "rho-lease-route-test-"));
	process.env.RHO_HOME = tempRhoHome;
	fs.writeFileSync(
		path.join(tempRhoHome, "init.toml"),
		[
			"[settings.web]",
			"auth_enabled = true",
			`auth_token_hashes = [\"${tokenHash}\"]`,
			"auth_session_ttl_seconds = 900",
		].join("\n"),
	);

	const serverModule = await import("../web/server.ts");
	const rpcModule = await import("../web/rpc-manager.ts");
	const app = serverModule.default;
	const rpcManager = rpcModule.rpcManager as any;

	rpcLiveModeLeases.clearAll();
	const originalGetActiveSessions = rpcManager.getActiveSessions.bind(rpcManager);
	rpcManager.getActiveSessions = () => [
		{
			id: "rpc-live-lease-1",
			sessionFile: "/tmp/lease-test.jsonl",
			cwd: process.cwd(),
			startedAt: new Date().toISOString(),
			lastActivityAt: new Date().toISOString(),
			pid: 1234,
		},
	];

	try {
		const unauthLease = await app.fetch(
			new Request("http://localhost/api/mobile/live-mode/lease", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ rpcSessionId: "rpc-live-lease-1" }),
			}),
		);
		assertEq(unauthLease.status, 401, "lease route is auth-protected");

		const exchange = await app.fetch(
			new Request("http://localhost/api/auth/exchange", {
				method: "POST",
				headers: { Authorization: `Bearer ${rawToken}` },
			}),
		);
		assertEq(exchange.status, 200, "auth exchange succeeds for lease route test");
		const cookie = exchange.headers.get("Set-Cookie") ?? "";
		assert(cookie.includes("rho_mobile_session"), "auth exchange returns session cookie");

		const createLease = await app.fetch(
			new Request("http://localhost/api/mobile/live-mode/lease", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Cookie: cookie,
				},
				body: JSON.stringify({ rpcSessionId: "rpc-live-lease-1", ttlMs: 120_000 }),
			}),
		);
		assertEq(createLease.status, 200, "lease create route returns 200 with auth");
		assert(
			rpcLiveModeLeases.hasActive("rpc-live-lease-1"),
			"lease registry contains active lease after route call",
		);

		const clearLease = await app.fetch(
			new Request("http://localhost/api/mobile/live-mode/lease/clear", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Cookie: cookie,
				},
				body: JSON.stringify({ rpcSessionId: "rpc-live-lease-1" }),
			}),
		);
		assertEq(clearLease.status, 200, "lease clear route returns 200 with auth");
		assert(
			!rpcLiveModeLeases.hasActive("rpc-live-lease-1"),
			"lease registry is cleared after clear route call",
		);
	} finally {
		rpcManager.getActiveSessions = originalGetActiveSessions;
		rpcLiveModeLeases.clearAll();
		fs.rmSync(tempRhoHome, { recursive: true, force: true });
	}
}

console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
