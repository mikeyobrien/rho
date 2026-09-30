/**
 * Guardrails for One Skill System cutover.
 * Run: npx tsx tests/test-one-skill-system.ts
 */

import fs from "node:fs";
import path from "node:path";
import { REGISTRY } from "../cli/registry.ts";

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

function walkFiles(dir: string, acc: string[] = []): string[] {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    const rel = path.relative(ROOT, full);
    if (
      rel.startsWith("node_modules") ||
      rel.startsWith(".git") ||
      rel.startsWith(".worktrees")
    ) {
      continue;
    }
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      walkFiles(full, acc);
    } else {
      acc.push(full);
    }
  }
  return acc;
}

const ROOT = path.resolve(import.meta.dirname ?? ".", "..");

console.log("\n-- no legacy sop artifacts --");
{
  const sopsDir = path.join(ROOT, "sops");
  const legacySops = fs.existsSync(sopsDir)
    ? fs.readdirSync(sopsDir).filter((f) => f.endsWith(".sop.md"))
    : [];
  assert(legacySops.length === 0, "no authored sops/*.sop.md files remain");

  const legacyExtDir = path.join(ROOT, "extensions", "agent-sop");
  assert(!fs.existsSync(legacyExtDir), "extensions/agent-sop removed");
}

console.log("\n-- no legacy references in runtime/docs/tests --");
{
  const scanRoots = [
    "README.md",
    "docs",
    "cli",
    "extensions",
    "skills",
    "templates",
    "tests",
  ];
  const files = scanRoots
    .flatMap((p) => {
      const full = path.join(ROOT, p);
      if (!fs.existsSync(full)) return [] as string[];
      const stat = fs.statSync(full);
      return stat.isDirectory() ? walkFiles(full) : [full];
    })
    .filter((f) => !f.endsWith("test-one-skill-system.ts"));

  const forbidden = [
    { label: "legacy /sop command", pattern: /(^|\s)\/sop(\s|$)/ },
    { label: "legacy .sop.md references", pattern: /\.sop\.md/ },
    { label: "legacy agent-sop extension", pattern: /extensions\/agent-sop/ },
    { label: "legacy agent-sop module", pattern: /\bagent-sop\b/ },
    { label: "legacy sops directory path", pattern: /(^|\W)sops\// },
  ];

  for (const { label, pattern } of forbidden) {
    const offenders: string[] = [];
    for (const file of files) {
      const text = fs.readFileSync(file, "utf-8");
      if (pattern.test(text)) offenders.push(path.relative(ROOT, file));
    }
    assert(
      offenders.length === 0,
      `${label} removed (${offenders.join(", ") || "none"})`,
    );
  }
}

console.log("\n-- sop skills are first-class skills --");
{
  const expectedSopSkills = [
    "auto-memory",
    "code-assist",
    "code-task-generator",
    "codebase-summary",
    "create-sop",
    "eval",
    "memory-consolidate",
    "pdd",
    "pdd-build",
    "small-improvement",
  ];

  for (const skillName of expectedSopSkills) {
    const skillPath = path.join(ROOT, "skills", skillName, "SKILL.md");
    assert(
      fs.existsSync(skillPath),
      `${skillName}: skills/<name>/SKILL.md exists`,
    );
    if (!fs.existsSync(skillPath)) continue;

    const content = fs.readFileSync(skillPath, "utf-8");
    assert(
      /\nkind:\s*sop\n/.test(content),
      `${skillName}: frontmatter has kind: sop`,
    );
    assert(
      content.includes("## Parameters"),
      `${skillName}: has ## Parameters section`,
    );
    assert(content.includes("## Steps"), `${skillName}: has ## Steps section`);
  }
}

console.log("\n-- registry follows one-skill-system model --");
{
  assert(!("agent-sop" in REGISTRY), "registry has no agent-sop module");
  assert("workflows" in REGISTRY, "registry includes workflows skill module");

  const workflows = REGISTRY.workflows;
  assert(
    workflows.category === "skills",
    "workflows module is in skills category",
  );
  assert(
    workflows.skills.includes("skills/pdd"),
    "workflows module includes pdd skill",
  );
  assert(
    workflows.skills.includes("skills/code-assist"),
    "workflows module includes code-assist skill",
  );

  const heartbeat = REGISTRY.heartbeat;
  assert(
    heartbeat.skills.includes("skills/memory-consolidate"),
    "heartbeat includes memory-consolidate skill",
  );
  assert(
    heartbeat.skills.includes("skills/auto-memory"),
    "heartbeat includes auto-memory skill",
  );
}

console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
