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
import { loadSessionMap } from "../extensions/telegram/session-map.ts";

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

  const rpcPrompts: string[] = [];
  const rpcRunner = {
    async runPrompt(_sessionFile: string, message: string) {
      rpcPrompts.push(message);
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
    rpcPromptTimeoutSeconds: 1,
    backgroundPromptTimeoutSeconds: 5,
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
  assert(rpcPrompts[0] === "hello worker", "pollOnce forwards non-slash prompt text unchanged");

  const snapshot = runtime.getSnapshot();
  assert(snapshot.runtimeState.last_update_id === 502, "runtime state advances update offset");
  assert(snapshot.pendingInbound === 0, "inbound queue drained");
  assert(snapshot.pendingOutbound === 0, "outbound queue drained");

  console.log("\n-- prompt timeout defers to background and posts completion --");
  const deferStatePath = join(tmp, "telegram", "state.defer.json");
  const deferMapPath = join(tmp, "telegram", "session-map.defer.json");
  const deferSessionDir = join(tmp, "sessions-defer");

  const deferUpdates = [
    {
      update_id: 801,
      message: {
        message_id: 95,
        from: { id: 2222 },
        chat: { id: 1111, type: "private" as const },
        date: 1,
        text: "run long horizon task",
      },
    },
  ];

  let deferGetUpdatesCalls = 0;
  const deferSent: Array<{ chat_id: number; text: string }> = [];
  const deferClient = {
    async getUpdates() {
      deferGetUpdatesCalls++;
      return deferGetUpdatesCalls === 1 ? deferUpdates : [];
    },
    async sendMessage(params: { chat_id: number; text: string }) {
      deferSent.push({ chat_id: params.chat_id, text: params.text });
      return { message_id: 1, chat: { id: params.chat_id, type: "private" as const }, date: 1 };
    },
    async sendChatAction() {
      return true;
    },
  };

  const deferCalls: Array<{ message: string; timeoutMs: number | undefined }> = [];
  const deferRpcRunner = {
    async runPrompt(_sessionFile: string, message: string, timeoutMs?: number) {
      deferCalls.push({ message, timeoutMs });
      if ((timeoutMs ?? 0) <= 1000) {
        throw new Error("RPC prompt timed out after 1s");
      }
      return "background result";
    },
    dispose() {
      // no-op
    },
  };

  const deferRuntime = createTelegramWorkerRuntime({
    settings,
    client: deferClient as any,
    rpcRunner: deferRpcRunner as any,
    statePath: deferStatePath,
    mapPath: deferMapPath,
    sessionDir: deferSessionDir,
    checkTriggerPath: join(tmp, "telegram", "check.trigger.defer.json"),
    operatorConfigPath: join(tmp, "telegram", "config.defer.json"),
    botUsername: "tau_rhobot",
    logPath: join(tmp, "telegram", "log.defer.jsonl"),
  });

  const deferResult = await deferRuntime.pollOnce(false);
  assert(deferResult.ok === true, "defer scenario poll succeeds");
  assert(deferResult.accepted === 1, "defer scenario accepts inbound update");

  await new Promise((resolve) => setTimeout(resolve, 25));

  assert(
    deferSent.some((item) => item.text.includes("continue in the background")),
    "defer scenario sends immediate background acknowledgement",
  );
  assert(
    deferSent.some((item) => item.text.includes("Background task finished") && item.text.includes("background result")),
    "defer scenario posts background completion",
  );
  assert(deferCalls.length === 2, "defer scenario runs foreground attempt then background attempt");
  assert((deferCalls[0]?.timeoutMs ?? 0) === 1000, "defer scenario foreground timeout uses rpc_prompt_timeout_seconds");
  assert((deferCalls[1]?.timeoutMs ?? 0) === 5000, "defer scenario background timeout uses background_prompt_timeout_seconds");
  assert(deferRuntime.getSnapshot().pendingBackground === 0, "defer scenario drains background queue after completion");
  deferRuntime.dispose();

  console.log("\n-- /new resets chat session without calling RPC --");
  const resetStatePath = join(tmp, "telegram", "state.reset.json");
  const resetMapPath = join(tmp, "telegram", "session-map.reset.json");
  const resetSessionDir = join(tmp, "sessions-reset");
  const resetLogPath = join(tmp, "telegram", "log.reset.jsonl");

  const resetUpdates = [
    {
      update_id: 601,
      message: {
        message_id: 88,
        from: { id: 2222 },
        chat: { id: 1111, type: "private" as const },
        date: 1,
        text: "/new",
      },
    },
  ];

  const resetSent: Array<{ chat_id: number; text: string }> = [];
  let resetRpcCalls = 0;
  const resetClient = {
    async getUpdates() {
      return resetUpdates;
    },
    async sendMessage(params: { chat_id: number; text: string }) {
      resetSent.push({ chat_id: params.chat_id, text: params.text });
      return { message_id: 1, chat: { id: params.chat_id, type: "private" as const }, date: 1 };
    },
    async sendChatAction() {
      return true;
    },
  };

  const resetRpcRunner = {
    async runPrompt() {
      resetRpcCalls++;
      return "should not run";
    },
    dispose() {
      // no-op
    },
  };

  const resetRuntime = createTelegramWorkerRuntime({
    settings,
    client: resetClient as any,
    rpcRunner: resetRpcRunner as any,
    statePath: resetStatePath,
    mapPath: resetMapPath,
    sessionDir: resetSessionDir,
    checkTriggerPath: join(tmp, "telegram", "check.trigger.reset.json"),
    operatorConfigPath: join(tmp, "telegram", "config.reset.json"),
    botUsername: "tau_rhobot",
    logPath: resetLogPath,
  });

  const resetResult = await resetRuntime.pollOnce(false);
  assert(resetResult.ok === true, "/new poll succeeds");
  assert(resetResult.accepted === 1, "/new update accepted");
  assert(resetRpcCalls === 0, "/new does not invoke rpc runner");
  assert(resetSent.length === 1, "/new sends acknowledgement message");
  assert(resetSent[0]?.text.includes("Started a new session"), "/new acknowledgement confirms new session");

  const resetMap = loadSessionMap(resetMapPath);
  assert(typeof resetMap["dm:1111"] === "string" && resetMap["dm:1111"].length > 0, "/new writes refreshed session mapping");
  resetRuntime.dispose();

  console.log("\n-- slash commands pass through without shortcut normalization --");
  const shortcutsStatePath = join(tmp, "telegram", "state.shortcuts.json");
  const shortcutsMapPath = join(tmp, "telegram", "session-map.shortcuts.json");
  const shortcutsSessionDir = join(tmp, "sessions-shortcuts");

  const shortcutUpdates = [
    {
      update_id: 701,
      message: {
        message_id: 91,
        from: { id: 2222 },
        chat: { id: 1111, type: "private" as const },
        date: 1,
        text: "/status",
      },
    },
    {
      update_id: 702,
      message: {
        message_id: 92,
        from: { id: 2222 },
        chat: { id: 1111, type: "private" as const },
        date: 1,
        text: "/check",
      },
    },
    {
      update_id: 703,
      message: {
        message_id: 93,
        from: { id: 2222 },
        chat: { id: 1111, type: "private" as const },
        date: 1,
        text: "/telegram",
      },
    },
    {
      update_id: 704,
      message: {
        message_id: 94,
        from: { id: 2222 },
        chat: { id: 1111, type: "private" as const },
        date: 1,
        text: "/telegram check",
      },
    },
  ];

  let shortcutGetUpdatesCalls = 0;
  const shortcutSent: Array<{ chat_id: number; text: string }> = [];
  const shortcutClient = {
    async getUpdates() {
      shortcutGetUpdatesCalls++;
      return shortcutGetUpdatesCalls === 1 ? shortcutUpdates : [];
    },
    async sendMessage(params: { chat_id: number; text: string }) {
      shortcutSent.push({ chat_id: params.chat_id, text: params.text });
      return { message_id: 1, chat: { id: params.chat_id, type: "private" as const }, date: 1 };
    },
    async sendChatAction() {
      return true;
    },
  };

  const shortcutPrompts: string[] = [];
  const shortcutRpcRunner = {
    async runPrompt(_sessionFile: string, message: string) {
      shortcutPrompts.push(message);
      return `ok:${message}`;
    },
    dispose() {
      // no-op
    },
  };

  const shortcutRuntime = createTelegramWorkerRuntime({
    settings,
    client: shortcutClient as any,
    rpcRunner: shortcutRpcRunner as any,
    statePath: shortcutsStatePath,
    mapPath: shortcutsMapPath,
    sessionDir: shortcutsSessionDir,
    checkTriggerPath: join(tmp, "telegram", "check.trigger.shortcuts.json"),
    operatorConfigPath: join(tmp, "telegram", "config.shortcuts.json"),
    botUsername: "tau_rhobot",
    logPath: join(tmp, "telegram", "log.shortcuts.jsonl"),
  });

  const shortcutResult = await shortcutRuntime.pollOnce(false);
  assert(shortcutResult.ok === true, "shortcut scenario poll succeeds");
  assert(shortcutResult.accepted === 4, "shortcut scenario accepts all shortcut updates");
  assert(
    JSON.stringify(shortcutPrompts) === JSON.stringify([
      "/status",
      "/check",
      "/telegram",
      "/telegram check",
    ]),
    "shortcut scenario forwards slash prompts exactly as received",
  );
  assert(shortcutSent.length === 4, "shortcut scenario sends one response per slash prompt");
  shortcutRuntime.dispose();

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
