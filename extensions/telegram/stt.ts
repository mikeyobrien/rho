export interface SttProvider {
  /** Transcribe audio bytes into text. */
  transcribe(audio: Uint8Array, mimeType: string, fileName: string): Promise<string>;
}

export interface SttProviderConfig {
  provider: "elevenlabs" | "openai";
  apiKeyEnv: string;
  endpoint?: string;
  model?: string;
}

export function extractTranscriptText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const candidate = payload as Record<string, unknown>;

  const directText = typeof candidate.text === "string" ? candidate.text.trim() : "";
  if (directText) return directText;

  const directTranscript = typeof candidate.transcript === "string" ? candidate.transcript.trim() : "";
  if (directTranscript) return directTranscript;

  const nestedResult = candidate.result;
  if (nestedResult && typeof nestedResult === "object") {
    const resultText = typeof (nestedResult as Record<string, unknown>).text === "string"
      ? ((nestedResult as Record<string, unknown>).text as string).trim()
      : "";
    if (resultText) return resultText;
  }

  const nestedData = candidate.data;
  if (nestedData && typeof nestedData === "object") {
    const dataText = typeof (nestedData as Record<string, unknown>).text === "string"
      ? ((nestedData as Record<string, unknown>).text as string).trim()
      : "";
    if (dataText) return dataText;
  }

  return "";
}

class ElevenLabsSttProvider implements SttProvider {
  private apiKeyEnv: string;
  private model: string;

  constructor(config: SttProviderConfig) {
    this.apiKeyEnv = config.apiKeyEnv;
    this.model = config.model || "scribe_v1";
  }

  async transcribe(audio: Uint8Array, mimeType: string, fileName: string): Promise<string> {
    const apiKey = (process.env[this.apiKeyEnv] || "").trim();
    if (!apiKey) {
      throw new Error(`${this.apiKeyEnv} is not set`);
    }

    const form = new FormData();
    form.append("model_id", this.model);
    form.append("file", new Blob([audio], { type: mimeType }), fileName);

    const response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body: form,
    });

    if (!response.ok) {
      let detail = "";
      try {
        detail = (await response.text()).trim();
      } catch {
        // ignore response body parse errors
      }
      const suffix = detail ? `: ${detail.slice(0, 240)}` : "";
      throw new Error(`ElevenLabs STT request failed (${response.status})${suffix}`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("ElevenLabs STT response was not valid JSON");
    }

    const transcript = extractTranscriptText(payload);
    if (!transcript) {
      throw new Error("ElevenLabs STT response did not include transcript text");
    }

    return transcript;
  }
}

class OpenAiSttProvider implements SttProvider {
  private apiKeyEnv: string;
  private baseUrl: string;
  private model: string;

  constructor(config: SttProviderConfig) {
    this.apiKeyEnv = config.apiKeyEnv;
    this.baseUrl = (config.endpoint || "https://api.openai.com").replace(/\/+$/, "");
    this.model = config.model || "whisper-1";
  }

  async transcribe(audio: Uint8Array, mimeType: string, fileName: string): Promise<string> {
    const apiKey = (process.env[this.apiKeyEnv] || "").trim();
    if (!apiKey) {
      throw new Error(`${this.apiKeyEnv} is not set`);
    }

    const form = new FormData();
    form.append("model", this.model);
    form.append("file", new Blob([audio], { type: mimeType }), fileName);

    const url = `${this.baseUrl}/v1/audio/transcriptions`;
    const response = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });

    if (!response.ok) {
      let detail = "";
      try {
        detail = (await response.text()).trim();
      } catch {
        // ignore response body parse errors
      }
      const suffix = detail ? `: ${detail.slice(0, 240)}` : "";
      throw new Error(`OpenAI STT request failed (${response.status})${suffix}`);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error("OpenAI STT response was not valid JSON");
    }

    const transcript = extractTranscriptText(payload);
    if (!transcript) {
      throw new Error("OpenAI STT response did not include transcript text");
    }

    return transcript;
  }
}

export function createSttProvider(config: SttProviderConfig): SttProvider {
  switch (config.provider) {
    case "elevenlabs":
      return new ElevenLabsSttProvider(config);
    case "openai":
      return new OpenAiSttProvider(config);
    default:
      throw new Error(`Unknown STT provider: ${(config as SttProviderConfig).provider}`);
  }
}
