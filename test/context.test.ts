import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { context, openCore, type Core } from "../src/core.ts";
import { environmentSummary } from "../src/context.ts";

// The project section as the model receives it: a real core, a scripted model that records each request.
const dirs: string[] = [];
const cores: Core[] = [];
afterEach(async () => {
	for (const core of cores.splice(0)) await core.close().catch(() => undefined);
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = (prefix: string) => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	dirs.push(dir);
	return dir;
};
async function open(work: string, reuse?: string) {
	const dir = reuse ?? scratch("rho-context-data-");
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	let today = "2026-03-01T12:00:00Z";
	const core = await openCore({ dir, models, config: { model: `${faux.getModel().provider}/${faux.getModel().id}`, cwd: work }, context: { now: () => new Date(today) } });
	cores.push(core);
	const requests: string[] = []; // each request's system messages, as sent
	const sections: string[] = []; // the project section each request carried
	const record = (reply: ReturnType<typeof fauxAssistantMessage>) => (transcript: { messages: { role: string; sections?: Record<string, string> }[] }) => {
		const system = transcript.messages.filter((message) => message.role === "system");
		requests.push(JSON.stringify(system.map((message) => ({ ...message, timestamp: undefined }))));
		sections.push(system.map((message) => message.sections?.project).findLast((text) => text !== undefined) ?? "");
		return reply;
	};
	const ask = async (text: string, ...replies: ReturnType<typeof fauxAssistantMessage>[]) => {
		faux.setResponses((replies.length > 0 ? replies : [fauxAssistantMessage("ok")]).map((reply) => record(reply) as never));
		await (await core.root.submit({ type: "input", content: text }, context)).wait(context);
	};
	return { core, dir, ask, requests, sections, setDate: (value: string) => void (today = value) };
}

test("the request carries the environment and the AGENTS.md files, outermost first", async () => {
	const top = scratch("rho-context-work-");
	const work = join(top, "packages", "app");
	mkdirSync(work, { recursive: true });
	mkdirSync(join(top, ".git"));
	writeFileSync(join(top, "AGENTS.md"), "Top rule: use tabs.\n");
	writeFileSync(join(top, "packages", "AGENTS.md"), "   \n"); // an empty file is not shown
	writeFileSync(join(work, "AGENTS.md"), "App rule: run bun test before a commit.\n");
	const { ask, sections, dir } = await open(work);
	writeFileSync(join(dir, "AGENTS.md"), "Mine: answer briefly.\n"); // the person's own, beside rho's data
	await ask("hello");
	const text = sections[0]!;
	expect(text.startsWith(`<project cwd=${JSON.stringify(work)}>\n# Environment\n- Working directory: ${work}\n- Git repository: yes\n`)).toBe(true);
	expect(text.endsWith("\n</project>")).toBe(true);
	expect(text).toContain("- Date when this conversation's context was read: 2026-03-01");
	const order = [`## ${join(dir, "AGENTS.md")}\nMine: answer briefly.`, `## ${join(top, "AGENTS.md")}\nTop rule: use tabs.`, `## ${join(work, "AGENTS.md")}\nApp rule: run bun test before a commit.`].map((part) => text.indexOf(part));
	expect(order.every((at) => at > 0)).toBe(true);
	expect([...order].sort((a, b) => a - b)).toEqual(order); // the nearest file comes last, so it wins
	expect(text).not.toContain(join(top, "packages", "AGENTS.md"));
	expect(text).toContain("Where they disagree, the later one wins.");
});

test("the section stays byte-identical across turns, tool rounds, an edited AGENTS.md and a new day", async () => {
	const work = scratch("rho-context-work-");
	writeFileSync(join(work, "AGENTS.md"), "Rule one.\n");
	const { ask, requests, sections, setDate } = await open(work);
	await ask("first");
	writeFileSync(join(work, "AGENTS.md"), "Rule one, rewritten mid-conversation.\n");
	setDate("2026-03-02T09:00:00Z");
	await ask("second", fauxAssistantMessage(fauxToolCall("ls", {}), { stopReason: "toolUse" }), fauxAssistantMessage("listed"));
	await ask("third");
	expect(requests.length).toBe(4);
	expect(new Set(requests).size).toBe(1); // every request's system messages are the same bytes
	expect(sections[3]).toContain("Rule one.\n</project>");
	expect(sections[3]).toContain("2026-03-01");
});

test("the section is read again when the directory changes, after a new chat, and after a restart only if it had not been shown", async () => {
	const a = scratch("rho-context-a-");
	const b = scratch("rho-context-b-");
	writeFileSync(join(a, "AGENTS.md"), "In A.\n");
	writeFileSync(join(b, "AGENTS.md"), "In B.\n");
	const first = await open(a);
	await first.ask("one");
	expect(first.sections[0]).toContain("In A.");
	await first.core.root.configure({ cwd: b }, context);
	await first.ask("two");
	expect(first.sections[1]).toContain(`<project cwd=${JSON.stringify(b)}>`);
	expect(first.sections[1]).toContain("In B.");
	expect(first.sections[1]).not.toContain("In A.");
	// A new chat is a new context: an AGENTS.md edited since is now seen.
	writeFileSync(join(b, "AGENTS.md"), "In B, revised.\n");
	await first.ask("three");
	expect(first.sections[2]).toContain("In B.\n</project>");
	await first.core.root.reset(undefined, context);
	await first.ask("four");
	expect(first.sections[3]).toContain("In B, revised.");
	// A restart mid-conversation keeps the shown bytes: the cache still matches.
	writeFileSync(join(b, "AGENTS.md"), "In B, revised again.\n");
	await first.core.close();
	const second = await open(a, first.dir); // config.cwd is only the first conversation's starting point
	await second.ask("five");
	expect(second.sections[0]).toBe(first.sections[3]!);
});

test("a long AGENTS.md is cut with a pointer to the rest; with none, only the environment is shown", async () => {
	const work = scratch("rho-context-work-");
	writeFileSync(join(work, "AGENTS.md"), `START ${"x".repeat(30_000)} END\n`);
	const long = await open(work);
	await long.ask("hi");
	expect(long.sections[0]).toContain("START xxx");
	expect(long.sections[0]).not.toContain(" END");
	expect(long.sections[0]).toContain(`[This file is longer; read the rest with the read tool: ${join(work, "AGENTS.md")}]`);
	expect(long.sections[0]!.length).toBeLessThan(17_500);
	const bare = await open(scratch("rho-context-bare-"));
	await bare.ask("hi");
	expect(bare.sections[0]).toContain("# Environment");
	expect(bare.sections[0]).toContain("- Git repository: no");
	expect(bare.sections[0]).not.toContain("# Project instructions");
});

test("the environment summary names the system and, on Termux, what differs there", () => {
	const text = environmentSummary("/work/x", new Date("2026-05-06T00:00:00Z"), true);
	expect(text.split("\n").slice(0, 2)).toEqual(["- Working directory: /work/x", "- Git repository: yes"]);
	expect(text).toContain("2026-05-06");
	expect(text.includes("Termux has no /usr")).toBe((process.env.PREFIX ?? "").includes("com.termux"));
});
