/**
 * rho telegram — Manage the Telegram worker.
 */

import * as path from "node:path";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";

import { Api } from "../../extensions/telegram/api.ts";
import {
  loadRuntimeState,
  readTelegramSettings,
  TELEGRAM_CHECK_TRIGGER_PATH,
  TELEGRAM_DIR,
  TELEGRAM_WORKER_LOCK_PATH,
} from "../../extensions/telegram/lib.ts";
import { loadOperatorConfig, saveOperatorConfig } from "../../extensions/telegram/operator-config.ts";
import {
  approvePendingByPin,
  listPendingApprovals,
  rejectPendingByPin,
} from "../../extensions/telegram/pending-approvals.ts";
import { readTelegramWorkerLockOwner } from "../../extensions/telegram/worker-lock.ts";
import { getTelegramCheckTriggerState, requestTelegramCheckTrigger } from "../../extensions/telegram/check-trigger.ts";
import { renderTelegramStatusText } from "../../extensions/telegram/status.ts";
import { isLeaseStale, readLeaseMeta } from "../../extensions/lib/lease-lock.ts";

const DEFAULT_WORKER_LOCK_STALE_MS = 90_000;

interface OnboardOptions {
  token?: string;
  chatId?: number;
  userId?: number;
  timeoutSeconds: number;
  allowlist: boolean;
  help: boolean;
}

interface TelegramGetMeResult {
  id: number;
  username?: string;
  first_name?: string;
}

interface HandshakeUpdate {
  chatId: number;
  userId: number | null;
  fromName: string;
  updateId: number;
}

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function getWorkerStatus(): { owner: ReturnType<typeof readTelegramWorkerLockOwner>; stale: boolean } {
  const meta = readLeaseMeta(TELEGRAM_WORKER_LOCK_PATH);
  if (!meta.payload) {
    return { owner: null, stale: false };
  }
  const staleMs = parsePositiveIntEnv("RHO_TELEGRAM_WORKER_LOCK_STALE_MS", DEFAULT_WORKER_LOCK_STALE_MS);
  const stale = isLeaseStale(meta, staleMs, Date.now());
  return { owner: readTelegramWorkerLockOwner(TELEGRAM_WORKER_LOCK_PATH), stale };
}

function formatOwner(owner: ReturnType<typeof readTelegramWorkerLockOwner> | null, stale: boolean): { leadership: string; ownerText: string } {
  if (!owner) {
    return { leadership: "stopped", ownerText: "none" };
  }
  const host = owner.hostname ? ` @${owner.hostname}` : "";
  const staleText = stale ? " (stale)" : "";
  return {
    leadership: stale
      ? `stale lock (pid ${owner.pid}${host})`
      : `worker (pid ${owner.pid}${host})`,
    ownerText: `${owner.pid}${host}${staleText}`,
  };
}

function allowedText(values: number[]): string {
  return values.length === 0 ? "all" : values.join(",");
}

function buildStatusText(): string {
  const settings = readTelegramSettings();
  const operator = loadOperatorConfig();
  const runtimeAllowedChatIds = operator?.allowedChatIds ?? settings.allowedChatIds;
  const runtimeAllowedUserIds = operator?.allowedUserIds ?? settings.allowedUserIds;
  const runtime = loadRuntimeState();
  const trigger = getTelegramCheckTriggerState(TELEGRAM_CHECK_TRIGGER_PATH, 0);
  const { owner, stale } = getWorkerStatus();
  const formatted = formatOwner(owner, stale);

  return renderTelegramStatusText({
    enabled: settings.enabled,
    mode: settings.mode,
    leadershipText: formatted.leadership,
    pollLockPath: TELEGRAM_WORKER_LOCK_PATH,
    pollLockOwnerText: formatted.ownerText,
    triggerPath: TELEGRAM_CHECK_TRIGGER_PATH,
    triggerPending: trigger.pending,
    triggerRequesterPid: trigger.requesterPid ?? null,
    triggerRequestedAt: trigger.requestedAt ?? null,
    lastCheckRequestAt: runtime.last_check_request_at ?? trigger.requestedAt ?? null,
    lastCheckConsumeAt: runtime.last_check_consume_at ?? null,
    lastCheckOutcome: runtime.last_check_outcome ?? null,
    lastCheckRequesterPid: runtime.last_check_requester_pid ?? null,
    tokenEnv: settings.botTokenEnv,
    lastUpdateId: runtime.last_update_id,
    lastPollAt: runtime.last_poll_at,
    pollFailures: runtime.consecutive_failures,
    sendFailures: 0,
    pendingInbound: 0,
    pendingOutbound: 0,
    allowedChatsText: allowedText(runtimeAllowedChatIds),
    allowedUsersText: allowedText(runtimeAllowedUserIds),
  });
}

