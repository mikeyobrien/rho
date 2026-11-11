// Guard rails. Reversible work goes on; an action that cannot be undone waits for the person's
// yes; a few things are refused outright.
//
//   refused   deleting a git directory; touching rho's own data (its token and storage)
//   waits     git push, publishing a package, merging or releasing on GitHub, `rho release`
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
import { recordAnswer } from "../answers.ts";
import { isProtected, protect } from "./protected.ts";
import { findTool, grepTool, lsTool } from "./search.ts";

export type Verdict = { kind: "allow" } | { kind: "refuse"; why: string } | { kind: "ask"; what: string };
export type Pending = { id: string; tool: string; command: string; what: string; at: number; /** What it would do, in lines for the person, when rho could work that out. */ details?: string[] }; // a type, not an interface: it is stored as JSON
/**
 * Per conversation: requests waiting for a yes, and what was allowed once. A yes for a shell
 * command is kept in `granted`; a yes for another tool's request is kept in `grants` under that
 * tool's name, so that no shell command, whatever its text, can be mistaken for it or it for one.
 */
export const Approvals = defineDoc<{ pending: Pending[]; granted: string[]; grants?: { tool: string; command: string }[] }>({
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
/** What a release is called when it waits for a yes. */
export const RELEASE = "putting new code into the running rho";
const GIT = String.raw`\bgit(?:\s+(?:-[cC]\s+\S+|--?[\w-]+(?:=\S+)?))*\s+`;
const WAITS: [RegExp, string][] = [
	[new RegExp(`${GIT}push\\b`), "git push"],
	[/\b(?:npm|pnpm|yarn|bun)\s+publish\b/, "publishing a package"],
	[/\bgh\s+(?:release\s+(?:create|delete)|pr\s+merge|repo\s+delete)\b/, "a GitHub release, merge or delete"],
	// The moment code the agent wrote gets the agent's powers. Its checks are the agent's own too.
	[/\brho\s+release\b(?!\s+--status)/, RELEASE],
];

const REFUSED = "Refused: rho's own data (its token and storage) is not the agent's to read or change.";
/** What the guard says about a shell command. Pure: the text and the paths decide. */
export function judgeCommand(command: string, dataDir: string, home = homedir()): Verdict {
	const names = new Set<string>();
	for (const dir of [dataDir, real(dataDir)]) {
		names.add(dir);
		if (dir.startsWith(home + sep)) for (const short of ["~", "$HOME", "${HOME}"]) names.add(short + dir.slice(home.length));
	}
	const why = "rho's own data (its token and storage) is not the agent's to read or change.";
	if ([...names].some((name) => command.includes(name))) return { kind: "refuse", why };
	// The same directory written from the home directory, where a conversation starts: `.rho/v2/token`.
	for (const dir of [dataDir, real(dataDir)]) {
		if (!dir.startsWith(home + sep)) continue;
		const relative = dir.slice(home.length + 1).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		if (new RegExp(`(?:^|[\\s"'=(;|&<>]|\\./)${relative}(?:$|[/\\s"';|&)<>])`).test(command)) return { kind: "refuse", why };
	}
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
		if (allow && pending!.tool === "bash") doc.granted.push(pending!.command);
		else if (allow) doc.grants = [...(doc.grants ?? []), { tool: pending!.tool, command: pending!.command }]; // assigned, not pushed through `??=`: the document tracks assignments
		return { ...pending! };
	}, context);
}

/** A command the rules let run or made wait, shown to something that only watches (the decider in shadow). Must not throw. */
export type Watch = (seen: { conversation: string; call: string; command: string; cwd?: string; rule: "allow" | "ask" }) => void;

/** The `guard` extension: wraps the tools that touch files or run commands. */
/** Says what a waiting command would do, for its card. May answer nothing. */
export type Explain = (ask: { what: string; command: string; cwd?: string }) => Promise<string[] | undefined>;

