import { Hono } from "hono";
import type { WSContext } from "hono/ws";
import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { WebSocket } from "ws";
import { FileWatcher } from "./file-watcher.ts";
import { findKnownFileByPath, getKnownFiles } from "./config.ts";
import {
  createSessionNotFoundError,
  getRpcSessionFile,
  rpcManager,
  type RPCCommand,
  type RPCEvent,
} from "./rpc-manager.ts";
import { findSessionFileById, listSessions, readSession } from "./session-reader.ts";
import { createTask, deleteTask, listAllTasks, updateTask } from "./task-api.ts";

const app = new Hono();
const publicDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "public");
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
export { injectWebSocket };

const fileWatcher = new FileWatcher();
let watcherStarted = false;
const fileSubscribers = new Set<WSContext<WebSocket>>();
const rpcSessionSubscribers = new Map<WSContext<WebSocket>, Map<string, () => void>>();
let sessionManagerModulePromise: Promise<{ SessionManager: { open(path: string): { createBranchedSession(leafId: string): string | undefined } } }> | null = null;

type WSIncomingMessage = {
  type?: string;
  sessionId?: string;
  sessionFile?: string;
  command?: RPCCommand;
};

function ensureFileWatcherStarted(): void {
  if (!watcherStarted) {
    fileWatcher.start();
    watcherStarted = true;
  }
}

async function listKnownFileMetadata(): Promise<
  { name: string; category: string; path: string; lastModified: string; isDirectory?: boolean }[]
> {
  const files = getKnownFiles();
  const results: { name: string; category: string; path: string; lastModified: string; isDirectory?: boolean }[] = [];

  for (const file of files) {
    try {
      const info = await stat(file.path);
      results.push({
        name: file.name,
        category: file.category,
        path: file.path,
        lastModified: info.mtime.toISOString(),
        isDirectory: info.isDirectory() || undefined,
      });
    } catch {
      // Skip missing files.
    }
  }

  return results;
}

function broadcastFileChange(filePath: string, content: string): void {
  const payload = JSON.stringify({ type: "file_changed", path: filePath, content });
  for (const ws of fileSubscribers) {
    try {
      ws.send(payload);
    } catch {
      fileSubscribers.delete(ws);
    }
  }
}

function sendWsMessage(ws: WSContext<WebSocket>, message: Record<string, unknown>): void {
  ws.send(JSON.stringify(message));
}

function subscribeToRpcSession(ws: WSContext<WebSocket>, sessionId: string): void {
  let subscriptions = rpcSessionSubscribers.get(ws);
  if (!subscriptions) {
    subscriptions = new Map<string, () => void>();
    rpcSessionSubscribers.set(ws, subscriptions);
  }

  if (subscriptions.has(sessionId)) {
    return;
  }

  const unsubscribe = rpcManager.onEvent(sessionId, (event: RPCEvent) => {
    try {
      sendWsMessage(ws, { type: "rpc_event", sessionId, event });
    } catch {
      const wsSubscriptions = rpcSessionSubscribers.get(ws);
      wsSubscriptions?.get(sessionId)?.();
      wsSubscriptions?.delete(sessionId);
      if (wsSubscriptions && wsSubscriptions.size === 0) {
        rpcSessionSubscribers.delete(ws);
      }
    }
  });

  subscriptions.set(sessionId, unsubscribe);
}

function clearRpcSubscriptions(ws: WSContext<WebSocket>): void {
  const subscriptions = rpcSessionSubscribers.get(ws);
  if (!subscriptions) {
    return;
  }

  for (const unsubscribe of subscriptions.values()) {
    unsubscribe();
  }
  rpcSessionSubscribers.delete(ws);
}

function extractSessionFile(payload: WSIncomingMessage): string | null {
  if (typeof payload.sessionFile === "string" && payload.sessionFile.trim()) {
    return payload.sessionFile.trim();
  }

  return getRpcSessionFile(payload.command);
}

