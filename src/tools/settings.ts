// The `settings` tool: how the agent changes rho's own settings. The agent cannot open
// config.json (the guard refuses rho's data to every file tool and to the shell), so it proposes
// a change here. The person is shown the setting with its value now and the new one, and rho
// writes it only after their yes.
//
// Only the settings named in SETTINGS can be proposed. The rest of config.json (API keys in
// `memory`, `providers`, the Claude plan, the turn limit) and every other file of rho's data stay
// the person's to edit. A yes is for one exact change from one exact old value: if the file was
// changed in between, the yes is not used and the new change is asked again.
import { chmodSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import { obj, oneOf, opt, str } from "@earendil-works/pi-schema";
import { readDecider } from "../decider.ts";
import { Approvals } from "./guard.ts";
import { isProtected } from "./protected.ts";

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
interface Checks {
	/** `provider/model` ids that can be used now. */
	available(): Promise<string[]>;
}
/** A value as it will be stored, or a refusal in words. */
type Checked = { value: Json } | { refused: string };

const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** The settings the agent may propose a change to. Each check answers for a value of any shape. */
export const SETTINGS: Record<string, { about: string; check(value: Json, checks: Checks): Promise<Checked> | Checked }> = {
	model: {
		about: "provider/model for new conversations",
		check: async (value, checks) => {
			const known = await checks.available();
			return typeof value === "string" && known.includes(value) ? { value } : { refused: `model is one that can be used now, written provider/model. ${known.length > 0 ? `For example: ${known.slice(0, 6).join(", ")}` : "None can be used yet."}` };
		},
	},
	thinking: { about: `thinking level for new conversations: ${THINKING.join(", ")}`, check: (value) => (typeof value === "string" && THINKING.includes(value) ? { value } : { refused: `thinking is one of: ${THINKING.join(", ")}.` }) },
	cwd: {
		about: "the directory new conversations work in",
		check: (value) => {
			if (typeof value !== "string" || !(isAbsolute(value) || /^~(\/|$)/.test(value))) return { refused: "cwd is an absolute directory, or one that starts with ~." };
			const path = resolve(value.replace(/^~(?=\/|$)/, homedir()));
			if (isProtected(path)) return { refused: "cwd cannot be rho's own data directory." };
			if (!existsSync(path) || !statSync(path).isDirectory()) return { refused: "That directory does not exist." };
			return { value: path };
		},
	},
	checkins: { about: "reminders rho runs unattended: true or false", check: (value) => (typeof value === "boolean" ? { value } : { refused: "checkins is true or false." }) },
	decider: {
		about: 'a decision model that labels each shell command: {"baseUrl": "http://127.0.0.1:8098", "model": "clef-flash", "timeoutMs": 4000}. It only watches',
		check: (value) => {
			if (typeof value !== "object" || value === null || Array.isArray(value)) return { refused: 'decider is an object with a "baseUrl".' };
			const extra = Object.keys(value).filter((key) => !["baseUrl", "model", "timeoutMs", "mode"].includes(key));
			if (extra.length > 0) return { refused: `decider takes baseUrl, model, timeoutMs and mode. Not: ${extra.join(", ")}.` };
			if (value.mode !== undefined && value.mode !== "shadow" && value.mode !== "off") return { refused: 'The only decider modes are "shadow" and "off".' };
			if (value.model !== undefined && (typeof value.model !== "string" || value.model === "")) return { refused: "decider.model is a model name." };
			if (value.timeoutMs !== undefined && !(typeof value.timeoutMs === "number" && value.timeoutMs >= 100 && value.timeoutMs <= 60_000)) return { refused: "decider.timeoutMs is 100 to 60000." };
			const said: string[] = [];
			return readDecider({ ...value, mode: "shadow" }, (line) => said.push(line)) ? { value } : { refused: said[0] ?? "That decider cannot be used." };
		},
	},
};
const THEIRS = "Other settings (keys, providers, memory, the Claude plan, limits) are the person's to edit in config.json.";

const show = (value: Json | undefined): string => (value === undefined ? "not set" : JSON.stringify(value));
/** The change as the person is shown it and as their yes is kept: the setting, the new value and the value now. */
export const changeText = (name: string, next: Json | undefined, now: Json | undefined): string => (next === undefined ? `unset ${name} (now ${show(now)})` : `set ${name} to ${show(next)} (now ${show(now)})`);

/** config.json as an object; `{}` when there is none. Throws, in words, when it cannot be read as one. */
function readAll(path: string): Record<string, Json> {
	if (!existsSync(path)) return {};
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		throw new Error("Rho's config.json is not valid JSON, so it was not changed. The person has to fix it by hand first.");
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Rho's config.json is not a JSON object, so it was not changed. The person has to fix it by hand first.");
	return value as Record<string, Json>;
}

export interface SettingsOptions {
	/** Whether a conversation is one of the person's own: only there is somebody to ask. */
	persons(conversation: string): Promise<boolean>;
}
export function settingsTool(dir: string, options: SettingsOptions): Extension {
	const path = join(dir, "config.json");
	const same = (a: Json | undefined, b: Json | undefined): boolean => JSON.stringify(a) === JSON.stringify(b);
	const tool = defineTool({
		name: "settings",
		description:
			"Rho's own settings (its config.json, which you cannot open as a file). list: the settings you may propose a change to, with their values. set {name, value}: value is JSON, or plain text for a word or a path. unset {name}: back to the default. " +
			"A change is shown to the person with the old and the new value and waits for their yes; after it, call this again with the same arguments. A saved change takes effect when rho next starts. " +
			THEIRS,
		parameters: obj({ action: oneOf(["list", "set", "unset"]), name: opt(str()), value: opt(str()) }),
		execute: async (args, api, context) => {
			const all = readAll(path);
			if (args.action === "list") return { output: [{ type: "text", text: `${Object.entries(SETTINGS).map(([name, setting]) => `${name}: ${show(all[name])}\n  ${setting.about}`).join("\n")}\n${THEIRS}` }] };
			const name = args.name ?? "";
			const setting = Object.hasOwn(SETTINGS, name) ? SETTINGS[name]! : undefined;
			if (!setting) throw new Error(`${name === "" ? "name is required." : `"${name}" is not a setting you can propose.`} You can propose: ${Object.keys(SETTINGS).join(", ")}. ${THEIRS}`);
			const now = all[name];
			let next: Json | undefined;
			if (args.action === "set") {
				if (args.value === undefined || args.value.trim() === "") throw new Error("value is required. To go back to the default, use unset.");
				if (args.value.length > 2_000) throw new Error("That value is too long.");
				let given: Json;
				try {
					given = JSON.parse(args.value) as Json;
				} catch {
					given = args.value.trim(); // a bare word or a path
				}
				if (given === null) throw new Error("To go back to the default, use unset.");
				const checked = await setting.check(given, { available: async () => (await api.models.getAvailable()).map((model) => `${model.provider}/${model.id}`) });
				if ("refused" in checked) throw new Error(checked.refused);
				next = checked.value;
			}
			if (same(next, now)) return { output: [{ type: "text", text: `${name} is already ${show(now)}. Nothing was changed.` }] };
			const change = changeText(name, next, now);
			// Rho's own side work (a check-in) has nobody watching: there is no one to ask.
			if (!(await options.persons(String(api.conversationId)))) throw new Error("Not done: a change to rho's settings needs the person's yes, and nobody is here to give it. Report that it was not done and why.");
			// One commit: take a waiting yes for this exact change, or leave the request for the person.
			const granted = await api.commit(async (tx) => {
				const doc = await tx.doc(Approvals, api.conversationId);
				const index = (doc.grants ?? []).findIndex((grant) => grant.tool === "settings" && grant.command === change);
				if (index >= 0) return (doc.grants = doc.grants!.filter((_, at) => at !== index)), true;
				if (!doc.pending.some((pending) => pending.tool === "settings" && pending.command === change)) doc.pending.push({ id: api.callId, tool: "settings", command: change, what: `changing rho's own setting "${name}"`, at: api.now() });
				return false;
			}, context);
			if (!granted) throw new Error(`Not done: a change to rho's settings waits for the person's yes. They are shown it with Allow and Deny: ${change}. Stop here and say what it changes; after their yes, call settings again with the same arguments.`);
			// The yes was for this change from this value, read just above: write it, and only it.
			const after = { ...all };
			if (next === undefined) delete after[name];
			else after[name] = next;
			writeFileSync(`${path}.tmp`, `${JSON.stringify(after, null, "\t")}\n`, { mode: 0o600 });
			chmodSync(`${path}.tmp`, 0o600);
			renameSync(`${path}.tmp`, path);
			return { output: [{ type: "text", text: `Saved: ${change}. It takes effect when rho next starts; the rho that is running now still has the old value.` }] };
		},
	});
	return defineExtension({ name: "settings", tools: [tool] });
}
