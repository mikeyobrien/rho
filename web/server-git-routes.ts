import { execFile as execFileCb } from "node:child_process";
import crypto from "node:crypto";
import { mkdirSync, watch } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { getRhoHome } from "./config.ts";
import { getSessionGitContext } from "./git-context-store.ts";
import {
	type ReviewFile,
	type ReviewSession,
	app,
	persistOpenReviewSession,
	persistReviewCompletion,
	readNumericEnv,
	reviewSessions,
} from "./server-core.ts";
import { broadcastUiEvent } from "./server-ui-events.ts";

// --- Git API ---

const execFileAsync = promisify(execFileCb);

interface GitContextFile {
	cwd: string;
	updatedAt: number;
	sessionFiles: string[];
}

let gitContextWatchStarted = false;
let gitContextNotifyTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleGitContextNotify(): void {
	if (gitContextNotifyTimer) {
		clearTimeout(gitContextNotifyTimer);
	}
	gitContextNotifyTimer = setTimeout(() => {
		gitContextNotifyTimer = null;
		broadcastUiEvent("git_context_changed");
	}, 100);
}

function startGitContextWatch(): void {
	if (gitContextWatchStarted) return;
	gitContextWatchStarted = true;
	const rhoHome = getRhoHome();
	const contextFile = "git-context.json";
	try {
		mkdirSync(rhoHome, { recursive: true });
		const watcher = watch(
			rhoHome,
			{ persistent: false },
			(_eventType, filename) => {
				const fileName =
					typeof filename === "string" ? filename : filename?.toString();
				if (!fileName || fileName !== contextFile) return;
				scheduleGitContextNotify();
			},
		);
		watcher.on("error", () => {
			// Best effort only; polling fallback remains available.
		});
	} catch {
		// Best effort only; polling fallback remains available.
	}
}

startGitContextWatch();

