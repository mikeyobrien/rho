import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { context, openCore } from "../src/core.ts";
import { findRho1, migrated, recordMigration, rho1Notice, rhoHome } from "../src/home.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
/** A directory laid out as rho 1 leaves it (the names seen on a real install). */
function rho1(): string {
	const home = mkdtempSync(join(tmpdir(), "rho-home-test-"));
	dirs.push(home);
	for (const dir of ["brain", "vault/notes", "telegram", "results", "logs"]) mkdirSync(join(home, dir), { recursive: true });
	writeFileSync(join(home, "brain", "brain.jsonl"), '{"id":"b1","type":"behavior","category":"do","text":"Be direct"}\n{"id":"l1","type":"learning","text":"Uses pnpm"}\n\n');
	writeFileSync(join(home, "vault", "inbox.md"), "# Inbox\n");
	writeFileSync(join(home, "vault", "notes", "a.md"), "# A\n");
	writeFileSync(join(home, "init.toml"), '[agent]\nname = "tau"\n\n[settings.heartbeat]\ninterval = "30m"\n');
	for (const file of ["packages.toml", "rho-state.json", "rho-settings.json", "tmux.conf", "git-context.json", "sync.lock", "web.log"]) writeFileSync(join(home, file), "x");
	writeFileSync(join(home, "telegram", "config.json"), "{}");
	return home;
}
/** Every file under `root` with its size and modification time, for proving nothing changed. */
function snapshot(root: string, skip: string): Record<string, string> {
	const out: Record<string, string> = {};
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const path = join(dir, entry.name);
			if (path === skip) continue;
			if (entry.isDirectory()) walk(path);
			else out[path.slice(root.length)] = `${statSync(path).size}:${statSync(path).mtimeMs}:${readFileSync(path, "utf8")}`;
		}
	};
	walk(root);
	return out;
}

test("rho 2 lives in v2/ of the rho directory, wherever that is", () => {
	expect(rhoHome({ RHO_HOME: "/x" })).toEqual({ home: "/x", dir: "/x/v2" });
	expect(rhoHome({}).home.endsWith("/.rho")).toBe(true);
	expect(rhoHome({}).dir.endsWith("/.rho/v2")).toBe(true);
});

test("rho 1's data is found and counted without being touched", () => {
	const home = rho1();
	const before = snapshot(home, "");
	expect(findRho1(home)).toEqual({ brainEntries: 2, vaultNotes: 2, agentName: "tau", heartbeatInterval: "30m", untouched: ["telegram", "results", "logs", "rho-state.json", "rho-settings.json", "packages.toml"] });
	expect(snapshot(home, "")).toEqual(before);
	const empty = mkdtempSync(join(tmpdir(), "rho-home-test-"));
	dirs.push(empty);
	expect(findRho1(empty)).toBeUndefined();
	expect(findRho1(join(empty, "missing"))).toBeUndefined();
	mkdirSync(join(empty, "v2"));
	expect(findRho1(empty)).toBeUndefined(); // rho 2 alone is not rho 1
});

test("running rho 2 in a rho 1 directory changes nothing outside v2/", async () => {
	const home = rho1();
	const dir = join(home, "v2");
	const before = snapshot(home, dir);
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage("hello")]);
	const models = createModels();
	models.setProvider(faux.provider);
	const model = faux.getModel();
	const core = await openCore({ dir, models, config: { model: `${model.provider}/${model.id}` } });
	await (await core.root.submit({ type: "input", content: "hi" }, context)).wait(context);
	await core.close();
	expect(snapshot(home, dir)).toEqual(before);
	expect(readdirSync(home).sort()).toEqual([...new Set([...Object.keys(before).map((path) => path.split("/")[1]!), "v2", "results", "logs"])].sort());
	expect(readdirSync(dir).some((name) => name.startsWith("rho.sqlite"))).toBe(true);
	expect(statSync(dir).mode & 0o777).toBe(0o700);
});

test("the notice says what has not been carried over, and stops once it has", () => {
	const home = rho1();
	const both = { home, dir: join(home, "v2") };
	expect(rho1Notice(both)).toContain("Not yet carried over: 2 memory entries, 2 vault notes.");
	expect(rho1Notice(both)).toContain("it is left as it is");
	recordMigration(both.dir, "brain", "2 entries copied", new Date("2026-11-10T00:00:00Z"));
	expect(migrated(both.dir)).toEqual({ brain: { at: "2026-11-10T00:00:00.000Z", detail: "2 entries copied" } });
	expect(rho1Notice(both)).toContain("Not yet carried over: 2 vault notes.");
	recordMigration(both.dir, "vault", "2 notes copied");
	expect(Object.keys(migrated(both.dir))).toEqual(["brain", "vault"]); // the earlier record is kept
	expect(rho1Notice(both)).not.toContain("Not yet carried over");
	const empty = mkdtempSync(join(tmpdir(), "rho-home-test-"));
	dirs.push(empty);
	expect(rho1Notice({ home: empty, dir: join(empty, "v2") })).toBeUndefined();
});
