/** rho restart — Stop and restart the Rho daemon without attaching. */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import { herdrSessionName } from "../session-host.ts";
import { run as start } from "./start.ts";
import { run as stop } from "./stop.ts";

const CALLER_HERDR_KEYS = [
	"HERDR_ENV",
	"HERDR_SESSION",
	"HERDR_SOCKET_PATH",
	"HERDR_CONFIG_PATH",
	"HERDR_WORKSPACE_ID",
	"HERDR_TAB_ID",
	"HERDR_PANE_ID",
];

function insideDedicatedSession(): boolean {
	const socket = process.env.HERDR_SOCKET_PATH || "";
	return socket.includes(`/sessions/${herdrSessionName()}/`);
}

function continueOutsideSession(): void {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of CALLER_HERDR_KEYS) delete env[key];
	const indexPath = path.resolve(
		path.dirname(fileURLToPath(import.meta.url)),
		"..",
		"index.ts",
	);
	const child = spawn(
		process.execPath,
		["--experimental-strip-types", "--no-warnings", indexPath, "restart", "--detached"],
		{ detached: true, stdio: "ignore", env },
	);
	child.unref();
}

export async function run(args: string[]): Promise<void> {
	if (args.includes("--help") || args.includes("-h")) {
		console.log(`rho restart

Stop and restart the Rho heartbeat daemon and dedicated session.
Does not attach. An in-session restart survives the session teardown.

Options:
  -h, --help   Show this help`);
		return;
	}

	if (args.includes("--detached")) {
		await stop([]);
		await start([]);
		return;
	}

	// stop() tears the session down. If this process is inside it, start() never runs.
	if (insideDedicatedSession()) {
		continueOutsideSession();
		console.log("Restarting the rho daemon outside this session.");
		return;
	}

	await stop([]);
	await start([]);
}
