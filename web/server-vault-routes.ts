/**
 * Vault API routes — list, read, and search vault notes.
 *
 * Reuses vault-lib.ts for parsing and vault-search-lib.ts for FTS/grep search.
 * Graph is cached with mtime-based invalidation.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	extractTitle,
	extractWikilinks,
	parseFrontmatter,
	stripFrontmatter,
} from "../extensions/lib/vault-lib.ts";
import { VaultSearch } from "../extensions/lib/vault-search-lib.ts";
import { app } from "./server-core.ts";

// ─── Constants ────────────────────────────────────────────────────────────────

const VAULT_DIR = path.join(os.homedir(), ".rho", "vault");
const VAULT_SUBDIRS = ["concepts", "projects", "patterns", "references", "log"];

// ─── Types ────────────────────────────────────────────────────────────────────

interface VaultNote {
	slug: string;
	path: string;
	title: string;
	type: string;
	tags: string[];
	created: string;
	updated: string;
	links: Set<string>;
	backlinks: Set<string>;
	size: number;
}

type VaultGraph = Map<string, VaultNote>;

// ─── Graph Cache ──────────────────────────────────────────────────────────────

let graphCache: { mtimeMs: number; graph: VaultGraph } | null = null;

function getLatestMtime(): number {
	let latest = 0;
	try {
		const st = fs.statSync(VAULT_DIR);
		latest = st.mtimeMs;
	} catch {
		return 0;
	}
	// Also check subdirs for changes
	for (const sub of VAULT_SUBDIRS) {
		try {
			const st = fs.statSync(path.join(VAULT_DIR, sub));
			if (st.mtimeMs > latest) latest = st.mtimeMs;
		} catch {
			/* skip */
		}
	}
	return latest;
}

function slugFromPath(filePath: string): string {
	return path.basename(filePath, ".md");
}

function findMdFiles(dir: string): string[] {
	const results: string[] = [];
	if (!fs.existsSync(dir)) return results;
	const entries = fs.readdirSync(dir, { withFileTypes: true });
	for (const entry of entries) {
		if (entry.name.startsWith(".")) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) results.push(...findMdFiles(full));
		else if (entry.isFile() && entry.name.endsWith(".md")) results.push(full);
	}
	return results;
}

function buildGraph(): VaultGraph {
	const graph: VaultGraph = new Map();
	const files = findMdFiles(VAULT_DIR);

	for (const file of files) {
		const slug = slugFromPath(file);
		const content = fs.readFileSync(file, "utf-8");
		const fm = parseFrontmatter(content);
		const links = extractWikilinks(content);
		let stat: fs.Stats;
		try {
			stat = fs.statSync(file);
		} catch {
			continue;
		}

		graph.set(slug, {
			slug,
			path: file,
			title: extractTitle(stripFrontmatter(content), slug),
			type: (fm.type as string) || "unknown",
			tags: (fm.tags as string[]) || [],
			created: (fm.created as string) || "",
			updated: (fm.updated as string) || "",
			links: new Set(links),
			backlinks: new Set(),
			size: stat.size,
		});
	}

	// Compute backlinks
	for (const [, note] of graph) {
		for (const target of note.links) {
			const targetNote = graph.get(target);
			if (targetNote) targetNote.backlinks.add(note.slug);
		}
	}

	return graph;
}

function getCachedGraph(): VaultGraph {
	const mtime = getLatestMtime();
	if (graphCache && graphCache.mtimeMs === mtime) return graphCache.graph;
	const graph = buildGraph();
	graphCache = { mtimeMs: mtime, graph };
	return graph;
}

// ─── Search Instance ──────────────────────────────────────────────────────────

const vaultSearcher = new VaultSearch(VAULT_DIR);

// ─── Routes ───────────────────────────────────────────────────────────────────

/** GET /api/vault — list all notes with optional type/query filter */
app.get("/api/vault", (c) => {
	try {
		const graph = getCachedGraph();
		const typeFilter = c.req.query("type");
		const q = c.req.query("q")?.toLowerCase();

		const notes: Array<{
			slug: string;
			title: string;
			type: string;
			tags: string[];
			created: string;
			linkCount: number;
			backlinkCount: number;
		}> = [];

		for (const note of graph.values()) {
			if (typeFilter && note.type !== typeFilter) continue;
			if (q) {
				const match =
					note.slug.toLowerCase().includes(q) ||
					note.title.toLowerCase().includes(q);
				if (!match) continue;
			}
			notes.push({
				slug: note.slug,
				title: note.title,
				type: note.type,
				tags: note.tags,
				created: note.created,
				linkCount: note.links.size,
				backlinkCount: note.backlinks.size,
			});
		}

		// Sort by created desc, then title
		notes.sort((a, b) => {
			if (b.created && a.created) return b.created.localeCompare(a.created);
			return a.title.localeCompare(b.title);
		});

		// Stats
		const byType: Record<string, number> = {};
		let orphanCount = 0;
		for (const note of graph.values()) {
			byType[note.type] = (byType[note.type] || 0) + 1;
			if (note.backlinks.size === 0 && !note.slug.startsWith("_"))
				orphanCount++;
		}

		return c.json({
			notes,
			stats: { total: graph.size, byType, orphanCount },
		});
	} catch (error) {
		return c.json(
			{ error: (error as Error).message ?? "Failed to list vault" },
			500,
		);
	}
});

/** GET /api/vault/search — FTS/grep search */
app.get("/api/vault/search", async (c) => {
	try {
		const q = c.req.query("q");
		if (!q) return c.json({ results: [] });

		const typeFilter = c.req.query("type") as string | undefined;
		const { results } = await vaultSearcher.search({
			query: q,
			type: typeFilter as
				| "concept"
				| "reference"
				| "pattern"
				| "project"
				| "log"
				| "moc"
				| undefined,
			limit: 20,
		});

		return c.json({
			results: results.map((r) => ({
				slug: slugFromPath(r.path),
				title: r.title,
				type: r.type,
				tags: r.tags,
				snippet: r.snippet,
			})),
		});
	} catch (error) {
		return c.json({ error: (error as Error).message ?? "Search failed" }, 500);
	}
});

/** GET /api/vault/:slug — read a single note with backlinks */
app.get("/api/vault/:slug", (c) => {
	try {
		const slug = c.req.param("slug");
		const graph = getCachedGraph();
		const note = graph.get(slug);

		if (!note) {
			return c.json({ error: "Note not found" }, 404);
		}

		const content = fs.readFileSync(note.path, "utf-8");
		const body = stripFrontmatter(content);

		// Resolve backlinks to { slug, title, type }
		const backlinks = Array.from(note.backlinks).map((bl) => {
			const blNote = graph.get(bl);
			return {
				slug: bl,
				title: blNote?.title ?? bl,
				type: blNote?.type ?? "unknown",
			};
		});

		// Resolve forward links
		const links = Array.from(note.links).map((lk) => {
			const lkNote = graph.get(lk);
			return {
				slug: lk,
				title: lkNote?.title ?? lk,
				type: lkNote?.type ?? "unknown",
				exists: !!lkNote,
			};
		});

		return c.json({
			slug: note.slug,
			title: note.title,
			type: note.type,
			tags: note.tags,
			created: note.created,
			updated: note.updated,
			content: body,
			backlinks,
			links,
		});
	} catch (error) {
		return c.json(
			{ error: (error as Error).message ?? "Failed to read note" },
			500,
		);
	}
});
