import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { setCookie } from "hono/cookie";
import { getRhoHome } from "./config.ts";
import { rpcLiveModeLeases } from "./rpc-live-mode-lease.ts";
import {
	app,
	clearRpcSubscriptions,
	publicDir,
	rpcManager,
	rpcReliability,
	rpcSessionSubscribers,
} from "./server-core.ts";
import {
	SESSION_COOKIE_NAME,
	activeSessions,
	pendingBootstrapTokens,
} from "./server-mobile-auth-state.ts";
import { terminalManager } from "./terminal-manager.ts";

// --- User CSS ---

const USER_CSS_PATH = path.join(getRhoHome(), "user.css");
const USER_CSS_LINK = '<link rel="stylesheet" href="/user.css">';

app.get("/user.css", async (c) => {
	try {
		const css = await readFile(USER_CSS_PATH, "utf-8");
		c.header("Content-Type", "text/css");
		c.header("Cache-Control", "no-cache");
		return c.body(css);
	} catch {
		return c.body("", 404);
	}
});

// --- Static files ---

app.get("/", async (c) => {
	const mobileShell = c.req.query("mobile_shell") === "1";
	const bootstrapToken = c.req.query("auth_bootstrap")?.trim();
	if (bootstrapToken) {
		const pending = pendingBootstrapTokens.get(bootstrapToken);
		pendingBootstrapTokens.delete(bootstrapToken);

		if (!pending) {
			return c.text("Invalid or expired auth bootstrap token", 401);
		}

		const session = activeSessions.get(pending.sessionId);
		if (!session || Date.now() > session.expiresAt) {
			activeSessions.delete(pending.sessionId);
			return c.text("Invalid or expired auth bootstrap token", 401);
		}

		const isSecure =
			c.req.header("x-forwarded-proto") === "https" ||
			new URL(c.req.url).protocol === "https:";
		const maxAge = Math.max(
			1,
			Math.floor((session.expiresAt - Date.now()) / 1000),
		);

		setCookie(c, SESSION_COOKIE_NAME, pending.sessionId, {
			httpOnly: true,
			secure: isSecure,
			sameSite: "Lax",
			maxAge,
			path: "/",
		});

		return c.redirect(mobileShell ? "/?mobile_shell=1" : "/", 302);
	}

	let html = await readFile(path.join(publicDir, "index.html"), "utf-8");
	try {
		await readFile(USER_CSS_PATH, "utf-8");
		html = html.replace("</head>", `${USER_CSS_LINK}\n</head>`);
	} catch {
		// No user.css — serve unmodified
	}
	return c.html(html);
});

// PWA root assets
app.get(
	"/manifest.json",
	serveStatic({ root: publicDir, path: "manifest.json" }),
);
app.use("/sw.js", async (c, next) => {
	await next();
	// Service workers need no-cache and root scope
	c.res.headers.set("Cache-Control", "no-cache");
	c.res.headers.set("Service-Worker-Allowed", "/");
});
app.get("/sw.js", serveStatic({ root: publicDir, path: "sw.js" }));
app.get("/favicon.svg", serveStatic({ root: publicDir, path: "favicon.svg" }));
app.get(
	"/icon-192.png",
	serveStatic({ root: publicDir, path: "icon-192.png" }),
);
app.get(
	"/icon-512.png",
	serveStatic({ root: publicDir, path: "icon-512.png" }),
);

// Cache headers for static assets (5 minutes)

app.use(
	"/css/*",
	async (c, next) => {
		await next();
		c.res.headers.set("Cache-Control", "public, max-age=300");
	},
	serveStatic({ root: publicDir }),
);
app.use(
	"/js/*",
	async (c, next) => {
		await next();
		// Browser modules import each other without content hashes.
		// Force revalidation so deploys don't run stale module graphs.
		c.res.headers.set("Cache-Control", "no-cache");
	},
	serveStatic({ root: publicDir }),
);
app.use(
	"/assets/*",
	async (c, next) => {
		await next();
		c.res.headers.set("Cache-Control", "public, max-age=300");
	},
	serveStatic({ root: publicDir }),
);
app.use(
	"/review/css/*",
	async (c, next) => {
		await next();
		c.res.headers.set("Cache-Control", "public, max-age=300");
	},
	serveStatic({ root: publicDir }),
);
app.use(
	"/review/js/*",
	async (c, next) => {
		await next();
		c.res.headers.set("Cache-Control", "public, max-age=300");
	},
	serveStatic({ root: publicDir }),
);

// --- Cleanup ---

export function disposeServerResources(): void {
	for (const ws of rpcSessionSubscribers.keys()) {
		clearRpcSubscriptions(ws);
	}
	rpcReliability.dispose();
	rpcManager.dispose();
	rpcLiveModeLeases.clearAll();
	terminalManager.dispose();
}

export default app;
