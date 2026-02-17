/**
 * Rho Telegram Extension (control-plane)
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { Api, isTelegramParseModeError, isRetryableAfterAutoRetry, queueRetryDelayMs, replyParams } from "./api.ts";
import { autoRetry } from "@grammyjs/auto-retry";
import {
  loadRuntimeState,
  readTelegramSettings,
  TELEGRAM_CHECK_TRIGGER_PATH,
  TELEGRAM_WORKER_LOCK_PATH,
} from "./lib.ts";
import { appendTelegramLog } from "./log.ts";
import { loadSessionMap } from "./session-map.ts";
import { renderTelegramOutboundChunks } from "./outbound.ts";
import { loadOperatorConfig, saveOperatorConfig } from "./operator-config.ts";
import { getTelegramCheckTriggerState, requestTelegramCheckTrigger } from "./check-trigger.ts";
import { loadTelegramJobs, summarizeTelegramJobs } from "./jobs.ts";
import { renderTelegramStatusText, renderTelegramUiStatus } from "./status.ts";
import { readTelegramWorkerLockOwner } from "./worker-lock.ts";
import { isLeaseStale, readLeaseMeta } from "../lib/lease-lock.ts";

const DEFAULT_WORKER_LOCK_STALE_MS = 90_000;

function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function setStatus(ctx: ExtensionContext, text: string, level: "dim" | "warning" | "error" = "dim"): void {
  if (!ctx.hasUI) return;
  const theme = ctx.ui.theme;
  const color = level === "error" ? "error" : level === "warning" ? "warning" : "dim";
  ctx.ui.setStatus("telegram", theme.fg(color, text));
}

type TelegramLogContext = {
  updateId?: number;
  chatId?: number;
  userId?: number | null;
  messageId?: number;
  sessionKey?: string;
  sessionFile?: string;
};

export default function (pi: ExtensionAPI) {
  // ── telegram_send: always registered, even in subagent contexts ──────────
  // Heartbeat and other subagents need to send Telegram messages but the
  // full control-plane (polling, commands, outbound queue) is gated behind
  // the RHO_SUBAGENT guard below.  This lightweight tool reads settings
  // fresh on each call so it is completely self-contained.
  pi.registerTool({
    name: "telegram_send",
    label: "Telegram Send",
    description:
      "Send a message to a Telegram chat. Works in all contexts including subagents.",
    parameters: Type.Object({
      chat_id: Type.Integer(),
      text: Type.String(),
      reply_to_message_id: Type.Optional(Type.Integer()),
      message_thread_id: Type.Optional(Type.Integer()),
    }),
    async execute(_toolCallId, params, _signal) {
      const tgSettings = readTelegramSettings();
      if (!tgSettings.enabled) {
        return { content: [{ type: "text", text: "Telegram is disabled in init.toml" }] };
      }
      const tgToken = (process.env[tgSettings.botTokenEnv] || "").trim();
      if (!tgToken) {
        return {
          content: [{ type: "text", text: `Missing token env: ${tgSettings.botTokenEnv}` }],
        };
      }

      if (!Number.isInteger(params.chat_id)) {
        return { content: [{ type: "text", text: "chat_id must be a valid integer" }] };
      }

      const text = (params.text ?? "").trim();
      if (text.length === 0) {
        return { content: [{ type: "text", text: "text must be non-empty" }] };
      }

      const opConfig = loadOperatorConfig();
      const allowedChatIds = opConfig?.allowedChatIds ?? tgSettings.allowedChatIds;
      if (allowedChatIds.length > 0 && !allowedChatIds.includes(params.chat_id)) {
        return {
          content: [
            { type: "text", text: `chat_id ${params.chat_id} is not in the allowed list` },
          ],
        };
      }

      const client = new Api(tgToken);
      client.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }));

      const chunks = renderTelegramOutboundChunks(text);
      const errors: string[] = [];

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        try {
          try {
            await client.sendMessage(params.chat_id, chunk.text, {
              parse_mode: chunk.parseMode,
              link_preview_options: { is_disabled: true },
              message_thread_id: params.message_thread_id,
              ...replyParams(i === 0 ? params.reply_to_message_id : undefined),
            });
          } catch (error) {
            if (chunk.parseMode && isTelegramParseModeError(error)) {
              await client.sendMessage(params.chat_id, chunk.fallbackText, {
                link_preview_options: { is_disabled: true },
                message_thread_id: params.message_thread_id,
                ...replyParams(i === 0 ? params.reply_to_message_id : undefined),
              });
            } else {
              throw error;
            }
          }
        } catch (error) {
          errors.push(`chunk ${i}: ${(error as Error)?.message || String(error)}`);
          break;
        }
      }

      if (errors.length > 0) {
        return {
          content: [{ type: "text", text: `send failed: ${errors.join("; ")}` }],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `sent to ${params.chat_id} (${chunks.length} chunk${chunks.length === 1 ? "" : "s"})`,
          },
        ],
      };
    },
  });

  // Keep telegram controls available in RPC sessions (get_commands, /telegram)
  // so headless/web/worker surfaces can execute command passthrough consistently.
  // Only hard-disable inside explicit subagent contexts.
  if (process.env.RHO_SUBAGENT === "1") return;

  const settings = readTelegramSettings();
  const token = process.env[settings.botTokenEnv] || "";
  const operatorConfig = loadOperatorConfig();

  let runtimeAllowedChatIds = [...(operatorConfig?.allowedChatIds ?? settings.allowedChatIds)];
  let runtimeAllowedUserIds = [...(operatorConfig?.allowedUserIds ?? settings.allowedUserIds)];

  let pendingOutbound: Array<{
    chatId: number;
    replyToMessageId?: number;
    messageThreadId?: number;
    text: string;
    attempts: number;
    notBeforeMs: number;
  }> = [];
  let consecutiveSendFailures = 0;
  let lastCheckRequestAtMs: number | null = null;

  const client = token.trim() ? new Api(token.trim()) : null;
  if (client) client.config.use(autoRetry({ maxRetryAttempts: 3, maxDelaySeconds: 30 }));

  const persistOperator = () => {
    saveOperatorConfig({
      allowedChatIds: runtimeAllowedChatIds,
      allowedUserIds: runtimeAllowedUserIds,
    });
  };

  const logEvent = (event: string, context: TelegramLogContext = {}, extra: Record<string, unknown> = {}) => {
    appendTelegramLog({
      event,
      update_id: context.updateId,
      chat_id: context.chatId,
      user_id: context.userId,
      message_id: context.messageId,
      session_key: context.sessionKey,
      session_file: context.sessionFile,
      ...extra,
    });
  };

  const getWorkerStatus = () => {
    const meta = readLeaseMeta(TELEGRAM_WORKER_LOCK_PATH);
    if (!meta.payload) return { owner: null, stale: false };
    const staleMs = parsePositiveIntEnv("RHO_TELEGRAM_WORKER_LOCK_STALE_MS", DEFAULT_WORKER_LOCK_STALE_MS);
    const stale = isLeaseStale(meta, staleMs, Date.now());
    return { owner: readTelegramWorkerLockOwner(TELEGRAM_WORKER_LOCK_PATH), stale };
  };

  const formatOwner = (owner: ReturnType<typeof readTelegramWorkerLockOwner> | null, stale: boolean) => {
    if (!owner) {
      return { leadership: "stopped", ownerText: "none", ownerPid: null };
    }
    const host = owner.hostname ? ` @${owner.hostname}` : "";
    const staleText = stale ? " (stale)" : "";
    return {
      leadership: stale
        ? `stale lock (pid ${owner.pid}${host})`
        : `worker (pid ${owner.pid}${host})`,
      ownerText: `${owner.pid}${host}${staleText}`,
      ownerPid: owner.pid,
    };
  };

  const refreshStatus = (ctx: ExtensionContext) => {
    const runtimeState = loadRuntimeState();
    if (!settings.enabled) {
      setStatus(ctx, "tg off", "dim");
      return;
    }
    if (!client) {
      setStatus(ctx, "tg no-token", "warning");
      return;
    }
    if (runtimeState.consecutive_failures >= 3) {
      setStatus(ctx, `tg poll-err(${runtimeState.consecutive_failures})`, "error");
      return;
    }
    if (consecutiveSendFailures >= 3) {
      setStatus(ctx, `tg send-err(${consecutiveSendFailures})`, "error");
      return;
    }

    const { owner, stale } = getWorkerStatus();
    const formatted = formatOwner(owner, stale);
    const triggerState = getTelegramCheckTriggerState(TELEGRAM_CHECK_TRIGGER_PATH, 0);
    setStatus(
      ctx,
      renderTelegramUiStatus({
        mode: settings.mode,
        isLeader: formatted.ownerPid === process.pid,
        ownerPid: formatted.ownerPid,
        lastUpdateId: runtimeState.last_update_id,
        pendingInbound: 0,
        pendingOutbound: pendingOutbound.length,
        pollFailures: runtimeState.consecutive_failures,
        sendFailures: consecutiveSendFailures,
        triggerPending: triggerState.pending,
      }),
      "dim",
    );
  };

  const statusText = () => {
    const runtimeState = loadRuntimeState();
    const triggerState = getTelegramCheckTriggerState(TELEGRAM_CHECK_TRIGGER_PATH, 0);
    const { owner, stale } = getWorkerStatus();
    const formatted = formatOwner(owner, stale);
    const jobs = summarizeTelegramJobs(loadTelegramJobs());
    return renderTelegramStatusText({
      enabled: settings.enabled,
      mode: settings.mode,
      leadershipText: formatted.leadership,
      pollLockPath: TELEGRAM_WORKER_LOCK_PATH,
      pollLockOwnerText: formatted.ownerText,
      triggerPath: TELEGRAM_CHECK_TRIGGER_PATH,
      triggerPending: triggerState.pending,
      triggerRequesterPid: triggerState.requesterPid,
      triggerRequestedAt: triggerState.requestedAt,
      lastCheckRequestAt: runtimeState.last_check_request_at ?? lastCheckRequestAtMs,
      lastCheckConsumeAt: runtimeState.last_check_consume_at,
      lastCheckOutcome: runtimeState.last_check_outcome,
      lastCheckRequesterPid: runtimeState.last_check_requester_pid,
      tokenEnv: settings.botTokenEnv,
      lastUpdateId: runtimeState.last_update_id,
      lastPollAt: runtimeState.last_poll_at,
      pollFailures: runtimeState.consecutive_failures,
      sendFailures: consecutiveSendFailures,
      pendingInbound: 0,
      pendingOutbound: pendingOutbound.length,
      pendingJobs: jobs.queued,
      runningJobs: jobs.running,
      allowedChatsText: runtimeAllowedChatIds.length === 0 ? "all" : runtimeAllowedChatIds.join(","),
      allowedUsersText: runtimeAllowedUserIds.length === 0 ? "all" : runtimeAllowedUserIds.join(","),
    });
  };

  const applyAllowlistMutation = (target: "chat" | "user", action: "allow" | "revoke", id: number) => {
    const current = target === "chat" ? runtimeAllowedChatIds : runtimeAllowedUserIds;
    const next = new Set(current);
    if (action === "allow") next.add(id);
    else next.delete(id);

    if (target === "chat") runtimeAllowedChatIds = [...next];
    else runtimeAllowedUserIds = [...next];

    persistOperator();
    logEvent("operator_allowlist_changed", {}, {
      target,
      action,
      id,
      allowed_chats: runtimeAllowedChatIds,
      allowed_users: runtimeAllowedUserIds,
    });
  };

  const requestWorkerCheck = (source: "tool" | "command"): boolean => {
    const requestedAt = Date.now();
    const requested = requestTelegramCheckTrigger(TELEGRAM_CHECK_TRIGGER_PATH, {
      requestedAt,
      requesterPid: process.pid,
      requesterRole: "follower",
      source,
    });

    if (requested) {
      lastCheckRequestAtMs = requestedAt;
      logEvent("operator_check_requested", {}, {
        route: "follower_trigger",
        requested_at: requestedAt,
        requester_pid: process.pid,
        check_source: source,
        owner_pid: getWorkerStatus().owner?.pid ?? null,
      });
    }

    return requested;
  };

  const flushOutboundQueue = async (ctx: ExtensionContext) => {
    if (!client) return;
    const deferred: typeof pendingOutbound = [];

    while (pendingOutbound.length > 0) {
      const item = pendingOutbound.shift()!;
      if (item.notBeforeMs > Date.now()) {
        deferred.push(item);
        continue;
      }

      const chunks = renderTelegramOutboundChunks(item.text);
      let failed = false;

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        let sentTextPreview = chunk.text;

        try {
          try {
            await client.sendMessage(item.chatId, chunk.text, {
              parse_mode: chunk.parseMode,
              link_preview_options: { is_disabled: true },
              message_thread_id: item.messageThreadId,
              ...replyParams(i === 0 ? item.replyToMessageId : undefined),
            });
          } catch (error) {
            if (chunk.parseMode && isTelegramParseModeError(error)) {
              await client.sendMessage(item.chatId, chunk.fallbackText, {
                link_preview_options: { is_disabled: true },
                message_thread_id: item.messageThreadId,
                ...replyParams(i === 0 ? item.replyToMessageId : undefined),
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

          if (isRetryableAfterAutoRetry(error, item.attempts)) {
            const delay = queueRetryDelayMs(error, item.attempts);
            deferred.push({
              ...item,
              attempts: item.attempts + 1,
              notBeforeMs: Date.now() + delay,
            });
            logEvent(
              "outbound_retry_scheduled",
              { chatId: item.chatId },
              {
                attempts: item.attempts + 1,
                retry_in_ms: delay,
              },
            );
          } else if (ctx.hasUI) {
            ctx.ui.notify(`Telegram send failed: ${msg}`, "warning");
          }
          break;
        }
      }

      if (!failed) {
        // no-op
      }
    }

    if (deferred.length > 0) {
      pendingOutbound = [...pendingOutbound, ...deferred];
    }

    refreshStatus(ctx);
  };

  pi.on("session_start", (_event, ctx) => {
    refreshStatus(ctx);
  });

  pi.on("session_switch", (_event, ctx) => {
    refreshStatus(ctx);
  });

  pi.registerTool({
    name: "telegram",
    label: "Telegram",
    description: "Operate Telegram channel bridge. Actions: status, check, send, allow, revoke, list_chats",
    parameters: Type.Object({
      action: StringEnum(["status", "check", "send", "allow", "revoke", "list_chats"] as const),
      target: Type.Optional(StringEnum(["chat", "user"] as const)),
      id: Type.Optional(Type.Integer()),
      chat_id: Type.Optional(Type.Integer()),
      text: Type.Optional(Type.String()),
      reply_to_message_id: Type.Optional(Type.Integer()),
      message_thread_id: Type.Optional(Type.Integer()),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (params.action === "status") {
        refreshStatus(ctx);
        return { content: [{ type: "text", text: statusText() }] };
      }

      if (params.action === "list_chats") {
        const map = loadSessionMap();
        const entries = Object.entries(map);
        const text = entries.length === 0
          ? "No mapped chats yet."
          : entries.map(([k, v]) => `${k} -> ${v}`).join("\n");
        return { content: [{ type: "text", text }] };
      }

      if (!settings.enabled) {
        return { content: [{ type: "text", text: "Telegram is disabled in init.toml" }] };
      }

      if (!client) {
        return { content: [{ type: "text", text: `Missing token env: ${settings.botTokenEnv}` }] };
      }

      if (params.action === "check") {
        const requested = requestWorkerCheck("tool");
        const text = requested
          ? `Requested Telegram check via worker\n${statusText()}`
          : `Failed to request Telegram check\n${statusText()}`;
        return { content: [{ type: "text", text }] };
      }

      if (params.action === "send") {
        const text = typeof params.text === "string" ? params.text : "";
        if (!Number.isInteger(params.chat_id) || text.trim().length === 0) {
          return { content: [{ type: "text", text: "send requires chat_id and non-empty text" }] };
        }
        pendingOutbound.push({
          chatId: params.chat_id,
          replyToMessageId: params.reply_to_message_id,
          messageThreadId: params.message_thread_id,
          text,
          attempts: 0,
          notBeforeMs: 0,
        });
        await flushOutboundQueue(ctx);
        return { content: [{ type: "text", text: `queued send to ${params.chat_id}` }] };
      }

      if (params.action === "allow" || params.action === "revoke") {
        if (!params.target || !Number.isInteger(params.id)) {
          return { content: [{ type: "text", text: `${params.action} requires target=(chat|user) and integer id` }] };
        }

        applyAllowlistMutation(params.target, params.action, params.id);
        refreshStatus(ctx);
        return { content: [{ type: "text", text: statusText() }] };
      }

      return { content: [{ type: "text", text: "Unknown action" }] };
    },
  });

  pi.registerCommand("telegram", {
    description: "Telegram channel status and controls",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] || "status").toLowerCase();

      if (sub === "status") {
        refreshStatus(ctx);
        ctx.ui.notify(statusText(), "info");
        return;
      }

      if (sub === "check") {
        const requested = requestWorkerCheck("command");
        ctx.ui.notify(
          requested ? "Requested Telegram check via worker" : "Failed to request Telegram check",
          requested ? "info" : "warning",
        );
        return;
      }

      if (sub === "allow-chat" || sub === "revoke-chat" || sub === "allow-user" || sub === "revoke-user") {
        const id = Number(parts[1]);
        if (!Number.isInteger(id)) {
          ctx.ui.notify("Usage: /telegram allow-chat|revoke-chat|allow-user|revoke-user <id>", "warning");
          return;
        }

        const target = sub.includes("chat") ? "chat" : "user";
        const action = sub.startsWith("allow") ? "allow" : "revoke";
        applyAllowlistMutation(target, action, id);

        refreshStatus(ctx);
        ctx.ui.notify(statusText(), "success");
        return;
      }

      ctx.ui.notify("Usage: /telegram [status|check|allow-chat|revoke-chat|allow-user|revoke-user]", "warning");
    },
  });
}
