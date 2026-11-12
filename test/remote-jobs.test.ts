// Jobs that outlive the connection (src/remote/jobs.ts), with `run` bound to a local sh. The kill
// test runs a real rho core in a second process (test/fixtures/crash-host.ts), kills it with
// SIGKILL while a job runs, and starts it again. No model is called.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJobs, type JobResult } from "../src/remote/jobs.ts";
import { localRun, type Run } from "../src/remote/run.ts";

const roots: string[] = [];
const scratch = (name = "rho-remote-jobs-") => { const dir = mkdtempSync(join(tmpdir(), name)); roots.push(dir); return dir; };
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
const text = (chunks: Uint8Array[]) => new TextDecoder().decode(Buffer.concat(chunks));
const collect = () => { const out: Uint8Array[] = []; const err: Uint8Array[] = []; return { out, err, onOutput: (chunk: Uint8Array, stream: "stdout" | "stderr") => (stream === "stdout" ? out : err).push(chunk) }; };
const lines = (file: string) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []);
/** Waits for a file to exist, without a fixed sleep. */
async function until(check: () => boolean, ms = 20_000) {
	for (let waited = 0; !check(); waited += 50) { if (waited > ms) throw new Error("timed out"); await Bun.sleep(50); }
}
const fast = { pollMs: 50, retryMs: 50 };

test("a job runs once, and a second call with its key collects it instead of starting it again", async () => {
	const root = scratch();
	const mark = join(root, "mark");
	const jobs = createJobs({ run: localRun(), root, ...fast });
	const first = collect();
	const command = `echo ran >> '${mark}'; printf 'out é'; printf 'err' >&2; exit 7`;
	expect(await jobs.job("k1", command, { onOutput: first.onOutput })).toEqual({ status: "exited", code: 7, started: true });
	expect([text(first.out), text(first.err)]).toEqual(["out é", "err"]);
	const again = collect();
	expect(await jobs.job("k1", command, { onOutput: again.onOutput })).toEqual({ status: "exited", code: 7, started: false });
	expect([text(again.out), text(again.err)]).toEqual(["out é", "err"]);
	expect(lines(mark)).toEqual(["ran"]);
	expect(await jobs.remove("k1")).toBe(true);
	expect(existsSync(join(root, "jobs", "k1"))).toBe(false);
});

test("an aborted caller leaves the command running; a later call reattaches and gets all the output", async () => {
	const root = scratch();
	const go = join(root, "go");
	const jobs = createJobs({ run: localRun(), root, ...fast });
	const controller = new AbortController();
	const first = collect();
	const running = jobs.job("k2", `echo before; while [ ! -f '${go}' ]; do sleep 0.05; done; echo after`, { signal: controller.signal, onOutput: first.onOutput });
	await until(() => text(first.out) === "before\n");
	controller.abort();
	expect(await running).toEqual({ status: "aborted", started: true });
	const pid = Number(readFileSync(join(root, "jobs", "k2", "pid"), "utf8"));
	expect(() => process.kill(pid, 0)).not.toThrow(); // still running
	const second = collect();
	const attached = jobs.job("k2", "never run", { onOutput: second.onOutput });
	await until(() => text(second.out) === "before\n");
	writeFileSync(go, "");
	expect(await attached).toEqual({ status: "exited", code: 0, started: false });
	expect(text(second.out)).toBe("before\nafter\n");
});

test("a run that drops mid-follow is not a dropped command: the next try picks up from the byte it reached", async () => {
	const root = scratch();
	const inner = localRun();
	let calls = 0;
	// Every second follow is cut off after its first chunk, as a link that drops would.
	const flaky: Run = async (script, options) => {
		calls++;
		if (calls % 2 === 1 || !options?.onOutput) return inner(script, options);
		const controller = new AbortController();
		return inner(script, { ...options, signal: controller.signal, onOutput: (chunk, stream) => { options.onOutput!(chunk, stream); controller.abort(); } });
	};
	const jobs = createJobs({ run: flaky, root, ...fast, followMs: 300, tries: 1000 });
	const seen = collect();
	const result = await jobs.job("k3", "i=0; while [ $i -lt 40 ]; do echo line-$i; i=$((i+1)); sleep 0.02; done", { onOutput: seen.onOutput });
	expect(result).toEqual({ status: "exited", code: 0, started: true });
	expect(text(seen.out)).toBe(Array.from({ length: 40 }, (_, i) => `line-${i}\n`).join(""));
	expect(calls).toBeGreaterThan(2);
}, 30_000);

