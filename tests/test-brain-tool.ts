/**
 * Tests for brain-tool.ts — handleBrainAction()
 * Run: npx tsx tests/test-brain-tool.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { handleBrainAction } from "../extensions/lib/brain-tool.ts";
import {
  readBrain,
  foldBrain,
  deterministicId,
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
    console.error(`  FAIL: ${label} -- "${haystack}" does not include "${needle}"`);
    FAIL++;
  }
}

// ── Helpers ───────────────────────────────────────────────────────

let testDir: string;

function setup(): string {
  testDir = path.join(
    os.tmpdir(),
    `brain-tool-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  fs.mkdirSync(testDir, { recursive: true });
  return testDir;
}

function cleanup(): void {
  if (testDir && fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

function bp(): string {
  return path.join(testDir, "brain.jsonl");
}

/** Read + fold helper */
function fold(brainPath: string): MaterializedBrain {
  const { entries } = readBrain(brainPath);
  return foldBrain(entries);
}

// ==================================================================
// 1. add type=learning → appended, list returns it
// ==================================================================
console.log("\n--- 1. add learning ---");
{
  setup();
  const res = await handleBrainAction(bp(), { action: "add", type: "learning", text: "Use pnpm" });
  assertEq(res.ok, true, "add learning ok");
  const brain = fold(bp());
  assertEq(brain.learnings.length, 1, "1 learning in brain");
  assertEq(brain.learnings[0].text, "Use pnpm", "learning text correct");

  // list returns it
  const list = await handleBrainAction(bp(), { action: "list", type: "learning" });
  assertEq(list.ok, true, "list ok");
  assertIncludes(list.message, "Use pnpm", "list shows learning text");
  cleanup();
}

// ==================================================================
// 2. add type=learning duplicate text → rejected
// ==================================================================
console.log("\n--- 2. add learning duplicate ---");
{
  setup();
  await handleBrainAction(bp(), { action: "add", type: "learning", text: "Use pnpm" });
  const res = await handleBrainAction(bp(), { action: "add", type: "learning", text: "Use pnpm" });
  assertEq(res.ok, false, "duplicate rejected");
  assertIncludes(res.message.toLowerCase(), "duplicate", "message says duplicate");
  const brain = fold(bp());
  assertEq(brain.learnings.length, 1, "still only 1 learning");
  cleanup();
}

// ==================================================================
// 3. add type=preference with category → appended
// ==================================================================
console.log("\n--- 3. add preference ---");
{
  setup();
  const res = await handleBrainAction(bp(), {
    action: "add", type: "preference", category: "Code", text: "Early returns over nested ifs",
  });
  assertEq(res.ok, true, "add preference ok");
  const brain = fold(bp());
  assertEq(brain.preferences.length, 1, "1 preference");
  assertEq(brain.preferences[0].category, "Code", "category correct");
  cleanup();
}

// ==================================================================
// 4. add type=behavior with valid category → appended
// ==================================================================
console.log("\n--- 4. add behavior valid ---");
{
  setup();
  const res = await handleBrainAction(bp(), {
    action: "add", type: "behavior", category: "do", text: "Be direct",
  });
  assertEq(res.ok, true, "add behavior ok");
  const brain = fold(bp());
  assertEq(brain.behaviors.length, 1, "1 behavior");
  assertEq(brain.behaviors[0].category, "do", "category=do");
  cleanup();
}

// ==================================================================
// 5. add type=behavior with invalid category → error message
// ==================================================================
console.log("\n--- 5. add behavior invalid category ---");
{
  setup();
  const res = await handleBrainAction(bp(), {
    action: "add", type: "behavior", category: "maybe", text: "Be vague",
  });
  assertEq(res.ok, false, "invalid category rejected");
  assertIncludes(res.message, "do", "error mentions valid categories");
  // nothing written
  assert(!fs.existsSync(bp()), "no file created");
  cleanup();
}

