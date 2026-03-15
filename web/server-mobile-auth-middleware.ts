import type { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { getAuthConfig } from "./config.ts";
import { app } from "./server-core.ts";
import {
	SESSION_COOKIE_NAME,
	activeSessions,
} from "./server-mobile-auth-state.ts";

const AUTH_EXEMPT_PATHS = new Set([
	"/api/health",
	"/api/auth/exchange",
	"/api/auth/logout",
	"/api/auth/status",
]);

export async function authMiddleware(c: Context, next: Next) {
	const config = getAuthConfig();
	if (!config.enabled) {
		await next();
		return;
	}

	const path = c.req.path;
	if (
		AUTH_EXEMPT_PATHS.has(path) ||
		(!path.startsWith("/api/") && path !== "/ws" && path !== "/terminal/ws")
	) {
		await next();
		return;
	}

	const sessionId = getCookie(c, SESSION_COOKIE_NAME);
	if (!sessionId) {
		return c.json({ error: "Unauthorized: Missing session" }, 401);
	}

	const session = activeSessions.get(sessionId);
	if (!session) {
		return c.json({ error: "Unauthorized: Invalid session" }, 401);
	}

	if (Date.now() > session.expiresAt) {
		activeSessions.delete(sessionId);
		return c.json({ error: "Unauthorized: Session expired" }, 401);
	}

	await next();
}

app.use("/api/*", authMiddleware);
app.use("/ws", authMiddleware);
app.use("/terminal/ws", authMiddleware);