test("output larger than one read arrives whole and in order", async () => {
	const root = scratch();
	const jobs = createJobs({ run: localRun(), root, ...fast, followMs: 200 });
	const seen = collect();
	// About 3 MB, written over several polls.
	const result = await jobs.job("k4", "i=0; while [ $i -lt 30 ]; do head -c 100000 /dev/zero | tr '\\0' \"$((i % 10))\"; i=$((i+1)); done; printf end", { onOutput: seen.onOutput });
	expect(result.status).toBe("exited");
	const out = text(seen.out);
	expect(out.length).toBe(3_000_003);
	expect(out.slice(0, 3)).toBe("000");
	expect(out.slice(2_999_990)).toBe("9999999999end");
}, 60_000);

test("stop ends the process group; a later call says the job ended without a code; remove is refused while it runs", async () => {
	const root = scratch();
	const jobs = createJobs({ run: localRun(), root, ...fast });
	const controller = new AbortController();
	const seen = collect();
	const running = jobs.job("k5", "sleep 30 & sleep 30; echo never", { signal: controller.signal, onOutput: seen.onOutput });
	await until(() => existsSync(join(root, "jobs", "k5", "pid")));
	expect(await jobs.remove("k5")).toBe(false);
	controller.abort();
	await running;
	const pid = Number(readFileSync(join(root, "jobs", "k5", "pid"), "utf8"));
	expect(await jobs.stop("k5", { graceMs: 2000 })).toBe(true);
	expect(() => process.kill(-pid, 0)).toThrow(); // the whole group is gone, the background sleep too
	const after = await jobs.job("k5", "never run");
	// TERM ends the wrapper's child; the wrapper may write its code (143) or die with it.
	expect(["exited", "stopped"]).toContain(after.status);
	if (after.status === "exited") expect(after.code).toBe(143);
	expect(await jobs.stop("k5")).toBe(false);
	expect(await jobs.remove("k5")).toBe(true);
}, 30_000);

test("a job whose process is gone with no exit code is reported as stopped", async () => {
	const root = scratch();
	const jobs = createJobs({ run: localRun(), root, ...fast });
	const controller = new AbortController();
	const running = jobs.job("k6", "sleep 30", { signal: controller.signal });
	await until(() => existsSync(join(root, "jobs", "k6", "pid")));
	controller.abort();
	await running;
	// KILL the group at once: the wrapper cannot write an exit code, as after a reboot.
	process.kill(-Number(readFileSync(join(root, "jobs", "k6", "pid"), "utf8")), "SIGKILL");
	expect(await jobs.job("k6", "never run")).toEqual({ status: "stopped", started: false });
});

test("two keys at once run side by side, each with its own output", async () => {
	const root = scratch();
	const jobs = createJobs({ run: localRun(), root, ...fast });
	const a = collect();
	const b = collect();
	const gate = join(root, "gate");
	const [ra, rb] = await Promise.all([
		jobs.job("a", `touch '${gate}.a'; while [ ! -f '${gate}.b' ]; do sleep 0.05; done; echo A`, { onOutput: a.onOutput }),
		jobs.job("b", `touch '${gate}.b'; while [ ! -f '${gate}.a' ]; do sleep 0.05; done; echo B; exit 2`, { onOutput: b.onOutput }),
	]);
	expect([ra, rb]).toEqual([{ status: "exited", code: 0, started: true }, { status: "exited", code: 2, started: true }]);
	expect([text(a.out), text(b.out)]).toEqual(["A\n", "B\n"]);
});

