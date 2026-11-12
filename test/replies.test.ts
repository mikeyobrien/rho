import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { context, INSTRUCTIONS, openCore, type Core } from "../src/core.ts";
import { countQuestions, describeReplies, readReplies } from "../src/replies.ts";

const dirs: string[] = [];
const cores: Core[] = [];
afterEach(async () => {
	for (const core of cores.splice(0)) await core.close().catch(() => undefined);
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function open(parent = realpathSync(mkdtempSync(join(tmpdir(), "rho-replies-")))) {
	if (!dirs.includes(parent)) (dirs.push(parent), mkdirSync(join(parent, "data")), mkdirSync(join(parent, "work")));
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const core = await openCore({ dir: join(parent, "data"), models, config: { model: `${faux.getModel().provider}/${faux.getModel().id}`, cwd: join(parent, "work"), delegates: { check: false } }, workerRetryMs: 40 });
	cores.push(core);
	const say = async (text: string) => {
		await (await core.root.submit({ type: "input", content: text }, context)).wait(context);
		await core.harness.waitForIdle(context); // the count is written after the answer settles
	};
	return { core, faux, parent, dir: join(parent, "data"), say };
}

test("questions are counted in the prose of a reply, and apart in its closing paragraph", () => {
	expect(countQuestions("Done. The file is fixed.")).toEqual({ questions: 0, closing: 0 });
	expect(countQuestions("It is fixed.\n\nShall I release it? And should the test stay?")).toEqual({ questions: 2, closing: 2 });
	// A question earlier in the reply is counted, but is not one the reply ends on.
	expect(countQuestions("Why did it fail? The lock was held.\n\nI removed the lock.")).toEqual({ questions: 1, closing: 0 });
	// A closing list of questions is one paragraph.
	expect(countQuestions("Built.\n\n- Which name?\n- Which port?\n- Release now?")).toEqual({ questions: 3, closing: 3 });
	// Code, commands and quotations are not questions to the person.
	expect(countQuestions("Run `ls foo?` and:\n\n```\ngrep 'a?' file\n```\n\n> Can you check?\n\nIt matched.")).toEqual({ questions: 0, closing: 0 });
	expect(countQuestions("The URL is http://x.test/a?b=1 and it works.")).toEqual({ questions: 0, closing: 0 });
	expect(countQuestions("He asked \"is it done?\" twice.")).toEqual({ questions: 1, closing: 1 });
	expect(countQuestions("")).toEqual({ questions: 0, closing: 0 });
});

test("each reply in the person's conversation is one line with no text of the reply; a worker's is not counted", async () => {
	const t = await open();
	t.faux.setResponses(Array.from({ length: 12 }, () => (asked: { messages: { role: string; content: unknown }[] }) => {
		const first = asked.messages.find((message) => message.role === "user")?.content;
		const brief = typeof first === "string" ? first : ((first ?? []) as { text?: string }[]).map((part) => part.text ?? "").join("");
		if (brief.startsWith("You are a worker.")) return fauxAssistantMessage("DONE\nIs this what was wanted? Should I go on?"); // a worker's words, with questions
		const last = asked.messages.at(-1)!;
		const said = typeof last.content === "string" ? last.content : JSON.stringify(last.content);
		if (said.includes("hand it off") && last.role === "user") return fauxAssistantMessage(fauxToolCall("delegate", { action: "start", title: "A job", brief: "Please do the whole job named here and report back what you did and checked." }), { stopReason: "toolUse" });
		if (last.role === "toolResult") return fauxAssistantMessage("Handed off.");
		if (said.includes("[worker")) return fauxAssistantMessage("The worker is done.");
		return fauxAssistantMessage(said.includes("plain") ? "It is done." : "It is done.\n\nShall I release it? Which branch?");
	}));
	await t.say("a plain one");
	await t.say("one that asks");
	expect(readReplies(t.dir).map(({ chars, questions, closing }) => ({ chars, questions, closing }))).toEqual([{ chars: 11, questions: 0, closing: 0 }, { chars: 46, questions: 2, closing: 2 }]);
	expect(JSON.stringify(readReplies(t.dir))).not.toContain("release"); // counts only: none of the reply's words
	expect(readReplies(t.dir).every((line) => line.conversation === t.core.rootId && line.at > 0)).toBe(true);
	// A worker's own answer has two questions and is not the person's reading: no line for it.
	await t.say("hand it off");
	const end = Date.now() + 15_000;
	while (readReplies(t.dir).length < 4 && Date.now() < end) await Bun.sleep(50);
	await t.core.harness.waitForIdle(context);
	expect(readReplies(t.dir).map((line) => line.closing)).toEqual([0, 2, 0, 0]); // "Handed off." and "The worker is done."
	expect(describeReplies(readReplies(t.dir), 1)).toMatch(/^All: 4 replies, 1 ended by asking \(25%\), 2 closing questions in all\.\n\d{4}-\d\d-\d\d \d\d:\d\d · \d+ characters · 0 asked, 0 at the end$/);
	expect(describeReplies([])).toStartWith("No replies counted yet.");
}, 40_000);

test("a conversation made by an older rho takes the current instructions at the next start", async () => {
	const first = await open();
	expect((await first.core.root.agent(context)).instructions).toBe(INSTRUCTIONS);
	expect(INSTRUCTIONS).toContain("Do not end a reply with questions.");
	const other = await first.core.create();
	await first.core.root.configure({ instructions: "You are rho, as an older release said it." }, context);
	await first.core.close();
	const second = await open(first.parent);
	expect((await second.core.root.agent(context)).instructions).toBe(INSTRUCTIONS);
	expect((await (await second.core.conversation(other.id))!.agent(context)).instructions).toBe(INSTRUCTIONS);
}, 40_000);
