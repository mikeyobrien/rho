/**
 * Vault Extension - Markdown-with-wikilinks knowledge graph for agents
 *
 * Structure (under ~/.rho/vault/):
 *   _index.md       - Root map of content (MOC)
 *   _inbox.md       - Capture buffer for quick entries
 *   concepts/       - Concept notes
 *   projects/       - Project notes
 *   patterns/       - Pattern notes
 *   references/     - Reference notes
 *   log/            - Daily logs (exempt from verbatim trap guard)
 *
 * Phase 1: capture, read, write, status, list actions + /vault command.
 * Verbatim trap guard enforces quality on write.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import {
  VAULT_DIR,
  ensureVaultDirs,
  createDefaultFiles,
  buildGraph,
  captureToInbox,
  readNote,
  writeNote,
  getVaultStatus,
  listNotes,
  type VaultGraph,
} from "./vault-core.ts";

export default function (pi: ExtensionAPI) {
  // Bootstrap vault on load
  ensureVaultDirs();
  createDefaultFiles();

  // In-memory graph — rebuilt on session start and after mutations
  let graph: VaultGraph = buildGraph();

  function rebuildGraph(): void {
    graph = buildGraph();
  }

  function updateVaultWidget(ctx: {
    ui?: { setStatus?: (id: string, text: string | undefined) => void };
  }) {
    if (!ctx?.ui?.setStatus) return;

    let noteCount = 0;
    let orphanCount = 0;
    for (const note of graph.values()) {
      noteCount++;
      if (note.backlinks.size === 0 && !note.slug.startsWith("_")) {
        orphanCount++;
      }
    }

    const status = `📓 ${noteCount} notes${orphanCount > 0 ? ` (${orphanCount} orphans)` : ""}`;
    ctx.ui.setStatus("vault", status);
  }

  // Rebuild graph and update widget on session start
  pi.on("session_start", async (_event, ctx) => {
    rebuildGraph();
    updateVaultWidget(ctx);
  });

  // Register vault tool
  pi.registerTool({
    name: "vault",
    label: "Vault",
    description:
      "Knowledge graph for persistent notes with wikilinks. " +
      "Actions: capture (quick inbox entry), read (note + backlinks), write (create/update with quality gate), " +
      "status (vault stats), list (filter by type/query). " +
      "Notes require frontmatter, a ## Connections section with [[wikilinks]], except log type.",
    parameters: Type.Object({
      action: StringEnum(["capture", "read", "write", "status", "list"] as const),
      slug: Type.Optional(
        Type.String({ description: "Note slug (kebab-case filename without .md)" })
      ),
      content: Type.Optional(
        Type.String({ description: "Note content (full markdown for write, text for capture)" })
      ),
      type: Type.Optional(
        Type.String({
          description: "Note type: concept, project, pattern, reference, log, moc",
        })
      ),
      source: Type.Optional(
        Type.String({ description: "Source of the note (conversation, url, etc)" })
      ),
      context: Type.Optional(
        Type.String({ description: "Additional context for capture entries" })
      ),
      query: Type.Optional(
        Type.String({ description: "Search/filter query for list action" })
      ),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      switch (params.action) {
        // ---- Capture: quick append to inbox ----
        case "capture": {
          if (!params.content) {
            return {
              content: [{ type: "text", text: "Error: content required for capture" }],
              details: { error: true },
            };
          }

          const entry = captureToInbox(
            VAULT_DIR,
            params.content,
            params.source,
            params.context
          );
          return {
            content: [
              {
                type: "text",
                text: `Captured to inbox:\n${entry}`,
              },
            ],
            details: { action: "capture" },
          };
        }

        // ---- Read: note content + backlinks ----
        case "read": {
          if (!params.slug) {
            return {
              content: [{ type: "text", text: "Error: slug required for read" }],
              details: { error: true },
            };
          }

          const result = readNote(VAULT_DIR, params.slug, graph);
          if (!result) {
            return {
              content: [
                {
                  type: "text",
                  text: `Note not found: ${params.slug}`,
                },
              ],
              details: { error: true, slug: params.slug },
            };
          }

          let text = result.content;
          if (result.backlinks.length > 0) {
            text +=
              "\n\n---\n**Backlinks:** " +
              result.backlinks.map((b) => `[[${b}]]`).join(", ");
          }

          return {
            content: [{ type: "text", text }],
            details: {
              action: "read",
              slug: params.slug,
              backlinks: result.backlinks,
            },
          };
        }

        // ---- Write: create/update note with verbatim guard ----
        case "write": {
          if (!params.slug) {
            return {
              content: [{ type: "text", text: "Error: slug required for write" }],
              details: { error: true },
            };
          }
          if (!params.content) {
            return {
              content: [{ type: "text", text: "Error: content required for write" }],
              details: { error: true },
            };
          }

          const noteType = params.type || "concept";
          const result = writeNote(VAULT_DIR, params.slug, params.content, noteType);

          if (!result.valid) {
            return {
              content: [
                {
                  type: "text",
                  text: `Rejected: ${result.reason}`,
                },
              ],
              details: { error: true, reason: result.reason },
            };
          }

          // Rebuild graph after write
          rebuildGraph();
          updateVaultWidget(ctx);

          return {
            content: [
              {
                type: "text",
                text: `Written: ${params.slug} -> ${result.path}`,
              },
            ],
            details: {
              action: "write",
              slug: params.slug,
              path: result.path,
              type: noteType,
            },
          };
        }

        // ---- Status: vault-wide statistics ----
        case "status": {
          const status = getVaultStatus(VAULT_DIR, graph);

          const typeCounts = Object.entries(status.byType)
            .map(([t, n]) => `${t}: ${n}`)
            .join(", ");

          const text = [
            `Vault Status`,
            `  Total notes: ${status.totalNotes}`,
            `  By type: ${typeCounts || "none"}`,
            `  Orphans: ${status.orphanCount}`,
            `  Inbox items: ${status.inboxItems}`,
            `  Avg links/note: ${status.avgLinksPerNote.toFixed(1)}`,
          ].join("\n");

          return {
            content: [{ type: "text", text }],
            details: { action: "status", ...status },
          };
        }

        // ---- List: filtered note listing ----
        case "list": {
          const notes = listNotes(graph, params.type, params.query);

          if (notes.length === 0) {
            const filters = [
              params.type ? `type=${params.type}` : "",
              params.query ? `query="${params.query}"` : "",
            ].filter(Boolean).join(", ");
            return {
              content: [
                {
                  type: "text",
                  text: filters
                    ? `No notes found matching: ${filters}`
                    : "Vault is empty.",
                },
              ],
              details: { action: "list", count: 0 },
            };
          }

          const lines = notes.map(
            (n) =>
              `- **${n.title}** (${n.slug}) [${n.type}] ${n.linkCount}L/${n.backlinkCount}BL${n.updated ? ` updated:${n.updated}` : ""}`
          );

          const header = params.type
            ? `${notes.length} ${params.type} note(s)`
            : `${notes.length} note(s)`;

          return {
            content: [
              {
                type: "text",
                text: `${header}${params.query ? ` matching "${params.query}"` : ""}:\n${lines.join("\n")}`,
              },
            ],
            details: { action: "list", count: notes.length },
          };
        }

        default:
          return {
            content: [{ type: "text", text: "Unknown action" }],
            details: { error: true },
          };
      }
    },
  });

  // Register /vault slash command
  pi.registerCommand("vault", {
    description: "Vault status dashboard (usage: /vault)",
    handler: async (_args, ctx) => {
      rebuildGraph();
      const status = getVaultStatus(VAULT_DIR, graph);

      const typeCounts = Object.entries(status.byType)
        .map(([t, n]) => `${n} ${t}`)
        .join(", ");

      const parts = [
        `${status.totalNotes} notes`,
        typeCounts ? `(${typeCounts})` : "",
        `${status.orphanCount} orphans`,
        `${status.inboxItems} inbox`,
        `avg ${status.avgLinksPerNote.toFixed(1)} links/note`,
      ].filter(Boolean);

      ctx.ui.notify(`Vault: ${parts.join(" | ")}`, "info");
      updateVaultWidget(ctx);
    },
  });
}
