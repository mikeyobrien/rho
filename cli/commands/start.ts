/**
 * rho start — Launch the heartbeat daemon.
 *
 * Starts a background monitor process that:
 * - holds a wake lock on Android
 * - ensures a tmux session named 'rho' exists running `pi -c`
 * - shows a persistent notification on Android
 * - cleans up wake lock + notification when stopped
 */

import * as os from "node:os";
import * as path from "node:path";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { detectPlatform } from "../init-core.ts";
import { parseInitToml } from "../config.ts";
import {
  SESSION_NAME,
  PID_FILE,
  planStart,
  buildNotificationArgs,
  notificationToCliArgs,
  type DaemonState,
} from "../daemon-core.ts";

const HOME = process.env.HOME || os.homedir();
const RHO_DIR = path.join(HOME, ".rho");
const PID_PATH = path.join(HOME, PID_FILE);
const INIT_TOML = path.join(RHO_DIR, "init.toml");

const TMUX_CONF_FALLBACK = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "configs",
  "tmux-rho.conf",
);

function expandHome(p: string): string {
  if (p === "~") return HOME;
  if (p.startsWith("~/")) return path.join(HOME, p.slice(2));
  return p;
}

function readInitConfig(): ReturnType<typeof parseInitToml> | null {
  try {
    if (!existsSync(INIT_TOML)) return null;
    return parseInitToml(readFileSync(INIT_TOML, "utf-8"));
  } catch {
    return null;
  }
}

function getTmuxSocket(): string {
  const env = (process.env.RHO_TMUX_SOCKET || "").trim();
  if (env) return env;

  const cfg = readInitConfig();
  const fromToml = (cfg?.settings as any)?.heartbeat?.tmux_socket;
  if (typeof fromToml === "string" && fromToml.trim()) return fromToml.trim();

  return "rho";
}

function getTmuxConfigSetting(): string | null {
  const env = (process.env.RHO_TMUX_CONF || "").trim();
  if (env) return env;

  const cfg = readInitConfig();
  const fromToml = (cfg?.settings as any)?.heartbeat?.tmux_config;
  if (typeof fromToml === "string" && fromToml.trim()) return fromToml.trim();

  return null;
}

function getTmuxConfPath(): string {
  const setting = getTmuxConfigSetting();
  if (!setting || setting === "builtin" || setting === "rho") return TMUX_CONF_FALLBACK;
  return expandHome(setting);
}

function tmuxBaseArgs(): string[] {
  // Always use a dedicated socket so we don't interfere with the user's default tmux server.
  return ["-L", getTmuxSocket(), "-f", getTmuxConfPath()];
}

function tmuxSessionExists(): boolean {
  // Rho socket server
  const r = spawnSync("tmux", [...tmuxBaseArgs(), "has-session", "-t", SESSION_NAME], { stdio: "ignore" });
  return r.status === 0;
}

function tmuxLegacySessionExists(): boolean {
  // Back-compat: prior versions used the default tmux socket/config.
  const r = spawnSync("tmux", ["has-session", "-t", SESSION_NAME], { stdio: "ignore" });
  return r.status === 0;
}

