import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { resolveFiles } from "./files.ts";

const TMP_DIR = join(import.meta.dirname ?? "/tmp", ".files-test-tmp");

describe("resolveFiles", () => {
  before(async () => {
    await mkdir(TMP_DIR, { recursive: true });
    // Normal file
    await writeFile(join(TMP_DIR, "small.ts"), 'console.log("hi");');
    // Large file (> 500KB)
    await writeFile(join(TMP_DIR, "huge.ts"), "x".repeat(600 * 1024));
    // Binary file (contains null bytes)
    const buf = Buffer.alloc(256);
    buf[0] = 0;
    await writeFile(join(TMP_DIR, "binary.bin"), buf);
  });

  after(async () => {
    await rm(TMP_DIR, { recursive: true, force: true });
  });

  it("loads a normal file", async () => {
    const { files, warnings } = await resolveFiles(["small.ts"], TMP_DIR);
    assert.equal(files.length, 1);
    assert.equal(files[0].relativePath, "small.ts");
    assert.equal(warnings.length, 0);
  });

  it("skips files over 500KB and reports a warning", async () => {
    const { files, warnings } = await resolveFiles(["huge.ts"], TMP_DIR);
    assert.equal(files.length, 0, "Large file should be skipped");
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes("Skipping large file"), `Expected large file warning, got: ${warnings[0]}`);
    assert.ok(warnings[0].includes("600KB") || warnings[0].includes("huge.ts"));
  });

  it("skips binary files and reports a warning", async () => {
    const { files, warnings } = await resolveFiles(["binary.bin"], TMP_DIR);
    assert.equal(files.length, 0, "Binary file should be skipped");
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes("Skipping binary file"));
  });

  it("skips missing files and reports a warning", async () => {
    const { files, warnings } = await resolveFiles(["nonexistent.ts"], TMP_DIR);
    assert.equal(files.length, 0);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes("Skipping missing"));
  });

  it("collects warnings across multiple files", async () => {
    const { files, warnings } = await resolveFiles(
      ["small.ts", "huge.ts", "nonexistent.ts"],
      TMP_DIR
    );
    assert.equal(files.length, 1, "Only small.ts should load");
    assert.equal(warnings.length, 2, "Should have 2 warnings (large + missing)");
  });
});
