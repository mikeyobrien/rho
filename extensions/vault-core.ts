/**
 * Vault Core -- Pure functions for the vault extension.
 *
 * Separated from vault.ts so tests can import without pi-coding-agent deps.
 * Contains: types, parsers, graph builder, validators, directory helpers.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---- Constants ----

export const VAULT_DIR = path.join(os.homedir(), ".pi", "vault");

export const VAULT_SUBDIRS = [
  "concepts",
  "projects",
  "patterns",
  "references",
  "log",
] as const;

/** Note types that require a ## Connections section with wikilinks */
const TYPES_REQUIRING_CONNECTIONS = new Set([
  "concept",
  "project",
  "pattern",
  "reference",
  "moc",
]);

// ---- Types ----

export interface VaultNote {
  slug: string;
  path: string;           // absolute path
  title: string;          // first H1 or filename
  type: string;           // from frontmatter
  tags: string[];
  created: string;
  updated: string;
  source: string;
  links: Set<string>;     // outgoing wikilink slugs
  backlinks: Set<string>; // incoming (computed)
  size: number;           // file size in bytes
}

export type VaultGraph = Map<string, VaultNote>;

export interface Frontmatter {
  type?: string;
  created?: string;
  updated?: string;
  tags?: string[];
  source?: string;
  [key: string]: unknown;
}

export interface ValidationResult {
  valid: boolean;
  reason?: string;
}

export interface VaultStatus {
  totalNotes: number;
  byType: Record<string, number>;
  orphanCount: number;
  inboxItems: number;
  avgLinksPerNote: number;
}

export interface NoteListEntry {
  slug: string;
  title: string;
  type: string;
  linkCount: number;
  backlinkCount: number;
  updated: string;
  tags: string[];
}

// ---- Frontmatter Parser ----

/**
 * Parse YAML frontmatter between --- fences.
 * Simple key-value parser -- no external YAML dependency.
 * Handles: strings, arrays in [a, b] syntax.
 */
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

    // Handle array syntax: [a, b, c]
    if (value.startsWith("[") && value.endsWith("]")) {
      const inner = value.slice(1, -1).trim();
      if (inner === "") {
        result[key] = [];
      } else {
        result[key] = inner.split(",").map((s) => s.trim());
      }
    } else {
      // Strip optional quotes
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      result[key] = value;
    }
  }

  return result;
}

// ---- Wikilink Extractor ----

const WIKILINK_RE = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;

/**
 * Extract wikilink slugs from markdown content.
 * Handles [[slug]] and [[slug|display text]].
 * Returns deduplicated array of slugs.
 */
export function extractWikilinks(content: string): string[] {
  const slugs = new Set<string>();
  let m: RegExpExecArray | null;
  // Reset regex state
  WIKILINK_RE.lastIndex = 0;
  while ((m = WIKILINK_RE.exec(content)) !== null) {
    slugs.add(m[1].trim());
  }
  return Array.from(slugs);
}

// ---- Title Extractor ----

/**
 * Extract the first H1 title from markdown content.
 * Falls back to slug if no H1 found.
 */
