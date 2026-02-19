import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getRhoHome } from "./config.ts";
import { app, loadPiSessionManagerModule } from "./server-core.ts";
import {
	findSessionFileById,
	listSessions,
	readSession,
} from "./session-reader.ts";

// --- Config API ---

app.get("/api/config", async (c) => {
	try {
		const configPath = path.join(getRhoHome(), "init.toml");
		const content = await readFile(configPath, "utf-8");
		return c.json({ path: configPath, content });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return c.json({
				path: path.join(getRhoHome(), "init.toml"),
				content: "",
			});
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
	const limit = Math.min(
		Number.parseInt(c.req.query("limit") ?? "20", 10) || 20,
		100,
	);
	const offset = Number.parseInt(c.req.query("offset") ?? "0", 10) || 0;
	try {
		const { total, sessions } = await listSessions({
			cwd: cwd ?? undefined,
			offset,
			limit,
		});
		c.header("X-Total-Count", String(total));
		return c.json(sessions);
	} catch (error) {
		return c.json(
			{ error: (error as Error).message ?? "Failed to list sessions" },
			500,
		);
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
		return c.json({ ...session, file: sessionFile });
	} catch (error) {
		return c.json(
			{ error: (error as Error).message ?? "Failed to read session" },
			500,
		);
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
		const requestedEntryId =
			typeof body.entryId === "string" ? body.entryId.trim() : "";
		const fallbackEntryId = sourceSession.forkPoints.at(-1)?.id ?? "";
		const entryId = requestedEntryId || fallbackEntryId;
		if (!entryId) {
			return c.json({ error: "No user message available to fork from" }, 400);
		}

		const validEntryIds = new Set(
			(sourceSession.forkPoints ?? []).map((point) => point.id),
		);
		if (!validEntryIds.has(entryId)) {
			return c.json({ error: "Invalid fork entryId" }, 400);
		}

		const { SessionManager } = await loadPiSessionManagerModule();
		const sourceManager = SessionManager.open(
			sourceSessionFile,
			path.dirname(sourceSessionFile),
		);
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
		return c.json(
			{ error: (error as Error).message ?? "Failed to fork session" },
			500,
		);
	}
});

app.post("/api/sessions/new", async (c) => {
	try {
		const sessionId = crypto.randomUUID();
		const timestamp = new Date().toISOString();
		const safeTimestamp = timestamp.replace(/[:.]/g, "-");
		const cwd = process.env.HOME ?? process.cwd();
		const safeCwd = cwd.replace(/\//g, "-");
		const sessionDir = path.join(
			process.env.HOME ?? "",
			".pi",
			"agent",
			"sessions",
			safeCwd,
		);
		await mkdir(sessionDir, { recursive: true });
		const sessionFile = path.join(
			sessionDir,
			`${safeTimestamp}_${sessionId}.jsonl`,
		);
		const header = JSON.stringify({
			type: "session",
			version: 1,
			id: sessionId,
			cwd,
			timestamp,
		});
		await writeFile(sessionFile, `${header}\n`, "utf-8");

		const session = await readSession(sessionFile);
		return c.json({
			sessionId,
			sessionFile,
			session,
		});
	} catch (error) {
		return c.json(
			{ error: (error as Error).message ?? "Failed to create session" },
			500,
		);
	}
});
