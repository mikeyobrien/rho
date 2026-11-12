// `RemoteEnv` against the local env: the engine's own conformance suite for both, then the same
// cases run on each and compared result for result. The remote's `run` is a local `sh` in a
// scratch directory, so no other machine is needed; it is counted, to keep round trips low.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@earendil-works/chord/context";
import { type ExecutionEnv, getOrThrow, type Result } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { registerEnvConformance } from "@earendil-works/pi-durable/testing";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { RemoteEnv } from "../src/remote/env.ts";
import { localRun, type Run } from "../src/remote/run.ts";

const roots: string[] = [];
afterAll(() => { for (const root of roots) { Bun.spawnSync(["chmod", "-R", "u+rwx", root]); rmSync(root, { recursive: true, force: true }); } });
function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "rho-remote-env-"));
	roots.push(dir);
	return dir;
}
/** A local `sh` as the far side, counting each call. */
function counted() {
	const inner = localRun();
	const counter = { calls: 0, run: ((script, options) => { counter.calls++; return inner(script, options); }) as Run };
	return counter;
}
const remote = (cwd: string, run: Run = localRun()) => new RemoteEnv({ run, cwd, id: "remote:test" });
const local = (cwd: string) => new NodeExecutionEnv({ cwd });

const runner = { describe, expect: expect as never, it: (name: string, run: () => Promise<void>, timeoutMs?: number) => test(name, run, timeoutMs ?? 30_000) };
const withEnv = (make: (cwd: string) => ExecutionEnv) => async (use: (env: ExecutionEnv) => Promise<void>) => {
	const env = make(scratch());
	try { await use(env); } finally { await env.cleanup(context); }
};
// The suite's watch cases need `watch`, which RemoteEnv does not support: they are run for the
// local env only, and the remote's `watch` is checked to say so.
registerEnvConformance(runner, "the engine's env conformance: NodeExecutionEnv", withEnv(local));
describe("the engine's env conformance: RemoteEnv over a local sh", () => {
	const skipped: string[] = [];
	registerEnvConformance({ describe: (_name, suite) => suite(), expect: expect as never, it: (name, run, ms) => (name.startsWith("watch ") ? skipped.push(name) : test(name, run, ms ?? 30_000)) }, "", withEnv((cwd) => remote(cwd)));
	test("only the watch cases are left out, and watch says it is not supported", async () => {
		expect(skipped.length).toBe(9);
		const env = remote(scratch());
		const watched = await env.watch([{ path: "x" }], () => {}, context);
		expect(!watched.ok && watched.error.code).toBe("not_supported");
	});
});

// The same cases on both envs, each in its own fresh directory; every observable result is kept.
type Outcome = unknown;
const strip = (value: unknown, cwd: string): unknown => value === undefined ? null : JSON.parse(JSON.stringify(value, (key, item) => key === "mtimeMs" ? undefined : (typeof item === "string" ? item.replaceAll(cwd, "<cwd>") : item instanceof Uint8Array ? Array.from(item) : item?.type === "Buffer" && Array.isArray(item.data) ? item.data : item)));
const shape = (result: Result<unknown, { code: string }>, cwd: string, keep?: (value: any) => unknown): Outcome =>
	result.ok ? { ok: strip(keep ? keep(result.value) : result.value, cwd) } : { error: result.error.code };
const infoShape = (info: any) => (info ? { name: info.name, path: info.path, kind: info.kind, size: info.kind === "directory" ? "dir" : info.size } : info);
const all = (bytes: number) => Uint8Array.from({ length: bytes }, (_, index) => index % 256);
const NAMES = ["with space.txt", "it's \"quoted\".txt", "-leading-dash", "$(touch pwned)`x`.txt", "ünïcødé ✓.md", "tab\there"];