function readDaemonPid(): number | null {
  try {
    const content = readFileSync(PID_PATH, "utf-8").trim();
    const pid = parseInt(content, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getInterval(): string {
  try {
    if (existsSync(INIT_TOML)) {
      const config = parseInitToml(readFileSync(INIT_TOML, "utf-8"));
      const interval = (config.settings as any)?.heartbeat?.interval;
      if (typeof interval === "string") return interval;
    }
  } catch {
    // ignore
  }
  return "30m";
}

function getCommandPath(cmd: string): string | null {
  const r = spawnSync("sh", ["-lc", `command -v ${cmd}`], { encoding: "utf-8" });
  if (r.status !== 0) return null;
  const out = (r.stdout || "").trim();
  return out || null;
}

function acquireWakeLock(): void {
  try {
    spawnSync("termux-wake-lock", [], { stdio: "ignore" });
  } catch {
    // non-fatal
  }
}

function releaseWakeLock(): void {
  try {
    spawnSync("termux-wake-unlock", [], { stdio: "ignore" });
  } catch {
    // non-fatal
  }
}

function showNotification(interval: string): void {
  const notifBin = getCommandPath("termux-notification");
  if (!notifBin) return;

  const tmuxBin = getCommandPath("tmux") || "tmux";

  try {
    const notif = buildNotificationArgs(tmuxBin, interval, getTmuxSocket());
    const cliArgs = notificationToCliArgs(notif);
    spawnSync("termux-notification", cliArgs, { stdio: "ignore" });
  } catch {
    // non-fatal
  }
}

function removeNotification(): void {
  const rmBin = getCommandPath("termux-notification-remove");
  if (!rmBin) return;

  try {
    spawnSync("termux-notification-remove", ["rho-daemon"], { stdio: "ignore" });
  } catch {
    // non-fatal
  }
}

function ensureTmuxSession(): void {
  if (tmuxSessionExists()) return;

  // Resolve full path to pi so tmux can find it without nvm in PATH
  const piPath = path.join(path.dirname(process.execPath), "pi");
  const r = spawnSync(
    "tmux",
    [...tmuxBaseArgs(), "new-session", "-d", "-s", SESSION_NAME, "-c", RHO_DIR, `${piPath} -c`],
    { stdio: "ignore" },
  );
  if (r.status !== 0) {
    throw new Error("Failed to create tmux session");
  }
}

function getWebConfig(): { enabled: boolean; port: number } {
  const cfg = readInitConfig();
  if (!cfg) return { enabled: false, port: 3141 };
  return cfg.web;
}

async function monitorLoop(): Promise<void> {
  const platform = detectPlatform();
  let webServer: { url: string; stop: () => void } | null = null;
  let webPort: number | null = null;

  async function applyWebConfig(next: { enabled: boolean; port: number }): Promise<void> {
    if (!next.enabled) {
      if (webServer) {
        webServer.stop();
        webServer = null;
        webPort = null;
        console.log("Rho web stopped");
      }
      return;
    }

    // Already running on the desired port.
    if (webServer && webPort === next.port) return;

    // Port changed (or server is missing) → restart.
    if (webServer) {
      webServer.stop();
      webServer = null;
      webPort = null;
    }

    try {
      const { startWebServer } = await import("./web.ts");
      webServer = startWebServer(next.port);
      webPort = next.port;
      console.log(`Rho web running at ${webServer.url}`);
    } catch (err) {
      console.error(`Failed to start web server: ${(err as Error).message}`);
      // Non-fatal - continue without web server
    }
  }

  writeFileSync(PID_PATH, String(process.pid));

  if (platform === "android") {
    acquireWakeLock();
    showNotification(getInterval());
  }

  // Start (or stop) web server based on current config.
  await applyWebConfig(getWebConfig());

  // Reload web config on SIGHUP (used by `rho sync` for immediate apply).
  if (process.platform !== "win32") {
    process.on("SIGHUP", () => {
      void applyWebConfig(getWebConfig());
    });
  }

  const cleanup = () => {
    try { unlinkSync(PID_PATH); } catch {}
    if (webServer) {
      webServer.stop();
    }
    if (platform === "android") {
      removeNotification();
      releaseWakeLock();
    }
  };

  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
  process.on("exit", cleanup);

  try {
    ensureTmuxSession();
  } catch {
    cleanup();
    process.exit(1);
  }

  while (true) {
    await sleep(30_000);
    if (!tmuxSessionExists()) {
      try {
        ensureTmuxSession();
      } catch {
        cleanup();
        process.exit(1);
      }
    }
  }
}

export async function run(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`rho start

Launch the Rho heartbeat daemon in a tmux session.

Starts a background monitor process that keeps the tmux session alive.
On Android, it also holds a wake lock and shows a persistent notification.

If [settings.web].enabled = true in init.toml, the web server also starts.

Options:
  --foreground   Attach to the session after starting
  --monitor      (internal) Run the background monitor loop
  -h, --help     Show this help`);
    return;
  }

  const foreground = args.includes("--foreground") || args.includes("-f");
  const monitorMode = args.includes("--monitor");

  if (monitorMode) {
    await monitorLoop();
    return;
  }

  const platform = detectPlatform();

  // Clean up stale PID file.
  const existingPid = readDaemonPid();
  if (existingPid !== null && !pidAlive(existingPid)) {
    try { unlinkSync(PID_PATH); } catch {}
  }

  const rhoSocketRunning = tmuxSessionExists();
  const legacyRunning = tmuxLegacySessionExists();

  const state: DaemonState = {
    tmuxRunning: rhoSocketRunning || legacyRunning,
    daemonPid: readDaemonPid(),
    daemonPidAlive: false,
    platform,
  };

  const plan = planStart(state, HOME);

  // If we're already inside the rho tmux session, don't nest-attach.
  if (foreground && process.env.TMUX) {
    try {
      const currentSession = spawnSync("tmux", ["display-message", "-p", "#S"], { encoding: "utf-8" });
      if (currentSession.stdout?.trim() === SESSION_NAME) {
        console.log("Already in rho session. Use `/rho status` for heartbeat info.");
        return;
      }
    } catch {}
  }

  if (plan.tmuxAlreadyRunning) {
    // Prefer the new dedicated socket if present.
    if (rhoSocketRunning) {
      if (foreground) {
        spawnSync("tmux", [...tmuxBaseArgs(), "attach", "-t", plan.sessionName], { stdio: "inherit" });
      } else {
        console.log("Rho already running.");
        console.log(`Attach with: tmux -L ${getTmuxSocket()} attach -t ${plan.sessionName}`);
      }
      return;
    }

    // Legacy server (default socket) exists.
    console.log("Rho is running on the legacy tmux socket (default config).");
    console.log("To migrate to the rho tmux config, run: rho stop  (then)  rho start");

    if (foreground) {
      spawnSync("tmux", ["attach", "-t", plan.sessionName], { stdio: "inherit" });
    } else {
      console.log(`Attach with: tmux attach -t ${plan.sessionName}`);
    }
    return;
  }

  const indexPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "index.ts");
  const child = spawn(process.execPath, [
    "--experimental-strip-types",
    indexPath,
    "start",
    "--monitor",
  ], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();

  await sleep(1000);

  if (!tmuxSessionExists()) {
    console.error("Failed to start rho daemon (tmux session not found).");
    process.exit(1);
  }

  console.log(`Rho running in tmux session: ${plan.sessionName}`);

  if (foreground) {
    spawnSync("tmux", [...tmuxBaseArgs(), "attach", "-t", plan.sessionName], { stdio: "inherit" });
  } else {
    console.log(`Attach with: tmux -L ${getTmuxSocket()} attach -t ${plan.sessionName}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
