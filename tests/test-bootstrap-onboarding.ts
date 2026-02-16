/**
 * RED tests for bootstrap onboarding + answer mapping.
 *
 * Traceability:
 * - BS-003, BS-004, BS-005
 *
 * Run: npx tsx tests/test-bootstrap-onboarding.ts
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

console.log("\n=== Bootstrap Onboarding RED Tests ===\n");

let onboarding: any = null;
let mapping: any = null;

try {
  onboarding = await import("../extensions/rho/bootstrap/onboarding.ts");
  assert(true, "BS-004: onboarding module is importable");
} catch (e: any) {
  assert(false, `BS-004: onboarding module is importable (${e?.message ?? e})`);
}

try {
  mapping = await import("../extensions/rho/bootstrap/mapping.ts");
  assert(true, "BS-004: mapping module is importable");
} catch (e: any) {
  assert(false, `BS-004: mapping module is importable (${e?.message ?? e})`);
}

if (onboarding && mapping) {
  const validateOnboardingAnswers = onboarding.validateOnboardingAnswers as
    | ((answers: Record<string, unknown>) => { ok: boolean; errors: string[] })
    | undefined;
  const shouldMarkBootstrapComplete = onboarding.shouldMarkBootstrapComplete as
    | ((state: string) => boolean)
    | undefined;
  const mapOnboardingAnswersToEntries = mapping.mapOnboardingAnswersToEntries as
    | ((answers: Record<string, unknown>) => Record<string, any[]>)
    | undefined;

  assert(typeof validateOnboardingAnswers === "function", "BS-004: validateOnboardingAnswers exists");
  assert(typeof shouldMarkBootstrapComplete === "function", "BS-003: shouldMarkBootstrapComplete exists");
  assert(typeof mapOnboardingAnswersToEntries === "function", "BS-004: mapOnboardingAnswersToEntries exists");

  const validAnswers = {
    name: "Mikey",
    timezone: "America/Chicago",
    style: "balanced",
    externalActionPolicy: "ask-risky-only",
    codingTaskFirst: true,
  };

  if (validateOnboardingAnswers) {
    const valid = validateOnboardingAnswers(validAnswers);
    assertEq(valid.ok, true, "BS-004: valid onboarding answers pass validation");

    const invalid = validateOnboardingAnswers({ ...validAnswers, timezone: "Mars/Phobos" });
    assertEq(invalid.ok, false, "BS-004: invalid timezone fails validation");
  }

  if (shouldMarkBootstrapComplete) {
    assertEq(shouldMarkBootstrapComplete("aborted"), false, "BS-003: aborted onboarding does not complete bootstrap");
    assertEq(shouldMarkBootstrapComplete("applied"), true, "BS-004: applied onboarding can complete bootstrap");
  }

  if (mapOnboardingAnswersToEntries) {
    const mapped = mapOnboardingAnswersToEntries(validAnswers);
    const userEntries = mapped.user ?? [];
    const prefEntries = mapped.preference ?? [];
    const ctxEntries = mapped.context ?? [];

    assert(
      userEntries.some((e: any) => String(e?.text ?? "").toLowerCase().includes("mikey")),
      "BS-004: mapping includes user name"
    );
    assert(
      userEntries.some((e: any) => String(e?.text ?? "").includes("America/Chicago")),
      "BS-004: mapping includes timezone"
    );
    assert(
      prefEntries.length > 0,
      "BS-004: mapping includes preference entries"
    );
    assert(
      ctxEntries.length > 0,
      "BS-005: mapping includes context entries for retrofit behavior"
    );
  }
}

console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
