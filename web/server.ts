import { Hono } from "hono";
import type { WSContext } from "hono/ws";
import { serveStatic } from "@hono/node-server/serve-static";
import { createNodeWebSocket } from "@hono/node-ws";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import crypto from "node:crypto";
import type { WebSocket } from "ws";
import { getRhoHome } from "./config.ts";
import {
  createSessionNotFoundError,
  getRpcSessionFile,
  rpcManager,
  type RPCCommand,
  type RPCEvent,
} from "./rpc-manager.ts";
import { findSessionFileById, listSessions, readSession } from "./session-reader.ts";
import { createTask, deleteTask, listAllTasks, updateTask } from "./task-api.ts";
import { readBrain, foldBrain, appendBrainEntry, BRAIN_PATH } from "../extensions/lib/brain-store.ts";

const app = new Hono();
const publicDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), "public");
const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app });
export { injectWebSocket };

const rpcSessionSubscribers = new Map<WSContext<WebSocket>, Map<string, () => void>>();
let sessionManagerModulePromise: Promise<{ SessionManager: { open(path: string): { createBranchedSession(leafId: string): string | undefined } } }> | null = null;

type WSIncomingMessage = {
  type?: string;
  sessionId?: string;
  sessionFile?: string;
  command?: RPCCommand;
};

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

// --- Health ---

app.get("/api/health", (c) => c.json({ status: "ok" }));

// --- Config API ---

app.get("/api/config", async (c) => {
  try {
    const configPath = path.join(getRhoHome(), "init.toml");
    const content = await readFile(configPath, "utf-8");
    return c.json({ path: configPath, content });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return c.json({ path: path.join(getRhoHome(), "init.toml"), content: "" });
    }
    return c.json({ error: (error as Error).message }, 500);
  }
});

app.put("/api/config", async (c) => {
  try {
    const content = await c.req.text();
    const configPath = path.join(getRhoHome(), "init.toml");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, content, "utf-8");
    return c.json({ status: "ok", path: configPath });
  } catch (error) {
    return c.json({ error: (error as Error).message }, 500);
  }
});

// --- Sessions API ---

