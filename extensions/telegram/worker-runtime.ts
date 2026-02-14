import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { TelegramApiError, isTelegramParseModeError, type GetUpdatesParams, type SendChatActionParams, type SendMessageParams, type TelegramUpdate } from "./api.ts";
import {
  advanceUpdateOffset,
  loadRuntimeState,
  markPollFailure,
  markPollSuccess,
  saveRuntimeState,
  TELEGRAM_CHECK_TRIGGER_PATH,
  TELEGRAM_STATE_PATH,
  type TelegramRuntimeState,
  type TelegramSettings,
} from "./lib.ts";
import { authorizeInbound, normalizeInboundUpdate, type TelegramInboundEnvelope } from "./router.ts";
import { resetSessionFile, resolveSessionFile } from "./session-map.ts";
import { appendTelegramLog } from "./log.ts";
import { renderTelegramOutboundChunks } from "./outbound.ts";
import { retryDelayMs, shouldRetryTelegramError } from "./retry.ts";
import { loadOperatorConfig } from "./operator-config.ts";
import { consumeTelegramCheckTrigger, type TelegramCheckTriggerRequestV1 } from "./check-trigger.ts";
import { TelegramRpcRunner } from "./rpc.ts";
import { upsertPendingApproval } from "./pending-approvals.ts";
import { formatSlashPromptFailure, parseSlashInput } from "./slash-contract.ts";

export interface TelegramClientLike {
  getUpdates(params: GetUpdatesParams): Promise<TelegramUpdate[]>;
  sendMessage(params: SendMessageParams): Promise<unknown>;
  sendChatAction(params: SendChatActionParams): Promise<unknown>;
}

export interface TelegramRpcRunnerLike {
  runPrompt(sessionFile: string, message: string, timeoutMs?: number): Promise<string>;
  dispose(): void;
}

export interface TelegramWorkerRuntimeOptions {
  settings: TelegramSettings;
  client: TelegramClientLike | null;
  botUsername?: string;
  statePath?: string;
  mapPath?: string;
  sessionDir?: string;
  checkTriggerPath?: string;
  operatorConfigPath?: string;
  rpcRunner?: TelegramRpcRunnerLike;
  logPath?: string;
  logEvent?: (event: string, context?: TelegramLogContext, extra?: Record<string, unknown>) => void;
}

export interface TelegramWorkerPollResult {
  ok: boolean;
  updates: number;
  accepted: number;
  blocked: number;
  error?: string;
  skipped?: string;
}

export interface TelegramWorkerSnapshot {
  runtimeState: TelegramRuntimeState;
  pendingInbound: number;
  pendingOutbound: number;
  pendingBackground: number;
  sendFailures: number;
  lastCheckConsumeAt: number | null;
  lastCheckOutcome: "ok" | "error" | null;
  lastCheckRequesterPid: number | null;
}

export interface TelegramWorkerRuntime {
  pollOnce(silent?: boolean): Promise<TelegramWorkerPollResult>;
  handleCheckTrigger(): Promise<{ triggered: boolean; result?: TelegramWorkerPollResult; request: TelegramCheckTriggerRequestV1 | null }>;
  getSnapshot(): TelegramWorkerSnapshot;
  dispose(): void;
}

type TelegramLogContext = {
  updateId?: number;
  chatId?: number;
  userId?: number | null;
  messageId?: number;
  sessionKey?: string;
  sessionFile?: string;
};

type PendingInboundItem = TelegramInboundEnvelope & {
  sessionKey: string;
  sessionFile: string;
};

type PendingOutboundItem = {
  chatId: number;
  replyToMessageId?: number;
  text: string;
  attempts: number;
  notBeforeMs: number;
};

type PendingBackgroundItem = {
  id: string;
  updateId: number;
  chatId: number;
  userId: number | null;
  messageId: number;
  sessionKey: string;
  sessionFile: string;
  promptText: string;
  createdAtMs: number;
  startedAtMs: number | null;
};

function ensureJsonFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    writeFileSync(path, "[]");
  }
}

