/**
 * Tests for rho daemon commands — daemon-core.ts pure logic.
 * Run: npx tsx tests/test-daemon.ts
 */

// ---- Test harness ----
let PASS = 0;
let FAIL = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  PASS: ${label}`);
    PASS++;
  } else {
    console.error(`  FAIL: ${label}`);
    FAIL++;
  }
}

function assertEq(actual: unknown, expected: unknown, label: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log(`  PASS: ${label}`);
    PASS++;
  } else {
    console.error(`  FAIL: ${label} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
    FAIL++;
  }
}

// ---- Imports ----
import {
  SESSION_NAME,
  PID_FILE,
  buildNotificationArgs,
  notificationToCliArgs,
  isRunning,
  buildModuleDisplay,
  countModules,
  formatStatus,
  planStart,
  planStop,
  type DaemonState,
  type StatusInfo,
  type NotificationArgs,
} from "../cli/daemon-core.ts";
import type { RhoConfig } from "../cli/config.ts";

// ---- Helper: build a config ----

function makeConfig(overrides?: Partial<{
  name: string;
  core: Record<string, boolean>;
  knowledge: Record<string, boolean>;
  tools: Record<string, boolean>;
  skills: Record<string, boolean>;
  ui: Record<string, boolean>;
}>): RhoConfig {
  return {
    agent: { name: overrides?.name ?? "tau" },
    modules: {
      core: overrides?.core ?? { heartbeat: true, memory: true },
      knowledge: overrides?.knowledge ?? { vault: true },
      tools: overrides?.tools ?? {
        "brave-search": true,
        "x-search": true,
        email: true,
      },
      skills: overrides?.skills ?? {
        "session-search": true,
        "update-pi": true,
      },
      ui: overrides?.ui ?? {
        "usage-bars": true,
      },
    },
    settings: {},
  };
}

function makeState(overrides?: Partial<DaemonState>): DaemonState {
  return {
    tmuxRunning: false,
    daemonPid: null,
    daemonPidAlive: false,
    platform: "linux",
    ...overrides,
  };
}

// ===== Constants =====
console.log("\n=== Constants ===\n");

assertEq(SESSION_NAME, "rho", "session name is rho");
assertEq(PID_FILE, ".rho-daemon.pid", "pid file name");

// ===== buildNotificationArgs =====
console.log("\n=== buildNotificationArgs ===\n");

{
  const args = buildNotificationArgs("/usr/bin/tmux");
  assertEq(args.title, "Rho Daemon", "default title");
  assertEq(args.content, "Check-ins active (30m)", "default content with 30m");
  assertEq(args.id, "rho-daemon", "notification id");
  assertEq(args.ongoing, true, "is ongoing");
  assert(args.action.includes("-L rho attach -t rho"), "action attaches to session (rho socket)");
  assert(args.button1Action.includes("/rho now"), "button triggers check-in");
}

{
  const args = buildNotificationArgs("/data/data/com.termux/files/usr/bin/tmux", "15m");
  assertEq(args.content, "Check-ins active (15m)", "custom interval in content");
  assert(
    args.action.startsWith("/data/data/com.termux/files/usr/bin/tmux"),
    "uses full tmux path",
  );
  assert(
    args.action.includes("-L rho"),
    "uses rho socket",
  );
  assert(
    args.button1Action.startsWith("/data/data/com.termux/files/usr/bin/tmux"),
    "button uses full tmux path",
  );
}

{
  const args = buildNotificationArgs("/usr/bin/tmux", "1h");
  assertEq(args.content, "Check-ins active (1h)", "1h interval");
}

// ===== notificationToCliArgs =====
console.log("\n=== notificationToCliArgs ===\n");

{
  const notif = buildNotificationArgs("/usr/bin/tmux");
  const cli = notificationToCliArgs(notif);
  assert(Array.isArray(cli), "returns array");
  assert(cli.includes("--title"), "has --title");
  assert(cli.includes("Rho Daemon"), "has title value");
  assert(cli.includes("--content"), "has --content");
  assert(cli.includes("--id"), "has --id");
  assert(cli.includes("rho-daemon"), "has id value");
  assert(cli.includes("--ongoing"), "has --ongoing");
  assert(cli.includes("--action"), "has --action");
  assert(cli.includes("--button1"), "has --button1");
  assert(cli.includes("--button1-action"), "has --button1-action");

  // Verify ordering: --title comes before its value
  const titleIdx = cli.indexOf("--title");
  assertEq(cli[titleIdx + 1], "Rho Daemon", "title value follows flag");
}