// ==================================================================
// 6. add type=identity → auto-upserts by key
// ==================================================================
console.log("\n--- 6. add identity auto-upsert ---");
{
  setup();
  await handleBrainAction(bp(), { action: "add", type: "identity", key: "name", value: "rho" });
  await handleBrainAction(bp(), { action: "add", type: "identity", key: "name", value: "rho-v2" });
  const brain = fold(bp());
  assertEq(brain.identity.size, 1, "identity: 1 entry after 2 adds with same key");
  assertEq(brain.identity.get("name")!.value, "rho-v2", "identity: latest value wins");
  cleanup();
}

// ==================================================================
// 7. add type=user → auto-upserts by key
// ==================================================================
console.log("\n--- 7. add user auto-upsert ---");
{
  setup();
  await handleBrainAction(bp(), { action: "add", type: "user", key: "name", value: "Mikey" });
  await handleBrainAction(bp(), { action: "add", type: "user", key: "name", value: "Mike" });
  const brain = fold(bp());
  assertEq(brain.user.size, 1, "user: 1 entry after 2 adds");
  assertEq(brain.user.get("name")!.value, "Mike", "user: latest value wins");
  cleanup();
}

// ==================================================================
// 8. add type=context → auto-upserts by path
// ==================================================================
console.log("\n--- 8. add context auto-upsert ---");
{
  setup();
  await handleBrainAction(bp(), {
    action: "add", type: "context", project: "rho", path: "/home/rho", content: "old context",
  });
  await handleBrainAction(bp(), {
    action: "add", type: "context", project: "rho", path: "/home/rho", content: "new context",
  });
  const brain = fold(bp());
  assertEq(brain.contexts.length, 1, "context: 1 entry after 2 adds");
  assertEq(brain.contexts[0].content, "new context", "context: latest content wins");
  cleanup();
}

// ==================================================================
// 9. add type=reminder with cadence → appended
// ==================================================================
console.log("\n--- 9. add reminder ---");
{
  setup();
  const res = await handleBrainAction(bp(), {
    action: "add", type: "reminder", text: "Check weather",
    enabled: true, cadence: { kind: "interval", every: "30m" },
  });
  assertEq(res.ok, true, "add reminder ok");
  const brain = fold(bp());
  assertEq(brain.reminders.length, 1, "1 reminder");
  assertEq(brain.reminders[0].text, "Check weather", "reminder text");
  assertEq(brain.reminders[0].cadence.kind, "interval", "cadence kind");
  cleanup();
}

// ==================================================================
// 10. add type=task → appended with random id
// ==================================================================
console.log("\n--- 10. add task ---");
{
  setup();
  const res = await handleBrainAction(bp(), {
    action: "add", type: "task", description: "Deploy app",
  });
  assertEq(res.ok, true, "add task ok");
  const brain = fold(bp());
  assertEq(brain.tasks.length, 1, "1 task");
  assertEq(brain.tasks[0].description, "Deploy app", "task desc");
  assertEq(brain.tasks[0].status, "pending", "task default status=pending");
  assertEq(brain.tasks[0].priority, "normal", "task default priority=normal");
  assert(Array.isArray(brain.tasks[0].tags), "task default tags=[]");
  assertEq(brain.tasks[0].due, null, "task default due=null");
  assertEq(brain.tasks[0].completedAt, null, "task default completedAt=null");
  // random id = 8 hex chars
  assert(/^[0-9a-f]{8}$/.test(brain.tasks[0].id), "task id is 8-char hex");
  cleanup();
}

// ==================================================================
// 11. add missing required field → descriptive error, nothing written
// ==================================================================
console.log("\n--- 11. add missing required field ---");
{
  setup();
  // learning without text
  const res = await handleBrainAction(bp(), { action: "add", type: "learning" });
  assertEq(res.ok, false, "missing text rejected");
  assertIncludes(res.message, "text", "error mentions missing field");
  assert(!fs.existsSync(bp()), "no file created");
  cleanup();
}

