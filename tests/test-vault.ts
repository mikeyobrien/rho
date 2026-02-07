/**
 * Tests for vault.ts core pure functions:
 * - parseFrontmatter
 * - extractWikilinks
 * - buildGraph (via buildGraphFromNotes helper)
 * - ensureVaultDirs
 * - verbatim trap guard (validateNote)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// Import the functions we'll implement
import {
  parseFrontmatter,
  extractWikilinks,
  buildGraph,
  ensureVaultDirs,
  validateNote,
  typeToDir,
  createDefaultFiles,
  captureToInbox,
  readNote,
  writeNote,
  getVaultStatus,
  listNotes,
  VAULT_DIR,
  VAULT_SUBDIRS,
  type VaultNote,
  type VaultGraph,
} from "../extensions/rho/index.ts";

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
    console.error(`  FAIL: ${label} — expected ${e}, got ${a}`);
    FAIL++;
  }
}

function assertIncludes(arr: string[], item: string, label: string): void {
  if (arr.includes(item)) {
    console.log(`  PASS: ${label}`);
    PASS++;
  } else {
    console.error(`  FAIL: ${label} — ${JSON.stringify(arr)} does not include "${item}"`);
    FAIL++;
  }
}

// ---- Test temp directory ----
const TEST_VAULT = path.join(os.tmpdir(), `vault-test-${Date.now()}`);

function setupTestVault(): void {
  fs.mkdirSync(TEST_VAULT, { recursive: true });
}

function cleanupTestVault(): void {
  if (fs.existsSync(TEST_VAULT)) {
    fs.rmSync(TEST_VAULT, { recursive: true, force: true });
  }
}

function writeTestNote(relativePath: string, content: string): void {
  const full = path.join(TEST_VAULT, relativePath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

// ==================================================
// parseFrontmatter tests
// ==================================================
console.log("\n--- parseFrontmatter ---");

{
  const result = parseFrontmatter(`---
type: concept
created: 2026-02-05
updated: 2026-02-05
tags: [memory, agent]
source: manual
---

# Test Note

Body text here.`);

  assertEq(result.type, "concept", "parses type field");
  assertEq(result.created, "2026-02-05", "parses created field");
  assertEq(result.updated, "2026-02-05", "parses updated field");
  assert(Array.isArray(result.tags), "tags is array");
  assertEq(result.tags, ["memory", "agent"], "parses tags array");
  assertEq(result.source, "manual", "parses source field");
}

{
  const result = parseFrontmatter(`---
type: log
created: 2026-02-05
---

# Daily Log`);

  assertEq(result.type, "log", "parses minimal frontmatter");
  assertEq(result.updated, undefined, "missing updated is undefined");
  assertEq(result.tags, undefined, "missing tags is undefined");
  assertEq(result.source, undefined, "missing source is undefined");
}

{
  const result = parseFrontmatter(`# No Frontmatter

Just body text.`);

  assertEq(result.type, undefined, "no frontmatter returns empty-ish object");
}

{
  const result = parseFrontmatter(`---
type: concept
created: 2026-02-05
updated: 2026-02-05
tags: [single]
---

# Single Tag`);

  assertEq(result.tags, ["single"], "parses single-item tags array");
}

{
  const result = parseFrontmatter(`---
type: pattern
created: 2026-01-01
updated: 2026-02-05
tags: []
source: conversation
---

# Empty tags`);

  assertEq(result.tags, [], "parses empty tags array");
}

// ==================================================
// extractWikilinks tests
// ==================================================
console.log("\n--- extractWikilinks ---");

{
  const links = extractWikilinks("This connects to [[agent-memory]] and more.");
  assertEq(links, ["agent-memory"], "extracts single wikilink");
}

{
  const links = extractWikilinks("See [[agent-memory]] and [[heartbeat]] for details.");
  assertEq(links, ["agent-memory", "heartbeat"], "extracts multiple wikilinks");
}

{
  const links = extractWikilinks("Applied in [[rho|the Rho project]] context.");
  assertEq(links, ["rho"], "extracts slug from display text syntax");
}

{
  const links = extractWikilinks("No links here at all.");
  assertEq(links, [], "returns empty array for no links");
}

{
  const links = extractWikilinks("Link [[a]] then [[b|B text]] then [[c]].");
  assertEq(links, ["a", "b", "c"], "mixed plain and display text links");
}

{
  const links = extractWikilinks("Duplicate [[foo]] and [[foo]] again.");
  assertEq(links, ["foo"], "deduplicates wikilinks");
}

{
  const links = extractWikilinks("Nested [[outer]] stuff [[inner-note|display]].");
  assertEq(links, ["outer", "inner-note"], "handles adjacent links");
}

// ==================================================
// buildGraph tests
// ==================================================
console.log("\n--- buildGraph ---");

setupTestVault();

writeTestNote("concepts/agent-memory.md", `---
type: concept
created: 2026-02-05
updated: 2026-02-05
tags: [memory]
source: manual
---

# Agent Memory

## Connections

- Related to [[heartbeat]] for maintenance
- Used by [[rho]]

## Body

Agent memory is important.`);

writeTestNote("concepts/heartbeat.md", `---
type: concept
created: 2026-02-05
updated: 2026-02-05
tags: [automation]
source: manual
---

# Heartbeat

## Connections

- Maintains [[agent-memory]]

## Body

The heartbeat runs periodically.`);

writeTestNote("patterns/orphan-note.md", `---
type: pattern
created: 2026-02-05
updated: 2026-02-05
tags: []
source: manual
---

# Orphan Note

## Connections

- Connects to [[nonexistent-note]]

## Body

Nobody links to this note.`);

writeTestNote("log/2026-02-05.md", `---
type: log
created: 2026-02-05
---

# 2026-02-05

Daily log entry. No connections needed.`);

{
  const graph = buildGraph(TEST_VAULT);

  assert(graph.size === 4, `graph has 4 notes (got ${graph.size})`);

  // Check agent-memory note
  const am = graph.get("agent-memory");
  assert(am !== undefined, "agent-memory exists in graph");
  if (am) {
    assertEq(am.type, "concept", "agent-memory type is concept");
    assert(am.links.has("heartbeat"), "agent-memory links to heartbeat");
    assert(am.links.has("rho"), "agent-memory links to rho");
    assertEq(am.links.size, 2, "agent-memory has 2 outgoing links");
    // backlinks: heartbeat links back
    assert(am.backlinks.has("heartbeat"), "agent-memory has backlink from heartbeat");
  }

  // Check heartbeat note
  const hb = graph.get("heartbeat");
  assert(hb !== undefined, "heartbeat exists in graph");
  if (hb) {
    assert(hb.links.has("agent-memory"), "heartbeat links to agent-memory");
    assert(hb.backlinks.has("agent-memory"), "heartbeat has backlink from agent-memory");
  }

  // Check orphan detection (orphan-note has no backlinks from existing notes)
  const orphan = graph.get("orphan-note");
  assert(orphan !== undefined, "orphan-note exists in graph");
  if (orphan) {
    assertEq(orphan.backlinks.size, 0, "orphan-note has 0 backlinks");
    assert(orphan.links.has("nonexistent-note"), "orphan-note links to nonexistent-note");
  }

  // Check log note
  const log = graph.get("2026-02-05");
  assert(log !== undefined, "log note exists in graph");
  if (log) {
    assertEq(log.type, "log", "log note type is log");
  }

  // Title extraction
  if (am) {
    assertEq(am.title, "Agent Memory", "extracts title from H1");
  }
}

cleanupTestVault();

// ==================================================
// ensureVaultDirs tests
// ==================================================
console.log("\n--- ensureVaultDirs ---");

{
  const testDir = path.join(os.tmpdir(), `vault-dirs-test-${Date.now()}`);
  ensureVaultDirs(testDir);

  assert(fs.existsSync(testDir), "vault root dir created");
  for (const sub of VAULT_SUBDIRS) {
    assert(fs.existsSync(path.join(testDir, sub)), `subdir ${sub} created`);
  }

  // Calling again should not error (idempotent)
  ensureVaultDirs(testDir);
  assert(fs.existsSync(testDir), "idempotent: vault dir still exists");

  fs.rmSync(testDir, { recursive: true, force: true });
}

// ==================================================
// validateNote (verbatim trap guard) tests
// ==================================================
console.log("\n--- validateNote ---");

{
  const validNote = `---
type: concept
created: 2026-02-05
updated: 2026-02-05
tags: [test]
---

# Valid Concept Note

## Connections

- Related to [[other-note]]

## Body

Content here.`;

  const result = validateNote(validNote, "concept");
  assert(result.valid, "valid concept note passes");
}

{
  const noFrontmatter = `# No Frontmatter

## Connections

- Link [[something]]`;

  const result = validateNote(noFrontmatter, "concept");
  assert(!result.valid, "rejects note without frontmatter");
  assert(result.reason!.includes("frontmatter"), `reason mentions frontmatter: ${result.reason}`);
}

{
  const noConnections = `---
type: concept
created: 2026-02-05
updated: 2026-02-05
---

# Missing Connections

## Body

No connections section here.`;

  const result = validateNote(noConnections, "concept");
  assert(!result.valid, "rejects concept without connections section");
  assert(result.reason!.includes("Connections"), `reason mentions Connections: ${result.reason}`);
}

{
  const noWikilinks = `---
type: concept
created: 2026-02-05
updated: 2026-02-05
---

# No Wikilinks

## Connections

- This has no actual wikilinks, just plain text

## Body

Missing links.`;

  const result = validateNote(noWikilinks, "concept");
  assert(!result.valid, "rejects concept with connections section but no wikilinks");
  assert(result.reason!.includes("wikilink"), `reason mentions wikilink: ${result.reason}`);
}

{
  const validLog = `---
type: log
created: 2026-02-05
---

# 2026-02-05

Daily log. No connections required.`;

  const result = validateNote(validLog, "log");
  assert(result.valid, "log type passes without connections");
}

{
  const logNoFrontmatter = `# Log Without Frontmatter

Daily stuff.`;

  const result = validateNote(logNoFrontmatter, "log");
  assert(!result.valid, "log still requires frontmatter");
}

{
  const patternNote = `---
type: pattern
created: 2026-02-05
updated: 2026-02-05
---

# Pattern Without Links

## Connections

- No actual [[link]] wait this has one

## Body

Hmm.`;

  const result = validateNote(patternNote, "pattern");
  assert(result.valid, "pattern with connections and wikilink passes");
}

{
  const referenceNote = `---
type: reference
created: 2026-02-05
updated: 2026-02-05
---

# Reference Note

## Body

No connections section.`;

  const result = validateNote(referenceNote, "reference");
  assert(!result.valid, "reference requires connections section");
}

// ==================================================
// typeToDir tests
// ==================================================
console.log("\n--- typeToDir ---");

{
  assertEq(typeToDir("concept"), "concepts", "concept -> concepts");
  assertEq(typeToDir("project"), "projects", "project -> projects");
  assertEq(typeToDir("pattern"), "patterns", "pattern -> patterns");
  assertEq(typeToDir("reference"), "references", "reference -> references");
  assertEq(typeToDir("log"), "log", "log -> log");
  assertEq(typeToDir("moc"), "", "moc -> root (empty string)");
  assertEq(typeToDir("unknown"), "", "unknown type -> root (empty string)");
}

// ==================================================
// createDefaultFiles tests
// ==================================================
console.log("\n--- createDefaultFiles ---");

{
  const testDir = path.join(os.tmpdir(), `vault-defaults-test-${Date.now()}`);
  ensureVaultDirs(testDir);
  createDefaultFiles(testDir);

  assert(fs.existsSync(path.join(testDir, "_index.md")), "_index.md created");
  assert(fs.existsSync(path.join(testDir, "_inbox.md")), "_inbox.md created");

  const indexContent = fs.readFileSync(path.join(testDir, "_index.md"), "utf-8");
  assert(indexContent.includes("type: moc"), "_index.md has moc type in frontmatter");
  assert(indexContent.includes("# Vault Index"), "_index.md has title");

  const inboxContent = fs.readFileSync(path.join(testDir, "_inbox.md"), "utf-8");
  assert(inboxContent.includes("# Inbox"), "_inbox.md has title");

  // Idempotent: doesn't overwrite existing files
  fs.writeFileSync(path.join(testDir, "_index.md"), "custom content");
  createDefaultFiles(testDir);
  const afterContent = fs.readFileSync(path.join(testDir, "_index.md"), "utf-8");
  assertEq(afterContent, "custom content", "createDefaultFiles does not overwrite existing");

  fs.rmSync(testDir, { recursive: true, force: true });
}

// ==================================================
// captureToInbox tests
// ==================================================
console.log("\n--- captureToInbox ---");

{
  const testDir = path.join(os.tmpdir(), `vault-capture-test-${Date.now()}`);
  ensureVaultDirs(testDir);
  createDefaultFiles(testDir);

  // Capture a simple entry
  const result1 = captureToInbox(testDir, "First capture entry");
  assert(result1.includes("First capture entry"), "capture result includes text");

  const inboxContent = fs.readFileSync(path.join(testDir, "_inbox.md"), "utf-8");
  assert(inboxContent.includes("First capture entry"), "inbox file contains captured text");
  assert(inboxContent.includes("---"), "inbox has separator");

  // Capture with source and context
  const result2 = captureToInbox(testDir, "Second entry", "conversation", "discussing vault design");
  assert(result2.includes("Second entry"), "second capture result includes text");
  assert(result2.includes("conversation"), "result includes source");

  const inboxAfter = fs.readFileSync(path.join(testDir, "_inbox.md"), "utf-8");
  assert(inboxAfter.includes("Second entry"), "inbox has second entry");
  assert(inboxAfter.includes("conversation"), "inbox has source");
  assert(inboxAfter.includes("discussing vault design"), "inbox has context");

  // Multiple captures append, don't overwrite
  assert(inboxAfter.includes("First capture entry"), "first entry still present after second capture");

  fs.rmSync(testDir, { recursive: true, force: true });
}

// ==================================================
// writeNote tests
// ==================================================
console.log("\n--- writeNote ---");

{
  const testDir = path.join(os.tmpdir(), `vault-write-test-${Date.now()}`);
  ensureVaultDirs(testDir);

  // Write a valid concept note
  const conceptContent = `---
type: concept
created: 2026-02-05
updated: 2026-02-05
tags: [test]
---

# Test Concept

## Connections

- Related to [[other-note]]

## Body

Test content.`;

  const result = writeNote(testDir, "test-concept", conceptContent, "concept");
  assert(result.valid, "valid concept note accepted by writeNote");
  assert(result.path !== undefined, "writeNote returns path");
  assert(result.path!.includes("concepts"), "concept placed in concepts/ dir");
  assert(fs.existsSync(result.path!), "file actually exists on disk");

  const written = fs.readFileSync(result.path!, "utf-8");
  assert(written.includes("# Test Concept"), "written content matches");

  // Write a log note (no connections required)
  const logContent = `---
type: log
created: 2026-02-05
---

# Daily Log

Just some notes.`;

  const logResult = writeNote(testDir, "2026-02-05-log", logContent, "log");
  assert(logResult.valid, "log note accepted");
  assert(logResult.path!.includes("log"), "log placed in log/ dir");

  // Reject invalid note (missing connections)
  const invalidContent = `---
type: concept
created: 2026-02-05
---

# Bad Note

No connections section.`;

  const invalidResult = writeNote(testDir, "bad-note", invalidContent, "concept");
  assert(!invalidResult.valid, "invalid note rejected by writeNote");
  assert(invalidResult.reason!.includes("Connections"), "reason explains rejection");
  assert(!fs.existsSync(path.join(testDir, "concepts", "bad-note.md")), "rejected note not written to disk");

  // Write a moc to root dir
  const mocContent = `---
type: moc
created: 2026-02-05
updated: 2026-02-05
---

# My MOC

## Connections

- Links to [[test-concept]]

## Body

Overview.`;

  const mocResult = writeNote(testDir, "my-moc", mocContent, "moc");
  assert(mocResult.valid, "moc note accepted");
  assertEq(mocResult.path!, path.join(testDir, "my-moc.md"), "moc placed in vault root");

  // Overwrite existing note
  const updatedConcept = `---
type: concept
created: 2026-02-05
updated: 2026-02-06
tags: [test, updated]
---

# Test Concept

## Connections

- Related to [[other-note]]
- Also see [[my-moc]]

## Body

Updated content.`;

  const updateResult = writeNote(testDir, "test-concept", updatedConcept, "concept");
  assert(updateResult.valid, "update accepted");
  const updatedContent = fs.readFileSync(updateResult.path!, "utf-8");
  assert(updatedContent.includes("Updated content"), "file updated on disk");
  assert(updatedContent.includes("2026-02-06"), "updated timestamp preserved");

  fs.rmSync(testDir, { recursive: true, force: true });
}

// ==================================================
// readNote tests
// ==================================================
console.log("\n--- readNote ---");

{
  const testDir = path.join(os.tmpdir(), `vault-read-test-${Date.now()}`);
  ensureVaultDirs(testDir);

  // Set up test notes
  writeNote(testDir, "alpha", `---
type: concept
created: 2026-02-05
updated: 2026-02-05
tags: [test]
---

# Alpha

## Connections

- Links to [[beta]]

## Body

Alpha content.`, "concept");

  writeNote(testDir, "beta", `---
type: concept
created: 2026-02-05
updated: 2026-02-05
tags: [test]
---

# Beta

## Connections

- Links to [[alpha]]

## Body

Beta content.`, "concept");

  // Build graph so backlinks are computed
  const graph = buildGraph(testDir);

  // Read alpha
  const alphaResult = readNote(testDir, "alpha", graph);
  assert(alphaResult !== null, "readNote returns result for existing note");
  assert(alphaResult!.content.includes("Alpha content"), "readNote returns content");
  assertIncludes(alphaResult!.backlinks, "beta", "alpha has backlink from beta");

  // Read beta
  const betaResult = readNote(testDir, "beta", graph);
  assert(betaResult !== null, "readNote returns result for beta");
  assertIncludes(betaResult!.backlinks, "alpha", "beta has backlink from alpha");

  // Read nonexistent note
  const missing = readNote(testDir, "nonexistent", graph);
  assert(missing === null, "readNote returns null for missing note");

  fs.rmSync(testDir, { recursive: true, force: true });
}

// ==================================================
// getVaultStatus tests
// ==================================================
console.log("\n--- getVaultStatus ---");

{
  const testDir = path.join(os.tmpdir(), `vault-status-test-${Date.now()}`);
  ensureVaultDirs(testDir);
  createDefaultFiles(testDir);

  // Write some notes of various types
  writeNote(testDir, "concept-a", `---
type: concept
created: 2026-02-05
updated: 2026-02-05
---

# Concept A

## Connections

- Links to [[concept-b]]

## Body

Content.`, "concept");

  writeNote(testDir, "concept-b", `---
type: concept
created: 2026-02-05
updated: 2026-02-05
---

# Concept B

## Connections

- Links to [[concept-a]]

## Body

Content.`, "concept");

  writeNote(testDir, "pattern-x", `---
type: pattern
created: 2026-02-05
updated: 2026-02-05
---

# Pattern X

## Connections

- See [[concept-a]]

## Body

Pattern content.`, "pattern");

  writeNote(testDir, "2026-02-05-log", `---
type: log
created: 2026-02-05
---

# Daily Log

Just some notes.`, "log");

  // Add some inbox entries
  captureToInbox(testDir, "First inbox item");
  captureToInbox(testDir, "Second inbox item");

  const graph = buildGraph(testDir);
  const status = getVaultStatus(testDir, graph);

  // 4 written notes + _index.md + _inbox.md = 6 total, but status should count properly
  // _index.md is type moc, _inbox.md has no frontmatter so type unknown
  assert(status.totalNotes === graph.size, `totalNotes matches graph size (${graph.size})`);
  assert(status.byType["concept"] === 2, `2 concept notes (got ${status.byType["concept"]})`);
  assert(status.byType["pattern"] === 1, `1 pattern note (got ${status.byType["pattern"]})`);
  assert(status.byType["log"] === 1, `1 log note (got ${status.byType["log"]})`);
  assert(status.byType["moc"] === 1, `1 moc note (_index.md) (got ${status.byType["moc"]})`);
  assert(status.inboxItems === 2, `2 inbox items (got ${status.inboxItems})`);
  assert(typeof status.orphanCount === "number", "orphanCount is a number");
  assert(typeof status.avgLinksPerNote === "number", "avgLinksPerNote is a number");
  assert(status.avgLinksPerNote > 0, `avgLinksPerNote > 0 (got ${status.avgLinksPerNote})`);

  // Orphan detection: pattern-x and 2026-02-05-log have no backlinks and don't start with _
  // _index.md also has no backlinks but it's special
  assert(status.orphanCount >= 2, `at least 2 orphans (got ${status.orphanCount})`);

  fs.rmSync(testDir, { recursive: true, force: true });
}

{
  // Empty vault status
  const testDir = path.join(os.tmpdir(), `vault-status-empty-${Date.now()}`);
  ensureVaultDirs(testDir);

  const graph = buildGraph(testDir);
  const status = getVaultStatus(testDir, graph);

  assertEq(status.totalNotes, 0, "empty vault has 0 notes");
  assertEq(status.inboxItems, 0, "empty vault has 0 inbox items");
  assertEq(status.orphanCount, 0, "empty vault has 0 orphans");
  assertEq(status.avgLinksPerNote, 0, "empty vault has 0 avg links");

  fs.rmSync(testDir, { recursive: true, force: true });
}

// ==================================================
// listNotes tests
// ==================================================
console.log("\n--- listNotes ---");

{
  const testDir = path.join(os.tmpdir(), `vault-list-test-${Date.now()}`);
  ensureVaultDirs(testDir);
  createDefaultFiles(testDir);

  writeNote(testDir, "agent-memory", `---
type: concept
created: 2026-02-01
updated: 2026-02-05
tags: [memory, agent]
---

# Agent Memory

## Connections

- Related to [[heartbeat]]

## Body

Memory content.`, "concept");

  writeNote(testDir, "heartbeat", `---
type: concept
created: 2026-02-02
updated: 2026-02-04
tags: [automation]
---

# Heartbeat System

## Connections

- Maintains [[agent-memory]]

## Body

Heartbeat content.`, "concept");

  writeNote(testDir, "retry-pattern", `---
type: pattern
created: 2026-02-03
updated: 2026-02-03
tags: [resilience]
---

# Retry Pattern

## Connections

- Applied in [[agent-memory]]

## Body

Retry content.`, "pattern");

  writeNote(testDir, "2026-02-05-log", `---
type: log
created: 2026-02-05
---

# Daily Log

Log content.`, "log");

  const graph = buildGraph(testDir);

  // List all notes
  const all = listNotes(graph);
  assert(all.length === graph.size, `list all returns all notes (${graph.size})`);

  // Each entry has required fields
  const first = all[0];
  assert(first.slug !== undefined, "entry has slug");
  assert(first.title !== undefined, "entry has title");
  assert(first.type !== undefined, "entry has type");
  assert(typeof first.linkCount === "number", "entry has linkCount");

  // Filter by type
  const concepts = listNotes(graph, "concept");
  assertEq(concepts.length, 2, "2 concept notes");
  assert(concepts.every(n => n.type === "concept"), "all filtered are concepts");

  const patterns = listNotes(graph, "pattern");
  assertEq(patterns.length, 1, "1 pattern note");

  const logs = listNotes(graph, "log");
  assertEq(logs.length, 1, "1 log note");

  // Filter by query (matches title or slug)
  const memoryResults = listNotes(graph, undefined, "memory");
  assert(memoryResults.some(n => n.slug === "agent-memory"), "query 'memory' finds agent-memory");

  const heartbeatResults = listNotes(graph, undefined, "heartbeat");
  assert(heartbeatResults.some(n => n.slug === "heartbeat"), "query 'heartbeat' finds heartbeat");

  // Filter by type AND query
  const conceptMemory = listNotes(graph, "concept", "memory");
  assertEq(conceptMemory.length, 1, "type+query narrows results");
  assertEq(conceptMemory[0].slug, "agent-memory", "finds agent-memory with type+query filter");

  // Query with no matches
  const noResults = listNotes(graph, undefined, "zzzznonexistent");
  assertEq(noResults.length, 0, "no results for nonexistent query");

  // Query is case-insensitive
  const upperQuery = listNotes(graph, undefined, "AGENT");
  assert(upperQuery.some(n => n.slug === "agent-memory"), "query is case-insensitive");

  fs.rmSync(testDir, { recursive: true, force: true });
}

// ==================================================
// Summary
// ==================================================
console.log(`\n--- Results: ${PASS} passed, ${FAIL} failed ---`);
process.exit(FAIL > 0 ? 1 : 0);