{
  // Non-ongoing notification
  const notif: NotificationArgs = {
    title: "Test",
    content: "test",
    id: "test",
    ongoing: false,
    action: "echo hi",
    button1: "OK",
    button1Action: "echo ok",
  };
  const cli = notificationToCliArgs(notif);
  assert(!cli.includes("--ongoing"), "no --ongoing when false");
}

// ===== isRunning =====
console.log("\n=== isRunning ===\n");

{
  const state = makeState({ tmuxRunning: true });
  assertEq(isRunning(state), true, "running when tmux session exists");
}

{
  const state = makeState({ tmuxRunning: false });
  assertEq(isRunning(state), false, "not running when no tmux session");
}

{
  // PID alive but no tmux session — not considered running
  const state = makeState({ tmuxRunning: false, daemonPid: 123, daemonPidAlive: true });
  assertEq(isRunning(state), false, "not running without tmux even if daemon PID alive");
}

{
  // Tmux running, daemon PID dead — still considered running
  const state = makeState({ tmuxRunning: true, daemonPid: 123, daemonPidAlive: false });
  assertEq(isRunning(state), true, "running with tmux even if daemon PID dead");
}

// ===== countModules =====
console.log("\n=== countModules ===\n");

{
  const config = makeConfig();
  const counts = countModules(config);
  assertEq(counts.enabled, 10, "all 10 modules enabled");
  assertEq(counts.disabled, 0, "0 disabled");
}

{
  const config = makeConfig({
    tools: { "brave-search": true, "x-search": false, email: true },
    ui: { "usage-bars": true },
  });
  const counts = countModules(config);
  assertEq(counts.enabled, 8, "8 enabled");
  assertEq(counts.disabled, 2, "2 disabled");
}

{
  // All non-core disabled
  const config = makeConfig({
    knowledge: { vault: false },
    tools: { "brave-search": false, "x-search": false, email: false },
    skills: { "session-search": false, "update-pi": false },
    ui: { "usage-bars": false },
  });
  const counts = countModules(config);
  assertEq(counts.enabled, 2, "only core enabled");
  assertEq(counts.disabled, 8, "8 disabled");
}

{
  // Empty modules
  const config: RhoConfig = {
    agent: { name: "test" },
    modules: { core: {}, knowledge: {}, tools: {}, skills: {}, ui: {} },
    settings: {},
  };
  const counts = countModules(config);
  assertEq(counts.enabled, 0, "0 enabled when empty");
  assertEq(counts.disabled, 0, "0 disabled when empty");
}

// ===== buildModuleDisplay =====
console.log("\n=== buildModuleDisplay ===\n");

{
  const config = makeConfig();
  const lines = buildModuleDisplay(config);
  assert(lines.length > 0, "has display lines");
  assert(lines.some(l => l.includes("core")), "shows core category");
  assert(lines.some(l => l.includes("knowledge")), "shows knowledge category");
  assert(lines.some(l => l.includes("tools")), "shows tools category");
  assert(lines.some(l => l.includes("ui")), "shows ui category");
  assert(lines.some(l => l.includes("heartbeat ✓")), "heartbeat enabled");
  assert(lines.some(l => l.includes("vault ✓")), "vault enabled");
}

{
  // Mixed enabled/disabled
  const config = makeConfig({
    tools: { "brave-search": true, "x-search": false, email: true },
  });
  const lines = buildModuleDisplay(config);
  assert(lines.some(l => l.includes("brave-search ✓")), "brave-search enabled");
  assert(lines.some(l => l.includes("x-search ✗")), "x-search disabled");
  assert(lines.some(l => l.includes("email ✓")), "email enabled");
}

