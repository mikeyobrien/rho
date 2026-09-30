/**
 * Tests for cli/registry.ts — Module registry.
 * Run: npx tsx tests/test-registry.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { REGISTRY, type ModuleEntry } from "../cli/registry.ts";

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

// Resolve package root (tests/ -> ..)
const PKG_ROOT = path.resolve(import.meta.dirname!, "..");

const VALID_CATEGORIES = new Set([
  "core",
  "knowledge",
  "tools",
  "ui",
  "skills",
]);

// ================================================================
// Registry structure
// ================================================================
console.log("\n-- registry structure --");
{
  const entries = Object.entries(REGISTRY);
  assert(entries.length > 0, "registry is not empty");

  for (const [name, entry] of entries) {
    assert(typeof name === "string" && name.length > 0, `${name}: has a name`);
    assert(
      VALID_CATEGORIES.has(entry.category),
      `${name}: valid category "${entry.category}"`,
    );
    assert(
      typeof entry.description === "string" && entry.description.length > 0,
      `${name}: has description`,
    );
    assert(Array.isArray(entry.extensions), `${name}: extensions is array`);
    assert(Array.isArray(entry.skills), `${name}: skills is array`);
  }
}

// ================================================================
// All paths resolve to real files/dirs
// ================================================================
console.log("\n-- extension paths exist --");
{
  for (const [name, entry] of Object.entries(REGISTRY)) {
    for (const ext of entry.extensions) {
      const full = path.join(PKG_ROOT, ext);
      // Extension dirs should have an index.ts
      const indexPath = path.join(full, "index.ts");
      const exists = fs.existsSync(full) || fs.existsSync(indexPath);
      assert(exists, `${name}: extension "${ext}" exists on disk`);
    }
  }
}

console.log("\n-- skill paths exist --");
{
  for (const [name, entry] of Object.entries(REGISTRY)) {
    for (const sk of entry.skills) {
      const full = path.join(PKG_ROOT, sk);
      // Skill dirs should have a SKILL.md
      const skillPath = path.join(full, "SKILL.md");
      const exists = fs.existsSync(full) || fs.existsSync(skillPath);
      assert(exists, `${name}: skill "${sk}" exists on disk`);
    }
  }
}

// ================================================================
// No duplicate paths
// ================================================================
console.log("\n-- no duplicate extension paths --");
{
  const allPaths: string[] = [];
  for (const entry of Object.values(REGISTRY)) {
    allPaths.push(...entry.extensions);
  }
  const unique = new Set(allPaths);
  assert(
    unique.size === allPaths.length,
    `no duplicate extension paths (${unique.size} unique / ${allPaths.length} total)`,
  );
}

console.log("\n-- no duplicate skill paths --");
{
  const allPaths: string[] = [];
  for (const entry of Object.values(REGISTRY)) {
    allPaths.push(...entry.skills);
  }
  const unique = new Set(allPaths);
  assert(
    unique.size === allPaths.length,
    `no duplicate skill paths (${unique.size} unique / ${allPaths.length} total)`,
  );
}

// ================================================================
// Core modules have alwaysOn
// ================================================================
console.log("\n-- core modules are alwaysOn --");
{
  for (const [name, entry] of Object.entries(REGISTRY)) {
    if (entry.category === "core") {
      assert(entry.alwaysOn === true, `${name}: core module has alwaysOn=true`);
    }
  }
}

console.log("\n-- non-core modules are not alwaysOn --");
{
  for (const [name, entry] of Object.entries(REGISTRY)) {
    if (entry.category !== "core") {
      assert(!entry.alwaysOn, `${name}: non-core module is not alwaysOn`);
    }
  }
}

// ================================================================
// Registry covers all shipped extensions and skills
// ================================================================
console.log("\n-- coverage: all extensions mapped --");
{
  // Get actual extension dirs (excluding lib/ and non-standalone extensions)
  // review is loaded by the rho extension, not registered separately.
  const EXT_SKIP = new Set(["lib", "review"]);
  const extDir = path.join(PKG_ROOT, "extensions");
  const actualExtensions = fs
    .readdirSync(extDir)
    .filter(
      (d) =>
        !EXT_SKIP.has(d) && fs.statSync(path.join(extDir, d)).isDirectory(),
    )
    .map((d) => `extensions/${d}`);

  const registeredExtensions = new Set<string>();
  for (const entry of Object.values(REGISTRY)) {
    for (const ext of entry.extensions) {
      registeredExtensions.add(ext);
    }
  }

  for (const ext of actualExtensions) {
    assert(registeredExtensions.has(ext), `extension "${ext}" is in registry`);
  }
}

console.log("\n-- coverage: all skills mapped --");
{
  // memory-migration is a transitional skill, not a permanent registry entry.
  const SKILL_SKIP = new Set(["memory-migration"]);
  const skillsDir = path.join(PKG_ROOT, "skills");
  const actualSkills = fs
    .readdirSync(skillsDir)
    .filter(
      (d) =>
        !SKILL_SKIP.has(d) &&
        fs.statSync(path.join(skillsDir, d)).isDirectory(),
    )
    .map((d) => `skills/${d}`);

  const registeredSkills = new Set<string>();
  for (const entry of Object.values(REGISTRY)) {
    for (const sk of entry.skills) {
      registeredSkills.add(sk);
    }
  }

  for (const sk of actualSkills) {
    assert(registeredSkills.has(sk), `skill "${sk}" is in registry`);
  }
}

// ---- Summary ----
console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
