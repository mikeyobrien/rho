// A rho core in its own process, for the check-in kill test. Its clock starts at a fixed time
// and is moved by the number in <dir>/clock, so a test can let hours pass while it is dead.
//   bun checkin-host.ts <dir> [every text]
// The model is scripted from <dir>/script.json and each call is appended to <dir>/model.log.
// What it holds is written to <dir>/state.json several times a second.
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { context, openCore } from "../../src/core.ts";
import { fakeClock } from "./clock.ts";

const [dir = "", every, text] = process.argv.slice(2);
const say = (event: object) => process.stdout.write(`${JSON.stringify(event)}\n`);
// Every process of one test shares one clock: the test's start is 10:00, whenever this process began.
const clock = fakeClock(Date.parse("2026-03-01T10:00:00Z") + (Date.now() - Number(readFileSync(join(dir, "epoch"), "utf8"))), join(dir, "clock"));
const faux = fauxProvider({ tokensPerSecond: Number(process.env.FAUX_TPS ?? 0) || undefined });
const script = JSON.parse(readFileSync(join(dir, "script.json"), "utf8")) as string[];
const cursor = join(dir, "script.cursor");
const taken = () => { try { return Number(readFileSync(cursor, "utf8")); } catch { return 0; } };
// Each response is taken off what is left of the script, so a restarted host continues it.
faux.setResponses(script.slice(taken()).map((reply) => () => {
	appendFileSync(join(dir, "model.log"), `${JSON.stringify(reply.slice(0, 40))}\n`);
	writeFileSync(cursor, String(taken() + 1));
	return fauxAssistantMessage(reply);
}));
const models = createModels();
models.setProvider(faux.provider);
const core = await openCore({ dir: join(dir, "data"), models, config: { model: `${faux.getModel().provider}/${faux.getModel().id}`, cwd: dir }, memory: null, clock, log: (line) => say({ event: "log", line }) });
say({ event: "open", pid: process.pid });
if (every && text) say({ event: "added", reminder: await core.reminders!.add({ text, every }) });
setInterval(async () => {
	const entries = (await core.root.entries({ order: "ascending" }, 200, undefined, context)).items;
	const notices = entries.filter((entry) => entry.kind === "rho.notice").map((entry) => (entry.model?.[0] as { content: string }).content);
	writeFileSync(join(dir, "state.tmp"), JSON.stringify({ pid: process.pid, now: clock.now(), reminders: await core.reminders!.list(), notices, runsInRoot: entries.filter((entry) => entry.kind === "pi.assistant").length }));
	require("node:fs").renameSync(join(dir, "state.tmp"), join(dir, "state.json"));
}, 100);