async function loadPiSessionManagerModule(): Promise<{
  SessionManager: { open(path: string): { createBranchedSession(leafId: string): string | undefined } };
}> {
  if (!sessionManagerModulePromise) {
    sessionManagerModulePromise = (async () => {
      try {
        const mod = await import("@mariozechner/pi-coding-agent");
        if (mod?.SessionManager) {
          return mod as {
            SessionManager: { open(path: string): { createBranchedSession(leafId: string): string | undefined } };
          };
        }
      } catch {
        // Fall through to global install fallback.
      }

      const homeDir = process.env.HOME ?? "";
      const fallbackPath = path.join(
        homeDir,
        ".npm-global",
        "lib",
        "node_modules",
        "@mariozechner",
        "pi-coding-agent",
        "dist",
        "index.js"
      );
      const mod = await import(pathToFileURL(fallbackPath).href);
      if (!mod?.SessionManager) {
        throw new Error("SessionManager export not found in pi-coding-agent module");
      }
      return mod as {
        SessionManager: { open(path: string): { createBranchedSession(leafId: string): string | undefined } };
      };
    })();
  }

  return sessionManagerModulePromise;
}

fileWatcher.onChange((filePath, content) => {
  broadcastFileChange(filePath, content);
});

app.get("/api/health", (c) => c.json({ status: "ok" }));

app.get("/api/files", async (c) => {
  ensureFileWatcherStarted();
  try {
    const files = await listKnownFileMetadata();
    return c.json(files);
  } catch (error) {
    return c.json({ error: (error as Error).message ?? "Failed to list files" }, 500);
  }
});

app.get("/api/file", async (c) => {
  ensureFileWatcherStarted();
  const requestedPath = c.req.query("path");
  if (!requestedPath) {
    return c.json({ error: "File path required" }, 400);
  }

  const knownFile = findKnownFileByPath(requestedPath);
  if (!knownFile) {
    return c.json({ error: "File not found" }, 404);
  }

  try {
    const info = await stat(knownFile.path);
    if (info.isDirectory()) {
      return c.json({ error: "Cannot read a directory" }, 400);
    }
    const content = await readFile(knownFile.path, "utf-8");
    return c.json({ path: knownFile.path, content });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return c.json({ error: "File not found" }, 404);
    }
    return c.json({ error: (error as Error).message ?? "Failed to read file" }, 500);
  }
});

app.put("/api/file", async (c) => {
  ensureFileWatcherStarted();
  const requestedPath = c.req.query("path");
  if (!requestedPath) {
    return c.json({ error: "File path required" }, 400);
  }

  const knownFile = findKnownFileByPath(requestedPath);
  if (!knownFile) {
    return c.json({ error: "File not found" }, 404);
  }

  if (knownFile.isDirectory) {
    return c.json({ error: "Cannot write to a directory" }, 400);
  }

  try {
    const content = await c.req.text();
    await mkdir(path.dirname(knownFile.path), { recursive: true });
    await writeFile(knownFile.path, content, "utf-8");
    return c.json({ status: "ok", path: knownFile.path });
  } catch (error) {
    return c.json({ error: (error as Error).message ?? "Failed to write file" }, 500);
  }
});

app.get("/api/sessions", async (c) => {
  const cwd = c.req.query("cwd");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "20", 10) || 20, 100);
  const offset = parseInt(c.req.query("offset") ?? "0", 10) || 0;
  try {
    const allSessions = await listSessions(cwd ?? undefined);
    const paginated = allSessions.slice(offset, offset + limit);
    c.header("X-Total-Count", String(allSessions.length));
    return c.json(paginated);
  } catch (error) {
    return c.json({ error: (error as Error).message ?? "Failed to list sessions" }, 500);
  }
});