{
  // Empty category not shown
  const config: RhoConfig = {
    agent: { name: "test" },
    modules: {
      core: { heartbeat: true },
      knowledge: {},
      tools: {},
      skills: {},
      ui: {},
    },
    settings: {},
  };
  const lines = buildModuleDisplay(config);
  assertEq(lines.length, 1, "only one category with entries");
  assert(lines[0].includes("core"), "only core shown");
}

{
  // Indentation format
  const config = makeConfig({ core: { heartbeat: true, memory: true } });
  const coreLine = buildModuleDisplay(config).find(l => l.includes("core"))!;
  assert(coreLine.startsWith("  "), "lines are indented");
  assert(coreLine.includes("core"), "has category name");
}

// ===== formatStatus =====
console.log("\n=== formatStatus ===\n");

{
  // Full status with config
  const info: StatusInfo = {
    state: makeState({ tmuxRunning: true, platform: "android" }),
    version: "0.2.0",
    agentName: "tau",
    config: makeConfig(),
    heartbeat: { enabled: true, intervalMs: 30 * 60 * 1000, lastCheckAt: null, nextCheckAt: Date.now() + 12 * 60 * 1000 },
    paneOutput: "Last heartbeat: ok",
  };
  const output = formatStatus(info);
  assert(output.includes("rho v0.2.0"), "shows version");
  assert(output.includes("agent: tau"), "shows agent name");
  assert(output.includes("platform: android"), "shows platform");
  assert(output.includes("Heartbeat: running"), "shows running state");
  assert(output.includes("next:"), "shows next check-in when available");
  assert(output.includes("10 enabled"), "shows enabled count");
  assert(output.includes("heartbeat ✓"), "shows modules");
  assert(output.includes("Recent output"), "shows pane output header");
  assert(output.includes("Last heartbeat: ok"), "shows pane content");
}

{
  // Stopped, no config
  const info: StatusInfo = {
    state: makeState({ tmuxRunning: false, platform: "linux" }),
    version: null,
    agentName: null,
    config: null,
    heartbeat: null,
    paneOutput: null,
  };
  const output = formatStatus(info);
  assert(output.includes("rho |"), "no version when null");
  assert(!output.includes("agent:"), "no agent when null");
  assert(output.includes("platform: linux"), "shows platform");
  assert(output.includes("Heartbeat: stopped"), "shows stopped");
  assert(!output.includes("Modules:"), "no modules when no config");
  assert(!output.includes("Recent output"), "no pane output when stopped");
}

{
  // Running but no pane output
  const info: StatusInfo = {
    state: makeState({ tmuxRunning: true, platform: "macos" }),
    version: "0.1.0",
    agentName: "rho",
    config: makeConfig(),
    heartbeat: null,
    paneOutput: null,
  };
  const output = formatStatus(info);
  assert(output.includes("Heartbeat: running"), "running");
  assert(!output.includes("Recent output"), "no pane section when null");
}

{
  // With disabled modules
  const config = makeConfig({
    tools: { "brave-search": true, "x-search": false, email: true },
    ui: { "usage-bars": true },
  });
  const info: StatusInfo = {
    state: makeState({ tmuxRunning: true }),
    version: "0.2.0",
    agentName: "tau",
    config,
    heartbeat: null,
    paneOutput: null,
  };
  const output = formatStatus(info);
  assert(output.includes("8 enabled, 2 disabled"), "shows disabled count");
}

{
  // Pane output not shown when not running (even if provided)
  const info: StatusInfo = {
    state: makeState({ tmuxRunning: false }),
    version: null,
    agentName: null,
    config: null,
    heartbeat: null,
    paneOutput: "stale output",
  };
  const output = formatStatus(info);
  assert(!output.includes("stale output"), "pane output hidden when stopped");
}

// ===== planStart =====
console.log("\n=== planStart ===\n");

{
  // Fresh start on Linux
  const state = makeState({ platform: "linux" });
  const plan = planStart(state, "/home/user");
  assertEq(plan.needsWakeLock, false, "no wake lock on linux");
  assertEq(plan.needsNotification, false, "no notification on linux");
  assertEq(plan.tmuxAlreadyRunning, false, "tmux not running");
  assertEq(plan.sessionName, "rho", "session name");
  assertEq(plan.homeDir, "/home/user", "home dir");
}

