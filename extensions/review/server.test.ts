import { describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import WebSocket from "ws";

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
    path: "/tmp/test/style.css",
    relativePath: "style.css",
    content: "body { color: red; }",
    language: "css",
  },
];

/** Helper: GET request with no keep-alive */
function get(
  port: number,
  path: string
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(`http://127.0.0.1:${port}${path}`, { agent: false }, (res) => {
        let body = "";
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode!, headers: res.headers, body })
        );
      })
      .on("error", reject);
  });
}

/** Helper: wait for server to bind */
function waitForPort(
  promise: ReturnType<typeof startReviewServer>
): Promise<number> {
  return new Promise((resolve) => {
    const check = () => {
      if (promise._port) return resolve(promise._port);
      setTimeout(check, 10);
    };
    check();
  });
}

/**
 * Helper: connect a WebSocket and collect the init message.
 * Sets up the message listener BEFORE the connection opens
 * to avoid a race where the init message fires before the
 * listener is attached.
 */
function connectWs(
  port: number
): Promise<{ ws: WebSocket; initMsg: any }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    // Capture first message (init) before open resolves
    ws.once("message", (raw) => {
      const initMsg = JSON.parse(String(raw));
      resolve({ ws, initMsg });
    });
    ws.on("error", reject);
  });
}

describe("ReviewServer", () => {
  it("starts and listens on a port > 0", async () => {
    const ac = new AbortController();
    const serverPromise = startReviewServer({
      files: TEST_FILES,
      signal: ac.signal,
      _skipOpen: true,
    });
    const port = await waitForPort(serverPromise);

    const res = await get(port, "/api/files");
    assert.equal(res.status, 200);
    assert.ok(port > 0, "Port should be > 0");

    ac.abort();
    await serverPromise;
  });

  it("GET / returns index.html with text/html content-type", async () => {
    const ac = new AbortController();
    const serverPromise = startReviewServer({
      files: TEST_FILES,
      signal: ac.signal,
      _skipOpen: true,
    });
    const port = await waitForPort(serverPromise);

    const res = await get(port, "/");
    assert.equal(res.status, 200);
    assert.ok(
      res.headers["content-type"]?.includes("text/html"),
      `Expected text/html, got ${res.headers["content-type"]}`
    );
    assert.ok(res.body.includes("<!DOCTYPE html>"), "Should contain HTML doctype");

    ac.abort();
    await serverPromise;
  });

  it("GET /css/review.css returns CSS with text/css content-type", async () => {
    const ac = new AbortController();
    const serverPromise = startReviewServer({
      files: TEST_FILES,
      signal: ac.signal,
      _skipOpen: true,
    });
    const port = await waitForPort(serverPromise);

    const res = await get(port, "/css/review.css");
    assert.equal(res.status, 200);
    assert.ok(
      res.headers["content-type"]?.includes("text/css"),
      `Expected text/css, got ${res.headers["content-type"]}`
    );
    assert.ok(res.body.includes("body"), "Should contain CSS content");

    ac.abort();
    await serverPromise;
  });

  it("GET /js/review.js returns JS with text/javascript content-type", async () => {
    const ac = new AbortController();
    const serverPromise = startReviewServer({
      files: TEST_FILES,
      signal: ac.signal,
      _skipOpen: true,
    });
    const port = await waitForPort(serverPromise);

    const res = await get(port, "/js/review.js");
    assert.equal(res.status, 200);
    assert.ok(
      res.headers["content-type"]?.includes("text/javascript"),
      `Expected text/javascript, got ${res.headers["content-type"]}`
    );
    assert.ok(res.body.includes("reviewApp"), "Should contain JS content");

    ac.abort();
    await serverPromise;
  });

  it("GET /api/files returns file data as JSON array", async () => {
    const ac = new AbortController();
    const serverPromise = startReviewServer({
      files: TEST_FILES,
      signal: ac.signal,
      _skipOpen: true,
    });
    const port = await waitForPort(serverPromise);

    const res = await get(port, "/api/files");
    assert.equal(res.status, 200);
    assert.ok(
      res.headers["content-type"]?.includes("application/json"),
      `Expected application/json, got ${res.headers["content-type"]}`
    );

    const data = JSON.parse(res.body);
    assert.ok(Array.isArray(data), "Should return an array");
    assert.equal(data.length, 2);
    assert.equal(data[0].relativePath, "hello.ts");
    assert.equal(data[0].language, "typescript");
    assert.equal(data[1].relativePath, "style.css");

    ac.abort();
    await serverPromise;
  });

  it("GET /api/config returns message when provided", async () => {
    const ac = new AbortController();
    const serverPromise = startReviewServer({
      files: TEST_FILES,
      message: "Please review the auth changes",
      signal: ac.signal,
      _skipOpen: true,
    });
    const port = await waitForPort(serverPromise);

    const res = await get(port, "/api/config");
    assert.equal(res.status, 200);
    assert.ok(
      res.headers["content-type"]?.includes("application/json"),
      `Expected application/json, got ${res.headers["content-type"]}`
    );

    const data = JSON.parse(res.body);
    assert.equal(data.message, "Please review the auth changes");

    ac.abort();
    await serverPromise;
  });

  it("GET /api/config returns empty object when no message", async () => {
    const ac = new AbortController();
    const serverPromise = startReviewServer({
      files: TEST_FILES,
      signal: ac.signal,
      _skipOpen: true,
    });
    const port = await waitForPort(serverPromise);

    const res = await get(port, "/api/config");
    assert.equal(res.status, 200);

    const data = JSON.parse(res.body);
    assert.deepEqual(data, {});

    ac.abort();
    await serverPromise;
  });

  it("GET /nonexistent returns 404", async () => {
    const ac = new AbortController();
    const serverPromise = startReviewServer({
      files: TEST_FILES,
      signal: ac.signal,
      _skipOpen: true,
    });
    const port = await waitForPort(serverPromise);

    const res = await get(port, "/nonexistent");
    assert.equal(res.status, 404);

    ac.abort();
    await serverPromise;
  });

  it("AbortSignal cancellation resolves with cancelled result", async () => {
    const ac = new AbortController();
    const serverPromise = startReviewServer({
      files: TEST_FILES,
      signal: ac.signal,
      _skipOpen: true,
    });
    await waitForPort(serverPromise);

    ac.abort();
    const result = await serverPromise;

    assert.deepEqual(result, { comments: [], cancelled: true });
  });

  it("server shuts down cleanly after abort", async () => {
    const ac = new AbortController();
    const serverPromise = startReviewServer({
      files: TEST_FILES,
      signal: ac.signal,
      _skipOpen: true,
    });
    const port = await waitForPort(serverPromise);

    ac.abort();
    await serverPromise;

    // Server should no longer accept connections
    await new Promise((r) => setTimeout(r, 50));
    try {
      await get(port, "/");
      assert.fail("Should not be able to connect after shutdown");
    } catch (err: any) {
      assert.ok(
        err.code === "ECONNREFUSED" || err.code === "ECONNRESET",
        `Expected connection error, got ${err.code}`
      );
    }
  });
});

