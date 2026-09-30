/**
 * Tests for rho doctor — doctor-core.ts pure logic.
 * Run: npx tsx tests/test-doctor.ts
 */

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

function assertEq(actual: unknown, expected: unknown, label: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  PASS: ${label}`);
    PASS++;
  } else {
    console.error(
      `  FAIL: ${label} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
    );
    FAIL++;
  }
}

// ---- Imports ----
import {
  checkNodeVersion,
  checkBinaryExists,
  checkConfigFile,
  checkModuleFiles,
  checkPiIntegration,
  checkDataDir,
  checkAuthFile,
  runAllChecks,
  type CheckResult,
  type DoctorInput,
} from "../cli/doctor-core.ts";

// ===== CheckResult type =====
console.log("\n=== CheckResult structure ===\n");

{
  // ok result
  const ok: CheckResult = { status: "ok", message: "all good" };
  assertEq(ok.status, "ok", "ok status");
  assertEq(ok.fix, undefined, "ok has no fix");
}
{
  // warn result with fix
  const warn: CheckResult = { status: "warn", message: "hmm", fix: "do this" };
  assertEq(warn.status, "warn", "warn status");
  assertEq(warn.fix, "do this", "warn has fix");
}
{
  // fail result with fix
  const fail: CheckResult = { status: "fail", message: "bad", fix: "fix it" };
  assertEq(fail.status, "fail", "fail status");
}

// ===== checkNodeVersion =====
console.log("\n=== checkNodeVersion ===\n");

{
  const r = checkNodeVersion("v22.5.0");
  assertEq(r.status, "ok", "Node v22.5.0 is ok");
  assert(r.message.includes("22.5.0"), "message includes version");
}
{
  const r = checkNodeVersion("v24.1.0");
  assertEq(r.status, "ok", "Node v24.1.0 is ok");
}
{
  const r = checkNodeVersion("v18.0.0");
  assertEq(r.status, "fail", "Node v18.0.0 fails (too old)");
  assert(r.fix !== undefined, "has fix suggestion");
}
{
  const r = checkNodeVersion("v20.0.0");
  assertEq(r.status, "ok", "Node v20.0.0 is ok (minimum)");
}
{
  const r = checkNodeVersion(null);
  assertEq(r.status, "fail", "null version fails");
  assert(r.fix !== undefined, "has fix for missing node");
}

// ===== checkBinaryExists =====
console.log("\n=== checkBinaryExists ===\n");

{
  const r = checkBinaryExists("tmux", "3.4", true);
  assertEq(r.status, "ok", "tmux present");
  assert(r.message.includes("3.4"), "message includes version");
}
{
  const r = checkBinaryExists("tmux", null, false);
  assertEq(r.status, "warn", "tmux missing is warn");
  assert(r.fix !== undefined, "has fix for missing tmux");
}
{
  const r = checkBinaryExists("git", "2.47.0", true);
  assertEq(r.status, "ok", "git present");
}
{
  const r = checkBinaryExists("git", null, false);
  assertEq(r.status, "warn", "git missing is warn");
}
{
  // Required binary missing (pi)
  const r = checkBinaryExists("pi", null, false, true);
  assertEq(r.status, "fail", "required binary missing is fail");
}
{
  // Required binary present
  const r = checkBinaryExists("pi", "1.2.0", true, true);
  assertEq(r.status, "ok", "required binary present is ok");
}

// ===== checkConfigFile =====
console.log("\n=== checkConfigFile ===\n");

{
  // File exists and parses OK
  const r = checkConfigFile("init.toml", true, null);
  assertEq(r.status, "ok", "init.toml exists and no error");
  assert(r.message.includes("init.toml"), "message names the file");
}
{
  // File doesn't exist
  const r = checkConfigFile("init.toml", false, null);
  assertEq(r.status, "fail", "missing init.toml is fail");
  assert(
    r.fix !== undefined && r.fix.includes("rho init"),
    "fix suggests rho init",
  );
}
{
  // File exists but has parse error
  const r = checkConfigFile("init.toml", true, "unexpected token at line 5");
  assertEq(r.status, "fail", "malformed init.toml is fail");
  assert(
    r.message.includes("unexpected token"),
    "message includes parse error",
  );
}
{
  // packages.toml missing is just a warning (optional)
  const r = checkConfigFile("packages.toml", false, null, false);
  assertEq(r.status, "warn", "optional missing file is warn");
}