{
  // Fresh start on Android
  const state = makeState({ platform: "android" });
  const plan = planStart(state, "/data/data/com.termux/files/home");
  assertEq(plan.needsWakeLock, true, "wake lock on android");
  assertEq(plan.needsNotification, true, "notification on android");
  assertEq(plan.tmuxAlreadyRunning, false, "tmux not running");
}

{
  // Already running
  const state = makeState({ tmuxRunning: true, platform: "android" });
  const plan = planStart(state, "/home");
  assertEq(plan.tmuxAlreadyRunning, true, "tmux already running");
  assertEq(plan.needsWakeLock, true, "still needs wake lock");
}

{
  // macOS
  const state = makeState({ platform: "macos" });
  const plan = planStart(state, "/Users/user");
  assertEq(plan.needsWakeLock, false, "no wake lock on macos");
  assertEq(plan.needsNotification, false, "no notification on macos");
}

// ===== planStop =====
console.log("\n=== planStop ===\n");

{
  // Stop on Linux, running
  const state = makeState({ tmuxRunning: true, daemonPid: 1234, platform: "linux" });
  const plan = planStop(state);
  assertEq(plan.needsWakeUnlock, false, "no wake unlock on linux");
  assertEq(plan.needsNotificationRemove, false, "no notification remove on linux");
  assertEq(plan.tmuxRunning, true, "tmux is running");
  assertEq(plan.daemonPid, 1234, "has daemon PID");
  assertEq(plan.sessionName, "rho", "session name");
}

{
  // Stop on Android, running
  const state = makeState({ tmuxRunning: true, daemonPid: 5678, platform: "android" });
  const plan = planStop(state);
  assertEq(plan.needsWakeUnlock, true, "wake unlock on android");
  assertEq(plan.needsNotificationRemove, true, "notification remove on android");
}

{
  // Stop when already stopped
  const state = makeState({ tmuxRunning: false, daemonPid: null });
  const plan = planStop(state);
  assertEq(plan.tmuxRunning, false, "tmux not running");
  assertEq(plan.daemonPid, null, "no daemon PID");
}

{
  // Stop with daemon PID but no tmux (zombie state)
  const state = makeState({ tmuxRunning: false, daemonPid: 9999, platform: "android" });
  const plan = planStop(state);
  assertEq(plan.tmuxRunning, false, "tmux not running");
  assertEq(plan.daemonPid, 9999, "daemon PID to kill");
  assertEq(plan.needsWakeUnlock, true, "still unlock on android");
}

// ===== Edge cases =====
console.log("\n=== Edge cases ===\n");

{
  // formatStatus with all modules disabled except core
  const config = makeConfig({
    knowledge: { vault: false },
    tools: { "brave-search": false, "x-search": false, email: false },
    skills: { "session-search": false, "update-pi": false },
    ui: { "usage-bars": false },
  });
  const info: StatusInfo = {
    state: makeState({ tmuxRunning: true }),
    version: "0.2.0",
    agentName: "test",
    config,
    heartbeat: null,
    paneOutput: null,
  };
  const output = formatStatus(info);
  assert(output.includes("2 enabled, 8 disabled"), "mostly disabled status");
  assert(output.includes("vault ✗"), "vault shown as disabled");
}

{
  // buildNotificationArgs with empty interval
  const args = buildNotificationArgs("/usr/bin/tmux", "");
  assertEq(args.content, "Check-ins active ()", "empty interval handled");
}

{
  // planStart and planStop are consistent on session name
  const state = makeState();
  const start = planStart(state, "/home");
  const stop = planStop(state);
  assertEq(start.sessionName, stop.sessionName, "same session name");
  assertEq(start.sessionName, SESSION_NAME, "matches constant");
}

// ---- Summary ----
console.log(`\n${"=".repeat(40)}`);
console.log(`Total: ${PASS + FAIL}  |  PASS: ${PASS}  |  FAIL: ${FAIL}`);
if (FAIL > 0) process.exit(1);
