/**
 * RED tests for bootstrap CLI command surface.
 *
 * Traceability:
 * - BS-009, BS-010, BS-011
 *
 * Run: npx tsx tests/test-bootstrap-command.ts
 */

import { execSync } from "node:child_process";
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

function assertIncludes(haystack: string, needle: string, label: string): void {
  if (haystack.includes(needle)) {
    console.log(`  PASS: ${label}`);
    PASS++;
  } else {
    console.error(`  FAIL: ${label} -- "${needle}" not found`);
    FAIL++;
  }
}

const CLI_PATH = path.resolve(import.meta.dirname!, "../cli/index.ts");

function run(args: string): { stdout: string; stderr: string; code: number } {
  try {
    const stdout = execSync(`node --experimental-strip-types ${CLI_PATH} ${args}`, {
      encoding: "utf-8",
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
      timeout: 10_000,
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

console.log("\n=== Bootstrap Command RED Tests ===\n");

console.log("-- bootstrap --help --");
{
  const r = run("bootstrap --help");
  assert(r.code === 0, "BS-011: bootstrap --help exits 0");
  assertIncludes(r.stdout, "bootstrap", "BS-011: help mentions bootstrap command");
  for (const sub of ["status", "run", "reapply", "upgrade", "diff", "reset"]) {
    assertIncludes(r.stdout, sub, `BS-011: help lists ${sub}`);
  }
}

console.log("\n-- bootstrap status --json --");
{
  const r = run("bootstrap status --json");
  assert(r.code === 0, "BS-011: bootstrap status --json exits 0");
  let parsed: any = null;
  try {
    parsed = JSON.parse(r.stdout || "{}");
  } catch {
    parsed = null;
  }
  assert(parsed !== null, "BS-011: status --json outputs valid JSON");
  assert(typeof parsed?.status === "string", "BS-011: status JSON includes status");
  assert(typeof parsed?.version === "string" || parsed?.version == null, "BS-011: status JSON includes version or null");
}

console.log("\n-- bootstrap reset safety --");
{
  const r = run("bootstrap reset");
  assert(r.code !== 0, "BS-009: reset without confirm fails");
  assertIncludes((r.stderr || r.stdout).toLowerCase(), "confirm", "BS-009: reset failure mentions confirmation");
}

console.log("\n-- bootstrap audit --");
{
  const r = run("bootstrap audit --json");
  assert(r.code === 0, "BS-010: bootstrap audit --json exits 0");
  let parsed: any = null;
  try {
    parsed = JSON.parse(r.stdout || "{}");
  } catch {
    parsed = null;
  }
  assert(parsed !== null, "BS-010: audit --json outputs valid JSON");
  assert(Array.isArray(parsed?.events), "BS-010: audit JSON includes events array");
}

console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
