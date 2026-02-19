/**
 * Tests for telegram worker runtime.
 * Run: npx tsx tests/test-telegram-worker-runtime.ts
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { GrammyError, InputFile } from "../extensions/telegram/api.ts";
import { createTelegramWorkerRuntime } from "../extensions/telegram/worker-runtime.ts";
import { requestTelegramCheckTrigger } from "../extensions/telegram/check-trigger.ts";
import { DEFAULT_SETTINGS, loadRuntimeState, type TelegramSettings } from "../extensions/telegram/lib.ts";
import { loadSessionMap } from "../extensions/telegram/session-map.ts";
import { SttApiKeyMissingError, type SttProvider } from "../extensions/telegram/stt.ts";

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

function createGrammyApiError(description: string, errorCode: number, retryAfterSeconds?: number): GrammyError {
  return new GrammyError(
    description,
    {
      ok: false,
      error_code: errorCode,
      description,
      parameters: typeof retryAfterSeconds === "number" ? { retry_after: retryAfterSeconds } : {},
    } as any,
    "sendMessage",
    {},
  );
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
    async sendMessage(chat_id: number, text: string) {
      sent.push({ chat_id: chat_id, text: text });
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
    ...DEFAULT_SETTINGS,
    enabled: true,
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
  assert(rpcPrompts[0]?.startsWith("[msg:1111:77]") === true, "pollOnce prefixes RPC prompt with message metadata tag");
  assert(rpcPrompts[0]?.endsWith("\nhello worker") === true, "pollOnce appends original text after metadata prefix");
  assert(/\[msg:1111:77\] \[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]\nhello worker/.test(rpcPrompts[0] ?? ""), "pollOnce prompt has [msg:chatId:messageId] [YYYY-MM-DD HH:MM] format");

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
    async sendMessage(chat_id: number, text: string) {
      deferSent.push({ chat_id: chat_id, text: text });
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
      if ((timeoutMs ?? 0) === 1000) {
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
    deferSent.some((item) => item.text.includes("background job") && item.text.includes("Job ID:")),
    "defer scenario sends immediate job acknowledgement",
  );
  assert(
    deferSent.some((item) => item.text.includes("Job") && item.text.includes("finished") && item.text.includes("background result")),
    "defer scenario posts job completion",
  );
  assert(deferCalls.length === 2, "defer scenario runs foreground attempt then job attempt");
  assert((deferCalls[0]?.timeoutMs ?? 0) === 1000, "defer scenario foreground timeout uses rpc_prompt_timeout_seconds");
  assert((deferCalls[1]?.timeoutMs ?? -1) === 0, "defer scenario job execution is unbounded (timeout=0)");
  assert(deferRuntime.getSnapshot().pendingBackground === 0, "defer scenario drains active job queue after completion");
  deferRuntime.dispose();

  console.log("\n-- /cancel and /jobs commands manage job lifecycle --");
  const jobCmdStatePath = join(tmp, "telegram", "state.jobs-cmd.json");
  const jobCmdMapPath = join(tmp, "telegram", "session-map.jobs-cmd.json");
  const jobCmdSessionDir = join(tmp, "sessions-jobs-cmd");
  const jobCmdJobsPath = join(tmp, "telegram", "jobs.jobs-cmd.json");

  writeFileSync(jobCmdJobsPath, JSON.stringify([
    {
      id: "JTEST1",
      updateId: 901,
      chatId: 1111,
      userId: 2222,
      messageId: 101,
      sessionKey: "dm:1111",
      sessionFile: "/tmp/job-session.jsonl",
      promptText: "long running",
      createdAtMs: Date.now() - 5_000,
      startedAtMs: Date.now() - 4_000,
      finishedAtMs: null,
      status: "running",
      completionNotifiedAtMs: null,
      cancelRequestedAtMs: null,
    },
  ], null, 2));

  const jobCmdUpdates: Array<any | null> = [
    null,
    {
      update_id: 901,
      message: {
        message_id: 102,
        from: { id: 2222 },
        chat: { id: 1111, type: "private" as const },
        date: 1,
        text: "/cancel JTEST1",
      },
    },
    {
      update_id: 902,
      message: {
        message_id: 103,
        from: { id: 2222 },
        chat: { id: 1111, type: "private" as const },
        date: 1,
        text: "/jobs",
      },
    },
  ];

  let jobCmdUpdateCalls = 0;
  const jobCmdSent: Array<{ chat_id: number; text: string }> = [];
  let jobCmdCancelCalls = 0;

  const jobCmdClient = {
    async getUpdates() {
      const next = jobCmdUpdates[jobCmdUpdateCalls];
      jobCmdUpdateCalls += 1;
      return next ? [next] : [];
    },
    async sendMessage(chat_id: number, text: string) {
      jobCmdSent.push({ chat_id, text });
      return { message_id: 1, chat: { id: chat_id, type: "private" as const }, date: 1 };
    },
    async sendChatAction() {
      return true;
    },
  };

  const jobCmdRunner = {
    async runPrompt() {
      return await new Promise<string>(() => {
        // unresolved until cancelled
      });
    },
    cancelSession() {
      jobCmdCancelCalls += 1;
      return true;
    },
    dispose() {
      // no-op
    },
  };

  const jobCmdRuntime = createTelegramWorkerRuntime({
    settings,
    client: jobCmdClient as any,
    rpcRunner: jobCmdRunner as any,
    statePath: jobCmdStatePath,
    mapPath: jobCmdMapPath,
    sessionDir: jobCmdSessionDir,
    jobsPath: jobCmdJobsPath,
    checkTriggerPath: join(tmp, "telegram", "check.trigger.jobs-cmd.json"),
    operatorConfigPath: join(tmp, "telegram", "config.jobs-cmd.json"),
    botUsername: "tau_rhobot",
    logPath: join(tmp, "telegram", "log.jobs-cmd.jsonl"),
  });

  const warmupResult = await jobCmdRuntime.pollOnce(false);
  assert(warmupResult.ok === true, "job command warmup poll succeeds");

  const cancelResult = await jobCmdRuntime.pollOnce(false);
  assert(cancelResult.ok === true, "job command cancel poll succeeds");
  assert(jobCmdCancelCalls === 1, "/cancel triggers rpc session cancellation for running job");
  assert(jobCmdSent.some((item) => item.text.includes("Cancelled job JTEST1")), "/cancel replies with cancellation confirmation");

  const jobsResult = await jobCmdRuntime.pollOnce(false);
  assert(jobsResult.ok === true, "job command list poll succeeds");
  assert(jobCmdSent.some((item) => item.text.includes("JTEST1") && item.text.includes("cancelled")), "/jobs reports cancelled job state");
  jobCmdRuntime.dispose();

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
    async sendMessage(chat_id: number, text: string) {
      resetSent.push({ chat_id: chat_id, text: text });
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
    async sendMessage(chat_id: number, text: string) {
      shortcutSent.push({ chat_id: chat_id, text: text });
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
  assert(shortcutPrompts.length === 4, "shortcut scenario forwards all slash prompts to RPC");
  // Slash commands must NOT be prefixed - prefix would break RPC slash parsing (^/ anchored regexes)
  assert(shortcutPrompts[0] === "/status", "shortcut /status sent without prefix");
  assert(shortcutPrompts[1] === "/check", "shortcut /check sent without prefix");
  assert(shortcutPrompts[2] === "/telegram", "shortcut /telegram sent without prefix");
  assert(shortcutPrompts[3] === "/telegram check", "shortcut /telegram check sent without prefix");
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
    async sendMessage(_chat_id: number, _text: string) {
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
    async sendMessage(_chat_id: number, _text: string) {
      retrySendAttempts++;
      throw createGrammyApiError("rate limited", 429, 0);
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
    async sendMessage(chat_id: number, text: string) {
      resumedOutboundSent.push({ chat_id: chat_id, text: text });
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
    async sendMessage(chat_id: number, text: string) {
      resumedInboundSent.push({ chat_id: chat_id, text: text });
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
    async sendMessage(chat_id: number, text: string) {
      mediaInboundSent.push({ chat_id: chat_id, text: text });
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

  console.log("\n-- inbound voice media runs STT provider and replies with transcript --");
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
  const sttDownloadUrls: string[] = [];

  const sttClient = {
    async getUpdates() {
      return sttUpdates;
    },
    async sendMessage(chat_id: number, text: string) {
      sttSent.push({ chat_id: chat_id, text: text });
      return { message_id: 5, chat: { id: chat_id, type: "private" as const }, date: 1 };
    },
    async sendChatAction(chat_id: number, action: string) {
      sttActions.push({ chat_id: chat_id, action: action });
      return true;
    },
    async getFile(file_id: string) {
      sttGetFileCalls.push(file_id);
      return {
        file_id: file_id,
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

  const mockSttTranscribeCalls: Array<{ audio: Uint8Array; mimeType: string; fileName: string }> = [];
  const mockSttProvider: SttProvider = {
    async transcribe(audio: Uint8Array, mimeType: string, fileName: string) {
      mockSttTranscribeCalls.push({ audio, mimeType, fileName });
      return "voice transcript from provider";
    },
  };

  {
    const sttOriginalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (url: string) => {
        sttDownloadUrls.push(String(url));
        return {
          ok: true,
          status: 200,
          async arrayBuffer() {
            return new Uint8Array([9, 8, 7]).buffer;
          },
        } as any;
      }) as any;

      const sttRuntime = createTelegramWorkerRuntime({
        settings,
        client: sttClient as any,
        rpcRunner: sttRpcRunner as any,
        sttProvider: mockSttProvider,
        botToken: "stt-test-token",
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
      assert(sttRpcPrompts[0]?.startsWith("[msg:") && sttRpcPrompts[0]?.endsWith("\nvoice transcript from provider"), "stt scenario prefixes transcript prompt with message metadata");
      assert(sttGetFileCalls.length === 1 && sttGetFileCalls[0] === "voice-file-telegram-1", "stt scenario resolves telegram file metadata from media file id");
      assert(
        sttDownloadUrls.length === 1 && sttDownloadUrls[0]?.includes("/file/botstt-test-token/voice/path-from-telegram.oga"),
        "stt scenario downloads telegram media file for transcription",
      );
      assert(mockSttTranscribeCalls.length === 1, "stt scenario calls provider transcribe exactly once");

      const providerCall = mockSttTranscribeCalls[0]!;
      assert(
        providerCall.audio.length === 3 && providerCall.audio[0] === 9 && providerCall.audio[1] === 8 && providerCall.audio[2] === 7,
        "stt scenario passes downloaded media bytes to provider",
      );
      assert(providerCall.mimeType === "audio/ogg", "stt scenario passes correct mime type to provider");
      assert(providerCall.fileName === "voice.ogg", "stt scenario passes inferred file name to provider");

      assert(sttSent.length === 1, "stt scenario sends assistant reply for transcribed prompt");
      assert(sttSent[0]?.text.includes("assistant response from transcript"), "stt scenario reply contains assistant response");
      assert(sttActions.length >= 1, "stt scenario emits chat action while processing media");

      sttRuntime.dispose();
    } finally {
      globalThis.fetch = sttOriginalFetch;
    }
  }

  console.log("\n-- inbound voice media fails gracefully when STT provider throws missing key --");
  const sttMissingKeyStatePath = join(tmp, "telegram", "state.stt.missing-key.json");
  const sttMissingKeyMapPath = join(tmp, "telegram", "session-map.stt.missing-key.json");
  const sttMissingKeySessionDir = join(tmp, "sessions-stt-missing-key");

  const sttMissingKeySent: Array<{ chat_id: number; text: string }> = [];
  let sttMissingKeyRpcCalls = 0;
  const sttMissingKeyClient = {
    async getUpdates() {
      return sttUpdates;
    },
    async sendMessage(chat_id: number, text: string) {
      sttMissingKeySent.push({ chat_id: chat_id, text: text });
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

  let missingKeySttTranscribeCalls = 0;
  const failingSttProvider: SttProvider = {
    async transcribe() {
      missingKeySttTranscribeCalls++;
      throw new SttApiKeyMissingError("ELEVENLABS_API_KEY");
    },
  };

  {
    const sttMissingKeyOriginalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => {
        return {
          ok: true,
          status: 200,
          async arrayBuffer() {
            return new Uint8Array([9, 8, 7]).buffer;
          },
        } as any;
      }) as any;

      const sttMissingKeyRuntime = createTelegramWorkerRuntime({
        settings,
        client: sttMissingKeyClient as any,
        rpcRunner: sttMissingKeyRpcRunner as any,
        sttProvider: failingSttProvider,
        botToken: "stt-test-token",
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
      assert(missingKeySttTranscribeCalls === 1, "stt missing-key scenario calls provider transcribe once");
      assert(sttMissingKeySent.length === 1, "stt missing-key scenario sends user-facing failure reply");
      assert(sttMissingKeySent[0]?.text.includes("ELEVENLABS_API_KEY"), "stt missing-key scenario reply tells operator how to fix config");

      sttMissingKeyRuntime.dispose();
    } finally {
      globalThis.fetch = sttMissingKeyOriginalFetch;
    }
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
  const ttsSentVoice: Array<{ chat_id: number; voice: unknown; reply_parameters?: { message_id: number } }> = [];
  const ttsActions: Array<{ chat_id: number; action: string }> = [];
  const ttsClient = {
    async getUpdates() {
      return ttsUpdates;
    },
    async sendMessage(chat_id: number, text: string) {
      ttsSentMessages.push({ chat_id: chat_id, text: text });
      return { message_id: 7, chat: { id: chat_id, type: "private" as const }, date: 1 };
    },
    async sendVoice(chat_id: number, voice: unknown, other?: Record<string, unknown>) {
      ttsSentVoice.push({
        chat_id,
        voice,
        reply_parameters: (other?.reply_parameters as { message_id: number } | undefined),
      });
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
    assert(ttsSentVoice[0]?.reply_parameters?.message_id === 311, "tts scenario replies in-thread to source message");
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
    async sendMessage(chat_id: number, text: string) {
      ttsMissingKeySentMessages.push({ chat_id: chat_id, text: text });
      return { message_id: 9, chat: { id: chat_id, type: "private" as const }, date: 1 };
    },
    async sendVoice(_chat_id: number, _voice: unknown, _other?: Record<string, unknown>) {
      ttsMissingKeyVoiceSends++;
      return { message_id: 10, chat: { id: 1111, type: "private" as const }, date: 1 };
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
    async sendMessage(chat_id: number, text: string) {
      ttsSendFailureMessages.push({ chat_id: chat_id, text: text });
      return { message_id: 11, chat: { id: chat_id, type: "private" as const }, date: 1 };
    },
    async sendVoice(_chat_id: number, _voice: unknown, _other?: Record<string, unknown>) {
      ttsSendFailureVoiceCalls++;
      throw createGrammyApiError("Bad Request: voice upload rejected", 400);
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

  console.log("\n-- inbound photo media downloads image and sends as vision prompt --");
  const photoStatePath = join(tmp, "telegram", "state.photo.json");
  const photoMapPath = join(tmp, "telegram", "session-map.photo.json");
  const photoSessionDir = join(tmp, "sessions-photo");

  const photoUpdates = [
    {
      update_id: 1401,
      message: {
        message_id: 401,
        from: { id: 2222 },
        chat: { id: 1111, type: "private" as const },
        date: 1,
        caption: "What is this?",
        photo: [
          { file_id: "thumb-photo-1", file_unique_id: "tp1", width: 90, height: 90, file_size: 1200 },
          { file_id: "full-photo-1", file_unique_id: "tp2", width: 800, height: 800, file_size: 120000 },
        ],
      },
    },
  ];

  const photoSent: Array<{ chat_id: number; text: string }> = [];
  const photoGetFileCalls: string[] = [];
  const photoDownloadUrls: string[] = [];
  let photoRpcCalls = 0;
  const photoRpcPrompts: Array<{ message: string; images?: unknown[] }> = [];

  const photoClient = {
    async getUpdates() {
      return photoUpdates;
    },
    async sendMessage(chat_id: number, text: string) {
      photoSent.push({ chat_id, text });
      return { message_id: 12, chat: { id: chat_id, type: "private" as const }, date: 1 };
    },
    async sendChatAction() {
      return true;
    },
    async getFile(file_id: string) {
      photoGetFileCalls.push(file_id);
      return {
        file_id,
        file_path: "photos/photo-from-telegram.jpg",
        file_size: 120000,
      };
    },
  };

  const photoRpcRunner = {
    async runPrompt(_sessionFile: string, message: string, _timeoutMs?: number, images?: unknown[]) {
      photoRpcCalls++;
      photoRpcPrompts.push({ message, images: images ?? [] });
      return "I see a cat in this image.";
    },
    dispose() {
      // no-op
    },
  };

  {
    const photoOriginalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (url: string) => {
        photoDownloadUrls.push(String(url));
        return {
          ok: true,
          status: 200,
          async arrayBuffer() {
            return new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]).buffer;
          },
        } as any;
      }) as any;

      const photoRuntime = createTelegramWorkerRuntime({
        settings,
        client: photoClient as any,
        rpcRunner: photoRpcRunner as any,
        botToken: "photo-test-token",
        statePath: photoStatePath,
        mapPath: photoMapPath,
        sessionDir: photoSessionDir,
        checkTriggerPath: join(tmp, "telegram", "check.trigger.photo.json"),
        operatorConfigPath: join(tmp, "telegram", "config.photo.json"),
        botUsername: "",
        logPath: join(tmp, "telegram", "log.photo.jsonl"),
      });

      const photoResult = await photoRuntime.pollOnce(false);
      assert(photoResult.ok === true, "photo scenario poll succeeds");
      assert(photoResult.accepted === 1, "photo scenario accepts inbound photo update");
      assert(photoRpcCalls === 1, "photo scenario calls rpc prompt exactly once");
      assert(photoGetFileCalls.length === 1 && photoGetFileCalls[0] === "full-photo-1", "photo scenario resolves file metadata from selected photo file id");
      assert(
        photoDownloadUrls.length === 1 && photoDownloadUrls[0]?.includes("/file/botphoto-test-token/photos/photo-from-telegram.jpg"),
        "photo scenario downloads telegram photo file",
      );
      assert(photoRpcPrompts[0]?.message?.startsWith("[msg:") && photoRpcPrompts[0]?.message?.endsWith("\nWhat is this?"), "photo scenario prefixes caption prompt with message metadata");

      const promptImages = photoRpcPrompts[0]?.images as Array<{ type: string; data: string; mimeType: string }>;
      assert(Array.isArray(promptImages) && promptImages.length === 1, "photo scenario passes one image to rpc prompt");
      assert(promptImages[0]?.type === "image", "photo scenario image has type 'image'");
      assert(promptImages[0]?.mimeType === "image/jpeg", "photo scenario image has jpeg mime type");
      assert(typeof promptImages[0]?.data === "string" && promptImages[0].data.length > 0, "photo scenario image has base64 data");

      assert(photoSent.length === 1, "photo scenario sends assistant reply");
      assert(photoSent[0]?.text.includes("cat"), "photo scenario reply contains vision response");

      photoRuntime.dispose();
    } finally {
      globalThis.fetch = photoOriginalFetch;
    }
  }

  console.log("\n-- captionless photo uses default prompt --");
  const captionlessPhotoStatePath = join(tmp, "telegram", "state.photo.captionless.json");
  const captionlessPhotoMapPath = join(tmp, "telegram", "session-map.photo.captionless.json");
  const captionlessPhotoSessionDir = join(tmp, "sessions-photo-captionless");

  const captionlessPhotoUpdates = [
    {
      update_id: 1402,
      message: {
        message_id: 402,
        from: { id: 2222 },
        chat: { id: 1111, type: "private" as const },
        date: 1,
        photo: [
          { file_id: "captionless-photo-1", file_unique_id: "cp1", width: 800, height: 800, file_size: 100000 },
        ],
      },
    },
  ];

  const captionlessPhotoPrompts: Array<{ message: string }> = [];
  const captionlessPhotoClient = {
    async getUpdates() {
      return captionlessPhotoUpdates;
    },
    async sendMessage(chat_id: number, text: string) {
      return { message_id: 13, chat: { id: chat_id, type: "private" as const }, date: 1 };
    },
    async sendChatAction() {
      return true;
    },
    async getFile(file_id: string) {
      return { file_id, file_path: "photos/captionless.jpg", file_size: 100000 };
    },
  };

  const captionlessPhotoRpcRunner = {
    async runPrompt(_sessionFile: string, message: string) {
      captionlessPhotoPrompts.push({ message });
      return "image description";
    },
    dispose() {
      // no-op
    },
  };

  {
    const captionlessOriginalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        async arrayBuffer() { return new Uint8Array([1, 2, 3]).buffer; },
      })) as any;

      const captionlessPhotoRuntime = createTelegramWorkerRuntime({
        settings,
        client: captionlessPhotoClient as any,
        rpcRunner: captionlessPhotoRpcRunner as any,
        botToken: "photo-test-token",
        statePath: captionlessPhotoStatePath,
        mapPath: captionlessPhotoMapPath,
        sessionDir: captionlessPhotoSessionDir,
        checkTriggerPath: join(tmp, "telegram", "check.trigger.photo.captionless.json"),
        operatorConfigPath: join(tmp, "telegram", "config.photo.captionless.json"),
        botUsername: "",
        logPath: join(tmp, "telegram", "log.photo.captionless.jsonl"),
      });

      await captionlessPhotoRuntime.pollOnce(false);
      assert(captionlessPhotoPrompts.length === 1, "captionless photo calls rpc prompt once");
      assert(captionlessPhotoPrompts[0]?.message?.startsWith("[msg:") && captionlessPhotoPrompts[0]?.message?.endsWith("\nDescribe this image."), "captionless photo prefixes default prompt with message metadata");
      captionlessPhotoRuntime.dispose();
    } finally {
      globalThis.fetch = captionlessOriginalFetch;
    }
  }

  console.log("\n-- inbound queue schema preserves photo envelope fields --");
  const photoInboundDir = join(tmp, "telegram-durable-inbound-photo");
  const photoInboundStatePath = join(photoInboundDir, "state.json");
  const photoInboundMapPath = join(photoInboundDir, "session-map.json");
  const photoInboundSessionDir = join(tmp, "sessions-durable-inbound-photo");
  const photoInboundQueuePath = join(photoInboundDir, "inbound.queue.json");

  loadRuntimeState(photoInboundStatePath);
  writeFileSync(
    photoInboundQueuePath,
    JSON.stringify([
      {
        updateId: 1501,
        chatId: 1111,
        chatType: "private",
        userId: 2222,
        messageId: 501,
        text: "",
        isReplyToBot: false,
        media: {
          kind: "photo",
          fileId: "photo-file-queue-1",
          mimeType: "image/jpeg",
          fileSize: 50000,
        },
        sessionKey: "chat-1111-user-2222",
        sessionFile: join(photoInboundSessionDir, "chat-1111-user-2222.jsonl"),
      },
    ], null, 2),
  );

  let photoInboundRpcCalls = 0;
  const photoInboundSent: Array<{ chat_id: number; text: string }> = [];
  const photoInboundClient = {
    async getUpdates() {
      return [];
    },
    async sendMessage(chat_id: number, text: string) {
      photoInboundSent.push({ chat_id, text });
      return { message_id: 14, chat: { id: chat_id, type: "private" as const }, date: 1 };
    },
    async sendChatAction() {
      return true;
    },
    async getFile(file_id: string) {
      return { file_id, file_path: "photos/queued.jpg", file_size: 50000 };
    },
  };

  const photoInboundRpcRunner = {
    async runPrompt(_sessionFile: string, _message: string, _timeoutMs?: number, _images?: unknown[]) {
      photoInboundRpcCalls++;
      return "queued photo response";
    },
    dispose() {
      // no-op
    },
  };

  {
    const photoInboundOriginalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        async arrayBuffer() { return new Uint8Array([1, 2]).buffer; },
      })) as any;

      const photoInboundRuntime = createTelegramWorkerRuntime({
        settings,
        client: photoInboundClient as any,
        rpcRunner: photoInboundRpcRunner as any,
        botToken: "photo-test-token",
        statePath: photoInboundStatePath,
        mapPath: photoInboundMapPath,
        sessionDir: photoInboundSessionDir,
        checkTriggerPath: join(photoInboundDir, "check.trigger.json"),
        operatorConfigPath: join(photoInboundDir, "config.json"),
        botUsername: "",
        logPath: join(photoInboundDir, "log.jsonl"),
      });

      const photoInboundResult = await photoInboundRuntime.pollOnce(false);
      assert(photoInboundResult.ok === true, "photo inbound queue scenario poll succeeds");
      assert(photoInboundRpcCalls === 1, "photo inbound queue scenario processes persisted photo item via rpc");
      assert(photoInboundSent.length === 1, "photo inbound queue scenario sends response for queued photo item");

      const drainedPhotoQueue = existsSync(photoInboundQueuePath)
        ? JSON.parse(readFileSync(photoInboundQueuePath, "utf-8")) as any[]
        : null;
      assert(Array.isArray(drainedPhotoQueue) && drainedPhotoQueue.length === 0, "photo inbound queue scenario drains persisted queue file");

      photoInboundRuntime.dispose();
    } finally {
      globalThis.fetch = photoInboundOriginalFetch;
    }
  }

  console.log("\n-- /jobs and /tts slash commands work without prefix interference --");
  {
    // /jobs and /tts are handled before the RPC call site, so the prefix
    // must NOT be applied to promptText used for slash parsing.
    const slashStatePath = join(tmp, "telegram", "state.slash-prefix.json");
    const slashMapPath = join(tmp, "telegram", "session-map.slash-prefix.json");
    const slashSessionDir = join(tmp, "sessions-slash-prefix");

    const slashUpdates = [
      {
        update_id: 1601,
        message: {
          message_id: 601,
          from: { id: 2222 },
          chat: { id: 1111, type: "private" as const },
          date: 1739808352,
          text: "/jobs",
        },
      },
      {
        update_id: 1602,
        message: {
          message_id: 602,
          from: { id: 2222 },
          chat: { id: 1111, type: "private" as const },
          date: 1739808352,
          text: "/tts hello test",
        },
      },
    ];

    let slashGetUpdatesCalls = 0;
    const slashSent: Array<{ chat_id: number; text: string }> = [];
    let slashRpcCalls = 0;

    const slashClient = {
      async getUpdates() {
        slashGetUpdatesCalls++;
        return slashGetUpdatesCalls === 1 ? slashUpdates : [];
      },
      async sendMessage(chat_id: number, text: string) {
        slashSent.push({ chat_id, text });
        return { message_id: 15, chat: { id: chat_id, type: "private" as const }, date: 1 };
      },
      async sendChatAction() { return true; },
      async sendVoice() {
        return { message_id: 16, chat: { id: 1111, type: "private" as const }, date: 1 };
      },
    };

    const slashRpcRunner = {
      async runPrompt() {
        slashRpcCalls++;
        return "should-not-run";
      },
      dispose() {},
    };

    const slashPrefixOriginalFetch = globalThis.fetch;
    const prevApiKey = process.env.ELEVENLABS_API_KEY;
    try {
      process.env.ELEVENLABS_API_KEY = "test-key";
      globalThis.fetch = (async () => ({
        ok: true,
        status: 200,
        async arrayBuffer() { return new Uint8Array([1, 2]).buffer; },
      })) as any;

      const slashRuntime = createTelegramWorkerRuntime({
        settings,
        client: slashClient as any,
        rpcRunner: slashRpcRunner as any,
        statePath: slashStatePath,
        mapPath: slashMapPath,
        sessionDir: slashSessionDir,
        checkTriggerPath: join(tmp, "telegram", "check.trigger.slash-prefix.json"),
        operatorConfigPath: join(tmp, "telegram", "config.slash-prefix.json"),
        botUsername: "",
        logPath: join(tmp, "telegram", "log.slash-prefix.jsonl"),
      });

      const slashResult = await slashRuntime.pollOnce(false);
      assert(slashResult.ok === true, "slash prefix scenario poll succeeds");
      assert(slashResult.accepted === 2, "slash prefix scenario accepts both /jobs and /tts");
      assert(slashRpcCalls === 0, "slash prefix scenario: /jobs and /tts bypass RPC (prefix does not break ^/ parsing)");
      assert(slashSent.some((s) => s.text.includes("Jobs") || s.text.includes("No jobs")), "slash prefix scenario: /jobs produces job list response");
      slashRuntime.dispose();
    } finally {
      if (prevApiKey === undefined) delete process.env.ELEVENLABS_API_KEY;
      else process.env.ELEVENLABS_API_KEY = prevApiKey;
      globalThis.fetch = slashPrefixOriginalFetch;
    }
  }

  console.log("\n-- inbound queue without date field loads with backwards compat --");
  {
    const noDatDir = join(tmp, "telegram-nodate");
    const noDatStatePath = join(noDatDir, "state.json");
    const noDatMapPath = join(noDatDir, "session-map.json");
    const noDatSessionDir = join(tmp, "sessions-nodate");
    const noDatQueuePath = join(noDatDir, "inbound.queue.json");

    loadRuntimeState(noDatStatePath);
    writeFileSync(
      noDatQueuePath,
      JSON.stringify([
        {
          updateId: 2001,
          chatId: 1111,
          chatType: "private",
          userId: 2222,
          messageId: 501,
          text: "old queue item",
          isReplyToBot: false,
          sessionKey: "dm:1111",
          sessionFile: join(noDatSessionDir, "dm-1111.jsonl"),
        },
      ], null, 2),
    );

    const noDatRpcPrompts: string[] = [];
    const noDatClient = {
      async getUpdates() { return []; },
      async sendMessage(chat_id: number, text: string) {
        return { message_id: 17, chat: { id: chat_id, type: "private" as const }, date: 1 };
      },
      async sendChatAction() { return true; },
    };

    const noDatRpcRunner = {
      async runPrompt(_sessionFile: string, message: string) {
        noDatRpcPrompts.push(message);
        return "compat reply";
      },
      dispose() {},
    };

    const noDatRuntime = createTelegramWorkerRuntime({
      settings,
      client: noDatClient as any,
      rpcRunner: noDatRpcRunner as any,
      statePath: noDatStatePath,
      mapPath: noDatMapPath,
      sessionDir: noDatSessionDir,
      checkTriggerPath: join(noDatDir, "check.trigger.json"),
      operatorConfigPath: join(noDatDir, "config.json"),
      botUsername: "",
      logPath: join(noDatDir, "log.jsonl"),
    });

    const noDatResult = await noDatRuntime.pollOnce(false);
    assert(noDatResult.ok === true, "no-date queue compat scenario poll succeeds");
    assert(noDatRpcPrompts.length === 1, "no-date queue item processed");
    assert(noDatRpcPrompts[0]?.startsWith("[msg:1111:501]\n"), "no-date queue item prefix omits timestamp bracket");
    assert(!noDatRpcPrompts[0]?.includes("[1970") && !noDatRpcPrompts[0]?.includes("[20"), "no-date queue item has no timestamp bracket");
    noDatRuntime.dispose();
  }

  failingRuntime.dispose();
  runtime.dispose();
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===`);
process.exit(FAIL > 0 ? 1 : 0);
