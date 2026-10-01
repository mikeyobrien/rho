/**
 * cli/daemon-core.ts — Pure daemon logic, no filesystem/process IO.
 *
 * Builds notification args, formats status output, plans daemon
 * operations. All functions are pure and testable.
 */

import type { RhoConfig } from "./config.ts";

// ---- Constants ----

export const SESSION_NAME = "rho";
export const PID_FILE = ".rho-daemon.pid";

// ---- Types ----

export type Platform = "android" | "macos" | "linux";

export interface DaemonState {
  sessionRunning: boolean;
  daemonPid: number | null;
  daemonPidAlive: boolean;
  platform: Platform;
}

export interface HeartbeatState {
  enabled: boolean;
  intervalMs: number;
  lastCheckAt: number | null;
  nextCheckAt: number | null;
  checkCount?: number;
}

export interface StatusInfo {
  state: DaemonState;
  version: string | null;
  agentName: string | null;
  config: RhoConfig | null;
  heartbeat: HeartbeatState | null;
  paneOutput: string | null;
  tmuxSocket?: string;
  sessionAttach?: string;
}

export interface NotificationArgs {
  title: string;
  content: string;
  id: string;
  ongoing: boolean;
  action: string;
  button1: string;
  button1Action: string;
}

// ---- Notification ----

/**
 * Build termux-notification arguments for the daemon notification.
 * @param tmuxBin Path to the tmux binary
 * @param interval Heartbeat interval string (e.g. "30m")
 */
export function buildNotificationArgs(
  tmuxBin: string,
  interval: string = "30m",
  socketName: string = SESSION_NAME,
): NotificationArgs {
  // Use a dedicated tmux socket so Rho sessions can use an opinionated tmux
  // config without affecting the user's default tmux server.
  const base = `${tmuxBin} -L ${socketName}`;

  return {
    title: "Rho Daemon",
    content: `Check-ins active (${interval})`,
    id: "rho-daemon",
    ongoing: true,
    action: `${base} attach -t ${SESSION_NAME}`,
    button1: "Check Now",
    button1Action: `${base} send-keys -t ${SESSION_NAME} '/rho now' Enter`,
  };
}

/**
 * Convert NotificationArgs to a flat array of CLI arguments
 * for termux-notification.
 */
export function notificationToCliArgs(args: NotificationArgs): string[] {
  const result: string[] = [
    "--title",
    args.title,
    "--content",
    args.content,
    "--id",
    args.id,
  ];
  if (args.ongoing) result.push("--ongoing");
  result.push("--action", args.action);
  result.push("--button1", args.button1);
  result.push("--button1-action", args.button1Action);
  return result;
}

// ---- Status formatting ----

/**
 * Check if the daemon is effectively running.
 * True if tmux session exists (daemon PID is optional — session is the source of truth).
 */
export function isRunning(state: DaemonState): boolean {
  return state.sessionRunning;
}

/**
 * Build the module state display lines for status output.
 * Groups modules by category, shows enabled (✓) / disabled (✗).
 */
export function buildModuleDisplay(config: RhoConfig): string[] {
  const lines: string[] = [];
  const categories = ["core", "knowledge", "tools", "skills", "ui"] as const;

  for (const cat of categories) {
    const mods = config.modules[cat] ?? {};
    const entries = Object.entries(mods);
    if (entries.length === 0) continue;

    const parts: string[] = [];
    for (const [name, enabled] of entries) {
      parts.push(`${name} ${enabled ? "✓" : "✗"}`);
    }

    lines.push(`  ${cat.padEnd(12)} ${parts.join("  ")}`);
  }

  return lines;
}

/**
 * Count enabled and disabled modules from config.
 */
export function countModules(config: RhoConfig): {
  enabled: number;
  disabled: number;
} {
  let enabled = 0;
  let disabled = 0;

  const categories = ["core", "knowledge", "tools", "skills", "ui"] as const;
  for (const cat of categories) {
    const mods = config.modules[cat] ?? {};
    for (const val of Object.values(mods)) {
      if (val) enabled++;
      else disabled++;
    }
  }

  return { enabled, disabled };
}

/**
 * Format the full status output.
 */
export function formatStatus(info: StatusInfo): string {
  const lines: string[] = [];

  // Header line
  const vPart = info.version ? `rho v${info.version}` : "rho";
  const namePart = info.agentName ? ` | agent: ${info.agentName}` : "";
  const platPart = ` | platform: ${info.state.platform}`;
  lines.push(`${vPart}${namePart}${platPart}`);
  lines.push("");

  // Daemon state + heartbeat schedule
  const runState = info.state.sessionRunning ? "running" : "stopped";
  let hbLine = `Heartbeat: ${runState}`;

  if (info.state.sessionRunning && info.heartbeat) {
    if (!info.heartbeat.enabled || info.heartbeat.intervalMs === 0) {
      hbLine += " (disabled)";
    } else if (typeof info.heartbeat.nextCheckAt === "number") {
      const remaining = info.heartbeat.nextCheckAt - Date.now();
      const mins = Math.max(0, Math.ceil(remaining / 60000));
      hbLine += ` (next: ${mins}m)`;
    }
  }

  lines.push(hbLine);

  if (info.state.sessionRunning && info.sessionAttach) {
    lines.push(`Session:   ${info.sessionAttach}`);
  } else if (info.state.sessionRunning && info.tmuxSocket) {
    lines.push(
      `Session:   tmux -L ${info.tmuxSocket} attach -t ${SESSION_NAME}`,
    );
  }

  if (!info.state.sessionRunning) {
    if (!info.config) {
      lines.push("  → Run `rho init` first (no config found)");
    }
    lines.push("  → Run `rho start` to begin");
  }

  // Module summary
  if (info.config) {
    const counts = countModules(info.config);
    lines.push(
      `Modules:   ${counts.enabled} enabled${counts.disabled > 0 ? `, ${counts.disabled} disabled` : ""}`,
    );
    lines.push("");
    lines.push(...buildModuleDisplay(info.config));
  }

  // Pane output (last lines from tmux)
  if (info.paneOutput && info.state.sessionRunning) {
    lines.push("");
    lines.push("--- Recent output ---");
    lines.push(info.paneOutput);
  }

  return lines.join("\n");
}

// ---- Start/stop planning ----

export interface StartPlan {
  needsWakeLock: boolean;
  needsNotification: boolean;
  tmuxAlreadyRunning: boolean;
  sessionName: string;
  homeDir: string;
}

/**
 * Plan what the start command needs to do.
 */
export function planStart(state: DaemonState, homeDir: string): StartPlan {
  return {
    needsWakeLock: state.platform === "android",
    needsNotification: state.platform === "android",
    tmuxAlreadyRunning: state.sessionRunning,
    sessionName: SESSION_NAME,
    homeDir,
  };
}

export interface StopPlan {
  needsWakeUnlock: boolean;
  needsNotificationRemove: boolean;
  sessionRunning: boolean;
  daemonPid: number | null;
  sessionName: string;
}

/**
 * Plan what the stop command needs to do.
 */
export function planStop(state: DaemonState): StopPlan {
  return {
    needsWakeUnlock: state.platform === "android",
    needsNotificationRemove: state.platform === "android",
    sessionRunning: state.sessionRunning,
    daemonPid: state.daemonPid,
    sessionName: SESSION_NAME,
  };
}
