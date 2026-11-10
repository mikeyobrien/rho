// Project context: what the agent is told about where it is working, before the conversation.
// An environment summary, then every AGENTS.md from the top of the file system down to the
// conversation's directory, outermost first, so the nearest file has the last word.
//
// The section is sticky, like memory: once a conversation shows it, each request repeats those
// bytes, so the prompt cache holds. It is read again when the conversation's directory changes,
// after a compaction, and in a new chat. An AGENTS.md edited mid-conversation is seen then.
import { existsSync } from "node:fs";
import { arch, homedir, platform, release } from "node:os";
import { dirname, join } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { defineExtension, section, type Extension } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";

const MAX_FILE = 16_000; // characters of one AGENTS.md
const MAX_ALL = 48_000; // characters of all of them
const NAME = "AGENTS.md";

export interface ContextOptions {
	/** The clock, for the date line. Tests change it. */
	now?: () => Date;
	/** A file read before the others: the person's own standing instructions. */
	personal?: string;
}

/** The machine in a few lines. Facts the agent would otherwise spend a tool call to learn. */
export function environmentSummary(cwd: string, now: Date, git: boolean): string {
	const termux = (process.env.PREFIX ?? "").includes("com.termux");
	const lines = [
		`- Working directory: ${cwd}`,
		`- Git repository: ${git ? "yes" : "no"}`,
		`- System: ${termux ? "Android, in Termux" : platform() === "darwin" ? "macOS" : platform()} ${release()}, ${arch()}`,
		`- Home: ${homedir()}`,
		`- Date when this conversation's context was read: ${now.toISOString().slice(0, 10)}`,
	];
	if (termux) lines.push(`- Termux has no /usr, /bin or /tmp: use $PREFIX (${process.env.PREFIX}) and $TMPDIR, and "#!/usr/bin/env" in scripts. Install with pkg, not sudo.`);
	return lines.join("\n");
}

/** Every directory from the root down to `cwd`. */
function ancestors(cwd: string): string[] {
	const dirs = [cwd];
	while (dirname(dirs[0]!) !== dirs[0]) dirs.unshift(dirname(dirs[0]!));
	return dirs;
}

async function read(env: ExecutionEnv, path: string, context: Context): Promise<string | undefined> {
	const result = await env.readTextFile(path, context);
	if (!result.ok) return undefined; // not there, or not readable: it is simply not shown
	const text = result.value.trim();
	return text === "" ? undefined : text;
}

/** The section's text for a conversation working in `cwd`. */
export async function projectContext(env: ExecutionEnv, cwd: string, context: Context, options: ContextOptions = {}): Promise<string> {
	const files: { path: string; text: string }[] = [];
	const paths = [...(options.personal ? [options.personal] : []), ...ancestors(cwd).map((dir) => join(dir, NAME))];
	let room = MAX_ALL;
	for (const path of [...new Set(paths)]) {
		const text = await read(env, path, context);
		if (text === undefined) continue;
		const cut = text.length > Math.min(MAX_FILE, room);
		const kept = text.slice(0, Math.min(MAX_FILE, room));
		files.push({ path, text: cut ? `${kept}\n[This file is longer; read the rest with the read tool: ${path}]` : kept });
		room -= kept.length;
		if (room <= 0) break;
	}
	const git = ancestors(cwd).some((dir) => existsSync(join(dir, ".git")));
	const parts = [`# Environment\n${environmentSummary(cwd, (options.now ?? (() => new Date()))(), git)}`];
	if (files.length > 0) parts.push(`# Project instructions\nFrom ${NAME} files, outermost first. Where they disagree, the later one wins.`, ...files.map((file) => `## ${file.path}\n${file.text}`));
	return parts.join("\n\n");
}

/** The `project` extension: the section above, sticky per conversation directory. */
export function projectExtension(fallbackCwd: string, options: ContextOptions = {}): Extension {
	return defineExtension({
		name: "project",
		sections: [
			section(
				"project",
				async ({ shown, env, agent }, context) => {
					const cwd = agent.cwd ?? fallbackCwd;
					const open = `<project cwd=${JSON.stringify(cwd)}>\n`;
					const kept = shown.project;
					if (kept !== undefined && kept.startsWith(open)) return kept; // same directory: the same bytes
					if (!env) return kept;
					return `${open}${await projectContext(env, cwd, context, options)}\n</project>`;
				},
				{ tag: false }, // wrapped here, so the shown text is the rendered text
			),
		],
	});
}
