/**
 * Telegram API adapter — backed by grammy.
 *
 * Re-exports grammy primitives so the rest of the telegram extension
 * can import them from a single canonical location.
 */

import { Api, GrammyError, InputFile } from "grammy";
import type { Update, Message, User, Chat, File } from "@grammyjs/types";

export { Api, GrammyError, InputFile };
export type { Update, Message, User, Chat, File };

/* ------------------------------------------------------------------ */
/*  Error utilities                                                    */
/* ------------------------------------------------------------------ */

export function isGrammyError(error: unknown): error is GrammyError {
  return error instanceof GrammyError;
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

export function retryAfterSeconds(error: unknown): number | undefined {
  if (!(error instanceof GrammyError)) return undefined;
  const value = error.parameters?.retry_after;
  return typeof value === "number" ? value : undefined;
}

/* ------------------------------------------------------------------ */
/*  File download helper (grammy doesn't provide raw file download)    */
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
