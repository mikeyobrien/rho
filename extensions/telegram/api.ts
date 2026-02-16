/**
 * Telegram API adapter — backed by grammY.
 *
 * Centralizes imports/utility helpers so the rest of the telegram extension
 * can use one canonical module.
 */

import { Api, GrammyError, HttpError, InputFile } from "grammy";
import type { Update, Message, User, Chat, File } from "@grammyjs/types";

export { Api, GrammyError, HttpError, InputFile };
export type { Update, Message, User, Chat, File };

/* ------------------------------------------------------------------ */
/*  Error utilities                                                    */
/* ------------------------------------------------------------------ */

export function retryAfterSeconds(error: unknown): number | undefined {
  if (!(error instanceof GrammyError)) return undefined;
  const value = error.parameters?.retry_after;
  return typeof value === "number" ? value : undefined;
}

export function isTelegramParseModeError(error: unknown): boolean {
  if (!(error instanceof GrammyError)) return false;
  if (error.error_code === 429 || error.error_code >= 500) return false;

  const message = String(error.description || "").toLowerCase();
  return (
    message.includes("can't parse entities")
    || message.includes("can't find end of")
    || message.includes("unsupported start tag")
    || message.includes("entity")
  );
}

/**
 * Should a failed send be re-queued for a later flush cycle?
 * Called AFTER auto-retry exhausted its within-call retries.
 */
export function isRetryableAfterAutoRetry(error: unknown, attempt: number, maxAttempts = 6): boolean {
  if (attempt >= maxAttempts) return false;
  if (error instanceof HttpError) return true;
  if (!(error instanceof GrammyError)) return false;
  if (error.error_code === 429) return true;
  if (error.error_code >= 500) return true;
  return false;
}

export function queueRetryDelayMs(error: unknown, attempt: number): number {
  const retryAfter = retryAfterSeconds(error);
  if (typeof retryAfter === "number") {
    return Math.max(0, retryAfter * 1000);
  }
  const base = 2000;
  return Math.min(60_000, base * Math.pow(2, Math.max(0, attempt)));
}

/** Build reply_parameters for grammY sendMessage/sendVoice calls. */
export function replyParams(messageId: number | undefined): Record<string, unknown> {
  return messageId ? { reply_parameters: { message_id: messageId } } : {};
}

/* ------------------------------------------------------------------ */
/*  File download helper (grammY doesn't provide raw file download)    */
/* ------------------------------------------------------------------ */

export async function downloadFile(
  token: string,
  filePath: string,
  baseUrl = "https://api.telegram.org",
): Promise<Uint8Array> {
  const normalizedPath = String(filePath || "").replace(/^\/+/, "");
  if (!normalizedPath) {
    throw new Error("downloadFile: file_path is required");
  }

  const url = `${baseUrl.replace(/\/+$/, "")}/file/bot${token}/${normalizedPath}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Telegram file download failed (${response.status})`);
  }

  return new Uint8Array(await response.arrayBuffer());
}