// ==================================================================
// 12. add unknown type → error
// ==================================================================
console.log("\n--- 12. add unknown type ---");
{
  setup();
  const res = await handleBrainAction(bp(), { action: "add", type: "alien", data: "foo" });
  assertEq(res.ok, false, "unknown type rejected");
  assertIncludes(res.message, "alien", "error mentions the type");
  cleanup();
}

// ==================================================================
// 13. update: merges fields over existing
// ==================================================================
console.log("\n--- 13. update merges fields ---");
{
  setup();
  const addRes = await handleBrainAction(bp(), {
    action: "add", type: "task", description: "Deploy app",
  });
  const brain1 = fold(bp());
  const taskId = brain1.tasks[0].id;

  const upd = await handleBrainAction(bp(), {
    action: "update", id: taskId, priority: "high",
  });
  assertEq(upd.ok, true, "update ok");
  const brain2 = fold(bp());
  assertEq(brain2.tasks.length, 1, "still 1 task");
  assertEq(brain2.tasks[0].priority, "high", "priority updated");
  assertEq(brain2.tasks[0].description, "Deploy app", "description preserved");
  cleanup();
}

// ==================================================================
// 14. update nonexistent id → error
// ==================================================================
console.log("\n--- 14. update nonexistent id ---");
{
  setup();
  const res = await handleBrainAction(bp(), {
    action: "update", id: "deadbeef", priority: "high",
  });
  assertEq(res.ok, false, "update nonexistent fails");
  assertIncludes(res.message, "deadbeef", "error mentions the id");
  cleanup();
}

// ==================================================================
// 15. remove by id → tombstoned, list no longer shows it
// ==================================================================
console.log("\n--- 15. remove by id ---");
{
  setup();
  await handleBrainAction(bp(), { action: "add", type: "learning", text: "Fact A" });
  const brain1 = fold(bp());
  const id = brain1.learnings[0].id;

  const res = await handleBrainAction(bp(), { action: "remove", id });
  assertEq(res.ok, true, "remove ok");
  const brain2 = fold(bp());
  assertEq(brain2.learnings.length, 0, "learning removed");
  assert(brain2.tombstoned.has(id), "id is tombstoned");
  cleanup();
}

// ==================================================================
// 16. remove by natural key (type=user, key=name)
// ==================================================================
console.log("\n--- 16. remove by natural key ---");
{
  setup();
  await handleBrainAction(bp(), { action: "add", type: "user", key: "name", value: "Mikey" });
  const brain1 = fold(bp());
  assertEq(brain1.user.size, 1, "user exists before remove");

  const res = await handleBrainAction(bp(), { action: "remove", type: "user", key: "name" });
  assertEq(res.ok, true, "remove by natural key ok");
  const brain2 = fold(bp());
  assertEq(brain2.user.size, 0, "user removed");
  cleanup();
}

// ==================================================================
// 17. list type=learning → filters correctly
// ==================================================================
console.log("\n--- 17. list type=learning ---");
{
  setup();
  await handleBrainAction(bp(), { action: "add", type: "learning", text: "Fact A" });
  await handleBrainAction(bp(), { action: "add", type: "preference", category: "Code", text: "Tabs" });
  await handleBrainAction(bp(), { action: "add", type: "learning", text: "Fact B" });

  const res = await handleBrainAction(bp(), { action: "list", type: "learning" });
  assertEq(res.ok, true, "list ok");
  assertIncludes(res.message, "Fact A", "list shows Fact A");
  assertIncludes(res.message, "Fact B", "list shows Fact B");
  assert(!res.message.includes("Tabs"), "list does not show preference");
  cleanup();
}

