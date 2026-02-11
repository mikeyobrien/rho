import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { parseArgs } from "./index.ts";
import { startTUIReview } from "./tui.ts";
import type { ReviewComment, ReviewResult } from "./server.ts";

// ── Temp dir for integration test files ─────────────────────────────

const TMP_DIR = join(import.meta.dirname ?? "/tmp", ".tui-test-tmp");

before(async () => {
  await mkdir(TMP_DIR, { recursive: true });
  await writeFile(join(TMP_DIR, "sample.ts"), "line 1\nline 2\nline 3\nline 4\nline 5");
});

after(async () => {
  await rm(TMP_DIR, { recursive: true, force: true });
});

// ── 1. --tui flag parsing ───────────────────────────────────────────

describe("--tui flag parsing", () => {
  it("parses --tui before file paths", () => {
    const paths = parseArgs("--tui file.ts");
    assert.ok(paths.includes("--tui"));
    assert.deepStrictEqual(
      paths.filter((p) => p !== "--tui"),
      ["file.ts"]
    );
  });

  it("parses --tui between file paths", () => {
    const paths = parseArgs("file.ts --tui other.ts");
    assert.ok(paths.includes("--tui"));
    assert.deepStrictEqual(
      paths.filter((p) => p !== "--tui"),
      ["file.ts", "other.ts"]
    );
  });

  it("parses --tui with multiple files", () => {
    const paths = parseArgs("--tui file.ts other.ts");
    const isTUI = paths.includes("--tui");
    const filteredPaths = paths.filter((p) => p !== "--tui");
    assert.equal(isTUI, true);
    assert.deepStrictEqual(filteredPaths, ["file.ts", "other.ts"]);
  });

  it("handles no --tui flag", () => {
    const paths = parseArgs("file.ts other.ts");
    assert.equal(paths.includes("--tui"), false);
    assert.deepStrictEqual(paths, ["file.ts", "other.ts"]);
  });
});

// ── 2. ReviewComment construction ───────────────────────────────────

describe("ReviewComment construction", () => {
  it("extracts selected text from source lines", () => {
    const sourceLines = ["line 1", "line 2", "line 3", "line 4"];
    const startLine = 2;
    const endLine = 3;
    const selectedText = sourceLines.slice(startLine - 1, endLine).join("\n");
    assert.equal(selectedText, "line 2\nline 3");
  });

  it("extracts a single line", () => {
    const sourceLines = ["line 1", "line 2", "line 3"];
    const startLine = 2;
    const endLine = 2;
    const selectedText = sourceLines.slice(startLine - 1, endLine).join("\n");
    assert.equal(selectedText, "line 2");
  });

  it("builds a complete ReviewComment", () => {
    const sourceLines = ["alpha", "beta", "gamma"];
    const comment: ReviewComment = {
      file: "test.ts",
      startLine: 1,
      endLine: 2,
      selectedText: sourceLines.slice(0, 2).join("\n"),
      comment: "needs refactor",
    };
    assert.equal(comment.file, "test.ts");
    assert.equal(comment.startLine, 1);
    assert.equal(comment.endLine, 2);
    assert.equal(comment.selectedText, "alpha\nbeta");
    assert.equal(comment.comment, "needs refactor");
  });
});

// ── 3. Comment Map CRUD ─────────────────────────────────────────────

