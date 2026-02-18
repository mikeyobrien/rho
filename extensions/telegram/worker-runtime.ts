import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  GrammyError,
  HttpError,
  InputFile,
  isTelegramParseModeError,
  isRetryableAfterAutoRetry,
  queueRetryDelayMs,
  replyParams,
  downloadFile as downloadTelegramFile,
  type Update,
  type Message,
  type File,
} from "./api.ts";
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
import { authorizeInbound, normalizeInboundUpdate, IMAGE_MAX_FILE_SIZE, type TelegramInboundEnvelope } from "./router.ts";
import { resetSessionFile, resolveSessionFile } from "./session-map.ts";
import { appendTelegramLog } from "./log.ts";
import { renderTelegramOutboundChunks } from "./outbound.ts";
import { loadOperatorConfig } from "./operator-config.ts";
import { consumeTelegramCheckTrigger, type TelegramCheckTriggerRequestV1 } from "./check-trigger.ts";
import { TelegramRpcRunner } from "./rpc.ts";
import {
  createTelegramJobId,
  loadTelegramJobs,
  saveTelegramJobs,
  summarizeTelegramJobs,
  type TelegramJobRecord,
} from "./jobs.ts";
import { upsertPendingApproval } from "./pending-approvals.ts";
import { formatSlashPromptFailure, parseSlashInput } from "./slash-contract.ts";
import { createSttProvider, SttApiKeyMissingError, type SttProvider } from "./stt.ts";

/**
 * Minimal interface matching the grammy Api methods this module uses.
 * Production code passes a real grammy `Api` instance; tests pass lightweight mocks.
 */
export interface TelegramApiLike {
  getUpdates(other?: { offset?: number; timeout?: number; allowed_updates?: readonly string[] }): Promise<Update[]>;
  sendMessage(chat_id: number | string, text: string, other?: Record<string, unknown>): Promise<Message.TextMessage>;
  sendChatAction(chat_id: number | string, action: string, other?: Record<string, unknown>): Promise<true>;
  sendVoice?(chat_id: number | string, voice: InputFile | string, other?: Record<string, unknown>): Promise<Message.VoiceMessage>;
  sendAudio?(chat_id: number | string, audio: InputFile | string, other?: Record<string, unknown>): Promise<Message.AudioMessage>;
  getFile?(file_id: string): Promise<File>;
}

export interface TelegramRpcRunnerLike {
  runPrompt(sessionFile: string, message: string, timeoutMs?: number, images?: Array<{ type: "image"; data: string; mimeType: string }>): Promise<string>;
  cancelSession?(sessionFile: string, reason?: string): boolean;
  dispose(): void;
}

export interface TelegramWorkerRuntimeOptions {
  settings: TelegramSettings;
  client: TelegramApiLike | null;
  botToken?: string;
  botUsername?: string;
  statePath?: string;
  mapPath?: string;
  sessionDir?: string;
  checkTriggerPath?: string;
  operatorConfigPath?: string;
  rpcRunner?: TelegramRpcRunnerLike;
  sttProvider?: SttProvider;
  jobsPath?: string;
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
  pendingJobs: number;
  runningJobs: number;
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
  messageThreadId?: number;
  text: string;
  attempts: number;
  notBeforeMs: number;
};

type PendingBackgroundItem = TelegramJobRecord;

