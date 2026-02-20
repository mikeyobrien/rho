import crypto from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
	claimReviewRecord,
	getReviewRecord,
	listReviewRecords,
	resolveReviewRecord,
} from "./review-store.ts";
import {
	type ReviewComment,
	type ReviewFile,
	type ReviewSession,
	app,
	getReviewSession,
	mapReviewStoreError,
	parseReviewListStatus,
	persistOpenReviewSession,
	persistReviewCompletion,
	publicDir,
	readNumericEnv,
	requireReviewToken,
	reviewSessions,
	sendWsMessage,
	toReviewSessionListItem,
	toSubmissionSummary,
	upgradeWebSocket,
} from "./server-core.ts";
import { broadcastUiEvent } from "./server-ui-events.ts";

// --- Health ---

app.get("/api/health", (c) => c.json({ status: "ok" }));

// --- Review API ---

app.get("/api/review/sessions", (c) => {
	const sessions = [...reviewSessions.values()].map(toReviewSessionListItem);
	sessions.sort((a, b) => b.createdAt - a.createdAt);
	return c.json(sessions);
});

app.post("/api/review/sessions", async (c) => {
	let body: { files?: ReviewFile[]; warnings?: string[]; message?: string };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid JSON body" }, 400);
	}

	const files = Array.isArray(body.files) ? body.files : [];
	if (files.length === 0) {
		return c.json({ error: "files is required" }, 400);
	}

	const id = crypto.randomUUID();
	const token = crypto.randomUUID().replace(/-/g, "");
	const session: ReviewSession = {
		id,
		token,
		files,
		warnings: Array.isArray(body.warnings) ? body.warnings : [],
		message: typeof body.message === "string" ? body.message : undefined,
		createdAt: Date.now(),
		done: false,
		result: null,
		toolSockets: new Set(),
		uiSockets: new Set(),
	};

	reviewSessions.set(id, session);
	try {
		await persistOpenReviewSession(session, { source: "tool" });
	} catch (error) {
		reviewSessions.delete(id);
		return c.json(
			{ error: (error as Error).message ?? "Failed to persist review" },
			500,
		);
	}

	const openTtlMs = readNumericEnv(
		"RHO_REVIEW_OPEN_TTL_MS",
		24 * 60 * 60 * 1000,
	);
	setTimeout(() => {
		const current = reviewSessions.get(id);
		if (!current) return;
		if (!current.done && Date.now() - current.createdAt > openTtlMs) {
			current.done = true;
			current.result = { cancelled: true, comments: [] };
			void persistReviewCompletion(current).catch((error) => {
				console.warn(
					`Failed to persist review auto-cancel for ${id}: ${(error as Error).message}`,
				);
			});
			reviewSessions.delete(id);
			broadcastUiEvent("review_sessions_changed");
			broadcastUiEvent("review_submissions_changed");
		}
	}, openTtlMs).unref?.();

	const origin = new URL(c.req.url).origin;
	const url = `${origin}/review/${id}?token=${token}`;
	broadcastUiEvent("review_sessions_changed");
	return c.json({ id, token, url });
});

app.get("/api/review/submissions", async (c) => {
	const status = parseReviewListStatus(c.req.query("status"));
	const claimedBy = c.req.query("claimedBy");
	const limitRaw = Number(c.req.query("limit") ?? "50");
	const limit = Number.isFinite(limitRaw)
		? Math.max(1, Math.min(Math.floor(limitRaw), 200))
		: 50;

	try {
		const records = await listReviewRecords({ status, claimedBy, limit });
		return c.json(records.map(toSubmissionSummary));
	} catch (error) {
		return c.json(
			{ error: (error as Error).message ?? "Failed to list submissions" },
			500,
		);
	}
});

app.get("/api/review/submissions/:id", async (c) => {
	const id = c.req.param("id");
	const record = await getReviewRecord(id);
	if (!record) {
		return c.json({ error: "not found" }, 404);
	}
	return c.json(record);
});

app.post("/api/review/submissions/:id/claim", async (c) => {
	const id = c.req.param("id");
	let body: { claimedBy?: string } = {};
	try {
		body = await c.req.json();
	} catch {
		// optional body
	}

	const claimedBy =
		typeof body.claimedBy === "string" && body.claimedBy.trim()
			? body.claimedBy.trim()
			: "agent";

	try {
		const record = await claimReviewRecord(id, claimedBy);
		broadcastUiEvent("review_submissions_changed");
		return c.json(toSubmissionSummary(record));
	} catch (error) {
		const mapped = mapReviewStoreError(error);
		return c.json({ error: mapped.message }, mapped.status);
	}
});

app.post("/api/review/submissions/:id/resolve", async (c) => {
	const id = c.req.param("id");
	let body: { resolvedBy?: string } = {};
	try {
		body = await c.req.json();
	} catch {
		// optional body
	}

	try {
		const record = await resolveReviewRecord(id, body.resolvedBy);
		broadcastUiEvent("review_submissions_changed");
		return c.json(toSubmissionSummary(record));
	} catch (error) {
		const mapped = mapReviewStoreError(error);
		return c.json({ error: mapped.message }, mapped.status);
	}
});