function parseLogsArgs(args: string[]): { lines: number; follow: boolean; help: boolean } {
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

function parseOnboardArgs(args: string[]): OnboardOptions {
  const out: OnboardOptions = {
    timeoutSeconds: 120,
    allowlist: true,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--help" || a === "-h") {
      out.help = true;
    } else if (a === "--token") {
      out.token = args[++i];
    } else if (a === "--chat-id") {
      const n = parseInt(args[++i] ?? "", 10);
      if (Number.isFinite(n)) out.chatId = n;
    } else if (a === "--user-id") {
      const n = parseInt(args[++i] ?? "", 10);
      if (Number.isFinite(n)) out.userId = n;
    } else if (a === "--timeout") {
      const n = parseInt(args[++i] ?? "", 10);
      if (Number.isFinite(n) && n > 0) out.timeoutSeconds = n;
    } else if (a === "--no-allowlist") {
      out.allowlist = false;
    }
  }

  return out;
}

function readLogLines(logPath: string): string[] {
  if (!existsSync(logPath)) return [];
  const raw = readFileSync(logPath, "utf-8");
  if (!raw.trim()) return [];
  return raw.split("\n");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function promptForToken(tokenEnv: string): Promise<string | null> {
  if (!process.stdin.isTTY) return null;
  console.log("Step 1: Create a Telegram bot");
  console.log("  1. Open Telegram and message @BotFather");
  console.log("  2. Send /newbot and follow the prompts");
  console.log("  3. Copy the bot token");
  console.log(`  4. Or set env var: ${tokenEnv}`);
  console.log("");

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const token = (await rl.question("Paste bot token: ")).trim();
    return token.length > 0 ? token : null;
  } finally {
    rl.close();
  }
}

async function telegramGetMe(token: string): Promise<TelegramGetMeResult> {
  const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });

  const json = await response.json().catch(() => null) as { ok?: boolean; result?: TelegramGetMeResult; description?: string } | null;
  if (!response.ok || !json?.ok || !json.result) {
    const msg = json?.description || `HTTP ${response.status}`;
    throw new Error(msg);
  }
  return json.result;
}

async function waitForHandshakeUpdate(client: Api, timeoutSeconds: number, offset?: number): Promise<HandshakeUpdate> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let nextOffset = typeof offset === "number" ? offset : undefined;

  while (Date.now() < deadline) {
    const remainingSeconds = Math.max(1, Math.ceil((deadline - Date.now()) / 1000));
    const updates = await client.getUpdates({
      offset: nextOffset,
      timeout: Math.min(10, remainingSeconds),
      allowed_updates: ["message", "edited_message"],
    });

    if (updates.length > 0) {
      nextOffset = Math.max(...updates.map((u) => u.update_id)) + 1;
      for (const update of updates) {
        const msg = update.message ?? update.edited_message;
        if (!msg || typeof msg.chat?.id !== "number") continue;
        const fromFirst = msg.from?.first_name || "";
        const fromLast = msg.from?.last_name || "";
        const fromName = `${fromFirst} ${fromLast}`.trim() || msg.from?.username || "unknown";
        return {
          chatId: msg.chat.id,
          userId: typeof msg.from?.id === "number" ? msg.from.id : null,
          fromName,
          updateId: update.update_id,
        };
      }
    }
  }

  throw new Error(`timed out after ${timeoutSeconds}s`);
}

