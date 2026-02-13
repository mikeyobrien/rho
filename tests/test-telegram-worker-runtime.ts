/**
 * Tests for telegram worker runtime.
 * Run: npx tsx tests/test-telegram-worker-runtime.ts
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { TelegramApiError } from "../extensions/telegram/api.ts";
import { createTelegramWorkerRuntime } from "../extensions/telegram/worker-runtime.ts";
import { requestTelegramCheckTrigger } from "../extensions/telegram/check-trigger.ts";
import { loadRuntimeState, type TelegramSettings } from "../extensions/telegram/lib.ts";

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

console.log("\n=== Telegram worker runtime tests ===\n");

const tmp = mkdtempSync(join(tmpdir(), "rho-telegram-worker-runtime-"));
try {
  const statePath = join(tmp, "telegram", "state.json");
  const mapPath = join(tmp, "telegram", "session-map.json");
  const sessionDir = join(tmp, "sessions");
  const triggerPath = join(tmp, "telegram", "check.trigger.json");
  const logPath = join(tmp, "telegram", "log.jsonl");

  const updates = [
    {
      update_id: 501,
      message: {
        message_id: 77,
        from: { id: 2222 },
        chat: { id: 1111, type: "private" as const },
        date: 1,
        text: "hello worker",
      },
    },
  ];

  let getUpdatesCalls = 0;
  const sent: Array<{ chat_id: number; text: string }> = [];

  const client = {
    async getUpdates() {
      getUpdatesCalls++;
      return updates;
    },
    async sendMessage(params: { chat_id: number; text: string }) {
      sent.push({ chat_id: params.chat_id, text: params.text });
      return { message_id: 1, chat: { id: params.chat_id, type: "private" as const }, date: 1 };
    },
    async sendChatAction() {
      return true;
    },
  };

  const rpcRunner = {
    async runPrompt() {
      return "pong";
    },
    dispose() {
      // no-op
    },
  };

  const settings: TelegramSettings = {
    enabled: true,
    mode: "polling",
    botTokenEnv: "TELEGRAM_BOT_TOKEN",
    pollTimeoutSeconds: 1,
    allowedChatIds: [1111],
    allowedUserIds: [2222],
    requireMentionInGroups: false,
  };

  const runtime = createTelegramWorkerRuntime({
    settings,
    client: client as any,
    rpcRunner: rpcRunner as any,
    statePath,
    mapPath,
    sessionDir,
    checkTriggerPath: triggerPath,
    operatorConfigPath: join(tmp, "telegram", "config.json"),
    botUsername: "",
    logPath,
  });

  console.log("-- pollOnce processes update + reply --");
  const result = await runtime.pollOnce(false);
  assert(result.ok === true, "pollOnce reports ok");
  assert(result.accepted === 1, "pollOnce accepts authorized update");
  assert(sent.length === 1, "pollOnce sends outbound reply");

  const snapshot = runtime.getSnapshot();
  assert(snapshot.runtimeState.last_update_id === 502, "runtime state advances update offset");
  assert(snapshot.pendingInbound === 0, "inbound queue drained");
  assert(snapshot.pendingOutbound === 0, "outbound queue drained");

  console.log("\n-- check trigger consumes + runs poll --");
  requestTelegramCheckTrigger(triggerPath, {
    requestedAt: Date.now(),
    requesterPid: 9000,
    requesterRole: "follower",
    source: "test",
  });

  const check = await runtime.handleCheckTrigger();
  assert(check.triggered === true, "check trigger consumed");
  assert(getUpdatesCalls === 2, "check trigger runs pollOnce");

  const afterCheck = runtime.getSnapshot() as any;
  assert(typeof afterCheck.lastCheckConsumeAt === "number" && afterCheck.lastCheckConsumeAt > 0, "status snapshot records last check consume timestamp");
  assert(afterCheck.lastCheckOutcome === "ok", "status snapshot records last check outcome");
  assert(afterCheck.lastCheckRequesterPid === 9000, "status snapshot records requester pid for last check");

  const persistedAfterCheck = loadRuntimeState(statePath) as any;
  assert(typeof persistedAfterCheck.last_check_consume_at === "number" && persistedAfterCheck.last_check_consume_at > 0, "runtime state persists last check consume timestamp");
  assert(persistedAfterCheck.last_check_outcome === "ok", "runtime state persists last check outcome");
  assert(persistedAfterCheck.last_check_requester_pid === 9000, "runtime state persists last check requester pid");

  console.log("\n-- check trigger failure still updates status snapshot --");
  const failingTriggerPath = join(tmp, "telegram", "check.trigger.fail.json");
  let failingGetUpdatesCalls = 0;
  const failingClient = {
    async getUpdates() {
      failingGetUpdatesCalls++;
      throw new Error("simulated poll failure");
    },
    async sendMessage(_params: { chat_id: number; text: string }) {
      return { message_id: 1, chat: { id: 1, type: "private" as const }, date: 1 };
    },
    async sendChatAction() {
      return true;
    },
  };

  const failingRuntime = createTelegramWorkerRuntime({
    settings,
    client: failingClient as any,
    rpcRunner: rpcRunner as any,
    statePath: join(tmp, "telegram", "state.fail.json"),
    mapPath: join(tmp, "telegram", "session-map.fail.json"),
    sessionDir: join(tmp, "sessions-fail"),
    checkTriggerPath: failingTriggerPath,
    operatorConfigPath: join(tmp, "telegram", "config.fail.json"),
    botUsername: "",
    logPath: join(tmp, "telegram", "log.fail.jsonl"),
  });

  requestTelegramCheckTrigger(failingTriggerPath, {
    requestedAt: Date.now(),
    requesterPid: 9001,
    requesterRole: "follower",
    source: "test",
  });

  const failedCheck = await failingRuntime.handleCheckTrigger();
  assert(failedCheck.triggered === true, "failed check trigger still consumed");
  assert(failingGetUpdatesCalls === 1, "failed check trigger still executes pollOnce");

  const failedSnapshot = failingRuntime.getSnapshot() as any;
  assert(failedSnapshot.lastCheckOutcome === "error", "status snapshot records error check outcome");
  assert(failedSnapshot.lastCheckRequesterPid === 9001, "status snapshot records requester pid for failed check");

  const persistedFailed = loadRuntimeState(join(tmp, "telegram", "state.fail.json")) as any;
  assert(persistedFailed.last_check_outcome === "error", "runtime state persists error check outcome");
  assert(persistedFailed.last_check_requester_pid === 9001, "runtime state persists requester pid for failed check");

  console.log("\n-- durable outbound queue persists retry and resumes on restart --");
  const durableOutboundDir = join(tmp, "telegram-durable-outbound");
  const durableOutboundQueuePath = join(durableOutboundDir, "outbound.queue.json");
  const durableOutboundStatePath = join(durableOutboundDir, "state.json");
  const durableOutboundMapPath = join(durableOutboundDir, "session-map.json");
  const durableOutboundSessionDir = join(tmp, "sessions-durable-outbound");

  let retrySendAttempts = 0;
  const retryingClient = {
    async getUpdates() {
      return updates;
    },
    async sendMessage(_params: { chat_id: number; text: string }) {
      retrySendAttempts++;
      throw new TelegramApiError("rate limited", 429, 0);
    },
    async sendChatAction() {
      return true;
    },
  };

  const retryRuntime = createTelegramWorkerRuntime({
    settings,
    client: retryingClient as any,
    rpcRunner: rpcRunner as any,
    statePath: durableOutboundStatePath,
    mapPath: durableOutboundMapPath,
    sessionDir: durableOutboundSessionDir,
    checkTriggerPath: join(durableOutboundDir, "check.trigger.json"),
    operatorConfigPath: join(durableOutboundDir, "config.json"),
    botUsername: "",
    logPath: join(durableOutboundDir, "log.jsonl"),
  });

  const retryResult = await retryRuntime.pollOnce(false);
  assert(retryResult.ok === true, "retry scenario poll succeeds");
  assert(retrySendAttempts >= 1, "retry scenario attempts outbound send");
  assert(retryRuntime.getSnapshot().pendingOutbound === 1, "retry scenario leaves outbound item queued");
  assert(existsSync(durableOutboundQueuePath), "retry scenario persists outbound queue file");

  const persistedOutboundQueue = existsSync(durableOutboundQueuePath)
    ? JSON.parse(readFileSync(durableOutboundQueuePath, "utf-8")) as any[]
    : [];
  assert(Array.isArray(persistedOutboundQueue) && persistedOutboundQueue.length === 1, "retry scenario persists queued outbound item");

  retryRuntime.dispose();

  const resumedOutboundSent: Array<{ chat_id: number; text: string }> = [];
  const resumedOutboundClient = {
    async getUpdates() {
      return [];
    },
    async sendMessage(params: { chat_id: number; text: string }) {
      resumedOutboundSent.push({ chat_id: params.chat_id, text: params.text });
      return { message_id: 2, chat: { id: params.chat_id, type: "private" as const }, date: 1 };
    },
    async sendChatAction() {
      return true;
    },
  };

  const resumedOutboundRuntime = createTelegramWorkerRuntime({
    settings,
    client: resumedOutboundClient as any,
    rpcRunner: rpcRunner as any,
    statePath: durableOutboundStatePath,
    mapPath: durableOutboundMapPath,
    sessionDir: durableOutboundSessionDir,
    checkTriggerPath: join(durableOutboundDir, "check.trigger.json"),
    operatorConfigPath: join(durableOutboundDir, "config.json"),
    botUsername: "",
    logPath: join(durableOutboundDir, "log.jsonl"),
  });

  const resumedOutboundResult = await resumedOutboundRuntime.pollOnce(false);
  assert(resumedOutboundResult.ok === true, "resumed outbound scenario poll succeeds");
  assert(resumedOutboundSent.length === 1, "resumed outbound scenario flushes persisted queue item");

  const drainedOutboundQueue = existsSync(durableOutboundQueuePath)
    ? JSON.parse(readFileSync(durableOutboundQueuePath, "utf-8")) as any[]
    : null;
  assert(Array.isArray(drainedOutboundQueue) && drainedOutboundQueue.length === 0, "resumed outbound scenario drains persisted queue file");

  resumedOutboundRuntime.dispose();

  console.log("\n-- durable inbound queue resumes persisted work after restart --");
  const durableInboundDir = join(tmp, "telegram-durable-inbound");
  const durableInboundStatePath = join(durableInboundDir, "state.json");
  const durableInboundMapPath = join(durableInboundDir, "session-map.json");
  const durableInboundSessionDir = join(tmp, "sessions-durable-inbound");
  const durableInboundQueuePath = join(durableInboundDir, "inbound.queue.json");

  loadRuntimeState(durableInboundStatePath);
  writeFileSync(
    durableInboundQueuePath,
    JSON.stringify([
      {
        updateId: 999,
        chatId: 1111,
        chatType: "private",
        userId: 2222,
        messageId: 333,
        text: "resume inbound message",
        isReplyToBot: false,
        sessionKey: "chat-1111-user-2222",
        sessionFile: join(durableInboundSessionDir, "chat-1111-user-2222.jsonl"),
      },
    ], null, 2),
  );

  let resumedInboundPrompts = 0;
  const resumedInboundSent: Array<{ chat_id: number; text: string }> = [];
  const inboundClient = {
    async getUpdates() {
      return [];
    },
    async sendMessage(params: { chat_id: number; text: string }) {
      resumedInboundSent.push({ chat_id: params.chat_id, text: params.text });
      return { message_id: 3, chat: { id: params.chat_id, type: "private" as const }, date: 1 };
    },
    async sendChatAction() {
      return true;
    },
  };

  const inboundRpcRunner = {
    async runPrompt(_sessionFile: string, _message: string) {
      resumedInboundPrompts++;
      return "inbound resumed reply";
    },
    dispose() {
      // no-op
    },
  };

  const resumedInboundRuntime = createTelegramWorkerRuntime({
    settings,
    client: inboundClient as any,
    rpcRunner: inboundRpcRunner as any,
    statePath: durableInboundStatePath,
    mapPath: durableInboundMapPath,
    sessionDir: durableInboundSessionDir,
    checkTriggerPath: join(durableInboundDir, "check.trigger.json"),
    operatorConfigPath: join(durableInboundDir, "config.json"),
    botUsername: "",
    logPath: join(durableInboundDir, "log.jsonl"),
  });

  const resumedInboundResult = await resumedInboundRuntime.pollOnce(false);
  assert(resumedInboundResult.ok === true, "resumed inbound scenario poll succeeds");
  assert(resumedInboundPrompts === 1, "resumed inbound scenario executes persisted inbound item");
  assert(resumedInboundSent.length === 1, "resumed inbound scenario sends response from persisted inbound item");

  const drainedInboundQueue = existsSync(durableInboundQueuePath)
    ? JSON.parse(readFileSync(durableInboundQueuePath, "utf-8")) as any[]
    : null;
  assert(Array.isArray(drainedInboundQueue) && drainedInboundQueue.length === 0, "resumed inbound scenario drains persisted inbound queue file");

  resumedInboundRuntime.dispose();
  failingRuntime.dispose();
  runtime.dispose();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===`);
process.exit(FAIL > 0 ? 1 : 0);
