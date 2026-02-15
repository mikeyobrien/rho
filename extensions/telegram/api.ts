export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  username?: string;
  first_name?: string;
  last_name?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
  title?: string;
  username?: string;
}

export interface TelegramVoice {
  file_id: string;
  duration: number;
  mime_type?: string;
  file_size?: number;
}

export interface TelegramAudio {
  file_id: string;
  duration: number;
  mime_type?: string;
  file_name?: string;
  title?: string;
  performer?: string;
  file_size?: number;
}

export interface TelegramDocument {
  file_id: string;
  mime_type?: string;
  file_name?: string;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  voice?: TelegramVoice;
  audio?: TelegramAudio;
  document?: TelegramDocument;
  reply_to_message?: TelegramMessage;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
}

export interface TelegramFile {
  file_id: string;
  file_unique_id?: string;
  file_size?: number;
  file_path?: string;
}

interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number };
}

export interface GetUpdatesParams {
  offset?: number;
  timeout?: number;
  allowed_updates?: string[];
}

export interface GetFileParams {
  file_id: string;
}

export interface SendMessageParams {
  chat_id: number;
  text: string;
  parse_mode?: "HTML" | "MarkdownV2";
  reply_to_message_id?: number;
  disable_web_page_preview?: boolean;
}

export interface SendChatActionParams {
  chat_id: number;
  action: "typing" | "upload_photo" | "record_video" | "upload_video" | "record_voice" | "upload_voice" | "upload_document" | "choose_sticker" | "find_location" | "record_video_note" | "upload_video_note";
}

export type TelegramUpload = string | Blob | Uint8Array | ArrayBuffer;

type TelegramParseMode = "HTML" | "MarkdownV2";

interface TelegramSendMediaBase {
  chat_id: number;
  caption?: string;
  parse_mode?: TelegramParseMode;
  reply_to_message_id?: number;
  duration?: number;
  filename?: string;
  mimeType?: string;
}

export interface SendVoiceParams extends TelegramSendMediaBase {
  voice: TelegramUpload;
}

export interface SendAudioParams extends TelegramSendMediaBase {
  audio: TelegramUpload;
  performer?: string;
  title?: string;
}

export class TelegramApiError extends Error {
  public readonly status: number;
  public readonly retryAfterSeconds?: number;

  constructor(message: string, status: number, retryAfterSeconds?: number) {
    super(message);
    this.name = "TelegramApiError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class TelegramClient {
  private readonly baseUrl: string;
  private readonly fileBaseUrl: string;

  constructor(token: string, baseUrl = "https://api.telegram.org") {
    const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
    this.baseUrl = `${normalizedBaseUrl}/bot${token}`;
    this.fileBaseUrl = `${normalizedBaseUrl}/file/bot${token}`;
  }

  async getUpdates(params: GetUpdatesParams): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>("getUpdates", {
      offset: params.offset,
      timeout: params.timeout,
      allowed_updates: params.allowed_updates,
    });
  }

  async getFile(params: GetFileParams): Promise<TelegramFile> {
    return this.call<TelegramFile>("getFile", params);
  }

  async downloadFile(filePath: string): Promise<Uint8Array> {
    const normalizedPath = String(filePath || "").replace(/^\/+/, "");
    if (!normalizedPath) {
      throw new TelegramApiError("Telegram downloadFile failed: file_path is required", 400);
    }

    const response = await fetch(`${this.fileBaseUrl}/${normalizedPath}`);
    if (!response.ok) {
      throw new TelegramApiError(`Telegram downloadFile failed with status ${response.status}`, response.status || 500);
    }

    return new Uint8Array(await response.arrayBuffer());
  }

  async sendMessage(params: SendMessageParams): Promise<TelegramMessage> {
    return this.call<TelegramMessage>("sendMessage", params);
  }

  async sendChatAction(params: SendChatActionParams): Promise<boolean> {
    return this.call<boolean>("sendChatAction", params);
  }

  async sendVoice(params: SendVoiceParams): Promise<TelegramMessage> {
    const form = this.createBaseMediaForm(params);
    this.appendUpload(form, "voice", params.voice, params.filename ?? "voice.ogg", params.mimeType);
    return this.callMultipart<TelegramMessage>("sendVoice", form);
  }

  async sendAudio(params: SendAudioParams): Promise<TelegramMessage> {
    const form = this.createBaseMediaForm(params);
    this.appendUpload(form, "audio", params.audio, params.filename ?? "audio.mp3", params.mimeType);
    if (typeof params.performer === "string" && params.performer.length > 0) {
      form.append("performer", params.performer);
    }
    if (typeof params.title === "string" && params.title.length > 0) {
      form.append("title", params.title);
    }
    return this.callMultipart<TelegramMessage>("sendAudio", form);
  }

  private createBaseMediaForm(params: TelegramSendMediaBase): FormData {
    const form = new FormData();
    form.append("chat_id", String(params.chat_id));

    if (typeof params.caption === "string") form.append("caption", params.caption);
    if (typeof params.parse_mode === "string") form.append("parse_mode", params.parse_mode);
    if (typeof params.reply_to_message_id === "number") form.append("reply_to_message_id", String(params.reply_to_message_id));
    if (typeof params.duration === "number") form.append("duration", String(params.duration));

    return form;
  }

  private appendUpload(form: FormData, fieldName: string, value: TelegramUpload, filename: string, mimeType?: string): void {
    if (typeof value === "string") {
      form.append(fieldName, value);
      return;
    }

    let blob: Blob;
    if (value instanceof Blob) {
      blob = value;
    } else if (value instanceof Uint8Array) {
      blob = new Blob([value as BlobPart], { type: mimeType ?? "application/octet-stream" });
    } else {
      blob = new Blob([value], { type: mimeType ?? "application/octet-stream" });
    }

    form.append(fieldName, blob, filename);
  }

  private async call<T>(method: string, body: Record<string, unknown> | object): Promise<T> {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    return this.parseJsonResponse<T>(response, method);
  }

  private async callMultipart<T>(method: string, body: FormData): Promise<T> {
    const response = await fetch(`${this.baseUrl}/${method}`, {
      method: "POST",
      body,
    });

    return this.parseJsonResponse<T>(response, method);
  }

  private async parseJsonResponse<T>(response: Response, method: string): Promise<T> {
    let json: TelegramApiResponse<T> | null = null;
    try {
      json = (await response.json()) as TelegramApiResponse<T>;
    } catch {
      throw new TelegramApiError(`Telegram ${method} failed: invalid JSON response`, response.status || 500);
    }

    if (!response.ok || !json.ok || json.result === undefined) {
      const retryAfter = json.parameters?.retry_after;
      const msg = json.description || `Telegram ${method} failed with status ${response.status}`;
      throw new TelegramApiError(msg, response.status || json.error_code || 500, retryAfter);
    }

    return json.result;
  }
}

export function isTelegramParseModeError(error: unknown): boolean {
  if (!(error instanceof TelegramApiError)) return false;
  if (error.status === 429 || error.status >= 500) return false;

  const message = String(error.message || "").toLowerCase();
  return (
    message.includes("can't parse entities")
    || message.includes("can't find end of")
    || message.includes("unsupported start tag")
    || message.includes("entity")
  );
}