app.delete("/api/review/sessions/:id", (c) => {
	const id = c.req.param("id");
	const session = getReviewSession(id);
	if (!session) return c.json({ error: "not found" }, 404);
	if (!requireReviewToken(c, session))
		return c.json({ error: "forbidden" }, 403);

	if (!session.done) {
		session.done = true;
		session.result = { cancelled: true, comments: [] };
		void persistReviewCompletion(session).catch((error) => {
			console.warn(
				`Failed to persist review cancel for ${id}: ${(error as Error).message}`,
			);
		});

		for (const toolWs of session.toolSockets) {
			try {
				sendWsMessage(toolWs, { type: "review_result", ...session.result });
			} catch {}
		}

		for (const uiWs of session.uiSockets) {
			try {
				uiWs.close();
			} catch {}
		}
	}

	reviewSessions.delete(id);
	broadcastUiEvent("review_sessions_changed");
	broadcastUiEvent("review_submissions_changed");
	return c.json({ ok: true });
});

app.get("/review", (c) => {
	return c.redirect("/?view=review", 302);
});

app.get("/review/:id", async (c) => {
	const id = c.req.param("id");
	const session = getReviewSession(id);
	if (!session) return c.text("Review session not found", 404);
	if (!requireReviewToken(c, session)) return c.text("Forbidden", 403);

	try {
		const template = await readFile(
			path.join(publicDir, "review", "index.html"),
			"utf-8",
		);
		const html = template
			.replace(/__SESSION_ID__/g, id)
			.replace(/__TOKEN__/g, session.token);
		return c.html(html);
	} catch (error) {
		return c.text((error as Error).message ?? "Failed to load review UI", 500);
	}
});

app.get("/review/:id/api/files", (c) => {
	const id = c.req.param("id");
	const session = getReviewSession(id);
	if (!session) return c.json({ error: "not found" }, 404);
	if (!requireReviewToken(c, session))
		return c.json({ error: "forbidden" }, 403);
	return c.json(session.files);
});

app.get("/review/:id/api/warnings", (c) => {
	const id = c.req.param("id");
	const session = getReviewSession(id);
	if (!session) return c.json({ error: "not found" }, 404);
	if (!requireReviewToken(c, session))
		return c.json({ error: "forbidden" }, 403);
	return c.json(session.warnings ?? []);
});

app.get("/review/:id/api/config", (c) => {
	const id = c.req.param("id");
	const session = getReviewSession(id);
	if (!session) return c.json({ error: "not found" }, 404);
	if (!requireReviewToken(c, session))
		return c.json({ error: "forbidden" }, 403);
	const cfg: Record<string, string> = {};
	if (session.message) cfg.message = session.message;
	return c.json(cfg);
});

app.get(
	"/review/:id/ws",
	upgradeWebSocket((c) => {
		const id = c.req.param("id");
		const session = getReviewSession(id);
		const token = c.req.query("token");
		const role = c.req.query("role") === "tool" ? "tool" : "ui";

		if (!session || typeof token !== "string" || token !== session.token) {
			return {
				onOpen: (_, ws) => {
					try {
						ws.close();
					} catch {}
				},
			};
		}

		return {
			onOpen: (_, ws) => {
				if (role === "tool") {
					session.toolSockets.add(ws);
					// If already done, send result immediately
					if (session.done && session.result) {
						sendWsMessage(ws, { type: "review_result", ...session.result });
					} else {
						sendWsMessage(ws, { type: "init" });
					}
				} else {
					session.uiSockets.add(ws);
					sendWsMessage(ws, { type: "init" });
				}
			},
			onMessage: (event, _ws) => {
				if (typeof event.data !== "string") return;
				if (role !== "ui") return;

				let msg: { type?: string; comments?: unknown[] };
				try {
					msg = JSON.parse(event.data);
				} catch {
					return;
				}

				if (session.done) {
					return;
				}

				if (msg?.type === "submit" && Array.isArray(msg.comments)) {
					session.done = true;
					session.result = {
						cancelled: false,
						comments: msg.comments as ReviewComment[],
					};
				} else if (msg?.type === "cancel") {
					session.done = true;
					session.result = { cancelled: true, comments: [] };
				} else {
					return;
				}

				broadcastUiEvent("review_sessions_changed");
				broadcastUiEvent("review_submissions_changed");

				void persistReviewCompletion(session).catch((error) => {
					console.warn(
						`Failed to persist review completion for ${id}: ${(error as Error).message}`,
					);
				});

				for (const toolWs of session.toolSockets) {
					try {
						sendWsMessage(toolWs, { type: "review_result", ...session.result });
					} catch {}
				}

				for (const uiWs of session.uiSockets) {
					try {
						uiWs.close();
					} catch {}
				}

				setTimeout(
					() => {
						reviewSessions.delete(id);
					},
					30 * 60 * 1000,
				).unref?.();
			},
			onClose: (_, ws) => {
				session.toolSockets.delete(ws);
				session.uiSockets.delete(ws);
			},
			onError: (_, ws) => {
				session.toolSockets.delete(ws);
				session.uiSockets.delete(ws);
			},
		};
	}),
);