// ==================================================================
// 18. list with query → substring match
// ==================================================================
console.log("\n--- 18. list with query ---");
{
  setup();
  await handleBrainAction(bp(), { action: "add", type: "learning", text: "Use pnpm not npm" });
  await handleBrainAction(bp(), { action: "add", type: "learning", text: "API uses snake_case" });
  await handleBrainAction(bp(), { action: "add", type: "learning", text: "Prefer early returns" });

  const res = await handleBrainAction(bp(), { action: "list", type: "learning", query: "pnpm" });
  assertEq(res.ok, true, "list with query ok");
  assertIncludes(res.message, "pnpm", "query match found");
  assert(!res.message.includes("snake_case"), "non-match excluded");
  assert(!res.message.includes("early returns"), "non-match excluded");
  cleanup();
}

// ==================================================================
// 19. list with filter=pending (tasks) → only pending
// ==================================================================
console.log("\n--- 19. list filter=pending ---");
{
  setup();
  await handleBrainAction(bp(), { action: "add", type: "task", description: "Task A" });
  await handleBrainAction(bp(), { action: "add", type: "task", description: "Task B" });
  // mark Task A done
  const brain1 = fold(bp());
  const taskAId = brain1.tasks.find(t => t.description === "Task A")!.id;
  await handleBrainAction(bp(), { action: "task_done", id: taskAId });

  const res = await handleBrainAction(bp(), { action: "list", type: "task", filter: "pending" });
  assertEq(res.ok, true, "list pending ok");
  assertIncludes(res.message, "Task B", "pending task shown");
  assert(!res.message.includes("Task A"), "done task excluded");
  cleanup();
}

// ==================================================================
// 20. list default → compact format (not full JSON)
// ==================================================================
console.log("\n--- 20. list default compact format ---");
{
  setup();
  await handleBrainAction(bp(), { action: "add", type: "learning", text: "Use pnpm" });
  const res = await handleBrainAction(bp(), { action: "list", type: "learning" });
  assertEq(res.ok, true, "list ok");
  // compact should NOT be raw JSON (no opening brace for an object/array)
  assert(!res.message.trimStart().startsWith("{"), "not raw JSON object");
  assert(!res.message.trimStart().startsWith("[{"), "not raw JSON array");
  // should contain the id and text
  assertIncludes(res.message, "Use pnpm", "contains text");
  cleanup();
}

// ==================================================================
// 21. list verbose=true → includes full JSON
// ==================================================================
console.log("\n--- 21. list verbose ---");
{
  setup();
  await handleBrainAction(bp(), { action: "add", type: "learning", text: "Use pnpm" });
  const res = await handleBrainAction(bp(), { action: "list", type: "learning", verbose: true });
  assertEq(res.ok, true, "list verbose ok");
  // verbose should have JSON structure markers
  assertIncludes(res.message, '"text"', "verbose includes JSON field names");
  assertIncludes(res.message, '"type"', "verbose includes type field");
  cleanup();
}

// ==================================================================
// 22. decay: old low-score learnings tombstoned, protected survive
// ==================================================================
console.log("\n--- 22. decay ---");
{
  setup();
  const brainFile = bp();

  // Write entries directly to control dates
  const now = new Date();
  const oldDate = new Date(now.getTime() - 120 * 24 * 60 * 60 * 1000); // 120 days ago
  const recentDate = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000); // 5 days ago

  // Old learning (should be decayed)
  await handleBrainAction(brainFile, { action: "add", type: "learning", text: "Old fact" });
  // Recent learning (should survive)
  await handleBrainAction(brainFile, { action: "add", type: "learning", text: "Recent fact" });
  // Manual old learning with high score should also survive (source=manual adds boost)
  await handleBrainAction(brainFile, { action: "add", type: "learning", text: "Manual important fact", source: "manual" });

  // Manually backdate the old entry
  const raw = fs.readFileSync(brainFile, "utf-8");
  const lines = raw.trim().split("\n");
  const entries = lines.map(l => JSON.parse(l));
  // Backdate the first entry (Old fact)
  entries[0].created = oldDate.toISOString();
  // Backdate the manual entry too
  entries[2].created = oldDate.toISOString();
  fs.writeFileSync(brainFile, entries.map(e => JSON.stringify(e)).join("\n") + "\n");

  const res = await handleBrainAction(brainFile, { action: "decay" }, {
    decayAfterDays: 90, decayMinScore: 3,
  });
  assertEq(res.ok, true, "decay ok");

  const brain = fold(brainFile);
  // Old fact (score ~0, age 120d) should be decayed
  assert(!brain.learnings.some(l => l.text === "Old fact"), "old low-score learning decayed");
  // Recent fact (score ~9, age 5d) should survive
  assert(brain.learnings.some(l => l.text === "Recent fact"), "recent learning survives");
  // Manual old fact (score ~0 recency + 2 manual = 2, still < 3) should be decayed
  // Actually let's check: recency = max(0, 10 - floor(120/7)) = max(0, 10 - 17) = 0. manual = 2. total = 2. < 3 → decayed.
  assert(!brain.learnings.some(l => l.text === "Manual important fact"), "manual old low-total-score decayed");
  cleanup();
}

