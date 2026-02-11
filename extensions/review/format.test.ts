import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { formatReviewMessage } from "./format.ts";
import type { ReviewComment } from "./server.ts";

describe("formatReviewMessage", () => {
  it("produces correct markdown for a single comment", () => {
    const comments: ReviewComment[] = [
      {
        file: "src/utils.ts",
        startLine: 12,
        endLine: 12,
        selectedText: "const data = fetch(url)",
        comment: "This should handle errors.",
      },
    ];

    const result = formatReviewMessage(comments);

    assert.ok(result.includes("## Review Comments"));
    assert.ok(result.includes("### src/utils.ts"));
    assert.ok(result.includes("**Line 12:**"));
    assert.ok(result.includes("> const data = fetch(url)"));
    assert.ok(result.includes("This should handle errors."));
    assert.ok(result.includes("summarize your plan"));
  });

  it("groups multiple comments under one file header", () => {
    const comments: ReviewComment[] = [
      {
        file: "src/app.ts",
        startLine: 5,
        endLine: 5,
        selectedText: "let x = 1",
        comment: "Use const.",
      },
      {
        file: "src/app.ts",
        startLine: 20,
        endLine: 20,
        selectedText: "console.log(x)",
        comment: "Remove debug logging.",
      },
    ];

    const result = formatReviewMessage(comments);

    // Only one file header
    const headers = result.split("### src/app.ts").length - 1;
    assert.equal(headers, 1);

    assert.ok(result.includes("**Line 5:**"));
    assert.ok(result.includes("**Line 20:**"));
    assert.ok(result.includes("Use const."));
    assert.ok(result.includes("Remove debug logging."));
  });

  it("gives each file its own header", () => {
    const comments: ReviewComment[] = [
      {
        file: "src/a.ts",
        startLine: 1,
        endLine: 1,
        selectedText: "import foo",
        comment: "Unused import.",
      },
      {
        file: "src/b.ts",
        startLine: 3,
        endLine: 3,
        selectedText: "return null",
        comment: "Should throw.",
      },
    ];

    const result = formatReviewMessage(comments);

    assert.ok(result.includes("### src/a.ts"));
    assert.ok(result.includes("### src/b.ts"));
  });

  it("shows Lines N-M for range comments", () => {
    const comments: ReviewComment[] = [
      {
        file: "design/plan.md",
        startLine: 42,
        endLine: 45,
        selectedText: "line one\nline two\nline three\nline four",
        comment: "Consider restructuring.",
      },
    ];

    const result = formatReviewMessage(comments);

    assert.ok(result.includes("**Lines 42-45:**"));
  });

  it("produces multi-line blockquote for multi-line selected text", () => {
    const comments: ReviewComment[] = [
      {
        file: "src/config.ts",
        startLine: 10,
        endLine: 12,
        selectedText: "const a = 1\nconst b = 2\nconst c = 3",
        comment: "Combine these.",
      },
    ];

    const result = formatReviewMessage(comments);

    assert.ok(result.includes("> const a = 1\n> const b = 2\n> const c = 3"));
  });

  it("returns minimal message for empty comments array", () => {
    const result = formatReviewMessage([]);

    assert.ok(result.includes("## Review Comments"));
    // Should still be a valid message, just no file sections
    assert.ok(!result.includes("###"));
  });

  it("preserves special characters in code", () => {
    const comments: ReviewComment[] = [
      {
        file: "src/render.tsx",
        startLine: 8,
        endLine: 8,
        selectedText: "const el = <div className={`foo-${bar}`}>",
        comment: "Use a variable for the class name.",
      },
    ];

    const result = formatReviewMessage(comments);

    assert.ok(
      result.includes("> const el = <div className={`foo-${bar}`}>")
    );
    assert.ok(result.includes("Use a variable for the class name."));
  });

  it("preserves comment order within a file", () => {
    const comments: ReviewComment[] = [
      {
        file: "src/main.ts",
        startLine: 100,
        endLine: 100,
        selectedText: "line 100",
        comment: "First comment.",
      },
      {
        file: "src/main.ts",
        startLine: 5,
        endLine: 5,
        selectedText: "line 5",
        comment: "Second comment.",
      },
    ];

    const result = formatReviewMessage(comments);

    const firstIdx = result.indexOf("First comment.");
    const secondIdx = result.indexOf("Second comment.");
    assert.ok(firstIdx < secondIdx, "Comments should preserve input order");
  });
});
