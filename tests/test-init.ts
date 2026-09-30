/**
 * Tests for rho init — init-core.ts pure logic + commands/init.ts integration.
 * Run: npx tsx tests/test-init.ts
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

function assertIncludes(haystack: string, needle: string, label: string): void {
  if (haystack.includes(needle)) {
    console.log(`  PASS: ${label}`);
    PASS++;
  } else {
    console.error(`  FAIL: ${label} — "${needle}" not found in output`);
    FAIL++;
  }
}

function assertNotIncludes(
  haystack: string,
  needle: string,
  label: string,
): void {
  if (haystack.includes(needle)) {
    console.error(`  FAIL: ${label} — "${needle}" should not be in output`);
    FAIL++;
  } else {
    console.log(`  PASS: ${label}`);
    PASS++;
  }
}

// ---- Imports ----
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { parseInitToml, validateConfig } from "../cli/config.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// Import init-core (the module under test)
import {
  detectPlatform,
  generateInitToml,
  planInit,
  type Platform,
  type InitPlan,
} from "../cli/init-core.ts";

// ===== detectPlatform tests =====
console.log("\n=== detectPlatform ===\n");

{
  // It should return a valid Platform
  const platform = detectPlatform();
  assert(
    ["android", "macos", "linux"].includes(platform),
    `returns valid platform: ${platform}`,
  );

  // It should detect android on Termux (ANDROID_ROOT set)
  // We can't mock process.env easily without side effects, so we test
  // the current environment is detected correctly
  if (process.env.ANDROID_ROOT || process.env.PREFIX?.includes("com.termux")) {
    assertEq(platform, "android", "detects android in Termux");
  }
}

// ===== generateInitToml tests =====
console.log("\n=== generateInitToml ===\n");

{
  // Basic generation with a name
  const result = generateInitToml("tau");
  assert(typeof result === "string", "returns a string");
  assert(result.length > 100, "output is non-trivial length");

  // Parses as valid TOML
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(result) as Record<string, unknown>;
    assert(true, "output parses as valid TOML");
  } catch (e: any) {
    assert(false, `output parses as valid TOML — ${e.message}`);
    parsed = {};
  }

  // Agent name is substituted
  const agent = parsed.agent as Record<string, unknown>;
  assertEq(agent?.name, "tau", "agent.name is substituted");

  // Name with special chars
  const specialResult = generateInitToml("my-agent-42");
  const specialParsed = parseToml(specialResult) as Record<string, unknown>;
  assertEq(
    (specialParsed.agent as any)?.name,
    "my-agent-42",
    "handles hyphens and numbers in name",
  );

  // Validates with config parser
  const config = parseInitToml(result);
  assertEq(config.agent.name, "tau", "parseInitToml accepts generated output");
  const validation = validateConfig(config);
  assert(validation.valid, "generated config passes validation");
  assertEq(validation.errors.length, 0, "no validation errors");

  // All modules present (some may default off)
  const allModules = [
    ...Object.entries(config.modules.core),
    ...Object.entries(config.modules.knowledge),
    ...Object.entries(config.modules.tools),
    ...Object.entries(config.modules.ui),
    ...Object.entries(config.modules.skills),
  ];
  assert(
    allModules.length >= 10,
    `has at least 10 modules (got ${allModules.length})`,
  );

  const DEFAULT_FALSE = new Set(["email"]);
  for (const [name, enabled] of allModules) {
    const expected = DEFAULT_FALSE.has(name) ? false : true;
    assert(enabled === expected, `module ${name} defaults to ${expected}`);
  }

  // Has comments (not just bare TOML)
  const commentLines = result
    .split("\n")
    .filter((l) => l.trimStart().startsWith("#"));
  assert(
    commentLines.length >= 10,
    `has plenty of comments (${commentLines.length})`,
  );

  // Has settings section
  assert(config.settings.heartbeat !== undefined, "has heartbeat settings");
  assertEq(
    config.settings.heartbeat.interval,
    "30m",
    "heartbeat interval defaults to 30m",
  );
}

// ===== planInit tests =====
console.log("\n=== planInit ===\n");

{
  // Fresh install — nothing exists
  const plan = planInit({
    name: "tau",
    rhoDir: "/tmp/test-rho",
    existingFiles: new Set(),
  });

  assertEq(plan.name, "tau", "plan name matches");
  assertEq(plan.rhoDir, "/tmp/test-rho", "plan rhoDir matches");

  // Should create init.toml, packages.toml
  assert(plan.filesToCreate.has("init.toml"), "creates init.toml");
  assert(plan.filesToCreate.has("packages.toml"), "creates packages.toml");

  // Should create data directories
  assert(plan.dirsToCreate.includes("brain"), "creates brain dir");
  assert(plan.dirsToCreate.includes("vault"), "creates vault dir");

  // Files should have content
  const initContent = plan.filesToCreate.get("init.toml")!;
  assert(initContent.includes("tau"), "init.toml has agent name");
}

{
  // Existing install — config files already exist
  const plan = planInit({
    name: "tau",
    rhoDir: "/tmp/test-rho",
    existingFiles: new Set(["init.toml", "packages.toml"]),
  });

  // Should NOT overwrite existing files
  assert(!plan.filesToCreate.has("init.toml"), "does not overwrite init.toml");
  assert(
    !plan.filesToCreate.has("packages.toml"),
    "does not overwrite packages.toml",
  );

  // Should still create data dirs (idempotent)
  assert(plan.dirsToCreate.includes("brain"), "still creates brain dir");
  assert(plan.dirsToCreate.includes("vault"), "still creates vault dir");

  // Should flag existing
  assert(plan.existingConfigs.length > 0, "reports existing configs");
}

{
  // Partial existing — only init.toml exists
  const plan = planInit({
    name: "myagent",
    rhoDir: "/tmp/test-rho",
    existingFiles: new Set(["init.toml"]),
  });

  assert(
    !plan.filesToCreate.has("init.toml"),
    "does not overwrite existing init.toml",
  );
  assert(
    plan.filesToCreate.has("packages.toml"),
    "creates missing packages.toml",
  );
}

{
  // Existing brain/vault data preserved (they're dirs, not files, so
  // dirsToCreate is always populated — mkdir -p is idempotent)
  const plan = planInit({
    name: "test",
    rhoDir: "/tmp/test-rho",
    existingFiles: new Set(["brain", "vault"]),
  });

  // Dirs are always in the plan (mkdir -p is safe)
  assert(plan.dirsToCreate.includes("brain"), "brain dir always in plan");
  assert(plan.dirsToCreate.includes("vault"), "vault dir always in plan");
}

// ===== Platform-specific behavior =====
console.log("\n=== Platform detection ===\n");

{
  // detectPlatform should return one of the three supported platforms
  const p = detectPlatform();
  assert(
    p === "android" || p === "macos" || p === "linux",
    `platform is one of the supported values: ${p}`,
  );
}

// ===== Edge cases =====
console.log("\n=== Edge cases ===\n");

{
  // Empty name should still work (validation is in the command layer)
  const plan = planInit({
    name: "",
    rhoDir: "/tmp/test-rho",
    existingFiles: new Set(),
  });
  assert(
    plan.filesToCreate.has("init.toml"),
    "empty name still generates files",
  );

  // Name with spaces
  const result = generateInitToml("my agent");
  const parsed = parseToml(result);
  assertEq(
    (parsed as any).agent.name,
    "my agent",
    "name with spaces preserved in TOML",
  );
}

// ===== Integration: CLI smoke test =====
console.log("\n=== CLI integration ===\n");

import { execSync } from "node:child_process";
import { mkdtempSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

{
  // Use PREFIX/tmp on Termux, /tmp elsewhere
  const base = process.env.PREFIX ? join(process.env.PREFIX, "tmp") : tmpdir();
  const tmpDir = mkdtempSync(join(base, "rho-init-test-"));
  const tmpRhoDir = join(tmpDir, ".rho");
  const tmpPiDir = join(tmpDir, ".pi", "agent");

  try {
    // Run rho init with HOME overridden
    const cliPath = resolve(ROOT, "cli", "index.ts");
    const env = { ...process.env, HOME: tmpDir };
    const result = execSync(
      `node --experimental-strip-types ${cliPath} init --name testbot --verbose`,
      { env, encoding: "utf-8", stderr: "pipe" },
    );

    // Check output
    assertIncludes(result, "testbot", "CLI output mentions agent name");
    assertIncludes(result, "Next steps", "CLI output has next steps");

    // Check files were created
    assert(
      existsSync(join(tmpRhoDir, "init.toml")),
      "init.toml created on disk",
    );
    assert(
      existsSync(join(tmpRhoDir, "packages.toml")),
      "packages.toml created on disk",
    );
    assert(existsSync(join(tmpRhoDir, "brain")), "brain/ dir created on disk");
    assert(existsSync(join(tmpRhoDir, "vault")), "vault/ dir created on disk");

    // Verify init.toml content
    const initOnDisk = readFileSync(join(tmpRhoDir, "init.toml"), "utf-8");
    const parsedConfig = parseInitToml(initOnDisk);
    assertEq(
      parsedConfig.agent.name,
      "testbot",
      "init.toml on disk has correct name",
    );
    const onDiskValidation = validateConfig(parsedConfig);
    assert(onDiskValidation.valid, "init.toml on disk passes validation");

    // Run init again — should not overwrite
    const result2 = execSync(
      `node --experimental-strip-types ${cliPath} init --name different`,
      { env, encoding: "utf-8", stderr: "pipe" },
    );
    assertIncludes(result2, "Preserved existing", "second run preserves files");
    assertIncludes(
      result2,
      "already initialized",
      "second run reports no changes",
    );

    // Verify original name is preserved
    const initStillOriginal = readFileSync(
      join(tmpRhoDir, "init.toml"),
      "utf-8",
    );
    const stillOriginal = parseInitToml(initStillOriginal);
    assertEq(
      stillOriginal.agent.name,
      "testbot",
      "name not overwritten on re-init",
    );
  } finally {
    // Cleanup
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

{
  // Test --help flag
  const cliPath = resolve(ROOT, "cli", "index.ts");
  const helpResult = execSync(
    `node --experimental-strip-types ${cliPath} init --help`,
    { encoding: "utf-8", stderr: "pipe" },
  );
  assertIncludes(helpResult, "--name", "help shows --name flag");
  assertIncludes(helpResult, "agent-name", "help describes name parameter");
}

{
  // Test default name (no --name flag)
  const base = process.env.PREFIX ? join(process.env.PREFIX, "tmp") : tmpdir();
  const tmpDir = mkdtempSync(join(base, "rho-init-default-"));

  try {
    const cliPath = resolve(ROOT, "cli", "index.ts");
    const env = { ...process.env, HOME: tmpDir };
    execSync(`node --experimental-strip-types ${cliPath} init`, {
      env,
      encoding: "utf-8",
      stderr: "pipe",
    });

    const initContent = readFileSync(
      join(tmpDir, ".rho", "init.toml"),
      "utf-8",
    );
    const config = parseInitToml(initContent);
    assertEq(config.agent.name, "rho", "default name is 'rho'");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ---- Summary ----
console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===\n`);
if (FAIL > 0) process.exit(1);
