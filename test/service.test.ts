import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootScript, readService, runitRun, serviceName, systemdUnit, uninstallService, writeService } from "../src/service.ts";

// The files the service is made of, written into scratch directories. No service manager is
// touched here; the real ones are exercised by hand on the phone and on Linux (TASKS.md).
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const scratch = () => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "rho-service-test-")));
	dirs.push(dir);
	return dir;
};
const files = (env: Record<string, string>) => ({ bun: "/opt/bun/bin/bun", main: "/srv/rho/src/main.ts", log: "/data/rho/v2/daemon.log", env });

test("the runit run file sets what rho needs and becomes rho, quoting what it is given", () => {
	const text = runitRun(files({ PREFIX: "/data/data/com.termux/files/usr", HOME: "/home/it's me", PATH: "/a:/b", TMPDIR: "/tmp x", LD_PRELOAD: "/lib/exec.so", RHO_HOME: "/data/rho", RHO_PORT: "4780", SECRET_TOKEN: "must not be copied" }));
	const lines = text.split("\n");
	expect(lines[0]).toBe("#!/data/data/com.termux/files/usr/bin/sh");
	expect(lines).toContain("export HOME='/home/it'\\''s me'");
	expect(lines).toContain("export TMPDIR='/tmp x'");
	expect(lines).toContain("export LD_PRELOAD='/lib/exec.so'");
	expect(lines).toContain("export RHO_PORT='4780'");
	expect(lines.at(-2)).toBe("exec '/opt/bun/bin/bun' '/srv/rho/src/main.ts' >> '/data/rho/v2/daemon.log' 2>&1");
	expect(text).not.toContain("SECRET_TOKEN"); // only the named variables are carried over
	// It is a shell script that parses, and runs with those values.
	const dir = scratch();
	writeFileSync(join(dir, "run"), text.replace(/^#!.*\n/, "").replace(/^exec .*$/m, 'printf "%s|%s" "$HOME" "$TMPDIR"'));
	expect(Bun.spawnSync(["sh", join(dir, "run")]).stdout.toString()).toBe("/home/it's me|/tmp x");
});

test("the boot script takes the wake lock and starts the service runner", () => {
	const text = bootScript({ PREFIX: "/data/data/com.termux/files/usr" });
	expect(text.split("\n").slice(-3)).toEqual(["termux-wake-lock", "service-daemon start", ""]);
	expect(text).toContain("export SVDIR='/data/data/com.termux/files/usr/var/service'");
});

test("the systemd unit restarts rho always, and its values survive quoting", () => {
	const unit = systemdUnit(files({ PATH: "/usr/bin:/home/u/.bun/bin", RHO_HOME: '/home/u/my "rho" 100%', RHO_PORT: "4781", AWS_SECRET: "must not be copied" }));
	expect(unit).toContain('ExecStart="/opt/bun/bin/bun" "/srv/rho/src/main.ts"');
	expect(unit).toContain("Restart=always");
	expect(unit).toContain("WantedBy=default.target");
	expect(unit).toContain('Environment="RHO_HOME=/home/u/my \\"rho\\" 100%%"');
	expect(unit).toContain('Environment="RHO_PORT=4781"');
	expect(unit).toContain("StandardOutput=append:/data/rho/v2/daemon.log");
	expect(unit).not.toContain("AWS_SECRET");
});

test("installing writes the files and a record; uninstalling removes only what rho wrote", async () => {
	const root = scratch();
	const dir = join(root, "data", "v2");
	const env = { HOME: join(root, "home"), PREFIX: join(root, "usr"), PATH: "/nowhere", SVDIR: join(root, "usr", "var", "service"), RHO_SERVICE: "rho-test" };
	const record = writeService("runit", dir, env, "/srv/rho");
	expect(record).toEqual({ kind: "runit", name: "rho-test", files: [join(env.SVDIR, "rho-test", "run"), join(env.HOME, ".termux", "boot", "rho-test")] });
	expect(readService(dir)).toEqual(record);
	for (const path of record.files) expect(statSync(path).mode & 0o777).toBe(0o700);
	expect(readFileSync(record.files[0]!, "utf8")).toContain("'/srv/rho/src/main.ts'");
	// Written again (an upgrade): the same files, replaced.
	expect(writeService("runit", dir, env, "/srv/rho-new").files).toEqual(record.files);
	expect(readFileSync(record.files[0]!, "utf8")).toContain("'/srv/rho-new/src/main.ts'");
	await uninstallService(dir, env);
	expect(existsSync(join(env.SVDIR, "rho-test"))).toBe(false);
	expect(existsSync(record.files[1]!)).toBe(false);
	expect(readService(dir)).toBeUndefined();

	const unit = writeService("systemd", dir, { HOME: env.HOME, PATH: "/nowhere", XDG_CONFIG_HOME: join(root, "config") }, "/srv/rho");
	expect(unit.files).toEqual([join(root, "config", "systemd", "user", "rho.service")]);
	expect(statSync(unit.files[0]!).mode & 0o777).toBe(0o600);
});

test("a file of that name that rho did not write is left alone", () => {
	const root = scratch();
	const env = { HOME: join(root, "home"), PREFIX: join(root, "usr"), SVDIR: join(root, "service") };
	mkdirSync(join(env.SVDIR, "rho"), { recursive: true });
	writeFileSync(join(env.SVDIR, "rho", "run"), "#!/bin/sh\nexec something-else\n");
	expect(() => writeService("runit", join(root, "v2"), env, "/srv/rho")).toThrow(/exists and was not written by rho/);
	expect(readFileSync(join(env.SVDIR, "rho", "run"), "utf8")).toBe("#!/bin/sh\nexec something-else\n");
	expect(existsSync(join(root, "v2", "service.json"))).toBe(false);
	expect(() => serviceName({ RHO_SERVICE: "../etc" })).toThrow(/lower-case letters/);
	expect(serviceName({})).toBe("rho");
});
