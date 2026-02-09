import {
  addTask,
  findTaskById,
  listTasks,
  loadTasks,
  removeTask,
  saveTasks,
  type Task,
  type TaskPriority,
  type TaskStatus,
} from "../extensions/rho/tasks-core.ts";

type TaskUpdate = {
  description?: string;
  priority?: TaskPriority;
  status?: TaskStatus;
  tags?: string[];
  due?: string | null;
};

type TaskResult = {
  ok: boolean;
  message: string;
  task?: Task;
  tasks?: Task[];
};

const VALID_PRIORITIES: TaskPriority[] = ["urgent", "high", "normal", "low"];

function normalizeTags(tags?: string[]): string[] {
  if (!tags) return [];
  return tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean);
}

function normalizeDue(due?: string | null): string | null {
  if (!due) return null;
  const trimmed = due.trim();
  if (!trimmed) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new Error(`Error: invalid due date '${trimmed}'. Use YYYY-MM-DD format.`);
  }
  return trimmed;
}

export function listAllTasks(filter: string | undefined): Task[] {
  const result = listTasks(filter ?? "all");
  return result.tasks ?? [];
}

export function createTask(params: { description?: string; priority?: TaskPriority; tags?: string[]; due?: string | null }): TaskResult {
  const tags = params.tags?.length ? params.tags.join(",") : undefined;
  const due = params.due ?? undefined;
  return addTask({ description: params.description ?? "", priority: params.priority, tags, due });
}

export function updateTask(id: string, update: TaskUpdate): TaskResult {
  if (!id?.trim()) return { ok: false, message: "Error: task ID is required" };

  const tasks = loadTasks();
  const task = findTaskById(tasks, id.trim());
  if (!task) return { ok: false, message: `Error: task '${id}' not found` };

  if (update.description !== undefined) {
    const desc = update.description.trim();
    if (!desc) return { ok: false, message: "Error: description is required" };
    task.description = desc;
  }

  if (update.priority !== undefined) {
    if (!VALID_PRIORITIES.includes(update.priority)) {
      return { ok: false, message: `Error: invalid priority '${update.priority}'.` };
    }
    task.priority = update.priority;
  }

  if (update.tags !== undefined) {
    task.tags = normalizeTags(update.tags);
  }

  if (update.due !== undefined) {
    try {
      task.due = normalizeDue(update.due);
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  }

  if (update.status !== undefined) {
    task.status = update.status;
    task.completedAt = update.status === "done" ? new Date().toISOString() : null;
  }

  saveTasks(tasks);
  return { ok: true, message: "Task updated.", task };
}

export function deleteTask(id: string): TaskResult {
  return removeTask(id);
}
