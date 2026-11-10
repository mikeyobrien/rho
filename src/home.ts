// Where rho keeps its state, and how rho 2 lives beside rho 1 in the same directory.
//
// Rho 1 keeps loose files in ~/.rho: brain/, vault/, init.toml, telegram/, and others. Rho 2
// reads and writes only ~/.rho/v2/. So one directory serves both: rho 1 keeps working, nothing
// of its is moved or changed, and rho 2 can be removed by deleting v2/.
//
// What can be carried over from rho 1 is copied, never moved, and each copy is recorded in
// v2/migrated.json so it is offered once.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface RhoHome {
	/** The rho directory: `RHO_HOME`, else `~/.rho`. Shared with rho 1 when it is installed. */
	home: string;
	/** Everything rho 2 owns. */
	dir: string;
}
export function rhoHome(env: Record<string, string | undefined> = process.env): RhoHome {
	const home = env.RHO_HOME ?? join(homedir(), ".rho");
	return { home, dir: join(home, "v2") };
}

export interface Rho1Data {
	/** Lines in `brain/brain.jsonl`, rho 1's memory. */
	brainEntries: number;
	/** Markdown notes under `vault/`. */
	vaultNotes: number;
	/** Agent name and heartbeat interval from `init.toml`, when it says. */
	agentName?: string;
	heartbeatInterval?: string;
	/** Parts of rho 1 that hold their own state and are not migrated: listed so the person knows. */
	untouched: string[];
}

function countNotes(dir: string): number {
	let count = 0;
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.isDirectory()) count += countNotes(join(dir, entry.name));
		else if (entry.name.endsWith(".md")) count++;
	}
	return count;
}

/** What rho 1 left in `home`, or undefined when there is no rho 1 there. Reads only; changes nothing. */
export function findRho1(home: string): Rho1Data | undefined {
	if (!existsSync(home)) return undefined;
	const has = (name: string) => existsSync(join(home, name));
	if (!has("brain") && !has("init.toml") && !has("vault")) return undefined;
	const brain = join(home, "brain", "brain.jsonl");
	const init = has("init.toml") ? readFileSync(join(home, "init.toml"), "utf8") : "";
	const value = (key: string) => new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"`, "m").exec(init)?.[1];
	return {
		brainEntries: existsSync(brain) ? readFileSync(brain, "utf8").split("\n").filter((line) => line.trim() !== "").length : 0,
		vaultNotes: has("vault") && statSync(join(home, "vault")).isDirectory() ? countNotes(join(home, "vault")) : 0,
		agentName: value("name"),
		heartbeatInterval: value("interval"),
		untouched: ["telegram", "results", "logs", "rho-state.json", "rho-settings.json", "tasks.jsonl", "packages.toml"].filter(has),
	};
}

interface Migrated { [step: string]: { at: string; detail: string } }
const recordPath = (dir: string) => join(dir, "migrated.json");
export function migrated(dir: string): Migrated {
	try {
		return JSON.parse(readFileSync(recordPath(dir), "utf8")) as Migrated;
	} catch {
		return {};
	}
}
/** Note that a migration step was done, so it is not offered again. */
export function recordMigration(dir: string, step: string, detail: string, now = new Date()): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileSync(recordPath(dir), `${JSON.stringify({ ...migrated(dir), [step]: { at: now.toISOString(), detail } }, null, "\t")}\n`, { mode: 0o600 });
}

/** One line for the log at start, or undefined when there is nothing to say. */
export function rho1Notice(home: RhoHome): string | undefined {
	const found = findRho1(home.home);
	if (!found) return undefined;
	const done = migrated(home.dir);
	const waiting = [
		found.brainEntries > 0 && !done.brain ? `${found.brainEntries} memory entries` : "",
		found.vaultNotes > 0 && !done.vault ? `${found.vaultNotes} vault notes` : "",
	].filter(Boolean);
	return `rho 1 data found in ${home.home}; it is left as it is, and rho 2 uses ${home.dir}.${waiting.length > 0 ? ` Not yet carried over: ${waiting.join(", ")}.` : ""}`;
}