function loadInboundQueue(path: string): PendingInboundItem[] {
  ensureJsonFile(path);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!Array.isArray(parsed)) return [];

    return parsed.filter((item): item is PendingInboundItem => {
      if (!item || typeof item !== "object") return false;
      const candidate = item as Record<string, unknown>;
      return typeof candidate.updateId === "number"
        && typeof candidate.chatId === "number"
        && (candidate.chatType === "private" || candidate.chatType === "group" || candidate.chatType === "supergroup" || candidate.chatType === "channel")
        && (typeof candidate.userId === "number" || candidate.userId === null)
        && typeof candidate.messageId === "number"
        && typeof candidate.text === "string"
        && typeof candidate.isReplyToBot === "boolean"
        && typeof candidate.sessionKey === "string"
        && typeof candidate.sessionFile === "string";
    });
  } catch {
    return [];
  }
}

function loadOutboundQueue(path: string): PendingOutboundItem[] {
  ensureJsonFile(path);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!Array.isArray(parsed)) return [];

    return parsed.filter((item): item is PendingOutboundItem => {
      if (!item || typeof item !== "object") return false;
      const candidate = item as Record<string, unknown>;
      const hasReplyTo = typeof candidate.replyToMessageId === "number" || candidate.replyToMessageId === undefined;
      return typeof candidate.chatId === "number"
        && typeof candidate.text === "string"
        && typeof candidate.attempts === "number"
        && typeof candidate.notBeforeMs === "number"
        && hasReplyTo;
    });
  } catch {
    return [];
  }
}

function loadBackgroundQueue(path: string): PendingBackgroundItem[] {
  ensureJsonFile(path);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!Array.isArray(parsed)) return [];

    return parsed.filter((item): item is PendingBackgroundItem => {
      if (!item || typeof item !== "object") return false;
      const candidate = item as Record<string, unknown>;
      return typeof candidate.id === "string"
        && typeof candidate.updateId === "number"
        && typeof candidate.chatId === "number"
        && (typeof candidate.userId === "number" || candidate.userId === null)
        && typeof candidate.messageId === "number"
        && typeof candidate.sessionKey === "string"
        && typeof candidate.sessionFile === "string"
        && typeof candidate.promptText === "string"
        && typeof candidate.createdAtMs === "number"
        && (typeof candidate.startedAtMs === "number" || candidate.startedAtMs === null);
    });
  } catch {
    return [];
  }
}

function saveInboundQueue(path: string, queue: PendingInboundItem[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(queue, null, 2));
}

function saveOutboundQueue(path: string, queue: PendingOutboundItem[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(queue, null, 2));
}

function saveBackgroundQueue(path: string, queue: PendingBackgroundItem[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(queue, null, 2));
}

