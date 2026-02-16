import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { parse as parseToml } from "smol-toml";

const HOME = process.env.HOME || homedir();
export const RHO_HOME = join(HOME, ".rho");
export const INIT_TOML = join(RHO_HOME, "init.toml");
export const TELEGRAM_DIR = join(RHO_HOME, "telegram");
export const TELEGRAM_STATE_PATH = join(TELEGRAM_DIR, "state.json");
export const TELEGRAM_POLL_LOCK_PATH = join(TELEGRAM_DIR, "poll.lock.json");
export const TELEGRAM_WORKER_LOCK_PATH = join(TELEGRAM_DIR, "worker.lock.json");
export const TELEGRAM_CHECK_TRIGGER_PATH = join(TELEGRAM_DIR, "check.trigger.json");

export interface TelegramSettings {
  enabled: boolean;
  mode: "polling" | "webhook";
  botTokenEnv: string;
  pollTimeoutSeconds: number;
  rpcPromptTimeoutSeconds: number;
  backgroundPromptTimeoutSeconds: number;
  allowedChatIds: number[];
  allowedUserIds: number[];
  requireMentionInGroups: boolean;
  threadedMode: boolean;
  sttProvider: "elevenlabs" | "openai";
  sttApiKeyEnv: string;
  sttEndpoint: string;
  sttModel: string;
}

export interface TelegramRuntimeState {
  last_update_id: number;
  last_poll_at: string | null;
  consecutive_failures: number;
  mode: "polling" | "webhook";
  last_check_request_at: number | null;
  last_check_consume_at: number | null;
  last_check_outcome: "ok" | "error" | null;
  last_check_requester_pid: number | null;
}

export const DEFAULT_SETTINGS: TelegramSettings = {
  enabled: false,
  mode: "polling",
  botTokenEnv: "TELEGRAM_BOT_TOKEN",
  pollTimeoutSeconds: 30,
  rpcPromptTimeoutSeconds: 60,
  backgroundPromptTimeoutSeconds: 900,
  allowedChatIds: [],
  allowedUserIds: [],
  requireMentionInGroups: true,
  threadedMode: false,
  sttProvider: "elevenlabs",
  sttApiKeyEnv: "ELEVENLABS_API_KEY",
  sttEndpoint: "",
  sttModel: "",
};

export const DEFAULT_STATE: TelegramRuntimeState = {
  last_update_id: 0,
  last_poll_at: null,
  consecutive_failures: 0,
  mode: "polling",
  last_check_request_at: null,
  last_check_consume_at: null,
  last_check_outcome: null,
  last_check_requester_pid: null,
};

function toNumberArray(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
}