// ===== checkModuleFiles =====
console.log("\n=== checkModuleFiles ===\n");

{
  // All module files exist
  const r = checkModuleFiles(
    new Map([
      ["heartbeat", { missing: [] }],
      ["vault", { missing: [] }],
    ]),
  );
  assertEq(r.status, "ok", "all module files present");
}
{
  // Some module files missing
  const r = checkModuleFiles(
    new Map([
      ["heartbeat", { missing: [] }],
      ["vault", { missing: ["extensions/vault-search"] }],
    ]),
  );
  assertEq(r.status, "fail", "missing module file is fail");
  assert(r.message.includes("vault"), "message names the module");
  assert(r.message.includes("vault-search"), "message names the missing path");
}
{
  // Multiple modules with missing files
  const r = checkModuleFiles(
    new Map([
      ["vault", { missing: ["extensions/vault-search"] }],
      ["email", { missing: ["extensions/email", "skills/rho-cloud-email"] }],
    ]),
  );
  assertEq(r.status, "fail", "multiple missing is fail");
  assert(r.message.includes("vault"), "mentions vault");
  assert(r.message.includes("email"), "mentions email");
}
{
  // Empty map
  const r = checkModuleFiles(new Map());
  assertEq(r.status, "ok", "empty module map is ok (nothing to check)");
}

// ===== checkPiIntegration =====
console.log("\n=== checkPiIntegration ===\n");

{
  // Settings.json has synced rho entry
  const r = checkPiIntegration(true, true, true);
  assertEq(r.status, "ok", "synced pi integration");
}
{
  // Settings.json has rho entry but it is out of sync
  const r = checkPiIntegration(true, true, false);
  assertEq(r.status, "warn", "out of sync is warn");
  assert(
    r.fix !== undefined && r.fix.includes("rho sync"),
    "fix suggests rho sync",
  );
}
{
  // Settings.json exists but no rho entry
  const r = checkPiIntegration(true, false, null);
  assertEq(r.status, "fail", "no rho entry in settings");
  assert(
    r.fix !== undefined && r.fix.includes("rho sync"),
    "fix suggests rho sync",
  );
}
{
  // No settings.json at all
  const r = checkPiIntegration(false, false, null);
  assertEq(r.status, "fail", "no settings.json");
  assert(r.fix !== undefined, "has fix");
}

// ===== checkDataDir =====
console.log("\n=== checkDataDir ===\n");

{
  const r = checkDataDir("brain", true);
  assertEq(r.status, "ok", "brain dir exists");
}
{
  const r = checkDataDir("brain", false);
  assertEq(r.status, "warn", "brain dir missing is warn");
  assert(
    r.fix !== undefined && r.fix.includes("rho sync"),
    "fix suggests rho sync or rho init",
  );
}
{
  const r = checkDataDir("vault", true);
  assertEq(r.status, "ok", "vault dir exists");
}
{
  const r = checkDataDir("vault", false);
  assertEq(r.status, "warn", "vault dir missing is warn");
}

// ===== checkAuthFile =====
console.log("\n=== checkAuthFile ===\n");

{
  // Pi auth present
  const r = checkAuthFile("pi", true, false);
  assertEq(r.status, "ok", "pi auth present");
}
{
  // Pi auth missing, module needs it
  const r = checkAuthFile("pi", false, true);
  assertEq(r.status, "warn", "pi auth missing is warn");
  assert(r.fix !== undefined, "has fix");
}
{
  // Rho Cloud auth missing, email module enabled
  const r = checkAuthFile("rho-cloud", false, true);
  assertEq(r.status, "warn", "rho cloud auth missing is warn");
  assert(
    r.fix !== undefined && r.fix.includes("rho login"),
    "fix suggests rho login",
  );
}
{
  // Rho Cloud auth missing but email not enabled
  const r = checkAuthFile("rho-cloud", false, false);
  assertEq(r.status, "ok", "rho cloud auth not needed if email disabled");
}
{
  // Rho Cloud auth present
  const r = checkAuthFile("rho-cloud", true, true);
  assertEq(r.status, "ok", "rho cloud auth present");
}

