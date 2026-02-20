/**
 * Git context tracker.
 *
 * Listens to tool events and caches the last git working directory
 * plus files changed in the current pi session to ~/.rho/git-context.json.
 * The rho web server reads this file to power the review dashboard.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";

const CONTEXT_PATH = join(homedir(), ".rho", "git-context.json");

export interface GitContext {
	cwd: string;
	updatedAt: number;
	sessionFiles: string[];
}

const GIT_RE = /(?:^|\s|[;&|])\s*(?:git|gh)\s/;

function looksLikeGit(cmd: string): boolean {
	return GIT_RE.test(cmd);
}

function persist(cwd: string, sessionFiles: string[]): void {
	try {
		mkdirSync(dirname(CONTEXT_PATH), { recursive: true });
		writeFileSync(
			CONTEXT_PATH,
			JSON.stringify({ cwd, updatedAt: Date.now(), sessionFiles }),
		);
	} catch {
		/* best-effort */
	}
}

export function setupGitTracker(pi: any): void {
	const sessionFiles = new Set<string>();
	let trackedCwd: string | null = null;

	function cwd(): string {
		return pi.cwd ?? process.cwd();
	}

	function update(dir?: string): void {
		const d = dir ?? trackedCwd ?? cwd();
		trackedCwd = d;
		persist(d, [...sessionFiles]);
	}

	// Detect git/gh commands in bash tool calls (fires before execution)
	pi.on("tool_call", (event: any) => {
		if (event.toolName === "bash" && looksLikeGit(event.input?.command ?? "")) {
			update(cwd());
		}
	});

	// Detect git/gh from user ! prefix commands
	pi.on("user_bash", (event: any) => {
		if (looksLikeGit(event.command ?? "")) {
			update(event.cwd ?? cwd());
		}
	});

	// Track files changed by edit/write tools (fires after execution)
	pi.on("tool_result", (event: any) => {
		const name = event.toolName;
		if ((name === "edit" || name === "write") && !event.isError) {
			const filePath = event.input?.path;
			if (typeof filePath === "string") {
				const base = trackedCwd ?? cwd();
				const abs = resolve(base, filePath);
				const rel = relative(base, abs);
				if (!rel.startsWith("..")) {
					sessionFiles.add(rel);
					update();
				}
			}
		}
	});
}