app.get("/api/sessions/:id", async (c) => {
  const sessionId = c.req.param("id");
  try {
    const sessionFile = await findSessionFileById(sessionId);
    if (!sessionFile) {
      return c.json({ error: "Session not found" }, 404);
    }
    const session = await readSession(sessionFile);
    return c.json(session);
  } catch (error) {
    return c.json({ error: (error as Error).message ?? "Failed to read session" }, 500);
  }
});

app.post("/api/sessions/:id/fork", async (c) => {
  const sourceSessionId = c.req.param("id");
  let body: { entryId?: string } = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  try {
    const sourceSessionFile = await findSessionFileById(sourceSessionId);
    if (!sourceSessionFile) {
      return c.json({ error: "Session not found" }, 404);
    }

    const sourceSession = await readSession(sourceSessionFile);
    const requestedEntryId = typeof body.entryId === "string" ? body.entryId.trim() : "";
    const fallbackEntryId = sourceSession.forkPoints.at(-1)?.id ?? "";
    const entryId = requestedEntryId || fallbackEntryId;
    if (!entryId) {
      return c.json({ error: "No user message available to fork from" }, 400);
    }

    const validEntryIds = new Set((sourceSession.forkPoints ?? []).map((point) => point.id));
    if (!validEntryIds.has(entryId)) {
      return c.json({ error: "Invalid fork entryId" }, 400);
    }

    const { SessionManager } = await loadPiSessionManagerModule();
    const sourceManager = SessionManager.open(sourceSessionFile, path.dirname(sourceSessionFile));
    const forkedSessionFile = sourceManager.createBranchedSession(entryId);
    if (!forkedSessionFile) {
      return c.json({ error: "Failed to create forked session" }, 500);
    }

    const forkedSession = await readSession(forkedSessionFile);
    return c.json({
      sourceSessionId,
      sourceSessionFile,
      entryId,
      sessionId: forkedSession.header.id,
      sessionFile: forkedSessionFile,
      session: forkedSession,
    });
  } catch (error) {
    return c.json({ error: (error as Error).message ?? "Failed to fork session" }, 500);
  }
});

