/**
 * rho web — Launch the Rho web server.
 *
 * Starts a web server providing a chat interface and state file viewer/editor.
 */

import * as os from "node:os";
import * as path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { parseInitToml, type RhoConfig } from "../config.ts";
import app, { disposeServerResources, injectWebSocket } from "../../web/server.ts";

const HOME = process.env.HOME || os.homedir();
const RHO_DIR = path.join(HOME, ".rho");
const INIT_TOML = path.join(RHO_DIR, "init.toml");
const DEFAULT_PORT = 3141;
const DEFAULT_HOST = "0.0.0.0";

interface WebConfig {
  enabled: boolean;
  port: number;
}

function readInitConfig(): RhoConfig | null {
  try {
    if (!existsSync(INIT_TOML)) return null;
    return parseInitToml(readFileSync(INIT_TOML, "utf-8"));
  } catch {
    return null;
  }
}

function getWebConfig(): WebConfig {
  const cfg = readInitConfig();
  const settings = (cfg?.settings as Record<string, unknown>)?.web as Record<string, unknown> | undefined;

  return {
    enabled: typeof settings?.enabled === "boolean" ? settings.enabled : false,
    port: typeof settings?.port === "number" ? settings.port : DEFAULT_PORT,
  };
}

function parseArgs(args: string[]): { port?: number; open: boolean; help: boolean } {
  let port: number | undefined;
  let open = false;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--open" || arg === "-o") {
      open = true;
    } else if (arg === "--port" || arg === "-p") {
      const next = args[i + 1];
      if (next && !next.startsWith("-")) {
        const parsed = parseInt(next, 10);
        if (Number.isFinite(parsed) && parsed > 0) {
          port = parsed;
        }
        i++;
      }
    } else if (arg.startsWith("--port=")) {
      const parsed = parseInt(arg.slice(7), 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        port = parsed;
      }
    }
  }

  return { port, open, help };
}

function openBrowser(url: string): void {
  const platform = process.platform;
  let cmd: string;
  let args: string[];

  if (platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", url];
  } else {
    // Linux / Android - try xdg-open first
    cmd = "xdg-open";
    args = [url];
  }

  try {
    const child = spawn(cmd, args, {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  } catch {
    // Non-fatal - browser open is best-effort
  }
}

export async function run(args: string[]): Promise<void> {
  const parsed = parseArgs(args);

  if (parsed.help) {
    console.log(`rho web

Launch the Rho web server.

The web server provides:
- Chat interface with pi RPC integration
- Brain viewer/editor (brain.jsonl entries)
- Tasks list view
- Real-time updates via WebSocket

Options:
  --port, -p <port>   Port to bind to (default: 3141 or from init.toml)
  --open, -o          Open browser after starting
  -h, --help          Show this help

Configuration:
  Add a [settings.web] section to ~/.rho/init.toml:

  [settings.web]
  port = 3141          # Server port
  enabled = false      # Auto-start with \`rho start\`

Examples:
  rho web              Start on default port (3141)
  rho web --port 4000  Start on port 4000
  rho web --open       Start and open browser`);
    return;
  }

  const webConfig = getWebConfig();
  const port = parsed.port ?? webConfig.port;
  const hostname = DEFAULT_HOST;

  const server = serve({ fetch: app.fetch, port, hostname });
  injectWebSocket(server);

  console.log(`Rho web running at http://localhost:${port}`);

  if (parsed.open) {
    openBrowser(`http://localhost:${port}`);
  }

  function shutdown(signal: string): void {
    console.log(`\nShutting down web server (${signal})...`);
    disposeServerResources();
    server.close();
    process.exit(0);
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // Keep the process alive
  await new Promise(() => {});
}

/**
 * Start the web server programmatically (for integration with rho start).
 * Returns a cleanup function.
 */
export function startWebServer(port: number = DEFAULT_PORT): { url: string; stop: () => void } {
  const hostname = DEFAULT_HOST;
  const server = serve({ fetch: app.fetch, port, hostname });
  injectWebSocket(server);

  const url = `http://localhost:${port}`;

  return {
    url,
    stop: () => {
      disposeServerResources();
      server.close();
    },
  };
}

/**
 * Get the web config from init.toml.
 */
export { getWebConfig };
