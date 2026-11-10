// The self-build proof, driven from the page in the real browser on this phone, against the
// real rho (its real home, its service, a real model). Needs Shizuku and an unlocked screen.
//
//   bun e2e/selfbuild.ts
//
// It asks rho, through the page, to make a small change to itself, commit it, and release it;
// taps Allow on the release when rho asks; waits for the gate; then asks a question of the rho
// that came up. It makes real model requests and changes this repository. Not part of `bun test`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/cli.ts";
import { rhoHome } from "../src/home.ts";
// @ts-expect-error a plain JavaScript helper
import * as device from "./device.mjs";

const out = join(import.meta.dir, "out");
const { dir } = rhoHome();
const stamp = () => new Date().toISOString().slice(11, 19);
const say = (line: string) => console.log(`${stamp()} ${line}`);
const daemon = () => JSON.parse(readFileSync(join(dir, "daemon.json"), "utf8")) as { pid: number; port: number; commit: string };
const releaseState = (): { status: string; commit?: string; previous?: string; stage?: string; reason?: string } => {
	try {
		return JSON.parse(readFileSync(join(dir, "release.json"), "utf8"));
	} catch {
		return { status: "none" };
	}
};
const below = (node: any): any[] => (node ? [node, ...node.children.flatMap(below)] : []);
const texts = (node: any): string[] => below(node).map((n) => n.text).filter(Boolean);
const status = (screen: any): string => {
	const words = texts(screen.web);
	return words[words.indexOf("rho") + 1] ?? "";
};
const thread = (screen: any): string => texts(screen.byId("thread")).join(" ");

const problem = await device.ready();
if (problem) {
	say(`Not run: ${problem}`);
	process.exit(2);
}
const links: string[] = [];
if ((await run(["open"], { env: process.env, out: (line) => say(`rho: ${line}`), openLink: (url) => (links.push(url), true) })) !== 0) process.exit(1);
const before = daemon();
const host = `127.0.0.1:${before.port}`;
const live = (screen: any) => screen.package === device.BROWSER && screen.address().startsWith(host) && /^[\w-]+\/[\w.-]+$/.test(status(screen));
const send = async (words: string) => {
	await device.clearInput(host); // a failed earlier try may have left words in the box
	await device.type(words, host);
	const typed = await device.read();
	if (typed.byId("input").text !== words) throw new Error(`the box holds ${JSON.stringify(typed.byId("input").text)}`);
	await device.tap(typed.byId("send"));
	await device.hideKeyboard();
};
let failed = false;
try {
	say(`rho runs ${before.commit.slice(0, 7)} (pid ${before.pid})`);
	await device.open(links[0]);
	await device.until("the page to go live", (s: any) => live(s) && s, 40_000);
	say(`page is live: ${status(await device.read())}`);

	await send(process.env.SELFBUILD_ASK ?? "Add a version command to the rho cli in src cli.ts that prints the commit rho runs from, with a test in test cli.test.ts. Run bun run check, commit it on v2, then run rho release from this checkout.");
	say("asked; waiting for the release to need a yes");
	const asked = await device.until("the Allow card", (s: any) => {
		const allow = below(s.web).find((n) => n.text === "Allow" && n.attrs.class.endsWith("Button"));
		return allow && { allow, text: thread(s) };
	}, 600_000);
	await device.shot("selfbuild-1-needs-yes.png", out);
	say(`rho asks: ${/Needs your yes: [^\n]*?(?=Deny|$)/.exec(asked.text)?.[0]?.slice(0, 160) ?? "(card shown)"}`);
	const head = Bun.spawnSync(["git", "log", "-1", "--format=%H %s"], { cwd: join(import.meta.dir, "..") }).stdout.toString().trim();
	say(`work checkout is at ${head.slice(0, 7)} ${head.slice(41)}`);
	await device.tap(asked.allow);
	say("tapped Allow");

	const end = Date.now() + 600_000;
	let last = "";
	for (;;) {
		const state = releaseState();
		const line = `${state.status}${state.stage ? ` (${state.stage})` : ""}`;
		if (line !== last) say(`gate: ${line}`);
		last = line;
		if (state.status !== "running" && state.status !== "none" && state.commit === head.slice(0, 40)) break;
		if (Date.now() > end) throw new Error("the gate did not finish in ten minutes");
		await device.sleep(2_000);
	}
	const state = releaseState();
	if (state.status !== "released") throw new Error(`the gate ended ${state.status}: ${state.reason ?? ""}`);
	const after = daemon();
	say(`rho now runs ${after.commit.slice(0, 7)} (pid ${after.pid}); it ran ${before.commit.slice(0, 7)} (pid ${before.pid})`);
	if (after.commit !== state.commit || after.pid === before.pid) throw new Error("the running rho is not a new process on the new commit");

	await device.until("the page to be live again and idle", (s: any) => live(s) && s, 120_000);
	await device.shot("selfbuild-2-released.png", out);
	// One sentence each: the phone's keyboard capitalises after a full stop, and what is sent must be what was typed.
	await send("Run rho version and tell me which commit you run now");
	const answered = await device.until("the answer with the commit", (s: any) => live(s) && thread(s).split("which commit you run now").at(-1)!.includes(after.commit.slice(0, 7)) && s, 180_000);
	await device.shot("selfbuild-3-answered.png", out);
	say(`answered after the release: ${JSON.stringify(thread(answered).split("which commit you run now").at(-1)!.trim().slice(-200))}`);
} catch (error) {
	failed = true;
	say(`FAILED: ${(error as Error).message}`);
	await device.shot("selfbuild-fail.png", out).catch(() => undefined);
} finally {
	await device.rish("am start -n com.termux/.app.TermuxActivity >/dev/null 2>&1").catch(() => undefined);
}
say(failed ? "the self-build proof FAILED" : "the self-build proof passed");
process.exit(failed ? 1 : 0);
