/**
 * Rho v2 launch isolation. Run: npx tsx tests/test-standalone-launch.ts
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "rho-launch-"));
process.env.HOME = home;

const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "rho-launch-pi-"));
const stubLog = path.join(stubDir, "pi.log");
fs.writeFileSync(
	path.join(stubDir, "pi"),
	`#!/bin/bash
printf '%s\n' "PI_CODING_AGENT_DIR=\${PI_CODING_AGENT_DIR-}" >> ${JSON.stringify(stubLog)}
printf '%s\n' "PI_CODING_AGENT_SESSION_DIR=\${PI_CODING_AGENT_SESSION_DIR-}" >> ${JSON.stringify(stubLog)}
printf '%s\n' "args=\$*" >> ${JSON.stringify(stubLog)}
sleep 5
`,
);
fs.chmodSync(path.join(stubDir, "pi"), 0o755);
process.env.PATH = `${stubDir}${path.delimiter}${process.env.PATH ?? ""}`;

const { planDaemonLaunch, skillProviderScope } = await import(
	"../cli/pi-launch.ts"
);
const { resolveRhoPaths } = await import("../cli/rho-paths.ts");
const { resolveSessionFile } = await import(
	"../extensions/telegram/session-map.ts"
);
const { DEFAULT_SESSION_DIR } = await import("../web/session-reader-types.ts");
const { buildRpcLaunch } = await import("../web/rpc-manager.ts");

let failed = 0;

function assert(condition: boolean, label: string): void {
	if (condition) {
		console.log(`  PASS: ${label}`);
		return;
	}
	failed += 1;
	console.error(`  FAIL: ${label}`);
}

const paths = resolveRhoPaths(home);
const ordinary = paths.ordinaryPiAgentDir;
const sentinelSettings = path.join(ordinary, "settings.json");
const sentinelAuth = path.join(ordinary, "auth.json");
const sentinelSession = path.join(ordinary, "sessions", "keep.jsonl");
fs.mkdirSync(path.dirname(sentinelSession), { recursive: true });
fs.writeFileSync(sentinelSettings, "settings-sentinel\n");
fs.writeFileSync(sentinelAuth, "auth-sentinel\n");
fs.writeFileSync(sentinelSession, "session-sentinel\n");
const before = new Map(
	[sentinelSettings, sentinelAuth, sentinelSession].map((file) => [
		file,
		fs.readFileSync(file),
	]),
);

const plan = planDaemonLaunch({
	piBin: path.join(stubDir, "pi"),
	paths,
	tmuxBaseArgs: ["-L", "rho-test"],
	sessionName: "rho",
});
assert(plan.ok, "daemon launch plans");
assert(plan.cwd === paths.workspaceDir, "daemon cwd is Rho workspace");
assert(
	plan.env.PI_CODING_AGENT_DIR === paths.piAgentDir,
	"daemon env agent dir",
);
assert(
	plan.env.PI_CODING_AGENT_SESSION_DIR === undefined,
	"daemon env does not force a session dir",
);
assert(
	plan.tmuxCommands[0]?.includes("new-session"),
	"tmux session is created before environment is set",
);
assert(
	plan.tmuxCommands.some(
		(args) =>
			args.includes("PI_CODING_AGENT_DIR") && args.includes(paths.piAgentDir),
	),
	"tmux receives isolated agent dir",
);
assert(
	!plan.piCommand.includes("--session-dir"),
	"daemon command does not force a session dir",
);
assert(
	plan.piCommand.includes("env -u PI_CODING_AGENT_SESSION_DIR"),
	"daemon command clears an inherited session dir",
);
assert(
	plan.tmuxCommands.some(
		(args) =>
			args.includes("set-environment") &&
			args.includes("-u") &&
			args.includes("PI_CODING_AGENT_SESSION_DIR"),
	),
	"tmux unsets an inherited session dir",
);
assert(
	!planDaemonLaunch({
		piBin: null,
		paths,
		tmuxBaseArgs: ["-L", "rho-test"],
		sessionName: "rho",
	}).ok,
	"missing pi fails the launch plan",
);

const vercel = skillProviderScope("vercel", paths);
assert(vercel.ok === false, "unscoped skill provider is rejected");
const clawhub = skillProviderScope("clawhub", paths);
assert(
	clawhub.ok && clawhub.workdir === paths.piAgentDir,
	"clawhub uses Rho agent dir",
);

const channel = resolveSessionFile({
	updateId: 1,
	chatId: 2,
	chatType: "private",
	userId: 3,
	messageId: 4,
	date: 5,
	text: "hi",
	isReplyToBot: false,
});
assert(
	channel.sessionFile.startsWith(paths.sessionDir),
	"channel session uses Rho sessions",
);
assert(
	!channel.sessionFile.includes(`${path.sep}.pi${path.sep}`),
	"channel session avoids ordinary Pi",
);
assert(
	DEFAULT_SESSION_DIR === paths.sessionDir,
	"web session reader uses Rho sessions",
);

const webLaunch = buildRpcLaunch(paths);
assert(webLaunch.command === "pi", "web RPC launches pi");
assert(
	webLaunch.env.PI_CODING_AGENT_DIR === paths.piAgentDir,
	"web RPC sets agent dir",
);
assert(
	webLaunch.env.PI_CODING_AGENT_SESSION_DIR === undefined,
	"web RPC does not force a session dir",
);
assert(
	!webLaunch.args.includes("--session-dir"),
	"web RPC does not pass session dir",
);
assert(webLaunch.args.includes("rpc"), "web RPC uses rpc mode");

for (const [file, bytes] of before) {
	assert(
		fs.readFileSync(file).equals(bytes),
		`ordinary Pi sentinel unchanged: ${path.basename(file)}`,
	);
}

const cli = spawnSync(
	process.execPath,
	["--experimental-strip-types", "--no-warnings", "cli/index.ts", "doctor"],
	{
		cwd: path.resolve("."),
		env: { ...process.env, HOME: home, PATH: process.env.PATH },
		encoding: "utf8",
	},
);
assert(
	cli.status === 0 ||
		(cli.stderr ?? "").includes("not isolated") ||
		(cli.stdout ?? "").includes(paths.piAgentDir) ||
		(cli.stderr ?? "").includes("layout"),
	"doctor does not need ordinary Pi",
);

if (failed > 0) {
	console.error(`\n${failed} failed`);
	process.exit(1);
}
console.log("\nstandalone launch: ok");
