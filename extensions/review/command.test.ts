import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseArgs } from "./index.ts";

describe("parseArgs", () => {
  it("parses a single bare path", () => {
    assert.deepEqual(parseArgs("file.ts"), ["file.ts"]);
  });

  it("parses multiple bare paths", () => {
    assert.deepEqual(parseArgs("file1.ts file2.ts"), ["file1.ts", "file2.ts"]);
  });

  it("parses double-quoted paths with spaces", () => {
    assert.deepEqual(parseArgs('"my file.ts" other.ts'), [
      "my file.ts",
      "other.ts",
    ]);
  });

  it("parses single-quoted paths with spaces", () => {
    assert.deepEqual(parseArgs("'single quoted.ts' bare.ts"), [
      "single quoted.ts",
      "bare.ts",
    ]);
  });

  it("parses glob patterns as bare words", () => {
    assert.deepEqual(parseArgs("src/*.ts"), ["src/*.ts"]);
  });

  it("returns empty array for empty string", () => {
    assert.deepEqual(parseArgs(""), []);
  });

  it("returns empty array for whitespace-only input", () => {
    assert.deepEqual(parseArgs("   "), []);
  });

  it("handles mixed double-quoted, single-quoted, and bare args", () => {
    assert.deepEqual(parseArgs('"a b.ts" \'c d.ts\' e.ts'), [
      "a b.ts",
      "c d.ts",
      "e.ts",
    ]);
  });

  it("handles multiple glob patterns", () => {
    assert.deepEqual(parseArgs("src/*.ts **/*.md"), ["src/*.ts", "**/*.md"]);
  });

  it("handles extra whitespace between args", () => {
    assert.deepEqual(parseArgs("  file1.ts   file2.ts  "), [
      "file1.ts",
      "file2.ts",
    ]);
  });
});
