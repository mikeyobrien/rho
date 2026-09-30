/**
 * Tests for orphan policy config: parsing, env precedence, clamping, and behavior.
 * Run: npx tsx tests/test-web-rpc-orphan-config.ts
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { getRpcReliabilityConfig } from "../web/config.ts";
import { RpcSessionReliability } from "../web/rpc-reliability.ts";

let PASS = 0;
let FAIL = 0;

function assert(condition: boolean, label: string): void {
	if (condition) {
		console.log(`  PASS: ${label}`);
		PASS++;
	} else {
		console.error(`  FAIL: ${label}`);
		FAIL++;
	}
}

function assertEq(actual: unknown, expected: unknown, label: string): void {
	const ok = Object.is(actual, expected);
	if (ok) {
		console.log(`  PASS: ${label}`);
		PASS++;
	} else {
		console.error(
			`  FAIL: ${label} (expected ${String(expected)}, got ${String(actual)})`,
		);
		FAIL++;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeTempToml(content: string): string {
	const dir = mkdtempSync(path.join(tmpdir(), "rho-orphan-config-test-"));
	const filePath = path.join(dir, "init.toml");
	writeFileSync(filePath, content, "utf-8");
	return filePath;
}

// ── Config parsing ────────────────────────────────────────────────────────────

console.log("\n=== getRpcReliabilityConfig: parsing ===\n");

console.log("-- defaults when config has no [settings.web] --");
{
	const toml = `
[agent]
name = "test"
[modules.core]
heartbeat = true
memory = true
`;
	const p = makeTempToml(toml);
	const cfg = getRpcReliabilityConfig(p);
	assertEq(cfg.orphanGraceMs, 60_000, "default orphanGraceMs = 60000");
	assertEq(cfg.orphanAbortDelayMs, 5_000, "default orphanAbortDelayMs = 5000");
}

console.log("\n-- config values are honored --");
{
	const toml = `
[agent]
name = "test"
[modules.core]
heartbeat = true
memory = true
[settings.web]
rpc_orphan_grace_ms = 300000
rpc_orphan_abort_delay_ms = 30000
`;
	const p = makeTempToml(toml);
	const cfg = getRpcReliabilityConfig(p);
	assertEq(cfg.orphanGraceMs, 300_000, "config orphanGraceMs = 300000");
	assertEq(cfg.orphanAbortDelayMs, 30_000, "config orphanAbortDelayMs = 30000");
}

console.log("\n-- abort-delay of 0 is valid (immediate hard-stop) --");
{
	const toml = `
[agent]
name = "test"
[modules.core]
heartbeat = true
memory = true
[settings.web]
rpc_orphan_grace_ms = 120000
rpc_orphan_abort_delay_ms = 0
`;
	const p = makeTempToml(toml);
	const cfg = getRpcReliabilityConfig(p);
	assertEq(cfg.orphanGraceMs, 120_000, "config orphanGraceMs = 120000");
	assertEq(cfg.orphanAbortDelayMs, 0, "abort-delay = 0 is valid");
}

console.log("\n-- malformed: non-numeric grace falls back to default --");
{
	const toml = `
[agent]
name = "test"
[modules.core]
heartbeat = true
memory = true
[settings.web]
rpc_orphan_grace_ms = "not-a-number"
rpc_orphan_abort_delay_ms = "also-bad"
`;
	const p = makeTempToml(toml);
	const cfg = getRpcReliabilityConfig(p);
	assertEq(cfg.orphanGraceMs, 60_000, "malformed grace string → default 60000");
	assertEq(
		cfg.orphanAbortDelayMs,
		5_000,
		"malformed abort-delay string → default 5000",
	);
}

console.log("\n-- malformed: negative grace clamped to 1000ms minimum --");
{
	const toml = `
[agent]
name = "test"
[modules.core]
heartbeat = true
memory = true
[settings.web]
rpc_orphan_grace_ms = -500
rpc_orphan_abort_delay_ms = -10
`;
	const p = makeTempToml(toml);
	const cfg = getRpcReliabilityConfig(p);
	assertEq(cfg.orphanGraceMs, 1_000, "negative grace clamped to min 1000");
	assertEq(cfg.orphanAbortDelayMs, 0, "negative abort-delay clamped to min 0");
}

console.log("\n-- malformed: float is floored --");
{
	const toml = `
[agent]
name = "test"
[modules.core]
heartbeat = true
memory = true
[settings.web]
rpc_orphan_grace_ms = 90000.9
rpc_orphan_abort_delay_ms = 8000.7
`;
	const p = makeTempToml(toml);
	const cfg = getRpcReliabilityConfig(p);
	assertEq(cfg.orphanGraceMs, 90_000, "float grace floored to 90000");
	assertEq(cfg.orphanAbortDelayMs, 8_000, "float abort-delay floored to 8000");
}

console.log("\n-- file not found: falls back to defaults without crash --");
{
	const cfg = getRpcReliabilityConfig("/tmp/nonexistent-rho-config-xyz.toml");
	assertEq(cfg.orphanGraceMs, 60_000, "missing file → default orphanGraceMs");
	assertEq(
		cfg.orphanAbortDelayMs,
		5_000,
		"missing file → default orphanAbortDelayMs",
	);
}

// ── Env override precedence ───────────────────────────────────────────────────

console.log("\n=== Env override precedence ===\n");

/**
 * Replicate the precedence logic from server-core.ts for testability:
 * env var → config → default (env wins).
 */
