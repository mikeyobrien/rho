/**
 * Tests for brain-store.ts
 * Run: npx tsx tests/test-brain-store.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  readBrain,
  foldBrain,
  validateEntry,
  deterministicId,
  appendBrainEntry,
  appendBrainEntryWithDedup,
  SCHEMA_REGISTRY,
  type BrainEntry,
  type BehaviorEntry,
  type IdentityEntry,
  type UserEntry,
  type LearningEntry,
  type PreferenceEntry,
  type ContextEntry,
  type TaskEntry,
  type ReminderEntry,
  type TombstoneEntry,
  type MetaEntry,
  type MaterializedBrain,
} from "../extensions/lib/brain-store.ts";

// ── Test harness ──────────────────────────────────────────────────

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

function assertEq<T>(actual: T, expected: T, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  PASS: ${label}`);
    PASS++;
  } else {
    console.error(`  FAIL: ${label} -- expected ${e}, got ${a}`);
    FAIL++;
  }
}

function assertIncludes(haystack: string, needle: string, label: string): void {
  if (haystack.includes(needle)) {
    console.log(`  PASS: ${label}`);
    PASS++;
  } else {
    console.error(
      `  FAIL: ${label} -- "${haystack}" does not include "${needle}"`,
    );
    FAIL++;
  }
}

// ── Helpers ───────────────────────────────────────────────────────

let testDir: string;

function setup(): string {
  testDir = path.join(
    os.tmpdir(),
    `brain-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.mkdirSync(testDir, { recursive: true });
  return testDir;
}

function cleanup(): void {
  if (testDir && fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

function brainPath(): string {
  return path.join(testDir, "brain.jsonl");
}

const TS = "2026-02-10T00:00:00Z";

function mkBehavior(
  id: string,
  cat: "do" | "dont" | "value",
  text: string,
): BehaviorEntry {
  return { id, type: "behavior", category: cat, text, created: TS };
}

function mkLearning(id: string, text: string): LearningEntry {
  return { id, type: "learning", text, created: TS };
}

function mkIdentity(key: string, value: string): IdentityEntry {
  return {
    id: deterministicId("identity", key),
    type: "identity",
    key,
    value,
    created: TS,
  };
}

function mkUser(key: string, value: string): UserEntry {
  return {
    id: deterministicId("user", key),
    type: "user",
    key,
    value,
    created: TS,
  };
}

function mkPreference(id: string, cat: string, text: string): PreferenceEntry {
  return { id, type: "preference", category: cat, text, created: TS };
}

function mkContext(project: string, p: string, content: string): ContextEntry {
  return {
    id: deterministicId("context", p),
    type: "context",
    project,
    path: p,
    content,
    created: TS,
  };
}

function mkTask(id: string, desc: string): TaskEntry {
  return {
    id,
    type: "task",
    description: desc,
    status: "pending",
    priority: "normal",
    tags: [],
    due: null,
    completedAt: null,
    created: TS,
  };
}

function mkReminder(id: string, text: string): ReminderEntry {
  return {
    id,
    type: "reminder",
    text,
    enabled: true,
    cadence: { kind: "interval", every: "30m" },
    priority: "normal",
    tags: [],
    last_run: null,
    next_due: null,
    last_result: null,
    last_error: null,
    created: TS,
  };
}

function mkTombstone(
  id: string,
  targetId: string,
  targetType: string,
): TombstoneEntry {
  return {
    id,
    type: "tombstone",
    target_id: targetId,
    target_type: targetType,
    reason: "manual",
    created: TS,
  };
}

function mkMeta(key: string, value: string): MetaEntry {
  return {
    id: deterministicId("meta", key),
    type: "meta",
    key,
    value,
    created: TS,
  };
}

function writeLines(
  fp: string,
  entries: BrainEntry[],
  trailingNewline = true,
): void {
  const lines = entries.map((e) => JSON.stringify(e)).join("\n");
  fs.writeFileSync(fp, lines + (trailingNewline ? "\n" : ""), "utf-8");
}

// ==================================================================
// readBrain()
// ==================================================================
console.log("\n--- readBrain ---");

// 1. empty file → empty entries, stats.total=0
{
  setup();
  fs.writeFileSync(brainPath(), "", "utf-8");
  const { entries, stats } = readBrain(brainPath());
  assertEq(entries.length, 0, "empty file → 0 entries");
  assertEq(stats.total, 0, "empty file → stats.total=0");
  assertEq(stats.badLines, 0, "empty file → no bad lines");
  assertEq(stats.truncatedTail, false, "empty file → no truncated tail");
  cleanup();
}

// 2. valid lines parsed correctly
{
  setup();
  const b = mkBehavior("b1", "do", "Be direct");
  const l = mkLearning("l1", "Use pnpm");
  const m = mkMeta("schema_version", "1");
  writeLines(brainPath(), [b, l, m]);
  const { entries, stats } = readBrain(brainPath());
  assertEq(entries.length, 3, "3 valid lines → 3 entries");
  assertEq(stats.total, 3, "stats.total=3");
  assertEq(stats.badLines, 0, "no bad lines");
  assertEq(
    (entries[0] as BehaviorEntry).text,
    "Be direct",
    "first entry parsed correctly",
  );
  assertEq(
    (entries[1] as LearningEntry).text,
    "Use pnpm",
    "second entry parsed correctly",
  );
  assertEq(
    (entries[2] as MetaEntry).key,
    "schema_version",
    "third entry parsed correctly",
  );
  cleanup();
}

// 3. malformed middle line skipped
{
  setup();
  const b = mkBehavior("b1", "do", "Be direct");
  const l = mkLearning("l1", "Use pnpm");
  const content =
    JSON.stringify(b) + "\n" + "NOT VALID JSON\n" + JSON.stringify(l) + "\n";
  fs.writeFileSync(brainPath(), content, "utf-8");
  const { entries, stats } = readBrain(brainPath());
  assertEq(entries.length, 2, "malformed middle line → 2 entries");
  assertEq(stats.badLines, 1, "badLines=1");
  assertEq(stats.truncatedTail, false, "not truncated");
  cleanup();
}

// 4. truncated last line (no trailing \n)
{
  setup();
  const b = mkBehavior("b1", "do", "Be direct");
  // Write valid line + newline + a partial line with NO trailing \n
  const content = JSON.stringify(b) + "\n" + '{"id":"trunc","type":"learn';
  fs.writeFileSync(brainPath(), content, "utf-8");
  const { entries, stats } = readBrain(brainPath());
  assertEq(entries.length, 1, "truncated tail → only valid line kept");
  assertEq(stats.truncatedTail, true, "truncatedTail=true");
  cleanup();
}

// 5. missing file → empty entries (no throw)
{
  setup();
  const { entries, stats } = readBrain(path.join(testDir, "nonexistent.jsonl"));
  assertEq(entries.length, 0, "missing file → 0 entries");
  assertEq(stats.total, 0, "missing file → stats.total=0");
  cleanup();
}

// ==================================================================
// foldBrain()
// ==================================================================
console.log("\n--- foldBrain ---");

// 6. single entry per type materializes correctly
{
  const b = mkBehavior("b1", "do", "Be direct");
  const id = mkIdentity("name", "rho");
  const u = mkUser("name", "Mikey");
  const l = mkLearning("l1", "Use pnpm");
  const p = mkPreference("p1", "Code", "Early returns");
  const c = mkContext("rho", "/home/rho", "Rho project context");
  const t = mkTask("t1", "Deploy");
  const r = mkReminder("r1", "Check weather");
  const m = mkMeta("schema_version", "1");

  const brain = foldBrain([b, id, u, l, p, c, t, r, m]);

  assertEq(brain.behaviors.length, 1, "1 behavior");
  assertEq(brain.identity.size, 1, "1 identity");
  assertEq(brain.user.size, 1, "1 user");
  assertEq(brain.learnings.length, 1, "1 learning");
  assertEq(brain.preferences.length, 1, "1 preference");
  assertEq(brain.contexts.length, 1, "1 context");
  assertEq(brain.tasks.length, 1, "1 task");
  assertEq(brain.reminders.length, 1, "1 reminder");
  assertEq(brain.meta.size, 1, "1 meta");
}

// 7. upsert: same id later line replaces earlier
{
  const l1 = mkLearning("l1", "Use npm");
  const l2 = mkLearning("l1", "Use pnpm");
  const brain = foldBrain([l1, l2]);
  assertEq(brain.learnings.length, 1, "upsert: 1 learning after replacement");
  assertEq(brain.learnings[0].text, "Use pnpm", "upsert: later value wins");
}

// 8. tombstone removes target entry
{
  const l = mkLearning("l1", "Use pnpm");
  const ts = mkTombstone("ts1", "l1", "learning");
  const brain = foldBrain([l, ts]);
  assertEq(brain.learnings.length, 0, "tombstone removes learning");
  assert(brain.tombstoned.has("l1"), "l1 in tombstoned set");
}

// 9. tombstone then re-creation → entry visible
{
  const l1 = mkLearning("l1", "Use pnpm");
  const ts = mkTombstone("ts1", "l1", "learning");
  const l2 = mkLearning("l1", "Use pnpm v2");
  const brain = foldBrain([l1, ts, l2]);
  assertEq(brain.learnings.length, 1, "re-created after tombstone");
  assertEq(brain.learnings[0].text, "Use pnpm v2", "re-created has new text");
}

// 10. all entry types routed to correct collections
{
  const entries: BrainEntry[] = [
    mkBehavior("b1", "do", "Be direct"),
    mkBehavior("b2", "dont", "Hedge"),
    mkIdentity("role", "assistant"),
    mkUser("name", "Mikey"),
    mkLearning("l1", "Fact A"),
    mkLearning("l2", "Fact B"),
    mkPreference("p1", "Code", "Tab indent"),
    mkContext("proj", "/foo", "Context"),
    mkTask("t1", "Ship it"),
    mkTask("t2", "Test it"),
    mkReminder("r1", "Check mail"),
    mkMeta("schema_version", "1"),
    mkMeta("migration.v2", "done"),
  ];

  const brain = foldBrain(entries);
  assertEq(brain.behaviors.length, 2, "2 behaviors");
  assertEq(brain.identity.size, 1, "1 identity");
  assertEq(
    brain.identity.get("role")!.value,
    "assistant",
    "identity value correct",
  );
  assertEq(brain.user.size, 1, "1 user");
  assertEq(brain.user.get("name")!.value, "Mikey", "user value correct");
  assertEq(brain.learnings.length, 2, "2 learnings");
  assertEq(brain.preferences.length, 1, "1 preference");
  assertEq(brain.contexts.length, 1, "1 context");
  assertEq(brain.tasks.length, 2, "2 tasks");
  assertEq(brain.reminders.length, 1, "1 reminder");
  assertEq(brain.meta.size, 2, "2 meta entries");
  assertEq(brain.meta.get("schema_version")!.value, "1", "meta schema_version");
  assertEq(brain.meta.get("migration.v2")!.value, "done", "meta migration.v2");
}

// ==================================================================
// validateEntry()
// ==================================================================
console.log("\n--- validateEntry ---");

// 11. valid behavior entry passes
{
  const result = validateEntry(mkBehavior("b1", "do", "Be direct"));
  assertEq(result.ok, true, "valid behavior passes");
}

// 12. behavior missing category → error mentions "category"
{
  const entry = {
    id: "b1",
    type: "behavior",
    text: "Be direct",
    created: TS,
  } as any;
  const result = validateEntry(entry);
  assertEq(result.ok, false, "missing category fails");
  assertIncludes((result as any).error, "category", "error mentions category");
}

// 13. behavior with invalid category value → mentions valid values
{
  const entry = {
    id: "b1",
    type: "behavior",
    category: "maybe",
    text: "Be direct",
    created: TS,
  } as any;
  const result = validateEntry(entry);
  assertEq(result.ok, false, "invalid category fails");
  const err = (result as any).error as string;
  assert(
    err.includes("do") && err.includes("dont") && err.includes("value"),
    "error mentions valid category values",
  );
}

// 14. each type in registry validates with required fields
{
  const samples: Record<string, BrainEntry> = {
    behavior: mkBehavior("b1", "do", "text"),
    identity: mkIdentity("key", "val"),
    user: mkUser("key", "val"),
    learning: mkLearning("l1", "text"),
    preference: mkPreference("p1", "Code", "text"),
    context: mkContext("proj", "/path", "content"),
    task: mkTask("t1", "desc"),
    reminder: mkReminder("r1", "text"),
    tombstone: mkTombstone("ts1", "target", "learning"),
    meta: mkMeta("key", "val"),
  };

  for (const [typeName, entry] of Object.entries(samples)) {
    const result = validateEntry(entry);
    assertEq(result.ok, true, `${typeName} with required fields validates`);
  }
}

// 15. unknown type rejected
{
  const entry = { id: "x1", type: "alien", created: TS, data: "foo" } as any;
  const result = validateEntry(entry);
  assertEq(result.ok, false, "unknown type rejected");
  assertIncludes((result as any).error, "alien", "error mentions unknown type");
}

// 16. missing id → error
{
  const entry = {
    type: "behavior",
    category: "do",
    text: "test",
    created: TS,
  } as any;
  const result = validateEntry(entry);
  assertEq(result.ok, false, "missing id fails");
  assertIncludes((result as any).error, "id", "error mentions id");
}

// 17. missing type → error
{
  const entry = { id: "b1", category: "do", text: "test", created: TS } as any;
  const result = validateEntry(entry);
  assertEq(result.ok, false, "missing type fails");
  assertIncludes((result as any).error, "type", "error mentions type");
}

// 18. missing created → error
{
  const entry = {
    id: "b1",
    type: "behavior",
    category: "do",
    text: "test",
  } as any;
  const result = validateEntry(entry);
  assertEq(result.ok, false, "missing created fails");
  assertIncludes((result as any).error, "created", "error mentions created");
}

// ==================================================================
// deterministicId()
// ==================================================================
console.log("\n--- deterministicId ---");

// 19. same type+key produces same id every time
{
  const id1 = deterministicId("identity", "name");
  const id2 = deterministicId("identity", "name");
  assertEq(id1, id2, "same type+key → same id");
}

// 20. different keys produce different ids
{
  const id1 = deterministicId("identity", "name");
  const id2 = deterministicId("identity", "role");
  assert(id1 !== id2, "different keys → different ids");
}

// 21. identity/user/meta use key field; context uses path field
{
  const idKey = deterministicId("identity", "name");
  const userKey = deterministicId("user", "name");
  const metaKey = deterministicId("meta", "schema_version");
  const ctxKey = deterministicId("context", "/home/rho");
  // All should be 8-char hex
  assert(/^[0-9a-f]{8}$/.test(idKey), "identity id is 8-char hex");
  assert(/^[0-9a-f]{8}$/.test(userKey), "user id is 8-char hex");
  assert(/^[0-9a-f]{8}$/.test(metaKey), "meta id is 8-char hex");
  assert(/^[0-9a-f]{8}$/.test(ctxKey), "context id is 8-char hex");
  // Different types with same key should produce different ids
  assert(
    idKey !== userKey,
    "identity and user with same key produce different ids",
  );
}

// ==================================================================
// appendBrainEntry()
// ==================================================================
console.log("\n--- appendBrainEntry ---");

// 22. appends single line, file ends with \n
{
  setup();
  const fp = brainPath();
  const entry = mkBehavior("b1", "do", "Be direct");
  await appendBrainEntry(fp, entry);
  const content = fs.readFileSync(fp, "utf-8");
  const lines = content.split("\n");
  // Should be: line, empty string after trailing \n
  assertEq(lines.length, 2, "one line + trailing newline");
  assert(content.endsWith("\n"), "file ends with newline");
  const parsed = JSON.parse(lines[0]);
  assertEq(parsed.id, "b1", "entry written correctly");
  cleanup();
}

// 23. creates file + parent dirs if missing
{
  setup();
  const fp = path.join(testDir, "deep", "nested", "brain.jsonl");
  const entry = mkLearning("l1", "Works");
  await appendBrainEntry(fp, entry);
  assert(fs.existsSync(fp), "file created in nested dirs");
  const content = fs.readFileSync(fp, "utf-8");
  const parsed = JSON.parse(content.trim());
  assertEq(parsed.text, "Works", "entry readable from created file");
  cleanup();
}

// 24. invalid entry rejected — nothing written to disk
{
  setup();
  const fp = brainPath();
  const bad = { id: "b1", type: "behavior", created: TS } as any; // missing category+text
  let threw = false;
  try {
    await appendBrainEntry(fp, bad);
  } catch {
    threw = true;
  }
  assert(threw, "invalid entry throws");
  assert(!fs.existsSync(fp), "no file created for invalid entry");
  cleanup();
}

// 25. concurrent appends don't interleave (20 parallel)
{
  setup();
  const fp = brainPath();
  const promises: Promise<void>[] = [];
  for (let i = 0; i < 20; i++) {
    promises.push(
      appendBrainEntry(
        fp,
        mkLearning(`c${i.toString().padStart(2, "0")}`, `Concurrent ${i}`),
      ),
    );
  }
  await Promise.all(promises);
  const content = fs.readFileSync(fp, "utf-8");
  const lines = content.trim().split("\n");
  assertEq(lines.length, 20, "20 concurrent appends → 20 lines");
  let allValid = true;
  for (const line of lines) {
    try {
      JSON.parse(line);
    } catch {
      allValid = false;
    }
  }
  assert(allValid, "all 20 lines are valid JSON");
  // All unique ids
  const ids = new Set(lines.map((l) => JSON.parse(l).id));
  assertEq(ids.size, 20, "all 20 ids unique");
  cleanup();
}

// ==================================================================
// appendBrainEntryWithDedup()
// ==================================================================
console.log("\n--- appendBrainEntryWithDedup ---");

// 26. duplicate rejected (returns false), file unchanged
{
  setup();
  const fp = brainPath();
  const entry = mkLearning("l1", "Use pnpm");
  await appendBrainEntry(fp, entry);
  const before = fs.readFileSync(fp, "utf-8");

  const isDup = (existing: BrainEntry[], candidate: BrainEntry) =>
    existing.some(
      (e) => (e as LearningEntry).text === (candidate as LearningEntry).text,
    );

  const result = await appendBrainEntryWithDedup(
    fp,
    mkLearning("l2", "Use pnpm"),
    isDup,
  );
  assertEq(result, false, "duplicate returns false");

  const after = fs.readFileSync(fp, "utf-8");
  assertEq(after, before, "file unchanged after duplicate rejection");
  cleanup();
}

// 27. non-duplicate appended (returns true)
{
  setup();
  const fp = brainPath();
  const entry = mkLearning("l1", "Use pnpm");
  await appendBrainEntry(fp, entry);

  const isDup = (existing: BrainEntry[], candidate: BrainEntry) =>
    existing.some(
      (e) => (e as LearningEntry).text === (candidate as LearningEntry).text,
    );

  const result = await appendBrainEntryWithDedup(
    fp,
    mkLearning("l2", "Use npm"),
    isDup,
  );
  assertEq(result, true, "non-duplicate returns true");

  const lines = fs.readFileSync(fp, "utf-8").trim().split("\n");
  assertEq(lines.length, 2, "2 lines after non-duplicate append");
  cleanup();
}

// ==================================================================
// Default file validation (brain.jsonl.default)
// ==================================================================
console.log("\n--- brain.jsonl.default validation ---");

{
  const defaultPath = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
    "brain",
    "brain.jsonl.default",
  );

  let lines: string[] = [];
  const entries: any[] = [];

  // 28. every line parses as valid JSON
  {
    assert(fs.existsSync(defaultPath), "brain.jsonl.default exists");
    const content = fs.readFileSync(defaultPath, "utf-8").trim();
    lines = content.split("\n").filter((l) => l.trim());
    let allValid = true;
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        allValid = false;
      }
    }
    assert(allValid, "every line is valid JSON");
  }

  // 29. every entry has id, type, created
  {
    let allHaveFields = true;
    for (const e of entries) {
      if (!e.id || !e.type || !e.created) allHaveFields = false;
    }
    assert(allHaveFields, "every entry has id, type, created");
  }

  // 30. contains at least one behavior per category (do, dont, value)
  {
    const behaviors = entries.filter((e) => e.type === "behavior");
    const cats = new Set(behaviors.map((b: any) => b.category));
    assert(cats.has("do"), "has at least one behavior category=do");
    assert(cats.has("dont"), "has at least one behavior category=dont");
    assert(cats.has("value"), "has at least one behavior category=value");
  }

  // 31. contains meta entry with schema_version="1"
  {
    const metas = entries.filter((e) => e.type === "meta");
    const sv = metas.find((m: any) => m.key === "schema_version");
    assert(sv !== undefined, "meta schema_version entry exists");
    assertEq(sv?.value, "1", "schema_version = 1");
  }
}

// ==================================================================
// Summary
// ==================================================================
console.log(`\n--- Results: ${PASS} passed, ${FAIL} failed ---`);
process.exit(FAIL > 0 ? 1 : 0);
