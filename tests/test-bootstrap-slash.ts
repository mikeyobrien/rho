/**
 * Tests for slash bootstrap bridge helpers.
 *
 * Traceability:
 * - BT-07 slash routing + output contract
 * - BS-012 noisy CLI output parsing safety
 *
 * Run: npx tsx tests/test-bootstrap-slash.ts
 */

import {
  buildBootstrapCliArgs,
  handleBootstrapSlash,
  type BootstrapCliRunnerResult,
} from "../extensions/rho/bootstrap/slash-bootstrap.ts";

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

console.log("\n=== Bootstrap Slash Bridge Tests ===\n");

console.log("-- buildBootstrapCliArgs --");
{
  const a = buildBootstrapCliArgs("");
  assertEq(a.command, "status", "default command is status");
  assertEq(a.args[0], "bootstrap", "args begin with bootstrap");
  assertEq(a.args[1], "status", "args include status");
  assert(a.args.includes("--json"), "status adds --json");
}

{
  const a = buildBootstrapCliArgs("run --force");
  assertEq(a.command, "run", "run command parsed");
  assert(a.args.includes("--json"), "run adds --json");
}

{
  const a = buildBootstrapCliArgs("run --json");
  const jsonCount = a.args.filter((x) => x === "--json").length;
  assertEq(jsonCount, 1, "run does not duplicate --json");
}

{
  const a = buildBootstrapCliArgs("bogus-subcommand --foo");
  assertEq(a.unknownCommand, "bogus-subcommand", "unknown command is detected");
  assertEq(a.args.length, 0, "unknown command does not build CLI args");
}

console.log("\n-- handleBootstrapSlash success paths --");
{
  const runner = (_args: string[]): BootstrapCliRunnerResult => ({
    code: 0,
    stdout: JSON.stringify({
      ok: true,
      status: "completed",
      version: "agentic-v1",
      mode: "agentic",
      phase: "completed",
      active: false,
      managedCount: 7,
      managedEntries: [
        "identity:agent.role",
        "user:timezone",
        "context:bootstrap/workflow.approvalGate",
      ],
      lastOperation: "upgrade",
      lastResult: "ok",
      lastOperationAt: "2026-02-16T12:00:00.000Z",
    }),
    stderr: "",
  });

  const r = handleBootstrapSlash("status", runner);
  assertEq(r.ok, true, "status success => ok");
  assertEq(r.command, "status", "status command captured");
  assert(r.notify.text.includes("completed"), "status notify includes state");
  assert(r.notify.text.includes("Mode: agentic"), "status notify includes mode");
  assert(r.notify.text.includes("Managed entries: 7"), "status notify includes managed count");
  assert(r.notify.text.includes("identity:agent.role"), "status notify includes managed entry preview");
  assert(r.notify.text.includes("Last op: upgrade"), "status notify includes last op summary");
}

{
  const runner = (_args: string[]): BootstrapCliRunnerResult => ({
    code: 0,
    stdout: JSON.stringify({ ok: true, events: [{ id: 1 }, { id: 2 }] }),
    stderr: "",
  });

  const r = handleBootstrapSlash("audit --limit 2", runner);
  assertEq(r.ok, true, "audit success => ok");
  assert(r.notify.text.includes("2"), "audit notify includes event count");
}

{
  const runner = (_args: string[]): BootstrapCliRunnerResult => ({
    code: 0,
    stdout: JSON.stringify({
      ok: true,
      mode: "agentic",
      phase: "identity_discovery",
      inject: true,
    }),
    stderr: "",
  });

  const r = handleBootstrapSlash("diff", runner);
  assertEq(r.ok, true, "diff success => ok");
  assert(r.notify.text.includes("mode=agentic"), "diff notify includes mode");
  assert(r.notify.text.includes("phase=identity_discovery"), "diff notify includes phase");
}

{
  const runner = (_args: string[]): BootstrapCliRunnerResult => ({
    code: 0,
    stdout: [
      "mise WARN {not-json}",
      "something noisy before payload",
      JSON.stringify({ ok: true, status: "completed", version: "agentic-v1" }),
      "trailer {still-not-json}",
    ].join("\n"),
    stderr: "",
  });

  const r = handleBootstrapSlash("status", runner);
  assertEq(r.ok, true, "noisy output still parsed as success");
  assert(r.notify.text.includes("completed"), "noisy output parsing keeps status details");
  assert(r.notify.text.includes("agentic-v1"), "noisy output parsing keeps version details");
}

console.log("\n-- handleBootstrapSlash error path --");
{
  let invoked = false;
  const runner = (_args: string[]): BootstrapCliRunnerResult => {
    invoked = true;
    return { code: 0, stdout: "{}", stderr: "" };
  };

  const r = handleBootstrapSlash("whoops", runner);
  assertEq(r.ok, false, "unknown subcommand => not ok");
  assertEq(r.code, 2, "unknown subcommand returns usage code 2");
  assertEq(invoked, false, "unknown subcommand does not invoke CLI runner");
  assert(r.notify.text.includes("Usage: /bootstrap"), "unknown subcommand includes usage hint");
}

{
  const runner = (_args: string[]): BootstrapCliRunnerResult => ({
    code: 1,
    stdout: "",
    stderr: "Confirmation required",
  });

  const r = handleBootstrapSlash("reset", runner);
  assertEq(r.ok, false, "error => not ok");
  assertEq(r.code, 1, "error code propagated");
  assert(r.notify.text.toLowerCase().includes("confirmation"), "error notify includes stderr reason");
}

console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
