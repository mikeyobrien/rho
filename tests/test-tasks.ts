/**
 * Tests for tasks-core.ts pure functions.
 * Run: npx tsx tests/test-tasks.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  loadTasks,
  saveTasks,
  addTask,
  listTasks,
  completeTask,
  removeTask,
  clearDone,
  buildHeartbeatSection,
  generateId,
  findTaskById,
  formatTask,
  type Task,
} from "../extensions/rho/tasks-core.ts";

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

// ---- Test helpers ----
let testDir: string;
let testPath: string;

function setup(): void {
  testDir = path.join(os.tmpdir(), `tasks-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  fs.mkdirSync(testDir, { recursive: true });
  testPath = path.join(testDir, "tasks.jsonl");
}

function cleanup(): void {
  if (fs.existsSync(testDir)) {
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

// ==================================================
// generateId tests
// ==================================================
console.log("\n--- generateId ---");

{
  const id = generateId([]);
  assert(id.length === 8, `ID is 8 chars (got ${id.length})`);
  assert(/^[0-9a-f]{8}$/.test(id), `ID is hex: ${id}`);
}

{
  // Uniqueness
  const ids = new Set<string>();
  for (let i = 0; i < 100; i++) {
    ids.add(generateId([]));
  }
  assert(ids.size === 100, `100 generated IDs are all unique (got ${ids.size})`);
}

{
  // Avoids existing IDs
  const existing: Task[] = [
    {
      id: "aaaaaaaa",
      description: "test",
      status: "pending",
      priority: "normal",
      tags: [],
      created: new Date().toISOString(),
      due: null,
      completedAt: null,
    },
  ];
  const id = generateId(existing);
  assert(id !== "aaaaaaaa", "generated ID differs from existing");
}

// ==================================================
// loadTasks / saveTasks tests
// ==================================================
console.log("\n--- loadTasks / saveTasks ---");

setup();

{
  // Load from nonexistent file
  const tasks = loadTasks(testPath);
  assertEq(tasks.length, 0, "load from missing file returns empty array");
}

{
  // Save and load roundtrip
  const tasks: Task[] = [
    {
      id: "abc12345",
      description: "Test task",
      status: "pending",
      priority: "high",
      tags: ["code"],
      created: "2026-02-05T10:00:00.000Z",
      due: "2026-02-10",
      completedAt: null,
    },
    {
      id: "def67890",
      description: "Done task",
      status: "done",
      priority: "normal",
      tags: [],
      created: "2026-02-04T10:00:00.000Z",
      due: null,
      completedAt: "2026-02-05T09:00:00.000Z",
    },
  ];

  saveTasks(tasks, testPath);
  assert(fs.existsSync(testPath), "file exists after save");

  const loaded = loadTasks(testPath);
  assertEq(loaded.length, 2, "loaded 2 tasks");
  assertEq(loaded[0].id, "abc12345", "first task ID preserved");
  assertEq(loaded[0].priority, "high", "priority preserved");
  assertEq(loaded[0].tags, ["code"], "tags preserved");
  assertEq(loaded[1].status, "done", "status preserved");
  assertEq(loaded[1].completedAt, "2026-02-05T09:00:00.000Z", "completedAt preserved");
}

{
  // JSONL format validation
  const raw = fs.readFileSync(testPath, "utf-8").trim();
  const lines = raw.split("\n");
  assertEq(lines.length, 2, "JSONL has 2 lines");
  for (let i = 0; i < lines.length; i++) {
    let valid = true;
    try {
      JSON.parse(lines[i]);
    } catch {
      valid = false;
    }
    assert(valid, `line ${i + 1} is valid JSON`);
  }
}

{
  // Load from empty file
  fs.writeFileSync(testPath, "", "utf-8");
  const tasks = loadTasks(testPath);
  assertEq(tasks.length, 0, "load from empty file returns empty array");
}

{
  // Load from corrupted file (partial JSON)
  fs.writeFileSync(testPath, "not json\n", "utf-8");
  const tasks = loadTasks(testPath);
  assertEq(tasks.length, 0, "load from corrupted file returns empty (graceful)");
}

cleanup();

// ==================================================
// addTask tests
// ==================================================
console.log("\n--- addTask ---");

setup();

{
  const result = addTask({ description: "Fix the login bug" }, testPath);
  assert(result.ok, "add returns ok");
  assert(result.task !== undefined, "add returns task");
  assertEq(result.task!.status, "pending", "new task is pending");
  assertEq(result.task!.priority, "normal", "default priority is normal");
  assertEq(result.task!.tags.length, 0, "no tags by default");
  assert(result.task!.id.length === 8, "ID is 8 chars");
  assert(result.task!.due === null, "no due date by default");

  // Verify persisted
  const loaded = loadTasks(testPath);
  assertEq(loaded.length, 1, "task persisted to file");
  assertEq(loaded[0].description, "Fix the login bug", "description persisted");
}

{
  // Add with priority
  const result = addTask({ description: "Ship v1", priority: "high" }, testPath);
  assert(result.ok, "add with priority ok");
  assertEq(result.task!.priority, "high", "priority set to high");
}

{
  // Add with due date
  const result = addTask({ description: "Write blog post", due: "2026-02-10" }, testPath);
  assert(result.ok, "add with due date ok");
  assertEq(result.task!.due, "2026-02-10", "due date set");
}

{
  // Add with tags
  const result = addTask({ description: "Refactor auth", tags: "code, rho" }, testPath);
  assert(result.ok, "add with tags ok");
  assertEq(result.task!.tags, ["code", "rho"], "tags parsed and trimmed");
}

{
  // Empty description fails
  const result = addTask({ description: "" }, testPath);
  assert(!result.ok, "empty description rejected");
  assertIncludes(result.message, "description", "error mentions description");
}

{
  // Whitespace-only description fails
  const result = addTask({ description: "   " }, testPath);
  assert(!result.ok, "whitespace description rejected");
}

{
  // Invalid priority
  const result = addTask({ description: "test", priority: "super" as any }, testPath);
  assert(!result.ok, "invalid priority rejected");
  assertIncludes(result.message, "invalid priority", "error mentions priority");
}

{
  // Invalid due date format
  const result = addTask({ description: "test", due: "next week" }, testPath);
  assert(!result.ok, "invalid due date rejected");
  assertIncludes(result.message, "YYYY-MM-DD", "error mentions format");
}

cleanup();

// ==================================================
// listTasks tests
// ==================================================
console.log("\n--- listTasks ---");

setup();

{
  // List empty
  const result = listTasks("pending", testPath);
  assert(result.ok, "list empty is ok");
  assertEq(result.count, 0, "count is 0");
  assertIncludes(result.message, "No pending tasks", "message says no pending tasks");
}

{
  // Add some tasks
  addTask({ description: "Task A", priority: "low" }, testPath);
  addTask({ description: "Task B", priority: "urgent" }, testPath);
  addTask({ description: "Task C", priority: "high", tags: "code" }, testPath);

  // List pending (default)
  const result = listTasks(undefined, testPath);
  assert(result.ok, "list ok");
  assertEq(result.count, 3, "3 pending tasks");
  assert(result.tasks!.length === 3, "tasks array has 3 items");

  // Check priority ordering: urgent first, then high, then low
  assertEq(result.tasks![0].priority, "urgent", "urgent first");
  assertEq(result.tasks![1].priority, "high", "high second");
  assertEq(result.tasks![2].priority, "low", "low last");
}

{
  // Complete one task
  const tasks = loadTasks(testPath);
  const taskA = tasks.find((t) => t.description === "Task A")!;
  completeTask(taskA.id, testPath);

  // List pending should show 2
  const pending = listTasks("pending", testPath);
  assertEq(pending.count, 2, "2 pending after completing one");

  // List all should show 3
  const all = listTasks("all", testPath);
  assertEq(all.count, 3, "3 total with all filter");

  // List done should show 1
  const done = listTasks("done", testPath);
  assertEq(done.count, 1, "1 done task");
}

{
  // Filter by tag
  const tagged = listTasks("code", testPath);
  assertEq(tagged.count, 1, "1 task with tag 'code'");
  assertEq(tagged.tasks![0].tags.includes("code"), true, "filtered task has code tag");
}

{
  // Filter by nonexistent tag
  const nope = listTasks("nonexistent", testPath);
  assertEq(nope.count, 0, "0 tasks with nonexistent tag");
}

cleanup();

// ==================================================
// completeTask tests
// ==================================================
console.log("\n--- completeTask ---");

setup();

{
  const added = addTask({ description: "Complete me" }, testPath);
  const id = added.task!.id;

  // Complete it
  const result = completeTask(id, testPath);
  assert(result.ok, "complete ok");
  assertEq(result.task!.status, "done", "status is done");
  assert(result.task!.completedAt !== null, "completedAt set");
  assertIncludes(result.message, "Done:", "message says Done:");

  // Verify persisted
  const loaded = loadTasks(testPath);
  assertEq(loaded[0].status, "done", "done status persisted");
}

{
  // Complete again (already done)
  const tasks = loadTasks(testPath);
  const result = completeTask(tasks[0].id, testPath);
  assert(result.ok, "completing already-done is ok (idempotent)");
  assertIncludes(result.message, "already done", "message says already done");
}

{
  // Complete nonexistent
  const result = completeTask("nonexistent", testPath);
  assert(!result.ok, "nonexistent task fails");
  assertIncludes(result.message, "not found", "error says not found");
}

{
  // Empty ID
  const result = completeTask("", testPath);
  assert(!result.ok, "empty ID fails");
}

cleanup();

// ==================================================
// findTaskById (prefix matching) tests
// ==================================================
console.log("\n--- findTaskById ---");

{
  const tasks: Task[] = [
    { id: "abc12345", description: "A", status: "pending", priority: "normal", tags: [], created: "", due: null, completedAt: null },
    { id: "abc1abcd", description: "B", status: "pending", priority: "normal", tags: [], created: "", due: null, completedAt: null },
    { id: "def12345", description: "C", status: "pending", priority: "normal", tags: [], created: "", due: null, completedAt: null },
  ];

  // Exact match
  const exact = findTaskById(tasks, "abc12345");
  assertEq(exact?.description, "A", "exact match works");

  // Prefix match (unambiguous, 4+ chars)
  const prefix = findTaskById(tasks, "def1");
  assertEq(prefix?.description, "C", "prefix match works (4 chars)");

  // Ambiguous prefix (both abc12345 and abc1abcd start with "abc1")
  const ambiguous = findTaskById(tasks, "abc1");
  assert(ambiguous === null, "ambiguous prefix returns null");

  // Disambiguated prefix
  const unambiguous = findTaskById(tasks, "abc12");
  assertEq(unambiguous?.description, "A", "longer prefix disambiguates");

  // Too short prefix (< 4 chars)
  const short = findTaskById(tasks, "ab");
  assert(short === null, "prefix < 4 chars returns null");

  // No match
  const none = findTaskById(tasks, "zzz99999");
  assert(none === null, "no match returns null");
}

// ==================================================
// removeTask tests
// ==================================================
console.log("\n--- removeTask ---");

setup();

{
  addTask({ description: "Remove me" }, testPath);
  addTask({ description: "Keep me" }, testPath);

  const tasks = loadTasks(testPath);
  const toRemove = tasks.find((t) => t.description === "Remove me")!;

  const result = removeTask(toRemove.id, testPath);
  assert(result.ok, "remove ok");
  assertIncludes(result.message, "Removed:", "message says Removed:");

  const remaining = loadTasks(testPath);
  assertEq(remaining.length, 1, "1 task remaining");
  assertEq(remaining[0].description, "Keep me", "correct task kept");
}

{
  // Remove nonexistent
  const result = removeTask("nonexistent", testPath);
  assert(!result.ok, "remove nonexistent fails");
  assertIncludes(result.message, "not found", "error says not found");
}

{
  // Empty ID
  const result = removeTask("", testPath);
  assert(!result.ok, "remove empty ID fails");
}

cleanup();

// ==================================================
// clearDone tests
// ==================================================
console.log("\n--- clearDone ---");

setup();

{
  // Clear when nothing done
  const result = clearDone(testPath);
  assert(result.ok, "clear empty is ok");
  assertEq(result.count, 0, "cleared 0");
}

{
  addTask({ description: "Pending task" }, testPath);
  const added1 = addTask({ description: "Done 1" }, testPath);
  const added2 = addTask({ description: "Done 2" }, testPath);
  completeTask(added1.task!.id, testPath);
  completeTask(added2.task!.id, testPath);

  // Should be 1 pending + 2 done = 3 total
  assertEq(loadTasks(testPath).length, 3, "3 tasks before clear");

  const result = clearDone(testPath);
  assert(result.ok, "clear done ok");
  assertEq(result.count, 2, "cleared 2 done tasks");

  const remaining = loadTasks(testPath);
  assertEq(remaining.length, 1, "1 task remaining");
  assertEq(remaining[0].description, "Pending task", "pending task kept");
}

cleanup();

// ==================================================
// buildHeartbeatSection tests
// ==================================================
console.log("\n--- buildHeartbeatSection ---");

setup();

{
  // No tasks
  const section = buildHeartbeatSection(testPath);
  assert(section === null, "null when no tasks");
}

{
  addTask({ description: "Deploy fix" }, testPath);
  addTask({ description: "Write tests", priority: "high" }, testPath);

  const section = buildHeartbeatSection(testPath);
  assert(section !== null, "section present with tasks");
  assertIncludes(section!, "Pending tasks (2)", "shows count");
  assertIncludes(section!, "Deploy fix", "includes task description");
  assertIncludes(section!, "Write tests", "includes second task");
  assertIncludes(section!, "(high)", "shows non-normal priority");
}

{
  // Add overdue task
  addTask({ description: "Overdue thing", due: "2020-01-01" }, testPath);

  const section = buildHeartbeatSection(testPath);
  assert(section !== null, "section present");
  assertIncludes(section!, "OVERDUE", "overdue task flagged");
  assertIncludes(section!, "Overdue thing", "overdue description shown");
}

{
  // Only done tasks (no pending)
  cleanup();
  setup();
  const added = addTask({ description: "Done task" }, testPath);
  completeTask(added.task!.id, testPath);

  const section = buildHeartbeatSection(testPath);
  assert(section === null, "null when only done tasks");
}

{
  // Tags shown
  cleanup();
  setup();
  addTask({ description: "Tagged task", tags: "code,rho" }, testPath);

  const section = buildHeartbeatSection(testPath);
  assert(section !== null, "section present");
  assertIncludes(section!, "[code, rho]", "tags shown in heartbeat");
}

{
  // Future due date (not overdue)
  cleanup();
  setup();
  addTask({ description: "Future task", due: "2099-12-31" }, testPath);

  const section = buildHeartbeatSection(testPath);
  assert(section !== null, "section present");
  assertIncludes(section!, "(due 2099-12-31)", "future due shown without OVERDUE");
  assert(!section!.includes("OVERDUE"), "not flagged as overdue");
}

cleanup();

// ==================================================
// formatTask tests
// ==================================================
console.log("\n--- formatTask ---");

{
  const task: Task = {
    id: "abc12345",
    description: "Simple task",
    status: "pending",
    priority: "normal",
    tags: [],
    created: "2026-02-05T10:00:00.000Z",
    due: null,
    completedAt: null,
  };

  const line = formatTask(task);
  assertIncludes(line, "[ ]", "pending shows [ ]");
  assertIncludes(line, "[abc12345]", "ID shown");
  assertIncludes(line, "Simple task", "description shown");
  assert(!line.includes("(normal)"), "normal priority not explicitly shown");
}

{
  const task: Task = {
    id: "def67890",
    description: "Urgent fix",
    status: "done",
    priority: "urgent",
    tags: ["code", "rho"],
    created: "2026-02-05T10:00:00.000Z",
    due: "2026-02-10",
    completedAt: "2026-02-06T12:00:00.000Z",
  };

  const line = formatTask(task);
  assertIncludes(line, "[x]", "done shows [x]");
  assertIncludes(line, "(urgent)", "non-normal priority shown");
  assertIncludes(line, "due:2026-02-10", "due date shown");
  assertIncludes(line, "#code", "tag shown with #");
  assertIncludes(line, "#rho", "second tag shown");
  assertIncludes(line, "done:2026-02-06", "completion date shown");
}

// ==================================================
// Integration: rapid additions don't corrupt
// ==================================================
console.log("\n--- rapid additions ---");

setup();

{
  for (let i = 0; i < 20; i++) {
    addTask({ description: `Rapid task ${i}` }, testPath);
  }

  const loaded = loadTasks(testPath);
  assertEq(loaded.length, 20, "20 rapid tasks persisted");

  // Verify JSONL integrity
  const raw = fs.readFileSync(testPath, "utf-8").trim();
  const lines = raw.split("\n");
  assertEq(lines.length, 20, "20 JSONL lines");

  let allValid = true;
  for (const line of lines) {
    try {
      JSON.parse(line);
    } catch {
      allValid = false;
    }
  }
  assert(allValid, "all 20 lines are valid JSON");

  // All IDs unique
  const ids = new Set(loaded.map((t) => t.id));
  assertEq(ids.size, 20, "all 20 IDs unique");
}

cleanup();

// ==================================================
// Summary
// ==================================================
console.log(`\n--- Results: ${PASS} passed, ${FAIL} failed ---`);
process.exit(FAIL > 0 ? 1 : 0);
