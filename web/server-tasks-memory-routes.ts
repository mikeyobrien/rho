import crypto from "node:crypto";
import { stat } from "node:fs/promises";
import {
	appendBrainEntry,
	type BehaviorEntry,
	BRAIN_PATH,
	type BrainEntry,
	type ContextEntry,
	foldBrain,
	type IdentityEntry,
	type LearningEntry,
	type PreferenceEntry,
	type ReminderEntry,
	readBrain,
	type TaskEntry,
	type UserEntry,
} from "../extensions/lib/brain-store.ts";
import { app } from "./server-core.ts";
import {
	createTask,
	deleteTask,
	listAllTasks,
	updateTask,
} from "./task-api.ts";

// --- Tasks API ---

app.get("/api/tasks", async (c) => {
	try {
		const filter = c.req.query("filter");
		const tasks = listAllTasks(filter ?? undefined);
		return c.json(tasks);
	} catch (error) {
		return c.json(
			{ error: (error as Error).message ?? "Failed to list tasks" },
			500,
		);
	}
});

app.post("/api/tasks", async (c) => {
	let payload: {
		description?: string;
		priority?: string;
		tags?: string[];
		due?: string | null;
	};
	try {
		payload = await c.req.json();
	} catch {
		return c.json({ error: "Invalid JSON body" }, 400);
	}

	const result = await createTask({
		description: payload.description,
		priority: payload.priority as
			| "urgent"
			| "high"
			| "normal"
			| "low"
			| undefined,
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
	let payload: {
		description?: string;
		priority?: string;
		status?: string;
		tags?: string[];
		due?: string | null;
	};
	try {
		payload = await c.req.json();
	} catch {
		return c.json({ error: "Invalid JSON body" }, 400);
	}

	const result = await updateTask(taskId, {
		description: payload.description,
		priority: payload.priority as
			| "urgent"
			| "high"
			| "normal"
			| "low"
			| undefined,
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

/** Safely access an optional field on a brain entry union. */
function field(e: BrainEntry, key: string): unknown {
	return (e as Record<string, unknown>)[key];
}

// --- Memory API ---

type MemoryEntries = {
	behaviors: BehaviorEntry[];
	identity: IdentityEntry[];
	user: UserEntry[];
	learnings: LearningEntry[];
	preferences: PreferenceEntry[];
	contexts: ContextEntry[];
	tasks: TaskEntry[];
	reminders: ReminderEntry[];
};

let memoryCache: { mtimeMs: number; data: MemoryEntries } | null = null;

async function readMemoryEntries(): Promise<MemoryEntries> {
	let mtimeMs = 0;
	try {
		mtimeMs = (await stat(BRAIN_PATH)).mtimeMs;
	} catch {
		// Missing brain file or unreadable.
		mtimeMs = 0;
	}

	if (memoryCache && memoryCache.mtimeMs === mtimeMs) {
		return memoryCache.data;
	}

	const { entries } = readBrain(BRAIN_PATH);
	const brain = foldBrain(entries);
	const data: MemoryEntries = {
		behaviors: brain.behaviors,
		identity: [...brain.identity.values()],
		user: [...brain.user.values()],
		learnings: brain.learnings,
		preferences: brain.preferences,
		contexts: brain.contexts,
		tasks: brain.tasks,
		reminders: brain.reminders,
	};

	memoryCache = { mtimeMs, data };
	return data;
}

app.get("/api/memory", async (c) => {
	try {
		const all = await readMemoryEntries();

		const total =
			all.behaviors.length +
			all.identity.length +
			all.user.length +
			all.learnings.length +
			all.preferences.length +
			all.contexts.length +
			all.tasks.length +
			all.reminders.length;

		const typeFilter = c.req.query("type");
		const categoryFilter = c.req.query("category");
		const q = c.req.query("q")?.toLowerCase();

		let baseEntries: BrainEntry[];
		if (typeFilter) {
			switch (typeFilter) {
				case "behavior":
					baseEntries = all.behaviors;
					break;
				case "identity":
					baseEntries = all.identity;
					break;
				case "user":
					baseEntries = all.user;
					break;
				case "learning":
					baseEntries = all.learnings;
					break;
				case "preference":
					baseEntries = all.preferences;
					break;
				case "context":
					baseEntries = all.contexts;
					break;
				case "task":
					baseEntries = all.tasks;
					break;
				case "reminder":
					baseEntries = all.reminders;
					break;
				default:
					baseEntries = [];
			}
		} else {
			baseEntries = [
				...all.behaviors,
				...all.identity,
				...all.user,
				...all.learnings,
				...all.preferences,
				...all.contexts,
				...all.tasks,
				...all.reminders,
			];
		}

		let filtered = baseEntries;
		if (categoryFilter)
			filtered = filtered.filter(
				(e) => field(e, "category") === categoryFilter,
			);
		if (q)
			filtered = filtered.filter((e) => {
				const searchable = [
					field(e, "text"),
					field(e, "category"),
					field(e, "key"),
					field(e, "value"),
					field(e, "content"),
					field(e, "description"),
					field(e, "path"),
					field(e, "project"),
				]
					.filter(Boolean)
					.join(" ")
					.toLowerCase();
				return searchable.includes(q);
			});

		const categories = [
			...new Set(all.preferences.map((p) => p.category)),
		].sort();

		return c.json({
			total,
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
		return c.json(
			{ error: (error as Error).message ?? "Failed to read memory" },
			500,
		);
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

		const all = await readMemoryEntries();
		const allMemory = [
			...all.behaviors,
			...all.identity,
			...all.user,
			...all.learnings,
			...all.preferences,
			...all.contexts,
			...all.tasks,
			...all.reminders,
		];
		const target = allMemory.find((e) => e.id === entryId);
		if (!target) return c.json({ error: "Entry not found" }, 404);

		// Build updated entry preserving all original fields
		const updated = {
			...target,
			text: body.text.trim(),
			created: new Date().toISOString(),
		};
		if (body.category !== undefined && target.type === "preference") {
			(updated as Record<string, unknown>).category = body.category;
		}

		await appendBrainEntry(BRAIN_PATH, updated as BrainEntry);
		memoryCache = null;
		return c.json({ status: "ok", entry: updated });
	} catch (error) {
		return c.json(
			{ error: (error as Error).message ?? "Failed to update entry" },
			500,
		);
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
		if (
			!entryType ||
			!["learning", "preference", "behavior", "context"].includes(entryType)
		) {
			return c.json(
				{
					error: "type must be one of: learning, preference, behavior, context",
				},
				400,
			);
		}

		const id = crypto.randomUUID().slice(0, 8);
		const created = new Date().toISOString();
		let entry: BrainEntry | undefined;

		switch (entryType) {
			case "learning":
				entry = { id, type: "learning", text, source: "web-ui", created };
				break;
			case "preference":
				entry = {
					id,
					type: "preference",
					text,
					category: body.category?.trim() || "General",
					created,
				};
				break;
			case "behavior": {
				// Parse do/dont/values from text
				let category: "do" | "dont" | "value" = "do";
				let cleanText = text;
				if (
					text.toLowerCase().startsWith("don't:") ||
					text.toLowerCase().startsWith("dont:")
				) {
					category = "dont";
					cleanText = text.replace(/^don'?t:\s*/i, "");
				} else if (text.toLowerCase().startsWith("do:")) {
					category = "do";
					cleanText = text.replace(/^do:\s*/i, "");
				} else if (
					text.toLowerCase().startsWith("value:") ||
					text.toLowerCase().startsWith("values:")
				) {
					category = "value";
					cleanText = text.replace(/^values?:\s*/i, "");
				}
				entry = { id, type: "behavior", category, text: cleanText, created };
				break;
			}
			case "context":
				return c.json(
					{
						error:
							"Context entries require project and path fields; use the CLI instead",
					},
					400,
				);
		}

		if (!entry) return c.json({ error: "Failed to construct entry" }, 500);
		await appendBrainEntry(BRAIN_PATH, entry);
		memoryCache = null;
		return c.json({ status: "ok", entry });
	} catch (error) {
		return c.json(
			{ error: (error as Error).message ?? "Failed to create entry" },
			500,
		);
	}
});

app.delete("/api/memory/:id", async (c) => {
	const entryId = c.req.param("id");
	try {
		// Find the entry across all types
		const all = await readMemoryEntries();
		const allMemory = [
			...all.behaviors,
			...all.identity,
			...all.user,
			...all.learnings,
			...all.preferences,
			...all.contexts,
			...all.tasks,
			...all.reminders,
		];
		const target = allMemory.find((e) => e.id === entryId);
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
		memoryCache = null;
		return c.json({ status: "ok" });
	} catch (error) {
		return c.json(
			{ error: (error as Error).message ?? "Failed to delete entry" },
			500,
		);
	}
});
