// Guard rails. Reversible work goes on; an action that cannot be undone waits for the person's
// yes; a few things are refused outright.
//
//   refused   deleting a git directory; touching rho's own data (its token and storage)
//   waits     git push, publishing a package, merging or releasing on GitHub
//
// A waiting command is shown to the person with Allow and Deny. Allow grants that exact command
// once. The request and the grant are a document in the conversation, so they survive a restart.
//
// This is a seatbelt, not a boundary: the rules read the command's text, and a command built to
// hide what it does (through a variable, a script file, another interpreter) passes them. The
// model runs as the person, with the person's shell.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, sep } from "node:path";
import type { Context } from "@earendil-works/chord/context";
import { defineDoc, defineExtension, wrapTool, type Conversation, type Extension, type ToolRegistration } from "@earendil-works/pi-durable";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { findTool, grepTool, lsTool } from "./search.ts";

export type Verdict = { kind: "allow" } | { kind: "refuse"; why: string } | { kind: "ask"; what: string };
export type Pending = { id: string; tool: string; command: string; what: string; at: number }; // a type, not an interface: it is stored as JSON
/** Per conversation: commands waiting for a yes, and commands allowed once. */
export const Approvals = defineDoc<{ pending: Pending[]; granted: string[] }>({
	kind: "rho.approvals",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ pending: [], granted: [] }),
	checkpointWhen: () => true,
});

const real = (path: string): string => {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
};
const GIT = String.raw`\bgit(?:\s+(?:-[cC]\s+\S+|--?[\w-]+(?:=\S+)?))*\s+`;
const WAITS: [RegExp, string][] = [
	[new RegExp(`${GIT}push\\b`), "git push"],
	[/\b(?:npm|pnpm|yarn|bun)\s+publish\b/, "publishing a package"],
	[/\bgh\s+(?:release\s+(?:create|delete)|pr\s+merge|repo\s+delete)\b/, "a GitHub release, merge or delete"],
];

/** What the guard says about a shell command. Pure: the text and the paths decide. */
export function judgeCommand(command: string, dataDir: string, home = homedir()): Verdict {
	const names = new Set<string>();
	for (const dir of [dataDir, real(dataDir)]) {
		names.add(dir);
		if (dir.startsWith(home + sep)) for (const short of ["~", "$HOME", "${HOME}"]) names.add(short + dir.slice(home.length));
	}
	if ([...names].some((name) => command.includes(name))) return { kind: "refuse", why: "rho's own data (its token and storage) is not the agent's to read or change." };
	// `rm` of a `.git` directory or anything in one; `.gitignore` and `.github` are not that.
	if (/\brm\b[^\n;|&]*?(?:^|[\s"'/=])\.git(?:\/[^\s"';|&]*)?(?=$|[\s"';|&])/.test(command)) return { kind: "refuse", why: "deleting a git directory destroys history that cannot be rebuilt." };
	for (const [pattern, what] of WAITS) if (pattern.test(command)) return { kind: "ask", what };
	return { kind: "allow" };
}

const inside = (path: string, dir: string): boolean => path === dir || path.startsWith(dir + sep);

/** Answer a waiting request, once. Returns it, or undefined when it no longer waits. */
export async function answerApproval(conversation: Conversation, id: string, allow: boolean, context: Context): Promise<Pending | undefined> {
	return conversation.commit(async (tx) => {
		const doc = await tx.doc(Approvals, conversation.id);
		const index = doc.pending.findIndex((pending) => pending.id === id);
		if (index < 0) return undefined;
		const [pending] = doc.pending.splice(index, 1);
		if (allow) doc.granted.push(pending!.command);
		return { ...pending! };
	}, context);
}

/** The `guard` extension: wraps the tools that touch files or run commands. */
export function guard(dataDir: string): Extension {
	const dirs = [...new Set([dataDir, real(dataDir)])];
	/** Refuse a path in rho's data, also when a link leads there. */
	const checkPath = async (path: unknown, api: Parameters<ToolRegistration["execute"]>[1], context: Context): Promise<void> => {
		const env = api.env;
		if (!env) return;
		const absolute = await env.absolutePath(typeof path === "string" && path !== "" ? path : ".", context);
		if (!absolute.ok) return; // the tool reports a bad path itself
		// Where the path really leads. A file that does not exist yet has no real path of its own,
		// so the nearest directory that does exist is resolved and the rest put back on it.
		let existing = absolute.value;
		let rest = "";
		let canonical = await env.canonicalPath(existing, context);
		while (!canonical.ok && dirname(existing) !== existing) {
			rest = `${sep}${basename(existing)}${rest}`;
			existing = dirname(existing);
			canonical = await env.canonicalPath(existing, context);
		}
		for (const candidate of [absolute.value, ...(canonical.ok ? [canonical.value + rest] : [])]) {
			if (dirs.some((dir) => inside(candidate, dir))) throw new Error("Refused: rho's own data (its token and storage) is not the agent's to read or change.");
		}
	};
	const paths = <T extends ToolRegistration<any, any>>(tool: T) =>
		wrapTool(tool, (inner) => ({ ...inner, execute: async (args: any, api: any, context: Context) => (await checkPath(args.path, api, context), inner.execute(args, api, context)) }) as T);
	const bash = wrapTool(createBashTool(), (inner) => ({
		...inner,
		execute: async (args, api, context) => {
			const verdict = judgeCommand(args.command, dataDir);
			if (verdict.kind === "refuse") throw new Error(`Refused: ${verdict.why} Do not try it another way.`);
			if (verdict.kind === "ask") {
				const command = args.command;
				// One commit: take a waiting grant for this exact command, or leave the request for the person.
				const granted = await api.commit(async (tx) => {
					const doc = await tx.doc(Approvals, api.conversationId);
					const index = doc.granted.indexOf(command);
					if (index >= 0) return doc.granted.splice(index, 1), true;
					if (!doc.pending.some((pending) => pending.command === command)) doc.pending.push({ id: api.callId, tool: "bash", command, what: verdict.what, at: api.now() });
					return false;
				}, context);
				if (!granted) throw new Error(`Not run: ${verdict.what} cannot be undone, so it waits for the person's yes. They are shown the command with Allow and Deny. Stop here and say what it will do; do not try it another way.`);
			}
			return inner.execute(args, api, context);
		},
	}));
	// The wraps differ in their tools' argument types; the extension holds them as plain tool wraps.
	const wraps = [bash, paths(createReadTool()), paths(createWriteTool()), paths(createEditTool()), paths(grepTool), paths(findTool), paths(lsTool)] as unknown as NonNullable<Extension["wraps"]>;
	return defineExtension({ name: "guard", wraps });
}
