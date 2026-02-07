/**
 * Brave Search Extension - Web search via Brave Search API
 *
 * Requires BRAVE_API_KEY environment variable.
 * Get one at: https://brave.com/search/api/
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

const API_KEY = process.env.BRAVE_API_KEY;
const SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";

interface SearchResult {
  title: string;
  url: string;
  description: string;
}

interface BraveSearchResponse {
  web?: {
    results?: Array<{
      title: string;
      url: string;
      description: string;
    }>;
  };
  query?: {
    original: string;
  };
}

async function search(query: string, count = 5): Promise<SearchResult[]> {
  if (!API_KEY) {
    throw new Error("BRAVE_API_KEY not set");
  }

  const params = new URLSearchParams({
    q: query,
    count: String(count),
  });

  const response = await fetch(`${SEARCH_URL}?${params}`, {
    headers: {
      Accept: "application/json",
      "X-Subscription-Token": API_KEY,
    },
  });

  if (!response.ok) {
    throw new Error(`Brave Search API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as BraveSearchResponse;
  
  return (data.web?.results || []).map((r) => ({
    title: r.title,
    url: r.url,
    description: r.description,
  }));
}

export default function (pi: ExtensionAPI) {
  // Register search tool
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description: "Search the web using Brave Search. Use for finding documentation, current information, facts, or any web content.",
    parameters: Type.Object({
      query: Type.String({ description: "Search query" }),
      count: Type.Optional(Type.Number({ description: "Number of results (default: 5, max: 10)" })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      if (!API_KEY) {
        return {
          content: [{ type: "text", text: "Error: BRAVE_API_KEY not set. Add to ~/.bashrc:\nexport BRAVE_API_KEY=\"your-key\"" }],
          details: { error: true },
        };
      }

      try {
        const count = Math.min(params.count || 5, 10);
        const results = await search(params.query, count);

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: `No results for: ${params.query}` }],
            details: { query: params.query, count: 0 },
          };
        }

        const formatted = results
          .map((r, i) => `${i + 1}. **${r.title}**\n   ${r.url}\n   ${r.description}`)
          .join("\n\n");

        return {
          content: [{ type: "text", text: formatted }],
          details: { query: params.query, count: results.length },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text", text: `Search error: ${message}` }],
          details: { error: true, message },
        };
      }
    },
  });

  // Register /search command for user
  pi.registerCommand("search", {
    description: "Quick web search (usage: /search <query>)",
    handler: async (args, ctx) => {
      if (!args?.trim()) {
        ctx.ui.notify("Usage: /search <query>", "error");
        return;
      }

      if (!API_KEY) {
        ctx.ui.notify("BRAVE_API_KEY not set", "error");
        return;
      }

      try {
        const results = await search(args.trim(), 3);
        if (results.length === 0) {
          ctx.ui.notify("No results", "info");
        } else {
          ctx.ui.notify(`Found ${results.length} results`, "success");
          // Set results in editor for easy use
          const text = results.map((r) => `- [${r.title}](${r.url})`).join("\n");
          ctx.ui.setEditorText(text);
        }
      } catch (err) {
        ctx.ui.notify(`Error: ${err instanceof Error ? err.message : err}`, "error");
      }
    },
  });
}
