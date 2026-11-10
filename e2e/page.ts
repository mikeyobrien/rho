// The page in the real browser on this phone, against a scratch rho with its own data, so the
// person's real conversation is never touched. Needs Shizuku (rish) and an unlocked screen.
//
//   bun e2e/page.ts
//
// It takes the browser to the front for about a minute, types into the rho page only, makes one
// model request (Haiku), and brings Termux back. Not part of `bun test`.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.ts";
// @ts-expect-error a plain JavaScript helper
import * as device from "./device.mjs";

const out = join(import.meta.dir, "out");
const home = mkdtempSync(join(tmpdir(), "rho-e2e-"));
const port = 4871;
const host = `127.0.0.1:${port}`;
mkdirSync(join(home, "v2"), { recursive: true });
writeFileSync(join(home, "v2", "config.json"), JSON.stringify({ model: process.env.E2E_MODEL ?? "claude-code/claude-haiku-5-5", thinking: "low" }));
const links: string[] = [];
const cli = { env: { ...process.env, RHO_HOME: home, RHO_PORT: String(port) }, out: (line: string) => console.log(`  rho: ${line}`), openLink: (url: string) => (links.push(url), true) };

let failed = false;
async function step(name: string, body: () => Promise<string | void>) {
	const started = Date.now();
	try {
		const note = await body();
		console.log(`ok   ${name}${note ? `: ${note}` : ""} (${((Date.now() - started) / 1000).toFixed(0)} s)`);
	} catch (error) {
		failed = true;
		console.log(`FAIL ${name}: ${(error as Error).message}`);
		await device.shot(`fail-${Date.now()}.png`, out).catch(() => undefined);
		throw error;
	}
}
// Chrome's UI tree carries the page's ids only on controls and landmarks (input, send,
// menu-button, thread). Text elements arrive without ids, so they are found by position and words.
const below = (node: any): any[] => (node ? [node, ...node.children.flatMap(below)] : []);
const texts = (node: any): string[] => below(node).map((n) => n.text).filter(Boolean);
/** The status line: the page's first text after its title. */
const status = (screen: any): string => {
	const words = texts(screen.web);
	return words[words.indexOf("rho") + 1] ?? "";
};
/** The thread's words. Chrome gives a log region as one run of text, so entries are not separable here. */
const thread = (screen: any): string => texts(screen.byId("thread")).join("");
const count = (hay: string, needle: string): number => hay.split(needle).length - 1;
const live = (screen: any) => screen.package === device.BROWSER && screen.address().startsWith(host) && /^[\w-]+\/[\w.-]+$/.test(status(screen));

const problem = await device.ready();
if (problem) {
	console.log(`Not run: ${problem}`);
	process.exit(2);
}
try {
	await step("rho open gives a pairing link, and the page opens paired and empty", async () => {
		if ((await run(["open"], cli)) !== 0) throw new Error("rho did not start");
		await device.open(links[0]);
		const screen = await device.until("the page to go live", (s: any) => live(s) && s, 40_000);
		if (!/No messages yet/.test(texts(screen.byId("thread")).join(" "))) throw new Error("the empty state is not shown");
		if (screen.address().includes("pair=")) throw new Error("the pairing code is still in the address");
		await device.shot("1-empty.png", out);
		return status(screen);
	});
	await step("layout: touch targets are at least 44 px and nothing leaves the page", async () => {
		await device.hideKeyboard();
		const scale = await device.density();
		const screen = await device.read();
		const web = screen.web.box;
		const sizes: string[] = [];
		for (const id of ["send", "input", "menu-button"]) {
			const box = screen.byId(id).box;
			sizes.push(`${id} ${Math.round(box.w / scale)}x${Math.round(box.h / scale)}`);
			if (box.h / scale < 43.5 || box.w / scale < 43.5) throw new Error(`${id} is too small: ${sizes.at(-1)} css px`);
			if (box.x1 < web.x1 || box.x2 > web.x2 || box.y2 > web.y2) throw new Error(`${id} is outside the page`);
		}
		return `${sizes.join(", ")} css px; page ${Math.round(web.w / scale)} px wide`;
	});
	await step("a typed question is answered, and drawn once", async () => {
		const words = "What is the capital of Japan? One word.";
		await device.type(words, host);
		const typed = await device.read();
		if (typed.byId("input").text !== words) throw new Error(`the box holds ${JSON.stringify(typed.byId("input").text)}`);
		await device.tap(typed.byId("send"));
		const screen = await device.until("the answer", (s: any) => live(s) && thread(s).includes("Tokyo") && s, 90_000);
		const seen = thread(screen);
		if (count(seen, words) !== 1 || count(seen, "Tokyo") !== 1) throw new Error(`the thread reads ${JSON.stringify(seen)}`);
		if (screen.byId("input").text !== "") throw new Error("the box is not empty after Send");
		await device.hideKeyboard();
		await device.shot("2-answered.png", out);
		return JSON.stringify(seen);
	});
	await step("the menu opens with the model and thinking pickers", async () => {
		const screen = await device.read();
		await device.tap(screen.byId("menu-button"));
		const open = await device.until("the menu", (s: any) => s.byId("new-chat") && s.byId("thinking") && s, 15_000);
		await device.shot("3-menu.png", out);
		await device.rish("input keyevent 111"); // Escape closes it
		return `model ${JSON.stringify(open.byId("model")?.text ?? "")}, thinking ${JSON.stringify(open.byId("thinking")?.text ?? "")}`;
	});
} catch {
	// reported by its step
} finally {
	await run(["stop"], cli);
	await device.rish("am start -n com.termux/.app.TermuxActivity >/dev/null 2>&1").catch(() => undefined); // give the terminal back
	rmSync(home, { recursive: true, force: true });
}
console.log(failed ? "\nthe page check FAILED" : "\nthe page check passed");
process.exit(failed ? 1 : 0);
