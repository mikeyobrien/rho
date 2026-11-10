// The `rho` command: start, stop, status, open, logs. It talks to the daemon only through its
// files (daemon.json, pair-code, daemon.log) and its health route, so it works the same whether
// rho was started by hand or by a service.
import { spawn } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { preflight, release, type GateHost } from "./gate.ts";
import { rhoHome } from "./home.ts";

export interface CliEnv {
	env: Record<string, string | undefined>;
	out(line: string): void;
	/** Open a link in the person's browser; false when there is no way to here. */
	openLink(url: string): boolean;
	/** The directory the command was run in. Default: the process's. */
	cwd?: string;
}
interface DaemonFile { pid: number; port: number; startedAt: number; commit?: string }
/** The checkout this rho runs from. */
const RELEASE_DIR = resolve(import.meta.dir, "..");

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

/** The gate's hands on the real rho: its command, its files and its door. */
function gateHost(dir: string, cli: CliEnv): GateHost {
	const log = (line: string) => appendFileSync(join(dir, "release.log"), `${new Date().toISOString()} ${line}\n`);
	const quiet = { ...cli, out: log };
	const call = async (path: string, body?: object) => {
		const now = daemonFile(dir);
		if (!now) throw new Error("rho is not running");
		const response = await fetch(`http://127.0.0.1:${now.port}${path}`, { method: body ? "POST" : "GET", headers: { authorization: `Bearer ${readFileSync(join(dir, "token"), "utf8").trim()}`, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10_000) });
		if (!response.ok) throw new Error(`rho answered ${response.status}`);
		return response.json() as Promise<any>;
	};
	return {
		releaseDir: RELEASE_DIR,
		dataDir: dir,
		install: [process.execPath, "install", "--frozen-lockfile"],
		check: [process.execPath, "run", "check"],
		stop: async () => void (await run(["stop"], quiet)),
		start: async () => void (await run(["start"], quiet)),
		healthy: async (commit) => (await running(dir))?.commit === commit,
		idle: async () => ((await call("/api/conversations")).items as { running: boolean }[]).every((item) => !item.running),
		notify: async (text, key) => void (await call("/api/submit", { text, requestId: key, whenBusy: "followUp" })),
		log,
	};
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
		case "release": {
			const file = join(dir, "release.json");
			if (args[1] === "--status") return cli.out(existsSync(file) ? readFileSync(file, "utf8").trim() : "No release yet."), 0;
			const cwd = cli.cwd ?? process.cwd();
			const checked = await preflight(RELEASE_DIR, cwd, args[1] ?? "HEAD");
			if ("refused" in checked) return cli.out(checked.refused), 1;
			try {
				const last = JSON.parse(readFileSync(file, "utf8")) as { status: string; pid?: number };
				if (last.status === "running" && last.pid && alive(last.pid)) return cli.out("A release is already under way. See: rho release --status"), 1;
			} catch {
				// no release yet
			}
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			// The gate runs apart from this command and from rho: the restart must not end it.
			const log = openSync(join(dir, "release.log"), "a", 0o600);
			spawn(process.execPath, [resolve(RELEASE_DIR, "bin", "rho"), "release-run", checked.source, checked.commit], { env: cli.env as NodeJS.ProcessEnv, cwd: RELEASE_DIR, detached: true, stdio: ["ignore", log, log] }).unref();
			closeSync(log);
			cli.out(`Releasing ${checked.commit.slice(0, 7)} (rho runs ${checked.previous.slice(0, 7)}). The gate checks it, then restarts rho onto it; if it does not come up, rho goes back. The result arrives as a message here. Progress: rho release --status`);
			return 0;
		}
		case "release-run": {
			// Not for people: the detached half of `release`.
			const outcome = await release(gateHost(dir, cli), args[1] ?? "", args[2] ?? "HEAD");
			return outcome.status === "released" ? 0 : 1;
		}
		case "logs":
			return cli.out(tail(join(dir, "daemon.log"), Number(args[1]) || 40) || "No log yet."), 0;
		default:
			cli.out("Usage: rho start | stop | status | open | logs [lines] | release [commit] | release --status");
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
