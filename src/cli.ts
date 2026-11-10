// The `rho` command: start, stop, status, open, logs. It talks to the daemon only through its
// files (daemon.json, pair-code, daemon.log) and its health route, so it works the same whether
// rho was started by hand or by a service.
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { rhoHome } from "./home.ts";

export interface CliEnv {
	env: Record<string, string | undefined>;
	out(line: string): void;
	/** Open a link in the person's browser; false when there is no way to here. */
	openLink(url: string): boolean;
}
interface DaemonFile { pid: number; port: number; startedAt: number }

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
function daemonFile(dir: string): DaemonFile | undefined {
	try {
		return JSON.parse(readFileSync(join(dir, "daemon.json"), "utf8")) as DaemonFile;
	} catch {
		return undefined;
	}
}
/** The running daemon, or undefined. Running means its process lives and its door answers. */
async function running(dir: string): Promise<DaemonFile | undefined> {
	const file = daemonFile(dir);
	if (!file || !alive(file.pid)) return undefined;
	const status = await fetch(`http://127.0.0.1:${file.port}/api/health`, { signal: AbortSignal.timeout(3_000) }).then((response) => response.status, () => 0);
	return status === 401 ? file : undefined; // 401: it is rho, and it wants the token
}
const tail = (path: string, lines: number): string => (existsSync(path) ? readFileSync(path, "utf8").trimEnd().split("\n").slice(-lines).join("\n") : "");

async function start(dir: string, cli: CliEnv): Promise<DaemonFile | undefined> {
	const already = await running(dir);
	if (already) return cli.out(`Rho is already running (pid ${already.pid}) at http://127.0.0.1:${already.port}.`), already;
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const log = openSync(join(dir, "daemon.log"), "a", 0o600);
	const before = daemonFile(dir)?.startedAt;
	const child = spawn(process.execPath, [resolve(import.meta.dir, "main.ts")], { env: cli.env as NodeJS.ProcessEnv, detached: true, stdio: ["ignore", log, log] });
	child.unref();
	closeSync(log);
	for (let i = 0; i < 80; i++) {
		const now = await running(dir);
		if (now && now.startedAt !== before) return cli.out(`Rho is running (pid ${now.pid}) at http://127.0.0.1:${now.port}.`), now;
		if (child.exitCode !== null) break;
		await sleep(250);
	}
	cli.out(`Rho did not start. Last lines of ${join(dir, "daemon.log")}:\n${tail(join(dir, "daemon.log"), 6)}`);
	return undefined;
}

/** Run one command; returns the exit code. */
export async function run(args: string[], cli: CliEnv): Promise<number> {
	const { dir } = rhoHome(cli.env);
	switch (args[0]) {
		case "start":
			return (await start(dir, cli)) ? 0 : 1;
		case "stop": {
			const now = await running(dir);
			if (!now) return cli.out("Rho is not running."), 0;
			process.kill(now.pid, "SIGTERM");
			for (let i = 0; i < 80 && alive(now.pid); i++) await sleep(250);
			if (alive(now.pid)) return cli.out(`Rho (pid ${now.pid}) did not stop.`), 1;
			return cli.out("Rho is stopped."), 0;
		}
		case "status": {
			const now = await running(dir);
			cli.out(now ? `Running (pid ${now.pid}) at http://127.0.0.1:${now.port}.` : "Not running.");
			return now ? 0 : 1;
		}
		case "open": {
			const now = await start(dir, cli);
			if (!now) return 1;
			// The code is one use: the page trades it for the token and takes it out of the address.
			const link = `http://127.0.0.1:${now.port}/#pair=${readFileSync(join(dir, "pair-code"), "utf8")}`;
			cli.out(cli.openLink(link) ? "Opened rho in the browser." : `Open this address in a browser on this machine: ${link}`);
			return 0;
		}
		case "logs":
			return cli.out(tail(join(dir, "daemon.log"), Number(args[1]) || 40) || "No log yet."), 0;
		default:
			cli.out("Usage: rho start | stop | status | open | logs [lines]");
			return 2;
	}
}

/** The command as a person runs it: real environment, real browser. */
export async function main(args: string[]): Promise<number> {
	const openLink = (url: string): boolean => {
		for (const opener of ["termux-open-url", "xdg-open", "open"]) {
			if (Bun.which(opener) === null) continue;
			spawn(opener, [url], { stdio: "ignore", detached: true }).unref();
			return true;
		}
		return false;
	};
	return run(args, { env: process.env, out: (line) => console.log(line), openLink });
}
