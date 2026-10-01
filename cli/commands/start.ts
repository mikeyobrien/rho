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
import { appendFileSync, existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { detectPlatform } from "../init-core.ts";
import { parseInitToml } from "../config.ts";
import { refuseLegacy } from "../install-kind.ts";
import { planDaemonLaunch } from "../pi-launch.ts";
import { resolveRhoPaths } from "../rho-paths.ts";
import {
  attachHerdrSession,
  ensureHerdrWorkspace,
  herdrAgentLive,
  herdrServerRunning,
  reportRhoPaneMetadata,
  startHerdrAgent,
  startHerdrServerDetached,
  waitForHerdrServer,
} from "../herdr-client.ts";
import {
  herdrAttachCommand,
  herdrSessionName,
  resolveSessionHost,
} from "../session-host.ts";
import {
  SESSION_NAME,
  PID_FILE,
  planStart,
  buildNotificationArgs,
  notificationToCliArgs,
  type DaemonState,
} from "../daemon-core.ts";
import { startJobSupervisor, type JobSupervisor } from "../job-supervisor.ts";

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
  if (!setting || setting === "builtin" || setting === "rho")
    return TMUX_CONF_FALLBACK;
  return expandHome(setting);
}

function getSessionHostSetting(): string {
  const env = (process.env.RHO_SESSION_HOST || "").trim();
  if (env) return env;
  const cfg = readInitConfig();
  const fromToml = (cfg?.settings as any)?.heartbeat?.host;
  return typeof fromToml === "string" ? fromToml.trim() : "";
}

function selectedHost(): "herdr" | "tmux" {
  const resolved = resolveSessionHost({
    requested: getSessionHostSetting(),
    herdrAvailable: getCommandPath("herdr") !== null,
  });
  if (resolved.error) throw new Error(resolved.error);
  return resolved.host;
}

function tmuxBaseArgs(): string[] {
  // Always use a dedicated socket so we don't interfere with the user's default tmux server.
  return ["-L", getTmuxSocket(), "-f", getTmuxConfPath()];
}

function tmuxSessionExists(): boolean {
  // Rho socket server
  const r = spawnSync(
    "tmux",
    [...tmuxBaseArgs(), "has-session", "-t", SESSION_NAME],
    { stdio: "ignore" },
  );
  return r.status === 0;
}

function tmuxLegacySessionExists(): boolean {
  // Back-compat: prior versions used the default tmux socket/config.
  const r = spawnSync("tmux", ["has-session", "-t", SESSION_NAME], {
    stdio: "ignore",
  });
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
  // First: search the current process's PATH directly (works even when
  // nvm/fnm/volta only modify the interactive shell, because rho inherits
  // that PATH when launched from the user's terminal).
  const pathDirs = (process.env.PATH || "").split(path.delimiter);
  for (const dir of pathDirs) {
    const candidate = path.join(dir, cmd);
    if (existsSync(candidate)) return candidate;
  }

  // Fallback: login shell (may pick up /etc/profile.d/ but not .bashrc/.zshrc).
  const r = spawnSync("sh", ["-lc", `command -v ${cmd}`], {
    encoding: "utf-8",
  });
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
    spawnSync("termux-notification-remove", ["rho-daemon"], {
      stdio: "ignore",
    });
  } catch {
    // non-fatal
  }
}

function ensureTmuxSession(): void {
  if (tmuxSessionExists()) return;

  const paths = refuseLegacy(resolveRhoPaths(HOME));
  const plan = planDaemonLaunch({
    piBin: getCommandPath("pi"),
    paths,
    tmuxBaseArgs: tmuxBaseArgs(),
    sessionName: SESSION_NAME,
    baseEnv: process.env,
  });
  if (!plan.ok) {
    throw new Error(plan.error ?? "Failed to plan isolated Pi launch");
  }

  if (process.env.PATH) {
    spawnSync(
      "tmux",
      [...tmuxBaseArgs(), "set-environment", "-g", "PATH", process.env.PATH],
      { stdio: "ignore" },
    );
  }

  for (const args of plan.tmuxCommands) {
    const result = spawnSync("tmux", args, { stdio: "ignore" });
    if (result.status !== 0) {
      throw new Error("Failed to create isolated tmux session");
    }
  }
}

