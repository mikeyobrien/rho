import type { Update, Message } from "./api.ts";
import type { PhotoSize } from "@grammyjs/types";
import type { TelegramSettings } from "./lib.ts";

export type TelegramInboundMediaKind = "voice" | "audio" | "document_audio" | "photo" | "document_image";

export const IMAGE_MAX_FILE_SIZE = 5 * 1024 * 1024;

/**
 * Pick the largest photo variant under 4MB from Telegram's photo[] array.
 * Walk from largest to smallest. If all known sizes exceed cap, return null.
 * If all sizes are unknown, pick second-to-last (medium resolution) as safe default.
 */
export function selectBestPhoto(photos: PhotoSize[]): PhotoSize | null {
  if (photos.length === 0) return null;

  let allUnknown = true;
  let hasUnknown = false;
  for (let i = photos.length - 1; i >= 0; i--) {
    const p = photos[i]!;
    if (typeof p.file_size === "number") {
      allUnknown = false;
      if (p.file_size < IMAGE_MAX_FILE_SIZE) return p;
    } else {
      hasUnknown = true;
    }
  }

  // All sizes unknown or mixed with some unknown - pick medium resolution as safe default
  if (allUnknown || hasUnknown) {
    return photos.length >= 2 ? photos[photos.length - 2]! : photos[0]!;
  }

  // All known sizes exceed cap
  return null;
}

export interface TelegramInboundMedia {
  kind: TelegramInboundMediaKind;
  fileId: string;
  mimeType?: string;
  fileName?: string;
  durationSeconds?: number;
  fileSize?: number;
}

export interface TelegramInboundEnvelope {
  updateId: number;
  chatId: number;
  chatType: "private" | "group" | "supergroup" | "channel";
  userId: number | null;
  messageId: number;
  text: string;
  media?: TelegramInboundMedia;
  replyToMessageId?: number;
  isReplyToBot: boolean;
  messageThreadId?: number;
}

function extractInboundMedia(message: Message): TelegramInboundMedia | undefined {
  if (message.voice?.file_id) {
    return {
      kind: "voice",
      fileId: message.voice.file_id,
      mimeType: message.voice.mime_type,
      durationSeconds: typeof message.voice.duration === "number" ? message.voice.duration : undefined,
      fileSize: typeof message.voice.file_size === "number" ? message.voice.file_size : undefined,
    };
  }

  if (message.audio?.file_id) {
    return {
      kind: "audio",
      fileId: message.audio.file_id,
      mimeType: message.audio.mime_type,
      fileName: message.audio.file_name,
      durationSeconds: typeof message.audio.duration === "number" ? message.audio.duration : undefined,
      fileSize: typeof message.audio.file_size === "number" ? message.audio.file_size : undefined,
    };
  }

  if (message.document?.file_id && message.document.mime_type?.toLowerCase().startsWith("audio/")) {
    return {
      kind: "document_audio",
      fileId: message.document.file_id,
      mimeType: message.document.mime_type,
      fileName: message.document.file_name,
      fileSize: typeof message.document.file_size === "number" ? message.document.file_size : undefined,
    };
  }

  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const best = selectBestPhoto(message.photo);
    if (best) {
      return {
        kind: "photo",
        fileId: best.file_id,
        mimeType: "image/jpeg",
        fileSize: typeof best.file_size === "number" ? best.file_size : undefined,
      };
    }
    // All photos over cap - return undefined (caption-only or drop)
    return undefined;
  }

  if (message.document?.file_id && message.document.mime_type?.toLowerCase().startsWith("image/")) {
    return {
      kind: "document_image",
      fileId: message.document.file_id,
      mimeType: message.document.mime_type,
      fileName: message.document.file_name,
      fileSize: typeof message.document.file_size === "number" ? message.document.file_size : undefined,
    };
  }

  return undefined;
}

export function normalizeInboundUpdate(update: Update): TelegramInboundEnvelope | null {
  const message = update.message ?? update.edited_message;
  if (!message) return null;

  const text = (message.text || message.caption || "").trim();
  const media = extractInboundMedia(message);
  if (!text && !media) return null;

  return {
    updateId: update.update_id,
    chatId: message.chat.id,
    chatType: message.chat.type as TelegramInboundEnvelope["chatType"],
    userId: typeof message.from?.id === "number" ? message.from.id : null,
    messageId: message.message_id,
    text,
    media,
    replyToMessageId: message.reply_to_message?.message_id,
    isReplyToBot: message.reply_to_message?.from?.is_bot === true,
    messageThreadId: typeof message.message_thread_id === "number" && message.message_thread_id > 0 ? message.message_thread_id : undefined,
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
