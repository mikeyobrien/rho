import { readBrain, foldBrain, appendBrainEntry, BRAIN_PATH } from "../extensions/lib/brain-store.ts";
import type { TaskEntry } from "../extensions/lib/brain-store.ts";
import crypto from "node:crypto";

type TaskUpdate = {
  description?: string;
  priority?: "urgent" | "high" | "normal" | "low";
  status?: "pending" | "done";
  tags?: string[];
  due?: string | null;
};

type TaskResult = {
  ok: boolean;
  message: string;
  task?: TaskEntry;
  tasks?: TaskEntry[];
};

function loadBrainTasks(): TaskEntry[] {
  const { entries } = readBrain(BRAIN_PATH);
  const brain = foldBrain(entries);
  return brain.tasks;
}

export function listAllTasks(filter: string | undefined): TaskEntry[] {
  const tasks = loadBrainTasks();
  if (!filter || filter === "all") return tasks;
  if (filter === "pending") return tasks.filter(t => t.status === "pending");
  if (filter === "done") return tasks.filter(t => t.status === "done");
  return tasks.filter(t => t.status === "pending" && t.tags.includes(filter.toLowerCase()));
}

export async function createTask(params: { description?: string; priority?: string; tags?: string[]; due?: string | null }): Promise<TaskResult> {
  const desc = params.description?.trim();
  if (!desc) return { ok: false, message: "Error: description is required" };

  const task: TaskEntry = {
    id: crypto.randomBytes(4).toString("hex"),
    type: "task",
    description: desc,
    status: "pending",
    priority: (params.priority as TaskEntry["priority"]) || "normal",
    tags: params.tags?.map(t => t.trim().toLowerCase()).filter(Boolean) || [],
    created: new Date().toISOString(),
    due: params.due || null,
    completedAt: null,
  };

  await appendBrainEntry(BRAIN_PATH, task);
  return { ok: true, message: `Task added: [${task.id}] ${desc}`, task };
}

export async function updateTask(id: string, update: TaskUpdate): Promise<TaskResult> {
  if (!id?.trim()) return { ok: false, message: "Error: task ID is required" };

  const tasks = loadBrainTasks();
  const task = tasks.find(t => t.id === id.trim() || t.id.startsWith(id.trim()));
  if (!task) return { ok: false, message: `Error: task '${id}' not found` };

  const updated: TaskEntry = { ...task };
  if (update.description !== undefined) updated.description = update.description.trim();
  if (update.priority !== undefined) updated.priority = update.priority;
  if (update.tags !== undefined) updated.tags = update.tags.map(t => t.trim().toLowerCase()).filter(Boolean);
  if (update.due !== undefined) updated.due = update.due;
  if (update.status !== undefined) {
    updated.status = update.status;
    updated.completedAt = update.status === "done" ? new Date().toISOString() : null;
  }
  // Append updated entry (last-write-wins via fold)
  await appendBrainEntry(BRAIN_PATH, updated);
  return { ok: true, message: "Task updated.", task: updated };
}

export async function deleteTask(id: string): Promise<TaskResult> {
  const tasks = loadBrainTasks();
  const task = tasks.find(t => t.id === id.trim() || t.id.startsWith(id.trim()));
  if (!task) return { ok: false, message: `Error: task '${id}' not found` };

  const tombstone = {
    id: crypto.randomBytes(4).toString("hex"),
    type: "tombstone" as const,
    target_id: task.id,
    target_type: "task",
    reason: "deleted via web UI",
    created: new Date().toISOString(),
  };
  await appendBrainEntry(BRAIN_PATH, tombstone);
  return { ok: true, message: `Removed: [${task.id}] ${task.description}` };
}