async function ensureHerdrSession(): Promise<void> {
  if (!herdrServerRunning()) {
    startHerdrServerDetached();
    const ready = await waitForHerdrServer();
    if (!ready) throw new Error("Failed to start the Rho Herdr session");
  }
  if (herdrAgentLive()) return;

  const paths = refuseLegacy(resolveRhoPaths(HOME));
  const rhoBin = getCommandPath("rho");
  if (!rhoBin) {
    throw new Error("rho is not installed or is not on PATH.");
  }
  const envPairs = [`PI_CODING_AGENT_DIR=${paths.piAgentDir}`];
  if (process.env.PATH) envPairs.push(`PATH=${process.env.PATH}`);
  const paneId = ensureHerdrWorkspace({
    cwd: paths.workspaceDir,
    envPairs,
  });
  await startHerdrAgent(paneId, rhoBin);
  reportRhoPaneMetadata();
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

  async function applyWebConfig(next: {
    enabled: boolean;
    port: number;
  }): Promise<void> {
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

  let jobs: JobSupervisor | null = null;
  const cleanup = () => {
    try {
      jobs?.stop();
    } catch {}
    try {
      unlinkSync(PID_PATH);
    } catch {}
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

  const useHerdr = selectedHost() === "herdr" && !tmuxSessionExists();
  try {
    if (useHerdr) await ensureHerdrSession();
    else ensureTmuxSession();
    jobs = startJobSupervisor({
      piBin: getCommandPath("pi"),
      home: HOME,
    });
  } catch (err) {
    const message = (err as Error).stack || (err as Error).message;
    try {
      appendFileSync(path.join(RHO_DIR, "monitor.err"), `${message}\n`);
    } catch {
      // logging is best-effort
    }
    console.error((err as Error).message);
    cleanup();
    process.exit(1);
  }

  while (true) {
    await sleep(30_000);
    try {
      if (useHerdr) {
        if (!herdrServerRunning() || !herdrAgentLive()) await ensureHerdrSession();
        else reportRhoPaneMetadata();
      } else if (!tmuxSessionExists()) {
        ensureTmuxSession();
      }
    } catch {
      cleanup();
      process.exit(1);
    }
  }
}

export async function run(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`rho start

Launch the Rho heartbeat daemon.

Uses a Herdr session named rho when herdr is on PATH. Otherwise uses tmux.
Set RHO_SESSION_HOST=tmux or [settings.heartbeat] host = "tmux" to force tmux.

Starts a background monitor process that keeps the session alive.
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
    try {
      unlinkSync(PID_PATH);
    } catch {}
  }

  let host: "herdr" | "tmux";
  try {
    host = selectedHost();
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
    return;
  }
  const herdrRunning = host === "herdr" && herdrServerRunning();
  const herdrLive = herdrRunning && herdrAgentLive();
  const rhoSocketRunning = tmuxSessionExists();
  const legacyRunning = tmuxLegacySessionExists();

  const state: DaemonState = {
    sessionRunning: herdrLive || rhoSocketRunning || legacyRunning,
    daemonPid: readDaemonPid(),
    daemonPidAlive: false,
    platform,
  };

  const plan = planStart(state, HOME);

  const insideRhoHerdr = Boolean(
    process.env.HERDR_SOCKET_PATH?.includes(`/sessions/${herdrSessionName()}/`),
  );
  if (foreground && insideRhoHerdr && herdrLive) {
    console.log(
      "Already in the rho Herdr session. Run `rho status` in a shell for heartbeat info.",
    );
    return;
  }

  // If we're already inside the rho tmux session, don't nest-attach.
  if (foreground && process.env.TMUX) {
    try {
      const currentSession = spawnSync(
        "tmux",
        ["display-message", "-p", "#S"],
        { encoding: "utf-8" },
      );
      if (currentSession.stdout?.trim() === SESSION_NAME) {
        console.log(
          "Already in rho session. Run `rho status` in a shell for heartbeat info.",
        );
        return;
      }
    } catch {}
  }

  if (herdrLive) {
    if (foreground) {
      attachHerdrSession();
    } else {
      console.log("Rho already running.");
      console.log(`Attach with: ${herdrAttachCommand()}`);
    }
    return;
  }

  if (plan.tmuxAlreadyRunning) {
    if (host === "herdr") {
      console.log(
        "Rho is still running in tmux. Run `rho stop`, then `rho start`, to move it to Herdr.",
      );
    }
    // Prefer the new dedicated socket if present.
    if (rhoSocketRunning) {
      if (foreground) {
        spawnSync(
          "tmux",
          [...tmuxBaseArgs(), "attach", "-t", plan.sessionName],
          { stdio: "inherit" },
        );
      } else {
        console.log("Rho already running.");
        console.log(
          `Attach with: tmux -L ${getTmuxSocket()} attach -t ${plan.sessionName}`,
        );
      }
      return;
    }

    // Legacy server (default socket) exists.
    console.log("Rho is running on the legacy tmux socket (default config).");
    console.log(
      "To migrate to the rho tmux config, run: rho stop  (then)  rho start",
    );

    if (foreground) {
      spawnSync("tmux", ["attach", "-t", plan.sessionName], {
        stdio: "inherit",
      });
    } else {
      console.log(`Attach with: tmux attach -t ${plan.sessionName}`);
    }
    return;
  }

  // Spawn the detached monitor process.
  //
  // Node's --experimental-strip-types refuses to work on files inside
  // node_modules (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING), so for npm
  // installs we must use the rho.mjs shim (which loads tsx to handle TS).
  // For dev/git-clone installs (outside node_modules), strip-types works and
  // avoids the tsx dependency.
  const cliDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );
  const indexPath = path.join(cliDir, "index.ts");
  const shimPath = path.join(cliDir, "rho.mjs");

  const insideNodeModules = cliDir.includes("node_modules");
  const nodeMajor = parseInt(process.version.slice(1), 10);
  const canStripTypes = nodeMajor >= 22 && !insideNodeModules;

  const childArgs = canStripTypes
    ? [
        "--experimental-strip-types",
        "--no-warnings",
        indexPath,
        "start",
        "--monitor",
      ]
    : [shimPath, "start", "--monitor"];

  const child = spawn(process.execPath, childArgs, {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
  });
  child.unref();

  const expectHerdr = host === "herdr";
  // Wait for the monitor to create the session. Herdr also waits for Pi to be detected.
  let started = false;
  const attempts = expectHerdr ? 40 : 5;
  for (let i = 0; i < attempts; i++) {
    await sleep(1000);
    if (expectHerdr ? herdrAgentLive() : tmuxSessionExists()) {
      started = true;
      break;
    }
  }

  if (!started) {
    console.error(
      expectHerdr
        ? "Failed to start rho daemon (Herdr agent not ready)."
        : "Failed to start rho daemon (tmux session not found after 5s).",
    );
    console.error("Check that pi is installed and on PATH: which pi");
    process.exit(1);
  }

  console.log(
    expectHerdr
      ? `Rho running in Herdr session: ${plan.sessionName}`
      : `Rho running in tmux session: ${plan.sessionName}`,
  );

  if (foreground) {
    if (expectHerdr) {
      if (insideRhoHerdr) {
        console.log(
          "Rho restarted in this Herdr session. Run `rho status` in a shell for heartbeat info.",
        );
      } else {
        attachHerdrSession();
      }
    } else {
      spawnSync("tmux", [...tmuxBaseArgs(), "attach", "-t", plan.sessionName], {
        stdio: "inherit",
      });
    }
  } else {
    console.log(
      expectHerdr
        ? `Attach with: ${herdrAttachCommand()}`
        : `Attach with: tmux -L ${getTmuxSocket()} attach -t ${plan.sessionName}`,
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
