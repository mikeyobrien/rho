/**
 * Vault Search Extension
 *
 * Tool: vault_search
 * Command: /vault-reindex
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import * as os from "node:os";
import * as path from "node:path";

import { VaultSearch } from "../lib/mod.ts";

const VAULT_DIR = path.join(os.homedir(), ".rho", "vault");

function formatResults(query: string, mode: "fts" | "grep", indexed: number, results: any[]): string {
  const lines = results.map((r: any, i: number) => {
    let line = `${i + 1}. **${r.title}** (${r.path}) [${r.type}]`;
    if (r.tags?.length > 0) line += ` {${r.tags.join(", ")}}`;
    if (r.score) line += ` score:${Number(r.score).toFixed(3)}`;
    if (r.snippet) line += `\n   ${r.snippet}`;
    if (r.wikilinks?.length > 0) line += `\n   links: ${r.wikilinks.map((l: string) => `[[${l}]]`).join(", ")}`;
    if (r.content) line += `\n---\n${r.content}\n---`;
    return line;
  });

  const header = `${results.length} result(s) for "${query}" (${mode}, ${indexed} notes)`;
  return `${header}\n\n${lines.join("\n\n")}`;
}

export default function activate(pi: ExtensionAPI) {
  const searcher = new VaultSearch(VAULT_DIR);

  // Fire-and-forget notice if sqlite isn't available (still works via ripgrep).
  searcher.sqliteAvailable().then((ok) => {
    if (!ok && pi.ui) {
      pi.ui.notify(
        "vault-search: Node 22.5+ enables fast FTS indexing. Falling back to ripgrep-only search.",
        "warning"
      );
    }
  }).catch(() => { /* ignore */ });

  pi.registerTool({
    name: "vault_search",
    label: "Search",
    description:
      "Search the knowledge vault for notes matching a query. Prefers FTS5 full-text search (porter stemming + ranking + snippets) " +
      "and falls back to ripgrep when FTS has no matches or when node:sqlite isn't available. " +
      "Supports FTS5 syntax: AND, OR, NOT, \"exact phrase\", prefix*. " +
      "Use mode='grep' to force ripgrep search.",

    parameters: Type.Object({
      query: Type.String({ description: "Search query. Natural language or FTS5 syntax." }),
      type: Type.Optional(
        StringEnum(["concept", "reference", "pattern", "project", "log", "moc"] as const, {
          description: "Filter by note type.",
        })
      ),
      tags: Type.Optional(Type.Array(Type.String(), { description: "Filter to notes containing ALL of these tags." })),
      limit: Type.Optional(Type.Number({ description: "Max results (default 10, max 30)." })),
      mode: Type.Optional(StringEnum(["fts", "grep"] as const, { description: "Force search mode." })),
      include_content: Type.Optional(Type.Boolean({ description: "Include full note content (truncated). Default false." })),
    }),

    async execute(_toolCallId, params) {
      const res = await searcher.search({
        query: params.query,
        type: params.type,
        tags: params.tags,
        limit: params.limit,
        mode: params.mode,
        include_content: params.include_content,
      });

      if (res.results.length === 0) {
        return {
          content: [{
            type: "text" as const,
            text: `No results for "${params.query}" (searched ${res.indexed} notes). Try broader terms or different keywords.`,
          }],
          details: { query: params.query, mode: res.mode, total: 0, indexed: res.indexed },
        };
      }

      return {
        content: [{ type: "text" as const, text: formatResults(params.query, res.mode, res.indexed, res.results) }],
        details: { query: params.query, mode: res.mode, total: res.results.length, indexed: res.indexed },
      };
    },
  });

  pi.registerCommand("vault-reindex", {
    description: "Force full re-index of the vault search database",
    handler: async (_args: string, ctx: any) => {
      const ok = await searcher.sqliteAvailable();
      if (!ok) {
        ctx.ui.notify("vault-search requires Node 22.5+ for node:sqlite.", "error");
        return;
      }

      const totalDocs = await searcher.reindex();
      ctx.ui.notify(`Vault search index rebuilt: ${totalDocs} notes indexed.`, "info");
    },
  });
}
