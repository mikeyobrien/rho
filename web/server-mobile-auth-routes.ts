import crypto from "node:crypto";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { getAuthConfig } from "./config.ts";
import { app } from "./server-core.ts";
import {
	activeSessions,
	pendingBootstrapTokens,
	SESSION_COOKIE_NAME,
} from "./server-mobile-auth-state.ts";

const AUTH_ROUTE_PREFIX = "/api/auth";

const MOBILE_SHELL_ORIGINS = new Set([
	"http://localhost",
	"https://localhost",
	"http://127.0.0.1",
	"https://127.0.0.1",
	"capacitor://localhost",
]);

function applyAuthCors(c: {
	req: { header: (name: string) => string | undefined };
	header: (name: string, value: string) => void;
}): void {
	const origin = c.req.header("Origin");
	if (!origin || !MOBILE_SHELL_ORIGINS.has(origin)) {
		return;
	}

	c.header("Access-Control-Allow-Origin", origin);
	c.header("Access-Control-Allow-Credentials", "true");
	c.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
	c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
	c.header("Vary", "Origin");
}

app.use(`${AUTH_ROUTE_PREFIX}/*`, async (c, next) => {
	applyAuthCors(c);

	if (c.req.method === "OPTIONS") {
		return c.body(null, 204);
	}

	await next();
	applyAuthCors(c);
});

export function validateToken(token: string, expectedHashes: string[]): boolean {
	const hash = crypto.createHash("sha256").update(token).digest("hex");
	return expectedHashes.includes(hash);
}

app.post(`${AUTH_ROUTE_PREFIX}/exchange`, async (c) => {
	const config = getAuthConfig();
	if (!config.enabled) {
		return c.json({ error: "Auth is disabled" }, 403);
	}
	if (!config.tokenHashes || config.tokenHashes.length === 0) {
		return c.json({ error: "Auth tokens are not configured" }, 500);
	}

	const authHeader = c.req.header("Authorization");
	if (!authHeader || !authHeader.startsWith("Bearer ")) {
		return c.json({ error: "Missing or invalid Authorization header" }, 401);
	}

	const token = authHeader.substring(7);
	if (!validateToken(token, config.tokenHashes)) {
		return c.json({ error: "Invalid token" }, 401);
	}

	const sessionId = crypto.randomBytes(32).toString("hex");
	const expiresAt = Date.now() + config.sessionTtlSeconds * 1000;
	activeSessions.set(sessionId, { expiresAt });

	const bootstrapToken = crypto.randomBytes(24).toString("base64url");
	pendingBootstrapTokens.set(bootstrapToken, { sessionId, expiresAt });

	const isSecure =
		c.req.header("x-forwarded-proto") === "https" ||
		new URL(c.req.url).protocol === "https:";

	setCookie(c, SESSION_COOKIE_NAME, sessionId, {
		httpOnly: true,
		secure: isSecure,
		sameSite: "Lax",
		maxAge: config.sessionTtlSeconds,
		path: "/",
	});

	return c.json({ success: true, bootstrapToken });
});

app.post(`${AUTH_ROUTE_PREFIX}/logout`, async (c) => {
	const config = getAuthConfig();
	if (!config.enabled) {
		return c.json({ error: "Auth is disabled" }, 403);
	}

	const sessionId = getCookie(c, SESSION_COOKIE_NAME);
	if (sessionId) {
		activeSessions.delete(sessionId);
		for (const [token, pending] of pendingBootstrapTokens.entries()) {
			if (pending.sessionId === sessionId) {
				pendingBootstrapTokens.delete(token);
			}
		}
	}

	deleteCookie(c, SESSION_COOKIE_NAME, {
		path: "/",
	});

	return c.json({ success: true });
});

app.get(`${AUTH_ROUTE_PREFIX}/status`, async (c) => {
	const config = getAuthConfig();
	if (!config.enabled) {
		return c.json({ enabled: false, active: false, reason: "disabled" });
	}

	const sessionId = getCookie(c, SESSION_COOKIE_NAME);
	if (!sessionId) {
		return c.json({ enabled: true, active: false, reason: "missing_cookie" });
	}

	const session = activeSessions.get(sessionId);
	if (!session) {
		return c.json({ enabled: true, active: false, reason: "revoked" });
	}

	if (Date.now() > session.expiresAt) {
		activeSessions.delete(sessionId);
		return c.json({ enabled: true, active: false, reason: "expired" });
	}

	return c.json({ enabled: true, active: true });
});
