// The `rho` command: start, stop, status, open, logs, version. It talks to the daemon only through its
// files (daemon.json, pair-code, daemon.log) and its health route, so it works the same whether
// rho was started by hand or by a service.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { preflight, release, type GateHost } from "./gate.ts";
import { readConfig } from "./core.ts";
import { rhoHome } from "./home.ts";
import { CLAUDE_PLAN_WARNING, deviceId, LOGIN_WARNING, openModels, SUGGESTED } from "./providers.ts";
import { installService, readService, serviceDown, serviceStatus, serviceUp, uninstallService } from "./service.ts";

export interface CliEnv {
	env: Record<string, string | undefined>;
	out(line: string): void;
	/** Open a link in the person's browser; false when there is no way to here. */
	openLink(url: string): boolean;
	/** The directory the command was run in. Default: the process's. */
	cwd?: string;
	/** Ask for a secret without showing it. Absent when there is nobody to ask. */
	readSecret?(prompt: string): Promise<string>;
	/** Ask for a line that may be shown. Rejects when `signal` fires. Absent when there is nobody to ask. */
	readLine?(prompt: string, signal?: AbortSignal): Promise<string>;
}
interface DaemonFile { pid: number; port: number; startedAt: number; commit?: string; /** The checkout the daemon runs from. */ root?: string }
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
	const before = daemonFile(dir)?.startedAt;
	const service = readService(dir);
	let child: ReturnType<typeof spawn> | undefined;
	if (service) {
		// Installed as a service: the service runs rho, and starts it again when it dies.
		try {
			await serviceUp(service, cli.env);
		} catch (error) {
			return cli.out(`Rho's service could not be started: ${(error as Error).message}`), undefined;
		}
	} else {
		const log = openSync(join(dir, "daemon.log"), "a", 0o600);
		child = spawn(process.execPath, [resolve(import.meta.dir, "main.ts")], { env: cli.env as NodeJS.ProcessEnv, detached: true, stdio: ["ignore", log, log] });
		child.unref();
		closeSync(log);
	}
	for (let i = 0; i < 80; i++) {
		const now = await running(dir);
		if (now && now.startedAt !== before) {
			cli.out(`Rho is running (pid ${now.pid}) at http://127.0.0.1:${now.port}.`);
			const setup = await setupLine(dir, now);
			if (setup.startsWith("Not ready")) cli.out(setup); // a first run says what is missing
			return now;
		}
		if (child && child.exitCode !== null) break;
		await sleep(250);
	}
	cli.out(`Rho did not start. Last lines of ${join(dir, "daemon.log")}:\n${tail(join(dir, "daemon.log"), 6)}`);
	return undefined;
}