describe("ReviewServer onReady callback", () => {
  it("calls onReady with correct URL after server starts", async () => {
    const ac = new AbortController();
    let readyUrl: string | undefined;

    const serverPromise = startReviewServer({
      files: TEST_FILES,
      signal: ac.signal,
      _skipOpen: true,
      onReady: (url) => { readyUrl = url; },
    });
    const port = await waitForPort(serverPromise);

    assert.ok(readyUrl, "onReady should have been called");
    assert.equal(readyUrl, `http://127.0.0.1:${port}`);

    ac.abort();
    await serverPromise;
  });
});

describe("ReviewServer warnings API", () => {
  it("GET /api/warnings returns empty array when no warnings", async () => {
    const ac = new AbortController();
    const serverPromise = startReviewServer({
      files: TEST_FILES,
      signal: ac.signal,
      _skipOpen: true,
    });
    const port = await waitForPort(serverPromise);

    const res = await get(port, "/api/warnings");
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), []);

    ac.abort();
    await serverPromise;
  });

  it("GET /api/warnings returns provided warnings", async () => {
    const ac = new AbortController();
    const warnings = ["Skipping large file (600KB): /tmp/huge.ts"];
    const serverPromise = startReviewServer({
      files: TEST_FILES,
      warnings,
      signal: ac.signal,
      _skipOpen: true,
    });
    const port = await waitForPort(serverPromise);

    const res = await get(port, "/api/warnings");
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body), warnings);

    ac.abort();
    await serverPromise;
  });
});

