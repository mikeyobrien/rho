// Drives the real browser on this phone through Shizuku's rish (the Android shell user).
// Reads the screen as a UI tree, taps nodes by the page's element ids, and types.
//
// Typed input goes to whichever window has focus. So every keystroke is preceded by a check
// that the page's own input field holds focus; otherwise nothing is typed.
import { execFile } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const RISH = process.env.RISH ?? join(homedir(), ".local", "bin", "rish");
// A folder both the shell user and Termux can use. rish cuts piped output at 8 KB, so large
// results travel as files.
const REMOTE = "/sdcard/Android/media/com.termux/rho-e2e";
const LOCAL = join(homedir(), "storage", "media-0", "rho-e2e");
export const BROWSER = process.env.E2E_BROWSER ?? "com.android.chrome";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run one command as the shell user. rish spreads output over stdout and stderr, so `out` is both. */
export function rish(command, timeoutMs = 30_000) {
	return new Promise((resolve, reject) => {
		execFile(RISH, ["-c", `{ ${command}\n} 2>&1`], { timeout: timeoutMs, maxBuffer: 1 << 20 }, (error, stdout, stderr) => {
			if (error && error.killed) reject(new Error(`rish timed out: ${command.slice(0, 80)}`));
			else resolve({ code: error?.code ?? 0, out: `${stdout}\n${stderr}`.trim() });
		});
	});
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (text) =>
	text.replace(/&(#x?[0-9a-fA-F]+|\w+);/g, (whole, name) =>
		name[0] === "#" ? String.fromCodePoint(name[1] === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1))) : (ENTITIES[name] ?? whole));

/** Parse a uiautomator dump into a tree of { attrs, children, parent }. */
export function parseTree(xml) {
	const root = { attrs: {}, children: [] };
	let current = root;
	for (const match of xml.matchAll(/<node\b([^>]*?)(\/?)>|<\/node>/g)) {
		if (match[0] === "</node>") {
			current = current.parent ?? root;
			continue;
		}
		const attrs = {};
		for (const pair of match[1].matchAll(/([\w-]+)="([^"]*)"/g)) attrs[pair[1]] = decode(pair[2]);
		const [x1, y1, x2, y2] = (attrs.bounds ?? "[0,0][0,0]").match(/-?\d+/g).map(Number);
		const node = { attrs, children: [], parent: current, id: attrs["resource-id"] ?? "", text: attrs.text ?? "", desc: attrs["content-desc"] ?? "", box: { x1, y1, x2, y2, w: x2 - x1, h: y2 - y1 } };
		current.children.push(node);
		if (match[2] !== "/") current = node;
	}
	return root;
}

const all = (node) => [node, ...node.children.flatMap(all)];
export const textOf = (node) => [node.text, ...node.children.map(textOf)].filter(Boolean).join("\n");

export class Screen {
	constructor(tree) {
		this.nodes = all(tree).filter((node) => node.attrs.class);
		this.web = this.nodes.find((node) => node.attrs.class.endsWith("WebView"));
		this.package = this.nodes[0]?.attrs.package;
	}
	/** A page element by its HTML id. Page ids arrive bare; native ones carry "package:id/". */
	byId(id) {
		return this.web ? all(this.web).find((node) => node.id === id) : undefined;
	}
	address() {
		return this.nodes.find((node) => /(url_bar|location_bar_edit_text)$/.test(node.id))?.text.replace(/\u200e/g, "") ?? "";
	}
	/** The words of each message row under #entries and #live, in order. */
	rows() {
		return ["entries", "live"].flatMap((id) => (this.byId(id)?.children ?? []).map(textOf)).filter(Boolean);
	}
}

export async function ready() {
	const probe = await rish("id -u; dumpsys power | grep -m1 mWakefulness=; dumpsys window | grep -m1 mDreamingLockscreen=");
	if (!/(^|\n)2000(\n|$)/.test(probe.out)) return "Shizuku is not answering. Start it, then run this again.";
	if (!/mWakefulness=Awake/.test(probe.out)) return "The screen is off.";
	if (/mDreamingLockscreen=true/.test(probe.out)) return "The phone is locked.";
	mkdirSync(LOCAL, { recursive: true });
	await rish(`mkdir -p ${REMOTE}`);
	return undefined;
}

