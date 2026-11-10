// grep, find and ls as tools of their own, so looking around does not go through `bash`.
// They only read, through the conversation's environment, and stop when the run is stopped.
// Inside a git work tree they see what git sees: tracked files and untracked ones that are not
// ignored. Elsewhere they walk the directory. `.git` and `node_modules` are skipped either way.
import type { Context } from "@earendil-works/chord/context";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { bool, num, obj, opt, str } from "@earendil-works/pi-schema";

const MAX_FILES = 50_000; // files one search will consider
const MAX_FILE_BYTES = 2 * 1024 * 1024; // larger files are not searched
const MAX_LINE = 500; // characters of a line shown, and tested against the pattern
const SKIP = new Set([".git", "node_modules"]);

const stopped = (context: Context): void => {
	if (context.abortSignal?.aborted) throw new Error("Stopped.");
};
function need(env: ExecutionEnv | undefined): ExecutionEnv {
	if (!env) throw new Error("This conversation has no environment to search.");
	return env;
}
async function absolute(env: ExecutionEnv, path: string | undefined, context: Context): Promise<string> {
	const result = await env.absolutePath(path === undefined || path === "" ? "." : path, context);
	if (!result.ok) throw result.error;
	return result.value;
}

/** The files under `root`, as paths relative to it, sorted. `truncated` when there were more than the cap. */
export async function filesUnder(env: ExecutionEnv, root: string, context: Context): Promise<{ files: string[]; truncated: boolean }> {
	let out = "";
	const git = await env.exec(["git", "ls-files", "-co", "--exclude-standard", "-z"], { cwd: root, onOutput: (text, _context, info) => void (info.stream === "stdout" && out.length < 16_000_000 && (out += text)) }, context);
	stopped(context);
	if (git.ok && git.value.exitCode === 0) {
		const files = [...new Set(out.split("\0").filter((file) => file !== "" && !file.split("/").some((part) => SKIP.has(part))))].sort();
		return { files: files.slice(0, MAX_FILES), truncated: files.length > MAX_FILES };
	}
	// Not a git work tree, or no git: walk it.
	const files: string[] = [];
	const queue = [""];
	while (queue.length > 0) {
		stopped(context);
		const dir = queue.shift()!;
		const listed = await env.listDir(dir === "" ? root : `${root}/${dir}`, context);
		if (!listed.ok) {
			if (dir === "") throw listed.error;
			continue; // a directory that cannot be read is skipped
		}
		for (const entry of listed.value) {
			if (SKIP.has(entry.name)) continue;
			const path = dir === "" ? entry.name : `${dir}/${entry.name}`;
			if (entry.kind === "directory") queue.push(path);
			else if (files.push(path) >= MAX_FILES) return { files: files.sort(), truncated: true };
		}
	}
	return { files: files.sort(), truncated: false };
}