export function createTelegramWorkerRuntime(options: TelegramWorkerRuntimeOptions): TelegramWorkerRuntime {
  const settings = options.settings;
  const client = options.client;
  const rpcRunner = options.rpcRunner ?? new TelegramRpcRunner();
  const botUsername = (options.botUsername || "").replace(/^@/, "").trim();
  const statePath = options.statePath ?? TELEGRAM_STATE_PATH;
  const mapPath = options.mapPath;
  const sessionDir = options.sessionDir;
  const telegramDir = dirname(statePath);
  const inboundQueuePath = join(telegramDir, "inbound.queue.json");
  const outboundQueuePath = join(telegramDir, "outbound.queue.json");
  const backgroundQueuePath = join(telegramDir, "background.queue.json");
  const checkTriggerPath = options.checkTriggerPath ?? TELEGRAM_CHECK_TRIGGER_PATH;
  const logPath = options.logPath;
  const strictAllowlist = true;
  const foregroundPromptTimeoutMs = Math.max(1, settings.rpcPromptTimeoutSeconds) * 1000;
  const backgroundPromptTimeoutMs = Math.max(
    foregroundPromptTimeoutMs,
    Math.max(1, settings.backgroundPromptTimeoutSeconds) * 1000,
  );

  let runtimeState: TelegramRuntimeState = loadRuntimeState(statePath);
  let pendingInbound: PendingInboundItem[] = loadInboundQueue(inboundQueuePath);
  let pendingOutbound: PendingOutboundItem[] = loadOutboundQueue(outboundQueuePath);
  let pendingBackground: PendingBackgroundItem[] = loadBackgroundQueue(backgroundQueuePath).map((item) => ({
    ...item,
    startedAtMs: null,
  }));
  let drainingInbound = false;
  let flushingOutbound = false;
  let pollInFlight = false;
  let backgroundPumpInFlight = false;
  let disposed = false;
  let consecutiveSendFailures = 0;
  let checkTriggerSeenMtimeMs = 0;
  let lastCheckConsumeAt: number | null = runtimeState.last_check_consume_at;
  let lastCheckOutcome: "ok" | "error" | null = runtimeState.last_check_outcome;
  let lastCheckRequesterPid: number | null = runtimeState.last_check_requester_pid;

  const activeBackgroundBySession = new Set<string>();
  const activeBackgroundById = new Set<string>();

  const logEvent = (event: string, context: TelegramLogContext = {}, extra: Record<string, unknown> = {}) => {
    if (options.logEvent) {
      options.logEvent(event, context, extra);
      return;
    }
    appendTelegramLog(
      {
        event,
        update_id: context.updateId,
        chat_id: context.chatId,
        user_id: context.userId,
        message_id: context.messageId,
        session_key: context.sessionKey,
        session_file: context.sessionFile,
        ...extra,
      },
      logPath,
    );
  };

  const effectiveAuthSettings = () => {
    const operatorConfig = loadOperatorConfig(options.operatorConfigPath);
    return {
      ...settings,
      allowedChatIds: operatorConfig?.allowedChatIds ?? settings.allowedChatIds,
      allowedUserIds: operatorConfig?.allowedUserIds ?? settings.allowedUserIds,
    };
  };

  const persistRuntimeState = () => {
    saveRuntimeState(runtimeState, statePath);
  };

  const persistInboundQueue = () => {
    saveInboundQueue(inboundQueuePath, pendingInbound);
  };

  const persistOutboundQueue = () => {
    saveOutboundQueue(outboundQueuePath, pendingOutbound);
  };

  const persistBackgroundQueue = () => {
    saveBackgroundQueue(backgroundQueuePath, pendingBackground);
  };

  const withTypingIndicator = async <T>(chatId: number, work: () => Promise<T>): Promise<T> => {
    if (!client) return await work();

    let timer: NodeJS.Timeout | null = null;
    const sendTyping = async () => {
      try {
        await client.sendChatAction({ chat_id: chatId, action: "typing" });
      } catch {
        // Ignore typing indicator failures; they are non-critical.
      }
    };

    void sendTyping();
    timer = setInterval(() => { void sendTyping(); }, 4000);

    try {
      return await work();
    } finally {
      if (timer) clearInterval(timer);
    }
  };

  const formatPromptFailureText = (inputText: string, rawMessage: string): string => {
    const message = String(rawMessage || "RPC prompt failed").trim() || "RPC prompt failed";
    const slashMapped = formatSlashPromptFailure(inputText, message);

    if (parseSlashInput(inputText).isSlash) {
      return `⚠️ ${slashMapped}`;
    }

    return `⚠️ Failed to run prompt: ${message}`;
  };

  const isPromptTimeoutError = (rawMessage: string): boolean => {
    const message = String(rawMessage || "");
    return /rpc prompt timed out/i.test(message);
  };

  const shouldDeferPromptToBackground = (promptText: string, rawMessage: string): boolean => {
    if (parseSlashInput(promptText).isSlash) return false;
    return isPromptTimeoutError(rawMessage);
  };

  const backgroundDeferAcknowledgement = "⏳ This may take a while. I’ll continue in the background and post results here.";

  const normalizeSlashMention = (text: string): string => {
    const trimmed = String(text || "").trim();
    if (!trimmed.startsWith("/")) return text;

    const token = trimmed.split(/\s+/, 1)[0] || "";
    const match = token.match(/^\/([a-z0-9:_-]+)@([a-z0-9_]+)$/i);
    if (!match) return text;

    if (!botUsername) return text;
    if (match[2].toLowerCase() !== botUsername.toLowerCase()) return text;

    const rest = trimmed.slice(token.length);
    return `/${match[1]}${rest}`;
  };

  const enqueueBackgroundPrompt = (item: PendingInboundItem, promptText: string): PendingBackgroundItem => {
    const queued: PendingBackgroundItem = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      updateId: item.updateId,
      chatId: item.chatId,
      userId: item.userId,
      messageId: item.messageId,
      sessionKey: item.sessionKey,
      sessionFile: item.sessionFile,
      promptText,
      createdAtMs: Date.now(),
      startedAtMs: null,
    };
    pendingBackground.push(queued);
    persistBackgroundQueue();
    return queued;
  };

  const isNewSessionCommand = (text: string): boolean => {
    const token = String(text || "").trim().split(/\s+/, 1)[0]?.toLowerCase() || "";
    if (!token.startsWith("/new")) return false;
    if (token === "/new") return true;
    if (!token.startsWith("/new@")) return false;

    const target = token.slice("/new@".length);
    if (!target) return false;
    if (!botUsername) return true;
    return target === botUsername.toLowerCase();
  };

  const newSessionAcknowledgement = "🆕 Started a new session for this chat.";

  const pumpBackgroundQueue = async () => {
    if (backgroundPumpInFlight || disposed) return;
    backgroundPumpInFlight = true;

    try {
      for (const item of pendingBackground) {
        if (disposed) break;
        if (activeBackgroundById.has(item.id)) continue;
        if (activeBackgroundBySession.has(item.sessionKey)) continue;

        activeBackgroundById.add(item.id);
        activeBackgroundBySession.add(item.sessionKey);
        item.startedAtMs = Date.now();
        persistBackgroundQueue();

        logEvent(
          "rpc_prompt_background_started",
          {
            updateId: item.updateId,
            chatId: item.chatId,
            userId: item.userId,
            messageId: item.messageId,
            sessionKey: item.sessionKey,
            sessionFile: item.sessionFile,
          },
          {
            timeout_ms: backgroundPromptTimeoutMs,
            prompt_preview: item.promptText.slice(0, 160),
          },
        );

        void (async () => {
          try {
            const response = await withTypingIndicator(
              item.chatId,
              () => rpcRunner.runPrompt(item.sessionFile, item.promptText, backgroundPromptTimeoutMs),
            );
            pendingOutbound.push({
              chatId: item.chatId,
              replyToMessageId: item.messageId,
              text: response
                ? `✅ Background task finished.\n\n${response}`
                : "✅ Background task finished.\n\n(No response)",
              attempts: 0,
              notBeforeMs: 0,
            });
            logEvent(
              "rpc_prompt_background_ok",
              {
                updateId: item.updateId,
                chatId: item.chatId,
                userId: item.userId,
                messageId: item.messageId,
                sessionKey: item.sessionKey,
                sessionFile: item.sessionFile,
              },
              {
                response_length: response.length,
              },
            );
          } catch (error) {
            const msg = (error as Error)?.message || String(error);
            pendingOutbound.push({
              chatId: item.chatId,
              replyToMessageId: item.messageId,
              text: formatPromptFailureText(item.promptText, msg),
              attempts: 0,
              notBeforeMs: 0,
            });
            logEvent(
              "rpc_prompt_background_error",
              {
                updateId: item.updateId,
                chatId: item.chatId,
                userId: item.userId,
                messageId: item.messageId,
                sessionKey: item.sessionKey,
                sessionFile: item.sessionFile,
              },
              {
                error: msg,
              },
            );
          } finally {
            activeBackgroundById.delete(item.id);
            activeBackgroundBySession.delete(item.sessionKey);
            pendingBackground = pendingBackground.filter((candidate) => candidate.id !== item.id);
            persistBackgroundQueue();
            persistOutboundQueue();
            await flushOutboundQueue();
            await drainInboundQueue();
            void pumpBackgroundQueue();
          }
        })();
      }
    } finally {
      backgroundPumpInFlight = false;
    }
  };

  const drainInboundQueue = async () => {
    if (drainingInbound) return;
    drainingInbound = true;
    try {
      if (pendingInbound.length === 0) {
        await pumpBackgroundQueue();
        return;
      }

      const deferred: PendingInboundItem[] = [];
      while (pendingInbound.length > 0) {
        const item = pendingInbound.shift()!;
        if (activeBackgroundBySession.has(item.sessionKey)) {
          deferred.push(item);
          continue;
        }

        const promptText = normalizeSlashMention(item.text);

        try {
          const response = await withTypingIndicator(
            item.chatId,
            () => rpcRunner.runPrompt(item.sessionFile, promptText, foregroundPromptTimeoutMs),
          );
          pendingOutbound.push({
            chatId: item.chatId,
            replyToMessageId: item.messageId,
            text: response || "(No response)",
            attempts: 0,
            notBeforeMs: 0,
          });
          logEvent(
            "rpc_prompt_ok",
            {
              updateId: item.updateId,
              chatId: item.chatId,
              userId: item.userId,
              messageId: item.messageId,
              sessionKey: item.sessionKey,
              sessionFile: item.sessionFile,
            },
            { response_length: response.length },
          );
        } catch (error) {
          const msg = (error as Error)?.message || String(error);

          if (shouldDeferPromptToBackground(promptText, msg)) {
            const queued = enqueueBackgroundPrompt(item, promptText);
            pendingOutbound.push({
              chatId: item.chatId,
              replyToMessageId: item.messageId,
              text: backgroundDeferAcknowledgement,
              attempts: 0,
              notBeforeMs: 0,
            });
            logEvent(
              "rpc_prompt_deferred_background",
              {
                updateId: item.updateId,
                chatId: item.chatId,
                userId: item.userId,
                messageId: item.messageId,
                sessionKey: item.sessionKey,
                sessionFile: item.sessionFile,
              },
              {
                background_id: queued.id,
                timeout_ms: foregroundPromptTimeoutMs,
                error: msg,
              },
            );
          } else {
            pendingOutbound.push({
              chatId: item.chatId,
              replyToMessageId: item.messageId,
              text: formatPromptFailureText(promptText, msg),
              attempts: 0,
              notBeforeMs: 0,
            });
            logEvent(
              "rpc_prompt_error",
              {
                updateId: item.updateId,
                chatId: item.chatId,
                userId: item.userId,
                messageId: item.messageId,
                sessionKey: item.sessionKey,
                sessionFile: item.sessionFile,
              },
              { error: msg },
            );
          }
        }

        persistOutboundQueue();
      }

      pendingInbound = deferred;
      persistInboundQueue();
      await pumpBackgroundQueue();
    } finally {
      drainingInbound = false;
    }
  };

  const flushOutboundQueue = async () => {
    if (!client || flushingOutbound) return;
    flushingOutbound = true;

    try {
      let index = 0;
    while (index < pendingOutbound.length) {
      const item = pendingOutbound[index]!;
      if (item.notBeforeMs > Date.now()) {
        index += 1;
        continue;
      }

      const chunks = renderTelegramOutboundChunks(item.text);
      let failed = false;
      let retryScheduled = false;

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        let sentTextPreview = chunk.text;

        try {
          try {
            await client.sendMessage({
              chat_id: item.chatId,
              text: chunk.text,
              parse_mode: chunk.parseMode,
              disable_web_page_preview: true,
              reply_to_message_id: i === 0 ? item.replyToMessageId : undefined,
            });
          } catch (error) {
            if (chunk.parseMode && isTelegramParseModeError(error)) {
              await client.sendMessage({
                chat_id: item.chatId,
                text: chunk.fallbackText,
                disable_web_page_preview: true,
                reply_to_message_id: i === 0 ? item.replyToMessageId : undefined,
              });
              sentTextPreview = chunk.fallbackText;
              logEvent(
                "outbound_parse_mode_fallback",
                {
                  chatId: item.chatId,
                  messageId: i === 0 ? item.replyToMessageId : undefined,
                },
                {
                  chunk_index: i,
                  chunk_count: chunks.length,
                  attempts: item.attempts,
                  parse_mode: chunk.parseMode,
                },
              );
            } else {
              throw error;
            }
          }

          consecutiveSendFailures = 0;
          logEvent(
            "outbound_sent",
            {
              chatId: item.chatId,
              messageId: i === 0 ? item.replyToMessageId : undefined,
            },
            {
              chunk_index: i,
              chunk_count: chunks.length,
              attempts: item.attempts,
              text_preview: sentTextPreview.slice(0, 120),
            },
          );
        } catch (error) {
          failed = true;
          consecutiveSendFailures += 1;
          const msg = (error as Error)?.message || String(error);
          logEvent(
            "outbound_error",
            { chatId: item.chatId },
            {
              chunk_index: i,
              chunk_count: chunks.length,
              attempts: item.attempts,
              error: msg,
            },
          );

          if (shouldRetryTelegramError(error, item.attempts)) {
            const delay = retryDelayMs(error, item.attempts);
            pendingOutbound[index] = {
              ...item,
              attempts: item.attempts + 1,
              notBeforeMs: Date.now() + delay,
            };
            persistOutboundQueue();
            retryScheduled = true;
            logEvent(
              "outbound_retry_scheduled",
              { chatId: item.chatId },
              {
                attempts: item.attempts + 1,
                retry_in_ms: delay,
              },
            );
          } else {
            pendingOutbound.splice(index, 1);
            persistOutboundQueue();
          }

          break;
        }
      }

      if (!failed) {
        pendingOutbound.splice(index, 1);
        persistOutboundQueue();
        continue;
      }

      if (retryScheduled) {
        index += 1;
      }
    }
    } finally {
      flushingOutbound = false;
    }
  };

  const pollOnce = async (silent = true): Promise<TelegramWorkerPollResult> => {
    if (!settings.enabled || !client || settings.mode !== "polling") {
      return { ok: false, updates: 0, accepted: 0, blocked: 0, skipped: "disabled_or_invalid_mode" };
    }
    if (pollInFlight) {
      return { ok: false, updates: 0, accepted: 0, blocked: 0, skipped: "poll_in_flight" };
    }

    pollInFlight = true;
    try {
      const updates = await client.getUpdates({
        offset: runtimeState.last_update_id,
        timeout: settings.pollTimeoutSeconds,
        allowed_updates: ["message", "edited_message"],
      });

      let accepted = 0;
      let blocked = 0;
      for (const update of updates) {
        const envelope = normalizeInboundUpdate(update);
        if (!envelope) continue;

        const auth = authorizeInbound(envelope, effectiveAuthSettings(), botUsername || undefined, strictAllowlist);
        if (!auth.ok) {
          blocked += 1;
          logEvent(
            "inbound_blocked",
            {
              updateId: envelope.updateId,
              chatId: envelope.chatId,
              userId: envelope.userId,
              messageId: envelope.messageId,
            },
            { reason: auth.reason },
          );

          if (strictAllowlist && (auth.reason === "chat_not_allowed" || auth.reason === "user_not_allowed")) {
            const pending = upsertPendingApproval({
              chatId: envelope.chatId,
              userId: envelope.userId,
              textPreview: envelope.text.slice(0, 160),
            });

            logEvent(
              "inbound_pending_approval",
              {
                updateId: envelope.updateId,
                chatId: envelope.chatId,
                userId: envelope.userId,
                messageId: envelope.messageId,
              },
              {
                pin: pending.request.pin,
                pending_created: pending.created,
              },
            );

            if (pending.created) {
              try {
                await client.sendMessage({
                  chat_id: envelope.chatId,
                  text: `🔒 Access request received. Share this PIN with the operator to approve: ${pending.request.pin}`,
                  reply_to_message_id: envelope.messageId,
                });
              } catch {
                // ignore notification failures for blocked users
              }
            }
          }

          continue;
        }

        if (isNewSessionCommand(envelope.text)) {
          const reset = resetSessionFile(envelope, mapPath, sessionDir);
          accepted += 1;
          pendingOutbound.push({
            chatId: envelope.chatId,
            replyToMessageId: envelope.messageId,
            text: newSessionAcknowledgement,
            attempts: 0,
            notBeforeMs: 0,
          });

          logEvent(
            "session_reset",
            {
              updateId: envelope.updateId,
              chatId: envelope.chatId,
              userId: envelope.userId,
              messageId: envelope.messageId,
              sessionKey: reset.sessionKey,
              sessionFile: reset.sessionFile,
            },
            {
              previous_session_file: reset.previousSessionFile ?? null,
              text_preview: envelope.text.slice(0, 160),
            },
          );

          continue;
        }

        const mapped = resolveSessionFile(envelope, mapPath, sessionDir);
        accepted += 1;
        pendingInbound.push({ ...envelope, sessionKey: mapped.sessionKey, sessionFile: mapped.sessionFile });
        logEvent(
          "inbound_accepted",
          {
            updateId: envelope.updateId,
            chatId: envelope.chatId,
            userId: envelope.userId,
            messageId: envelope.messageId,
            sessionKey: mapped.sessionKey,
            sessionFile: mapped.sessionFile,
          },
          {
            mapping_created: mapped.created,
            text_preview: envelope.text.slice(0, 160),
          },
        );
      }

      const updateIds = updates.map((u) => u.update_id);
      runtimeState.last_update_id = advanceUpdateOffset(runtimeState.last_update_id, updateIds);
      runtimeState = markPollSuccess(runtimeState);
      persistRuntimeState();
      persistInboundQueue();

      await drainInboundQueue();
      await flushOutboundQueue();
      await pumpBackgroundQueue();

      logEvent("poll_ok", {}, {
        updates: updates.length,
        accepted,
        blocked,
        last_update_id: runtimeState.last_update_id,
        poll_failures: runtimeState.consecutive_failures,
        send_failures: consecutiveSendFailures,
        background_pending: pendingBackground.length,
      });

      if (!silent) {
        // no-op (worker has no UI)
      }

      return { ok: true, updates: updates.length, accepted, blocked };
    } catch (error) {
      runtimeState = markPollFailure(runtimeState);
      persistRuntimeState();
      const msg = error instanceof TelegramApiError ? error.message : (error as Error)?.message || String(error);
      logEvent("poll_error", {}, {
        error: msg,
        last_update_id: runtimeState.last_update_id,
        poll_failures: runtimeState.consecutive_failures,
      });
      return { ok: false, updates: 0, accepted: 0, blocked: 0, error: msg };
    } finally {
      pollInFlight = false;
    }
  };

  const executeOperatorCheck = async (
    source: "trigger" | "manual",
    options?: { requesterPid?: number | null; silent?: boolean },
  ) => {
    const result = await pollOnce(options?.silent ?? source === "trigger");
    logEvent("operator_check_executed", {}, {
      check_source: source,
      requester_pid: options?.requesterPid ?? null,
      executed_by_pid: process.pid,
      result: result.ok ? "ok" : "error",
      skipped: result.skipped ?? null,
      updates: result.updates,
      accepted: result.accepted,
      blocked: result.blocked,
      error: result.error,
    });
    return result;
  };

  const handleCheckTrigger = async () => {
    const consumed = consumeTelegramCheckTrigger(checkTriggerPath, checkTriggerSeenMtimeMs);
    checkTriggerSeenMtimeMs = consumed.nextSeen;
    if (!consumed.triggered) {
      return { triggered: false, result: undefined, request: consumed.request };
    }

    logEvent("operator_check_trigger_consumed", {}, {
      consumed_by_pid: process.pid,
      requester_pid: consumed.request?.requesterPid ?? null,
      requester_role: consumed.request?.requesterRole ?? null,
      requested_at: consumed.request?.requestedAt ?? null,
      check_source: consumed.request?.source ?? null,
    });

    lastCheckConsumeAt = Date.now();
    lastCheckRequesterPid = consumed.request?.requesterPid ?? null;
    runtimeState.last_check_request_at = consumed.request?.requestedAt ?? null;
    runtimeState.last_check_consume_at = lastCheckConsumeAt;
    runtimeState.last_check_requester_pid = lastCheckRequesterPid;

    try {
      const result = await executeOperatorCheck("trigger", {
        requesterPid: consumed.request?.requesterPid ?? null,
        silent: true,
      });
      lastCheckOutcome = result.ok ? "ok" : "error";
      runtimeState.last_check_outcome = lastCheckOutcome;
      persistRuntimeState();
      return { triggered: true, result, request: consumed.request };
    } catch (error) {
      lastCheckOutcome = "error";
      runtimeState.last_check_outcome = lastCheckOutcome;
      persistRuntimeState();
      throw error;
    }
  };

  const getSnapshot = (): TelegramWorkerSnapshot => ({
    runtimeState,
    pendingInbound: pendingInbound.length,
    pendingOutbound: pendingOutbound.length,
    pendingBackground: pendingBackground.length,
    sendFailures: consecutiveSendFailures,
    lastCheckConsumeAt,
    lastCheckOutcome,
    lastCheckRequesterPid,
  });

  const dispose = () => {
    disposed = true;
    activeBackgroundById.clear();
    activeBackgroundBySession.clear();
    rpcRunner.dispose();
  };

  return {
    pollOnce,
    handleCheckTrigger,
    getSnapshot,
    dispose,
  };
}