function extractTitle(content: string, fallback: string): string {
  const match = content.match(/^#\s+(.+)$/m);
  return match ? match[1].trim() : fallback;
}

// ---- Slug from Path ----

/**
 * Derive slug from a file path: filename without .md extension.
 */
function slugFromPath(filePath: string): string {
  return path.basename(filePath, ".md");
}

// ---- Directory Helpers ----

/**
 * Ensure vault directory structure exists.
 * Creates root and all subdirs. Idempotent.
 */
export function ensureVaultDirs(vaultDir: string = VAULT_DIR): void {
  fs.mkdirSync(vaultDir, { recursive: true });
  for (const sub of VAULT_SUBDIRS) {
    fs.mkdirSync(path.join(vaultDir, sub), { recursive: true });
  }
}

// ---- Graph Builder ----

/**
 * Recursively find all .md files under a directory.
 */
function findMdFiles(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findMdFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Build the in-memory vault graph by scanning all .md files.
 * Parses frontmatter, extracts wikilinks, computes backlinks.
 */
export function buildGraph(vaultDir: string = VAULT_DIR): VaultGraph {
  const graph: VaultGraph = new Map();
  const files = findMdFiles(vaultDir);

  // First pass: parse all notes, extract outgoing links
  for (const file of files) {
    const slug = slugFromPath(file);
    const content = fs.readFileSync(file, "utf-8");
    const fm = parseFrontmatter(content);
    const links = extractWikilinks(content);
    const stat = fs.statSync(file);

    const note: VaultNote = {
      slug,
      path: file,
      title: extractTitle(content, slug),
      type: (fm.type as string) || "unknown",
      tags: (fm.tags as string[]) || [],
      created: (fm.created as string) || "",
      updated: (fm.updated as string) || "",
      source: (fm.source as string) || "",
      links: new Set(links),
      backlinks: new Set(),
      size: stat.size,
    };

    graph.set(slug, note);
  }

  // Second pass: compute backlinks
  for (const [slug, note] of graph) {
    for (const target of note.links) {
      const targetNote = graph.get(target);
      if (targetNote) {
        targetNote.backlinks.add(slug);
      }
    }
  }

  return graph;
}

// ---- Type-to-Directory Mapping ----

const TYPE_DIR_MAP: Record<string, string> = {
  concept: "concepts",
  project: "projects",
  pattern: "patterns",
  reference: "references",
  log: "log",
};

/**
 * Map a note type to its subdirectory.
 * Types not in the map (moc, unknown) go to vault root (empty string).
 */
export function typeToDir(type: string): string {
  return TYPE_DIR_MAP[type] ?? "";
}

// ---- Default Files ----

const DEFAULT_INDEX = `---
type: moc
created: ${new Date().toISOString().split("T")[0]}
updated: ${new Date().toISOString().split("T")[0]}
tags: []
---

# Vault Index

## Connections

This is the root map of content for the vault.

## Body

Start linking notes here as the vault grows.
`;

const DEFAULT_INBOX = `# Inbox

Captured items waiting to be processed into notes.
`;

/**
 * Create _index.md and _inbox.md if they don't already exist.
 * Idempotent -- never overwrites existing files.
 */
export function createDefaultFiles(vaultDir: string = VAULT_DIR): void {
  const indexPath = path.join(vaultDir, "_index.md");
  const inboxPath = path.join(vaultDir, "_inbox.md");

  if (!fs.existsSync(indexPath)) {
    fs.writeFileSync(indexPath, DEFAULT_INDEX);
  }
  if (!fs.existsSync(inboxPath)) {
    fs.writeFileSync(inboxPath, DEFAULT_INBOX);
  }
}

// ---- Capture to Inbox ----

/**
 * Append a timestamped entry to _inbox.md.
 * Returns the formatted entry that was appended.
 */
export function captureToInbox(
  vaultDir: string,
  text: string,
  source?: string,
  context?: string
): string {
  const inboxPath = path.join(vaultDir, "_inbox.md");
  const timestamp = new Date().toISOString();

  const lines: string[] = ["", "---", "", `**${timestamp}**`];
  if (source) lines.push(`> Source: ${source}`);
  if (context) lines.push(`> Context: ${context}`);
  lines.push("", text, "");

  const entry = lines.join("\n");
  fs.appendFileSync(inboxPath, entry);
  return entry.trim();
}

// ---- Read Note ----

/**
 * Read a note by slug. Returns content and computed backlinks, or null if not found.
 */
export function readNote(
  vaultDir: string,
  slug: string,
  graph: VaultGraph
): { content: string; backlinks: string[] } | null {
  const note = graph.get(slug);
  if (!note) {
    // Try finding by scanning disk (note might not be in graph yet)
    const candidates = findNoteFile(vaultDir, slug);
    if (!candidates) return null;
    const content = fs.readFileSync(candidates, "utf-8");
    return { content, backlinks: [] };
  }

  const content = fs.readFileSync(note.path, "utf-8");
  return {
    content,
    backlinks: Array.from(note.backlinks),
  };
}

/**
 * Find a note file by slug, scanning all vault dirs.
 */
function findNoteFile(vaultDir: string, slug: string): string | null {
  const filename = `${slug}.md`;

  // Check root
  const rootPath = path.join(vaultDir, filename);
  if (fs.existsSync(rootPath)) return rootPath;

  // Check subdirs
  for (const sub of VAULT_SUBDIRS) {
    const subPath = path.join(vaultDir, sub, filename);
    if (fs.existsSync(subPath)) return subPath;
  }

  return null;
}

// ---- Write Note ----

/**
 * Validate and write a note to the vault.
 * Places it in the correct subdirectory based on type.
 * Returns validation result with path if successful.
 */
export function writeNote(
  vaultDir: string,
  slug: string,
  content: string,
  type: string
): ValidationResult & { path?: string } {
  // Validate first
  const validation = validateNote(content, type);
  if (!validation.valid) {
    return validation;
  }

  // Determine target directory
  const subdir = typeToDir(type);
  const targetDir = subdir ? path.join(vaultDir, subdir) : vaultDir;
  fs.mkdirSync(targetDir, { recursive: true });

  const filePath = path.join(targetDir, `${slug}.md`);
  fs.writeFileSync(filePath, content);

  return { valid: true, path: filePath };
}

// ---- Verbatim Trap Guard ----

/**
 * Validate a note's content before writing.
 * Rejects notes that don't meet structural requirements:
 * - Frontmatter must be present
 * - Connections section required (except log type)
 * - At least 1 wikilink required (except log type)
 */
export function validateNote(
  content: string,
  type: string
): ValidationResult {
  // 1. Frontmatter must exist
  const fm = parseFrontmatter(content);
  if (!fm.type) {
    return {
      valid: false,
      reason: "Missing frontmatter: note must have --- delimited frontmatter with at least a 'type' field.",
    };
  }

  // 2. Log type is exempt from connections requirement
  if (type === "log") {
    return { valid: true };
  }

  // 3. Connections section required for non-log types
  if (TYPES_REQUIRING_CONNECTIONS.has(type)) {
    const hasConnections = /^##\s+Connections/m.test(content);
    if (!hasConnections) {
      return {
        valid: false,
        reason: "Missing '## Connections' section. Non-log notes must have a Connections section with wikilinks.",
      };
    }

    // 4. At least 1 wikilink required
    const links = extractWikilinks(content);
    if (links.length === 0) {
      return {
        valid: false,
        reason: "No wikilinks found. Notes must have at least 1 [[wikilink]] to connect to the knowledge graph.",
      };
    }
  }

  return { valid: true };
}

// ---- Vault Status ----

/**
 * Count inbox items by counting `---` separators in _inbox.md.
 * Each capture appends a `---` separator before the entry.
 */
function countInboxItems(vaultDir: string): number {
  const inboxPath = path.join(vaultDir, "_inbox.md");
  if (!fs.existsSync(inboxPath)) return 0;

  const content = fs.readFileSync(inboxPath, "utf-8");
  // Count --- separators that appear after the header.
  // Each captured item starts with a --- separator line.
  const separators = content.match(/^---$/gm);
  return separators ? separators.length : 0;
}

/**
 * Compute vault-wide statistics from the graph.
 */
export function getVaultStatus(
  vaultDir: string,
  graph: VaultGraph
): VaultStatus {
  const byType: Record<string, number> = {};
  let orphanCount = 0;
  let totalLinks = 0;

  for (const note of graph.values()) {
    byType[note.type] = (byType[note.type] || 0) + 1;
    totalLinks += note.links.size;
    if (note.backlinks.size === 0 && !note.slug.startsWith("_")) {
      orphanCount++;
    }
  }

  return {
    totalNotes: graph.size,
    byType,
    orphanCount,
    inboxItems: countInboxItems(vaultDir),
    avgLinksPerNote: graph.size > 0 ? totalLinks / graph.size : 0,
  };
}

// ---- List Notes ----

/**
 * List notes from the graph with optional type and query filters.
 * Query matches against slug and title (case-insensitive).
 */
export function listNotes(
  graph: VaultGraph,
  type?: string,
  query?: string
): NoteListEntry[] {
  const results: NoteListEntry[] = [];
  const q = query?.toLowerCase();

  for (const note of graph.values()) {
    // Type filter
    if (type && note.type !== type) continue;

    // Query filter: match slug or title
    if (q) {
      const matchesSlug = note.slug.toLowerCase().includes(q);
      const matchesTitle = note.title.toLowerCase().includes(q);
      if (!matchesSlug && !matchesTitle) continue;
    }

    results.push({
      slug: note.slug,
      title: note.title,
      type: note.type,
      linkCount: note.links.size,
      backlinkCount: note.backlinks.size,
      updated: note.updated,
      tags: note.tags,
    });
  }

  return results;
}
