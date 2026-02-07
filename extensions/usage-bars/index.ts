/**
 * Usage Extension - Minimal API usage indicator for pi
 *
 * Shows Codex (OpenAI) and Anthropic (Claude) API usage as
 * color-coded percentages in the footer status bar. Polls OAuth
 * APIs using tokens from ~/.pi/agent/auth.json.
 *
 * Only shows usage for the currently active provider.
 *
 * Inspired by steipete/CodexBar.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const AUTH_FILE = path.join(os.homedir(), ".pi", "agent", "auth.json");
const POLL_INTERVAL_MS = 2 * 60 * 1000;


interface AuthData {
  "openai-codex"?: { access?: string; refresh?: string };
  anthropic?: { access?: string; refresh?: string };
}

interface CodexUsage {
  plan_type?: string;
  rate_limit?: {
    primary_window?: { used_percent: number; reset_after_seconds: number };
    secondary_window?: { used_percent: number; reset_after_seconds: number };
  };
}

interface ClaudeUsage {
  five_hour?: { utilization: number; resets_at: string };
  seven_day?: { utilization: number; resets_at: string };
  extra_usage?: { is_enabled: boolean; monthly_limit: number; used_credits: number };
}

interface UsageState {
  codex: { session: number; weekly: number; error?: string } | null;
  claude: { session: number; weekly: number; extraSpend?: number; extraLimit?: number; error?: string } | null;
  lastPoll: number;
  activeProvider: "codex" | "claude" | null;
}

function readAuth(): AuthData | null {
  try {
    return JSON.parse(fs.readFileSync(AUTH_FILE, "utf-8"));
  } catch {
    return null;
  }
}

async function fetchCodexUsage(token: string): Promise<UsageState["codex"]> {
  try {
    const res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return { session: 0, weekly: 0, error: `HTTP ${res.status}` };
    const data = (await res.json()) as CodexUsage;
    return {
      session: data.rate_limit?.primary_window?.used_percent ?? 0,
      weekly: data.rate_limit?.secondary_window?.used_percent ?? 0,
    };
  } catch (e) {
    return { session: 0, weekly: 0, error: String(e) };
  }
}

async function fetchClaudeUsage(token: string): Promise<UsageState["claude"]> {
  try {
    const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${token}`,
        "anthropic-beta": "oauth-2025-04-20",
      },
    });
    if (!res.ok) return { session: 0, weekly: 0, error: `HTTP ${res.status}` };
    const data = (await res.json()) as ClaudeUsage;
    const result: NonNullable<UsageState["claude"]> = {
      session: data.five_hour?.utilization ?? 0,
      weekly: data.seven_day?.utilization ?? 0,
    };
    if (data.extra_usage?.is_enabled) {
      result.extraSpend = data.extra_usage.used_credits;
      result.extraLimit = data.extra_usage.monthly_limit;
    }
    return result;
  } catch (e) {
    return { session: 0, weekly: 0, error: String(e) };
  }
}

function detectProvider(model: { provider?: string; id?: string; name?: string; api?: string } | string | undefined | null): "codex" | "claude" | null {
  if (!model) return null;
  if (typeof model === "string") {
    const id = model.toLowerCase();
    if (id.includes("claude")) return "claude";
    if (id.includes("gpt") || id.includes("codex")) return "codex";
    return null;
  }

  const p = (model.provider || "").toLowerCase();
  const id = (model.id || "").toLowerCase();
  const name = (model.name || "").toLowerCase();
  const api = (model.api || "").toLowerCase();

  // Claude/Anthropic detection first
  if (p.includes("anthropic") || api.includes("anthropic") || id.includes("claude") || name.includes("claude")) return "claude";

  // Codex/OpenAI detection
  if (
    p.includes("openai") ||
    p.includes("codex") ||
    api.includes("openai") ||
    api.includes("codex") ||
    id.includes("gpt") ||
    id.includes("codex") ||
    name.includes("gpt") ||
    name.includes("codex")
  ) {
    return "codex";
  }

  // Google/antigravity routing Claude through Gemini
  if ((p.includes("google") || p.includes("antigravity")) && (id.includes("claude") || name.includes("claude"))) {
    return "claude";
  }

  return null;
}

export default function (pi: ExtensionAPI) {
  const state: UsageState = { codex: null, claude: null, lastPoll: 0, activeProvider: null };
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let ctx: any = null;

  async function poll() {
    const auth = readAuth();
    if (!auth) return;
    const active = state.activeProvider;
    if (active === "codex" && auth["openai-codex"]?.access) {
      state.codex = await fetchCodexUsage(auth["openai-codex"].access);
    } else if (active === "claude" && auth.anthropic?.access) {
      state.claude = await fetchClaudeUsage(auth.anthropic.access);
    }
    state.lastPoll = Date.now();
    updateStatus();
  }

  function updateStatus() {
    const active = state.activeProvider;
    const data = active === "codex" ? state.codex : active === "claude" ? state.claude : null;
    // Emit for custom footer consumption
    if (data && !data.error) {
      pi.events.emit("usage:update", { session: data.session, weekly: data.weekly });
    }
  }

  function updateProviderFrom(modelLike: any): boolean {
    const prev = state.activeProvider;
    state.activeProvider = detectProvider(modelLike);
    if (prev !== state.activeProvider) {
      updateStatus();
      return true;
    }
    return false;
  }

  pi.on("session_start", async (_event, _ctx) => {
    ctx = _ctx;
    updateProviderFrom(_ctx.model);
    await poll();
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => poll(), POLL_INTERVAL_MS);
  });

  pi.on("session_shutdown", async () => {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  });

  pi.on("turn_start", async (_event, _ctx) => {
    ctx = _ctx;
    updateProviderFrom(_ctx.model);
  });

  pi.on("model_select", async (event, _ctx) => {
    ctx = _ctx;
    const changed = updateProviderFrom(event.model ?? _ctx.model);
    if (changed) await poll();
  });

  pi.registerCommand("usage", {
    description: "Refresh API usage bars",
    handler: async (_args, _ctx) => {
      ctx = _ctx;
      updateProviderFrom(_ctx.model);
      await poll();
      _ctx.ui.notify("Usage refreshed", "info");
    },
  });
}
