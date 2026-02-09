/**
 * Tests for cli/commands/sync.ts — rho sync command.
 * Run: npx tsx tests/test-sync.ts
 */

import path from "node:path";

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
    console.error(`  FAIL: ${label} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    FAIL++;
  }
}

function assertIncludes(arr: string[], item: string, label: string): void {
  if (arr.includes(item)) {
    console.log(`  PASS: ${label}`);
    PASS++;
  } else {
    console.error(`  FAIL: ${label} — ${JSON.stringify(item)} not in ${JSON.stringify(arr)}`);
    FAIL++;
  }
}

function assertNotIncludes(arr: string[], item: string, label: string): void {
  if (!arr.includes(item)) {
    console.log(`  PASS: ${label}`);
    PASS++;
  } else {
    console.error(`  FAIL: ${label} — ${JSON.stringify(item)} should not be in array`);
    FAIL++;
  }
}

// ---- Import ----
import {
  buildRhoPackageEntry,
  findRhoEntryIndex,
  buildSyncLock,
  planSync,
  type RhoPackageEntry,
  type SyncLock,
  type SyncPlan,
} from "../cli/sync-core.ts";
import type { RhoConfig, PackagesConfig } from "../cli/config.ts";
import { REGISTRY } from "../cli/registry.ts";

// ---- Helpers ----

function makeConfig(overrides?: {
  modules?: Partial<RhoConfig["modules"]>;
  settings?: RhoConfig["settings"];
}): RhoConfig {
  // Start with all modules enabled
  const modules: RhoConfig["modules"] = {
    core: { heartbeat: true, memory: true },
    knowledge: { vault: true },
    tools: { "brave-search": true, "x-search": true, email: true },
    skills: { "session-search": true, "update-pi": true },
    ui: { "usage-bars": true, moltbook: true },
  };
  if (overrides?.modules) {
    for (const [cat, mods] of Object.entries(overrides.modules)) {
      Object.assign((modules as any)[cat], mods);
    }
  }
  return {
    agent: { name: "test" },
    modules,
    settings: overrides?.settings ?? {},
  };
}

function makeEmptyPackages(): PackagesConfig {
  return { packages: [] };
}

const RHO_ROOT = path.resolve(import.meta.dirname ?? ".", "..");

// ================================================================
// buildRhoPackageEntry
// ================================================================

console.log("\n-- buildRhoPackageEntry: all modules enabled --");
{
  const config = makeConfig();
  const entry = buildRhoPackageEntry(config, RHO_ROOT);

  assertEq(entry.source, RHO_ROOT, "source is rho root path");
  assertEq(entry._managed_by, "rho", "has _managed_by marker");
  // When all modules enabled, no exclusions needed — omit extensions/skills keys
  assert(entry.extensions === undefined, "extensions omitted when all enabled");
  assert(entry.skills === undefined, "skills omitted when all enabled");
}

console.log("\n-- buildRhoPackageEntry: one tool disabled --");
{
  const config = makeConfig({ modules: { tools: { "x-search": false } } });
  const entry = buildRhoPackageEntry(config, RHO_ROOT);

  assert(entry.extensions !== undefined, "extensions array present");
  assertIncludes(entry.extensions!, "extensions/**/*.ts", "includes extension entrypoints");
  assertIncludes(entry.extensions!, "!extensions/x-search/**", "excludes x-search extension");
  // skills unaffected since x-search has no skills
  assert(entry.skills === undefined, "skills omitted — x-search has no skills");
}

console.log("\n-- buildRhoPackageEntry: module with both extensions and skills disabled --");
{
  const config = makeConfig({ modules: { tools: { email: false } } });
  const entry = buildRhoPackageEntry(config, RHO_ROOT);

  assert(entry.extensions !== undefined, "extensions array present");
  assertIncludes(entry.extensions!, "extensions/**/*.ts", "includes extension entrypoints");
  assertIncludes(entry.extensions!, "!extensions/email/**", "excludes email extension");
  assert(entry.skills !== undefined, "skills array present");
  assertIncludes(entry.skills!, "skills/*", "starts with skills/*");
  assertIncludes(entry.skills!, "!skills/rho-cloud-email", "excludes rho-cloud-email skill");
  assertIncludes(entry.skills!, "!skills/rho-cloud-onboard", "excludes rho-cloud-onboard skill");
}

console.log("\n-- buildRhoPackageEntry: multiple modules disabled --");
{
  const config = makeConfig({
    modules: {
      tools: { "x-search": false, email: false },
      ui: { moltbook: false },
      knowledge: { vault: false },
    },
  });
  const entry = buildRhoPackageEntry(config, RHO_ROOT);

  // Extensions
  assert(entry.extensions !== undefined, "extensions array present");
  assertIncludes(entry.extensions!, "extensions/**/*.ts", "includes extension entrypoints");
  assertIncludes(entry.extensions!, "!extensions/x-search/**", "excludes x-search");
  assertIncludes(entry.extensions!, "!extensions/email/**", "excludes email");
  assertIncludes(entry.extensions!, "!extensions/moltbook-viewer/**", "excludes moltbook-viewer");
  assertIncludes(entry.extensions!, "!extensions/vault-search/**", "excludes vault-search");

  // Skills
  assert(entry.skills !== undefined, "skills array present");
  assertIncludes(entry.skills!, "skills/*", "starts with skills/*");
  assertIncludes(entry.skills!, "!skills/rho-cloud-email", "excludes rho-cloud-email");
  assertIncludes(entry.skills!, "!skills/rho-cloud-onboard", "excludes rho-cloud-onboard");
  assertIncludes(entry.skills!, "!skills/vault-clean", "excludes vault-clean");
}

console.log("\n-- buildRhoPackageEntry: core modules cannot be disabled --");
{
  // Even if config says false, core modules stay enabled
  const config = makeConfig({
    modules: { core: { heartbeat: false, memory: false } },
  });
  const entry = buildRhoPackageEntry(config, RHO_ROOT);

  // Core modules are alwaysOn — should NOT generate exclusions
  if (entry.extensions) {
    assertNotIncludes(entry.extensions, "!extensions/rho", "core heartbeat extension not excluded");
    assertNotIncludes(entry.extensions, "!extensions/memory-viewer", "core memory extension not excluded");
  } else {
    assert(true, "no extensions exclusions (all enabled including core)");
  }
  if (entry.skills) {
    assertNotIncludes(entry.skills, "!skills/memory-clean", "core memory-clean skill not excluded");
  } else {
    assert(true, "no skills exclusions (all enabled including core)");
  }
}

console.log("\n-- buildRhoPackageEntry: skills-only module disabled --");
{
  const config = makeConfig({ modules: { skills: { "session-search": false } } });
  const entry = buildRhoPackageEntry(config, RHO_ROOT);

  // session-search has no extensions, only skills
  assert(entry.extensions === undefined, "no extension exclusions needed");
  assert(entry.skills !== undefined, "skills array present");
  assertIncludes(entry.skills!, "!skills/session-search", "excludes session-search skill");
}

console.log("\n-- buildRhoPackageEntry: all non-core modules disabled --");
{
  const config = makeConfig({
    modules: {
      knowledge: { vault: false },
      tools: { "brave-search": false, "x-search": false, email: false, "agent-sop": false },
      skills: { "session-search": false, "update-pi": false },
      ui: { "usage-bars": false, moltbook: false },
    },
  });
  const entry = buildRhoPackageEntry(config, RHO_ROOT);

  // Should have includes + exclusions for all non-core
  assert(entry.extensions !== undefined, "extensions array present");
  assertIncludes(entry.extensions!, "extensions/**/*.ts", "includes extension entrypoints");

  // Count: vault-search, brave-search, x-search, email, agent-sop, usage-bars, moltbook-viewer = 7 exclusions
  const extExclusions = entry.extensions!.filter((p) => p.startsWith("!"));
  assertEq(extExclusions.length, 7, "7 extension exclusions");

  assert(entry.skills !== undefined, "skills array present");
  // Count: vault-clean, rho-cloud-email, rho-cloud-onboard, session-search, update-pi = 5 exclusions
  const skillExclusions = entry.skills!.filter((p) => p.startsWith("!"));
  assertEq(skillExclusions.length, 5, "5 skill exclusions");
}

// ================================================================
// findRhoEntryIndex
// ================================================================

console.log("\n-- findRhoEntryIndex: find by _managed_by marker --");
{
  const packages = [
    "npm:pi-interactive-shell",
    { source: RHO_ROOT, _managed_by: "rho", extensions: ["extensions/*"] },
    "../../projects/pi-ralph",
  ];
  assertEq(findRhoEntryIndex(packages), 1, "finds rho entry at index 1");
}

console.log("\n-- findRhoEntryIndex: find by source path --");
{
  const packages = [
    "npm:pi-interactive-shell",
    { source: RHO_ROOT },
    "../../projects/pi-ralph",
  ];
  assertEq(findRhoEntryIndex(packages, RHO_ROOT), 1, "finds by source path at index 1");
}

console.log("\n-- findRhoEntryIndex: find bare string entry --");
{
  const packages = [
    "npm:pi-interactive-shell",
    RHO_ROOT,
    "../../projects/pi-ralph",
  ];
  assertEq(findRhoEntryIndex(packages, RHO_ROOT), 1, "finds bare string at index 1");
}

console.log("\n-- findRhoEntryIndex: not found --");
{
  const packages = [
    "npm:pi-interactive-shell",
    "../../projects/pi-ralph",
  ];
  assertEq(findRhoEntryIndex(packages), -1, "returns -1 when not found");
}

console.log("\n-- findRhoEntryIndex: prefers _managed_by over source match --");
{
  const packages = [
    { source: RHO_ROOT },
    { source: "/some/other/path", _managed_by: "rho" },
  ];
  assertEq(findRhoEntryIndex(packages, RHO_ROOT), 1, "prefers _managed_by marker");
}

// ================================================================
// buildSyncLock
// ================================================================

console.log("\n-- buildSyncLock: empty packages --");
{
  const lock = buildSyncLock(makeEmptyPackages());
  assertEq(lock.managed_packages, [], "no managed packages");
  assert(typeof lock.last_sync === "string", "has last_sync timestamp");
}

console.log("\n-- buildSyncLock: tracks package sources --");
{
  const pkgConfig: PackagesConfig = {
    packages: [
      { source: "npm:some-package" },
      { source: "git:github.com/user/repo" },
    ],
  };
  const lock = buildSyncLock(pkgConfig);
  assertEq(lock.managed_packages, ["npm:some-package", "git:github.com/user/repo"], "tracks all sources");
}

// ================================================================
// planSync — the big integration function
// ================================================================

console.log("\n-- planSync: fresh install (no existing settings) --");
{
  const config = makeConfig();
  const pkgConfig = makeEmptyPackages();
  const plan = planSync({
    config,
    pkgConfig,
    settingsJson: null,
    syncLock: null,
    rhoRoot: RHO_ROOT,
  });

  assert(plan.rhoEntry.source === RHO_ROOT, "rho entry has correct source");
  assert(plan.rhoEntry._managed_by === "rho", "rho entry has marker");
  assertEq(plan.packagesToInstall, [], "no packages to install");
  assertEq(plan.packagesToRemove, [], "no packages to remove");
  assert(plan.settingsJson.packages.length >= 1, "settings has at least the rho package");
}

console.log("\n-- planSync: upgrades bare string to object form --");
{
  const config = makeConfig();
  const existingSettings = {
    packages: ["npm:pi-interactive-shell", RHO_ROOT, "../../projects/pi-ralph"],
    defaultProvider: "anthropic",
  };
  const plan = planSync({
    config,
    pkgConfig: makeEmptyPackages(),
    settingsJson: existingSettings,
    syncLock: null,
    rhoRoot: RHO_ROOT,
  });

  // Should replace bare string with object
  const rhoIdx = plan.settingsJson.packages.findIndex(
    (p: any) => typeof p === "object" && p._managed_by === "rho"
  );
  assert(rhoIdx >= 0, "rho entry is now an object");
  assertEq(plan.settingsJson.packages.length, 3, "preserves other packages");
  // Verify other packages untouched
  assertEq(plan.settingsJson.packages[0], "npm:pi-interactive-shell", "first package preserved");
  assertEq(plan.settingsJson.packages[2], "../../projects/pi-ralph", "third package preserved");
  // Verify non-packages fields preserved
  assertEq(plan.settingsJson.defaultProvider, "anthropic", "other settings preserved");
}

console.log("\n-- planSync: updates existing object entry --");
{
  const existingSettings = {
    packages: [
      "npm:pi-interactive-shell",
      { source: RHO_ROOT, _managed_by: "rho", extensions: ["extensions/**/*.ts", "!extensions/old"] },
    ],
  };
  const config = makeConfig({ modules: { tools: { "x-search": false } } });
  const plan = planSync({
    config,
    pkgConfig: makeEmptyPackages(),
    settingsJson: existingSettings,
    syncLock: null,
    rhoRoot: RHO_ROOT,
  });

  const rhoEntry = plan.settingsJson.packages[1] as any;
  assertEq(rhoEntry._managed_by, "rho", "marker preserved");
  assertIncludes(rhoEntry.extensions, "!extensions/x-search/**", "new exclusion applied");
  assertNotIncludes(rhoEntry.extensions, "!extensions/old", "old exclusion removed");
}

console.log("\n-- planSync: new packages.toml entry to install --");
{
  const config = makeConfig();
  const pkgConfig: PackagesConfig = {
    packages: [{ source: "npm:cool-ext" }],
  };
  const existingSettings = {
    packages: [{ source: RHO_ROOT, _managed_by: "rho" }],
  };
  const plan = planSync({
    config,
    pkgConfig,
    settingsJson: existingSettings,
    syncLock: null,
    rhoRoot: RHO_ROOT,
  });

  assertEq(plan.packagesToInstall, ["npm:cool-ext"], "lists package for install");
}

console.log("\n-- planSync: existing packages.toml entry already installed --");
{
  const config = makeConfig();
  const pkgConfig: PackagesConfig = {
    packages: [{ source: "npm:cool-ext" }],
  };
  const existingSettings = {
    packages: [
      { source: RHO_ROOT, _managed_by: "rho" },
      "npm:cool-ext",
    ],
  };
  const plan = planSync({
    config,
    pkgConfig,
    settingsJson: existingSettings,
    syncLock: { managed_packages: ["npm:cool-ext"], last_sync: "2026-01-01" },
    rhoRoot: RHO_ROOT,
  });

  assertEq(plan.packagesToInstall, [], "nothing to install");
  assertEq(plan.packagesToRemove, [], "nothing to remove");
}

console.log("\n-- planSync: package removed from packages.toml --");
{
  const config = makeConfig();
  const pkgConfig = makeEmptyPackages(); // empty now
  const existingSettings = {
    packages: [
      { source: RHO_ROOT, _managed_by: "rho" },
      "npm:old-pkg",
    ],
  };
  const prevLock: SyncLock = {
    managed_packages: ["npm:old-pkg"],
    last_sync: "2026-01-01",
  };
  const plan = planSync({
    config,
    pkgConfig,
    settingsJson: existingSettings,
    syncLock: prevLock,
    rhoRoot: RHO_ROOT,
  });

  assertEq(plan.packagesToRemove, ["npm:old-pkg"], "old package flagged for removal");
  // Should remove from settings.json packages array
  const sources = plan.settingsJson.packages.map((p: any) =>
    typeof p === "string" ? p : p.source
  );
  assertNotIncludes(sources, "npm:old-pkg", "removed package not in settings.json");
}

console.log("\n-- planSync: does not remove unmanaged packages --");
{
  const config = makeConfig();
  const pkgConfig = makeEmptyPackages();
  const existingSettings = {
    packages: [
      { source: RHO_ROOT, _managed_by: "rho" },
      "npm:user-installed",
    ],
  };
  // sync.lock doesn't include user-installed
  const prevLock: SyncLock = {
    managed_packages: [],
    last_sync: "2026-01-01",
  };
  const plan = planSync({
    config,
    pkgConfig,
    settingsJson: existingSettings,
    syncLock: prevLock,
    rhoRoot: RHO_ROOT,
  });

  assertEq(plan.packagesToRemove, [], "nothing to remove");
  const sources = plan.settingsJson.packages.map((p: any) =>
    typeof p === "string" ? p : p.source
  );
  assertIncludes(sources, "npm:user-installed", "user package preserved");
}

console.log("\n-- planSync: packages.toml entry with filtering --");
{
  const config = makeConfig();
  const pkgConfig: PackagesConfig = {
    packages: [
      { source: "npm:filtered-pkg", extensions: ["extensions/only-this.ts"] },
    ],
  };
  const existingSettings = {
    packages: [{ source: RHO_ROOT, _managed_by: "rho" }],
  };
  const plan = planSync({
    config,
    pkgConfig,
    settingsJson: existingSettings,
    syncLock: null,
    rhoRoot: RHO_ROOT,
  });

  assertEq(plan.packagesToInstall, ["npm:filtered-pkg"], "filtered package to install");
}

console.log("\n-- planSync: no settings.json creates fresh one --");
{
  const config = makeConfig();
  const plan = planSync({
    config,
    pkgConfig: makeEmptyPackages(),
    settingsJson: null,
    syncLock: null,
    rhoRoot: RHO_ROOT,
  });

  assert(plan.settingsJson.packages !== undefined, "creates packages array");
  assert(plan.settingsJson.packages.length === 1, "only rho entry");
  assertEq(plan.settingsJson.packages[0].source, RHO_ROOT, "rho entry");
}

console.log("\n-- planSync: sync lock generated --");
{
  const config = makeConfig();
  const pkgConfig: PackagesConfig = {
    packages: [{ source: "npm:pkg-a" }, { source: "npm:pkg-b" }],
  };
  const plan = planSync({
    config,
    pkgConfig,
    settingsJson: null,
    syncLock: null,
    rhoRoot: RHO_ROOT,
  });

  assertEq(plan.newSyncLock.managed_packages, ["npm:pkg-a", "npm:pkg-b"], "lock tracks all packages");
  assert(typeof plan.newSyncLock.last_sync === "string", "lock has timestamp");
}

console.log("\n-- planSync: rho entry at same index when updating --");
{
  const existingSettings = {
    packages: [
      "npm:pi-interactive-shell",
      { source: RHO_ROOT, _managed_by: "rho" },
      "../../projects/pi-ralph",
    ],
  };
  const config = makeConfig({ modules: { ui: { moltbook: false } } });
  const plan = planSync({
    config,
    pkgConfig: makeEmptyPackages(),
    settingsJson: existingSettings,
    syncLock: null,
    rhoRoot: RHO_ROOT,
  });

  // Rho should stay at index 1
  const rhoEntry = plan.settingsJson.packages[1] as any;
  assertEq(rhoEntry._managed_by, "rho", "rho stays at index 1");
  assertEq(plan.settingsJson.packages[0], "npm:pi-interactive-shell", "index 0 preserved");
  assertEq(plan.settingsJson.packages[2], "../../projects/pi-ralph", "index 2 preserved");
}

// ================================================================
// Summary
// ================================================================
console.log(`\n--- ${PASS} passed, ${FAIL} failed ---`);
process.exit(FAIL > 0 ? 1 : 0);
