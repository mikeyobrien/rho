/**
 * Usage Bars Extension - CodexBar-style usage widget for pi
 *
 * Shows Codex (OpenAI) and Anthropic (Claude) API usage bars
 * as a persistent widget above the editor. Polls OAuth APIs
 * using tokens from ~/.pi/agent/auth.json.
 *
 * Only shows the bar for the currently active provider.
 *
 * Inspired by steipete/CodexBar.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const AUTH_FILE = path.join(os.homedir(), ".pi", "agent", "auth.json");
const POLL_INTERVAL_MS = 2 * 60 * 1000;
const BAR_WIDTH = 20;

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

function renderBar(pct: number, width: number, fillFn: (s: string) => string, emptyFn: (s: string) => string): string {
  const filled = Math.round((pct / 100) * width);
  const empty = width - filled;
  return fillFn("█".repeat(filled)) + emptyFn("░".repeat(empty));
}

function barColor(pct: number, theme: any): (s: string) => string {
  if (pct >= 80) return (s: string) => theme.fg("error", s);
  if (pct >= 50) return (s: string) => theme.fg("warning", s);
  return (s: string) => theme.fg("success", s);
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
    // Only fetch usage for the active provider
    if (active === "codex" && auth["openai-codex"]?.access) {
      state.codex = await fetchCodexUsage(auth["openai-codex"].access);
    } else if (active === "claude" && auth.anthropic?.access) {
      state.claude = await fetchClaudeUsage(auth.anthropic.access);
    }
    state.lastPoll = Date.now();
    updateWidget();
  }

  function updateWidget() {
    if (ctx) {
      ctx.ui.setWidget("usage-bars", (_tui: any, theme: any) => ({
        render: (width: number) => renderWidget(theme, width),
        invalidate: () => {},
      }));
    }
  }

  function renderProviderLine(
    label: string,
    data: { session: number; weekly: number; error?: string; extraSpend?: number; extraLimit?: number },
    theme: any,
    width?: number,
  ): string {
    const dimFn = (s: string) => theme.fg("dim", s);
    const emptyFn = (s: string) => theme.fg("dim", s);
    if (data.error) return ` ${theme.fg("muted", label)} ${theme.fg("error", data.error)}`;

    const sPct = String(data.session).padStart(3) + "%";
    const wPct = String(data.weekly).padStart(3) + "%";

    const sFill = barColor(data.session, theme);
    const wFill = barColor(data.weekly, theme);
    const sBar = renderBar(data.session, BAR_WIDTH, sFill, emptyFn);
    const wBar = renderBar(data.weekly, BAR_WIDTH, wFill, emptyFn);
    let line = ` ${theme.fg("muted", label)} 5h ${sBar} ${dimFn(sPct)}  7d ${wBar} ${dimFn(wPct)}`;
    if (data.extraSpend !== undefined && data.extraLimit !== undefined) {
      line += `  ${dimFn("$" + data.extraSpend.toFixed(0) + "/" + data.extraLimit)}`;
    }

    if (width !== undefined && visibleWidth(line) > width) {
      const compactWithLabel = ` ${theme.fg("muted", label)} 5h ${dimFn(sPct)} 7d ${dimFn(wPct)}`;
      if (visibleWidth(compactWithLabel) <= width) return compactWithLabel;
      return ` 5h ${dimFn(sPct)} 7d ${dimFn(wPct)}`;
    }

    return line;
  }

  function renderWidget(theme: any, width: number): string[] {
    const active = state.activeProvider;
    let lines: string[] = [];
    if (active === "codex" && state.codex) lines = [renderProviderLine("Codex ", state.codex, theme, width)];
    else if (active === "claude" && state.claude) lines = [renderProviderLine("Claude", state.claude, theme, width)];
    return lines.map((line) => truncateToWidth(line, width, "", true));
  }

  function updateProviderFrom(modelLike: any): boolean {
    const prev = state.activeProvider;
    state.activeProvider = detectProvider(modelLike);
    if (prev !== state.activeProvider) {
      updateWidget();
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
