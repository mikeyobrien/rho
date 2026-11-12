import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { context, INSTRUCTIONS, openCore, type Core } from "../src/core.ts";

// Rho's own instructions: what they hold, and that a conversation made earlier takes them.
const dirs: string[] = [];
const cores: Core[] = [];
afterEach(async () => {
	for (const core of cores.splice(0)) await core.close().catch(() => undefined);
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
async function open(parent = realpathSync(mkdtempSync(join(tmpdir(), "rho-instructions-")))) {
	if (!dirs.includes(parent)) (dirs.push(parent), mkdirSync(join(parent, "data")), mkdirSync(join(parent, "work")));
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const core = await openCore({ dir: join(parent, "data"), models, config: { model: `${faux.getModel().provider}/${faux.getModel().id}`, cwd: join(parent, "work") } });
	cores.push(core);
	return { core, parent };
}

test("the instructions say how to treat the person's attention", () => {
	expect(INSTRUCTIONS).toContain("Do not end a reply with questions.");
	expect(INSTRUCTIONS).toContain("Never ask them whether to do it now or later.");
	expect(INSTRUCTIONS).toContain("waits for the person's yes");
});

test("a conversation made by an older rho takes the current instructions at the next start", async () => {
	const first = await open();
	expect((await first.core.root.agent(context)).instructions).toBe(INSTRUCTIONS);
	const other = await first.core.create();
	await first.core.root.configure({ instructions: "You are rho, as an older release said it." }, context);
	await first.core.close();
	const second = await open(first.parent);
	expect((await second.core.root.agent(context)).instructions).toBe(INSTRUCTIONS);
	expect((await (await second.core.conversation(other.id))!.agent(context)).instructions).toBe(INSTRUCTIONS);
}, 40_000);