export function guard(dataDir: string, persons: (conversation: string) => Promise<boolean> = async () => true, watch?: Watch, explain?: Explain): Extension {
	// The data directory is marked as rho's own by whoever owns it (the core), which also ends
	// that when it closes. A guard made without a core marks it for the life of the process.
	if (!isProtected(dataDir)) protect(dataDir);
	/** Refuse a path in rho's data, also when a link leads there. */
	const checkPath = async (path: unknown, api: Parameters<ToolRegistration["execute"]>[1], context: Context): Promise<void> => {
		const env = api.env;
		if (!env) return;
		const absolute = await env.absolutePath(typeof path === "string" && path !== "" ? path : ".", context);
		if (!absolute.ok) return; // the tool reports a bad path itself
		if (isProtected(absolute.value)) throw new Error(REFUSED);
	};
	const paths = <T extends ToolRegistration<any, any>>(tool: T) =>
		wrapTool(tool, (inner) => ({ ...inner, execute: async (args: any, api: any, context: Context) => (await checkPath(args.path, api, context), inner.execute(args, api, context)) }) as T);
	const bash = wrapTool(createBashTool(), (inner) => ({
		...inner,
		execute: async (args, api, context) => {
			// A command run from inside rho's data needs no path to reach it.
			const cwd = await api.env?.absolutePath(".", context);
			if (cwd?.ok && isProtected(cwd.value)) throw new Error(REFUSED);
			// Every path the command names, resolved: another name for the same directory (a link, or
			// Android's second mount of an app's files) is the same directory.
			const seen = new Map<string, boolean>();
			for (const word of args.command.match(/(?:~|\.{0,2})?\/?[\w.@%+,:~-]+(?:\/[\w.@%+,:~-]*)+|~/g) ?? []) {
				const path = word.startsWith("~") ? homedir() + word.slice(1) : word.startsWith("/") ? word : cwd?.ok ? `${cwd.value}/${word}` : undefined;
				if (path !== undefined && isProtected(path, seen)) throw new Error(REFUSED);
			}
			const verdict = judgeCommand(args.command, dataDir);
			if (verdict.kind === "refuse") throw new Error(`Refused: ${verdict.why} Do not try it another way.`);
			// A command that names rho's own data was refused above and is shown to nobody.
			watch?.({ conversation: String(api.conversationId), call: api.callId, command: args.command, ...(cwd?.ok ? { cwd: cwd.value } : {}), rule: verdict.kind });
			if (verdict.kind === "ask") {
				const command = args.command;
				// Rho's own side work (a check-in) has nobody watching: there is no one to ask.
				if (!(await persons(String(api.conversationId)))) throw new Error(`Not run: ${verdict.what} cannot be undone and needs the person's yes, and nobody is here to give it. Do not try it another way. Report that it was not done and why.`);
				// Worked out before the commit, and again on every ask, so the card says what is true now.
				const details = (await explain?.({ what: verdict.what, command, ...(cwd?.ok ? { cwd: cwd.value } : {}) }).catch(() => undefined))?.slice(0, 14);
				// One commit: take a waiting grant for this exact command, or leave the request for the person.
				const outcome = await api.commit(async (tx) => {
					const doc = await tx.doc(Approvals, api.conversationId);
					const index = doc.granted.indexOf(command);
					if (index >= 0) return doc.granted.splice(index, 1), "granted" as const;
					const waits = doc.pending.some((pending) => pending.tool === "bash" && pending.command === command);
					if (!waits) doc.pending.push({ id: api.callId, tool: "bash", command, what: verdict.what, at: api.now(), ...(details ? { details } : {}) });
					else doc.pending = doc.pending.map(({ details: _old, ...pending }) => (pending.tool === "bash" && pending.command === command ? { ...pending, ...(details ? { details } : {}) } : { ...pending, ...(_old ? { details: _old } : {}) }));
					return waits ? ("waiting" as const) : ("asked" as const);
				}, context);
				// A request shown for the first time is a line in the answer log; asking again while it waits is not.
				if (outcome === "asked") recordAnswer(dataDir, { at: api.now(), event: "asked", id: api.callId, conversation: String(api.conversationId), tool: "bash", what: verdict.what, command });
				if (outcome !== "granted") throw new Error(`Not run: ${verdict.what} cannot be undone, so it waits for the person's yes. They are shown the command with Allow and Deny. Stop here and say what it will do; do not try it another way.`);
			}
			return inner.execute(args, api, context);
		},
	}));
	// The wraps differ in their tools' argument types; the extension holds them as plain tool wraps.
	const wraps = [bash, paths(createReadTool()), paths(createWriteTool()), paths(createEditTool()), paths(grepTool), paths(findTool), paths(lsTool)] as unknown as NonNullable<Extension["wraps"]>;
	return defineExtension({ name: "guard", wraps });
}