/** Read the focused window's UI tree. An animating page can refuse a dump; that is retried. */
export async function read() {
	for (let attempt = 0; attempt < 4; attempt++) {
		const result = await rish(`rm -f ${REMOTE}/ui.xml; uiautomator dump ${REMOTE}/ui.xml 2>&1 | tail -1`);
		if (/dumped to/.test(result.out)) {
			try {
				return new Screen(parseTree(readFileSync(join(LOCAL, "ui.xml"), "utf8")));
			} catch {
				// The file was not visible yet: read again.
			}
		}
		await sleep(400);
	}
	throw new Error("The screen could not be read (uiautomator gave no dump).");
}

export async function shot(name, outDir) {
	await rish(`screencap -p ${REMOTE}/shot.png`);
	mkdirSync(outDir, { recursive: true });
	copyFileSync(join(LOCAL, "shot.png"), join(outDir, name));
}

export async function open(url) {
	// Single quotes keep the remote shell from reading "#" or "&" in the address.
	await rish(`am start -a android.intent.action.VIEW -d '${url.replace(/'/g, "")}' ${BROWSER} >/dev/null 2>&1`);
}

export async function tap(node) {
	await rish(`input tap ${Math.round((node.box.x1 + node.box.x2) / 2)} ${Math.round((node.box.y1 + node.box.y2) / 2)}`);
}

/** Wait until `check(screen)` returns something truthy; returns it. */
export async function until(what, check, ms = 60_000) {
	const end = Date.now() + ms;
	let last;
	for (;;) {
		try {
			last = await read();
			const value = check(last);
			if (value) return value;
		} catch (error) {
			if (Date.now() > end) throw error;
		}
		if (Date.now() > end) {
			const seen = last ? `package=${last.package} address=${last.address()} page text=${JSON.stringify(textOf(last.web ?? { text: "", children: [] })).slice(0, 300)}` : "nothing read";
			throw new Error(`timed out waiting for: ${what}. Last seen: ${seen}`);
		}
		await sleep(300);
	}
}

/** Put the page's input in focus and prove it, or throw. Nothing is typed without this. */
async function focusInput(pageHost) {
	const screen = await read();
	const input = screen.byId("input");
	if (screen.package !== BROWSER || !screen.address().startsWith(pageHost) || !input) throw new Error(`The rho page is not in front (package ${screen.package}, address ${screen.address()}). Nothing was typed.`);
	if (input.attrs.focused !== "true") {
		await tap(input);
		await sleep(600);
	}
	const after = await read();
	if (after.package !== BROWSER || after.byId("input")?.attrs.focused !== "true") throw new Error("The message box did not take focus. Nothing was typed.");
	return after;
}

/** Type words into the page's message box. Letters, digits, spaces and . , ? only. */
export async function type(words, pageHost) {
	if (!/^[A-Za-z0-9 .,?]+$/.test(words)) throw new Error("e2e text may hold only letters, digits, spaces and . , ?");
	await focusInput(pageHost);
	await rish(`input text '${words.replace(/ /g, "%s")}'`);
	await sleep(300);
}

/** Empty the message box: select all, delete. */
export async function clearInput(pageHost) {
	const screen = await focusInput(pageHost);
	if (screen.byId("input").text === "") return;
	await rish("input keycombination 113 29; input keyevent 67"); // Ctrl+A, Delete
	await sleep(300);
}

export async function hideKeyboard() {
	const shown = await rish("dumpsys input_method | grep -m1 -o 'mInputShown=[a-z]*'");
	if (/true/.test(shown.out)) await rish("input keyevent 111"); // Escape closes the keyboard, not the page
	await sleep(300);
}

export async function density() {
	const result = await rish("wm density");
	const found = [...result.out.matchAll(/density:\s*(\d+)/g)].pop(); // an override, when set, is listed last
	return Number(found?.[1] ?? 420) / 160;
}
