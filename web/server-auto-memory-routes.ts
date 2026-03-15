import {
	readAutoMemoryStatus,
	readRecentAutoMemoryRuns,
} from "../extensions/lib/auto-memory-status.ts";
import {
	getAutoMemoryEffective,
	readMemorySettings,
} from "../extensions/lib/memory-settings.ts";
import { app } from "./server-core.ts";

app.get("/api/auto-memory/status", async (c) => {
	try {
		const effective = getAutoMemoryEffective();
		const settings = readMemorySettings();
		const status = readAutoMemoryStatus();
		return c.json({
			effective,
			settings: {
				autoMemory: settings.autoMemory,
				autoMemoryModel: settings.autoMemoryModel ?? null,
				autoMemoryMode: settings.autoMemoryMode,
				autoMemoryDebounceMs: settings.autoMemoryDebounceMs,
			},
			status: status ?? {
				phase: "idle",
				pendingCount: 0,
				activeRunId: null,
				activeSessionId: null,
				activeLeafId: null,
				queuedAt: null,
				startedAt: null,
				finishedAt: null,
				lastRunId: null,
				lastStatus: null,
				lastSavedTotal: 0,
				lastError: null,
				updatedAt: new Date(0).toISOString(),
			},
		});
	} catch (error) {
		return c.json(
			{
				error: (error as Error).message ?? "Failed to read auto-memory status",
			},
			500,
		);
	}
});

app.get("/api/auto-memory/runs", async (c) => {
	try {
		const rawLimit = Number.parseInt(c.req.query("limit") ?? "10", 10);
		const limit = Number.isFinite(rawLimit)
			? Math.min(Math.max(rawLimit, 1), 50)
			: 10;
		return c.json({ runs: readRecentAutoMemoryRuns(limit) });
	} catch (error) {
		return c.json(
			{ error: (error as Error).message ?? "Failed to read auto-memory runs" },
			500,
		);
	}
});