app.get("/api/sessions", async (c) => {
  const cwd = c.req.query("cwd");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "20", 10) || 20, 100);
  const offset = parseInt(c.req.query("offset") ?? "0", 10) || 0;
  try {
    const { total, sessions } = await listSessions({
      cwd: cwd ?? undefined,
      offset,
      limit,
    });
    c.header("X-Total-Count", String(total));
    return c.json(sessions);
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
    const sessionId = crypto.randomUUID();
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

// --- Tasks API ---

app.get("/api/tasks", async (c) => {
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

  const result = await createTask({
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

  const result = await updateTask(taskId, {
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

app.delete("/api/tasks/:id", async (c) => {
  const taskId = c.req.param("id");
  const result = await deleteTask(taskId);
  if (!result.ok) {
    const status = result.message.includes("not found") ? 404 : 400;
    return c.json({ error: result.message }, status);
  }
  return c.json({ status: "ok" });
});

// --- Memory API ---

async function readMemoryEntries() {
  const { entries } = readBrain(BRAIN_PATH);
  const brain = foldBrain(entries);
  return {
    behaviors: brain.behaviors,
    identity: [...brain.identity.values()],
    user: [...brain.user.values()],
    learnings: brain.learnings,
    preferences: brain.preferences,
    contexts: brain.contexts,
    tasks: brain.tasks,
    reminders: brain.reminders,
  };
}

app.get("/api/memory", async (c) => {
  try {
    const all = await readMemoryEntries();
    const allEntries = [
      ...all.behaviors,
      ...all.identity,
      ...all.user,
      ...all.learnings,
      ...all.preferences,
      ...all.contexts,
      ...all.tasks,
      ...all.reminders,
    ];

    const typeFilter = c.req.query("type");
    const categoryFilter = c.req.query("category");
    const q = c.req.query("q")?.toLowerCase();

    let filtered = allEntries;
    if (typeFilter) filtered = filtered.filter(e => e.type === typeFilter);
    if (categoryFilter) filtered = filtered.filter(e => (e as any).category === categoryFilter);
    if (q) filtered = filtered.filter(e => {
      const searchable = [
        (e as any).text, (e as any).category, (e as any).key,
        (e as any).value, (e as any).content, (e as any).description,
        (e as any).path, (e as any).project,
      ].filter(Boolean).join(" ").toLowerCase();
      return searchable.includes(q);
    });

    const categories = [...new Set(all.preferences.map(p => p.category))].sort();

    return c.json({
      total: allEntries.length,
      behaviors: all.behaviors.length,
      identity: all.identity.length,
      user: all.user.length,
      learnings: all.learnings.length,
      preferences: all.preferences.length,
      contexts: all.contexts.length,
      tasks: all.tasks.length,
      reminders: all.reminders.length,
      categories,
      entries: filtered,
    });
  } catch (error) {
    return c.json({ error: (error as Error).message ?? "Failed to read memory" }, 500);
  }
});

app.put("/api/memory/:id", async (c) => {
  const entryId = c.req.param("id");
  try {
    let body: { text?: string; category?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (!body.text || typeof body.text !== "string" || !body.text.trim()) {
      return c.json({ error: "text is required" }, 400);
    }

    const { entries } = readBrain(BRAIN_PATH);
    const brain = foldBrain(entries);
    const allMemory = [...brain.learnings, ...brain.preferences];
    const target = allMemory.find(e => e.id === entryId);
    if (!target) return c.json({ error: "Entry not found" }, 404);

    // Build updated entry preserving all original fields
    const updated = { ...target, text: body.text.trim(), created: new Date().toISOString() };
    if (body.category !== undefined && target.type === "preference") {
      (updated as any).category = body.category;
    }

    await appendBrainEntry(BRAIN_PATH, updated as any);
    return c.json({ status: "ok", entry: updated });
  } catch (error) {
    return c.json({ error: (error as Error).message ?? "Failed to update entry" }, 500);
  }
});

app.post("/api/memory", async (c) => {
  try {
    let body: { type?: string; text?: string; category?: string };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    const entryType = body.type;
    const text = body.text?.trim();

    if (!text) return c.json({ error: "text is required" }, 400);
    if (!entryType || !["learning", "preference", "behavior", "context"].includes(entryType)) {
      return c.json({ error: "type must be one of: learning, preference, behavior, context" }, 400);
    }

    const id = crypto.randomUUID().slice(0, 8);
    const created = new Date().toISOString();
    let entry: any;

    switch (entryType) {
      case "learning":
        entry = { id, type: "learning", text, source: "web-ui", created };
        break;
      case "preference":
        entry = { id, type: "preference", text, category: body.category?.trim() || "General", created };
        break;
      case "behavior": {
        // Parse do/dont/values from text
        let category: "do" | "dont" | "value" = "do";
        let cleanText = text;
        if (text.toLowerCase().startsWith("don't:") || text.toLowerCase().startsWith("dont:")) {
          category = "dont";
          cleanText = text.replace(/^don'?t:\s*/i, "");
        } else if (text.toLowerCase().startsWith("do:")) {
          category = "do";
          cleanText = text.replace(/^do:\s*/i, "");
        } else if (text.toLowerCase().startsWith("value:") || text.toLowerCase().startsWith("values:")) {
          category = "value";
          cleanText = text.replace(/^values?:\s*/i, "");
        }
        entry = { id, type: "behavior", category, text: cleanText, created };
        break;
      }
      case "context":
        return c.json({ error: "Context entries require project and path fields; use the CLI instead" }, 400);
    }

    await appendBrainEntry(BRAIN_PATH, entry);
    return c.json({ status: "ok", entry });
  } catch (error) {
    return c.json({ error: (error as Error).message ?? "Failed to create entry" }, 500);
  }
});

app.delete("/api/memory/:id", async (c) => {
  const entryId = c.req.param("id");
  try {
    // Find the entry across all types
    const { entries } = readBrain(BRAIN_PATH);
    const brain = foldBrain(entries);
    const allMemory = [
      ...brain.behaviors,
      ...[...brain.identity.values()],
      ...[...brain.user.values()],
      ...brain.learnings,
      ...brain.preferences,
      ...brain.contexts,
      ...brain.tasks,
      ...brain.reminders,
    ];
    const target = allMemory.find(e => e.id === entryId);
    if (!target) return c.json({ error: "Entry not found" }, 404);

    // Append tombstone
    const tombstone = {
      id: crypto.randomUUID().slice(0, 8),
      type: "tombstone" as const,
      target_id: entryId,
      target_type: target.type,
      reason: "deleted via web UI",
      created: new Date().toISOString(),
    };
    await appendBrainEntry(BRAIN_PATH, tombstone);
    return c.json({ status: "ok" });
  } catch (error) {
    return c.json({ error: (error as Error).message ?? "Failed to delete entry" }, 500);
  }
});

// --- WebSocket ---

app.get(
  "/ws",
  upgradeWebSocket(() => ({
    onOpen: () => {},
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
      clearRpcSubscriptions(ws);
    },
    onError: (_, ws) => {
      clearRpcSubscriptions(ws);
    },
  }))
);

// --- Static files ---

app.get("/", async (c) => {
  const html = await readFile(path.join(publicDir, "index.html"), "utf-8");
  return c.html(html);
});

app.use("/css/*", serveStatic({ root: publicDir }));
app.use("/js/*", serveStatic({ root: publicDir }));
app.use("/assets/*", serveStatic({ root: publicDir }));

// --- Cleanup ---

export function disposeServerResources(): void {
  for (const ws of rpcSessionSubscribers.keys()) {
    clearRpcSubscriptions(ws);
  }
  rpcManager.dispose();
}

export default app;
