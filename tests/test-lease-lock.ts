/**
 * Tests for lease-lock.ts
 * Run: node --experimental-strip-types tests/test-lease-lock.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  readLeasePayload,
  tryAcquireLeaseLock,
} from "../extensions/lib/lease-lock.ts";

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

// ---- Helpers ----
let testDir: string;

function setup(): string {
  testDir = path.join(
    os.tmpdir(),
    `lease-lock-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.mkdirSync(testDir, { recursive: true });
  return path.join(testDir, "lease.lock.json");
}

function cleanup(): void {
  if (testDir && fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

// ==================================================
// 1. Refresh/release must not clobber a new lock if the path inode changes
// ==================================================
console.log("\n--- no clobber on inode change ---");

{
  const lockPath = setup();
  const now = Date.now();

  const a = tryAcquireLeaseLock(lockPath, "nonce-a", now, {
    staleMs: 60_000,
    purpose: "test",
  });
  assert(a.ok, "A acquired lock");
  if (a.ok) {
    // Simulate lock file being replaced (e.g. stale cleanup) while A still holds an fd.
    fs.unlinkSync(lockPath);

    const b = tryAcquireLeaseLock(lockPath, "nonce-b", now + 1, {
      staleMs: 60_000,
      purpose: "test",
    });
    assert(b.ok, "B acquired lock after replacement");
    if (b.ok) {
      // A must detect loss and refuse to refresh.
      const refreshed = a.lease.refresh(now + 2);
      assertEq(refreshed, false, "A refresh returns false after inode change");

      const p = readLeasePayload(lockPath);
      assert(p !== null, "lock payload readable after replacement");
      if (p) {
        assertEq(p.nonce, "nonce-b", "B nonce remains after A refresh attempt");
      }

      // A release must not delete B's lock.
      a.lease.release();
      const stillThere = readLeasePayload(lockPath);
      assert(stillThere !== null, "B lock still exists after A release");
      if (stillThere)
        assertEq(
          stillThere.nonce,
          "nonce-b",
          "B nonce remains after A release",
        );

      b.lease.release();
      assert(!fs.existsSync(lockPath), "lock removed after B release");
      cleanup();
    } else {
      a.lease.release();
      cleanup();
    }
  } else {
    cleanup();
  }
}

// ==================================================
// 2. Repeated refresh writes valid JSON at start-of-file (no null-prefix corruption)
// ==================================================
console.log("\n--- refresh writes from offset 0 ---");

{
  const lockPath = setup();
  const now = Date.now();

  const a = tryAcquireLeaseLock(lockPath, "nonce-refresh", now, {
    staleMs: 60_000,
    purpose: "test",
  });
  assert(a.ok, "A acquired lock for refresh test");
  if (a.ok) {
    const refreshed1 = a.lease.refresh(now + 100);
    const refreshed2 = a.lease.refresh(now + 200);
    assertEq(refreshed1, true, "first refresh succeeds");
    assertEq(refreshed2, true, "second refresh succeeds");

    const payload = readLeasePayload(lockPath);
    assert(
      payload !== null,
      "payload remains parseable after repeated refresh",
    );
    if (payload) {
      assertEq(
        payload.nonce,
        "nonce-refresh",
        "nonce remains intact after refresh",
      );
    }

    const raw = fs.readFileSync(lockPath, "utf-8");
    assert(
      !raw.startsWith("\u0000"),
      "lock file does not start with NUL after refresh",
    );

    a.lease.release();
    cleanup();
  }
}

// ---- Summary ----
console.log(`\nSummary: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) process.exitCode = 1;