// ==================================================================
// 23. task_done: sets status=done
// ==================================================================
console.log("\n--- 23. task_done ---");
{
  setup();
  await handleBrainAction(bp(), { action: "add", type: "task", description: "Ship it" });
  const brain1 = fold(bp());
  const taskId = brain1.tasks[0].id;

  const res = await handleBrainAction(bp(), { action: "task_done", id: taskId });
  assertEq(res.ok, true, "task_done ok");
  const brain2 = fold(bp());
  assertEq(brain2.tasks[0].status, "done", "status=done");
  assert(brain2.tasks[0].completedAt !== null, "completedAt set");
  cleanup();
}

// ==================================================================
// 24. task_clear: tombstones all done tasks
// ==================================================================
console.log("\n--- 24. task_clear ---");
{
  setup();
  await handleBrainAction(bp(), { action: "add", type: "task", description: "Done task" });
  await handleBrainAction(bp(), { action: "add", type: "task", description: "Pending task" });
  const brain1 = fold(bp());
  const doneId = brain1.tasks.find(t => t.description === "Done task")!.id;
  await handleBrainAction(bp(), { action: "task_done", id: doneId });

  const res = await handleBrainAction(bp(), { action: "task_clear" });
  assertEq(res.ok, true, "task_clear ok");
  const brain2 = fold(bp());
  assertEq(brain2.tasks.length, 1, "only pending task remains");
  assertEq(brain2.tasks[0].description, "Pending task", "pending task is the one that remains");
  cleanup();
}

// ==================================================================
// 25. reminder_run: records result, computes next_due for interval
// ==================================================================
console.log("\n--- 25. reminder_run ---");
{
  setup();
  await handleBrainAction(bp(), {
    action: "add", type: "reminder", text: "Check weather",
    enabled: true, cadence: { kind: "interval", every: "2h" },
  });
  const brain1 = fold(bp());
  const remId = brain1.reminders[0].id;

  const before = Date.now();
  const res = await handleBrainAction(bp(), {
    action: "reminder_run", id: remId, result: "ok",
  });
  const after = Date.now();
  assertEq(res.ok, true, "reminder_run ok");

  const brain2 = fold(bp());
  const rem = brain2.reminders[0];
  assertEq(rem.last_result, "ok", "last_result=ok");
  assert(rem.last_run !== null, "last_run set");
  assert(rem.next_due !== null, "next_due computed");

  // next_due should be ~2h from now
  const nextDueMs = new Date(rem.next_due!).getTime();
  const expectedMin = before + 2 * 3600 * 1000 - 5000; // 5s tolerance
  const expectedMax = after + 2 * 3600 * 1000 + 5000;
  assert(nextDueMs >= expectedMin && nextDueMs <= expectedMax, "next_due ~2h from now");
  cleanup();
}

// ==================================================================
// Summary
// ==================================================================
console.log(`\n--- Results: ${PASS} passed, ${FAIL} failed ---`);
process.exit(FAIL > 0 ? 1 : 0);