async function showLogs(args: string[]): Promise<void> {
  const opts = parseLogsArgs(args);
  if (opts.help) {
    console.log(`rho telegram logs

Show recent Telegram worker output.

Options:
  -n, --lines N   Number of lines to show (default: 50)
  -f, --follow    Poll for new output every 2 seconds
  -h, --help      Show this help`);
    return;
  }

  const logPath = path.join(TELEGRAM_DIR, "log.jsonl");
  if (!existsSync(logPath)) {
    console.error("Telegram log not found. Start the worker to generate logs.");
    process.exitCode = 1;
    return;
  }

  if (!opts.follow) {
    const lines = readLogLines(logPath);
    const tail = lines.slice(-opts.lines);
    process.stdout.write(tail.join("\n") + "\n");
    return;
  }

  const initial = readLogLines(logPath);
  const initialTail = initial.slice(-opts.lines);
  process.stdout.write(initialTail.join("\n") + "\n");
  let lastContent = initial.join("\n");

  while (true) {
    await sleep(2000);
    const current = readLogLines(logPath);
    const currentText = current.join("\n");
    if (currentText !== lastContent) {
      const oldLines = lastContent.split("\n");
      let newStart = 0;
      if (oldLines.length > 0) {
        const lastOldLine = oldLines[oldLines.length - 1];
        const lastOldIdx = current.lastIndexOf(lastOldLine);
        if (lastOldIdx >= 0) {
          newStart = lastOldIdx + 1;
        }
      }
      const diff = current.slice(newStart).filter((l) => l.trim() !== "");
      if (diff.length > 0) {
        process.stdout.write(diff.join("\n") + "\n");
      }
      lastContent = currentText;
    }
  }
}

async function startWorker(): Promise<void> {
  const settings = readTelegramSettings();
  if (!settings.enabled) {
    console.error("Telegram is disabled in init.toml. Enable [settings.telegram].");
    process.exitCode = 1;
    return;
  }
  if (settings.mode !== "polling") {
    console.error("Telegram worker only runs in polling mode.");
    process.exitCode = 1;
    return;
  }

  const status = getWorkerStatus();
  if (status.owner && !status.stale) {
    console.log(`Telegram worker already running (pid ${status.owner.pid}).`);
    return;
  }

  const cliDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const workerTs = path.join(cliDir, "telegramd.ts");
  const workerShim = path.join(cliDir, "telegramd.mjs");

  const insideNodeModules = cliDir.includes("node_modules");
  const nodeMajor = parseInt(process.version.slice(1), 10);
  const canStripTypes = nodeMajor >= 22 && !insideNodeModules;

  const childArgs = canStripTypes
    ? ["--experimental-strip-types", "--no-warnings", workerTs]
    : [workerShim];

  const child = spawn(process.execPath, childArgs, {
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      RHO_TELEGRAM_DISABLE: "0",
    },
  });
  child.unref();

  let started = false;
  for (let i = 0; i < 5; i++) {
    await sleep(500);
    const check = getWorkerStatus();
    if (check.owner && !check.stale) {
      started = true;
      break;
    }
  }

  if (!started) {
    console.error("Failed to start telegram worker (lock not acquired).");
    process.exitCode = 1;
    return;
  }

  const owner = getWorkerStatus().owner;
  const pid = owner?.pid ? `pid ${owner.pid}` : "unknown";
  console.log(`Telegram worker started (${pid}).`);
}

async function stopWorker(): Promise<void> {
  const status = getWorkerStatus();
  if (!status.owner) {
    console.log("Telegram worker is not running.");
    return;
  }

  if (status.stale || !pidAlive(status.owner.pid)) {
    try { unlinkSync(TELEGRAM_WORKER_LOCK_PATH); } catch {}
    console.log("Removed stale telegram worker lock.");
    return;
  }

  try {
    process.kill(status.owner.pid, "SIGTERM");
  } catch {
    console.error("Failed to stop telegram worker (signal failed).");
    process.exitCode = 1;
    return;
  }

  let stopped = false;
  for (let i = 0; i < 10; i++) {
    await sleep(300);
    const next = getWorkerStatus();
    if (!next.owner || next.stale || !pidAlive(status.owner.pid)) {
      stopped = true;
      break;
    }
  }

  if (!stopped) {
    console.error("Telegram worker did not stop in time.");
    process.exitCode = 1;
    return;
  }

  console.log("Telegram worker stopped.");
}

