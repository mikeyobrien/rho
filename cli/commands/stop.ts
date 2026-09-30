/**
 * rho stop — Stop the heartbeat daemon.
 *
 * Stops the background monitor process (if present) and kills the tmux session.
 * On Android, also releases wake lock and removes notification (defense in depth).
 */

import * as os from "node:os";
import * as path from "node:path";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { detectPlatform } from "../init-core.ts";
import { parseInitToml } from "../config.ts";
import {
  SESSION_NAME,
  PID_FILE,
  planStop,
  type DaemonState,
} from "../daemon-core.ts";
import { herdrServerRunning, stopHerdrSession } from "../herdr-client.ts";

const HOME = process.env.HOME || os.homedir();
const RHO_DIR = path.join(HOME, ".rho");
const INIT_TOML = path.join(RHO_DIR, "init.toml");
const PID_PATH = path.join(HOME, PID_FILE);

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

function readDaemonPid(): number | null {
  try {
    const content = readFileSync(PID_PATH, "utf-8").trim();
    const pid = parseInt(content, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

export async function run(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`rho stop

Stop the Rho heartbeat daemon.

Stops the background monitor process and the dedicated rho Herdr or tmux session.

Options:
  -h, --help   Show this help`);
    return;
  }

  const platform = detectPlatform();
  const herdrRunning = herdrServerRunning();
  const rhoSocketRunning = tmuxSessionExists();
  const legacyRunning = tmuxLegacySessionExists();

  const state: DaemonState = {
    tmuxRunning: herdrRunning || rhoSocketRunning || legacyRunning,
    daemonPid: readDaemonPid(),
    daemonPidAlive: false,
    platform,
  };

  const plan = planStop(state);

  if (!plan.tmuxRunning && plan.daemonPid === null) {
    console.log("Rho is not running.");
    return;
  }

  console.log("Stopping rho daemon...");

  // Stop monitor first so it doesn't restart tmux. Wait until it exits so a
  // following start cannot have its pid file unlinked by the old cleanup.
  if (plan.daemonPid !== null) {
    try {
      process.kill(plan.daemonPid, "SIGTERM");
    } catch {
      // stale pid
    }
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        process.kill(plan.daemonPid, 0);
      } catch {
        break;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }

  // Stop only the dedicated rho Herdr session. Never the default session.
  if (herdrRunning) stopHerdrSession();

  // Kill tmux session (new socket + legacy socket)
  if (plan.tmuxRunning) {
    spawnSync("tmux", tmuxArgs(["kill-session", "-t", plan.sessionName]), {
      stdio: "ignore",
    });
    spawnSync("tmux", ["kill-session", "-t", plan.sessionName], {
      stdio: "ignore",
    });
  }

  // Clean up PID file
  try {
    unlinkSync(PID_PATH);
  } catch {}

  // Android cleanup (defense in depth)
  if (plan.needsWakeUnlock) {
    spawnSync("termux-wake-unlock", [], { stdio: "ignore" });
  }

  if (plan.needsNotificationRemove) {
    spawnSync("termux-notification-remove", ["rho-daemon"], {
      stdio: "ignore",
    });
  }

  console.log("Rho daemon stopped.");
}
