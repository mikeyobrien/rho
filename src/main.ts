// The rho daemon: the core on the person's data directory, the models their keys allow, and the HTTP
// door. It stays up until it is told to stop. A storage failure exits non-zero so a service
// runner starts it again.
import { CLAUDE_CODE } from "./claude/provider.ts";
import { closeWarmProcesses, sweepStale } from "./claude/relay.ts";
import { openCore, readConfig } from "./core.ts";
import { rho1Notice, rhoHome } from "./home.ts";
import { serve } from "./http.ts";
import { chooseModel, openModels, setupOf } from "./providers.ts";

const log = (line: string) => console.error(line);
const home = rhoHome();
const dir = home.dir;
const port = Number(process.env.RHO_PORT ?? 4780);
sweepStale();
const config = readConfig(dir, log);
const { models, claudePlan } = openModels({ dir, config, log });
if (claudePlan) await models.refresh({ providers: [CLAUDE_CODE] }).catch((error: Error) => log(`models: could not ask Claude Code for its models: ${error.message}`));
// Rho starts without a model too: the page and `rho status` then say what is missing.
const model = await chooseModel(models, config);
const core = await openCore({ dir, models, config: { ...config, ...(model ? { model } : {}) }, log, onFailed: () => setTimeout(() => process.exit(1), 100) });
const setup = await setupOf(models, model);
if (!setup.ready) log(`setup: ${setup.note}`);
const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: import.meta.dir, stderr: "ignore" });
const commit = head.exitCode === 0 ? head.stdout.toString().trim() : undefined;
const server = await serve({ core, models, dir, port, commit, log });
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
