// A rho core in its own process, for the crash test. It runs a scripted model and one tool that
// records each time it really runs, takes one optional submission, and then waits to be killed
// or to see the conversation go idle.
//   bun crash-host.ts <dir> <script.json> [requestId text]
// script.json is a list of model responses: { text } or { tool, args }.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { obj, str } from "@earendil-works/pi-schema";
import { context, openCore } from "../../src/core.ts";

const [dir = "", scriptPath = "", requestId, text] = process.argv.slice(2);
const say = (event: object) => process.stdout.write(`${JSON.stringify(event)}\n`);
const faux = fauxProvider({ tokensPerSecond: Number(process.env.FAUX_TPS ?? 0) || undefined });
const script = JSON.parse(readFileSync(scriptPath, "utf8")) as ({ text: string } | { tool: string; args: Record<string, string> })[];
// Each response is taken off the script file's remaining list, so a restarted host continues it.
const cursor = join(dir, "script.cursor");
const taken = () => { try { return Number(readFileSync(cursor, "utf8")); } catch { return 0; } };
faux.setResponses(script.slice(taken()).map((step) => () => {
	appendFileSync(join(dir, "model.log"), `${JSON.stringify(step)}\n`);
	Bun.write(cursor, String(taken() + 1));
	return "text" in step ? fauxAssistantMessage(step.text) : fauxAssistantMessage(fauxToolCall(step.tool, step.args), { stopReason: "toolUse" });
}));
const models = createModels();
models.setProvider(faux.provider);

const effect = defineTool({
	name: "effect",
	description: "Record a side effect, slowly.",
	parameters: obj({ label: str() }),
	execute: async (args) => {
		appendFileSync(join(dir, "effects.log"), `${args.label}\n`); // the effect happens first
		say({ event: "tool-started", label: args.label });
		await Bun.sleep(Number(process.env.TOOL_MS ?? 0));
		return { output: [{ type: "text", text: `recorded ${args.label}` }] };
	},
});
const model = faux.getModel();
const core = await openCore({ dir, models, config: { model: `${model.provider}/${model.id}` }, extensions: [defineExtension({ name: "effects", tools: [effect] })], log: (line) => say({ event: "log", line }) });
say({ event: "open", pid: process.pid });
if (requestId && text) {
	const submission = await core.root.submit({ type: "input", content: text, requestId }, context);
	say({ event: "submitted", id: String(submission.id) });
}
await core.harness.waitForIdle(context);
const page = await core.root.entries({ order: "ascending" }, 200, undefined, context);
const entries = page.items.map((entry) => {
	const message = entry.model?.[0] as { role?: string; content?: unknown; stopReason?: string; isError?: boolean } | undefined;
	const content = message?.content;
	const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((part: { type: string; text?: string; name?: string }) => part.text ?? `[${part.type}${part.name ? ` ${part.name}` : ""}]`).join("") : "";
	return { kind: entry.kind, text: text.slice(0, 120), stop: message?.stopReason, isError: message?.isError };
});
say({ event: "idle", entries, answers: entries.filter((entry) => AssistantEntry.kind === entry.kind).length });
await core.close();
