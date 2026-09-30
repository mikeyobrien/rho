/**
 * Session host selection. Run: npx tsx tests/test-session-host.ts
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { herdrConfigPath, rhoAgentCommand } from "../cli/herdr-client.ts";
import {
	agentIsLive,
	agentIsRho,
	foregroundProcessName,
	herdrAttachCommand,
	herdrSessionName,
	isInteractiveShell,
	paneIdFromWorkspaceCreate,
	parseHerdrServerRunning,
	resolveSessionHost,
	workspaceIdByLabel,
} from "../cli/session-host.ts";

let failed = 0;

function assert(condition: boolean, label: string): void {
	if (condition) {
		console.log(`  PASS: ${label}`);
		return;
	}
	failed += 1;
	console.error(`  FAIL: ${label}`);
}

const autoHerdr = resolveSessionHost({ herdrAvailable: true });
assert(autoHerdr.host === "herdr" && !autoHerdr.error, "auto prefers herdr when installed");

const autoTmux = resolveSessionHost({ herdrAvailable: false });
assert(autoTmux.host === "tmux" && !autoTmux.error, "auto falls back to tmux");

const forced = resolveSessionHost({ requested: "tmux", herdrAvailable: true });
assert(forced.host === "tmux", "explicit tmux wins over an installed herdr");

const missing = resolveSessionHost({ requested: "herdr", herdrAvailable: false });
assert(missing.host === "herdr" && Boolean(missing.error), "forced herdr fails closed when missing");

assert(parseHerdrServerRunning('{"running":true}'), "parses running server");
assert(!parseHerdrServerRunning("not json"), "bad server status is not running");
assert(
	paneIdFromWorkspaceCreate(
		'{"result":{"root_pane":{"pane_id":"w1:p1"}}}',
	) === "w1:p1",
	"reads created pane id",
);
assert(
	workspaceIdByLabel(
		'{"result":{"workspaces":[{"label":"rho","workspace_id":"w9"}]}}',
		"rho",
	) === "w9",
	"finds rho workspace",
);
assert(
	agentIsLive('{"result":{"agents":[{"name":"rho"}]}}', "rho"),
	"detects live rho agent",
);
assert(
	!agentIsRho('{"result":{"agents":[{"name":"rho","agent":"pi"}]}}', "rho"),
	"a renamed pi process is not a rho agent",
);
assert(
	agentIsRho(
		'{"result":{"agents":[{"name":"rho","agent":"rho","pane_id":"w1:p1"}]}}',
		"rho",
	),
	"rho kind and name are required",
);
assert(
	foregroundProcessName(
		'{"result":{"process_info":{"foreground_processes":[{"name":"pi"}]}}}',
	) === "pi",
	"reads the foreground process name",
);
assert(isInteractiveShell("bash") && !isInteractiveShell("pi"), "pi is not a shell prompt");
assert(herdrSessionName({ RHO_HERDR_SESSION: "rho-hermetic" } as NodeJS.ProcessEnv) === "rho-hermetic", "tests can isolate the herdr session");
assert(herdrAttachCommand() === "herdr --session rho", "attach command uses the rho session");
assert(
	herdrAttachCommand() !== "herdr" && !herdrAttachCommand().includes("default"),
	"attach command is not the default Herdr session",
);
assert(
	herdrConfigPath("/home/rho").endsWith("/herdr/sessions/rho/config.toml"),
	"rho herdr config is session-scoped",
);
assert(
	rhoAgentCommand("/opt/rho bin/rho") === "'/opt/rho bin/rho' agent",
	"Herdr launches the Rho agent entry point",
);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rhoHerdrConfig = readFileSync(
	path.join(repoRoot, "configs", "herdr-rho.toml"),
	"utf-8",
);
assert(
	rhoHerdrConfig.includes("resume_agents_on_restore = false"),
	"Herdr native restore cannot bypass rho agent",
);
const cliSource = readFileSync(path.join(repoRoot, "cli", "index.ts"), "utf-8");
assert(
	cliSource.includes('COMMANDS["agent"].load()'),
	"bare rho starts the agent",
);
assert(
	!cliSource.includes('COMMANDS["start"].load()'),
	"bare rho does not start the daemon",
);

if (failed > 0) {
	console.error(`\n${failed} failed`);
	process.exit(1);
}
console.log("\nall passed");
