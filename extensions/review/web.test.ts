import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { startReviewServer } from "./server.ts";
import type { ReviewFile } from "./files.ts";

const TEST_FILES: ReviewFile[] = [
  {
    path: "/tmp/test/hello.ts",
    relativePath: "hello.ts",
    content: 'console.log("hello");',
    language: "typescript",
  },
  {
    path: "/tmp/test/readme.md",
    relativePath: "readme.md",
    content: "# Hello",
    language: "markdown",
  },
];

function get(
  port: number,
  path: string
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}${path}`, (res) => {
      let body = "";
      res.on("data", (chunk) => (body += chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode!, headers: res.headers, body })
      );
    });
    req.on("error", reject);
  });
}

describe("Web UI Shell", () => {
  it("GET / returns HTML containing Alpine.js script tag and review.css link", async () => {
    const ac = new AbortController();
    const server = startReviewServer({
      files: TEST_FILES,
      signal: ac.signal,
      _skipOpen: true,
    });
    await new Promise((r) => setTimeout(r, 100));

    const res = await get(server._port!, "/");
    assert.equal(res.status, 200);
    assert.ok(res.body.includes("alpinejs"), "Should include Alpine.js CDN script");
    assert.ok(res.body.includes("review.css"), "Should link review.css");
    assert.ok(res.body.includes("review.js"), "Should link review.js");
    assert.ok(res.body.includes("highlight.js") || res.body.includes("highlight.min.js"),
      "Should include highlight.js CDN");
    assert.ok(res.body.includes('x-data="reviewApp()"'),
      "Body should have Alpine.js x-data binding");

    ac.abort();
    await server;
  });

  it("GET /api/files returns JSON matching input files", async () => {
    const ac = new AbortController();
    const server = startReviewServer({
      files: TEST_FILES,
      signal: ac.signal,
      _skipOpen: true,
    });
    await new Promise((r) => setTimeout(r, 100));

    const res = await get(server._port!, "/api/files");
    assert.equal(res.status, 200);
    assert.ok(
      res.headers["content-type"]?.includes("application/json"),
      "Should return JSON content-type"
    );

    const data = JSON.parse(res.body);
    assert.ok(Array.isArray(data), "Should return an array");
    assert.equal(data.length, 2);
    assert.equal(data[0].relativePath, "hello.ts");
    assert.equal(data[0].content, 'console.log("hello");');
    assert.equal(data[0].language, "typescript");
    assert.equal(data[1].relativePath, "readme.md");

    ac.abort();
    await server;
  });

  it("GET /js/review.js contains reviewApp function", async () => {
    const ac = new AbortController();
    const server = startReviewServer({
      files: TEST_FILES,
      signal: ac.signal,
      _skipOpen: true,
    });
    await new Promise((r) => setTimeout(r, 100));

    const res = await get(server._port!, "/js/review.js");
    assert.equal(res.status, 200);
    assert.ok(
      res.headers["content-type"]?.includes("text/javascript"),
      "Should return JS content-type"
    );
    assert.ok(res.body.includes("reviewApp"), "Should contain reviewApp function");

    ac.abort();
    await server;
  });

  it("GET /css/review.css contains --bg CSS variable", async () => {
    const ac = new AbortController();
    const server = startReviewServer({
      files: TEST_FILES,
      signal: ac.signal,
      _skipOpen: true,
    });
    await new Promise((r) => setTimeout(r, 100));

    const res = await get(server._port!, "/css/review.css");
    assert.equal(res.status, 200);
    assert.ok(
      res.headers["content-type"]?.includes("text/css"),
      "Should return CSS content-type"
    );
    assert.ok(res.body.includes("--bg"), "Should contain --bg CSS variable");

    ac.abort();
    await server;
  });
});

describe("Step 5 — Line Selection & Comment Form", () => {
  it("review.js contains activeComment state and interaction methods", async () => {
    const ac = new AbortController();
    const server = startReviewServer({
      files: TEST_FILES,
      signal: ac.signal,
      _skipOpen: true,
    });
    await new Promise((r) => setTimeout(r, 100));

    const res = await get(server._port!, "/js/review.js");
    assert.equal(res.status, 200);

    const required = [
      "activeComment",
      "onLineClick",
      "expandRangeUp",
      "expandRangeDown",
      "saveComment",
      "cancelComment",
      "isLineSelected",
      "getSelectedText",
    ];
    for (const name of required) {
      assert.ok(
        res.body.includes(name),
        `review.js should contain ${name}`
      );
    }

    ac.abort();
    await server;
  });

  it("review.js supports shift+click range selection", async () => {
    const ac = new AbortController();
    const server = startReviewServer({
      files: TEST_FILES,
      signal: ac.signal,
      _skipOpen: true,
    });
    await new Promise((r) => setTimeout(r, 100));

    const res = await get(server._port!, "/js/review.js");
    assert.equal(res.status, 200);
    assert.ok(
      res.body.includes("shiftKey"),
      "onLineClick should check event.shiftKey for range selection"
    );

    ac.abort();
    await server;
  });

  it("index.html renders comment form template with range controls", async () => {
    const ac = new AbortController();
    const server = startReviewServer({
      files: TEST_FILES,
      signal: ac.signal,
      _skipOpen: true,
    });
    await new Promise((r) => setTimeout(r, 100));

    const res = await get(server._port!, "/");
    assert.equal(res.status, 200);
    assert.ok(res.body.includes("comment-form"), "Should contain comment-form element");
    assert.ok(res.body.includes("comment-input"), "Should contain comment textarea");
    assert.ok(res.body.includes("comment-quote"), "Should contain quoted source blockquote");
    assert.ok(res.body.includes("range-controls"), "Should contain range expansion controls");
    assert.ok(res.body.includes("expandRangeUp"), "Should wire expandRangeUp button");
    assert.ok(res.body.includes("expandRangeDown"), "Should wire expandRangeDown button");

    ac.abort();
    await server;
  });

  it("index.html passes $event to onLineClick for shift detection", async () => {
    const ac = new AbortController();
    const server = startReviewServer({
      files: TEST_FILES,
      signal: ac.signal,
      _skipOpen: true,
    });
    await new Promise((r) => setTimeout(r, 100));

    const res = await get(server._port!, "/");
    assert.equal(res.status, 200);
    assert.ok(
      res.body.includes("$event"),
      "onLineClick should receive $event for shift-key detection"
    );

    ac.abort();
    await server;
  });

  it("index.html applies code-line--selected class conditionally", async () => {
    const ac = new AbortController();
    const server = startReviewServer({
      files: TEST_FILES,
      signal: ac.signal,
      _skipOpen: true,
    });
    await new Promise((r) => setTimeout(r, 100));

    const res = await get(server._port!, "/");
    assert.equal(res.status, 200);
    assert.ok(
      res.body.includes("code-line--selected"),
      "Template should conditionally apply code-line--selected class"
    );

    ac.abort();
    await server;
  });

  it("review.css contains comment form styles", async () => {
    const ac = new AbortController();
    const server = startReviewServer({
      files: TEST_FILES,
      signal: ac.signal,
      _skipOpen: true,
    });
    await new Promise((r) => setTimeout(r, 100));

    const res = await get(server._port!, "/css/review.css");
    assert.equal(res.status, 200);

    const selectors = [
      ".code-line--selected",
      ".comment-form",
      ".comment-form-header",
      ".range-controls",
      ".comment-quote",
      ".comment-input",
      ".comment-form-actions",
    ];
    for (const sel of selectors) {
      assert.ok(
        res.body.includes(sel),
        `CSS should contain ${sel} selector`
      );
    }

    ac.abort();
    await server;
  });
});

describe("Step 6 — Comment Management", () => {
  it("review.js contains comment CRUD methods", async () => {
    const ac = new AbortController();
    const server = startReviewServer({
      files: TEST_FILES,
      signal: ac.signal,
      _skipOpen: true,
    });
    await new Promise((r) => setTimeout(r, 100));

    const res = await get(server._port!, "/js/review.js");
    assert.equal(res.status, 200);

    const required = [
      "saveComment",
      "deleteComment",
      "editComment",
      "totalComments",
      "fileCommentCount",
      "getCommentsForLine",
      "isLineCommented",
    ];
    for (const name of required) {
      assert.ok(
        res.body.includes(name),
        `review.js should contain ${name}`
      );
    }

    ac.abort();
    await server;
  });

  it("index.html contains saved-comment elements", async () => {
    const ac = new AbortController();
    const server = startReviewServer({
      files: TEST_FILES,
      signal: ac.signal,
      _skipOpen: true,
    });
    await new Promise((r) => setTimeout(r, 100));

    const res = await get(server._port!, "/");
    assert.equal(res.status, 200);
    assert.ok(res.body.includes("saved-comment"), "Should contain saved-comment class");
    assert.ok(res.body.includes("saved-comment-header"), "Should contain saved-comment-header");
    assert.ok(res.body.includes("saved-comment-text"), "Should contain saved-comment-text");
    assert.ok(res.body.includes("editComment"), "Should wire editComment");
    assert.ok(res.body.includes("deleteComment"), "Should wire deleteComment");
    assert.ok(res.body.includes("code-line--commented"), "Should apply commented line class");

    ac.abort();
    await server;
  });

  it("review.css contains saved-comment styling", async () => {
    const ac = new AbortController();
    const server = startReviewServer({
      files: TEST_FILES,
      signal: ac.signal,
      _skipOpen: true,
    });
    await new Promise((r) => setTimeout(r, 100));

    const res = await get(server._port!, "/css/review.css");
    assert.equal(res.status, 200);

    const selectors = [
      ".saved-comment",
      ".saved-comment-header",
      ".saved-comment-text",
      ".saved-comment-quote",
      ".btn-icon",
      ".code-line--commented",
    ];
    for (const sel of selectors) {
      assert.ok(
        res.body.includes(sel),
        `CSS should contain ${sel} selector`
      );
    }

    ac.abort();
    await server;
  });
});

describe("Step 4 — Syntax Highlighting", () => {
  it("review.js contains hljs.highlight usage", async () => {
    const ac = new AbortController();
    const server = startReviewServer({
      files: TEST_FILES,
      signal: ac.signal,
      _skipOpen: true,
    });
    await new Promise((r) => setTimeout(r, 100));

    const res = await get(server._port!, "/js/review.js");
    assert.equal(res.status, 200);
    assert.ok(
      res.body.includes("hljs.highlight"),
      "review.js should use hljs.highlight for syntax highlighting"
    );

    ac.abort();
    await server;
  });

  it("index.html loads highlight.js language modules from CDN", async () => {
    const ac = new AbortController();
    const server = startReviewServer({
      files: TEST_FILES,
      signal: ac.signal,
      _skipOpen: true,
    });
    await new Promise((r) => setTimeout(r, 100));

    const res = await get(server._port!, "/");
    assert.equal(res.status, 200);

    const languages = ["typescript", "python", "rust", "go", "bash"];
    for (const lang of languages) {
      assert.ok(
        res.body.includes(`languages/${lang}.min.js`),
        `Should load ${lang} language module from CDN`
      );
    }

    ac.abort();
    await server;
  });

  it("index.html uses x-html for highlighted line content", async () => {
    const ac = new AbortController();
    const server = startReviewServer({
      files: TEST_FILES,
      signal: ac.signal,
      _skipOpen: true,
    });
    await new Promise((r) => setTimeout(r, 100));

    const res = await get(server._port!, "/");
    assert.equal(res.status, 200);
    assert.ok(
      res.body.includes("x-html") && res.body.includes("highlightedLines"),
      "Template should use x-html with highlightedLines for syntax-highlighted content"
    );

    ac.abort();
    await server;
  });

  it("review.css contains position: sticky for line number gutter", async () => {
    const ac = new AbortController();
    const server = startReviewServer({
      files: TEST_FILES,
      signal: ac.signal,
      _skipOpen: true,
    });
    await new Promise((r) => setTimeout(r, 100));

    const res = await get(server._port!, "/css/review.css");
    assert.equal(res.status, 200);
    assert.ok(
      res.body.includes("position: sticky"),
      "CSS should use position: sticky for line number gutter"
    );

    ac.abort();
    await server;
  });

  it("review.css has cursor: pointer on line numbers", async () => {
    const ac = new AbortController();
    const server = startReviewServer({
      files: TEST_FILES,
      signal: ac.signal,
      _skipOpen: true,
    });
    await new Promise((r) => setTimeout(r, 100));

    const res = await get(server._port!, "/css/review.css");
    assert.equal(res.status, 200);
    assert.ok(
      res.body.includes("cursor: pointer"),
      "Line numbers should have cursor: pointer for clickability"
    );

    ac.abort();
    await server;
  });
});
