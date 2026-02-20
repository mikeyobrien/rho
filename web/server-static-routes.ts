import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import {
	app,
	clearRpcSubscriptions,
	publicDir,
	rpcManager,
	rpcReliability,
	rpcSessionSubscribers,
} from "./server-core.ts";

// --- Static files ---

app.get("/", async (c) => {
	const html = await readFile(path.join(publicDir, "index.html"), "utf-8");
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
}

export default app;
