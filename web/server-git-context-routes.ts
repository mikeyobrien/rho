import { getProjectsDir } from "./config.ts";
import {
	getSessionGitContext,
	listGitProjects,
	setSessionGitContext,
} from "./git-context-store.ts";
import { app } from "./server-core.ts";
import { broadcastUiEvent } from "./server-ui-events.ts";

app.get("/api/git/projects", async (c) => {
	try {
		const projects = await listGitProjects();
		return c.json({ projectsDir: getProjectsDir(), projects });
	} catch (error) {
		return c.json(
			{ error: (error as Error).message ?? "Failed to list git projects" },
			500,
		);
	}
});

app.get("/api/git/context", async (c) => {
	const sessionId = c.req.query("sessionId")?.trim() ?? "";
	if (!sessionId) {
		return c.json({ error: "sessionId query parameter is required" }, 400);
	}
	const context = await getSessionGitContext(sessionId);
	if (!context) {
		return c.json({ context: null });
	}
	return c.json({ context });
});

app.post("/api/git/context", async (c) => {
	let payload: { sessionId?: string; repoId?: string };
	try {
		payload = await c.req.json();
	} catch {
		return c.json({ error: "Invalid JSON body" }, 400);
	}

	const sessionId = payload.sessionId?.trim() ?? "";
	const repoId = payload.repoId?.trim() ?? "";
	if (!sessionId) {
		return c.json({ error: "sessionId is required" }, 400);
	}
	if (!repoId) {
		return c.json({ error: "repoId is required" }, 400);
	}

	try {
		const context = await setSessionGitContext(sessionId, repoId);
		broadcastUiEvent("git_context_changed", {
			sessionId: context.sessionId,
			repoId: context.repoId,
			cwd: context.cwd,
		});
		return c.json({ context });
	} catch (error) {
		return c.json(
			{ error: (error as Error).message ?? "Invalid context" },
			400,
		);
	}
});