/** A glob with no `/` matches a file name at any depth. */
const globFor = (pattern: string) => new Bun.Glob(pattern.includes("/") ? pattern : `**/${pattern}`);
const text = (value: string) => ({ output: [{ type: "text" as const, text: value }] });
const clip = (line: string) => (line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)} [line cut]` : line);
const reasoning = opt(str({ description: "A short phrase: why this call, in context." }));

export const lsTool = defineTool({
	name: "ls",
	description: "List a directory. Directories end in '/'. Sorted; dotfiles included. At most `limit` entries (default 500).",
	parameters: obj({ path: opt(str({ description: "Directory; default the current one." })), limit: opt(num()), reasoning }),
	replay: "safe",
	execute: async (args, api, context) => {
		const env = need(api.env);
		const listed = await env.listDir(await absolute(env, args.path, context), context);
		if (!listed.ok) throw listed.error;
		const limit = Math.max(1, Math.floor(args.limit ?? 500));
		const names = listed.value.map((entry) => (entry.kind === "directory" ? `${entry.name}/` : entry.name)).sort();
		if (names.length === 0) return text("The directory is empty.");
		return text(names.slice(0, limit).join("\n") + (names.length > limit ? `\n[${limit} of ${names.length} entries shown. Raise limit to see more.]` : ""));
	},
});

export const findTool = defineTool({
	name: "find",
	description: "Find files by glob, e.g. '*.ts', 'src/**/*.test.ts'. A pattern with no '/' matches file names at any depth. Returns paths relative to `path`. Skips what git ignores. At most `limit` results (default 1000).",
	parameters: obj({ pattern: str(), path: opt(str({ description: "Directory to search; default the current one." })), limit: opt(num()), reasoning }),
	replay: "safe",
	execute: async (args, api, context) => {
		const env = need(api.env);
		const { files, truncated } = await filesUnder(env, await absolute(env, args.path, context), context);
		const glob = globFor(args.pattern);
		const limit = Math.max(1, Math.floor(args.limit ?? 1000));
		const found = files.filter((file) => glob.match(file));
		if (found.length === 0) return text(`No files match.${truncated ? ` Only the first ${MAX_FILES} files were considered.` : ""}`);
		const notes = [found.length > limit ? `${limit} of ${found.length} files shown. Narrow the pattern or raise limit.` : "", truncated ? `Only the first ${MAX_FILES} files were considered.` : ""].filter(Boolean);
		return text(found.slice(0, limit).join("\n") + (notes.length > 0 ? `\n[${notes.join(" ")}]` : ""));
	},
});

export const grepTool = defineTool({
	name: "grep",
	description: "Search file contents for a regular expression (JavaScript syntax) or, with literal, an exact string. Returns 'path:line: text'. Skips what git ignores, binary files and files over 2 MB. At most `limit` matches (default 100).",
	parameters: obj({
		pattern: str(),
		path: opt(str({ description: "Directory or file to search; default the current directory." })),
		glob: opt(str({ description: "Only files matching this glob, e.g. '*.ts'." })),
		ignoreCase: opt(bool()),
		literal: opt(bool({ description: "Treat the pattern as an exact string." })),
		context: opt(num({ description: "Lines to show before and after each match." })),
		limit: opt(num()),
		reasoning,
	}),
	replay: "safe",
	execute: async (args, api, context) => {
		const env = need(api.env);
		let pattern: RegExp;
		try {
			pattern = new RegExp(args.literal ? args.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") : args.pattern, args.ignoreCase ? "i" : "");
		} catch (error) {
			throw new Error(`The pattern is not a valid regular expression: ${(error as Error).message}`);
		}
		const root = await absolute(env, args.path, context);
		const info = await env.fileInfo(root, context);
		if (!info.ok) throw info.error;
		const single = info.value.kind !== "directory";
		const listing = single ? { files: [""], truncated: false } : await filesUnder(env, root, context);
		const glob = args.glob ? globFor(args.glob) : undefined;
		const limit = Math.max(1, Math.floor(args.limit ?? 100));
		const around = Math.max(0, Math.min(10, Math.floor(args.context ?? 0)));
		const lines: string[] = [];
		let matches = 0;
		let more = false;
		search: for (const file of listing.files) {
			stopped(context);
			if (glob && !single && !glob.match(file)) continue;
			const path = single ? root : `${root}/${file}`;
			const shown = single ? (args.path ?? root) : file;
			if (!single) {
				const size = await env.fileInfo(path, context);
				if (!size.ok || size.value.kind === "directory" || size.value.size > MAX_FILE_BYTES) continue;
			}
			const read = await env.readTextFile(path, context);
			if (!read.ok) {
				if (read.error.code === "aborted") throw new Error("Stopped.");
				continue; // unreadable, or gone since it was listed
			}
			if (read.value.includes("\0")) continue; // binary
			const all = read.value.split("\n");
			let last = -1; // the last line already shown from this file
			for (let index = 0; index < all.length; index++) {
				if (!pattern.test(all[index]!.slice(0, MAX_LINE * 4))) continue;
				if (matches >= limit) {
					more = true;
					break search;
				}
				matches++;
				for (let at = Math.max(last + 1, index - around); at <= Math.min(all.length - 1, index + around); at++) {
					lines.push(at === index ? `${shown}:${at + 1}: ${clip(all[at]!)}` : `${shown}-${at + 1}- ${clip(all[at]!)}`);
					last = at;
				}
			}
		}
		if (matches === 0) return text(`No matches.${listing.truncated ? ` Only the first ${MAX_FILES} files were searched.` : ""}`);
		const notes = [more ? `${limit} matches shown; there are more. Narrow the pattern or raise limit.` : "", listing.truncated ? `Only the first ${MAX_FILES} files were searched.` : ""].filter(Boolean);
		return text(lines.join("\n") + (notes.length > 0 ? `\n[${notes.join(" ")}]` : ""));
	},
});

export const SearchTools = defineExtension({ name: "search-tools", tools: [grepTool, findTool, lsTool] });