function readNumericEnv(name: string, fallback: number): number {
	const raw = process.env[name];
	if (!raw) return fallback;
	const parsed = Number(raw);
	return Number.isFinite(parsed) ? parsed : fallback;
}

console.log("-- env overrides config value --");
{
	const toml = `
[agent]
name = "test"
[modules.core]
heartbeat = true
memory = true
[settings.web]
rpc_orphan_grace_ms = 300000
rpc_orphan_abort_delay_ms = 30000
`;
	const p = makeTempToml(toml);

	const origGrace = process.env.RHO_RPC_ORPHAN_GRACE_MS;
	const origAbort = process.env.RHO_RPC_ORPHAN_ABORT_DELAY_MS;

	process.env.RHO_RPC_ORPHAN_GRACE_MS = "999";
	process.env.RHO_RPC_ORPHAN_ABORT_DELAY_MS = "888";

	const cfg = getRpcReliabilityConfig(p);
	const effectiveGrace = readNumericEnv(
		"RHO_RPC_ORPHAN_GRACE_MS",
		cfg.orphanGraceMs,
	);
	const effectiveAbort = readNumericEnv(
		"RHO_RPC_ORPHAN_ABORT_DELAY_MS",
		cfg.orphanAbortDelayMs,
	);

	assertEq(effectiveGrace, 999, "env RHO_RPC_ORPHAN_GRACE_MS wins over config");
	assertEq(
		effectiveAbort,
		888,
		"env RHO_RPC_ORPHAN_ABORT_DELAY_MS wins over config",
	);

	// Restore env
	if (origGrace === undefined) {
		process.env.RHO_RPC_ORPHAN_GRACE_MS = undefined;
	} else {
		process.env.RHO_RPC_ORPHAN_GRACE_MS = origGrace;
	}
	if (origAbort === undefined) {
		process.env.RHO_RPC_ORPHAN_ABORT_DELAY_MS = undefined;
	} else {
		process.env.RHO_RPC_ORPHAN_ABORT_DELAY_MS = origAbort;
	}
}