describe("ReviewServer WebSocket", () => {
  it("WebSocket connects and receives init message", async () => {
    const serverPromise = startReviewServer({
      files: TEST_FILES,
      _skipOpen: true,
    });
    const port = await waitForPort(serverPromise);

    const { ws, initMsg } = await connectWs(port);
    assert.deepEqual(initMsg, { type: "init" });

    ws.send(JSON.stringify({ type: "cancel" }));
    await serverPromise;
    ws.terminate();
  });

  it("submit via WebSocket resolves with comments and cancelled: false", async () => {
    const serverPromise = startReviewServer({
      files: TEST_FILES,
      _skipOpen: true,
    });
    const port = await waitForPort(serverPromise);

    const { ws } = await connectWs(port);

    const comments = [
      {
        file: "hello.ts",
        startLine: 1,
        endLine: 1,
        selectedText: 'console.log("hello");',
        comment: "Use a logger instead",
      },
    ];

    ws.send(JSON.stringify({ type: "submit", comments }));

    const result = await serverPromise;
    assert.equal(result.cancelled, false);
    assert.equal(result.comments.length, 1);
    assert.equal(result.comments[0].file, "hello.ts");
    assert.equal(result.comments[0].comment, "Use a logger instead");
    ws.terminate();
  });

  it("cancel via WebSocket resolves with cancelled: true", async () => {
    const serverPromise = startReviewServer({
      files: TEST_FILES,
      _skipOpen: true,
    });
    const port = await waitForPort(serverPromise);

    const { ws } = await connectWs(port);

    ws.send(JSON.stringify({ type: "cancel" }));

    const result = await serverPromise;
    assert.deepEqual(result, { comments: [], cancelled: true });
    ws.terminate();
  });

  it("WebSocket disconnect treated as cancel", async () => {
    const serverPromise = startReviewServer({
      files: TEST_FILES,
      _skipOpen: true,
    });
    const port = await waitForPort(serverPromise);

    const { ws } = await connectWs(port);

    // Terminate without sending anything — treated as cancel
    ws.terminate();

    const result = await serverPromise;
    assert.deepEqual(result, { comments: [], cancelled: true });
  });

  it("multiple rapid submits do not cause double-resolve errors", async () => {
    const serverPromise = startReviewServer({
      files: TEST_FILES,
      _skipOpen: true,
    });
    const port = await waitForPort(serverPromise);

    const { ws } = await connectWs(port);

    const comments = [
      {
        file: "hello.ts",
        startLine: 1,
        endLine: 1,
        selectedText: "first",
        comment: "first submit",
      },
    ];

    // Send submit multiple times rapidly
    ws.send(JSON.stringify({ type: "submit", comments }));
    ws.send(
      JSON.stringify({
        type: "submit",
        comments: [{ ...comments[0], comment: "second" }],
      })
    );
    ws.send(JSON.stringify({ type: "cancel" }));

    const result = await serverPromise;
    // Only the first submit should win
    assert.equal(result.cancelled, false);
    assert.equal(result.comments.length, 1);
    assert.equal(result.comments[0].comment, "first submit");
    ws.terminate();
  });

  it("server shuts down after submit", async () => {
    const serverPromise = startReviewServer({
      files: TEST_FILES,
      _skipOpen: true,
    });
    const port = await waitForPort(serverPromise);

    const { ws } = await connectWs(port);

    ws.send(
      JSON.stringify({
        type: "submit",
        comments: [
          {
            file: "hello.ts",
            startLine: 1,
            endLine: 1,
            selectedText: "x",
            comment: "y",
          },
        ],
      })
    );

    await serverPromise;
    ws.terminate();

    // Server should no longer accept connections
    await new Promise((r) => setTimeout(r, 50));
    try {
      await get(port, "/");
      assert.fail("Should not be able to connect after shutdown");
    } catch (err: any) {
      assert.ok(
        err.code === "ECONNREFUSED" || err.code === "ECONNRESET",
        `Expected connection error, got ${err.code}`
      );
    }
  });

  it("AbortSignal terminates active WebSocket connections", async () => {
    const ac = new AbortController();
    const serverPromise = startReviewServer({
      files: TEST_FILES,
      signal: ac.signal,
      _skipOpen: true,
    });
    const port = await waitForPort(serverPromise);

    const { ws } = await connectWs(port);

    // WebSocket should be open
    assert.equal(ws.readyState, WebSocket.OPEN);

    // Track close event
    const closed = new Promise<void>((resolve) => {
      ws.on("close", () => resolve());
    });

    ac.abort();
    await serverPromise;

    // Wait for the close event on the client side
    await closed;

    // WebSocket should be closed after abort
    assert.ok(
      ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING,
      `Expected WS to be closed/closing, got readyState=${ws.readyState}`
    );
    ws.terminate();
  });
});
