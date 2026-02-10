/**
 * Generate a synthetic brain.jsonl with intentional problems for consolidation testing.
 *
 * Usage: npx tsx tests/generate-synthetic-brain.ts <output-path>
 *
 * Creates entries across these categories:
 *   - 5 exact/near-duplicate learnings (should be consolidated)
 *   - 2 contradictory preferences (old vs new — old should be removed)
 *   - 3 stale learnings (about things that no longer apply)
 *   - 2 merge candidates (related learnings that could be one)
 *   - 2 vague learnings (too general to be useful)
 *   - 5 good learnings (should survive untouched)
 *   - 4 good preferences (should survive untouched)
 *   - 5 behavior entries (should NEVER be touched)
 *   - 1 meta entry (schema version)
 */

import * as fs from "node:fs";
import * as path from "node:path";

const outPath = process.argv[2];
if (!outPath) {
  console.error("Usage: npx tsx tests/generate-synthetic-brain.ts <output-path>");
  process.exit(1);
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

const now = new Date().toISOString();
let idCounter = 0;
function nextId(): string {
  return `syn${String(++idCounter).padStart(4, "0")}`;
}

interface Entry {
  id: string;
  type: string;
  created: string;
  [key: string]: any;
}

const entries: Entry[] = [];

// ── Meta ──────────────────────────────────────────────────────────

entries.push({ id: "meta0001", type: "meta", key: "schema_version", value: "1", created: now });

// ── Behaviors (5, should NEVER be modified) ───────────────────────

entries.push({ id: nextId(), type: "behavior", category: "do", text: "Be direct — skip filler", created: now });
entries.push({ id: nextId(), type: "behavior", category: "do", text: "Have opinions — disagree when warranted", created: now });
entries.push({ id: nextId(), type: "behavior", category: "dont", text: "Use performative phrases like 'Great question!'", created: now });
entries.push({ id: nextId(), type: "behavior", category: "value", text: "Clarity over diplomacy", created: now });
entries.push({ id: nextId(), type: "behavior", category: "value", text: "Concise when simple, thorough when complex", created: now });

// ── Exact/near-duplicate learnings (5 entries, should become 2–3) ─

// Pair 1: exact duplicate
entries.push({ id: nextId(), type: "learning", text: "Use printf '%s' instead of echo for piping to jq", source: "auto", created: daysAgo(30) });
entries.push({ id: nextId(), type: "learning", text: "Use printf '%s' instead of echo for piping to jq", source: "auto", created: daysAgo(5) });

// Pair 2: near-duplicate (same meaning, different wording)
entries.push({ id: nextId(), type: "learning", text: "The CI pipeline runs on GitHub Actions", source: "auto", created: daysAgo(20) });
entries.push({ id: nextId(), type: "learning", text: "CI/CD uses GitHub Actions for the pipeline", source: "auto", created: daysAgo(3) });

// Solo near-duplicate of pair 1 (slightly different)
entries.push({ id: nextId(), type: "learning", text: "When piping to jq, use printf instead of echo to avoid trailing newline issues", source: "auto", created: daysAgo(15) });

// ── Contradictory preferences (2 — old should be removed) ────────

entries.push({ id: nextId(), type: "preference", category: "Code", text: "Use 2 spaces for indentation", created: daysAgo(60) });
entries.push({ id: nextId(), type: "preference", category: "Code", text: "Use tabs for indentation (switched from spaces)", created: daysAgo(2) });

// ── Stale learnings (3 — about things that no longer apply) ──────

entries.push({ id: nextId(), type: "learning", text: "The project uses webpack 4 for bundling (migrated to vite in January)", source: "auto", created: daysAgo(120) });
entries.push({ id: nextId(), type: "learning", text: "Deploy to the staging server at staging.oldcompany.com", source: "auto", created: daysAgo(90) });
entries.push({ id: nextId(), type: "learning", text: "The API is on v1 endpoint /api/v1 (v2 launched last month)", source: "auto", created: daysAgo(45) });

// ── Merge candidates (2 — related, should become 1) ──────────────

entries.push({ id: nextId(), type: "learning", text: "The database connection pool max is 20", source: "manual", created: daysAgo(10) });
entries.push({ id: nextId(), type: "learning", text: "Database connections time out after 30 seconds if idle", source: "manual", created: daysAgo(10) });

// ── Vague learnings (2 — too general to be useful) ───────────────

entries.push({ id: nextId(), type: "learning", text: "The code should be clean", source: "auto", created: daysAgo(40) });
entries.push({ id: nextId(), type: "learning", text: "Testing is important for quality", source: "auto", created: daysAgo(35) });

// ── Textually similar but semantically different (2 — must NOT merge) ─

entries.push({ id: nextId(), type: "learning", text: "Use 4-space indent in Python files per PEP 8", source: "manual", created: daysAgo(8) });
entries.push({ id: nextId(), type: "learning", text: "Use 2-space indent in YAML files per project convention", source: "manual", created: daysAgo(8) });

// ── Scoped learning that must not merge with global ──────────────

entries.push({ id: nextId(), type: "learning", text: "Redis cache TTL is 5 minutes", source: "manual", scope: "project", projectPath: "/home/user/webapp", created: daysAgo(6) });
entries.push({ id: nextId(), type: "learning", text: "Redis cache TTL is 1 hour for the billing service", source: "manual", scope: "global", created: daysAgo(6) });

// ── Same-text preferences in different categories (must keep both) ─

entries.push({ id: nextId(), type: "preference", category: "Code", text: "Prefer explicit over implicit", created: daysAgo(20) });
entries.push({ id: nextId(), type: "preference", category: "Communication", text: "Prefer explicit over implicit", created: daysAgo(20) });

// ── Pre-existing tombstone (should be ignored, not re-processed) ─

const tombstoneTargetId = nextId();
entries.push({ id: tombstoneTargetId, type: "learning", text: "Old entry that was already removed", source: "auto", created: daysAgo(100) });
entries.push({ id: nextId(), type: "tombstone", target_id: tombstoneTargetId, target_type: "learning", reason: "previously cleaned", created: daysAgo(50) });

// ── Good learnings (5 — should survive untouched) ────────────────

entries.push({ id: nextId(), type: "learning", text: "API rate limit is 100 requests per minute per key", source: "manual", created: daysAgo(7) });
entries.push({ id: nextId(), type: "learning", text: "Always run tests before committing", source: "manual", created: daysAgo(14) });
entries.push({ id: nextId(), type: "learning", text: "The deploy pipeline takes 12 minutes on average", source: "manual", created: daysAgo(21) });
entries.push({ id: nextId(), type: "learning", text: "Use pnpm not npm in this monorepo", source: "manual", created: daysAgo(5) });
entries.push({ id: nextId(), type: "learning", text: "Fish shell config lives in ~/.config/fish/conf.d/", source: "manual", created: daysAgo(3) });

// ── Good preferences (4 — should survive untouched) ──────────────

entries.push({ id: nextId(), type: "preference", category: "Communication", text: "User name: Mikey", created: daysAgo(30) });
entries.push({ id: nextId(), type: "preference", category: "Communication", text: "Terse communication style preferred", created: daysAgo(30) });
entries.push({ id: nextId(), type: "preference", category: "Workflow", text: "Do not run destructive commands without asking first", created: daysAgo(30) });
entries.push({ id: nextId(), type: "preference", category: "Tools", text: "Use ripgrep over grep for all searches", created: daysAgo(30) });

// ── Write ─────────────────────────────────────────────────────────

fs.mkdirSync(path.dirname(outPath), { recursive: true });
const lines = entries.map((e) => JSON.stringify(e));
fs.writeFileSync(outPath, lines.join("\n") + "\n");

console.log(`Wrote ${entries.length} entries to ${outPath}`);
console.log(`  Behaviors:    5 (should not be touched)`);
console.log(`  Learnings:    ${entries.filter(e => e.type === "learning").length} (active after fold: ${entries.filter(e => e.type === "learning").length - 1})`);
console.log(`    - 5 duplicates/near-dupes (should consolidate to 2-3)`);
console.log(`    - 3 stale (should be removed)`);
console.log(`    - 2 merge candidates (should become 1)`);
console.log(`    - 2 vague (should be removed)`);
console.log(`    - 2 textually similar but different (must NOT merge)`);
console.log(`    - 2 scoped vs global (must NOT merge)`);
console.log(`    - 5 keepers (must survive)`);
console.log(`    - 1 pre-tombstoned (already gone)`);
console.log(`  Preferences:  ${entries.filter(e => e.type === "preference").length}`);
console.log(`    - 2 contradictory (old should go)`);
console.log(`    - 2 same-text different-category (must keep both)`);
console.log(`    - 4 keepers (must survive)`);
console.log(`  Tombstones:   ${entries.filter(e => e.type === "tombstone").length} (pre-existing)`);
console.log(`  Meta:         1`);
