/**
 * Vault shared utilities.
 *
 * Keep these as pure functions so they can be reused by:
 * - rho.ts (vault graph + tool)
 * - vault-search-lib.ts (FTS / grep search)
 */

export interface Frontmatter {
  type?: string;
  created?: string;
  updated?: string;
  tags?: string[];
  source?: string;
  [key: string]: unknown;
}

// ─── Frontmatter Parser ──────────────────────────────────────────────────────

export function parseFrontmatter(content: string): Frontmatter {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};

  const yaml = match[1];
  const result: Frontmatter = {};

  for (const line of yaml.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    let value = trimmed.slice(colonIdx + 1).trim();

    if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1).trim();
      if (inner === "") {
        result[key] = [];
      } else {
        result[key] = inner.split(",").map((s) => s.trim());
      }
    } else {
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      result[key] = value;
    }
  }

  return result;
}

export function stripFrontmatter(content: string): string {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return content;
  return content.slice(match[0].length);
}

// ─── Wikilinks ──────────────────────────────────────────────────────────────

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

export function extractWikilinks(content: string): string[] {
  const slugs = new Set<string>();
  let m: RegExpExecArray | null;
  WIKILINK_RE.lastIndex = 0;
  while ((m = WIKILINK_RE.exec(content)) !== null) {
    slugs.add(m[1].trim());
  }
  return Array.from(slugs);
}

// ─── Title ──────────────────────────────────────────────────────────────────

export function extractTitle(content: string, fallback: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : fallback;
}
