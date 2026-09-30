/**
 * rho trigger — Force an immediate heartbeat check-in.
 *
 * Sends the `/rho now` command to the running tmux session.
 * Starts the daemon if not running.
 */

import { spawnSync } from "node:child_process";

import { SESSION_NAME } from "../daemon-core.ts";

import { existsSync, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { parseInitToml } from "../config.ts";

const HOME = process.env.HOME || os.homedir();
const RHO_DIR = path.join(HOME, ".rho");
const INIT_TOML = path.join(RHO_DIR, "init.toml");

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

function getActiveTmuxArgs(): string[] | null {
  if (tmuxSessionExists()) return tmuxArgs([]);
  if (tmuxLegacySessionExists()) return [];
  return null;
}

export async function run(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`rho trigger

Force an immediate heartbeat check-in.

Sends '/rho now' to the running tmux session. If the daemon
is not running, starts it first.

Options:
  -h, --help   Show this help`);
    return;
  }

  if (!getActiveTmuxArgs()) {
    console.log("Rho not running. Starting...");
    const { run: startRun } = await import("./start.ts");
    await startRun([]);

    // Give tmux/pi a moment to initialize.
    await new Promise((resolve) => setTimeout(resolve, 2000));

    if (!getActiveTmuxArgs()) {
      console.error("Failed to start rho daemon.");
      process.exit(1);
    }
  }

  const active = getActiveTmuxArgs();
  if (!active) {
    console.error(
      "Failed to trigger check-in (tmux session missing). Try: rho start",
    );
    process.exit(1);
  }

  // Send check-in command
  const r = spawnSync(
    "tmux",
    [...active, "send-keys", "-t", SESSION_NAME, "/rho now", "Enter"],
    { stdio: "ignore" },
  );
  if (r.status !== 0) {
    console.error("Failed to trigger check-in.");
    process.exit(1);
  }

  console.log("Heartbeat check-in triggered.");

  // Show tmux display message if possible
  spawnSync(
    "tmux",
    [
      ...active,
      "display-message",
      "-t",
      SESSION_NAME,
      "Rho check-in triggered",
    ],
    { stdio: "ignore" },
  );
}