async function requestCheck(): Promise<void> {
  const requested = requestTelegramCheckTrigger(TELEGRAM_CHECK_TRIGGER_PATH, {
    requestedAt: Date.now(),
    requesterPid: process.pid,
    requesterRole: "follower",
    source: "cli",
  });

  if (!requested) {
    console.error("Failed to request telegram check.");
    process.exitCode = 1;
    return;
  }

  console.log("Telegram check requested.");
  console.log(buildStatusText());
}

async function onboard(args: string[]): Promise<void> {
  const opts = parseOnboardArgs(args);
  if (opts.help) {
    console.log(`rho telegram onboard

Onboard Telegram with an OpenClaw-style guided flow.

Usage:
  rho telegram onboard [--token TOKEN] [--chat-id ID] [--user-id ID] [--timeout SEC] [--no-allowlist]

Options:
  --token TOKEN       Bot token (otherwise reads env, then prompts in TTY)
  --chat-id ID        Skip detection and use this chat id
  --user-id ID        Optional explicit user id to allow
  --timeout SEC       Wait timeout for first message (default: 120)
  --no-allowlist      Do not update allowed_chat_ids/allowed_user_ids override
  -h, --help          Show this help`);
    return;
  }

  const settings = readTelegramSettings();
  if (!settings.enabled) {
    console.error("Telegram is disabled in init.toml. Enable [settings.telegram].");
    process.exitCode = 1;
    return;
  }
  if (settings.mode !== "polling") {
    console.error("Telegram onboarding currently supports polling mode only.");
    process.exitCode = 1;
    return;
  }

  console.log("\nTelegram Onboarding\n===================\n");

  const envToken = (process.env[settings.botTokenEnv] || "").trim();
  const promptedToken = opts.token?.trim() ? null : await promptForToken(settings.botTokenEnv);
  const token = (opts.token?.trim() || envToken || promptedToken || "").trim();

  if (!token) {
    console.error(`Missing token. Pass --token or set ${settings.botTokenEnv}.`);
    process.exitCode = 1;
    return;
  }

  console.log("Step 2: Validate token");
  const me = await telegramGetMe(token).catch((error) => {
    console.error(`  Token validation failed: ${(error as Error)?.message || String(error)}`);
    process.exitCode = 1;
    return null;
  });
  if (!me) return;
  const username = me.username || `bot-${me.id}`;
  console.log(`  Token valid for @${username}`);

  const client = new Api(token);
  const runtime = loadRuntimeState();

  let chatId = opts.chatId ?? null;
  let userId = opts.userId ?? null;

  if (chatId === null || userId === null) {
    console.log("\nStep 3: Detect chat/user from first message");
    console.log(`  Send any message to: https://t.me/${username}`);
    console.log(`  Waiting up to ${opts.timeoutSeconds}s...`);

    const detected = await waitForHandshakeUpdate(client, opts.timeoutSeconds, runtime.last_update_id)
      .catch((error) => {
        console.error(`  Detection failed: ${(error as Error)?.message || String(error)}`);
        process.exitCode = 1;
        return null;
      });
    if (!detected) return;

    chatId = chatId ?? detected.chatId;
    userId = userId ?? detected.userId;

    console.log(`  Got message from ${detected.fromName}`);
    console.log(`  chat_id=${chatId}${userId !== null ? ` user_id=${userId}` : ""}`);
  }

  if (chatId === null) {
    console.error("No chat_id available. Provide --chat-id.");
    process.exitCode = 1;
    return;
  }

  if (opts.allowlist) {
    console.log("\nStep 4: Lock down allowlist");
    const existing = loadOperatorConfig() ?? {
      allowedChatIds: settings.allowedChatIds,
      allowedUserIds: settings.allowedUserIds,
    };

    const nextChats = new Set(existing.allowedChatIds);
    nextChats.add(chatId);

    const nextUsers = new Set(existing.allowedUserIds);
    if (userId !== null) nextUsers.add(userId);

    saveOperatorConfig({
      allowedChatIds: [...nextChats],
      allowedUserIds: [...nextUsers],
    });

    console.log(`  Allowed chats: ${[...nextChats].join(",")}`);
    console.log(`  Allowed users: ${[...nextUsers].length === 0 ? "all" : [...nextUsers].join(",")}`);
  } else {
    console.log("\nStep 4: Skipped allowlist update (--no-allowlist)");
  }

  console.log("\nStep 5: Send verification message");
  const verifyText = "✅ rho Telegram onboarding complete. You are authorized.";
  await client.sendMessage(chatId, verifyText).catch((error) => {
    console.error(`  Failed to send verification message: ${(error as Error)?.message || String(error)}`);
    process.exitCode = 1;
  });

  if (process.exitCode && process.exitCode !== 0) return;

  console.log("  Verification sent.");
  console.log("\nOnboarding complete.");
  console.log("Next: rho telegram start");
}