async function cases(env: ExecutionEnv, cwd: string): Promise<Record<string, Outcome>> {
	const out: Record<string, Outcome> = {};
	const c = context;
	const at = (key: string, value: Outcome) => { out[key] = value; };
	const text = "héllo — 世界 🙂\nline two\r\nno newline at end";
	at("write text", shape(await env.writeFile("text.txt", text, c), cwd));
	at("read text", shape(await env.readTextFile("text.txt", c), cwd));
	at("read text bytes", shape(await env.readBinaryFile("text.txt", c), cwd, (bytes: Uint8Array) => bytes.length));
	at("binary every byte", shape(await env.writeFile("bin.dat", all(256 * 3 + 7), c), cwd));
	at("binary read back", shape(await env.readBinaryFile("bin.dat", c), cwd, (bytes: Uint8Array) => Buffer.from(bytes).equals(Buffer.from(all(256 * 3 + 7)))));
	at("empty file", shape(await env.writeFile("empty", "", c), cwd));
	at("empty read", shape(await env.readTextFile("empty", c), cwd));
	at("empty info", shape(await env.fileInfo("empty", c), cwd, infoShape));
	const big = Uint8Array.from({ length: 3 * 1024 * 1024 + 11 }, (_, index) => (index * 7919) % 251);
	at("big write", shape(await env.writeFile("big.bin", big, c), cwd));
	at("big read", shape(await env.readBinaryFile("big.bin", c), cwd, (bytes: Uint8Array) => Buffer.from(bytes).equals(Buffer.from(big))));
	const reader = getOrThrow(await env.openBinaryReader("big.bin", undefined, c));
	at("big ranged read", shape(await reader.read(2 * 1024 * 1024 - 3, 9, c), cwd));
	at("big ranged tail", shape(await reader.read(big.length - 4, 100, c), cwd));
	at("big scan", shape(await reader.scanLines({ startLine: 0 }, c), cwd));
	await reader.close(c);
	for (const name of NAMES) {
		at(`name ${name} write`, shape(await env.writeFile(name, name, c), cwd));
		at(`name ${name} read`, shape(await env.readTextFile(name, c), cwd));
		at(`name ${name} info`, shape(await env.fileInfo(name, c), cwd, infoShape));
	}
	at("nothing ran from a name", shape(await env.exists("pwned", c), cwd));
	at("nested write", shape(await env.writeFile("a/b/c/d.txt", "deep", c), cwd));
	at("nested list", shape(await env.listDir("a/b", c), cwd, (infos: any[]) => infos.map(infoShape).sort((x: any, y: any) => x.name.localeCompare(y.name))));
	at("list root", shape(await env.listDir(".", c), cwd, (infos: any[]) => infos.map(infoShape).sort((x: any, y: any) => x.name.localeCompare(y.name))));
	at("append", shape(await env.appendFile("a/log", "one\n", c), cwd));
	at("append again", shape(await env.appendFile("a/log", "two", c), cwd));
	at("append read", shape(await env.readTextFile("a/log", c), cwd));
	at("lines", shape(await env.readTextLines("a/log", undefined, c), cwd));
	at("lines max 1", shape(await env.readTextLines("text.txt", { maxLines: 1 }, c), cwd));
	at("lines max 0", shape(await env.readTextLines("text.txt", { maxLines: 0 }, c), cwd));
	const lines = getOrThrow(await env.openTextLineReader("text.txt", c));
	const read: unknown[] = [];
	for (let line = await lines.readLine(c); line.ok && line.value; line = await lines.readLine(c)) read.push(line.value);
	await lines.close(c);
	at("line reader", read);
	at("truncate", shape(await env.truncateFile("text.txt", 5, c), cwd));
	at("truncated", shape(await env.readBinaryFile("text.txt", c), cwd));
	at("extend", shape(await env.truncateFile("text.txt", 9, c), cwd));
	at("extended", shape(await env.readBinaryFile("text.txt", c), cwd));
	at("truncate bad size", shape(await env.truncateFile("text.txt", -1, c), cwd));
	at("flush", shape(await env.flushFile("text.txt", c), cwd));
	at("rename", shape(await env.renameFile("a/log", "a/b/moved", c), cwd));
	at("renamed gone", shape(await env.exists("a/log", c), cwd));
	at("renamed there", shape(await env.readTextFile("a/b/moved", c), cwd));
	at("rename over file", shape(await env.renameFile("empty", "a/b/moved", c), cwd));
	at("rename dir", shape(await env.renameFile("a/b", "a/b2", c), cwd));
	at("rename dir onto empty dir", shape(await env.createDir("e1", undefined, c), cwd));
	at("rename dir onto empty dir 2", shape(await env.renameFile("a/b2", "e1", c), cwd));
	at("rename dir onto empty dir 3", shape(await env.listDir("e1", c), cwd, (infos: any[]) => infos.map((info) => info.name).sort()));
	at("canonical", shape(await env.canonicalPath("e1/c/../c", c), cwd));
	at("absolute", shape(await env.absolutePath("x/../y", c), cwd));
	at("join", shape(await env.joinPath(["a", "../b", "c"], c), cwd));
	at("mkdir recursive", shape(await env.createDir("m/n/o", undefined, c), cwd));
	at("mkdir again", shape(await env.createDir("m/n/o", undefined, c), cwd));
	at("remove file", shape(await env.remove(NAMES[2]!, undefined, c), cwd));
	at("remove dir plain", shape(await env.remove("m", undefined, c), cwd));
	at("remove dir recursive", shape(await env.remove("m", { recursive: true }, c), cwd));
	at("removed", shape(await env.exists("m", c), cwd));
	at("remove missing forced", shape(await env.remove("m", { force: true }, c), cwd));
	const temp = getOrThrow(await env.createTempFile({ prefix: "pre-", suffix: ".log" }, c));
	at("temp file", [temp.split("/").at(-1)!.startsWith("pre-"), temp.endsWith(".log"), getOrThrow(await env.readTextFile(temp, c))]);
	const tempDir = getOrThrow(await env.createTempDir("rho-t-", c));
	at("temp dir", [tempDir.split("/").at(-1)!.startsWith("rho-t-"), getOrThrow(await env.fileInfo(tempDir, c)).kind]);
	await env.remove(tempDir, { recursive: true }, c);
	await env.remove(temp.slice(0, temp.lastIndexOf("/")), { recursive: true }, c);

	// Each error code that applies. `empty` is a file again: the renames above moved it.
	getOrThrow(await env.writeFile("empty", "", c));
	const missing = "nope/none.txt";
	at("E read missing", shape(await env.readTextFile(missing, c), cwd));
	at("E binary missing", shape(await env.readBinaryFile("none", c), cwd));
	at("E info missing", shape(await env.fileInfo("none", c), cwd));
	at("E exists missing", shape(await env.exists("none", c), cwd));
	at("E list missing", shape(await env.listDir("none", c), cwd));
	at("E canonical missing", shape(await env.canonicalPath("none", c), cwd));
	at("E rename missing", shape(await env.renameFile("none", "x", c), cwd));
	at("E rename into missing", shape(await env.renameFile("empty", "none/x", c), cwd));
	at("E truncate missing", shape(await env.truncateFile("none", 1, c), cwd));
	at("E flush missing", shape(await env.flushFile("none", c), cwd));
	at("E remove missing", shape(await env.remove("none", undefined, c), cwd));
	at("E lines missing", shape(await env.readTextLines("none", undefined, c), cwd));
	at("E mkdir no parent", shape(await env.createDir("none/x", { recursive: false }, c), cwd));
	at("E read dir", shape(await env.readTextFile("e1", c), cwd));
	at("E write dir", shape(await env.writeFile("e1", "x", c), cwd));
	at("E append dir", shape(await env.appendFile("e1", "x", c), cwd));
	at("E truncate dir", shape(await env.truncateFile("e1", 0, c), cwd));
	at("E flush dir", shape(await env.flushFile("e1", c), cwd));
	at("E rename file onto dir", shape(await env.renameFile("empty", "e1", c), cwd));
	at("E rename dir onto file", shape(await env.renameFile("e1", "empty", c), cwd));
	at("E read through file", shape(await env.readTextFile("empty/x", c), cwd));
	at("E info through file", shape(await env.fileInfo("empty/x", c), cwd));
	at("E list file", shape(await env.listDir("empty", c), cwd));
	at("E dir reader file", shape(await env.openDirReader("empty", c), cwd, () => "opened"));
	at("E mkdir through file", shape(await env.createDir("empty/x/y", undefined, c), cwd));
	at("E reader dir", shape(await env.openBinaryReader("e1", undefined, c), cwd, () => "opened"));
	getOrThrow(await env.writeFile("locked/inner", "x", c));
	getOrThrow(await env.writeFile("noread", "x", c));
	await env.exec("chmod 0 noread locked", undefined, c);
	at("E read no permission", shape(await env.readTextFile("noread", c), cwd));
	at("E reader no permission", shape(await env.openBinaryReader("noread", undefined, c), cwd, () => "opened"));
	at("E write no permission", shape(await env.writeFile("noread", "y", c), cwd));
	at("E read in locked dir", shape(await env.readTextFile("locked/inner", c), cwd));
	at("E list locked dir", shape(await env.listDir("locked", c), cwd));
	await env.exec("chmod 700 locked; chmod 600 noread", undefined, c);
	const stopped = new AbortController();
	stopped.abort();
	at("E aborted", shape(await env.readTextFile("empty", withAbortSignal(stopped.signal, c)), cwd));
	return out;
}

