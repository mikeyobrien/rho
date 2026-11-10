// Keeping rho running: a service that starts it at boot and starts it again when it dies.
// On Termux that is runit (the termux-services package) plus a Termux:Boot script; on Linux a
// systemd user unit. `rho service install` writes the files for the platform it is run on, from
// the checkout it is run from, and records what it made in `<data dir>/service.json`. With that
// record present, `rho start` and `rho stop` go through the service, so a stop stays stopped.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type ServiceKind = "runit" | "systemd";
export type ServiceRecord = { kind: ServiceKind; name: string; files: string[] };
type Env = Record<string, string | undefined>;

const MARK = "# Written by `rho service install`. Remove with `rho service uninstall`.";
/** What the service's rho needs from the shell that installed it. */
const KEPT = ["RHO_HOME", "RHO_PORT", "RHO_CLAUDE"];
/** On Termux also these: without TMPDIR and PREFIX there is no temp directory, and LD_PRELOAD is what makes `#!/usr/bin/env` work. */
const KEPT_TERMUX = ["PREFIX", "TMPDIR", "LD_PRELOAD", "LANG"];

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const shQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
const unitQuote = (value: string): string => `"${value.replace(/[\\"]/g, "\\$&").replace(/%/g, "%%")}"`;

export function serviceName(env: Env): string {
	const name = env.RHO_SERVICE ?? "rho";
	if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) throw new Error("The service name (RHO_SERVICE) may hold lower-case letters, digits and -.");
	return name;
}
/** The service manager this machine has, or undefined. */
export function serviceKind(env: Env): ServiceKind | undefined {
	const has = (program: string) => Bun.which(program, { PATH: env.PATH ?? "" }) !== null;
	if ((env.PREFIX ?? "").includes("com.termux")) return has("sv") && has("service-daemon") ? "runit" : undefined;
	return has("systemctl") ? "systemd" : undefined;
}
export function readService(dir: string): ServiceRecord | undefined {
	try {
		return JSON.parse(readFileSync(join(dir, "service.json"), "utf8")) as ServiceRecord;
	} catch {
		return undefined;
	}
}

export interface ServiceFiles { bun: string; main: string; log: string; env: Env }
/** The runit `run` file: set the environment, then become rho. */
export function runitRun(files: ServiceFiles): string {
	const names = ["HOME", "PATH", ...KEPT_TERMUX, ...KEPT].filter((name) => files.env[name] !== undefined);
	return [`#!${files.env.PREFIX}/bin/sh`, MARK, ...names.map((name) => `export ${name}=${shQuote(files.env[name]!)}`), `exec ${shQuote(files.bun)} ${shQuote(files.main)} >> ${shQuote(files.log)} 2>&1`, ""].join("\n");
}
/** The Termux:Boot script: after the phone starts, start the service runner, which starts rho. */
export function bootScript(env: Env): string {
	const prefix = env.PREFIX!;
	return [`#!${prefix}/bin/sh`, MARK, `export PREFIX=${shQuote(prefix)}`, `export PATH=${shQuote(`${prefix}/bin`)}:"$PATH"`, `export SVDIR=${shQuote(`${prefix}/var/service`)}`, `export LOGDIR=${shQuote(`${prefix}/var/log`)}`, "termux-wake-lock", "service-daemon start", ""].join("\n");
}
/** The systemd user unit. */
export function systemdUnit(files: ServiceFiles): string {
	const names = ["PATH", ...KEPT].filter((name) => files.env[name] !== undefined);
	return [
		MARK,
		"[Unit]",
		"Description=rho, a personal agent",
		"After=network-online.target",
		"",
		"[Service]",
		`ExecStart=${[files.bun, files.main].map((part) => unitQuote(part).replace(/\$/g, "$$$$")).join(" ")}`,
		...names.map((name) => `Environment=${unitQuote(`${name}=${files.env[name]!}`)}`),
		"Restart=always",
		"RestartSec=2",
		`StandardOutput=append:${files.log}`,
		`StandardError=append:${files.log}`,
		"",
		"[Install]",
		"WantedBy=default.target",
		"",
	].join("\n");
}

