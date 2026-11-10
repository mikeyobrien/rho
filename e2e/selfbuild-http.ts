// The self-build loop against the real rho, over HTTP instead of the page: ask for a change,
// allow the release when rho asks, wait for the gate, then ask the rho that came up.
// Real model requests; changes this repository. For when the phone's screen is locked.
//
//   bun e2e/selfbuild-http.ts "what to build" "question to ask after"
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { rhoHome } from "../src/home.ts";

const { dir } = rhoHome();
const token = readFileSync(join(dir, "token"), "utf8").trim();
const [ask = "", question = "Which commit do you run now? Run `rho version` and tell me what it prints."] = process.argv.slice(2);
if (ask === "") throw new Error("Say what to build.");
const daemon = () => JSON.parse(readFileSync(join(dir, "daemon.json"), "utf8")) as { pid: number; port: number; commit: string };
const gate = (): { status: string; commit?: string; stage?: string; reason?: string } => { try { return JSON.parse(readFileSync(join(dir, "release.json"), "utf8")); } catch { return { status: "none" }; } };
const say = (line: string) => console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);
const call = async (path: string, body?: object) => {
	const response = await fetch(`http://127.0.0.1:${daemon().port}${path}`, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
	if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
	return response.json() as Promise<any>;
};
async function state(): Promise<any> {
	const response = await fetch(`http://127.0.0.1:${daemon().port}/api/events`, { headers: { authorization: `Bearer ${token}` } });
	const reader = response.body!.getReader();
	let buffer = "";
	while (!buffer.includes("\n\n")) buffer += new TextDecoder().decode((await reader.read()).value);
	await reader.cancel();
	return JSON.parse(buffer.split("\n\n")[0]!.slice(6));
}
let shown = -1;
async function until<T>(what: string, check: (view: any) => T | undefined | false, ms: number): Promise<T> {
	const end = Date.now() + ms;
	for (;;) {
		const view = await state().catch(() => undefined);
		if (view) {
			const calls = view.entries.filter((entry: any) => entry.role === "assistant").flatMap((entry: any) => entry.calls);
			if (shown < 0) shown = calls.length; // only what happens from now on
			for (const made of calls.slice(shown)) say(`   ${made.name}: ${made.reasoning ?? ""} | ${String(made.args.path ?? made.args.command ?? made.args.pattern ?? "").split("\n")[0].slice(0, 70)}`);
			shown = calls.length;
			const found = check(view);
			if (found) return found;
		}
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await Bun.sleep(1_500);
	}
}
const before = daemon();
say(`rho runs ${before.commit.slice(0, 7)} (pid ${before.pid})`);
await until("idle", (view) => !view.running, 60_000);
await call("/api/submit", { text: ask, requestId: `selfbuild-${Date.now()}` });
const asked = await until("the release to need a yes", (view) => view.approvals[0] ?? (!view.running && view.entries.at(-1)?.role === "assistant" && view.entries.at(-1).calls.length === 0 && view.queued.length === 0 ? (() => { throw new Error(`rho stopped without asking to release: ${view.entries.at(-1).text.slice(0, 300)}`); })() : undefined), 900_000);
say(`rho asks for a yes: ${asked.what}: ${asked.command}`);
const head = Bun.spawnSync(["git", "log", "-1", "--format=%H %s"], { cwd: join(import.meta.dir, "..") }).stdout.toString().trim();
say(`rho's commit in the work checkout: ${head.slice(0, 7)} ${head.slice(41)}`);
await call("/api/approve", { id: asked.id, allow: true });
say("allowed");
let last = "";
for (const end = Date.now() + 600_000; ; ) {
	const now = gate();
	const line = `${now.status}${now.stage ? ` (${now.stage})` : ""} ${String(now.commit ?? "").slice(0, 7)}`;
	if (line !== last) say(`gate: ${line}`);
	last = line;
	if (now.status !== "running" && now.commit === head.slice(0, 40)) break;
	if (Date.now() > end) throw new Error("the gate did not finish in ten minutes");
	await Bun.sleep(2_000);
}
if (gate().status !== "released") throw new Error(`the gate ended ${gate().status}: ${gate().reason}`);
await Bun.sleep(1_500);
const after = daemon();
say(`rho now runs ${after.commit.slice(0, 7)} (pid ${after.pid}); before: ${before.commit.slice(0, 7)} (pid ${before.pid})`);
if (after.commit !== head.slice(0, 40) || after.pid === before.pid) throw new Error("the running rho is not a new process on rho's commit");
await until("idle after the restart", (view) => !view.running && view.queued.length === 0, 300_000);
await call("/api/submit", { text: question, requestId: `selfbuild-q-${Date.now()}` });
const done = await until("the answer", (view) => !view.running && view.entries.at(-1)?.role === "assistant" && view.entries.at(-1).text.includes(after.commit.slice(0, 7)) && view, 300_000);
say(`answered after the release: ${JSON.stringify(done.entries.at(-1).text.slice(0, 240))}`);
say("the self-build loop passed (over HTTP)");
