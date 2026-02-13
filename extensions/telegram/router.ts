import type { TelegramMessage, TelegramUpdate } from "./api.ts";
import type { TelegramSettings } from "./lib.ts";

export interface TelegramInboundEnvelope {
  updateId: number;
  chatId: number;
  chatType: TelegramMessage["chat"]["type"];
  userId: number | null;
  messageId: number;
  text: string;
  replyToMessageId?: number;
  isReplyToBot: boolean;
}

export function normalizeInboundUpdate(update: TelegramUpdate): TelegramInboundEnvelope | null {
  const message = update.message ?? update.edited_message;
  if (!message) return null;
  const text = (message.text || message.caption || "").trim();
  if (!text) return null;

  return {
    updateId: update.update_id,
    chatId: message.chat.id,
    chatType: message.chat.type,
    userId: typeof message.from?.id === "number" ? message.from.id : null,
    messageId: message.message_id,
    text,
    replyToMessageId: message.reply_to_message?.message_id,
    isReplyToBot: message.reply_to_message?.from?.is_bot === true,
  };
}

function isAllowedId(id: number | null, allowed: number[], strictAllowlist: boolean): boolean {
  if (allowed.length === 0) return !strictAllowlist;
  if (id === null) return false;
  return allowed.includes(id);
}

function groupActivated(envelope: TelegramInboundEnvelope, settings: TelegramSettings, botUsername?: string): boolean {
  if (envelope.chatType === "private") return true;
  if (!settings.requireMentionInGroups) return true;
  if (envelope.isReplyToBot) return true;

  const text = envelope.text.toLowerCase();
  if (text.startsWith("/rho")) return true;
  if (botUsername && text.includes(`@${botUsername.toLowerCase()}`)) return true;

  return false;
}

export function authorizeInbound(
  envelope: TelegramInboundEnvelope,
  settings: TelegramSettings,
  botUsername?: string,
  strictAllowlist = false,
): { ok: boolean; reason?: string } {
  if (!isAllowedId(envelope.chatId, settings.allowedChatIds, strictAllowlist)) {
    return { ok: false, reason: "chat_not_allowed" };
  }
  if (!isAllowedId(envelope.userId, settings.allowedUserIds, strictAllowlist)) {
    return { ok: false, reason: "user_not_allowed" };
  }
  if (!groupActivated(envelope, settings, botUsername)) {
    return { ok: false, reason: "group_not_activated" };
  }
  return { ok: true };
}