test("the same cases give the same results on the local env and on RemoteEnv", async () => {
	const here = scratch();
	const there = scratch();
	const expected = await cases(local(here), here);
	const actual = await cases(remote(there), there);
	expect(actual).toEqual(expected);
	// What a few of them were, so the comparison is not of two empty runs.
	expect(expected["read text"]).toEqual({ ok: "héllo — 世界 🙂\nline two\r\nno newline at end" });
	expect(expected["binary read back"]).toEqual({ ok: true });
	expect(expected["E read missing"]).toEqual({ error: "not_found" });
	expect(expected["E read dir"]).toEqual({ error: "is_directory" });
	expect(expected["E read through file"]).toEqual({ error: "not_directory" });
}, 120_000);

test("mtimes agree with the local env to the microsecond", async () => {
	const dir = scratch();
	getOrThrow(await local(dir).writeFile("f", "x", context));
	const here = getOrThrow(await local(dir).fileInfo("f", context));
	const there = getOrThrow(await remote(dir).fileInfo("f", context));
	expect(Math.abs(here.mtimeMs - there.mtimeMs)).toBeLessThan(0.001);
	expect(there).toEqual({ ...here, mtimeMs: there.mtimeMs });
});

test("round trips: a small file's read costs two, a write two or three, an edit four", async () => {
	const dir = scratch();
	const counter = counted();
	const env = remote(dir, counter.run);
	const api = (calls: number) => ({ env, taskId: 1, callId: `c${calls}`, output: () => {}, retainedOutput: () => ({ text: "", truncated: false }), diagnostic: () => {} }) as never;
	const steps: Record<string, number> = {};
	const measure = async (name: string, work: () => Promise<unknown>) => { const before = counter.calls; await work(); steps[name] = counter.calls - before; };
	await measure("writeFile", () => env.writeFile("f.txt", "one\ntwo\n", context));
	await measure("readTextFile", () => env.readTextFile("f.txt", context));
	await measure("fileInfo", () => env.fileInfo("f.txt", context));
	await measure("open, info, read, scan and close a small file", async () => {
		const reader = getOrThrow(await env.openBinaryReader("f.txt", undefined, context));
		await reader.info(context); await reader.read(0, 3, context); await reader.scanLines({ startLine: 0 }, context); await reader.info(context);
		await reader.close(context);
	});
	await measure("read tool", () => createReadTool().execute({ path: "f.txt" }, api(1), context));
	await measure("write tool, new file", () => createWriteTool().execute({ path: "g.txt", content: "x" }, api(2), context));
	await measure("write tool, existing file", () => createWriteTool().execute({ path: "g.txt", content: "y" }, api(5), context));
	await measure("edit tool", () => createEditTool().execute({ path: "f.txt", edits: [{ oldText: "two", newText: "three" }] }, api(3), context));
	await measure("bash tool", () => createBashTool().execute({ command: "true" }, api(4), context));
	// The tools' path checks are part of their cost: `exists` for read, `canonicalPath` for the
	// mutation queue of write and edit.
	expect(steps).toEqual({
		writeFile: 1, readTextFile: 1, fileInfo: 1,
		"open, info, read, scan and close a small file": 1,
		"read tool": 2, // exists, then open (which reads the whole small file)
		"write tool, new file": 3, // canonicalPath (not found), canonicalPath of the parent, writeFile
		"write tool, existing file": 2, // canonicalPath, writeFile
		"edit tool": 4, // canonicalPath, fileInfo, readTextFile, writeFile
		"bash tool": 1,
	});
	expect(getOrThrow(await env.readTextFile("f.txt", context))).toBe("one\nthree\n");
});

