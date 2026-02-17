/**
 * RED tests for brain bootstrap state helpers.
 *
 * Traceability:
 * - BS-001, BS-002, BS-003
 *
 * Run: npx tsx tests/test-brain-bootstrap-state.ts
 */

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
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  PASS: ${label}`);
    PASS++;
  } else {
    console.error(`  FAIL: ${label} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    FAIL++;
  }
}

type BrainEntry = Record<string, unknown>;

console.log("\n=== Brain Bootstrap State RED Tests ===\n");

let stateMod: any = null;
try {
  stateMod = await import("../extensions/lib/brain-bootstrap-state.ts");
  assert(true, "BS-001: state module is importable");
} catch (e: any) {
  assert(false, `BS-001: state module is importable (${e?.message ?? e})`);
}

if (stateMod) {
  const getBootstrapState = stateMod.getBootstrapState as
    | ((entries: BrainEntry[]) => { status: string; version?: string; completedAt?: string })
    | undefined;
  const markBootstrapCompleted = stateMod.markBootstrapCompleted as
    | ((entries: BrainEntry[], version: string, nowIso: string) => BrainEntry[])
    | undefined;

  assert(typeof getBootstrapState === "function", "BS-001: getBootstrapState exists");
  assert(typeof markBootstrapCompleted === "function", "BS-002: markBootstrapCompleted exists");

  if (getBootstrapState) {
    const s0 = getBootstrapState([]);
    assertEq(s0.status, "not_started", "BS-001: no meta => not_started");

    const partialEntries: BrainEntry[] = [
      { type: "meta", key: "bootstrap.version", value: "agentic-v1" },
    ];
    const s1 = getBootstrapState(partialEntries);
    assertEq(s1.status, "partial", "BS-003: version-only meta => partial");
  }

  if (getBootstrapState && markBootstrapCompleted) {
    const nowIso = "2026-02-16T16:05:00.000Z";
    const updated = markBootstrapCompleted([], "agentic-v1", nowIso);

    const byKey = new Map(
      updated
        .filter((e) => e.type === "meta")
        .map((e) => [String(e.key), e.value])
    );

    assertEq(byKey.get("bootstrap.completed"), true, "BS-002: writes bootstrap.completed=true");
    assertEq(byKey.get("bootstrap.version"), "agentic-v1", "BS-002: writes bootstrap.version");
    assertEq(byKey.get("bootstrap.completedAt"), nowIso, "BS-002: writes bootstrap.completedAt");

    const s2 = getBootstrapState(updated);
    assertEq(s2.status, "completed", "BS-002: completed meta => completed state");
  }
}

console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
