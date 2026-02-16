/**
 * Integration tests for bootstrap apply/diff/upgrade semantics.
 *
 * Traceability:
 * - BS-005 (existing users opt-in)
 * - BS-006 (reapply idempotence)
 * - BS-007 (user-edited entries preserved)
 * - BS-008 (diff/upgrade action classification)
 *
 * Run: npx tsx tests/test-bootstrap-apply.ts
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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

const CLI_PATH = path.resolve(import.meta.dirname!, "../cli/index.ts");

function parseJsonSafe(raw: string): any {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function run(args: string, envExtra: Record<string, string>): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execSync(`node --experimental-strip-types ${CLI_PATH} ${args}`, {
      encoding: "utf-8",
      env: {
        ...process.env,
        NODE_NO_WARNINGS: "1",
        ...envExtra,
      },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    });
    return { stdout, stderr: "", code: 0 };
  } catch (e: any) {
    return {
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
      code: e.status ?? 1,
    };
  }
}

function readJsonl(filePath: string): any[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf-8");
  if (!raw.trim()) return [];
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function writeJsonl(filePath: string, rows: any[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length > 0 ? "\n" : "");
  fs.writeFileSync(filePath, body, "utf-8");
}

console.log("\n=== Bootstrap Apply Integration Tests ===\n");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rho-bootstrap-apply-"));
const brainPath = path.join(tmpRoot, "brain", "brain.jsonl");
const auditPath = path.join(tmpRoot, "logs", "bootstrap-events.jsonl");

const env = {
  HOME: tmpRoot,
  RHO_BRAIN_PATH: brainPath,
  RHO_BOOTSTRAP_AUDIT_PATH: auditPath,
};

console.log("-- run bootstrap on existing user brain (no bootstrap meta) --");
{
  // Existing user data should remain while bootstrap is applied.
  writeJsonl(brainPath, [
    {
      id: "u-existing",
      type: "user",
      key: "name",
      value: "Mikey",
      created: new Date().toISOString(),
    },
  ]);

  const r = run("bootstrap run --to pa-v1 --json", env);
  assertEq(r.code, 0, "BS-005: bootstrap run exits 0");

  const payload = parseJsonSafe(r.stdout);
  assert(payload !== null, "BS-005: bootstrap run --json returns valid JSON");
  assertEq(payload?.status, "completed", "BS-005: status becomes completed");
  assertEq(payload?.version, "pa-v1", "BS-005: version becomes pa-v1");

  const rows = readJsonl(brainPath);
  assert(rows.some((e) => e.type === "user" && e.key === "name" && e.value === "Mikey"), "BS-005: existing unmanaged entry preserved");
  assert(rows.some((e) => e.type === "meta" && e.key === "bootstrap.completed" && e.value === true), "BS-005: bootstrap.completed meta written");
}

console.log("\n-- reapply same version is idempotent-ish and reports NOOP --");
{
  const r = run("bootstrap reapply --to pa-v1 --json", env);
  assertEq(r.code, 0, "BS-006: reapply exits 0");

  const payload = parseJsonSafe(r.stdout);
  assert(payload !== null, "BS-006: reapply --json returns valid JSON");
  const planCounts = payload?.planCounts ?? {};
  assert(typeof planCounts.NOOP === "number", "BS-006: planCounts includes NOOP");
  assert(planCounts.NOOP >= 1, "BS-006: reapply reports NOOP actions");
}

console.log("\n-- simulate user edit and verify upgrade dry-run skips edited entry --");
{
  const rows = readJsonl(brainPath);

  // Mutate the managed behavior entry to look user-edited.
  let edited = false;
  for (const row of rows) {
    if (row.managedKey === "behavior:do:ask-before-risky-external-actions" && row.managed === true) {
      row.text = "Custom user-edited behavior text";
      row.contentHash = "user-edited-hash";
      edited = true;
    }
  }
  assert(edited, "BS-007: located managed behavior entry to edit");
  writeJsonl(brainPath, rows);

  const dry = run("bootstrap upgrade --to pa-v2 --dry-run --json", env);
  assertEq(dry.code, 0, "BS-007/008: upgrade dry-run exits 0");
  const payload = parseJsonSafe(dry.stdout);
  assert(payload !== null, "BS-008: upgrade dry-run --json valid");

  const actions: any[] = Array.isArray(payload?.actions) ? payload.actions : [];
  const target = actions.find((a) => a.managedKey === "behavior:do:ask-before-risky-external-actions");
  assertEq(target?.action, "SKIP_USER_EDITED", "BS-007: edited managed entry classified as SKIP_USER_EDITED");
}

console.log("\n-- apply upgrade and verify bootstrap version changes --");
{
  const up = run("bootstrap upgrade --to pa-v2 --json", env);
  assertEq(up.code, 0, "BS-008: upgrade exits 0");
  const payload = parseJsonSafe(up.stdout);
  assert(payload !== null, "BS-008: upgrade --json valid");
  assertEq(payload?.toVersion, "pa-v2", "BS-008: upgrade result toVersion pa-v2");

  const rows = readJsonl(brainPath);
  const versions = rows.filter((e) => e.type === "meta" && e.key === "bootstrap.version");
  assert(versions.length >= 1, "BS-008: bootstrap.version meta exists");
  assertEq(versions[versions.length - 1]?.value, "pa-v2", "BS-008: latest bootstrap.version is pa-v2");
}

console.log("\n-- diff returns classified actions payload --");
{
  const diff = run("bootstrap diff --to pa-v2 --json", env);
  assertEq(diff.code, 0, "BS-008: diff exits 0");
  const payload = parseJsonSafe(diff.stdout);
  assert(payload !== null, "BS-008: diff --json valid");
  assert(typeof payload?.planCounts === "object" && payload.planCounts !== null, "BS-008: diff includes planCounts");
  assert(Array.isArray(payload?.actions), "BS-008: diff includes actions array");
}

console.log("\n=== Results: " + PASS + " passed, " + FAIL + " failed ===\n");
process.exit(FAIL > 0 ? 1 : 0);