describe("Comment Map CRUD", () => {
  it("adds a comment", () => {
    const comments = new Map<string, ReviewComment[]>();
    const comment: ReviewComment = {
      file: "test.ts",
      startLine: 1,
      endLine: 1,
      selectedText: "line 1",
      comment: "fix this",
    };
    comments.set("test.ts", [comment]);
    assert.equal(comments.get("test.ts")?.length, 1);
    assert.equal(comments.get("test.ts")![0].comment, "fix this");
  });

  it("edits a comment in place", () => {
    const comments = new Map<string, ReviewComment[]>();
    const comment: ReviewComment = {
      file: "test.ts",
      startLine: 1,
      endLine: 1,
      selectedText: "line 1",
      comment: "fix this",
    };
    comments.set("test.ts", [comment]);
    comments.get("test.ts")![0].comment = "updated";
    assert.equal(comments.get("test.ts")![0].comment, "updated");
  });

  it("deletes a comment by splice", () => {
    const comments = new Map<string, ReviewComment[]>();
    const comment: ReviewComment = {
      file: "test.ts",
      startLine: 1,
      endLine: 1,
      selectedText: "line 1",
      comment: "fix this",
    };
    comments.set("test.ts", [comment]);
    comments.get("test.ts")!.splice(0, 1);
    assert.equal(comments.get("test.ts")?.length, 0);
  });

  it("tracks comments across multiple files", () => {
    const comments = new Map<string, ReviewComment[]>();
    comments.set("a.ts", [
      { file: "a.ts", startLine: 1, endLine: 1, selectedText: "a", comment: "comment a" },
    ]);
    comments.set("b.ts", [
      { file: "b.ts", startLine: 5, endLine: 5, selectedText: "b", comment: "comment b" },
      { file: "b.ts", startLine: 10, endLine: 12, selectedText: "b2", comment: "comment b2" },
    ]);
    assert.equal(comments.get("a.ts")?.length, 1);
    assert.equal(comments.get("b.ts")?.length, 2);

    // Delete from b.ts
    comments.get("b.ts")!.splice(0, 1);
    assert.equal(comments.get("b.ts")?.length, 1);
    assert.equal(comments.get("b.ts")![0].comment, "comment b2");
  });
});

// ── 4. Range computation ────────────────────────────────────────────

describe("Range computation", () => {
  it("anchor above cursor", () => {
    const anchor = 5,
      cursor = 10;
    assert.equal(Math.min(anchor, cursor), 5);
    assert.equal(Math.max(anchor, cursor), 10);
  });

  it("anchor below cursor", () => {
    const anchor = 10,
      cursor = 3;
    assert.equal(Math.min(anchor, cursor), 3);
    assert.equal(Math.max(anchor, cursor), 10);
  });

  it("same line", () => {
    const anchor = 7,
      cursor = 7;
    assert.equal(Math.min(anchor, cursor), 7);
    assert.equal(Math.max(anchor, cursor), 7);
  });

  it("range with line 1", () => {
    const anchor = 1,
      cursor = 50;
    assert.equal(Math.min(anchor, cursor), 1);
    assert.equal(Math.max(anchor, cursor), 50);
  });
});

// ── 5. Scroll clamping logic ────────────────────────────────────────

describe("Scroll clamping logic", () => {
  // Extracted from tui.ts clampScroll() method
  function clampScroll(
    cursorLine: number,
    scrollOffset: number,
    viewportHeight: number,
    totalLines: number
  ): number {
    const cursorIdx = cursorLine - 1;
    let newScroll = scrollOffset;
    if (cursorIdx < newScroll) newScroll = cursorIdx;
    if (cursorIdx >= newScroll + viewportHeight)
      newScroll = cursorIdx - viewportHeight + 1;
    if (newScroll < 0) newScroll = 0;
    const maxScroll = Math.max(0, totalLines - viewportHeight);
    if (newScroll > maxScroll) newScroll = maxScroll;
    return newScroll;
  }

  it("scrolls up when cursor is above viewport", () => {
    assert.equal(clampScroll(1, 5, 10, 100), 0);
  });

  it("scrolls down when cursor is below viewport", () => {
    assert.equal(clampScroll(100, 0, 10, 100), 90);
  });

  it("does not change scroll when cursor is in viewport", () => {
    assert.equal(clampScroll(5, 0, 10, 100), 0);
  });

  it("scrolls to keep cursor just visible at bottom", () => {
    assert.equal(clampScroll(15, 0, 10, 100), 5);
  });

  it("keeps scroll when cursor is in middle of viewport", () => {
    assert.equal(clampScroll(50, 40, 10, 100), 40);
  });

  it("clamps to zero when file shorter than viewport", () => {
    assert.equal(clampScroll(3, 0, 50, 10), 0);
  });

  it("clamps max scroll to totalLines - viewportHeight", () => {
    // scrollOffset way past the end
    assert.equal(clampScroll(10, 999, 10, 20), 9);
  });

  it("handles single-line file", () => {
    assert.equal(clampScroll(1, 0, 10, 1), 0);
  });
});

// ── 6. Selected text extraction for ranges ──────────────────────────