/** Write the service's files and its record. Nothing is started. A file of that name that rho did not write is left alone. */
export function writeService(kind: ServiceKind, dir: string, env: Env, releaseDir: string): ServiceRecord {
	const name = serviceName(env);
	const home = env.HOME ?? homedir();
	const files: ServiceFiles = { bun: process.execPath, main: join(releaseDir, "src", "main.ts"), log: join(dir, "daemon.log"), env: { ...env, HOME: home } };
	const written: [string, string][] =
		kind === "runit"
			? [[join(env.SVDIR ?? join(env.PREFIX!, "var", "service"), name, "run"), runitRun(files)], [join(home, ".termux", "boot", name), bootScript(env)]]
			: [[join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "systemd", "user", `${name}.service`), systemdUnit(files)]];
	for (const [path] of written) if (existsSync(path) && !readFileSync(path, "utf8").includes(MARK)) throw new Error(`${path} exists and was not written by rho. It was left alone; choose another name with RHO_SERVICE.`);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	for (const [path, text] of written) {
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, text, { mode: 0o700 });
		chmodSync(path, kind === "runit" ? 0o700 : 0o600);
	}
	const record: ServiceRecord = { kind, name, files: written.map(([path]) => path) };
	writeFileSync(join(dir, "service.json"), `${JSON.stringify(record, null, "\t")}\n`, { mode: 0o600 });
	return record;
}

function sh(command: string[], env: Env): { code: number; out: string } {
	const result = spawnSync(command[0]!, command.slice(1), { env: env as NodeJS.ProcessEnv, encoding: "utf8", timeout: 30_000 });
	return { code: result.status ?? 1, out: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}
const runitEnv = (env: Env): Env => ({ ...env, SVDIR: env.SVDIR ?? join(env.PREFIX ?? "", "var", "service"), LOGDIR: env.LOGDIR ?? join(env.PREFIX ?? "", "var", "log") });
const must = (result: { code: number; out: string }, what: string): void => {
	if (result.code !== 0) throw new Error(`${what} failed: ${result.out.slice(0, 300)}`);
};

/** Ask the service to run rho, and to start it again whenever it dies. */
export async function serviceUp(record: ServiceRecord, env: Env): Promise<void> {
	if (record.kind === "systemd") return must(sh(["systemctl", "--user", "start", `${record.name}.service`], env), "systemctl start");
	const with_ = runitEnv(env);
	// `sv status` fails while nothing supervises the service: the runner is not up, or has not seen it yet (it looks every 5 s).
	if (sh(["sv", "status", record.name], with_).code !== 0) sh(["service-daemon", "start"], with_);
	for (let i = 0; i < 60 && sh(["sv", "status", record.name], with_).code !== 0; i++) await sleep(250);
	must(sh(["sv", "up", record.name], with_), "sv up");
}
/** Ask the service to stop rho and keep it stopped. */
export function serviceDown(record: ServiceRecord, env: Env): void {
	if (record.kind === "systemd") return void sh(["systemctl", "--user", "stop", `${record.name}.service`], env);
	sh(["sv", "down", record.name], runitEnv(env));
}
/** One line from the service manager about rho. */
export function serviceStatus(record: ServiceRecord, env: Env): string {
	if (record.kind === "systemd") return `systemd: ${sh(["systemctl", "--user", "is-active", `${record.name}.service`], env).out}, ${sh(["systemctl", "--user", "is-enabled", `${record.name}.service`], env).out}`;
	return `runit: ${sh(["sv", "status", record.name], runitEnv(env)).out}`;
}
/** Write the files and have the manager take them up; rho is started by `serviceUp`. */
export function installService(dir: string, env: Env, releaseDir: string): ServiceRecord {
	const kind = serviceKind(env);
	if (!kind) throw new Error((env.PREFIX ?? "").includes("com.termux") ? "No service runner found. Install it with: pkg install termux-services (then open a new Termux session)." : "No service manager found: this needs systemd.");
	const record = writeService(kind, dir, env, releaseDir);
	if (kind === "systemd") {
		must(sh(["systemctl", "--user", "daemon-reload"], env), "systemctl daemon-reload");
		must(sh(["systemctl", "--user", "enable", `${record.name}.service`], env), "systemctl enable");
	}
	return record;
}
/** Stop rho, remove the service's files and its record. */
export async function uninstallService(dir: string, env: Env): Promise<void> {
	const record = readService(dir);
	if (!record) return;
	serviceDown(record, env);
	if (record.kind === "systemd") sh(["systemctl", "--user", "disable", `${record.name}.service`], env);
	else for (let i = 0; i < 40 && /^run:/.test(sh(["sv", "status", record.name], runitEnv(env)).out); i++) await sleep(250); // until it has stopped; no runner means nothing to wait for
	for (const path of record.files) {
		if (existsSync(path) && readFileSync(path, "utf8").includes(MARK)) rmSync(record.kind === "runit" && path.endsWith("/run") ? join(path, "..") : path, { recursive: true, force: true });
	}
	if (record.kind === "systemd") sh(["systemctl", "--user", "daemon-reload"], env);
	rmSync(join(dir, "service.json"), { force: true });
}