// ===== runAllChecks =====
console.log("\n=== runAllChecks ===\n");

{
  // All healthy
  const input: DoctorInput = {
    nodeVersion: "v22.5.0",
    binaries: {
      tmux: { version: "3.4", exists: true },
      git: { version: "2.47.0", exists: true },
      pi: { version: "1.0.0", exists: true },
    },
    configFiles: {
      "init.toml": { exists: true, parseError: null },
      "packages.toml": { exists: true, parseError: null },
    },
    moduleFiles: new Map([
      ["heartbeat", { missing: [] }],
      ["vault", { missing: [] }],
    ]),
    piIntegration: {
      settingsExists: true,
      rhoEntryFound: true,
      rhoEntryInSync: true,
    },
    dataDirs: {
      brain: true,
      vault: true,
    },
    auth: {
      pi: true,
      "rho-cloud": true,
    },
    emailModuleEnabled: true,
  };
  const results = runAllChecks(input);

  // All should be ok
  const allOk = results.every((r) => r.result.status === "ok");
  assert(allOk, "all checks pass for healthy system");
  assert(results.length > 0, "has results");

  // Should have checks from each category
  const categories = new Set(results.map((r) => r.category));
  assert(categories.has("System"), "has System category");
  assert(categories.has("Config"), "has Config category");
  assert(categories.has("Packages"), "has Packages category");
  assert(categories.has("Pi Integration"), "has Pi Integration category");
  assert(categories.has("Data"), "has Data category");
  assert(categories.has("Auth"), "has Auth category");
}

{
  // Mixed: some failures and warnings
  const input: DoctorInput = {
    nodeVersion: "v18.0.0",
    binaries: {
      tmux: { version: null, exists: false },
      git: { version: "2.47.0", exists: true },
      pi: { version: "1.0.0", exists: true },
    },
    configFiles: {
      "init.toml": { exists: true, parseError: null },
      "packages.toml": { exists: false, parseError: null },
    },
    moduleFiles: new Map([["vault", { missing: ["extensions/vault-search"] }]]),
    piIntegration: {
      settingsExists: true,
      rhoEntryFound: false,
      rhoEntryInSync: null,
    },
    dataDirs: {
      brain: true,
      vault: false,
    },
    auth: {
      pi: true,
      "rho-cloud": false,
    },
    emailModuleEnabled: true,
  };
  const results = runAllChecks(input);

  // Count statuses
  const statuses = results.map((r) => r.result.status);
  const fails = statuses.filter((s) => s === "fail");
  const warns = statuses.filter((s) => s === "warn");
  const oks = statuses.filter((s) => s === "ok");

  assert(fails.length > 0, "has failures");
  assert(warns.length > 0, "has warnings");
  assert(oks.length > 0, "has oks");

  // Node should fail
  const nodeCheck = results.find((r) => r.label.toLowerCase().includes("node"));
  assertEq(nodeCheck?.result.status, "fail", "node version fails");

  // tmux should warn
  const tmuxCheck = results.find((r) => r.label.toLowerCase().includes("tmux"));
  assertEq(tmuxCheck?.result.status, "warn", "tmux missing warns");

  // Pi integration should fail
  const piCheck = results.find((r) =>
    r.label.toLowerCase().includes("rho entry"),
  );
  assertEq(piCheck?.result.status, "fail", "pi integration missing fails");

  // Rho cloud should warn
  const cloudCheck = results.find(
    (r) =>
      r.label.toLowerCase().includes("rho cloud") ||
      r.label.toLowerCase().includes("rho-cloud"),
  );
  assertEq(cloudCheck?.result.status, "warn", "rho cloud auth missing warns");
}

