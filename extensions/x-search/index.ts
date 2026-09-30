/**
 * X Search Extension - Search X (Twitter) via xAI Grok's built-in `x_search` tool.
 *
 * Requires XAI_API_KEY environment variable.
 * Get one at: https://console.x.ai/
 *
 * Env:
 * - XAI_API_KEY            (required)
 * - XAI_API_BASE_URL       (optional, default: https://api.x.ai/v1)
 * - XAI_X_SEARCH_MODEL     (optional, default: grok-4-1-fast-reasoning)
 *
 * Notes:
 * - xAI server-side tools (including `x_search`) require a Grok 4 family model.
 * - This extension does not depend on `response.citations` (they may be absent depending on model/tooling).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const API_KEY = process.env.XAI_API_KEY;
const BASE_URL = process.env.XAI_API_BASE_URL || "https://api.x.ai/v1";
const DEFAULT_MODEL =
  process.env.XAI_X_SEARCH_MODEL || "grok-4-1-fast-reasoning";

type JsonSchema = Record<string, unknown>;

interface XSearchResult {
  url: string;
  text: string;
  author?: string;
  created_at?: string;
}

interface XSearchJson {
  results: XSearchResult[];
}

function extractOutputText(response: any): string {
  // xAI Responses API is OpenAI-compatible: response.output[*].content[*]
  if (typeof response?.output_text === "string" && response.output_text.trim())
    return response.output_text;

  const chunks: string[] = [];
  const output = response?.output;
  if (Array.isArray(output)) {
    for (const item of output) {
      const content = item?.content;
      if (!Array.isArray(content)) continue;
      for (const part of content) {
        if (part?.type === "output_text" && typeof part?.text === "string")
          chunks.push(part.text);
      }
    }
  }

  return chunks.join("").trim();
}

function extractCitations(response: any): string[] {
  const citations = response?.citations;
  if (!citations) return [];
  if (!Array.isArray(citations)) return [];
  return citations
    .map((c: any) => {
      if (typeof c === "string") return c;
      if (c && typeof c.url === "string") return c.url;
      return null;
    })
    .filter(Boolean);
}

function tryParseJson<T>(text: string): T | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // Common failure mode: model wraps JSON in code fences.
    const m = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (!m) return null;
    try {
      return JSON.parse(m[1].trim()) as T;
    } catch {
      return null;
    }
  }
}

async function xSearch(
  query: string,
  count = 5,
  model = DEFAULT_MODEL,
): Promise<{ results: XSearchResult[]; citations: string[]; rawText: string }> {
  if (!API_KEY) throw new Error("XAI_API_KEY not set");

  const schema: JsonSchema = {
    type: "object",
    additionalProperties: false,
    required: ["results"],
    properties: {
      results: {
        type: "array",
        maxItems: Math.max(1, Math.min(count, 20)),
        items: {
          type: "object",
          additionalProperties: false,
          required: ["url", "text"],
          properties: {
            url: { type: "string", description: "Full X status URL" },
            text: { type: "string", description: "Post text (truncated)" },
            author: {
              type: "string",
              description: "Author handle or display name",
            },
            created_at: {
              type: "string",
              description: "ISO timestamp if available",
            },
          },
        },
      },
    },
  };

  const body = {
    model,
    input: [
      {
        role: "system",
        content:
          "You are a search assistant. Use the built-in x_search tool to find real X posts. Return ONLY JSON that matches the provided JSON schema. Do not include markdown or extra keys.",
      },
      {
        role: "user",
        content: `Find up to ${Math.max(1, Math.min(count, 20))} recent and relevant X posts for the query: ${JSON.stringify(query)}.\n\nRules:\n- Only include direct X status URLs (https://x.com/<user>/status/<id>).\n- De-duplicate near-identical posts.\n- Keep text under 240 characters.\n- If a field is unknown, omit it (do not fabricate).`,
      },
    ],
    tools: [{ type: "x_search" }],
    text: {
      format: {
        type: "json_schema",
        name: "x_search_results",
        schema,
        strict: true,
      },
    },
  };

  const res = await fetch(`${BASE_URL}/responses`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const msg = await res.text().catch(() => "");
    // Common failure: using Grok 3 with server-side tools.
    if (res.status === 400 && msg.includes("only the grok-4 family")) {
      throw new Error(
        `xAI API error: ${res.status} ${res.statusText}\n${msg.slice(0, 1000)}\n\nFix: set XAI_X_SEARCH_MODEL=grok-4-1-fast-reasoning (or pass {model: "grok-4-1-fast-reasoning"}).`,
      );
    }

    throw new Error(
      `xAI API error: ${res.status} ${res.statusText}${msg ? `\n${msg.slice(0, 1000)}` : ""}`,
    );
  }

  const json = (await res.json()) as any;
  const citations = extractCitations(json);
  const rawText = extractOutputText(json);

  const parsed = tryParseJson<XSearchJson>(rawText);
  const results = parsed?.results;

  if (!Array.isArray(results)) {
    throw new Error(
      `Failed to parse JSON results from xAI response. Raw output:\n${rawText.slice(0, 2000)}`,
    );
  }

  return { results, citations, rawText };
}

function formatResults(results: XSearchResult[], query: string): string {
  if (!results.length) return `No X results for: ${query}`;

  const lines = results.map((r, i) => {
    const metaParts: string[] = [];
    if (r.author) metaParts.push(r.author);
    if (r.created_at) metaParts.push(r.created_at);
    const meta = metaParts.length ? ` (${metaParts.join(" • ")})` : "";

    return `${i + 1}. ${r.url}${meta}\n   ${r.text}`;
  });

  return `X search: ${query}\n\n${lines.join("\n\n")}`;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "x_search",
    label: "X Search (Grok)",
    description: "Search X (Twitter) using xAI Grok's built-in x_search tool.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      count: Type.Optional(
        Type.Number({ description: "Number of results (default: 5, max: 20)" }),
      ),
      model: Type.Optional(
        Type.String({
          description:
            "xAI model (default: env XAI_X_SEARCH_MODEL or grok-4-1-fast-reasoning). Must be Grok 4 family for server-side tools.",
        }),
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!API_KEY) {
        return {
          content: [
            {
              type: "text",
              text: 'Error: XAI_API_KEY not set. Add to ~/.bashrc:\nexport XAI_API_KEY="your-key"',
            },
          ],
          details: { error: true },
        };
      }

      try {
        const count = Math.max(1, Math.min(params.count || 5, 20));
        const model = params.model || DEFAULT_MODEL;
        const { results, citations, rawText } = await xSearch(
          params.query,
          count,
          model,
        );

        return {
          content: [
            { type: "text", text: formatResults(results, params.query) },
          ],
          details: {
            query: params.query,
            count: results.length,
            model,
            citations,
            results,
            rawText,
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `X search error: ${message}` }],
          details: { error: true, message },
        };
      }
    },
  });

  // Convenience command for the user: /xsearch <query>
  pi.registerCommand("xsearch", {
    description: "Search X via Grok (usage: /xsearch <query>)",
    handler: async (args, ctx) => {
      if (!args?.trim()) {
        ctx.ui.notify("Usage: /xsearch <query>", "error");
        return;
      }

      if (!API_KEY) {
        ctx.ui.notify("XAI_API_KEY not set", "error");
        return;
      }

      try {
        const { results } = await xSearch(args.trim(), 5);
        if (!results.length) {
          ctx.ui.notify("No results", "info");
          return;
        }

        ctx.ui.notify(`Found ${results.length} results`, "success");
        ctx.ui.setEditorText(results.map((r) => `- ${r.url}`).join("\n"));
      } catch (err) {
        ctx.ui.notify(
          `Error: ${err instanceof Error ? err.message : err}`,
          "error",
        );
      }
    },
  });
}
