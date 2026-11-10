// The rho daemon: the core on the person's data directory, Claude on their plan, and the HTTP
// door. It stays up until it is told to stop. A storage failure exits non-zero so a service
// runner starts it again.
import { createModels } from "@earendil-works/pi-ai/models";
import { claudeCodeProvider, CLAUDE_CODE } from "./claude/provider.ts";
import { closeWarmProcesses, sweepStale } from "./claude/relay.ts";
import { openCore, readConfig } from "./core.ts";
import { rho1Notice, rhoHome } from "./home.ts";
import { serve } from "./http.ts";

const log = (line: string) => console.error(line);
const home = rhoHome();
const dir = home.dir;
const port = Number(process.env.RHO_PORT ?? 4780);
sweepStale();
const models = createModels();
models.setProvider(claudeCodeProvider());
await models.refresh({ providers: [CLAUDE_CODE] }).catch((error: Error) => log(`models: could not ask Claude Code for its models: ${error.message}`));
const core = await openCore({ dir, models, config: readConfig(dir, log), log, onFailed: () => setTimeout(() => process.exit(1), 100) });
const server = await serve({ core, models, dir, port, log });
log(`rho: pid ${process.pid} on http://127.0.0.1:${server.port}, data in ${dir}`);
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
