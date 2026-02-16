/**
 * Tests for telegram worker runtime.
 * Run: npx tsx tests/test-telegram-worker-runtime.ts
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { GrammyError, InputFile } from "../extensions/telegram/api.ts";
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
    async sendMessage(chat_id: number, text: string, other?: any) {
      sent.push({ chat_id, text });
      return { message_id: 1, chat: { id: chat_id, type: "private" as const }, date: 1 };
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
    threadedMode: false,
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

  console.log("\n-- empty prompt responses return actionable error text --");
  {
    const emptyStatePath = join(tmp, "telegram", "state.empty-response.json");
    const emptyMapPath = join(tmp, "telegram", "session-map.empty-response.json");
    const emptySessionDir = join(tmp, "sessions-empty-response");

    const emptyUpdates = [
      {
        update_id: 551,
        message: {
          message_id: 79,
          from: { id: 2222 },
          chat: { id: 1111, type: "private" as const },
          date: 1,
          text: "trigger empty",
        },
      },
    ];

    const emptySent: Array<{ chat_id: number; text: string }> = [];
    const emptyClient = {
      async getUpdates() {
        return emptyUpdates;
      },
      async sendMessage(chat_id: number, text: string, _other?: any) {
        emptySent.push({ chat_id, text });
        return { message_id: 1, chat: { id: chat_id, type: "private" as const }, date: 1 };
      },
      async sendChatAction() {
        return true;
      },
    };

    const emptyRpcRunner = {
      async runPrompt() {
        return "   ";
      },
      dispose() {
        // no-op
      },
    };

    const emptyRuntime = createTelegramWorkerRuntime({
      settings,
      client: emptyClient as any,
      rpcRunner: emptyRpcRunner as any,
      statePath: emptyStatePath,
      mapPath: emptyMapPath,
      sessionDir: emptySessionDir,
      checkTriggerPath: join(tmp, "telegram", "check.trigger.empty-response.json"),
      operatorConfigPath: join(tmp, "telegram", "config.empty-response.json"),
      botUsername: "",
      logPath: join(tmp, "telegram", "log.empty-response.jsonl"),
    });

    const emptyResult = await emptyRuntime.pollOnce(false);
    assert(emptyResult.ok === true, "empty-response scenario poll succeeds");
    assert(emptySent.length === 1, "empty-response scenario sends fallback text message");
    assert(!emptySent[0]?.text.includes("(No response)"), "empty-response scenario does not emit '(No response)'");
    assert(emptySent[0]?.text.toLowerCase().includes("empty response"), "empty-response scenario explains empty response failure");

    emptyRuntime.dispose();
  }

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
    async sendMessage(chat_id: number, text: string, other?: any) {
      deferSent.push({ chat_id, text });
      return { message_id: 1, chat: { id: chat_id, type: "private" as const }, date: 1 };
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
    async sendMessage(chat_id: number, text: string, other?: any) {
      resetSent.push({ chat_id, text });
      return { message_id: 1, chat: { id: chat_id, type: "private" as const }, date: 1 };
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
    async sendMessage(chat_id: number, text: string, other?: any) {
      shortcutSent.push({ chat_id, text });
      return { message_id: 1, chat: { id: chat_id, type: "private" as const }, date: 1 };
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
    async sendMessage(_chat_id: number, _text: string, _other?: any) {
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

  console.log("\n-- retryable send failure (429) keeps outbound item queued --");
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
    async sendMessage(_chat_id: number, _text: string, _other?: any) {
      retrySendAttempts++;
      throw new GrammyError("rate limited", { ok: false, error_code: 429, description: "rate limited", parameters: { retry_after: 0 } }, "sendMessage", {});
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
  assert(retryRuntime.getSnapshot().pendingOutbound === 1, "retryable failure keeps outbound item queued");
  assert(existsSync(durableOutboundQueuePath), "retry scenario persists outbound queue file");

  const persistedOutboundQueue = existsSync(durableOutboundQueuePath)
    ? JSON.parse(readFileSync(durableOutboundQueuePath, "utf-8")) as any[]
    : [];
  assert(Array.isArray(persistedOutboundQueue) && persistedOutboundQueue.length === 1, "retry scenario persists queued outbound item");
  assert(persistedOutboundQueue[0].attempts === 1, "retry scenario increments attempt counter");
  assert(persistedOutboundQueue[0].notBeforeMs > 0, "retry scenario sets backoff delay");

  retryRuntime.dispose();

  console.log("\n-- permanent send failure (400) removes outbound item from queue --");
  const permFailDir = join(tmp, "telegram-perm-fail");
  const permFailQueuePath = join(permFailDir, "outbound.queue.json");
  const permFailStatePath = join(permFailDir, "state.json");
  const permFailMapPath = join(permFailDir, "session-map.json");
  const permFailSessionDir = join(tmp, "sessions-perm-fail");

  const permFailClient = {
    async getUpdates() {
      return updates;
    },
    async sendMessage(_chat_id: number, _text: string, _other?: any) {
      throw new GrammyError("Bad Request", { ok: false, error_code: 400, description: "Bad Request: chat not found" }, "sendMessage", {});
    },
    async sendChatAction() {
      return true;
    },
  };
  const permFailRuntime = createTelegramWorkerRuntime({
    settings,
    client: permFailClient as any,
    rpcRunner: rpcRunner as any,
    statePath: permFailStatePath,
    mapPath: permFailMapPath,
    sessionDir: permFailSessionDir,
    checkTriggerPath: join(permFailDir, "check.trigger.json"),
    operatorConfigPath: join(permFailDir, "config.json"),
    botUsername: "",
    logPath: join(permFailDir, "log.jsonl"),
  });
  const permFailResult = await permFailRuntime.pollOnce(false);
  assert(permFailResult.ok === true, "permanent failure scenario poll succeeds");
  assert(permFailRuntime.getSnapshot().pendingOutbound === 0, "permanent failure removes outbound item from queue");

  permFailRuntime.dispose();

  console.log("\n-- durable outbound queue resumes persisted items on restart --");
  // Seed the queue file directly to test resume-on-restart
  mkdirSync(durableOutboundDir, { recursive: true });
  writeFileSync(durableOutboundQueuePath, JSON.stringify([
    { chatId: 100, replyToMessageId: 1, text: "persisted msg", attempts: 0, notBeforeMs: 0 },
  ]));
  const resumedOutboundSent: Array<{ chat_id: number; text: string }> = [];
  const resumedOutboundClient = {
    async getUpdates() {
      return [];
    },
    async sendMessage(chat_id: number, text: string, other?: any) {
      resumedOutboundSent.push({ chat_id, text });
      return { message_id: 2, chat: { id: chat_id, type: "private" as const }, date: 1 };
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
    async sendMessage(chat_id: number, text: string, other?: any) {
      resumedInboundSent.push({ chat_id, text });
      return { message_id: 3, chat: { id: chat_id, type: "private" as const }, date: 1 };
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

  console.log("\n-- inbound queue schema preserves voice/audio envelope fields --");
  const mediaInboundDir = join(tmp, "telegram-durable-inbound-media");
  const mediaInboundStatePath = join(mediaInboundDir, "state.json");
  const mediaInboundMapPath = join(mediaInboundDir, "session-map.json");
  const mediaInboundSessionDir = join(tmp, "sessions-durable-inbound-media");
  const mediaInboundQueuePath = join(mediaInboundDir, "inbound.queue.json");

  loadRuntimeState(mediaInboundStatePath);
  writeFileSync(
    mediaInboundQueuePath,
    JSON.stringify([
      {
        updateId: 1001,
        chatId: 1111,
        chatType: "private",
        userId: 2222,
        messageId: 444,
        text: "",
        isReplyToBot: false,
        media: {
          kind: "voice",
          fileId: "voice-file-queue-1",
          mimeType: "audio/ogg",
          durationSeconds: 6,
          fileSize: 2048,
        },
        sessionKey: "chat-1111-user-2222",
        sessionFile: join(mediaInboundSessionDir, "chat-1111-user-2222.jsonl"),
      },
      {
        updateId: 1002,
        chatId: 1111,
        chatType: "private",
        userId: 2222,
        messageId: 445,
        text: "",
        isReplyToBot: false,
        media: {
          kind: "voice",
          mimeType: "audio/ogg",
        },
        sessionKey: "chat-1111-user-2222",
        sessionFile: join(mediaInboundSessionDir, "chat-1111-user-2222.jsonl"),
      },
    ], null, 2),
  );

  const mediaInboundPrompts: string[] = [];
  const mediaInboundSent: Array<{ chat_id: number; text: string }> = [];
  const mediaInboundClient = {
    async getUpdates() {
      return [];
    },
    async sendMessage(chat_id: number, text: string, other?: any) {
      mediaInboundSent.push({ chat_id, text });
      return { message_id: 4, chat: { id: chat_id, type: "private" as const }, date: 1 };
    },
    async sendChatAction() {
      return true;
    },
  };

  const mediaInboundRpcRunner = {
    async runPrompt(_sessionFile: string, message: string) {
      mediaInboundPrompts.push(message);
      return "media envelope resumed reply";
    },
    dispose() {
      // no-op
    },
  };

  const mediaInboundRuntime = createTelegramWorkerRuntime({
    settings,
    client: mediaInboundClient as any,
    rpcRunner: mediaInboundRpcRunner as any,
    statePath: mediaInboundStatePath,
    mapPath: mediaInboundMapPath,
    sessionDir: mediaInboundSessionDir,
    checkTriggerPath: join(mediaInboundDir, "check.trigger.json"),
    operatorConfigPath: join(mediaInboundDir, "config.json"),
    botUsername: "",
    logPath: join(mediaInboundDir, "log.jsonl"),
  });

  const mediaInboundResult = await mediaInboundRuntime.pollOnce(false);
  assert(mediaInboundResult.ok === true, "media inbound schema scenario poll succeeds");
  assert(mediaInboundPrompts.length === 0, "media inbound schema scenario bypasses rpc prompt runner for queued voice envelope item");
  assert(mediaInboundSent.length === 1, "media inbound schema scenario sends response for queued voice envelope item");
  assert(mediaInboundSent[0]?.text.includes("Voice transcription"), "media inbound schema scenario returns transcription-path response text");

  const drainedMediaInboundQueue = existsSync(mediaInboundQueuePath)
    ? JSON.parse(readFileSync(mediaInboundQueuePath, "utf-8")) as any[]
    : null;
  assert(Array.isArray(drainedMediaInboundQueue) && drainedMediaInboundQueue.length === 0, "media inbound schema scenario drains persisted queue file");

  mediaInboundRuntime.dispose();

  console.log("\n-- inbound voice media runs ElevenLabs STT and replies with transcript --");
  const sttStatePath = join(tmp, "telegram", "state.stt.json");
  const sttMapPath = join(tmp, "telegram", "session-map.stt.json");
  const sttSessionDir = join(tmp, "sessions-stt");

  const sttUpdates = [
    {
      update_id: 1201,
      message: {
        message_id: 211,
        from: { id: 2222 },
        chat: { id: 1111, type: "private" as const },
        date: 1,
        voice: {
          file_id: "voice-file-telegram-1",
          duration: 4,
          mime_type: "audio/ogg",
        },
      },
    },
  ];

  const sttSent: Array<{ chat_id: number; text: string }> = [];
  const sttActions: Array<{ chat_id: number; action: string }> = [];
  const sttGetFileCalls: string[] = [];
  const sttDownloadCalls: string[] = [];

  const sttClient = {
    async getUpdates() {
      return sttUpdates;
    },
    async sendMessage(chat_id: number, text: string, other?: any) {
      sttSent.push({ chat_id, text });
      return { message_id: 5, chat: { id: chat_id, type: "private" as const }, date: 1 };
    },
    async sendChatAction(chat_id: number, action: string) {
      sttActions.push({ chat_id, action });
      return true;
    },
    async getFile(file_id: string) {
      sttGetFileCalls.push(file_id);
      return {
        file_id,
        file_path: "voice/path-from-telegram.oga",
      };
    },
  };

  let sttRpcCalls = 0;
  const sttRpcPrompts: string[] = [];
  const sttRpcRunner = {
    async runPrompt(_sessionFile: string, message: string) {
      sttRpcCalls++;
      sttRpcPrompts.push(message);
      return "assistant response from transcript";
    },
    dispose() {
      // no-op
    },
  };

  const originalFetch = globalThis.fetch;
  const previousApiKey = process.env.ELEVENLABS_API_KEY;
  const sttFetchCalls: Array<{ url: string; headers: Record<string, string>; body: FormData | null }> = [];
  try {
    process.env.ELEVENLABS_API_KEY = "test-elevenlabs-key";

    globalThis.fetch = (async (url: string, init?: any) => {
      const urlStr = String(url);
      if (urlStr.includes("/file/bot")) {
        sttDownloadCalls.push(urlStr);
        return {
          ok: true,
          status: 200,
          async arrayBuffer() {
            return new Uint8Array([9, 8, 7]).buffer;
          },
        } as any;
      }
      const headers = (init?.headers ?? {}) as Record<string, string>;
      sttFetchCalls.push({
        url: urlStr,
        headers,
        body: init?.body instanceof FormData ? init.body : null,
      });
      return {
        ok: true,
        status: 200,
        async json() {
          return { text: "voice transcript from ElevenLabs" };
        },
      } as any;
    }) as any;

    const sttRuntime = createTelegramWorkerRuntime({
      settings,
      client: sttClient as any,
      rpcRunner: sttRpcRunner as any,
      statePath: sttStatePath,
      mapPath: sttMapPath,
      sessionDir: sttSessionDir,
      checkTriggerPath: join(tmp, "telegram", "check.trigger.stt.json"),
      operatorConfigPath: join(tmp, "telegram", "config.stt.json"),
      botUsername: "",
      logPath: join(tmp, "telegram", "log.stt.jsonl"),
    });

    const sttResult = await sttRuntime.pollOnce(false);
    assert(sttResult.ok === true, "stt scenario poll succeeds");
    assert(sttResult.accepted === 1, "stt scenario accepts inbound voice update");
    assert(sttRpcCalls === 1, "stt scenario treats transcript as prompt and runs rpc once");
    assert(sttRpcPrompts[0] === "voice transcript from ElevenLabs", "stt scenario forwards transcript text to rpc prompt runner");
    assert(sttGetFileCalls.length === 1 && sttGetFileCalls[0] === "voice-file-telegram-1", "stt scenario resolves telegram file metadata from media file id");
    assert(sttDownloadCalls.length === 1 && sttDownloadCalls[0]?.includes("voice/path-from-telegram.oga"), "stt scenario downloads telegram media file for transcription");
    assert(sttFetchCalls.length === 1 && sttFetchCalls[0]?.url === "https://api.elevenlabs.io/v1/speech-to-text", "stt scenario posts media bytes to ElevenLabs STT endpoint");
    assert(sttFetchCalls[0]?.headers?.["xi-api-key"] === "test-elevenlabs-key", "stt scenario uses ELEVENLABS_API_KEY header for STT request");

    const sttBody = sttFetchCalls[0]?.body;
    assert(sttBody instanceof FormData && sttBody.get("model_id") === "scribe_v1", "stt scenario sends model_id in multipart request");
    assert(sttBody instanceof FormData && sttBody.get("file") instanceof Blob, "stt scenario sends binary media file in multipart request");

    assert(sttSent.length === 1, "stt scenario sends assistant reply for transcribed prompt");
    assert(sttSent[0]?.text.includes("assistant response from transcript"), "stt scenario reply contains assistant response");
    assert(sttActions.length >= 1, "stt scenario emits chat action while processing media");

    sttRuntime.dispose();
  } finally {
    if (previousApiKey === undefined) {
      delete process.env.ELEVENLABS_API_KEY;
    } else {
      process.env.ELEVENLABS_API_KEY = previousApiKey;
    }
    globalThis.fetch = originalFetch;
  }

  console.log("\n-- inbound voice media fails gracefully when ELEVENLABS_API_KEY is missing --");
  const sttMissingKeyStatePath = join(tmp, "telegram", "state.stt.missing-key.json");
  const sttMissingKeyMapPath = join(tmp, "telegram", "session-map.stt.missing-key.json");
  const sttMissingKeySessionDir = join(tmp, "sessions-stt-missing-key");

  const sttMissingKeySent: Array<{ chat_id: number; text: string }> = [];
  let sttMissingKeyRpcCalls = 0;
  const sttMissingKeyClient = {
    async getUpdates() {
      return sttUpdates;
    },
    async sendMessage(chat_id: number, text: string, other?: any) {
      sttMissingKeySent.push({ chat_id, text });
      return { message_id: 6, chat: { id: chat_id, type: "private" as const }, date: 1 };
    },
    async sendChatAction() {
      return true;
    },
    async getFile(_file_id: string) {
      return {
        file_id: "voice-file-telegram-1",
        file_path: "voice/path-from-telegram.oga",
      };
    },
  };

  const sttMissingKeyRpcRunner = {
    async runPrompt() {
      sttMissingKeyRpcCalls++;
      return "should-not-run-for-voice";
    },
    dispose() {
      // no-op
    },
  };

  const previousMissingKeyApiKey = process.env.ELEVENLABS_API_KEY;
  const missingKeyOriginalFetch = globalThis.fetch;
  let missingKeyFetchCalls = 0;
  try {
    delete process.env.ELEVENLABS_API_KEY;
    globalThis.fetch = (async () => {
      missingKeyFetchCalls++;
      return {
        ok: true,
        status: 200,
        async json() {
          return { text: "unexpected" };
        },
      } as any;
    }) as any;

    const sttMissingKeyRuntime = createTelegramWorkerRuntime({
      settings,
      client: sttMissingKeyClient as any,
      rpcRunner: sttMissingKeyRpcRunner as any,
      statePath: sttMissingKeyStatePath,
      mapPath: sttMissingKeyMapPath,
      sessionDir: sttMissingKeySessionDir,
      checkTriggerPath: join(tmp, "telegram", "check.trigger.stt.missing-key.json"),
      operatorConfigPath: join(tmp, "telegram", "config.stt.missing-key.json"),
      botUsername: "",
      logPath: join(tmp, "telegram", "log.stt.missing-key.jsonl"),
    });

    const sttMissingKeyResult = await sttMissingKeyRuntime.pollOnce(false);
    assert(sttMissingKeyResult.ok === true, "stt missing-key scenario poll succeeds");
    assert(sttMissingKeyRpcCalls === 0, "stt missing-key scenario bypasses rpc prompt runner");
    assert(missingKeyFetchCalls === 0, "stt missing-key scenario does not call ElevenLabs API without key");
    assert(sttMissingKeySent.length === 1, "stt missing-key scenario sends user-facing failure reply");
    assert(sttMissingKeySent[0]?.text.includes("ELEVENLABS_API_KEY"), "stt missing-key scenario reply tells operator how to fix config");

    sttMissingKeyRuntime.dispose();
  } finally {
    if (previousMissingKeyApiKey === undefined) {
      delete process.env.ELEVENLABS_API_KEY;
    } else {
      process.env.ELEVENLABS_API_KEY = previousMissingKeyApiKey;
    }
    globalThis.fetch = missingKeyOriginalFetch;
  }

  console.log("\n-- /tts command generates ElevenLabs audio and sends Telegram voice reply --");
  const ttsStatePath = join(tmp, "telegram", "state.tts.json");
  const ttsMapPath = join(tmp, "telegram", "session-map.tts.json");
  const ttsSessionDir = join(tmp, "sessions-tts");

  const ttsUpdates = [
    {
      update_id: 1301,
      message: {
        message_id: 311,
        from: { id: 2222 },
        chat: { id: 1111, type: "private" as const },
        date: 1,
        text: "/tts hello from telegram",
      },
    },
  ];

  const ttsSentMessages: Array<{ chat_id: number; text: string }> = [];
  const ttsSentVoice: Array<{ chat_id: number; reply_message_id?: number; voice: unknown }> = [];
  const ttsActions: Array<{ chat_id: number; action: string }> = [];
  const ttsClient = {
    async getUpdates() {
      return ttsUpdates;
    },
    async sendMessage(chat_id: number, text: string, other?: any) {
      ttsSentMessages.push({ chat_id, text });
      return { message_id: 7, chat: { id: chat_id, type: "private" as const }, date: 1 };
    },
    async sendVoice(chat_id: number, voice: unknown, other?: any) {
      ttsSentVoice.push({ chat_id, voice, reply_message_id: (other?.reply_parameters as any)?.message_id });
      return { message_id: 8, chat: { id: chat_id, type: "private" as const }, date: 1 };
    },
    async sendChatAction(chat_id: number, action: string) {
      ttsActions.push({ chat_id, action });
      return true;
    },
  };

  let ttsRpcCalls = 0;
  const ttsRpcRunner = {
    async runPrompt() {
      ttsRpcCalls++;
      return "should-not-run-for-tts";
    },
    dispose() {
      // no-op
    },
  };

  const ttsOriginalFetch = globalThis.fetch;
  const previousTtsApiKey = process.env.ELEVENLABS_API_KEY;
  const ttsFetchCalls: Array<{ url: string; init: any }> = [];
  try {
    process.env.ELEVENLABS_API_KEY = "test-elevenlabs-key";

    globalThis.fetch = (async (url: string, init?: any) => {
      ttsFetchCalls.push({ url: String(url), init });
      return {
        ok: true,
        status: 200,
        async arrayBuffer() {
          return new Uint8Array([1, 9, 9, 6]).buffer;
        },
      } as any;
    }) as any;

    const ttsRuntime = createTelegramWorkerRuntime({
      settings,
      client: ttsClient as any,
      rpcRunner: ttsRpcRunner as any,
      statePath: ttsStatePath,
      mapPath: ttsMapPath,
      sessionDir: ttsSessionDir,
      checkTriggerPath: join(tmp, "telegram", "check.trigger.tts.json"),
      operatorConfigPath: join(tmp, "telegram", "config.tts.json"),
      botUsername: "",
      logPath: join(tmp, "telegram", "log.tts.jsonl"),
    });

    const ttsResult = await ttsRuntime.pollOnce(false);
    assert(ttsResult.ok === true, "tts scenario poll succeeds");
    assert(ttsResult.accepted === 1, "tts scenario accepts /tts update");
    assert(ttsRpcCalls === 0, "tts scenario bypasses rpc prompt runner");
    assert(ttsFetchCalls.length === 1, "tts scenario calls ElevenLabs TTS endpoint");
    assert(ttsFetchCalls[0]?.url.includes("/v1/text-to-speech/"), "tts scenario targets ElevenLabs text-to-speech API path");
    assert(ttsFetchCalls[0]?.init?.headers?.["xi-api-key"] === "test-elevenlabs-key", "tts scenario uses ELEVENLABS_API_KEY header for TTS request");

    const ttsRequestBody = JSON.parse(String(ttsFetchCalls[0]?.init?.body || "{}")) as any;
    assert(ttsRequestBody.text === "hello from telegram", "tts scenario sends stripped /tts text payload");

    assert(ttsSentVoice.length === 1, "tts scenario sends Telegram voice reply");
    assert(ttsSentVoice[0]?.reply_message_id === 311, "tts scenario replies in-thread to source message");
    assert(ttsSentVoice[0]?.voice instanceof InputFile, "tts scenario sends InputFile audio payload to Telegram sendVoice");
    assert(ttsSentMessages.length === 0, "tts scenario does not send fallback text when media send succeeds");
    assert(ttsActions.some((action) => action.action === "record_voice"), "tts scenario emits record_voice chat action while synthesizing audio");
    assert(ttsActions.some((action) => action.action === "upload_voice"), "tts scenario emits upload_voice chat action while sending Telegram voice");

    ttsRuntime.dispose();
  } finally {
    if (previousTtsApiKey === undefined) {
      delete process.env.ELEVENLABS_API_KEY;
    } else {
      process.env.ELEVENLABS_API_KEY = previousTtsApiKey;
    }
    globalThis.fetch = ttsOriginalFetch;
  }

  console.log("\n-- /tts command fails gracefully when ELEVENLABS_API_KEY is missing --");
  const ttsMissingKeyStatePath = join(tmp, "telegram", "state.tts.missing-key.json");
  const ttsMissingKeyMapPath = join(tmp, "telegram", "session-map.tts.missing-key.json");
  const ttsMissingKeySessionDir = join(tmp, "sessions-tts-missing-key");

  const ttsMissingKeyUpdates = [
    {
      update_id: 1302,
      message: {
        message_id: 312,
        from: { id: 2222 },
        chat: { id: 1111, type: "private" as const },
        date: 1,
        text: "/tts missing key case",
      },
    },
  ];

  const ttsMissingKeySentMessages: Array<{ chat_id: number; text: string }> = [];
  let ttsMissingKeyVoiceSends = 0;
  const ttsMissingKeyClient = {
    async getUpdates() {
      return ttsMissingKeyUpdates;
    },
    async sendMessage(chat_id: number, text: string, other?: any) {
      ttsMissingKeySentMessages.push({ chat_id, text });
      return { message_id: 9, chat: { id: chat_id, type: "private" as const }, date: 1 };
    },
    async sendVoice(_chat_id: number, _voice: unknown, _other?: any) {
      ttsMissingKeyVoiceSends++;
      return { message_id: 10, chat: { id: 1111, type: "private" as const }, date: 1 } as any;
    },
    async sendChatAction() {
      return true;
    },
  };

  let ttsMissingKeyRpcCalls = 0;
  const ttsMissingKeyRpcRunner = {
    async runPrompt() {
      ttsMissingKeyRpcCalls++;
      return "should-not-run-for-tts";
    },
    dispose() {
      // no-op
    },
  };

  const ttsMissingKeyOriginalFetch = globalThis.fetch;
  const previousTtsMissingApiKey = process.env.ELEVENLABS_API_KEY;
  let ttsMissingKeyFetchCalls = 0;
  try {
    delete process.env.ELEVENLABS_API_KEY;
    globalThis.fetch = (async () => {
      ttsMissingKeyFetchCalls++;
      return {
        ok: true,
        status: 200,
        async arrayBuffer() {
          return new Uint8Array([7, 7, 7]).buffer;
        },
      } as any;
    }) as any;

    const ttsMissingKeyRuntime = createTelegramWorkerRuntime({
      settings,
      client: ttsMissingKeyClient as any,
      rpcRunner: ttsMissingKeyRpcRunner as any,
      statePath: ttsMissingKeyStatePath,
      mapPath: ttsMissingKeyMapPath,
      sessionDir: ttsMissingKeySessionDir,
      checkTriggerPath: join(tmp, "telegram", "check.trigger.tts.missing-key.json"),
      operatorConfigPath: join(tmp, "telegram", "config.tts.missing-key.json"),
      botUsername: "",
      logPath: join(tmp, "telegram", "log.tts.missing-key.jsonl"),
    });

    const ttsMissingKeyResult = await ttsMissingKeyRuntime.pollOnce(false);
    assert(ttsMissingKeyResult.ok === true, "tts missing-key scenario poll succeeds");
    assert(ttsMissingKeyRpcCalls === 0, "tts missing-key scenario bypasses rpc prompt runner");
    assert(ttsMissingKeyFetchCalls === 0, "tts missing-key scenario does not call ElevenLabs API without key");
    assert(ttsMissingKeyVoiceSends === 0, "tts missing-key scenario does not attempt Telegram media send");
    assert(ttsMissingKeySentMessages.length === 1, "tts missing-key scenario sends user-facing failure message");
    assert(ttsMissingKeySentMessages[0]?.text.includes("ELEVENLABS_API_KEY"), "tts missing-key scenario reply explains missing API key fix");

    ttsMissingKeyRuntime.dispose();
  } finally {
    if (previousTtsMissingApiKey === undefined) {
      delete process.env.ELEVENLABS_API_KEY;
    } else {
      process.env.ELEVENLABS_API_KEY = previousTtsMissingApiKey;
    }
    globalThis.fetch = ttsMissingKeyOriginalFetch;
  }

  console.log("\n-- /tts media send failures fall back to text reply --");
  const ttsSendFailureStatePath = join(tmp, "telegram", "state.tts.send-failure.json");
  const ttsSendFailureMapPath = join(tmp, "telegram", "session-map.tts.send-failure.json");
  const ttsSendFailureSessionDir = join(tmp, "sessions-tts-send-failure");

  const ttsSendFailureUpdates = [
    {
      update_id: 1303,
      message: {
        message_id: 313,
        from: { id: 2222 },
        chat: { id: 1111, type: "private" as const },
        date: 1,
        text: "/tts media send failure",
      },
    },
  ];

  const ttsSendFailureMessages: Array<{ chat_id: number; text: string }> = [];
  let ttsSendFailureVoiceCalls = 0;
  const ttsSendFailureClient = {
    async getUpdates() {
      return ttsSendFailureUpdates;
    },
    async sendMessage(chat_id: number, text: string, other?: any) {
      ttsSendFailureMessages.push({ chat_id, text });
      return { message_id: 11, chat: { id: chat_id, type: "private" as const }, date: 1 };
    },
    async sendVoice(_chat_id: number, _voice: unknown, _other?: any) {
      ttsSendFailureVoiceCalls++;
      throw new GrammyError("Bad Request", { ok: false, error_code: 400, description: "Bad Request: voice upload rejected" }, "sendVoice", {});
    },
    async sendChatAction() {
      return true;
    },
  };

  const ttsSendFailureRpcRunner = {
    async runPrompt() {
      return "should-not-run-for-tts";
    },
    dispose() {
      // no-op
    },
  };

  const ttsSendFailureOriginalFetch = globalThis.fetch;
  const previousTtsSendFailureApiKey = process.env.ELEVENLABS_API_KEY;
  try {
    process.env.ELEVENLABS_API_KEY = "test-elevenlabs-key";
    globalThis.fetch = (async () => {
      return {
        ok: true,
        status: 200,
        async arrayBuffer() {
          return new Uint8Array([1, 2, 3, 4]).buffer;
        },
      } as any;
    }) as any;

    const ttsSendFailureRuntime = createTelegramWorkerRuntime({
      settings,
      client: ttsSendFailureClient as any,
      rpcRunner: ttsSendFailureRpcRunner as any,
      statePath: ttsSendFailureStatePath,
      mapPath: ttsSendFailureMapPath,
      sessionDir: ttsSendFailureSessionDir,
      checkTriggerPath: join(tmp, "telegram", "check.trigger.tts.send-failure.json"),
      operatorConfigPath: join(tmp, "telegram", "config.tts.send-failure.json"),
      botUsername: "",
      logPath: join(tmp, "telegram", "log.tts.send-failure.jsonl"),
    });

    const ttsSendFailureResult = await ttsSendFailureRuntime.pollOnce(false);
    assert(ttsSendFailureResult.ok === true, "tts send-failure scenario poll succeeds");
    assert(ttsSendFailureVoiceCalls === 1, "tts send-failure scenario attempts Telegram voice send");
    assert(ttsSendFailureMessages.length === 1, "tts send-failure scenario emits text fallback reply");
    assert(ttsSendFailureMessages[0]?.text.toLowerCase().includes("voice"), "tts send-failure scenario fallback message mentions voice send failure");

    ttsSendFailureRuntime.dispose();
  } finally {
    if (previousTtsSendFailureApiKey === undefined) {
      delete process.env.ELEVENLABS_API_KEY;
    } else {
      process.env.ELEVENLABS_API_KEY = previousTtsSendFailureApiKey;
    }
    globalThis.fetch = ttsSendFailureOriginalFetch;
  }

  console.log("\n-- threaded mode routes message_thread_id through full cycle --");
  {
    const threadedDir = join(tmp, "telegram-threaded");
    const threadedStatePath = join(threadedDir, "state.json");
    const threadedMapPath = join(threadedDir, "session-map.json");
    const threadedSessionDir = join(tmp, "sessions-threaded");

    const threadedUpdates = [
      {
        update_id: 901,
        message: {
          message_id: 55,
          from: { id: 2222 },
          chat: { id: 1111, type: "private" as const },
          date: 1,
          text: "hello from thread",
          message_thread_id: 7,
        },
      },
    ];

    const threadedSent: Array<{ chat_id: number; text: string; other?: any }> = [];
    const threadedActions: Array<{ chat_id: number; action: string; other?: any }> = [];
    const threadedClient = {
      async getUpdates() {
        return threadedUpdates;
      },
      async sendMessage(chat_id: number, text: string, other?: any) {
        threadedSent.push({ chat_id, text, other });
        return { message_id: 1, chat: { id: chat_id, type: "private" as const }, date: 1 };
      },
      async sendChatAction(chat_id: number, action: string, other?: any) {
        threadedActions.push({ chat_id, action, other });
        return true;
      },
    };

    const threadedRpcPrompts: string[] = [];
    const threadedRpcRunner = {
      async runPrompt(_sessionFile: string, message: string) {
        threadedRpcPrompts.push(message);
        return "threaded pong";
      },
      dispose() {},
    };

    const threadedSettings: TelegramSettings = {
      enabled: true,
      mode: "polling",
      botTokenEnv: "TELEGRAM_BOT_TOKEN",
      pollTimeoutSeconds: 1,
      rpcPromptTimeoutSeconds: 1,
      backgroundPromptTimeoutSeconds: 5,
      allowedChatIds: [1111],
      allowedUserIds: [2222],
      requireMentionInGroups: false,
      threadedMode: true,
    };

    const threadedRuntime = createTelegramWorkerRuntime({
      settings: threadedSettings,
      client: threadedClient as any,
      rpcRunner: threadedRpcRunner as any,
      statePath: threadedStatePath,
      mapPath: threadedMapPath,
      sessionDir: threadedSessionDir,
      checkTriggerPath: join(threadedDir, "check.trigger.json"),
      operatorConfigPath: join(threadedDir, "config.json"),
      botUsername: "",
      logPath: join(threadedDir, "log.jsonl"),
    });

    const threadedResult = await threadedRuntime.pollOnce(false);
    assert(threadedResult.ok === true, "threaded poll succeeds");
    assert(threadedResult.accepted === 1, "threaded poll accepts update");
    assert(threadedSent.length === 1, "threaded poll sends reply");
    assert(threadedSent[0]?.other?.message_thread_id === 7, "outbound sendMessage carries message_thread_id");
    assert(threadedActions.some((a) => a.other?.message_thread_id === 7), "sendChatAction carries message_thread_id");

    // Verify session key uses threaded format
    const threadedMap = loadSessionMap(threadedMapPath);
    const threadedKeys = Object.keys(threadedMap);
    assert(threadedKeys.some((k) => k.includes("topic:7")), "session map key includes topic:7");

    threadedRuntime.dispose();
  }

  failingRuntime.dispose();
  runtime.dispose();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===`);
process.exit(FAIL > 0 ? 1 : 0);
