/**
 * Tests for telegram worker lock helpers.
 * Run: npx tsx tests/test-telegram-worker-lock.ts
 */

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createTelegramWorkerLockState,
  readTelegramWorkerLockOwner,
  releaseTelegramWorkerLock,
  stepTelegramWorkerLock,
} from "../extensions/telegram/worker-lock.ts";

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

console.log("\n=== Telegram worker lock tests ===\n");

const tmp = mkdtempSync(join(tmpdir(), "rho-telegram-worker-lock-"));
const lockPath = join(tmp, "worker.lock.json");

try {
  console.log("-- acquire + refresh --");
  {
    const state = createTelegramWorkerLockState();
    const now = Date.now();
    const staleMs = 2000;

    const first = stepTelegramWorkerLock(state, {
      lockPath,
      nonce: "nonce-a",
      now,
      staleMs,
    });
    assert(first.isOwner === true, "first contender becomes owner");
    assert(first.acquired === true, "first contender reports acquisition");

    const owner = readTelegramWorkerLockOwner(lockPath);
    assert(owner?.pid === process.pid, "lock owner pid stored");

    const refresh = stepTelegramWorkerLock(state, {
      lockPath,
      nonce: "nonce-a",
      now: now + 100,
      staleMs,
    });
    assert(refresh.isOwner === true, "owner refresh keeps ownership");
    assert(refresh.acquired === false, "refresh does not re-acquire");
    assert(refresh.lost === false, "refresh does not lose lock");

    releaseTelegramWorkerLock(state);
    assert(!existsSync(lockPath), "lock removed after release");
  }

  console.log("\n-- blocked contender + takeover after release --");
  {
    const state = createTelegramWorkerLockState();
    const contender = createTelegramWorkerLockState();
    const now = Date.now();
    const staleMs = 2000;

    stepTelegramWorkerLock(state, {
      lockPath,
      nonce: "nonce-owner",
      now,
      staleMs,
    });

    const blocked = stepTelegramWorkerLock(contender, {
      lockPath,
      nonce: "nonce-b",
      now: now + 10,
      staleMs,
    });

    assert(
      blocked.isOwner === false,
      "second contender blocked while owner holds lock",
    );
    assert(
      blocked.ownerPid === process.pid,
      "blocked contender sees owner pid",
    );

    releaseTelegramWorkerLock(state);
    assert(!existsSync(lockPath), "lock removed before takeover");

    const takeover = stepTelegramWorkerLock(contender, {
      lockPath,
      nonce: "nonce-b",
      now: now + 100,
      staleMs,
    });
    assert(takeover.isOwner === true, "contender acquires after release");
    assert(takeover.acquired === true, "takeover reports acquisition");

    releaseTelegramWorkerLock(contender);
  }

  console.log("\n-- stale lock takeover --");
  {
    const now = Date.now();
    const staleMs = 1000;

    writeFileSync(
      lockPath,
      JSON.stringify(
        {
          version: 1,
          purpose: "rho-telegram-worker",
          pid: 999999,
          nonce: "stale-nonce",
          acquiredAt: now - 10_000,
          refreshedAt: now - 10_000,
          hostname: "test-host",
        },
        null,
        2,
      ),
    );

    const state = createTelegramWorkerLockState();
    const takeover = stepTelegramWorkerLock(state, {
      lockPath,
      nonce: "nonce-stale",
      now: now + staleMs + 10,
      staleMs,
    });

    assert(takeover.isOwner === true, "stale lock is taken over");
    assert(takeover.acquired === true, "stale takeover reports acquisition");

    releaseTelegramWorkerLock(state);
    assert(!existsSync(lockPath), "stale lock cleaned up on release");
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===`);
process.exit(FAIL > 0 ? 1 : 0);
