import { serve } from "@hono/node-server";
import app, { disposeServerResources, injectWebSocket } from "./server.ts";

const port = 3141;
const bindHost = "0.0.0.0";

const server = serve({ fetch: app.fetch, port, hostname: bindHost });
injectWebSocket(server);
console.log(`Rho web server listening on http://localhost:${port}`);

function shutdown(signal: string): void {
  console.log(`Shutting down web server (${signal})...`);
  disposeServerResources();
  server.close();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
