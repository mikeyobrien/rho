/**
 * rho logs — Tail heartbeat pane output without attaching to tmux.
 */

import * as os from "node:os";
import * as path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

import { parseInitToml } from "../config.ts";
import { SESSION_NAME } from "../daemon-core.ts";
import { herdrAgentLive, herdrServerRunning, readHerdrAgent } from "../herdr-client.ts";

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

function tmuxArgs(extra: string[]): string[] {
  return ["-L", getTmuxSocket(), ...extra];
}

function sessionExists(): boolean {
  const r = spawnSync("tmux", tmuxArgs(["has-session", "-t", SESSION_NAME]), {
    stdio: "ignore",
  });
  return r.status === 0;
}

function windowExists(window: string): boolean {
  const target = `${SESSION_NAME}:${window}`;
  const r = spawnSync("tmux", tmuxArgs(["has-session", "-t", target]), {
    stdio: "ignore",
  });
  return r.status === 0;
}

function capturePane(target: string): string[] {
  const r = spawnSync("tmux", tmuxArgs(["capture-pane", "-t", target, "-p"]), {
    encoding: "utf-8",
  });
  if (r.status !== 0) return [];
  return (r.stdout || "").split("\n");
}

function parseArgs(args: string[]): {
  lines: number;
  follow: boolean;
  help: boolean;
} {
  let lines = 50;
  let follow = false;
  let help = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") {
      help = true;
    } else if (a === "--follow" || a === "-f") {
      follow = true;
    } else if (a === "--lines" || a === "-n") {
      const next = args[++i];
      const n = parseInt(next, 10);
      if (Number.isFinite(n) && n > 0) lines = n;
    }
  }

  return { lines, follow, help };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function run(args: string[]): Promise<void> {
  const opts = parseArgs(args);

  if (opts.help) {
    console.log(`rho logs

Show recent heartbeat output from the dedicated rho Herdr or tmux session.

Options:
  -n, --lines N   Number of lines to show (default: 50)
  -f, --follow    Poll for new output every 2 seconds
  -h, --help      Show this help`);
    return;
  }

  if (herdrServerRunning()) {
    if (!herdrAgentLive()) {
      console.error("Rho Herdr session is up, but the rho agent is not running.");
      process.exitCode = 1;
      return;
    }
    const show = () => {
      const text = readHerdrAgent(opts.lines);
      const tail = text.split("\n").slice(-opts.lines);
      process.stdout.write(tail.join("\n") + "\n");
    };
    if (!opts.follow) {
      show();
      return;
    }
    let last = "";
    while (true) {
      const text = readHerdrAgent(opts.lines);
      if (text !== last) {
        process.stdout.write(text.endsWith("\n") ? text : text + "\n");
        last = text;
      }
      await sleep(2000);
    }
  }

  if (!sessionExists()) {
    console.error("Rho session is not running. Start it with `rho start`.");
    process.exitCode = 1;
    return;
  }

  // Prefer heartbeat window, fall back to main window
  const hasHeartbeat = windowExists("heartbeat");
  const target = hasHeartbeat
    ? `${SESSION_NAME}:heartbeat`
    : `${SESSION_NAME}:0`;

  if (!hasHeartbeat) {
    console.error("heartbeat window not found, falling back to main window\n");
  }

  if (!opts.follow) {
    const lines = capturePane(target);
    const tail = lines.slice(-opts.lines);
    process.stdout.write(tail.join("\n") + "\n");
    return;
  }

  // Follow mode: poll every 2s and print new lines
  let lastContent = "";

  // Print initial snapshot
  const initial = capturePane(target);
  const initialTail = initial.slice(-opts.lines);
  const initialText = initialTail.join("\n");
  process.stdout.write(initialText + "\n");
  lastContent = initial.join("\n");

  while (true) {
    await sleep(2000);
    const current = capturePane(target);
    const currentText = current.join("\n");

    if (currentText !== lastContent) {
      // Find new content by comparing full snapshots
      // Simple approach: print lines that differ from the end
      const oldLines = lastContent.split("\n");
      const newLines = current;

      // Find where old content ends in new content
      let newStart = 0;
      if (oldLines.length > 0) {
        const lastOldLine = oldLines[oldLines.length - 1];
        const lastOldIdx = newLines.lastIndexOf(lastOldLine);
        if (lastOldIdx >= 0) {
          newStart = lastOldIdx + 1;
        }
      }

      const diff = newLines.slice(newStart).filter((l) => l.trim() !== "");
      if (diff.length > 0) {
        process.stdout.write(diff.join("\n") + "\n");
      }

      lastContent = currentText;
    }
  }
}