export function readTelegramSettings(initPath: string = INIT_TOML): TelegramSettings {
  if (!existsSync(initPath)) return { ...DEFAULT_SETTINGS };
  try {
    const raw = parseToml(readFileSync(initPath, "utf-8")) as Record<string, any>;
    const settings = (raw.settings ?? {}) as Record<string, unknown>;
    const telegram = (settings.telegram ?? {}) as Record<string, unknown>;

    return {
      enabled: typeof telegram.enabled === "boolean" ? telegram.enabled : DEFAULT_SETTINGS.enabled,
      mode: telegram.mode === "webhook" ? "webhook" : "polling",
      botTokenEnv: typeof telegram.bot_token_env === "string" && telegram.bot_token_env.trim()
        ? telegram.bot_token_env.trim()
        : DEFAULT_SETTINGS.botTokenEnv,
      pollTimeoutSeconds: typeof telegram.poll_timeout_seconds === "number" && telegram.poll_timeout_seconds > 0
        ? Math.floor(telegram.poll_timeout_seconds)
        : DEFAULT_SETTINGS.pollTimeoutSeconds,
      rpcPromptTimeoutSeconds:
        typeof telegram.rpc_prompt_timeout_seconds === "number" && telegram.rpc_prompt_timeout_seconds > 0
          ? Math.floor(telegram.rpc_prompt_timeout_seconds)
          : DEFAULT_SETTINGS.rpcPromptTimeoutSeconds,
      backgroundPromptTimeoutSeconds:
        typeof telegram.background_prompt_timeout_seconds === "number" && telegram.background_prompt_timeout_seconds > 0
          ? Math.floor(telegram.background_prompt_timeout_seconds)
          : DEFAULT_SETTINGS.backgroundPromptTimeoutSeconds,
      allowedChatIds: toNumberArray(telegram.allowed_chat_ids),
      allowedUserIds: toNumberArray(telegram.allowed_user_ids),
      requireMentionInGroups:
        typeof telegram.require_mention_in_groups === "boolean"
          ? telegram.require_mention_in_groups
          : DEFAULT_SETTINGS.requireMentionInGroups,
      threadedMode: telegram.threaded_mode === true,
      sttProvider:
        telegram.stt_provider === "elevenlabs" || telegram.stt_provider === "openai"
          ? telegram.stt_provider
          : DEFAULT_SETTINGS.sttProvider,
      sttApiKeyEnv:
        typeof telegram.stt_api_key_env === "string" && telegram.stt_api_key_env.trim()
          ? telegram.stt_api_key_env.trim()
          : DEFAULT_SETTINGS.sttApiKeyEnv,
      sttEndpoint:
        typeof telegram.stt_endpoint === "string"
          ? telegram.stt_endpoint.trim()
          : DEFAULT_SETTINGS.sttEndpoint,
      sttModel:
        typeof telegram.stt_model === "string"
          ? telegram.stt_model.trim()
          : DEFAULT_SETTINGS.sttModel,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function ensureTelegramDir(telegramDir: string): void {
  mkdirSync(telegramDir, { recursive: true });
}

export function loadRuntimeState(statePath: string = TELEGRAM_STATE_PATH): TelegramRuntimeState {
  const telegramDir = dirname(statePath);
  ensureTelegramDir(telegramDir);
  if (!existsSync(statePath)) {
    writeFileSync(statePath, JSON.stringify(DEFAULT_STATE, null, 2));
    return { ...DEFAULT_STATE };
  }
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf-8")) as Partial<TelegramRuntimeState>;
    return {
      last_update_id: typeof parsed.last_update_id === "number" ? parsed.last_update_id : 0,
      last_poll_at: typeof parsed.last_poll_at === "string" || parsed.last_poll_at === null ? parsed.last_poll_at : null,
      consecutive_failures: typeof parsed.consecutive_failures === "number" ? parsed.consecutive_failures : 0,
      mode: parsed.mode === "webhook" ? "webhook" : "polling",
      last_check_request_at: typeof parsed.last_check_request_at === "number" ? parsed.last_check_request_at : null,
      last_check_consume_at: typeof parsed.last_check_consume_at === "number" ? parsed.last_check_consume_at : null,
      last_check_outcome: parsed.last_check_outcome === "ok" || parsed.last_check_outcome === "error" ? parsed.last_check_outcome : null,
      last_check_requester_pid: typeof parsed.last_check_requester_pid === "number" ? parsed.last_check_requester_pid : null,
    };
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveRuntimeState(state: TelegramRuntimeState, statePath: string = TELEGRAM_STATE_PATH): void {
  const telegramDir = dirname(statePath);
  ensureTelegramDir(telegramDir);
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}

export function advanceUpdateOffset(current: number, updateIds: number[]): number {
  if (updateIds.length === 0) return current;
  const maxUpdateId = Math.max(...updateIds);
  return Math.max(current, maxUpdateId + 1);
}

export function markPollSuccess(state: TelegramRuntimeState): TelegramRuntimeState {
  return {
    ...state,
    consecutive_failures: 0,
    last_poll_at: new Date().toISOString(),
  };
}

export function markPollFailure(state: TelegramRuntimeState): TelegramRuntimeState {
  return {
    ...state,
    consecutive_failures: state.consecutive_failures + 1,
    last_poll_at: new Date().toISOString(),
  };
}
