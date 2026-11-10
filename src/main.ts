// Start rho: the core on the person's data directory, with Claude on their plan.
// For now it answers one question given on the command line, or just finishes unfinished work.
//   bun src/main.ts "a question"
import { createModels } from "@earendil-works/pi-ai/models";
import { AssistantEntry } from "@earendil-works/pi-durable";
import { claudeCodeProvider, CLAUDE_CODE } from "./claude/provider.ts";
import { closeWarmProcesses, sweepStale } from "./claude/relay.ts";
import { context, openCore, readConfig } from "./core.ts";
import { rho1Notice, rhoHome } from "./home.ts";

const log = (line: string) => console.error(line);
const home = rhoHome();
const dir = home.dir;
sweepStale();
const models = createModels();
models.setProvider(claudeCodeProvider());
await models.refresh({ providers: [CLAUDE_CODE] }).catch((error: Error) => log(`models: could not ask Claude Code for its models: ${error.message}`));
const core = await openCore({ dir, models, config: readConfig(dir, log), log, onFailed: () => setTimeout(() => process.exit(1), 100) });
log(`rho: data in ${dir}`);
const notice = rho1Notice(home);
if (notice) log(notice);

const question = process.argv.slice(2).join(" ").trim();
if (question !== "") {
	const settled = await (await core.root.submit({ type: "input", content: question }, context)).wait(context);
	if (settled.status === "done" && settled.type === "input") {
		const entry = await core.root.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
		const content = (entry?.model?.[0] as { content?: { type: string; text?: string }[] } | undefined)?.content ?? [];
		console.log(content.filter((part) => part.type === "text").map((part) => part.text).join(""));
	} else log(`rho: no answer (${settled.status}${"reason" in settled ? `: ${String(settled.reason)}` : ""})`);
}
await core.harness.waitForIdle(context);
await core.close();
closeWarmProcesses();