function formatMessagePrefix(item: PendingInboundItem): string {
  const msgTag = `[msg:${item.chatId}:${item.messageId}]`;
  if (!item.date) {
    return `${msgTag}\n`;
  }
  const tz = (process.env.TELEGRAM_TIMESTAMP_TZ || "").trim() || "UTC";
  const dt = new Date(item.date * 1000);
  const formatted = dt.toLocaleString("sv-SE", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${msgTag} [${formatted}]\n`;
}

/** Prepend metadata prefix unless prompt is a slash command (would break RPC slash parsing). */
function prefixPrompt(item: PendingInboundItem, promptText: string): string {
  if (promptText.trimStart().startsWith("/")) return promptText;
  return formatMessagePrefix(item) + promptText;
}

const DEFAULT_ELEVENLABS_TTS_VOICE_ID = "EXAVITQu4vr4xnSDxMaL";
const DEFAULT_ELEVENLABS_TTS_MODEL_ID = "eleven_multilingual_v2";

const waitMs = async (ms: number) => {
  await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));
};

function ensureJsonFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    writeFileSync(path, "[]");
  }
}

function isImageMediaKind(kind: string): boolean {
  return kind === "photo" || kind === "document_image";
}

function isInboundMediaEnvelope(value: unknown): value is NonNullable<TelegramInboundEnvelope["media"]> {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.kind !== "voice"
    && candidate.kind !== "audio"
    && candidate.kind !== "document_audio"
    && candidate.kind !== "photo"
    && candidate.kind !== "document_image"
  ) {
    return false;
  }
  if (typeof candidate.fileId !== "string" || candidate.fileId.trim().length === 0) return false;
  if (candidate.mimeType !== undefined && typeof candidate.mimeType !== "string") return false;
  if (candidate.fileName !== undefined && typeof candidate.fileName !== "string") return false;
  // durationSeconds only applies to audio kinds
  if (!isImageMediaKind(candidate.kind as string)) {
    if (candidate.durationSeconds !== undefined && (typeof candidate.durationSeconds !== "number" || !Number.isFinite(candidate.durationSeconds))) {
      return false;
    }
  }
  if (candidate.fileSize !== undefined && (typeof candidate.fileSize !== "number" || !Number.isFinite(candidate.fileSize))) {
    return false;
  }
  return true;
}

function loadInboundQueue(path: string): PendingInboundItem[] {
  ensureJsonFile(path);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!Array.isArray(parsed)) return [];

    return parsed.filter((item): item is PendingInboundItem => {
      if (!item || typeof item !== "object") return false;
      const candidate = item as Record<string, unknown>;
      const hasReplyTo = typeof candidate.replyToMessageId === "number" || candidate.replyToMessageId === undefined;
      const hasMedia = candidate.media === undefined || isInboundMediaEnvelope(candidate.media);
      const hasPayload = (typeof candidate.text === "string" && candidate.text.length > 0) || candidate.media !== undefined;
      return typeof candidate.updateId === "number"
        && typeof candidate.chatId === "number"
        && (candidate.chatType === "private" || candidate.chatType === "group" || candidate.chatType === "supergroup" || candidate.chatType === "channel")
        && (typeof candidate.userId === "number" || candidate.userId === null)
        && typeof candidate.messageId === "number"
        && (candidate.date === undefined || (typeof candidate.date === "number" && Number.isFinite(candidate.date)))
        && typeof candidate.text === "string"
        && hasMedia
        && hasReplyTo
        && hasPayload
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

function loadLegacyBackgroundQueue(path: string): Array<{
  id: string;
  updateId: number;
  chatId: number;
  userId: number | null;
  messageId: number;
  messageThreadId?: number;
  sessionKey: string;
  sessionFile: string;
  promptText: string;
  createdAtMs: number;
  startedAtMs: number | null;
}> {
  ensureJsonFile(path);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!Array.isArray(parsed)) return [];

    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const candidate = item as Record<string, unknown>;
      if (
        typeof candidate.id !== "string"
        || typeof candidate.updateId !== "number"
        || typeof candidate.chatId !== "number"
        || (typeof candidate.userId !== "number" && candidate.userId !== null)
        || typeof candidate.messageId !== "number"
        || typeof candidate.sessionKey !== "string"
        || typeof candidate.sessionFile !== "string"
        || typeof candidate.promptText !== "string"
        || typeof candidate.createdAtMs !== "number"
        || (typeof candidate.startedAtMs !== "number" && candidate.startedAtMs !== null)
      ) {
        return [];
      }
      return [{
        id: candidate.id,
        updateId: candidate.updateId,
        chatId: candidate.chatId,
        userId: candidate.userId as number | null,
        messageId: candidate.messageId,
        messageThreadId: typeof candidate.messageThreadId === "number" ? candidate.messageThreadId : undefined,
        sessionKey: candidate.sessionKey,
        sessionFile: candidate.sessionFile,
        promptText: candidate.promptText,
        createdAtMs: candidate.createdAtMs,
        startedAtMs: candidate.startedAtMs as number | null,
      }];
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

export function createTelegramWorkerRuntime(options: TelegramWorkerRuntimeOptions): TelegramWorkerRuntime {
  const settings = options.settings;
  const client = options.client;
  const botToken = options.botToken ?? "";
  const rpcRunner = options.rpcRunner ?? new TelegramRpcRunner();
  const botUsername = (options.botUsername || "").replace(/^@/, "").trim();
  const statePath = options.statePath ?? TELEGRAM_STATE_PATH;
  const mapPath = options.mapPath;
  const sessionDir = options.sessionDir;
  const telegramDir = dirname(statePath);
  const inboundQueuePath = join(telegramDir, "inbound.queue.json");
  const outboundQueuePath = join(telegramDir, "outbound.queue.json");
  const legacyBackgroundQueuePath = join(telegramDir, "background.queue.json");
  const jobsPath = options.jobsPath ?? join(telegramDir, "jobs.json");
  const checkTriggerPath = options.checkTriggerPath ?? TELEGRAM_CHECK_TRIGGER_PATH;
  const logPath = options.logPath;
  const strictAllowlist = true;
  const foregroundPromptTimeoutMs = Math.max(1, settings.rpcPromptTimeoutSeconds) * 1000;

  let runtimeState: TelegramRuntimeState = loadRuntimeState(statePath);
  let pendingInbound: PendingInboundItem[] = loadInboundQueue(inboundQueuePath);
  let pendingOutbound: PendingOutboundItem[] = loadOutboundQueue(outboundQueuePath);
  let pendingBackground: PendingBackgroundItem[] = loadTelegramJobs(jobsPath);

  if (pendingBackground.length === 0) {
    const legacy = loadLegacyBackgroundQueue(legacyBackgroundQueuePath);
    if (legacy.length > 0) {
      pendingBackground = legacy.map((item) => ({
        id: item.id,
        chatId: item.chatId,
        userId: item.userId,
        messageId: item.messageId,
        messageThreadId: item.messageThreadId,
        sessionKey: item.sessionKey,
        sessionFile: item.sessionFile,
        promptText: item.promptText,
        createdAtMs: item.createdAtMs,
        startedAtMs: null,
        finishedAtMs: null,
        status: "queued",
      }));
      saveTelegramJobs(pendingBackground, jobsPath);
    }
  }

  let jobsRehydrated = false;
  pendingBackground = pendingBackground.map((job) => {
    if (job.status !== "running") return job;
    jobsRehydrated = true;
    return {
      ...job,
      status: "queued",
      startedAtMs: null,
      error: undefined,
    };
  });
  if (jobsRehydrated) {
    saveTelegramJobs(pendingBackground, jobsPath);
  }

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

  const activeBackgroundBySessionFile = new Set<string>();
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
    saveTelegramJobs(pendingBackground, jobsPath);
  };

  const withChatAction = async <T>(
    chatId: number,
    action: string,
    work: () => Promise<T>,
    messageThreadId?: number,
  ): Promise<T> => {
    if (!client) return await work();
    let timer: NodeJS.Timeout | null = null;
    const emitAction = async () => {
      try {
        await client.sendChatAction(chatId, action, { message_thread_id: messageThreadId });
      } catch {
        // Ignore chat action failures; they are non-critical.
      }
    };
    void emitAction();
    timer = setInterval(() => { void emitAction(); }, 4000);
    try {
      return await work();
    } finally {
      if (timer) clearInterval(timer);
    }
  };

  const withTypingIndicator = async <T>(chatId: number, work: () => Promise<T>, messageThreadId?: number): Promise<T> => {
    return await withChatAction(chatId, "typing", work, messageThreadId);
  };

  const sttProvider = options.sttProvider ?? createSttProvider({
    provider: settings.sttProvider,
    apiKeyEnv: settings.sttApiKeyEnv,
    endpoint: settings.sttEndpoint,
    model: settings.sttModel,
  });

  const transcribeInboundMedia = async (item: PendingInboundItem): Promise<string> => {
    if (!item.media) {
      throw new Error("No media payload available for transcription");
    }
    if (!client?.getFile) {
      throw new Error("Telegram media download support is unavailable in this worker build");
    }

    const file = await client.getFile(item.media.fileId);
    const filePath = String(file.file_path || "").trim();
    if (!filePath) {
      throw new Error("Telegram file metadata missing file_path");
    }

    const mediaBytes = await downloadTelegramFile(botToken, filePath);
    const mimeType = item.media.mimeType || "application/octet-stream";
    const extension = mimeType.includes("/") ? mimeType.split("/")[1] : "bin";
    const inferredName = item.media.fileName || `${item.media.kind}.${extension}`;

    return await sttProvider.transcribe(mediaBytes, mimeType, inferredName);
  };

  const downloadInboundImage = async (item: PendingInboundItem): Promise<{ data: string; mimeType: string }> => {
    if (!item.media) {
      throw new Error("No media payload available for image download");
    }
    if (!client?.getFile) {
      throw new Error("Telegram media download support is unavailable in this worker build");
    }

    // Retry getFile up to 3 times (matches openclaw pattern)
    let file: Awaited<ReturnType<NonNullable<TelegramApiLike["getFile"]>>>;
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        file = await client.getFile(item.media.fileId);
        lastError = undefined;
        break;
      } catch (err) {
        lastError = err;
        if (attempt < 2) await waitMs(500 * (attempt + 1));
      }
    }
    if (lastError) throw lastError;

    // Pre-download size check (File.file_size is optional - skip if undefined)
    if (typeof file!.file_size === "number" && file!.file_size >= IMAGE_MAX_FILE_SIZE) {
      throw new Error("Image is too large (over 5MB). Please send a smaller image.");
    }

    const filePath = String(file!.file_path || "").trim();
    if (!filePath) {
      throw new Error("Telegram file metadata missing file_path");
    }

    const mediaBytes = await downloadTelegramFile(botToken, filePath);

    // Post-download byte check
    if (mediaBytes.length >= IMAGE_MAX_FILE_SIZE) {
      throw new Error("Image is too large (over 5MB). Please send a smaller image.");
    }

    const data = Buffer.from(mediaBytes).toString("base64");
    const mimeType = item.media.mimeType || "image/jpeg";
    return { data, mimeType };
  };

  const formatTranscriptionFailureText = (error: unknown): string => {
    if (error instanceof SttApiKeyMissingError) {
      return `⚠️ Voice transcription is unavailable. Set ${error.envVar} for the Telegram worker and try again.`;
    }

    const message = String(
      error instanceof Error ? error.message : error || "Voice transcription failed",
    ).trim() || "Voice transcription failed";

    return `⚠️ Voice transcription failed: ${message}`;
  };

  const parseTtsCommandInput = (text: string): { matched: boolean; payload: string } => {
    const trimmed = String(text || "").trim();
    const match = trimmed.match(/^\/tts(?:\s+([\s\S]+))?$/i);
    if (!match) {
      return { matched: false, payload: "" };
    }

    return { matched: true, payload: String(match[1] || "").trim() };
  };

  const synthesizeTtsAudio = async (text: string): Promise<{ bytes: Uint8Array; mimeType: string; fileName: string }> => {
    const apiKey = (process.env.ELEVENLABS_API_KEY || "").trim();
    if (!apiKey) {
      throw new Error("ELEVENLABS_API_KEY is not set");
    }

    const voiceId = (process.env.ELEVENLABS_TTS_VOICE_ID || process.env.ELEVENLABS_VOICE_ID || DEFAULT_ELEVENLABS_TTS_VOICE_ID).trim();
    const endpoint = `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voiceId)}`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({
        text,
        model_id: DEFAULT_ELEVENLABS_TTS_MODEL_ID,
        output_format: "mp3_44100_128",
      }),
    });

    if (!response.ok) {
      let detail = "";
      try {
        detail = (await response.text()).trim();
      } catch {
        // ignore response parse errors
      }
      const suffix = detail ? `: ${detail.slice(0, 240)}` : "";
      throw new Error(`ElevenLabs TTS request failed (${response.status})${suffix}`);
    }

    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0) {
      throw new Error("ElevenLabs TTS response did not include audio bytes");
    }

    return {
      bytes,
      mimeType: "audio/mpeg",
      fileName: "tts.mp3",
    };
  };

  const sendTtsVoiceReply = async (
    item: PendingInboundItem,
    audio: { bytes: Uint8Array; mimeType: string; fileName: string },
  ): Promise<void> => {
    if (!client?.sendVoice && !client?.sendAudio) {
      throw new Error("Telegram voice delivery is unavailable in this worker build");
    }

    await withChatAction(item.chatId, "upload_voice", async () => {
      if (client.sendVoice) {
        await client.sendVoice(
          item.chatId,
          new InputFile(audio.bytes, audio.fileName),
          {
            message_thread_id: item.messageThreadId,
            ...replyParams(item.messageId),
          },
        );
        return;
      }
      if (client.sendAudio) {
        await client.sendAudio(
          item.chatId,
          new InputFile(audio.bytes, audio.fileName),
          {
            title: "rho /tts",
            message_thread_id: item.messageThreadId,
            ...replyParams(item.messageId),
          },
        );
        return;
      }
    }, item.messageThreadId);

    logEvent(
      "outbound_media_sent",
      {
        updateId: item.updateId,
        chatId: item.chatId,
        userId: item.userId,
        messageId: item.messageId,
        sessionKey: item.sessionKey,
        sessionFile: item.sessionFile,
      },
      {
        bytes: audio.bytes.length,
        mime_type: audio.mimeType,
      },
    );
  };

  const formatTtsFailureText = (rawMessage: string): string => {
    const message = String(rawMessage || "/tts failed").trim() || "/tts failed";

    if (/ELEVENLABS_API_KEY is not set/i.test(message)) {
      return "⚠️ /tts is unavailable. Set ELEVENLABS_API_KEY for the Telegram worker and try again.";
    }

    if (/usage: \/tts/i.test(message)) {
      return message;
    }

    return `⚠️ /tts failed: ${message}`;
  };

  const formatPromptFailureText = (inputText: string, rawMessage: string): string => {
    const message = String(rawMessage || "RPC prompt failed").trim() || "RPC prompt failed";
    const slashMapped = formatSlashPromptFailure(inputText, message);

    if (parseSlashInput(inputText).isSlash) {
      return `⚠️ ${slashMapped}`;
    }

    return `⚠️ Failed to run prompt: ${message}`;
  };

  const requireNonEmptyPromptResponse = (response: string): string => {
    const normalized = String(response || "").trim();
    if (!normalized) {
      throw new Error("RPC prompt returned an empty response");
    }
    return normalized;
  };

  const isPromptTimeoutError = (rawMessage: string): boolean => {
    const message = String(rawMessage || "");
    return /rpc prompt timed out/i.test(message);
  };

  const backgroundEligibleSlashCommands = new Set(["plan", "code", "sop"]);

  const shouldDeferPromptToBackground = (promptText: string, rawMessage: string): boolean => {
    if (!isPromptTimeoutError(rawMessage)) return false;

    const slash = parseSlashInput(promptText);
    if (!slash.isSlash) return true;

    return backgroundEligibleSlashCommands.has(slash.commandName);
  };

  const backgroundDeferAcknowledgement = "⏳ This is now running as a background job. I'll post updates here. Use /jobs to monitor or /cancel <job-id> to stop.";

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

  const parseJobsCommand = (text: string): { command: "jobs" | "job" | "cancel"; arg: string } | null => {
    const trimmed = String(text || "").trim();
    const match = trimmed.match(/^\/(jobs|job|cancel)(?:\s+(.+))?$/i);
    if (!match) return null;
    return {
      command: match[1]!.toLowerCase() as "jobs" | "job" | "cancel",
      arg: String(match[2] || "").trim(),
    };
  };

  const findJobById = (jobId: string): PendingBackgroundItem | null => {
    const normalized = String(jobId || "").trim();
    if (!normalized) return null;
    return pendingBackground.find((job) => job.id.toLowerCase() === normalized.toLowerCase()) ?? null;
  };

  const renderJobsListForChat = (chatId: number): string => {
    const jobs = pendingBackground
      .filter((job) => job.chatId === chatId)
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .slice(0, 10);

    if (jobs.length === 0) {
      return "No jobs for this chat yet.";
    }

    const statusEmoji: Record<TelegramJobRecord["status"], string> = {
      queued: "🕒",
      running: "🏃",
      completed: "✅",
      failed: "⚠️",
      cancelled: "🛑",
    };

    const lines = jobs.map((job) => {
      const ageSec = Math.max(0, Math.floor((Date.now() - job.createdAtMs) / 1000));
      return `${statusEmoji[job.status]} ${job.id} — ${job.status} — ${ageSec}s ago`;
    });

    return [`Jobs (latest ${jobs.length}):`, ...lines].join("\n");
  };

  const renderJobDetails = (job: PendingBackgroundItem): string => {
    const started = job.startedAtMs ? new Date(job.startedAtMs).toISOString() : "not started";
    const finished = job.finishedAtMs ? new Date(job.finishedAtMs).toISOString() : "not finished";
    const promptPreview = job.promptText.trim().replace(/\s+/g, " ").slice(0, 140);

    const lines = [
      `Job: ${job.id}`,
      `Status: ${job.status}`,
      `Created: ${new Date(job.createdAtMs).toISOString()}`,
      `Started: ${started}`,
      `Finished: ${finished}`,
      `Session: ${job.sessionFile}`,
      `Prompt: ${promptPreview || "(empty)"}`,
    ];

    if (job.error) lines.push(`Error: ${job.error}`);
    return lines.join("\n");
  };

  const cancelJob = (job: PendingBackgroundItem): { ok: boolean; text: string } => {
    if (job.status === "completed") {
      return { ok: false, text: `Job ${job.id} already completed.` };
    }
    if (job.status === "failed") {
      return { ok: false, text: `Job ${job.id} already failed.` };
    }
    if (job.status === "cancelled") {
      return { ok: false, text: `Job ${job.id} is already cancelled.` };
    }

    job.cancelRequestedAtMs = Date.now();
    job.finishedAtMs = Date.now();
    job.status = "cancelled";
    job.error = "Cancelled by user";

    if (job.startedAtMs && rpcRunner.cancelSession) {
      try {
        rpcRunner.cancelSession(job.sessionFile, `Job ${job.id} cancelled by user`);
      } catch {
        // ignore cancellation transport errors
      }
    }

    persistBackgroundQueue();
    return { ok: true, text: `🛑 Cancelled job ${job.id}.` };
  };

  const forkPromptToBackgroundJob = (item: PendingInboundItem, promptText: string): PendingBackgroundItem => {
    const jobId = createTelegramJobId();
    const rotated = resetSessionFile(item, mapPath, sessionDir);

    if (rpcRunner.cancelSession) {
      try {
        rpcRunner.cancelSession(item.sessionFile, `Foreground timeout; forked to job ${jobId}`);
      } catch {
        // ignore cancellation transport errors
      }
    }

    const queued: PendingBackgroundItem = {
      id: jobId,
      updateId: item.updateId,
      chatId: item.chatId,
      userId: item.userId,
      messageId: item.messageId,
      sessionKey: item.sessionKey,
      sessionFile: item.sessionFile,
      messageThreadId: item.messageThreadId,
      promptText,
      createdAtMs: Date.now(),
      startedAtMs: null,
      finishedAtMs: null,
      status: "queued",
      completionNotifiedAtMs: null,
      cancelRequestedAtMs: null,
    };

    pendingBackground.push(queued);
    persistBackgroundQueue();

    logEvent(
      "rpc_prompt_forked_job",
      {
        updateId: item.updateId,
        chatId: item.chatId,
        userId: item.userId,
        messageId: item.messageId,
        sessionKey: item.sessionKey,
        sessionFile: item.sessionFile,
      },
      {
        job_id: jobId,
        previous_session_file: rotated.previousSessionFile ?? item.sessionFile,
        new_session_file: rotated.sessionFile,
      },
    );

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
        if (item.status !== "queued") continue;
        if (activeBackgroundBySessionFile.has(item.sessionFile)) continue;

        activeBackgroundById.add(item.id);
        activeBackgroundBySessionFile.add(item.sessionFile);
        item.status = "running";
        item.startedAtMs = Date.now();
        item.finishedAtMs = null;
        item.error = undefined;
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
            job_id: item.id,
            timeout_ms: 0,
            prompt_preview: item.promptText.slice(0, 160),
          },
        );

        void (async () => {
          try {
            const rawResponse = await withTypingIndicator(
              item.chatId,
              () => rpcRunner.runPrompt(item.sessionFile, item.promptText, 0),
              item.messageThreadId,
            );
            const response = requireNonEmptyPromptResponse(rawResponse);
            if (item.status === "cancelled") {
              logEvent(
                "rpc_prompt_background_cancelled",
                {
                  updateId: item.updateId,
                  chatId: item.chatId,
                  userId: item.userId,
                  messageId: item.messageId,
                  sessionKey: item.sessionKey,
                  sessionFile: item.sessionFile,
                },
                {
                  job_id: item.id,
                  error: "Job completed after cancellation request; result discarded",
                },
              );
              return;
            }

            item.status = "completed";
            item.resultText = response;
            item.finishedAtMs = Date.now();

            if (!item.completionNotifiedAtMs) {
              pendingOutbound.push({
                chatId: item.chatId,
                replyToMessageId: item.messageId,
                messageThreadId: item.messageThreadId,
                text: `✅ Job ${item.id} finished.\n\n${response}`,
                attempts: 0,
                notBeforeMs: 0,
              });
              item.completionNotifiedAtMs = Date.now();
            }

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
                job_id: item.id,
                response_length: response.length,
              },
            );
          } catch (error) {
            const msg = (error as Error)?.message || String(error);
            item.finishedAtMs = Date.now();

            if (item.status === "cancelled") {
              logEvent(
                "rpc_prompt_background_cancelled",
                {
                  updateId: item.updateId,
                  chatId: item.chatId,
                  userId: item.userId,
                  messageId: item.messageId,
                  sessionKey: item.sessionKey,
                  sessionFile: item.sessionFile,
                },
                {
                  job_id: item.id,
                  error: msg,
                },
              );
            } else {
              item.status = "failed";
              item.error = msg;
              if (!item.completionNotifiedAtMs) {
                pendingOutbound.push({
                  chatId: item.chatId,
                  replyToMessageId: item.messageId,
                  messageThreadId: item.messageThreadId,
                  text: `⚠️ Job ${item.id} failed.\n\n${formatPromptFailureText(item.promptText, msg)}`,
                  attempts: 0,
                  notBeforeMs: 0,
                });
                item.completionNotifiedAtMs = Date.now();
              }
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
                  job_id: item.id,
                  error: msg,
                },
              );
            }
          } finally {
            activeBackgroundById.delete(item.id);
            activeBackgroundBySessionFile.delete(item.sessionFile);
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
        if (activeBackgroundBySessionFile.has(item.sessionFile)) {
          deferred.push(item);
          continue;
        }

        if (item.media && isImageMediaKind(item.media.kind)) {
          // IMAGE PATH: download -> base64 -> runPrompt with images
          let imagePayload: { data: string; mimeType: string } | null = null;
          try {
            imagePayload = await withTypingIndicator(item.chatId, () => downloadInboundImage(item), item.messageThreadId);
            logEvent(
              "inbound_image_downloaded",
              {
                updateId: item.updateId,
                chatId: item.chatId,
                userId: item.userId,
                messageId: item.messageId,
                sessionKey: item.sessionKey,
                sessionFile: item.sessionFile,
              },
              {
                media_kind: item.media.kind,
                mime_type: imagePayload.mimeType,
                base64_length: imagePayload.data.length,
              },
            );
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            pendingOutbound.push({
              chatId: item.chatId,
              replyToMessageId: item.messageId,
              messageThreadId: item.messageThreadId,
              text: `⚠️ Failed to download image: ${msg}`,
              attempts: 0,
              notBeforeMs: 0,
            });
            logEvent(
              "inbound_image_download_error",
              {
                updateId: item.updateId,
                chatId: item.chatId,
                userId: item.userId,
                messageId: item.messageId,
                sessionKey: item.sessionKey,
                sessionFile: item.sessionFile,
              },
              {
                media_kind: item.media.kind,
                error: msg,
              },
            );
            persistOutboundQueue();
            continue;
          }

          const promptText = item.text || "Describe this image.";
          const images = [{ type: "image" as const, data: imagePayload.data, mimeType: imagePayload.mimeType }];
          try {
            const rawResponse = await withTypingIndicator(
              item.chatId,
              () => rpcRunner.runPrompt(item.sessionFile, prefixPrompt(item, promptText), foregroundPromptTimeoutMs, images),
              item.messageThreadId,
            );
            const response = requireNonEmptyPromptResponse(rawResponse);
            pendingOutbound.push({
              chatId: item.chatId,
              replyToMessageId: item.messageId,
              messageThreadId: item.messageThreadId,
              text: response,
              attempts: 0,
              notBeforeMs: 0,
            });
            logEvent(
              "inbound_image_prompt_ok",
              {
                updateId: item.updateId,
                chatId: item.chatId,
                userId: item.userId,
                messageId: item.messageId,
                sessionKey: item.sessionKey,
                sessionFile: item.sessionFile,
              },
              {
                media_kind: item.media.kind,
                prompt_length: promptText.length,
                response_length: response.length,
              },
            );
          } catch (error) {
            // NO background deferral for images - on timeout, return error asking to retry
            const msg = (error as Error)?.message || String(error);
            pendingOutbound.push({
              chatId: item.chatId,
              replyToMessageId: item.messageId,
              messageThreadId: item.messageThreadId,
              text: formatPromptFailureText(promptText, msg),
              attempts: 0,
              notBeforeMs: 0,
            });
            logEvent(
              "inbound_image_prompt_error",
              {
                updateId: item.updateId,
                chatId: item.chatId,
                userId: item.userId,
                messageId: item.messageId,
                sessionKey: item.sessionKey,
                sessionFile: item.sessionFile,
              },
              {
                media_kind: item.media.kind,
                error: msg,
              },
            );
          }

          persistOutboundQueue();
          continue;
        }

        if (item.media) {
          // AUDIO/STT PATH: existing transcription flow unchanged
          let transcript = "";
          try {
            transcript = await withTypingIndicator(item.chatId, () => transcribeInboundMedia(item), item.messageThreadId);
            logEvent(
              "inbound_media_transcribed",
              {
                updateId: item.updateId,
                chatId: item.chatId,
                userId: item.userId,
                messageId: item.messageId,
                sessionKey: item.sessionKey,
                sessionFile: item.sessionFile,
              },
              {
                media_kind: item.media.kind,
                transcript_length: transcript.length,
              },
            );
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            pendingOutbound.push({
              chatId: item.chatId,
              replyToMessageId: item.messageId,
              messageThreadId: item.messageThreadId,
              text: formatTranscriptionFailureText(msg),
              attempts: 0,
              notBeforeMs: 0,
            });
            logEvent(
              "inbound_media_transcription_error",
              {
                updateId: item.updateId,
                chatId: item.chatId,
                userId: item.userId,
                messageId: item.messageId,
                sessionKey: item.sessionKey,
                sessionFile: item.sessionFile,
              },
              {
                media_kind: item.media.kind,
                error: error instanceof Error ? error.message : String(error),
              },
            );
            persistOutboundQueue();
            continue;
          }

          const promptText = transcript;
          try {
            const rawResponse = await withTypingIndicator(
              item.chatId,
              () => rpcRunner.runPrompt(item.sessionFile, prefixPrompt(item, promptText), foregroundPromptTimeoutMs),
              item.messageThreadId,
            );
            const response = requireNonEmptyPromptResponse(rawResponse);
            pendingOutbound.push({
              chatId: item.chatId,
              replyToMessageId: item.messageId,
              messageThreadId: item.messageThreadId,
              text: response,
              attempts: 0,
              notBeforeMs: 0,
            });
            logEvent(
              "inbound_media_prompt_ok",
              {
                updateId: item.updateId,
                chatId: item.chatId,
                userId: item.userId,
                messageId: item.messageId,
                sessionKey: item.sessionKey,
                sessionFile: item.sessionFile,
              },
              {
                media_kind: item.media.kind,
                transcript_length: transcript.length,
                response_length: response.length,
              },
            );
          } catch (error) {
            const msg = (error as Error)?.message || String(error);
            if (shouldDeferPromptToBackground(promptText, msg)) {
              const queued = forkPromptToBackgroundJob(item, prefixPrompt(item, promptText));
              pendingOutbound.push({
                chatId: item.chatId,
                replyToMessageId: item.messageId,
                messageThreadId: item.messageThreadId,
                text: `${backgroundDeferAcknowledgement}\nJob ID: ${queued.id}`,
                attempts: 0,
                notBeforeMs: 0,
              });
              logEvent(
                "inbound_media_prompt_deferred_background",
                {
                  updateId: item.updateId,
                  chatId: item.chatId,
                  userId: item.userId,
                  messageId: item.messageId,
                  sessionKey: item.sessionKey,
                  sessionFile: item.sessionFile,
                },
                {
                  media_kind: item.media.kind,
                  transcript_length: transcript.length,
                  job_id: queued.id,
                  timeout_ms: foregroundPromptTimeoutMs,
                  error: msg,
                },
              );
              void pumpBackgroundQueue();
            } else {
              pendingOutbound.push({
                chatId: item.chatId,
                replyToMessageId: item.messageId,
                messageThreadId: item.messageThreadId,
                text: formatPromptFailureText(promptText, msg),
                attempts: 0,
                notBeforeMs: 0,
              });
              logEvent(
                "inbound_media_prompt_error",
                {
                  updateId: item.updateId,
                  chatId: item.chatId,
                  userId: item.userId,
                  messageId: item.messageId,
                  sessionKey: item.sessionKey,
                  sessionFile: item.sessionFile,
                },
                {
                  media_kind: item.media.kind,
                  transcript_length: transcript.length,
                  error: msg,
                },
              );
            }
          }

          persistOutboundQueue();
          continue;
        }

        const promptText = normalizeSlashMention(item.text);

        const jobsCommand = parseJobsCommand(promptText);
        if (jobsCommand) {
          if (jobsCommand.command === "jobs") {
            pendingOutbound.push({
              chatId: item.chatId,
              replyToMessageId: item.messageId,
              messageThreadId: item.messageThreadId,
              text: renderJobsListForChat(item.chatId),
              attempts: 0,
              notBeforeMs: 0,
            });
            persistOutboundQueue();
            continue;
          }

          if (jobsCommand.command === "job") {
            if (!jobsCommand.arg) {
              pendingOutbound.push({
                chatId: item.chatId,
                replyToMessageId: item.messageId,
                messageThreadId: item.messageThreadId,
                text: "Usage: /job <job-id>",
                attempts: 0,
                notBeforeMs: 0,
              });
              persistOutboundQueue();
              continue;
            }

            const job = findJobById(jobsCommand.arg);
            if (!job || job.chatId !== item.chatId) {
              pendingOutbound.push({
                chatId: item.chatId,
                replyToMessageId: item.messageId,
                messageThreadId: item.messageThreadId,
                text: `Job not found: ${jobsCommand.arg}`,
                attempts: 0,
                notBeforeMs: 0,
              });
              persistOutboundQueue();
              continue;
            }

            pendingOutbound.push({
              chatId: item.chatId,
              replyToMessageId: item.messageId,
              messageThreadId: item.messageThreadId,
              text: renderJobDetails(job),
              attempts: 0,
              notBeforeMs: 0,
            });
            persistOutboundQueue();
            continue;
          }

          if (jobsCommand.command === "cancel") {
            if (!jobsCommand.arg) {
              pendingOutbound.push({
                chatId: item.chatId,
                replyToMessageId: item.messageId,
                messageThreadId: item.messageThreadId,
                text: "Usage: /cancel <job-id>",
                attempts: 0,
                notBeforeMs: 0,
              });
              persistOutboundQueue();
              continue;
            }

            const job = findJobById(jobsCommand.arg);
            if (!job || job.chatId !== item.chatId) {
              pendingOutbound.push({
                chatId: item.chatId,
                replyToMessageId: item.messageId,
                messageThreadId: item.messageThreadId,
                text: `Job not found: ${jobsCommand.arg}`,
                attempts: 0,
                notBeforeMs: 0,
              });
              persistOutboundQueue();
              continue;
            }

            const cancelled = cancelJob(job);
            pendingOutbound.push({
              chatId: item.chatId,
              replyToMessageId: item.messageId,
              messageThreadId: item.messageThreadId,
              text: cancelled.text,
              attempts: 0,
              notBeforeMs: 0,
            });
            persistOutboundQueue();
            continue;
          }
        }

        const ttsCommand = parseTtsCommandInput(promptText);

        if (ttsCommand.matched) {
          if (!ttsCommand.payload) {
            pendingOutbound.push({
              chatId: item.chatId,
              replyToMessageId: item.messageId,
              messageThreadId: item.messageThreadId,
              text: "⚠️ Usage: /tts <text>",
              attempts: 0,
              notBeforeMs: 0,
            });
            persistOutboundQueue();
            continue;
          }

          try {
            const audio = await withChatAction(item.chatId, "record_voice", () => synthesizeTtsAudio(ttsCommand.payload), item.messageThreadId);
            await sendTtsVoiceReply(item, audio);

            logEvent(
              "tts_ok",
              {
                updateId: item.updateId,
                chatId: item.chatId,
                userId: item.userId,
                messageId: item.messageId,
                sessionKey: item.sessionKey,
                sessionFile: item.sessionFile,
              },
              {
                text_length: ttsCommand.payload.length,
                audio_bytes: audio.bytes.length,
              },
            );
          } catch (error) {
            const msg = (error as Error)?.message || String(error);
            pendingOutbound.push({
              chatId: item.chatId,
              replyToMessageId: item.messageId,
              messageThreadId: item.messageThreadId,
              text: formatTtsFailureText(msg),
              attempts: 0,
              notBeforeMs: 0,
            });
            logEvent(
              "tts_error",
              {
                updateId: item.updateId,
                chatId: item.chatId,
                userId: item.userId,
                messageId: item.messageId,
                sessionKey: item.sessionKey,
                sessionFile: item.sessionFile,
              },
              {
                text_length: ttsCommand.payload.length,
                error: msg,
              },
            );
            persistOutboundQueue();
          }

          continue;
        }

        try {
          const rawResponse = await withTypingIndicator(
            item.chatId,
            () => rpcRunner.runPrompt(item.sessionFile, prefixPrompt(item, promptText), foregroundPromptTimeoutMs),
            item.messageThreadId,
          );
          const response = requireNonEmptyPromptResponse(rawResponse);
          pendingOutbound.push({
            chatId: item.chatId,
            replyToMessageId: item.messageId,
            messageThreadId: item.messageThreadId,
            text: response,
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
            const queued = forkPromptToBackgroundJob(item, prefixPrompt(item, promptText));
            pendingOutbound.push({
              chatId: item.chatId,
              replyToMessageId: item.messageId,
              messageThreadId: item.messageThreadId,
              text: `${backgroundDeferAcknowledgement}\nJob ID: ${queued.id}`,
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
                job_id: queued.id,
                timeout_ms: foregroundPromptTimeoutMs,
                error: msg,
              },
            );
            void pumpBackgroundQueue();
          } else {
            pendingOutbound.push({
              chatId: item.chatId,
              replyToMessageId: item.messageId,
              messageThreadId: item.messageThreadId,
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
      let requeued = false;

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
            pendingOutbound[index] = {
              ...item,
              attempts: item.attempts + 1,
              notBeforeMs: Date.now() + delay,
            };
            persistOutboundQueue();
            requeued = true;
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

      if (requeued) {
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

        // Strip thread context when threaded mode is disabled
        if (!settings.threadedMode) {
          envelope.messageThreadId = undefined;
        }

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
                await client.sendMessage(
                  envelope.chatId,
                  `🔒 Access request received. Share this PIN with the operator to approve: ${pending.request.pin}`,
                  {
                    message_thread_id: envelope.messageThreadId,
                    ...replyParams(envelope.messageId),
                  },
                );
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
            messageThreadId: envelope.messageThreadId,
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

      const jobSummary = summarizeTelegramJobs(pendingBackground);
      logEvent("poll_ok", {}, {
        updates: updates.length,
        accepted,
        blocked,
        last_update_id: runtimeState.last_update_id,
        poll_failures: runtimeState.consecutive_failures,
        send_failures: consecutiveSendFailures,
        background_pending: jobSummary.queued + jobSummary.running,
        jobs_queued: jobSummary.queued,
        jobs_running: jobSummary.running,
        jobs_total: jobSummary.total,
      });

      if (!silent) {
        // no-op (worker has no UI)
      }

      return { ok: true, updates: updates.length, accepted, blocked };
    } catch (error) {
      runtimeState = markPollFailure(runtimeState);
      persistRuntimeState();
      const msg = (error instanceof GrammyError || error instanceof HttpError) ? error.message : (error as Error)?.message || String(error);
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
    checkOptions?: { requesterPid?: number | null; silent?: boolean },
  ) => {
    const result = await pollOnce(checkOptions?.silent ?? source === "trigger");
    logEvent("operator_check_executed", {}, {
      check_source: source,
      requester_pid: checkOptions?.requesterPid ?? null,
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

  const getSnapshot = (): TelegramWorkerSnapshot => {
    const jobs = summarizeTelegramJobs(pendingBackground);
    return {
      runtimeState,
      pendingInbound: pendingInbound.length,
      pendingOutbound: pendingOutbound.length,
      pendingBackground: jobs.queued + jobs.running,
      pendingJobs: jobs.queued,
      runningJobs: jobs.running,
      sendFailures: consecutiveSendFailures,
      lastCheckConsumeAt,
      lastCheckOutcome,
      lastCheckRequesterPid,
    };
  };

  const dispose = () => {
    disposed = true;
    activeBackgroundById.clear();
    activeBackgroundBySessionFile.clear();
    rpcRunner.dispose();
  };

  return {
    pollOnce,
    handleCheckTrigger,
    getSnapshot,
    dispose,
  };
}