test("cwd, env and timeout; a key that is not a plain name is refused", async () => {
	const root = scratch();
	const jobs = createJobs({ run: localRun(), root, ...fast });
	const seen = collect();
	expect(await jobs.job("k7", `printf '%s|%s' "$PWD" "$V"`, { cwd: root, env: { V: "it's" }, onOutput: seen.onOutput })).toMatchObject({ status: "exited", code: 0 });
	expect(text(seen.out)).toBe(`${root}|it's`);
	expect((await jobs.job("k8", "sleep 30", { timeout: 1 })).status).toBe("timeout");
	expect(await jobs.stop("k8")).toBe(false); // already stopped by the timeout
	expect((await jobs.job("k9", "true", { cwd: join(root, "missing") }))).toMatchObject({ status: "exited", code: 127 });
	await expect(jobs.job("../x", "true")).rejects.toThrow(/Not a job key/);
}, 30_000);

test("a transport that is down is unreachable, and nothing was started", async () => {
	const jobs = createJobs({ run: async () => { throw new Error("link down"); }, root: "/nowhere", ...fast, tries: 2 });
	const result: JobResult = await jobs.job("k", "true");
	expect(result).toEqual({ status: "unreachable", started: false, error: "link down" });
});

// The project's rule for kill behaviour: a real second process, SIGKILL, start it again.
const host = join(import.meta.dir, "fixtures", "crash-host.ts");
function startHost(dir: string, root: string, submit?: [string, string]) {
	const child = Bun.spawn([process.execPath, host, dir, join(dir, "script.json"), ...(submit ?? [])], { env: { ...process.env, REMOTE_JOBS: root }, stdout: "pipe", stderr: "pipe" });
	const events: any[] = [];
	let stderr = "";
	void (async () => { for await (const chunk of child.stderr) stderr += new TextDecoder().decode(chunk); })();
	void (async () => {
		let buffer = "";
		for await (const chunk of child.stdout) {
			buffer += new TextDecoder().decode(chunk);
			let end: number;
			while ((end = buffer.indexOf("\n")) !== -1) { try { events.push(JSON.parse(buffer.slice(0, end))); } catch { /* not an event */ } buffer = buffer.slice(end + 1); }
		}
	})();
	return {
		idle: async (ms = 60_000) => {
			for (let waited = 0; ; waited += 50) {
				const found = events.find((event) => event.event === "idle");
				if (found) return found;
				if (child.exitCode !== null || waited > ms) throw new Error(`no idle (exit ${child.exitCode}); stderr: ${stderr.slice(-800)}`);
				await Bun.sleep(50);
			}
		},
		kill: async () => { child.kill("SIGKILL"); await child.exited; },
	};
}

test("killed while a remote command runs: the next process collects it, it ran once, and the model saw one result", async () => {
	const dir = scratch("rho-remote-kill-");
	const root = join(dir, "far");
	const mark = join(dir, "mark");
	const go = join(dir, "go");
	const command = `echo ran >> '${mark}'; echo first; while [ ! -f '${go}' ]; do sleep 0.05; done; echo second; exit 5`;
	writeFileSync(join(dir, "script.json"), JSON.stringify([{ tool: "remote_bash", args: { command } }, { text: "Collected." }]));
	const first = startHost(dir, root, ["req-r", "Run it."]);
	await until(() => lines(mark).length === 1);
	await first.kill();
	expect(lines(mark)).toEqual(["ran"]);
	const [job] = (await Array.fromAsync(new Bun.Glob("*").scan({ cwd: join(root, "jobs"), onlyFiles: false })));
	const pid = Number(readFileSync(join(root, "jobs", job!, "pid"), "utf8"));
	expect(() => process.kill(pid, 0)).not.toThrow(); // the command outlived the process that started it
	writeFileSync(go, "");
	const idle = await startHost(dir, root).idle();
	expect(lines(mark)).toEqual(["ran"]); // still once
	const results = idle.entries.filter((entry: any) => entry.kind === "pi.tool-result");
	expect(results.length).toBe(1);
	expect(results[0].isError).toBe(true); // exit 5
	expect(results[0].text).toContain("first\nsecond");
	expect(readFileSync(join(root, "jobs", job!, "exit"), "utf8").trim()).toBe("5");
	expect(idle.entries.at(-1).text).toBe("Collected.");
	expect(lines(join(dir, "model.log")).length).toBe(2);
}, 120_000);