{
  // Minimal: no email module, so rho-cloud auth not needed
  const input: DoctorInput = {
    nodeVersion: "v22.0.0",
    binaries: {
      tmux: { version: "3.4", exists: true },
      git: { version: "2.47.0", exists: true },
      pi: { version: "1.0.0", exists: true },
    },
    configFiles: {
      "init.toml": { exists: true, parseError: null },
      "packages.toml": { exists: true, parseError: null },
    },
    moduleFiles: new Map(),
    piIntegration: {
      settingsExists: true,
      rhoEntryFound: true,
      rhoEntryInSync: true,
    },
    dataDirs: {
      brain: true,
      vault: true,
    },
    auth: {
      pi: true,
      "rho-cloud": false,
    },
    emailModuleEnabled: false,
  };
  const results = runAllChecks(input);

  // Rho cloud check should be ok since email not enabled
  const cloudCheck = results.find(
    (r) =>
      r.label.toLowerCase().includes("rho cloud") ||
      r.label.toLowerCase().includes("rho-cloud"),
  );
  assertEq(cloudCheck?.result.status, "ok", "rho-cloud ok when email disabled");
}

{
  // Config parse error
  const input: DoctorInput = {
    nodeVersion: "v22.0.0",
    binaries: {
      tmux: { version: "3.4", exists: true },
      git: { version: "2.47.0", exists: true },
      pi: { version: "1.0.0", exists: true },
    },
    configFiles: {
      "init.toml": { exists: true, parseError: "unexpected token at line 3" },
      "packages.toml": { exists: true, parseError: null },
    },
    moduleFiles: new Map(),
    piIntegration: {
      settingsExists: true,
      rhoEntryFound: true,
      rhoEntryInSync: null,
    },
    dataDirs: {
      brain: true,
      vault: true,
    },
    auth: {
      pi: true,
      "rho-cloud": false,
    },
    emailModuleEnabled: false,
  };
  const results = runAllChecks(input);

  const initCheck = results.find((r) => r.label.includes("init.toml"));
  assertEq(initCheck?.result.status, "fail", "config parse error is fail");
  assert(
    initCheck?.result.message.includes("unexpected token"),
    "parse error message propagated",
  );
}

// ===== formatResults (output formatting) =====
console.log("\n=== formatResults ===\n");

import { formatResults, type CategorizedCheck } from "../cli/doctor-core.ts";

{
  const checks: CategorizedCheck[] = [
    {
      category: "System",
      label: "Node.js",
      result: { status: "ok", message: "v22.5.0" },
    },
    {
      category: "System",
      label: "tmux",
      result: { status: "warn", message: "not found", fix: "Install tmux" },
    },
    {
      category: "Config",
      label: "init.toml",
      result: {
        status: "fail",
        message: "parse error",
        fix: "Fix TOML syntax",
      },
    },
  ];
  const output = formatResults(checks);

  // Output should contain category headers
  assert(output.includes("System"), "output has System header");
  assert(output.includes("Config"), "output has Config header");

  // Should use ok/warn/fail indicators
  assert(output.includes("✓") || output.includes("ok"), "has ok indicator");
  assert(output.includes("!") || output.includes("warn"), "has warn indicator");
  assert(output.includes("✗") || output.includes("fail"), "has fail indicator");

  // Fix suggestions should appear
  assert(output.includes("Install tmux"), "shows fix for warn");
  assert(output.includes("Fix TOML syntax"), "shows fix for fail");
}

{
  // All ok — should indicate healthy
  const checks: CategorizedCheck[] = [
    {
      category: "System",
      label: "Node.js",
      result: { status: "ok", message: "v22.5.0" },
    },
    {
      category: "Config",
      label: "init.toml",
      result: { status: "ok", message: "exists" },
    },
  ];
  const output = formatResults(checks);
  assert(output.length > 0, "output is non-empty");
}

// ===== Summary counts =====
console.log("\n=== summaryCounts ===\n");

import { summaryCounts } from "../cli/doctor-core.ts";

{
  const checks: CategorizedCheck[] = [
    { category: "A", label: "a1", result: { status: "ok", message: "" } },
    { category: "A", label: "a2", result: { status: "ok", message: "" } },
    { category: "B", label: "b1", result: { status: "warn", message: "" } },
    { category: "B", label: "b2", result: { status: "fail", message: "" } },
  ];
  const counts = summaryCounts(checks);
  assertEq(counts.ok, 2, "2 ok");
  assertEq(counts.warn, 1, "1 warn");
  assertEq(counts.fail, 1, "1 fail");
  assertEq(counts.total, 4, "4 total");
}

// ---- Summary ----
console.log(`\n${"=".repeat(40)}`);
console.log(`Doctor tests: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) process.exit(1);