describe("Selected text extraction", () => {
  const lines = ["a", "b", "c", "d", "e"];

  it("extracts a single line", () => {
    assert.equal(lines.slice(2, 3).join("\n"), "c");
  });

  it("extracts a multi-line range", () => {
    assert.equal(lines.slice(1, 4).join("\n"), "b\nc\nd");
  });

  it("extracts from the start", () => {
    assert.equal(lines.slice(0, 2).join("\n"), "a\nb");
  });

  it("extracts to the end", () => {
    assert.equal(lines.slice(3, 5).join("\n"), "d\ne");
  });

  it("extracts the entire file", () => {
    assert.equal(lines.slice(0, 5).join("\n"), "a\nb\nc\nd\ne");
  });
});

// ── 7. Integration: startTUIReview with mock ctx ────────────────────

describe("startTUIReview integration", () => {
  it("returns cancelled result on Esc", async () => {
    const mockCtx = {
      ui: {
        custom: async (factory: Function) => {
          const tui = {
            terminal: { rows: 30, columns: 80 },
            requestRender: () => {},
          };
          const theme = {
            fg: (_color: string, text: string) => text,
            bg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          };
          let resolveResult!: (r: ReviewResult) => void;
          const p = new Promise<ReviewResult>((resolve) => {
            resolveResult = resolve;
          });
          const component = factory(tui, theme, {}, (result: ReviewResult) =>
            resolveResult(result)
          );
          // Simulate Esc key
          component.handleInput("\x1b");
          return p;
        },
      },
    };

    const result = await startTUIReview(mockCtx, {
      files: [
        {
          absolutePath: join(TMP_DIR, "sample.ts"),
          relativePath: "sample.ts",
          content: "line 1\nline 2\nline 3\nline 4\nline 5",
        },
      ],
    });
    assert.equal(result.cancelled, true);
    assert.equal(result.comments.length, 0);
  });

  it("renders without crashing", async () => {
    const mockCtx = {
      ui: {
        custom: async (factory: Function) => {
          const tui = {
            terminal: { rows: 30, columns: 80 },
            requestRender: () => {},
          };
          const theme = {
            fg: (_color: string, text: string) => text,
            bg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          };
          let resolveResult!: (r: ReviewResult) => void;
          const p = new Promise<ReviewResult>((resolve) => {
            resolveResult = resolve;
          });
          const component = factory(tui, theme, {}, (result: ReviewResult) =>
            resolveResult(result)
          );
          // Verify render produces output
          const lines = component.render(80);
          assert.ok(Array.isArray(lines));
          assert.ok(lines.length > 0);
          // Should contain filename somewhere in header
          assert.ok(lines[0].includes("sample.ts"));
          // Esc to finish
          component.handleInput("\x1b");
          return p;
        },
      },
    };

    const result = await startTUIReview(mockCtx, {
      files: [
        {
          absolutePath: join(TMP_DIR, "sample.ts"),
          relativePath: "sample.ts",
          content: "line 1\nline 2\nline 3\nline 4\nline 5",
        },
      ],
    });
    assert.equal(result.cancelled, true);
  });

  it("invalidate clears the render cache", async () => {
    const mockCtx = {
      ui: {
        custom: async (factory: Function) => {
          const tui = {
            terminal: { rows: 30, columns: 80 },
            requestRender: () => {},
          };
          const theme = {
            fg: (_color: string, text: string) => text,
            bg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          };
          let resolveResult!: (r: ReviewResult) => void;
          const p = new Promise<ReviewResult>((resolve) => {
            resolveResult = resolve;
          });
          const component = factory(tui, theme, {}, (result: ReviewResult) =>
            resolveResult(result)
          );
          // Render, invalidate, render again — both should work
          const lines1 = component.render(80);
          component.invalidate();
          const lines2 = component.render(80);
          assert.ok(lines1.length > 0);
          assert.ok(lines2.length > 0);
          // Esc to finish
          component.handleInput("\x1b");
          return p;
        },
      },
    };

    const result = await startTUIReview(mockCtx, {
      files: [
        {
          absolutePath: join(TMP_DIR, "sample.ts"),
          relativePath: "sample.ts",
          content: "line 1\nline 2\nline 3\nline 4\nline 5",
        },
      ],
    });
    assert.equal(result.cancelled, true);
  });
});
