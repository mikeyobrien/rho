/**
 * Tests for file-lock.ts
 * Run: npx tsx tests/test-file-lock.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { withFileLock, isPidRunning } from "../extensions/lib/file-lock.ts";

// ---- Test harness ----
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

function assertEq<T>(actual: T, expected: T, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  PASS: ${label}`);
    PASS++;
  } else {
    console.error(`  FAIL: ${label} -- expected ${e}, got ${a}`);
    FAIL++;
  }
}

// ---- Test helpers ----
let testDir: string;

function setup(): string {
  testDir = path.join(
    os.tmpdir(),
    `filelock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.mkdirSync(testDir, { recursive: true });
  return path.join(testDir, "test.lock");
}

function cleanup(): void {
  if (testDir && fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

// ==================================================
// 1. Acquire and release lock
// ==================================================
console.log("\n--- acquire and release ---");

{
  const lockPath = setup();

  try {
    const result = await withFileLock(
      lockPath,
      { purpose: "test" },
      async () => {
        // Lock file should exist while held
        assert(fs.existsSync(lockPath), "lock file exists during fn()");
        const data = JSON.parse(fs.readFileSync(lockPath, "utf-8"));
        assertEq(data.pid, process.pid, "lock contains our PID");
        assert(
          typeof data.nonce === "string" && data.nonce.length > 0,
          "lock has nonce",
        );
        assert(typeof data.acquiredAt === "number", "lock has acquiredAt");
        assert(typeof data.refreshedAt === "number", "lock has refreshedAt");
        assert(typeof data.hostname === "string", "lock has hostname");
        assertEq(data.purpose, "test", "lock has purpose");
        return 42;
      },
    );

    assertEq(result, 42, "fn() return value passed through");
    assert(!fs.existsSync(lockPath), "lock file removed after release");
  } catch (err) {
    console.error(`  FAIL: acquire and release threw: ${err}`);
    FAIL++;
  }

  cleanup();
}

// ==================================================
// 2. Stale lock — dead PID
// ==================================================
console.log("\n--- stale lock: dead PID ---");

{
  const lockPath = setup();

  // Write a lock with a PID that almost certainly doesn't exist
  const staleLock = {
    pid: 99999999,
    nonce: "dead-nonce",
    acquiredAt: Date.now(),
    refreshedAt: Date.now(),
    hostname: os.hostname(),
    purpose: "stale",
  };
  fs.writeFileSync(lockPath, JSON.stringify(staleLock), "utf-8");

  try {
    const result = await withFileLock(
      lockPath,
      { timeoutMs: 3000 },
      async () => {
        return "acquired-over-dead-pid";
      },
    );
    assertEq(result, "acquired-over-dead-pid", "acquired lock over dead PID");
  } catch (err) {
    console.error(`  FAIL: should have acquired over dead PID: ${err}`);
    FAIL++;
  }

  assert(
    !fs.existsSync(lockPath),
    "lock cleaned up after dead-PID acquisition",
  );
  cleanup();
}

// ==================================================
// 3. Stale lock — expired refreshedAt
// ==================================================
console.log("\n--- stale lock: expired refreshedAt ---");

{
  const lockPath = setup();

  // Write a lock with current PID but very old refreshedAt
  const staleLock = {
    pid: process.pid,
    nonce: "old-nonce",
    acquiredAt: Date.now() - 120_000,
    refreshedAt: Date.now() - 120_000, // 2 minutes ago, well past 30s default
    hostname: os.hostname(),
    purpose: "expired",
  };
  fs.writeFileSync(lockPath, JSON.stringify(staleLock), "utf-8");

  try {
    const result = await withFileLock(
      lockPath,
      { staleMs: 30_000, timeoutMs: 3000 },
      async () => {
        return "acquired-over-expired";
      },
    );
    assertEq(
      result,
      "acquired-over-expired",
      "acquired lock over expired refreshedAt",
    );
  } catch (err) {
    console.error(`  FAIL: should have acquired over expired lock: ${err}`);
    FAIL++;
  }

  cleanup();
}

// ==================================================
// 4. Timeout when lock held by live process
// ==================================================
console.log("\n--- timeout: lock held by live process ---");

{
  const lockPath = setup();

  // Write a lock with current PID and fresh timestamp — this is a live lock
  const liveLock = {
    pid: process.pid,
    nonce: "live-nonce",
    acquiredAt: Date.now(),
    refreshedAt: Date.now(),
    hostname: os.hostname(),
    purpose: "live",
  };
  fs.writeFileSync(lockPath, JSON.stringify(liveLock), "utf-8");

  try {
    await withFileLock(
      lockPath,
      { timeoutMs: 500, staleMs: 60_000 },
      async () => {
        return "should-not-reach";
      },
    );
    console.error("  FAIL: should have thrown LOCK_TIMEOUT");
    FAIL++;
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    assert(msg.includes("LOCK_TIMEOUT"), `threw LOCK_TIMEOUT (got: ${msg})`);
  }

  // Original lock file should still be there (we didn't steal it)
  assert(fs.existsSync(lockPath), "original lock untouched after timeout");
  cleanup();
}

// ==================================================
// 5. Concurrent acquisition — only one wins
// ==================================================
console.log("\n--- concurrent acquisition ---");

{
  const lockPath = setup();

  let wins = 0;
  let losses = 0;

  const attempt = async (id: string): Promise<string> => {
    try {
      return await withFileLock(
        lockPath,
        { timeoutMs: 2000, staleMs: 60_000 },
        async () => {
          wins++;
          // Hold the lock for a bit so the other attempt has to wait/fail
          await new Promise((r) => setTimeout(r, 500));
          return `won-${id}`;
        },
      );
    } catch {
      losses++;
      return `lost-${id}`;
    }
  };

  const results = await Promise.all([attempt("a"), attempt("b")]);

  // At least one should win. With 2s timeout and 500ms hold, both might win sequentially,
  // or one might timeout. The key constraint: they never both hold it simultaneously.
  assert(wins >= 1, `at least one acquired (wins=${wins})`);
  assert(
    wins + losses === 2,
    `all attempts accounted for (wins=${wins}, losses=${losses})`,
  );

  // Verify results match
  const wonCount = results.filter((r) => r.startsWith("won-")).length;
  assertEq(wonCount, wins, "result strings match win count");

  cleanup();
}

// ==================================================
// 6. Unparseable lock falls back to mtime staleness
// ==================================================
console.log("\n--- unparseable lock: mtime fallback ---");

{
  const lockPath = setup();

  // Write garbage to lock file
  fs.writeFileSync(lockPath, "THIS IS NOT JSON {{{{", "utf-8");

  // Set mtime to 2 minutes ago (well past default 30s staleMs)
  const oldTime = new Date(Date.now() - 120_000);
  fs.utimesSync(lockPath, oldTime, oldTime);

  try {
    const result = await withFileLock(
      lockPath,
      { timeoutMs: 3000 },
      async () => {
        return "acquired-over-garbage";
      },
    );
    assertEq(
      result,
      "acquired-over-garbage",
      "acquired lock over garbage file with old mtime",
    );
  } catch (err) {
    console.error(`  FAIL: should have acquired over garbage lock: ${err}`);
    FAIL++;
  }

  cleanup();
}

// ==================================================
// 6b. Unparseable lock with recent mtime blocks
// ==================================================
console.log("\n--- unparseable lock: recent mtime blocks ---");

{
  const lockPath = setup();

  // Write garbage but with FRESH mtime (just written, so mtime is now)
  fs.writeFileSync(lockPath, "GARBAGE BUT FRESH", "utf-8");

  try {
    await withFileLock(
      lockPath,
      { timeoutMs: 500, staleMs: 60_000 },
      async () => {
        return "should-not-reach";
      },
    );
    console.error(
      "  FAIL: should have thrown LOCK_TIMEOUT for fresh garbage lock",
    );
    FAIL++;
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    assert(
      msg.includes("LOCK_TIMEOUT"),
      `fresh garbage lock causes timeout (got: ${msg})`,
    );
  }

  cleanup();
}

// ==================================================
// 7. Lock released even if fn() throws
// ==================================================
console.log("\n--- lock released on fn() throw ---");

{
  const lockPath = setup();

  try {
    await withFileLock(lockPath, {}, async () => {
      assert(fs.existsSync(lockPath), "lock exists before throw");
      throw new Error("intentional explosion");
    });
    console.error("  FAIL: should have re-thrown");
    FAIL++;
  } catch (err: any) {
    const msg = err?.message ?? String(err);
    assert(
      msg.includes("intentional explosion"),
      `original error re-thrown (got: ${msg})`,
    );
  }

  assert(!fs.existsSync(lockPath), "lock file removed despite fn() throwing");
  cleanup();
}

// ==================================================
// isPidRunning sanity checks
// ==================================================
console.log("\n--- isPidRunning ---");

{
  assert(isPidRunning(process.pid), "current process PID is running");
  assert(!isPidRunning(99999999), "PID 99999999 is not running");
  assert(!isPidRunning(-1), "negative PID returns false");
  assert(!isPidRunning(0), "PID 0 returns false");
  assert(!isPidRunning(NaN), "NaN returns false");
}

// ==================================================
// Summary
// ==================================================
console.log(`\n--- Results: ${PASS} passed, ${FAIL} failed ---`);
process.exit(FAIL > 0 ? 1 : 0);
