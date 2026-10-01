/**
 * rho status — Show daemon state and module configuration.
 */

import * as os from "node:os";
import * as path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { detectPlatform } from "../init-core.ts";
import { parseInitToml } from "../config.ts";
import { herdrServerRunning, readHerdrAgent } from "../herdr-client.ts";
import { herdrAttachCommand } from "../session-host.ts";
import {
  SESSION_NAME,
  PID_FILE,
  formatStatus,
  isRunning,
  type DaemonState,
  type StatusInfo,
  type HeartbeatState,
} from "../daemon-core.ts";

const HOME = process.env.HOME || os.homedir();
const RHO_DIR = path.join(HOME, ".rho");
const PID_PATH = path.join(HOME, PID_FILE);
const INIT_TOML = path.join(RHO_DIR, "init.toml");
const HB_STATE_PATH = path.join(RHO_DIR, "rho-state.json");
const HB_SETTINGS_PATH = path.join(RHO_DIR, "rho-settings.json");

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

function tmuxArgs(args: string[]): string[] {
  return ["-L", getTmuxSocket(), ...args];
}

function tmuxSessionExists(): boolean {
  // New dedicated socket
  const r = spawnSync("tmux", tmuxArgs(["has-session", "-t", SESSION_NAME]), {
    stdio: "ignore",
  });
  return r.status === 0;
}

function tmuxLegacySessionExists(): boolean {
  const r = spawnSync("tmux", ["has-session", "-t", SESSION_NAME], {
    stdio: "ignore",
  });
  return r.status === 0;
}

function getActiveTmuxArgs(): { baseArgs: string[]; legacy: boolean } | null {
  if (tmuxSessionExists()) return { baseArgs: tmuxArgs([]), legacy: false };
  if (tmuxLegacySessionExists()) return { baseArgs: [], legacy: true };
  return null;
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

function getVersion(): string | null {
  try {
    const pkgRoot = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
    );
    const pkg = JSON.parse(
      readFileSync(path.join(pkgRoot, "package.json"), "utf-8"),
    );
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

function capturePaneOutput(): string | null {
  try {
    const active = getActiveTmuxArgs();
    if (!active) return null;

    const r = spawnSync(
      "tmux",
      [...active.baseArgs, "capture-pane", "-t", SESSION_NAME, "-p"],
      { encoding: "utf-8" },
    );
    if (r.status !== 0) return null;
    const out = r.stdout || "";
    const lines = out.split("\n").filter((l) => l.trim() !== "");
    if (lines.length === 0) return null;
    return lines.slice(-20).join("\n");
  } catch {
    return null;
  }
}

function readHeartbeatState(): HeartbeatState | null {
  try {
    if (!existsSync(HB_STATE_PATH)) return null;
    const raw = JSON.parse(readFileSync(HB_STATE_PATH, "utf-8"));
    if (!raw || typeof raw !== "object") return null;

    const enabled = typeof raw.enabled === "boolean" ? raw.enabled : false;
    const intervalMs = typeof raw.intervalMs === "number" ? raw.intervalMs : 0;
    const lastCheckAt =
      typeof raw.lastCheckAt === "number" ? raw.lastCheckAt : null;
    const nextCheckAt =
      typeof raw.nextCheckAt === "number" ? raw.nextCheckAt : null;
    const checkCount =
      typeof raw.checkCount === "number" ? raw.checkCount : undefined;

    return { enabled, intervalMs, lastCheckAt, nextCheckAt, checkCount };
  } catch {
    return null;
  }
}

function readHeartbeatSettings(): {
  enabled: boolean;
  intervalMs: number;
} | null {
  try {
    if (!existsSync(HB_SETTINGS_PATH)) return null;
    const raw = JSON.parse(readFileSync(HB_SETTINGS_PATH, "utf-8"));
    if (!raw || typeof raw !== "object") return null;
    const enabled =
      typeof (raw as any).enabled === "boolean" ? (raw as any).enabled : null;
    const intervalMs =
      typeof (raw as any).intervalMs === "number"
        ? (raw as any).intervalMs
        : null;
    if (enabled === null || intervalMs === null) return null;
    return { enabled, intervalMs };
  } catch {
    return null;
  }
}

function mergeHeartbeat(
  state: HeartbeatState | null,
  settings: { enabled: boolean; intervalMs: number } | null,
): HeartbeatState | null {
  if (!state && !settings) return null;
  return {
    enabled: settings?.enabled ?? state?.enabled ?? false,
    intervalMs: settings?.intervalMs ?? state?.intervalMs ?? 0,
    lastCheckAt: state?.lastCheckAt ?? null,
    nextCheckAt: state?.nextCheckAt ?? null,
    checkCount: state?.checkCount,
  };
}

export async function run(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`rho status

Show the Rho daemon status and module configuration.

Options:
  --json       Output as JSON
  -h, --help   Show this help`);
    return;
  }

  const jsonMode = args.includes("--json");
  const platform = detectPlatform();
  const daemonPid = readDaemonPid();

  const active = getActiveTmuxArgs();
  const herdrRunning = herdrServerRunning();

  const state: DaemonState = {
    sessionRunning: herdrRunning || active !== null,
    daemonPid,
    daemonPidAlive: daemonPid === null ? false : pidAlive(daemonPid),
    platform,
  };

  let config = null;
  let agentName = null;
  if (existsSync(INIT_TOML)) {
    try {
      config = parseInitToml(readFileSync(INIT_TOML, "utf-8"));
      agentName = config.agent.name;
    } catch {
      // ignore
    }
  }

  const info: StatusInfo = {
    state,
    version: getVersion(),
    agentName,
    config,
    heartbeat: mergeHeartbeat(readHeartbeatState(), readHeartbeatSettings()),
    paneOutput: herdrRunning
      ? readHerdrAgent(20) || null
      : state.sessionRunning
        ? capturePaneOutput()
        : null,
    tmuxSocket: getTmuxSocket(),
    sessionAttach: herdrRunning ? herdrAttachCommand() : undefined,
  };

  if (jsonMode) {
    console.log(
      JSON.stringify(
        {
          running: isRunning(state),
          version: info.version,
          agent: agentName,
          platform,
          tmuxSession: state.sessionRunning,
          host: herdrRunning ? "herdr" : active ? "tmux" : null,
          session: herdrRunning ? "rho" : null,
          daemonPid: state.daemonPid,
          daemonPidAlive: state.daemonPidAlive,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(formatStatus(info));

  if (!isRunning(state)) process.exitCode = 1;
}