console.log("\n-- config used when env is absent --");
{
	const toml = `
[agent]
name = "test"
[modules.core]
heartbeat = true
memory = true
[settings.web]
rpc_orphan_grace_ms = 240000
rpc_orphan_abort_delay_ms = 20000
`;
	const p = makeTempToml(toml);

	const origGrace = process.env.RHO_RPC_ORPHAN_GRACE_MS;
	const origAbort = process.env.RHO_RPC_ORPHAN_ABORT_DELAY_MS;
	process.env.RHO_RPC_ORPHAN_GRACE_MS = undefined;
	process.env.RHO_RPC_ORPHAN_ABORT_DELAY_MS = undefined;

	const cfg = getRpcReliabilityConfig(p);
	const effectiveGrace = readNumericEnv(
		"RHO_RPC_ORPHAN_GRACE_MS",
		cfg.orphanGraceMs,
	);
	const effectiveAbort = readNumericEnv(
		"RHO_RPC_ORPHAN_ABORT_DELAY_MS",
		cfg.orphanAbortDelayMs,
	);

	assertEq(effectiveGrace, 240_000, "config orphanGraceMs used when env absent");
	assertEq(
		effectiveAbort,
		20_000,
		"config orphanAbortDelayMs used when env absent",
	);

	if (origGrace !== undefined) process.env.RHO_RPC_ORPHAN_GRACE_MS = origGrace;
	if (origAbort !== undefined)
		process.env.RHO_RPC_ORPHAN_ABORT_DELAY_MS = origAbort;
}

console.log("\n-- non-numeric env var falls through to config --");
{
	const toml = `
[agent]
name = "test"
[modules.core]
heartbeat = true
memory = true
[settings.web]
rpc_orphan_grace_ms = 180000
`;
	const p = makeTempToml(toml);

	const origGrace = process.env.RHO_RPC_ORPHAN_GRACE_MS;
	process.env.RHO_RPC_ORPHAN_GRACE_MS = "not-a-number";

	const cfg = getRpcReliabilityConfig(p);
	const effectiveGrace = readNumericEnv(
		"RHO_RPC_ORPHAN_GRACE_MS",
		cfg.orphanGraceMs,
	);

	assertEq(
		effectiveGrace,
		180_000,
		"bad env value falls through to config 180000",
	);

	if (origGrace === undefined) {
		process.env.RHO_RPC_ORPHAN_GRACE_MS = undefined;
	} else {
		process.env.RHO_RPC_ORPHAN_GRACE_MS = origGrace;
	}
}

// ── Behavior: orphan timing follows configured values ────────────────────────

console.log("\n=== Behavior: orphan timing ===\n");

console.log("-- lock-tolerant grace (large) defers abort within window --");
{
	let aborted = false;
	let stopped = false;
	const rel = new RpcSessionReliability({
		orphanGraceMs: 10_000, // 10 s — far beyond our test window
		orphanAbortDelayMs: 1_000,
		hasSubscribers: () => false,
		onAbort: () => {
			aborted = true;
		},
		onStop: () => {
			stopped = true;
		},
	});

	rel.scheduleOrphan("lock-test-session");
	await sleep(150); // 150 ms — well within 10 s grace

	assert(!aborted, "session NOT aborted within lock-tolerant grace window");
	assert(!stopped, "session NOT stopped within lock-tolerant grace window");
	rel.dispose();
}

console.log("-- short grace fires abort and stop after window --");
{
	let aborted = false;
	let stopped = false;
	const rel = new RpcSessionReliability({
		orphanGraceMs: 60,
		orphanAbortDelayMs: 30,
		hasSubscribers: () => false,
		onAbort: () => {
			aborted = true;
		},
		onStop: () => {
			stopped = true;
		},
	});

	rel.scheduleOrphan("short-grace-session");
	await sleep(300); // 300 ms > 60 + 30 ms

	assert(aborted, "abort fired after short grace window");
	assert(stopped, "stop fired after abort delay");
	rel.dispose();
}

console.log("\n-- cancel prevents abort on subscriber re-attach --");
{
	let aborted = false;
	const rel = new RpcSessionReliability({
		orphanGraceMs: 60,
		orphanAbortDelayMs: 30,
		hasSubscribers: () => false,
		onAbort: () => {
			aborted = true;
		},
		onStop: () => {},
	});

	rel.scheduleOrphan("cancel-test-session");
	// Simulate re-attach before grace expires
	rel.cancelOrphan("cancel-test-session");
	await sleep(200);

	assert(!aborted, "abort NOT fired when orphan was cancelled (re-attach)");
	rel.dispose();
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
