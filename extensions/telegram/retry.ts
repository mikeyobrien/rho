import { GrammyError, retryAfterSeconds } from "./api.ts";

export function shouldRetryTelegramError(error: unknown, attempt: number, maxAttempts = 3): boolean {
  if (attempt >= maxAttempts) return false;
  if (!(error instanceof GrammyError)) return false;
  if (error.error_code === 429) return true;
  if (error.error_code >= 500) return true;
  return false;
}

export function retryDelayMs(error: unknown, attempt: number): number {
  const retryAfter = retryAfterSeconds(error);
  if (typeof retryAfter === "number") {
    return Math.max(0, retryAfter * 1000);
  }
  const base = 1000;
  return Math.min(30_000, base * Math.pow(2, Math.max(0, attempt)));
}
