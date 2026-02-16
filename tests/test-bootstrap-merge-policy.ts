/**
 * RED tests for profile merge policy and upgrade planning.
 *
 * Traceability:
 * - BS-006, BS-007, BS-008
 *
 * Run: npx tsx tests/test-bootstrap-merge-policy.ts
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

console.log("\n=== Bootstrap Merge Policy RED Tests ===\n");

let mergeMod: any = null;
try {
  mergeMod = await import("../extensions/rho/bootstrap/merge-policy.ts");
  assert(true, "BS-008: merge-policy module is importable");
} catch (e: any) {
  assert(false, `BS-008: merge-policy module is importable (${e?.message ?? e})`);
}

if (mergeMod) {
  const planMergeActions = mergeMod.planMergeActions as
    | ((args: { current: any[]; desired: any[]; mode?: string }) => { actions: any[]; counts: Record<string, number> })
    | undefined;

  assert(typeof planMergeActions === "function", "BS-008: planMergeActions exists");

  if (planMergeActions) {
    const current = [
      {
        type: "preference",
        key: "communication.style",
        value: "balanced",
        managed: true,
        source: "profile:personal-assistant",
        sourceVersion: "pa-v1",
        managedKey: "preference:communication.style",
        managedBaselineHash: "abc",
        contentHash: "abc",
      },
      {
        type: "behavior",
        category: "do",
        text: "Ask before risky external actions",
        managed: true,
        source: "profile:personal-assistant",
        sourceVersion: "pa-v1",
        managedKey: "behavior:do:ask-before-risky-external-actions",
        managedBaselineHash: "seed",
        contentHash: "user-edited",
      },
    ];

    const desired = [
      {
        type: "preference",
        key: "communication.style",
        value: "balanced",
        managedKey: "preference:communication.style",
      },
      {
        type: "behavior",
        category: "do",
        text: "Ask before risky external actions",
        managedKey: "behavior:do:ask-before-risky-external-actions",
      },
      {
        type: "context",
        key: "workflow.approvalGate",
        value: "propose-approve-implement",
        managedKey: "context:workflow.approvalGate",
      },
    ];

    const plan = planMergeActions({ current, desired, mode: "upgrade" });
    const byKey = new Map(plan.actions.map((a: any) => [a.managedKey, a.action]));

    assertEq(byKey.get("preference:communication.style"), "NOOP", "BS-006: unchanged managed entry -> NOOP");
    assertEq(
      byKey.get("behavior:do:ask-before-risky-external-actions"),
      "SKIP_USER_EDITED",
      "BS-007: user-edited managed entry -> SKIP_USER_EDITED"
    );
    assertEq(byKey.get("context:workflow.approvalGate"), "ADD", "BS-008: new managed key -> ADD");

    assert(
      Object.keys(plan.counts).some((k) => ["ADD", "UPDATE", "NOOP", "SKIP_USER_EDITED", "SKIP_CONFLICT", "DEPRECATE"].includes(k)),
      "BS-008: plan includes action classification counts"
    );
  }
}

console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
