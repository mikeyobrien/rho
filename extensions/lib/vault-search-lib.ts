/**
 * Vault search library (shared by the vault_search tool + vault(action="search")).
 *
 * - Prefers node:sqlite FTS5 index when available (Node 22.5+)
 * - Falls back to ripgrep when FTS has no hits, or sqlite isn't available
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";

import { parseFrontmatter, extractWikilinks, extractTitle, stripFrontmatter } from "./vault-lib.ts";

export type VaultNoteType = "concept" | "reference" | "pattern" | "project" | "log" | "moc" | "unknown";
export type VaultSearchMode = "fts" | "grep";

export interface VaultSearchResult {
  path: string; // path relative to vaultDir
  title: string;
  type: VaultNoteType;
  tags: string[];
  score: number;
  snippet: string;
  wikilinks: string[];
  content?: string;
}

export interface VaultSearchParams {
  query: string;
  type?: Exclude<VaultNoteType, "unknown">;
  tags?: string[];
  limit?: number; // default 10
  mode?: VaultSearchMode; // default: prefer fts, fallback to grep
  include_content?: boolean;
  max_content_chars?: number; // default 20000
}

interface ParsedNote {
  title: string;
  type: string;
  tags: string[];
  wikilinks: string[];
  body: string;
}

const SCHEMA_VERSION = "1";

export function sanitizeFtsQuery(query: string): string {
  let q = query.trim();
  if (!q) return '""';

  const quoteCount = (q.match(/"/g) || []).length;
  if (quoteCount % 2 !== 0) q = q.replace(/"/g, "");

  q = q.replace(/\bNOT\s*$/i, "");
  q = q.replace(/^\s*NOT\b/i, "");

  let depth = 0;
  let cleaned = "";
  for (const ch of q) {
    if (ch === "(") depth++;
    else if (ch === ")") {
      if (depth > 0) depth--;
      else continue;
    }
    cleaned += ch;
  }
  if (depth > 0) cleaned = cleaned.replace(/\(/g, "");
  q = cleaned.trim();

  if (!q) return `"${query.replace(/"/g, "")}"`;
  return q;
}

function parseNote(content: string): ParsedNote {
  const fm = parseFrontmatter(content) as any;
  const body = stripFrontmatter(content);

  const titleFromFm = typeof fm.title === "string" ? fm.title.trim() : "";
  const title = titleFromFm || extractTitle(body, "(untitled)");

  const type = typeof fm.type === "string" ? fm.type.trim() : "";

  const tags = Array.isArray(fm.tags)
    ? fm.tags.map((t: any) => String(t).trim()).filter(Boolean)
    : [];

  const wikilinks = extractWikilinks(content);

  return { title, type, tags, wikilinks, body };
}

function hashContent(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function safeParseJson(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function tagFilter(results: VaultSearchResult[], tags: string[]): VaultSearchResult[] {
  if (!tags || tags.length === 0) return results;
  const required = new Set(tags.map((t) => t.toLowerCase()));
  return results.filter((r) => {
    const noteTags = new Set(r.tags.map((t) => t.toLowerCase()));
    for (const req of required) {
      if (!noteTags.has(req)) return false;
    }
    return true;
  });
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class VaultSearch {
  private vaultDir: string;
  private dbPath: string;

  private DatabaseSync: any = null;
  private db: any = null;
  private sqliteReady: Promise<boolean> | null = null;

  constructor(vaultDir: string) {
    this.vaultDir = vaultDir;
    this.dbPath = path.join(vaultDir, ".vault-search.db");
  }

  async sqliteAvailable(): Promise<boolean> {
    if (this.sqliteReady) return this.sqliteReady;
    this.sqliteReady = this.initSqlite();
    return this.sqliteReady;
  }

  close(): void {
    if (!this.db) return;
    try { this.db.close(); } catch { /* ignore */ }
    this.db = null;
  }

  async reindex(): Promise<number> {
    const ok = await this.sqliteAvailable();
    if (!ok) throw new Error("node:sqlite unavailable");

    this.close();
    try { if (fs.existsSync(this.dbPath)) fs.unlinkSync(this.dbPath); } catch { /* ignore */ }

    const db = this.getDb();
    const totalDocs = (db.prepare("SELECT COUNT(*) as c FROM documents").get() as any).c;
    return totalDocs;
  }

  async search(params: VaultSearchParams): Promise<{ mode: VaultSearchMode; indexed: number; results: VaultSearchResult[] }> {
    if (!fs.existsSync(this.vaultDir)) {
      return { mode: "grep", indexed: 0, results: [] };
    }

    const limit = Math.min(params.limit || 10, 30);
    const maxContentChars = params.max_content_chars ?? 20000;

    const requestedMode = params.mode; // undefined = prefer fts, fallback to grep
    const hasSqlite = await this.sqliteAvailable();

    let modeUsed: VaultSearchMode = "grep";
    let results: VaultSearchResult[] = [];
    let indexed = 0;

    if (!hasSqlite || requestedMode === "grep") {
      results = this.grepSearch(params.query, params.type, Math.min(limit * 5, 150));
      indexed = this.walkVault().length;
      modeUsed = "grep";
    } else {
      const db = this.getDb();
      this.fullIndex(db);
      indexed = (db.prepare("SELECT COUNT(*) as c FROM documents").get() as any).c;

      const ftsLimit = params.tags && params.tags.length > 0 ? Math.min(limit * 5, 150) : limit;
      results = this.ftsSearch(db, params.query, params.type, ftsLimit);
      modeUsed = "fts";

      if (!requestedMode && results.length === 0) {
        const grep = this.grepSearch(params.query, params.type, Math.min(limit * 5, 150));
        if (grep.length > 0) {
          results = grep;
          modeUsed = "grep";
          indexed = this.walkVault().length;
        }
      }
    }

    let filtered = results;
    if (params.tags && params.tags.length > 0) filtered = tagFilter(results, params.tags);
    filtered = filtered.slice(0, limit);

    if (params.include_content) {
      for (const r of filtered) {
        try {
          const full = fs.readFileSync(path.join(this.vaultDir, r.path), "utf-8");
          r.content = full.length > maxContentChars
            ? full.slice(0, maxContentChars) + `\n\n...(truncated, ${full.length} chars total)`
            : full;
        } catch {
          r.content = "(file read error)";
        }
      }
    }

    return { mode: modeUsed, indexed, results: filtered };
  }

  // ───────────────────────────────────────────────────────────────────────────
  // SQLite / DB
  // ───────────────────────────────────────────────────────────────────────────

  private async initSqlite(): Promise<boolean> {
    try {
      const mod = await import("node:sqlite");
      this.DatabaseSync = (mod as any).DatabaseSync;
      return !!this.DatabaseSync;
    } catch {
      return false;
    }
  }

  private getDb(): any {
    if (this.db) return this.db;
    const existed = fs.existsSync(this.dbPath);

    this.db = new this.DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA synchronous=NORMAL");

    const schemaOk = this.ensureSchema(this.db);
    if (!schemaOk) {
      this.close();
      try { fs.unlinkSync(this.dbPath); } catch { /* ignore */ }
      return this.getDb();
    }

    if (!existed) this.fullIndex(this.db);
    return this.db;
  }

  private ensureSchema(db: any): boolean {
    db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        id INTEGER PRIMARY KEY,
        path TEXT UNIQUE NOT NULL,
        title TEXT,
        type TEXT,
        tags TEXT,
        wikilinks TEXT,
        content_hash TEXT NOT NULL,
        char_count INTEGER,
        indexed_at TEXT NOT NULL
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(
        title, body, tags,
        tokenize='porter unicode61'
      );
      CREATE TABLE IF NOT EXISTS search_meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `);

    let existing: any;
    try {
      existing = db.prepare("SELECT value FROM search_meta WHERE key = 'schema_version'").get();
    } catch {
      existing = null;
    }
    if (existing?.value && existing.value !== SCHEMA_VERSION) return false;

    db.prepare("INSERT OR REPLACE INTO search_meta(key, value) VALUES ('schema_version', ?)").run(SCHEMA_VERSION);
    return true;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Indexing
  // ───────────────────────────────────────────────────────────────────────────

  private walkVault(): string[] {
    const files: string[] = [];
    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith(".md")) files.push(full);
      }
    };

    if (fs.existsSync(this.vaultDir)) walk(this.vaultDir);
    return files;
  }

  private fullIndex(db: any): void {
    const files = this.walkVault();
    const now = new Date().toISOString();

    db.exec("BEGIN");
    try {
      const insertDoc = db.prepare(
        "INSERT OR REPLACE INTO documents(path, title, type, tags, wikilinks, content_hash, char_count, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      );
      const insertFts = db.prepare("INSERT INTO documents_fts(rowid, title, body, tags) VALUES (?, ?, ?, ?)");
      const deleteFts = db.prepare("DELETE FROM documents_fts WHERE rowid = ?");
      const getDoc = db.prepare("SELECT id, content_hash FROM documents WHERE path = ?");

      const existingPaths = new Set<string>();
      for (const row of db.prepare("SELECT path FROM documents").all() as { path: string }[]) {
        existingPaths.add(row.path);
      }

      const seenPaths = new Set<string>();
      for (const absPath of files) {
        const relPath = path.relative(this.vaultDir, absPath);
        seenPaths.add(relPath);

        let content: string;
        try {
          content = fs.readFileSync(absPath, "utf-8");
        } catch {
          continue;
        }

        const hash = hashContent(content);
        const existing = getDoc.get(relPath) as { id: number; content_hash: string } | undefined;
        if (existing && existing.content_hash === hash) continue;

        const note = parseNote(content);
        const tagsJson = JSON.stringify(note.tags);
        const wikilinksJson = JSON.stringify(note.wikilinks);

        if (existing) {
          deleteFts.run(existing.id);
          insertDoc.run(relPath, note.title, note.type, tagsJson, wikilinksJson, hash, content.length, now);
          const updated = getDoc.get(relPath) as { id: number; content_hash: string };
          insertFts.run(updated.id, note.title, note.body, note.tags.join(" "));
        } else {
          insertDoc.run(relPath, note.title, note.type, tagsJson, wikilinksJson, hash, content.length, now);
          const inserted = getDoc.get(relPath) as { id: number; content_hash: string };
          insertFts.run(inserted.id, note.title, note.body, note.tags.join(" "));
        }
      }

      const deleteDoc = db.prepare("DELETE FROM documents WHERE path = ?");
      for (const oldPath of existingPaths) {
        if (!seenPaths.has(oldPath)) {
          const old = getDoc.get(oldPath) as { id: number; content_hash: string } | undefined;
          if (old) {
            deleteFts.run(old.id);
            deleteDoc.run(oldPath);
          }
        }
      }

      db.prepare("INSERT OR REPLACE INTO search_meta(key, value) VALUES ('last_full_index', ?)").run(now);
      db.exec("COMMIT");
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch { /* ignore */ }
      throw e;
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Search implementations
  // ───────────────────────────────────────────────────────────────────────────

  private ftsSearch(db: any, query: string, type?: string, limit: number = 10): VaultSearchResult[] {
    const ftsQuery = sanitizeFtsQuery(query);

    let sql = `
      SELECT d.id, d.path, d.title, d.type, d.tags, d.wikilinks,
             rank AS score,
             snippet(documents_fts, 1, ?, ?, ?, 20) AS snippet
      FROM documents_fts
      JOIN documents d ON d.id = documents_fts.rowid
      WHERE documents_fts MATCH ?
    `;
    const params: (string | number)[] = ["**", "**", "...", ftsQuery];

    if (type) {
      sql += " AND d.type = ?";
      params.push(type);
    }

    sql += " ORDER BY rank LIMIT ?";
    params.push(limit);

    let rows: any[];
    try {
      rows = db.prepare(sql).all(...params);
    } catch {
      const keywords = query.replace(/[^\w\s]/g, "").trim().split(/\s+/).filter(Boolean);
      if (keywords.length === 0) return [];
      const keywordQuery = keywords.join(" OR ");
      try {
        rows = db.prepare(sql).all("**", "**", "...", keywordQuery, ...(type ? [type] : []), limit);
      } catch {
        return [];
      }
    }

    return rows.map((r: any) => ({
      path: r.path,
      title: r.title || "(untitled)",
      type: (r.type || "unknown") as VaultNoteType,
      tags: safeParseJson(r.tags),
      score: r.score,
      snippet: r.snippet || "",
      wikilinks: safeParseJson(r.wikilinks),
    }));
  }

  private grepSearch(query: string, type?: string, limit: number = 10): VaultSearchResult[] {
    const cleaned = query.replace(/[^\w\s-]/g, " ").trim();
    const terms = cleaned.split(/\s+/).filter(Boolean);
    if (terms.length === 0) return [];

    const pattern = terms.map(escapeRegex).join("|");
    const args = [
      "--no-heading",
      "--line-number",
      "--max-count", "1",
      "-S",
      "--glob", "*.md",
      pattern,
      this.vaultDir,
    ];

    const proc = spawnSync("rg", args, { encoding: "utf-8" });
    if (proc.error) return [];
    if (proc.status !== 0 && proc.status !== 1) return [];

    const out = (proc.stdout || "").split("\n").filter(Boolean);
    const results: VaultSearchResult[] = [];

    for (const line of out) {
      if (results.length >= limit) break;

      const i1 = line.indexOf(":");
      const i2 = i1 >= 0 ? line.indexOf(":", i1 + 1) : -1;
      if (i1 < 0 || i2 < 0) continue;

      const absPath = line.slice(0, i1);
      const lineNo = Number(line.slice(i1 + 1, i2));
      const text = line.slice(i2 + 1).trim();

      let content: string;
      try {
        content = fs.readFileSync(absPath, "utf-8");
      } catch {
        continue;
      }

      const note = parseNote(content);
      const noteType = (note.type || "unknown") as VaultNoteType;
      if (type && noteType !== type) continue;

      results.push({
        path: path.relative(this.vaultDir, absPath),
        title: note.title || "(untitled)",
        type: noteType,
        tags: note.tags,
        score: 0,
        snippet: `L${Number.isFinite(lineNo) ? lineNo : "?"}: ${text}`,
        wikilinks: note.wikilinks,
      });
    }

    return results;
  }
}
