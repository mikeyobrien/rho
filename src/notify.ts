// Notifications: how rho reaches the person when they are not looking. The daemon sends them
// itself, so they arrive with the page closed.
//
// One rule decides what interrupts, and it is short on purpose:
//   needs you   a request waits for their yes
//   failed      a run ended in a failure (not one they stopped)
//   a report    a message they did not write arrived: a check-in's report, the release gate's
// A finished answer never notifies. Nothing notifies while a client has that conversation open:
// the page shows it. A request that was shown in the page and is still waiting when the person
// leaves is notified then.
//
// Android comes first: on Termux the sender is `termux-notification` (the Termux:API app and
// its package). Where there is no sender rho says so once in its log and stays quiet.
//
// What was notified is a small file, so a restart does not ring again for a card that still
// waits. The rest is memory a restart may lose: the first look at a conversation notifies
// nothing that is already there except a waiting request.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StateView } from "./view.ts";

export interface Note {
	/** The same for the same thing: a notification with a key replaces the one before it. */
	key: string;
	title: string;
	text: string;
}
export interface Sender {
	label: string;
	send(note: Note, open: string): Promise<void>;
	/** Take a notification away, when the thing it was about is over. */
	remove?(key: string): Promise<void>;
}

const oneLine = (text: string, most: number): string => {
	const line = text.trim().replace(/\s+/g, " ");
	return line.length > most ? `${line.slice(0, most - 1)}…` : line;
};
const TITLES: Record<string, string> = { "check-in": "rho check-in", gate: "rho release", background: "rho: a background command ended" };

/** What in a conversation's state is worth the person's attention, as notes. Pure. */
export function attention(state: StateView): { approvals: Note[]; failure?: Note; notices: Note[] } {
	const at = `${state.conversation}`;
	const approvals = state.approvals.map((ask) => ({ key: `approval:${at}:${ask.id}`, title: "rho needs your yes", text: `${ask.what}: ${oneLine(ask.command, 160)}` }));
	// A run the person stopped is not news to them.
	const failed = state.failure && state.failure.reason !== "aborted" ? state.failure : undefined;
	const failure = failed && { key: `failure:${at}:${failed.reason}:${state.entries.at(-1)?.id ?? 0}`, title: "rho: the run failed", text: oneLine(`${failed.text}${failed.detail ? ` ${failed.detail}` : ""}`, 240) };
	const notices = state.entries.flatMap((entry) => (entry.role === "notice" ? [{ key: `notice:${at}:${entry.id}`, title: TITLES[entry.from] ?? "rho", text: oneLine(entry.text.replace(/^\[[a-z -]+\]\s*/, ""), 300) }] : []));
	return { approvals, ...(failure ? { failure } : {}), notices };
}

/** Run a command to its end, at most `ms`. Never throws; a command that hangs is killed. */
function run(command: string, args: string[], ms = 10_000): Promise<number> {
	return new Promise((done) => {
		try {
			const child = spawn(command, args, { stdio: "ignore" });
			const timer = setTimeout(() => child.kill("SIGKILL"), ms); // without the Termux:API app the command waits for ever
			child.on("error", () => (clearTimeout(timer), done(127)));
			child.on("close", (code) => (clearTimeout(timer), done(code ?? 1)));
		} catch {
			done(127);
		}
	});
}
const idOf = (key: string): string => `rho-${key.replace(/[^\w-]/g, "-")}`;
/** The way to notify on this machine, or undefined. `which` finds a command's path. */
export function findSender(which: (name: string) => string | null = (name) => Bun.which(name)): Sender | undefined {
	const termux = which("termux-notification");
	if (!termux) return undefined;
	const remover = which("termux-notification-remove");
	return {
		label: "termux-notification",
		// A tap opens rho's page. No buttons: a yes is given on the card, where what it allows can be read.
		send: async (note, open) => void (await run(termux, ["--id", idOf(note.key), "--title", note.title, "--content", note.text, "--priority", "high", "--action", `termux-open-url ${open}`])),
		...(remover ? { remove: async (key: string) => void (await run(remover, [idOf(key)])) } : {}),
	};
}
export const NO_SENDER = "notifications: off, because there is no way to send one here. On Android install the Termux:API app, then run: pkg install termux-api";

export interface Notifier {
	/** The newest state of a conversation, and whether a client has it open now. Returns at once. */
	update(conversation: string, state: StateView, watched: boolean): void;
	/** Resolves when everything started has been sent. */
	idle(): Promise<void>;
}
const KEPT = 300; // keys remembered; a card answered long ago is not asked about again anyway
export function openNotifier(options: { dir: string; sender: Sender; /** What a tap opens. */ open: string; log?: (line: string) => void }): Notifier {
	const path = join(options.dir, "notified.json");
	let told: string[] = [];
	try {
		const stored = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (Array.isArray(stored)) told = stored.filter((key): key is string => typeof key === "string");
	} catch {
		// nothing was notified yet, or the file was cut short: at worst one card rings twice
	}
	const save = () => {
		try {
			writeFileSync(path, JSON.stringify(told.slice(-KEPT)), { mode: 0o600 });
		} catch (error) {
			options.log?.(`notifications: could not remember what was sent: ${(error as Error).message}`);
		}
	};
	const known = new Map<string, Set<string>>(); // per conversation: failures and reports already there or already told
	let chain: Promise<void> = Promise.resolve();
	const later = (work: () => Promise<void>) => void (chain = chain.then(work).catch((error: unknown) => options.log?.(`notifications: ${String((error as Error)?.message ?? error)}`)));
	const ring = (note: Note) => later(() => options.sender.send(note, options.open));
	return {
		update(conversation, state, watched) {
			const now = attention(state);
			// A request that is over takes its notification with it.
			const waiting = new Set(now.approvals.map((note) => note.key));
			const over = told.filter((key) => key.startsWith(`approval:${conversation}:`) && !waiting.has(key));
			if (over.length > 0) {
				told = told.filter((key) => !over.includes(key));
				save();
				for (const key of over) if (options.sender.remove) later(() => options.sender.remove!(key));
			}
			// A waiting request rings once, and only while nobody has the conversation open.
			const fresh = watched ? [] : now.approvals.filter((note) => !told.includes(note.key));
			if (fresh.length > 0) {
				told = [...told, ...fresh.map((note) => note.key)];
				save();
				fresh.forEach(ring);
			}
			// Failures and reports: what is there at the first look, or seen in the page, is not rung.
			const first = !known.has(conversation);
			const seen = known.get(conversation) ?? new Set<string>();
			known.set(conversation, seen);
			for (const note of [...(now.failure ? [now.failure] : []), ...now.notices]) {
				if (seen.has(note.key)) continue;
				seen.add(note.key);
				if (!first && !watched) ring(note);
			}
		},
		idle: () => chain,
	};
}
