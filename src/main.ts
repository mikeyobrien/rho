// The rho daemon: the core on the person's data directory, the models their keys allow, and the HTTP
// door. It stays up until it is told to stop. A storage failure exits non-zero so a service
// runner starts it again.
import { CLAUDE_CODE } from "./claude/provider.ts";
import { closeWarmProcesses, sweepStale } from "./claude/relay.ts";
import { openCore, readConfig } from "./core.ts";
import { rho1Notice, rhoHome } from "./home.ts";
import { serve } from "./http.ts";
import { findSender, NO_SENDER, openNotifier } from "./notify.ts";
import { chooseModel, keyVariables, openModels, setupOf } from "./providers.ts";

const log = (line: string) => console.error(line);
const home = rhoHome();
const dir = home.dir;
const port = Number(process.env.RHO_PORT ?? 4780);
sweepStale();
const config = readConfig(dir, log);
// The keys are read from a copy of the environment, then taken out of the real one: the bash
// tool and the Claude CLI run with this process's environment and must not see them.
const env = { ...process.env };
const { models, claudePlan } = openModels({ dir, config, env, log });
for (const name of await keyVariables(config)) delete process.env[name];
if (claudePlan) await models.refresh({ providers: [CLAUDE_CODE] }).catch((error: Error) => log(`models: could not ask Claude Code for its models: ${error.message}`));
// Rho starts without a model too: the page and `rho status` then say what is missing.
const model = await chooseModel(models, config);
const core = await openCore({ dir, models, config: { ...config, ...(model ? { model } : {}) }, log, onFailed: () => setTimeout(() => process.exit(1), 100) });
const setup = await setupOf(models, model);
if (!setup.ready) log(`setup: ${setup.note}`);
const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: import.meta.dir, stderr: "ignore" });
const commit = head.exitCode === 0 ? head.stdout.toString().trim() : undefined;
// Scales a photo the person sends to what a model takes. Without it rho still runs, and a large photo is refused.
const images = await import("@earendil-works/pi-durable/images/node").then((module) => module.createNodePhotonImages()).catch((error: Error) => (log(`photos: no image scaling here, so a large photo is refused: ${error.message}`), undefined));
// Notifications go out from here, so they arrive with the page closed. `"notifications": false` turns them off.
const sender = config.notifications === false ? undefined : findSender();
if (config.notifications !== false) log(sender ? `notifications: ${sender.label}` : NO_SENDER);
const notifier = sender ? openNotifier({ dir, sender, open: `http://127.0.0.1:${port}/`, log }) : undefined;
const server = await serve({ core, models, dir, port, commit, images, log, ...(notifier ? { notifier } : {}) });
log(`rho: pid ${process.pid} on http://127.0.0.1:${server.port}, data in ${dir}${commit ? `, commit ${commit.slice(0, 7)}` : ""}`);
const notice = rho1Notice(home);
if (notice) log(notice);

let closing = false;
async function close(): Promise<void> {
	if (closing) return;
	closing = true;
	await server.stop().catch(() => undefined);
	await core.close().catch(() => undefined);
	closeWarmProcesses();
	process.exit(0);
}
process.on("SIGTERM", () => void close());
process.on("SIGINT", () => void close());
