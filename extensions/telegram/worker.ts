import { Api } from "./api.ts";
import { readTelegramSettings, TELEGRAM_WORKER_LOCK_PATH } from "./lib.ts";
import {
  createTelegramWorkerLockState,
  releaseTelegramWorkerLock,
  stepTelegramWorkerLock,
} from "./worker-lock.ts";
import { createTelegramWorkerRuntime } from "./worker-runtime.ts";

const DEFAULT_WORKER_LOCK_REFRESH_MS = 15_000;
const DEFAULT_WORKER_LOCK_STALE_MS = 90_000;

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

export interface TelegramWorkerOptions {
  lockPath?: string;
  refreshMs?: number;
  staleMs?: number;
  log?: (message: string) => void;
}

export function runTelegramWorker(options: TelegramWorkerOptions = {}): void {
  const log = options.log ?? console.log;
  const settings = readTelegramSettings();

  if (process.env.RHO_TELEGRAM_DISABLE === "1") {
    log("Telegram worker disabled via RHO_TELEGRAM_DISABLE. Exiting.");
    return;
  }

  if (!settings.enabled || settings.mode !== "polling") {
    log("Telegram worker disabled (init.toml). Exiting.");
    return;
  }

  const token = (process.env[settings.botTokenEnv] || "").trim();
  if (!token) {
    log(`Telegram worker missing token env: ${settings.botTokenEnv}`);
    process.exitCode = 1;
    return;
  }

  const botUsername = (process.env.TELEGRAM_BOT_USERNAME || "").replace(/^@/, "").trim();
  const client = new Api(token);

  const lockPath = options.lockPath ?? TELEGRAM_WORKER_LOCK_PATH;
  const refreshMs = options.refreshMs
    ?? parsePositiveIntEnv("RHO_TELEGRAM_WORKER_LOCK_REFRESH_MS", DEFAULT_WORKER_LOCK_REFRESH_MS);
  const staleMs = options.staleMs ?? parsePositiveIntEnv("RHO_TELEGRAM_WORKER_LOCK_STALE_MS", DEFAULT_WORKER_LOCK_STALE_MS);

  const lockState = createTelegramWorkerLockState();
  const nonce = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

  const step = () => stepTelegramWorkerLock(lockState, { lockPath, nonce, now: Date.now(), staleMs });
  const initial = step();

  if (!initial.isOwner) {
    const owner = initial.ownerPid ? `pid ${initial.ownerPid}` : "unknown owner";
    log(`Telegram worker already running (${owner}).`);
    process.exitCode = 1;
    return;
  }

  log(`Telegram worker lock acquired (pid ${process.pid}).`);

  const runtime = createTelegramWorkerRuntime({
    settings,
    client,
    botToken: token,
    botUsername,
  });

  let pollTimer: NodeJS.Timeout | null = null;
  let stopping = false;

  const stopPolling = () => {
    stopping = true;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    runtime.dispose();
  };

  const runSequentialPollLoop = async () => {
    if (stopping) return;
    const result = await runtime.pollOnce(true);
    await runtime.handleCheckTrigger();
    if (stopping) return;
    const nextDelayMs = result.ok ? 0 : 1000;
    pollTimer = setTimeout(() => {
      pollTimer = null;
      void runSequentialPollLoop();
    }, nextDelayMs);
  };

  void runSequentialPollLoop();

  const refreshTimer = setInterval(() => {
    const result = step();
    if (!result.isOwner) {
      const owner = result.ownerPid ? `pid ${result.ownerPid}` : "unknown owner";
      log(`Telegram worker lock lost (${owner}). Exiting.`);
      clearInterval(refreshTimer);
      stopPolling();
      releaseTelegramWorkerLock(lockState);
      process.exit(1);
    }
  }, refreshMs);

  const cleanup = () => {
    clearInterval(refreshTimer);
    stopPolling();
    releaseTelegramWorkerLock(lockState);
  };

  process.once("exit", cleanup);
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);
}
