/**
 * Integration test for bootstrap run onboarding flag mapping.
 *
 * Traceability:
 * - BS-004 (onboarding maps answers to brain primitives)
 *
 * Run: npx tsx tests/test-bootstrap-run-onboarding.ts
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

function run(args: string, envExtra: Record<string, string>): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execSync(`node --experimental-strip-types ${CLI_PATH} ${args}`, {
      encoding: "utf-8",
      env: {
        ...process.env,
        NODE_NO_WARNINGS: "1",
        ...envExtra,
      },
      timeout: 15_000,
      stdio: ["ignore", "pipe", "pipe"],
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

console.log("\n=== Bootstrap Run Onboarding Integration Test ===\n");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rho-bootstrap-onboarding-"));
const brainPath = path.join(tmpRoot, "brain", "brain.jsonl");
const auditPath = path.join(tmpRoot, "logs", "bootstrap-events.jsonl");

const env = {
  HOME: tmpRoot,
  RHO_BRAIN_PATH: brainPath,
  RHO_BOOTSTRAP_AUDIT_PATH: auditPath,
};

const cmd = [
  "bootstrap run",
  "--to pa-v1",
  "--name Mikey",
  "--timezone America/Chicago",
  "--style concise",
  "--external-action-policy always-ask",
  "--coding-task-first",
  "--quiet-hours 23:00-08:00",
  "--proactive-cadence light",
  "--non-interactive",
  "--json",
].join(" ");

const r = run(cmd, env);
assertEq(r.code, 0, "bootstrap run exits 0");

let payload: any = null;
try {
  payload = JSON.parse(r.stdout);
} catch {
  payload = null;
}
assert(payload !== null, "bootstrap run returns JSON");
assertEq(payload?.status, "completed", "status is completed");
assertEq(payload?.version, "pa-v1", "version is pa-v1");
assert(typeof payload?.onboardingApplied === "number", "onboardingApplied count included");
assert((payload?.onboardingApplied ?? 0) >= 1, "onboarding applied at least one entry");

const rows = readJsonl(brainPath);

assert(
  rows.some((e) => e.type === "user" && e.key === "name" && e.value === "Mikey"),
  "user name entry persisted"
);

assert(
  rows.some((e) => e.type === "user" && e.key === "timezone" && e.value === "America/Chicago"),
  "user timezone entry persisted"
);

assert(
  rows.some((e) => e.type === "preference" && e.key === "communication.style" && e.value === "concise"),
  "communication style preference persisted"
);

assert(
  rows.some((e) => e.type === "context" && e.key === "workflow.approvalGate" && e.value === "propose-approve-implement"),
  "workflow approval-gate context persisted"
);

assert(
  rows.some((e) => e.type === "reminder"),
  "light proactive cadence created reminder"
);

console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