async function readTrackedGitContext(): Promise<GitContextFile | null> {
	try {
		const raw = await readFile(
			path.join(getRhoHome(), "git-context.json"),
			"utf-8",
		);
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

async function isGitRepo(cwd: string): Promise<boolean> {
	try {
		await execFileAsync("git", ["rev-parse", "--git-dir"], {
			cwd,
			timeout: 2000,
		});
		return true;
	} catch {
		return false;
	}
}

async function getGitCwd(sessionId = ""): Promise<string | null> {
	const normalizedSessionId = sessionId.trim();
	if (normalizedSessionId) {
		const sessionContext = await getSessionGitContext(normalizedSessionId);
		if (sessionContext?.cwd && (await isGitRepo(sessionContext.cwd))) {
			return sessionContext.cwd;
		}
	}

	const trackedContext = await readTrackedGitContext();
	if (trackedContext?.cwd && (await isGitRepo(trackedContext.cwd))) {
		return trackedContext.cwd;
	}
	if (await isGitRepo(process.cwd())) {
		return process.cwd();
	}
	return null;
}

async function gitExec(args: string[], cwd: string): Promise<string> {
	const { stdout } = await execFileAsync("git", args, {
		cwd,
		timeout: 10000,
		maxBuffer: 10 * 1024 * 1024,
	});
	return stdout;
}

interface GitStatusFile {
	path: string;
	index: string;
	worktree: string;
	status: string;
	statusLabel: string;
	additions: number;
	deletions: number;
	isSession: boolean;
}

function parseStatusLine(
	line: string,
): { index: string; worktree: string; path: string } | null {
	if (line.length < 4) return null;
	const index = line[0];
	const worktree = line[1];
	let filePath = line.slice(3);
	const renameIdx = filePath.indexOf(" -> ");
	if (renameIdx !== -1) filePath = filePath.slice(renameIdx + 4);
	return { index, worktree, path: filePath };
}

function classifyFile(
	index: string,
	worktree: string,
): { status: string; statusLabel: string } {
	if (index === "?" && worktree === "?")
		return { status: "untracked", statusLabel: "?" };
	if (index === "A") return { status: "added", statusLabel: "A" };
	if (index === "D" || worktree === "D")
		return { status: "deleted", statusLabel: "D" };
	if (index === "R") return { status: "renamed", statusLabel: "R" };
	return { status: "modified", statusLabel: "M" };
}

function parseNumstat(
	output: string,
): Map<string, { add: number; del: number }> {
	const map = new Map<string, { add: number; del: number }>();
	for (const line of output.trim().split("\n")) {
		if (!line) continue;
		const parts = line.split("\t");
		if (parts.length >= 3) {
			const add = parts[0] === "-" ? 0 : Number.parseInt(parts[0]) || 0;
			const del = parts[1] === "-" ? 0 : Number.parseInt(parts[1]) || 0;
			map.set(parts[2], { add, del });
		}
	}
	return map;
}

const GIT_LANG_MAP: Record<string, string> = {
	".ts": "typescript",
	".tsx": "typescript",
	".js": "javascript",
	".jsx": "javascript",
	".mjs": "javascript",
	".py": "python",
	".rs": "rust",
	".go": "go",
	".css": "css",
	".html": "html",
	".json": "json",
	".yaml": "yaml",
	".yml": "yaml",
	".sh": "bash",
	".md": "markdown",
	".toml": "toml",
};

function detectLang(filePath: string): string {
	return GIT_LANG_MAP[path.extname(filePath).toLowerCase()] ?? "plaintext";
}

const MAX_REVIEW_FILE_BYTES = 500 * 1024;
const BINARY_SNIFF_BYTES = 8192;

function resolveRepoFilePath(
	repoRoot: string,
	relOrAbsPath: string,
): { absPath: string; relPath: string } | null {
	if (
		!relOrAbsPath ||
		relOrAbsPath.includes("\0") ||
		relOrAbsPath.includes("..")
	) {
		return null;
	}
	if (path.isAbsolute(relOrAbsPath)) {
		return null;
	}
	const absPath = path.resolve(repoRoot, relOrAbsPath);
	const relPath = path.relative(repoRoot, absPath);
	if (!relPath || relPath.startsWith("..") || path.isAbsolute(relPath)) {
		return null;
	}
	return { absPath, relPath };
}

async function isLikelyBinaryFile(filePath: string): Promise<boolean> {
	const content = await readFile(filePath);
	const sample = content.subarray(0, BINARY_SNIFF_BYTES);
	return sample.includes(0);
}

app.get("/api/git/status", async (c) => {
	const sessionId = c.req.query("sessionId")?.trim() ?? "";
	const cwd = await getGitCwd(sessionId);
	if (!cwd) return c.json({ error: "No git repository detected" }, 404);

	const trackedContext = await readTrackedGitContext();
	const sessionFiles =
		trackedContext?.cwd === cwd
			? new Set(trackedContext?.sessionFiles ?? [])
			: new Set<string>();

	try {
		const [branch, porcelain, numstatRaw, cachedNumstatRaw, logRaw] =
			await Promise.all([
				gitExec(["rev-parse", "--abbrev-ref", "HEAD"], cwd).catch(() => "HEAD"),
				gitExec(["status", "--porcelain=v1"], cwd).catch(() => ""),
				gitExec(["diff", "--numstat"], cwd).catch(() => ""),
				gitExec(["diff", "--cached", "--numstat"], cwd).catch(() => ""),
				gitExec(["log", "--oneline", "--format=%h\t%s", "-10"], cwd).catch(
					() => "",
				),
			]);

		const numstat = parseNumstat(numstatRaw);
		const cachedNumstat = parseNumstat(cachedNumstatRaw);

		const files: GitStatusFile[] = [];
		for (const line of porcelain.split("\n")) {
			const parsed = parseStatusLine(line);
			if (!parsed) continue;

			const { status, statusLabel } = classifyFile(
				parsed.index,
				parsed.worktree,
			);
			const stats = numstat.get(parsed.path) ??
				cachedNumstat.get(parsed.path) ?? { add: 0, del: 0 };

			files.push({
				path: parsed.path,
				index: parsed.index,
				worktree: parsed.worktree,
				status,
				statusLabel,
				additions: stats.add,
				deletions: stats.del,
				isSession: sessionFiles.has(parsed.path),
			});
		}

		const log = logRaw
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((l) => {
				const [hash, ...rest] = l.split("\t");
				return { hash, message: rest.join("\t") };
			});

		return c.json({
			cwd,
			branch: branch.trim(),
			files,
			log,
			sessionFiles: [...sessionFiles],
			sessionId: sessionId || null,
		});
	} catch (err) {
		return c.json({ error: (err as Error).message }, 500);
	}
});

app.get("/api/git/diff", async (c) => {
	const sessionId = c.req.query("sessionId")?.trim() ?? "";
	const cwd = await getGitCwd(sessionId);
	if (!cwd) return c.json({ error: "No git repository" }, 404);

	const file = c.req.query("file");
	if (!file) return c.json({ error: "file parameter required" }, 400);

	const resolved = resolveRepoFilePath(cwd, file);
	if (!resolved) return c.json({ error: "Invalid path" }, 400);
	const { absPath, relPath } = resolved;

	try {
		// Try unstaged
		const unstaged = await gitExec(["diff", "--", relPath], cwd);
		if (unstaged.trim()) return c.text(unstaged);

		// Try staged
		const staged = await gitExec(["diff", "--cached", "--", relPath], cwd);
		if (staged.trim()) return c.text(staged);

		// Untracked / new: synthetic full-add diff
		const fileInfo = await stat(absPath);
		if (fileInfo.size > MAX_REVIEW_FILE_BYTES) {
			return c.text("");
		}
		if (await isLikelyBinaryFile(absPath)) {
			return c.text("");
		}

		const content = await readFile(absPath, "utf-8");
		const lines = content.split("\n");
		let diff = `--- /dev/null\n+++ b/${relPath}\n`;
		diff += `@@ -0,0 +1,${lines.length} @@\n`;
		diff += lines.map((l) => `+${l}`).join("\n");
		return c.text(diff);
	} catch (err) {
		return c.json({ error: (err as Error).message }, 500);
	}
});

app.post("/api/review/from-git", async (c) => {
	let body: { files?: string[]; message?: string; sessionId?: string };
	try {
		body = await c.req.json();
	} catch {
		return c.json({ error: "Invalid JSON" }, 400);
	}

	const sessionId = body.sessionId?.trim() ?? "";
	const cwd = await getGitCwd(sessionId);
	if (!cwd) return c.json({ error: "No git repository" }, 404);

	const filePaths = Array.isArray(body.files) ? body.files : [];
	if (filePaths.length === 0)
		return c.json({ error: "No files specified" }, 400);

	const reviewFiles: ReviewFile[] = [];
	const warnings: string[] = [];

	for (const fp of filePaths) {
		const resolved = resolveRepoFilePath(cwd, fp);
		if (!resolved) {
			warnings.push(`Skipped: ${fp} (invalid path)`);
			continue;
		}

		const { absPath, relPath } = resolved;
		try {
			const fileInfo = await stat(absPath);
			if (!fileInfo.isFile()) {
				warnings.push(`Skipped: ${fp} (not a file)`);
				continue;
			}
			if (fileInfo.size > MAX_REVIEW_FILE_BYTES) {
				warnings.push(
					`Skipped: ${fp} (file too large: ${Math.round(fileInfo.size / 1024)}KB)`,
				);
				continue;
			}
			if (await isLikelyBinaryFile(absPath)) {
				warnings.push(`Skipped: ${fp} (binary file)`);
				continue;
			}

			const content = await readFile(absPath, "utf-8");
			reviewFiles.push({
				path: absPath,
				relativePath: relPath,
				content,
				language: detectLang(relPath),
			});
		} catch (err) {
			warnings.push(`Skipped: ${fp} (${(err as Error).message})`);
		}
	}

	if (reviewFiles.length === 0)
		return c.json({ error: "No readable files" }, 400);

	const id = crypto.randomUUID();
	const token = crypto.randomUUID().replace(/-/g, "");
	const session: ReviewSession = {
		id,
		token,
		files: reviewFiles,
		warnings,
		message: typeof body.message === "string" ? body.message : undefined,
		createdAt: Date.now(),
		done: false,
		result: null,
		toolSockets: new Set(),
		uiSockets: new Set(),
	};

	reviewSessions.set(id, session);

	let branch: string | undefined;
	let commit: string | undefined;
	try {
		branch = (await gitExec(["rev-parse", "--abbrev-ref", "HEAD"], cwd)).trim();
		if (!branch) branch = undefined;
	} catch {
		branch = undefined;
	}
	try {
		commit = (await gitExec(["rev-parse", "HEAD"], cwd)).trim();
		if (!commit) commit = undefined;
	} catch {
		commit = undefined;
	}

	try {
		await persistOpenReviewSession(session, {
			cwd,
			branch,
			commit,
			source: "git",
		});
	} catch (error) {
		reviewSessions.delete(id);
		return c.json(
			{ error: (error as Error).message ?? "Failed to persist review" },
			500,
		);
	}

	const openTtlMs = readNumericEnv(
		"RHO_REVIEW_OPEN_TTL_MS",
		24 * 60 * 60 * 1000,
	);
	setTimeout(() => {
		const current = reviewSessions.get(id);
		if (!current) return;
		if (!current.done && Date.now() - current.createdAt > openTtlMs) {
			current.done = true;
			current.result = { cancelled: true, comments: [] };
			void persistReviewCompletion(current).catch((error) => {
				console.warn(
					`Failed to persist review auto-cancel for ${id}: ${(error as Error).message}`,
				);
			});
			reviewSessions.delete(id);
			broadcastUiEvent("review_sessions_changed");
			broadcastUiEvent("review_submissions_changed");
		}
	}, openTtlMs).unref?.();

	const origin = new URL(c.req.url).origin;
	const url = `${origin}/review/${id}?token=${token}`;
	broadcastUiEvent("review_sessions_changed");
	return c.json({ id, token, url });
});