app.post("/api/sessions/new", async (c) => {
  try {
    const { randomUUID } = await import("node:crypto");
    const sessionId = randomUUID();
    const timestamp = new Date().toISOString();
    const safeTimestamp = timestamp.replace(/[:.]/g, "-");
    const cwd = process.env.HOME ?? process.cwd();
    const safeCwd = cwd.replace(/\//g, "-");
    const sessionDir = path.join(process.env.HOME ?? "", ".pi", "agent", "sessions", safeCwd);
    await mkdir(sessionDir, { recursive: true });
    const sessionFile = path.join(sessionDir, `${safeTimestamp}_${sessionId}.jsonl`);
    const header = JSON.stringify({ type: "session", version: 1, id: sessionId, cwd, timestamp });
    await writeFile(sessionFile, header + "\n", "utf-8");

    const session = await readSession(sessionFile);
    return c.json({
      sessionId,
      sessionFile,
      session,
    });
  } catch (error) {
    return c.json({ error: (error as Error).message ?? "Failed to create session" }, 500);
  }
});

app.get("/api/tasks", (c) => {
  try {
    const filter = c.req.query("filter");
    const tasks = listAllTasks(filter ?? undefined);
    return c.json(tasks);
  } catch (error) {
    return c.json({ error: (error as Error).message ?? "Failed to list tasks" }, 500);
  }
});

app.post("/api/tasks", async (c) => {
  let payload: { description?: string; priority?: string; tags?: string[]; due?: string | null };
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const result = createTask({
    description: payload.description,
    priority: payload.priority as "urgent" | "high" | "normal" | "low" | undefined,
    tags: payload.tags,
    due: payload.due ?? undefined,
  });

  if (!result.ok || !result.task) {
    return c.json({ error: result.message }, 400);
  }
  return c.json(result.task);
});

app.patch("/api/tasks/:id", async (c) => {
  const taskId = c.req.param("id");
  let payload: { description?: string; priority?: string; status?: string; tags?: string[]; due?: string | null };
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const result = updateTask(taskId, {
    description: payload.description,
    priority: payload.priority as "urgent" | "high" | "normal" | "low" | undefined,
    status: payload.status as "pending" | "done" | undefined,
    tags: payload.tags,
    due: payload.due ?? undefined,
  });

  if (!result.ok || !result.task) {
    const status = result.message.includes("not found") ? 404 : 400;
    return c.json({ error: result.message }, status);
  }
  return c.json(result.task);
});

app.delete("/api/tasks/:id", (c) => {
  const taskId = c.req.param("id");
  const result = deleteTask(taskId);
  if (!result.ok) {
    const status = result.message.includes("not found") ? 404 : 400;
    return c.json({ error: result.message }, status);
  }
  return c.json({ status: "ok" });
});

app.get(
  "/ws",
  upgradeWebSocket(() => ({
    onOpen: (_, ws) => {
      ensureFileWatcherStarted();
      fileSubscribers.add(ws);
    },
    onMessage: async (event, ws) => {
      if (typeof event.data !== "string") {
        return;
      }

      let payload: WSIncomingMessage | null = null;
      try {
        payload = JSON.parse(event.data) as WSIncomingMessage;
      } catch {
        return;
      }

      if (payload?.type === "subscribe_files") {
        fileSubscribers.add(ws);
        const files = await listKnownFileMetadata();
        try {
          ws.send(JSON.stringify({ type: "files", files }));
        } catch {
          fileSubscribers.delete(ws);
        }
        return;
      }

      if (payload?.type !== "rpc_command") {
        return;
      }

      const command = payload.command;
      if (!command || typeof command !== "object" || typeof command.type !== "string") {
        sendWsMessage(ws, { type: "error", message: "rpc_command requires a command object with a type field" });
        return;
      }

      let sessionId = typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
      let sessionStarted = false;

      if (!sessionId) {
        const sessionFile = extractSessionFile(payload);
        if (!sessionFile) {
          sendWsMessage(ws, {
            type: "error",
            message: "rpc_command requires sessionId or sessionFile (or command session path)",
          });
          return;
        }

        try {
          sessionId = rpcManager.startSession(sessionFile);
          subscribeToRpcSession(ws, sessionId);
          sessionStarted = true;
          sendWsMessage(ws, { type: "session_started", sessionId, sessionFile });
        } catch (error) {
          sendWsMessage(ws, { type: "error", message: (error as Error).message ?? "Failed to start RPC session" });
          return;
        }
      } else {
        try {
          subscribeToRpcSession(ws, sessionId);
        } catch {
          sendWsMessage(ws, createSessionNotFoundError(sessionId));
          return;
        }
      }

      const isBootstrapSwitch = sessionStarted && command.type === "switch_session";
      if (isBootstrapSwitch) {
        return;
      }

      try {
        rpcManager.sendCommand(sessionId, command);
      } catch (error) {
        sendWsMessage(ws, { type: "error", message: (error as Error).message ?? "Failed to send RPC command" });
      }
    },
    onClose: (_, ws) => {
      fileSubscribers.delete(ws);
      clearRpcSubscriptions(ws);
    },
    onError: (_, ws) => {
      fileSubscribers.delete(ws);
      clearRpcSubscriptions(ws);
    },
  }))
);

app.get("/", async (c) => {
  const html = await readFile(path.join(publicDir, "index.html"), "utf-8");
  return c.html(html);
});

app.use("/css/*", serveStatic({ root: publicDir }));
app.use("/js/*", serveStatic({ root: publicDir }));
app.use("/assets/*", serveStatic({ root: publicDir }));

export function disposeServerResources(): void {
  if (watcherStarted) {
    fileWatcher.stop();
    watcherStarted = false;
  }
  fileSubscribers.clear();

  for (const ws of rpcSessionSubscribers.keys()) {
    clearRpcSubscriptions(ws);
  }

  rpcManager.dispose();
}

export default app;