test("a larger file is read in ranges, and a read after the path changed fails as invalid", async () => {
	const dir = scratch();
	const counter = counted();
	const env = remote(dir, counter.run);
	const big = all(2 * 1024 * 1024);
	getOrThrow(await env.writeFile("big", big, context));
	const reader = getOrThrow(await env.openBinaryReader("big", undefined, context));
	const before = counter.calls;
	expect(Array.from(getOrThrow(await reader.read(1_500_000, 4, context)))).toEqual(Array.from(big.subarray(1_500_000, 1_500_004)));
	expect(counter.calls - before).toBe(1);
	getOrThrow(await env.renameFile("big", "big2", context));
	getOrThrow(await env.writeFile("big", "other", context));
	const after = await reader.read(0, 4, context);
	expect(!after.ok && after.error.code).toBe("invalid");
	await reader.close(context);
});

test("exec: cwd, env, inheritEnv, timeout, output as it arrives, spill on the far side", async () => {
	const dir = scratch();
	const env = remote(dir);
	const chunks: string[] = [];
	getOrThrow(await env.createDir("sub dir", undefined, context));
	const result = await env.exec(`printf '%s|%s' "$PWD" "$GREETING"; printf ' — é' >&2`, { cwd: "sub dir", env: { GREETING: "hi there" }, onOutput: (text, _c, info) => chunks.push(`${info.stream}:${text}`) }, context);
	expect(getOrThrow(result).exitCode).toBe(0);
	expect(chunks.join("")).toBe(`stdout:${join(dir, "sub dir")}|hi therestderr: — é`);
	const bare: string[] = [];
	await env.exec(["sh", "-c", 'printf "%s" "${HOME:-none}|$X"'], { env: { X: "y" }, inheritEnv: false, onOutput: (text) => bare.push(text) }, context);
	expect(bare.join("")).toBe("none|y");
	expect((await env.exec("sleep 5", { timeout: 0.2 }, context)) as unknown).toMatchObject({ ok: false, error: { code: "timeout" } });
	expect((await env.exec("exit 4", undefined, context)) as unknown).toMatchObject({ ok: true, value: { exitCode: 4 } });
	expect((await env.exec("true", { cwd: "missing" }, context)) as unknown).toMatchObject({ ok: false, error: { code: "spawn_error" } });
	// A command's own stderr that looks like the start of the mark is passed on.
	const odd: string[] = [];
	await env.exec(`printf '\\001x' >&2`, { onOutput: (text) => odd.push(text) }, context);
	expect(odd.join("")).toBe("\u0001x");
	// Arrival order: the first chunk comes before the command ends.
	let first = 0;
	const started = Date.now();
	await env.exec("echo one; sleep 1; echo two", { onOutput: () => { first ||= Date.now(); } }, context);
	expect(first - started).toBeLessThan(Date.now() - started);
	const spilled = getOrThrow(await env.exec("i=0; while [ $i -lt 3000 ]; do echo line-$i; i=$((i+1)); done", { spill: { afterBytes: 1000, afterLines: 100 } }, context));
	expect(spilled.spillPath).toBeString();
	const kept = getOrThrow(await env.readTextFile(spilled.spillPath!, context));
	expect(kept.split("\n").length).toBe(3001);
	expect(kept.endsWith("line-2999\n")).toBe(true);
	await env.remove(spilled.spillPath!.slice(0, spilled.spillPath!.lastIndexOf("/")), { recursive: true }, context);
}, 30_000);

test("a transport that fails is an error, not a throw", async () => {
	const env = new RemoteEnv({ run: async () => { throw new Error("link down"); }, cwd: "/x" });
	const read = await env.readTextFile("a", context);
	expect(!read.ok && read.error.code).toBe("unknown");
	expect(!read.ok && read.error.message).toContain("link down");
	const ran = await env.exec("true", undefined, context);
	expect(!ran.ok && ran.error.code).toBe("unknown");
});
