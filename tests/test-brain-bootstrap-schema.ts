/**
 * RED tests for brain bootstrap schema/validation.
 *
 * Traceability:
 * - BS-001, BS-002 (features/brain-bootstrap.feature)
 *
 * Run: npx tsx tests/test-brain-bootstrap-schema.ts
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

interface ValidateResult {
  ok: boolean;
  errors: string[];
}

console.log("\n=== Brain Bootstrap Schema RED Tests ===\n");

let schema: any = null;
try {
  schema = await import("../extensions/lib/brain-bootstrap-schema.ts");
  assert(true, "BS-001: schema module is importable");
} catch (e: any) {
  assert(false, `BS-001: schema module is importable (${e?.message ?? e})`);
}

if (schema) {
  const validateBootstrapMeta = schema.validateBootstrapMeta as
    | ((input: unknown) => ValidateResult)
    | undefined;
  const validateManagedMetadata = schema.validateManagedMetadata as
    | ((input: unknown) => ValidateResult)
    | undefined;
  const buildManagedKey = schema.buildManagedKey as
    | ((input: { type: string; category?: string; key?: string; text?: string }) => string)
    | undefined;

  assert(typeof validateBootstrapMeta === "function", "BS-002: validateBootstrapMeta exists");
  assert(typeof validateManagedMetadata === "function", "BS-002: validateManagedMetadata exists");
  assert(typeof buildManagedKey === "function", "BS-002: buildManagedKey exists");

  if (validateBootstrapMeta) {
    const valid = validateBootstrapMeta({
      completed: true,
      version: "pa-v1",
      completedAt: "2026-02-16T16:00:00.000Z",
    });
    assertEq(valid.ok, true, "BS-002: valid bootstrap meta passes");

    const invalid = validateBootstrapMeta({
      completed: true,
      version: "pa-v1",
      completedAt: "not-an-iso-time",
    });
    assertEq(invalid.ok, false, "BS-002: invalid completedAt fails validation");
  }

  if (validateManagedMetadata) {
    const missingSource = validateManagedMetadata({ managed: true, sourceVersion: "pa-v1" });
    assertEq(missingSource.ok, false, "BS-002: managed metadata requires source");

    const ok = validateManagedMetadata({
      managed: true,
      source: "profile:personal-assistant",
      sourceVersion: "pa-v1",
      managedKey: "preference:communication.style",
    });
    assertEq(ok.ok, true, "BS-002: managed metadata accepts valid shape");
  }

  if (buildManagedKey) {
    const a = buildManagedKey({ type: "preference", key: "communication.style" });
    const b = buildManagedKey({ type: "preference", key: "communication.style" });
    assertEq(a, b, "BS-002: managed key generation is deterministic");
  }
}

console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