/** Start the gate as its own systemd user unit, outside rho's. Returns its pid, or undefined when systemd-run is not there. */
function gateUnit(command: string[], env: Record<string, string | undefined>, log: string): { pid: number | undefined } | undefined {
	if (Bun.which("systemd-run", { PATH: env.PATH ?? "" }) === null) return undefined;
	const unit = `rho-release-${Date.now()}`;
	const pass = ["PATH", "HOME", "RHO_HOME", "RHO_PORT", "RHO_CLAUDE", "RHO_SERVICE", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"].flatMap((name) => (env[name] ? [`--setenv=${name}=${env[name]}`] : []));
	const started = spawnSync("systemd-run", ["--user", "--quiet", "--collect", `--unit=${unit}`, `--working-directory=${RELEASE_DIR}`, `--property=StandardOutput=append:${log}`, `--property=StandardError=append:${log}`, ...pass, ...command], { env: env as NodeJS.ProcessEnv, encoding: "utf8" });
	if (started.status !== 0) return undefined; // fall back to a detached process
	const pid = Number(spawnSync("systemctl", ["--user", "show", "-p", "MainPID", "--value", unit], { env: env as NodeJS.ProcessEnv, encoding: "utf8" }).stdout.trim());
	return { pid: pid > 0 ? pid : undefined };
}

/** One line on whether the running rho has a model it can use. */
async function setupLine(dir: string, now: DaemonFile): Promise<string> {
	try {
		const response = await fetch(`http://127.0.0.1:${now.port}/api/setup`, { headers: { authorization: `Bearer ${readFileSync(join(dir, "token"), "utf8").trim()}` }, signal: AbortSignal.timeout(5_000) });
		const setup = (await response.json()) as { ready: boolean; model?: string; note?: string };
		return setup.ready ? `Model: ${setup.model}.` : `Not ready: ${setup.note}`;
	} catch {
		return "Could not ask rho about its model.";
	}
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
		ready: async () => ((await call("/api/setup")) as { ready: boolean }).ready,
		idle: async () => ((await call("/api/conversations")).items as { running: boolean }[]).every((item) => !item.running),
		notify: async (text, key) => void (await call("/api/submit", { text, requestId: key, from: "gate" })),
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
			const service = readService(dir);
			if (service) serviceDown(service, cli.env); // told to stay down, also when rho is between restarts
			if (!now) return cli.out("Rho is not running."), 0;
			if (!service) process.kill(now.pid, "SIGTERM");
			for (let i = 0; i < 80 && alive(now.pid); i++) await sleep(250);
			if (alive(now.pid)) return cli.out(`Rho (pid ${now.pid}) did not stop.`), 1;
			return cli.out("Rho is stopped."), 0;
		}
		case "status": {
			const now = await running(dir);
			// The commit is the daemon's own word for what it runs; a rho outside git has none to give.
			cli.out(now ? `Running (pid ${now.pid}) at http://127.0.0.1:${now.port}${now.commit ? `, commit ${now.commit.slice(0, 7)}` : ""}.` : "Not running.");
			if (now) cli.out(await setupLine(dir, now));
			return now ? 0 : 1;
		}
		case "login":
		case "logout": {
			// A sign-in with a subscription, run by the provider's own flow in pi-ai. Rho does its own
			// login and keeps its own credential: two programs refreshing one login can end each other's.
			const { models, keys } = openModels({ dir, config: readConfig(dir), env: cli.env });
			// Not Anthropic: a Claude subscription is used only through Claude Code's own requests ("claudePlan").
			const able = models.getProviders().filter((item) => item.auth.oauth && item.id !== "anthropic").map((item) => item.id);
			const provider = args[1];
			if (provider === "anthropic" || provider === "claude-code") return cli.out(`A Claude subscription is not signed in to here. Rho uses it only through Claude Code's own login: set "claudePlan": true in ${join(dir, "config.json")}. For an API key: rho key anthropic`), 2;
			const known = provider === undefined ? undefined : models.getProvider(provider);
			if (!known?.auth.oauth) return cli.out(`${provider === undefined ? "" : known ? `${provider} has no sign-in; it takes a key: rho key ${provider}\n` : `Rho knows no provider called ${provider}.\n`}Usage: rho ${args[0]} <provider>\nProviders with a sign-in: ${able.join(", ")}`), provider === undefined ? 0 : 2;
			if (args[0] === "logout") {
				const had = keys.has(provider!);
				await models.logout(provider!);
				return cli.out(had ? `Removed rho's stored login for ${provider}.` : `Rho has no stored login for ${provider}.`), 0;
			}
			cli.out(LOGIN_WARNING);
			const cancel = new AbortController();
			try {
				await models.login(provider!, "oauth", {
					signal: cancel.signal,
					notify: (event) => {
						if (event.type === "auth_url") cli.out(`${cli.openLink(event.url) ? "Opened the sign-in page in your browser. If it did not open, use this address" : "Open this address in a browser on this machine"}:\n${event.url}${event.instructions ? `\n${event.instructions}` : ""}`);
						else if (event.type === "device_code") cli.out(`Go to ${event.verificationUri} and enter the code ${event.userCode}`);
						else cli.out(event.message);
					},
					prompt: async (prompt) => {
						if (prompt.type === "select") return prompt.options[0]!.id;
						const ask = prompt.type === "secret" ? cli.readSecret : cli.readLine;
						// With nobody to ask, the browser's own return to rho is the only way in: wait for it.
						if (!ask) return new Promise<string>((_resolve, reject) => prompt.signal?.addEventListener("abort", () => reject(new Error("not needed")), { once: true }));
						return ask(`${prompt.message} `, prompt.signal);
					},
				}, { getDeviceId: () => deviceId(dir), agentName: "rho" });
			} catch (error) {
				return cli.out(`Sign-in did not finish: ${(error as Error).message}`), 1;
			}
			const first = (await models.getAvailable(provider!))[0];
			cli.out(`Signed in to ${known.name ?? provider}. The login is stored in ${keys.path} (readable by you only). Rho uses it from the next message${first ? `; pick a model such as ${first.provider}/${first.id} in the page's menu, or restart rho for new conversations to start on it` : ""}.`);
			return 0;
		}
		case "key": {
			// Keys are stored in the data directory, readable by the owner only. A key is never an
			// argument: arguments are kept in shell history and shown to other processes.
			const { models, keys } = openModels({ dir, config: readConfig(dir), env: cli.env });
			const provider = args[1];
			if (provider === undefined) {
				const stored = new Set((await keys.list()).map((item) => item.providerId));
				const lines: string[] = [];
				for (const item of models.getProviders()) {
					const check = await models.checkAuth(item.id).catch(() => undefined);
					if (check) lines.push(`  ${item.id}: ${stored.has(item.id) ? (check.type === "oauth" ? "signed in (rho login)" : "key stored by rho") : `from ${check.source ?? "the environment"}`}`);
				}
				cli.out(lines.length > 0 ? `Providers rho can use now:\n${lines.join("\n")}` : "Rho has no API key yet.");
				cli.out(`To sign in with a subscription instead of a key: rho login <provider>   (${models.getProviders().filter((item) => item.auth.oauth && item.id !== "anthropic").map((item) => item.id).join(", ")})`);
				cli.out(`Add one with: rho key <provider>\n${SUGGESTED.map((item) => `  ${item.id.padEnd(11)}${item.name} (or set ${item.env})`).join("\n")}\nOther providers rho knows: ${models.getProviders().map((item) => item.id).filter((id) => !SUGGESTED.some((item) => item.id === id) && id !== "claude-code").join(", ")}`);
				cli.out(`To use a Claude plan instead of a key, set "claudePlan": true in ${join(dir, "config.json")}. ${CLAUDE_PLAN_WARNING.split(". ").slice(1, 3).join(". ")}.`);
				return 0;
			}
			const known = models.getProvider(provider);
			if (!known || provider === "claude-code") return cli.out(provider === "claude-code" ? `Claude on your plan uses your Claude Code login, not a key. Turn it on with "claudePlan": true in ${join(dir, "config.json")}.` : `Rho knows no provider called ${provider}. See them with: rho key`), 2;
			if (args[2] === "--remove") {
				const had = keys.has(provider);
				await keys.delete(provider);
				return cli.out(had ? `Removed rho's stored key for ${provider}.` : `Rho has no stored key for ${provider}.`), 0;
			}
			if (args[2] !== undefined) return cli.out("A key is not given as an argument, where it would be kept in your shell history. Run: rho key " + provider + "   and paste it when asked."), 2;
			if (!known.auth.apiKey) return cli.out(`${provider} does not take an API key.`), 2;
			if (!cli.readSecret) return cli.out("There is nobody to ask for the key here. Run this in a terminal, or pipe the key in: rho key " + provider + " < file"), 2;
			const key = (await cli.readSecret(`${known.name ?? provider} API key (not shown): `)).trim();
			if (key === "") return cli.out("No key was given; nothing changed."), 1;
			if (/\s/.test(key) || key.length < 8) return cli.out("That does not look like a key (it is too short or has spaces); nothing changed."), 1;
			await keys.modify(provider, async () => ({ type: "api_key", key }));
			cli.out(`Stored the ${provider} key in ${keys.path} (readable by you only). Rho uses it from the next message; a new conversation starts on that provider after: rho stop && rho start`);
			return 0;
		}
		case "open": {
			const now = await start(dir, cli);
			if (!now) return 1;
			// The code is one use: the page trades it for the token and takes it out of the address.
			const link = `http://127.0.0.1:${now.port}/#pair=${readFileSync(join(dir, "pair-code"), "utf8")}`;
			// `--print` is for a browser on another device, reached through a forwarded port.
			if (args[1] === "--print") return cli.out(`Open this address in a browser that reaches this machine's port ${now.port}. It works once: ${link}`), 0;
			cli.out(cli.openLink(link) ? "Opened rho in the browser." : `Open this address in a browser on this machine: ${link}`);
			return 0;
		}
		case "release": {
			// A release is done by the rho that runs, with its gate, whichever checkout's command was typed:
			// the work checkout has a `bin/rho` too, and its code is the candidate, not the judge.
			const root = daemonFile(dir)?.root;
			if (root && existsSync(join(root, "bin", "rho")) && realpathSync(root) !== realpathSync(RELEASE_DIR)) {
				const handed = spawnSync(process.execPath, [join(root, "bin", "rho"), ...args], { cwd: cli.cwd ?? process.cwd(), env: cli.env as NodeJS.ProcessEnv, encoding: "utf8" });
				cli.out(`${handed.stdout}${handed.stderr}`.trim());
				return handed.status ?? 1;
			}
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
			const command = [process.execPath, resolve(RELEASE_DIR, "bin", "rho"), "release-run", checked.source, checked.commit];
			// Under systemd, stopping rho's unit ends every process started inside it, a detached one
			// too. When rho itself runs the release, the gate would die at its own restart and leave
			// rho stopped. So there the gate runs as a unit of its own.
			const unit = readService(dir)?.kind === "systemd" ? gateUnit(command, cli.env, join(dir, "release.log")) : undefined;
			const gate = unit ?? spawn(command[0]!, command.slice(1), { env: cli.env as NodeJS.ProcessEnv, cwd: RELEASE_DIR, detached: true, stdio: ["ignore", log, log] });
			if (!unit) (gate as ReturnType<typeof spawn>).unref();
			closeSync(log);
			if (gate.pid === undefined) return cli.out("The release gate could not be started. See: rho logs"), 1;
			// Said before this command returns, so the status never shows the release before this one.
			writeFileSync(file, `${JSON.stringify({ status: "running", stage: "starting", commit: checked.commit, previous: checked.previous, pid: gate.pid, at: Date.now() }, null, "\t")}\n`, { mode: 0o600 });
			cli.out(`Releasing ${checked.commit.slice(0, 7)} (rho runs ${checked.previous.slice(0, 7)}). The gate checks it, then restarts rho onto it; if it does not come up, rho goes back. The result arrives as a message here. Progress: rho release --status`);
			return 0;
		}
		case "release-run": {
			// Not for people: the detached half of `release`.
			const outcome = await release(gateHost(dir, cli), args[1] ?? "", args[2] ?? "HEAD");
			return outcome.status === "released" ? 0 : 1;
		}
		case "service": {
			const service = readService(dir);
			if (args[1] === "status") return cli.out(service ? serviceStatus(service, cli.env) : "Rho is not installed as a service. Install it with: rho service install"), service ? 0 : 1;
			if (args[1] === "uninstall") {
				if (!service) return cli.out("Rho is not installed as a service."), 0;
				await uninstallService(dir, cli.env);
				return cli.out("Rho's service is removed, and rho is stopped."), 0;
			}
			if (args[1] !== "install") return cli.out("Usage: rho service install | uninstall | status"), 2;
			// A rho started by hand gives way to the one the service runs.
			const byHand = service ? undefined : await running(dir);
			if (byHand) {
				process.kill(byHand.pid, "SIGTERM");
				for (let i = 0; i < 80 && alive(byHand.pid); i++) await sleep(250);
			}
			try {
				const made = installService(dir, cli.env, RELEASE_DIR);
				cli.out(`Installed as a ${made.kind} service named ${made.name}: it starts at boot and is started again if it dies.${made.kind === "runit" ? " Starting at boot needs the Termux:Boot app, opened once." : ""}`);
			} catch (error) {
				return cli.out((error as Error).message), 1;
			}
			return (await start(dir, cli)) ? 0 : 1;
		}
		case "version": {
			// The checkout's commit is what the next start runs; the running daemon says its own.
			const head = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: RELEASE_DIR });
			// Installed from a package there is no commit: the package's version is what it is.
			if (head.exitCode !== 0) return cli.out(`${(JSON.parse(readFileSync(join(RELEASE_DIR, "package.json"), "utf8")) as { version: string }).version} (installed from a package, not a git checkout)`), 0;
			const commit = head.stdout.toString().trim();
			const now = await running(dir);
			const differs = now?.commit && now.commit !== commit ? ` The running rho is still ${now.commit.slice(0, 7)}; it runs ${commit.slice(0, 7)} after a restart.` : "";
			return cli.out(`${commit}${differs}`), 0;
		}
		case "logs":
			return cli.out(tail(join(dir, "daemon.log"), Number(args[1]) || 40) || "No log yet, start rho first."), 0;
		default:
			cli.out("Usage: rho start | stop | status | open [--print] | key [provider [--remove]] | login <provider> | logout <provider> | logs [lines] | version | service install|uninstall|status | release [commit] | release --status");
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
	// A secret is read without echo from a terminal, or as the first line of piped input.
	const readSecret = async (prompt: string): Promise<string> => {
		const tty = process.stdin.isTTY === true;
		const restore = () => {
			spawnSync("stty", ["echo"], { stdio: "inherit" });
			process.stderr.write("\n");
			process.exit(130);
		};
		if (tty) {
			process.stderr.write(prompt);
			spawnSync("stty", ["-echo"], { stdio: "inherit" });
			process.once("SIGINT", restore); // Ctrl-C must not leave the terminal without echo
		}
		try {
			let text = "";
			for await (const chunk of process.stdin) {
				text += String(chunk);
				if (text.includes("\n")) break;
			}
			return text.split("\n")[0] ?? "";
		} finally {
			if (tty) {
				process.removeListener("SIGINT", restore);
				spawnSync("stty", ["echo"], { stdio: "inherit" });
				process.stderr.write("\n");
			}
			process.stdin.pause();
		}
	};
	// A line that may be shown, such as an address pasted back. It stops waiting when the signal fires.
	const readLine = (prompt: string, signal?: AbortSignal): Promise<string> =>
		new Promise((done, fail) => {
			process.stderr.write(prompt);
			let text = "";
			const stop = () => {
				process.stdin.off("data", onData);
				process.stdin.pause();
			};
			const onData = (chunk: Buffer) => {
				text += String(chunk);
				if (!text.includes("\n")) return;
				stop();
				done(text.split("\n")[0]!.trim());
			};
			signal?.addEventListener("abort", () => (stop(), fail(new Error("not needed"))), { once: true });
			process.stdin.on("data", onData);
			process.stdin.resume();
		});
	return run(args, { env: process.env, out: (line) => console.log(line), openLink, readSecret, readLine });
}