function parseApprovalPin(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--pin") {
      return (args[++i] || "").trim();
    }
  }
  return "";
}

function showPendingApprovals(): void {
  const pending = listPendingApprovals();
  if (pending.length === 0) {
    console.log("No pending approvals.");
    return;
  }

  console.log("Pending approvals:");
  for (const req of pending) {
    const ageSec = Math.max(0, Math.floor((Date.now() - req.firstSeenAt) / 1000));
    const preview = req.textPreview ? ` text=\"${req.textPreview.replace(/\"/g, "'")}\"` : "";
    console.log(
      `  pin=${req.pin} chat=${req.chatId} user=${req.userId ?? "unknown"} age=${ageSec}s${preview}`,
    );
  }
}

async function approvePending(args: string[]): Promise<void> {
  const pin = parseApprovalPin(args);
  if (!/^\d{6}$/.test(pin)) {
    console.error("Usage: rho telegram approve --pin 123456");
    process.exitCode = 1;
    return;
  }

  const req = approvePendingByPin(pin);
  if (!req) {
    console.error("No matching pending request.");
    process.exitCode = 1;
    return;
  }

  const settings = readTelegramSettings();
  const operator = loadOperatorConfig() ?? {
    allowedChatIds: settings.allowedChatIds,
    allowedUserIds: settings.allowedUserIds,
  };

  const nextChats = new Set(operator.allowedChatIds);
  nextChats.add(req.chatId);

  const nextUsers = new Set(operator.allowedUserIds);
  if (req.userId !== null) nextUsers.add(req.userId);

  saveOperatorConfig({
    allowedChatIds: [...nextChats],
    allowedUserIds: [...nextUsers],
  });

  console.log(`Approved chat=${req.chatId} user=${req.userId ?? "unknown"} (pin=${req.pin}).`);
  console.log(buildStatusText());
}

async function rejectPending(args: string[]): Promise<void> {
  const pin = parseApprovalPin(args);
  if (!/^\d{6}$/.test(pin)) {
    console.error("Usage: rho telegram reject --pin 123456");
    process.exitCode = 1;
    return;
  }

  const req = rejectPendingByPin(pin);
  if (!req) {
    console.error("No matching pending request.");
    process.exitCode = 1;
    return;
  }

  console.log(`Rejected chat=${req.chatId} user=${req.userId ?? "unknown"} (pin=${req.pin}).`);
}

export async function run(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  const command = (sub || "status").toLowerCase();

  if (command === "--help" || command === "-h" || command === "help") {
    console.log(`rho telegram

Manage the Telegram worker.

Usage:
  rho telegram start
  rho telegram stop
  rho telegram status
  rho telegram logs [--lines N] [--follow]
  rho telegram check
  rho telegram onboard [--token TOKEN] [--chat-id ID] [--user-id ID] [--timeout SEC]
  rho telegram pending
  rho telegram approve --pin 123456
  rho telegram reject --pin 123456

Options:
  -h, --help   Show this help`);
    return;
  }

  if (command === "start") {
    await startWorker();
    return;
  }

  if (command === "stop") {
    await stopWorker();
    return;
  }

  if (command === "status") {
    console.log(buildStatusText());
    return;
  }

  if (command === "logs") {
    await showLogs(rest);
    return;
  }

  if (command === "check") {
    await requestCheck();
    return;
  }

  if (command === "onboard") {
    await onboard(rest);
    return;
  }

  if (command === "pending") {
    showPendingApprovals();
    return;
  }

  if (command === "approve") {
    await approvePending(rest);
    return;
  }

  if (command === "reject") {
    await rejectPending(rest);
    return;
  }

  console.error(`Unknown telegram subcommand: ${command}`);
  process.exitCode = 1;
}
