import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { context, openCore, type Core } from "../src/core.ts";
import { entryView, type EntryView } from "../src/view.ts";

// The coding tools through a real core under Bun, with a scripted model deciding the calls.
const dirs: string[] = [];
const cores: Core[] = [];
afterEach(async () => {
	for (const core of cores.splice(0)) await core.close().catch(() => undefined);
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = (prefix: string) => {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	dirs.push(dir);
	return dir;
};
async function open(options: { env?: (cwd: string) => NodeExecutionEnv } = {}) {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const work = scratch("rho-work-");
	const core = await openCore({ dir: scratch("rho-tools-test-"), models, config: { model: `${faux.getModel().provider}/${faux.getModel().id}`, cwd: work }, env: options.env });
	cores.push(core);
	const call = (name: string, args: Record<string, unknown>) => fauxAssistantMessage(fauxToolCall(name, args as never), { stopReason: "toolUse" });
	const entries = async (): Promise<EntryView[]> => (await core.root.entries({ order: "ascending" }, 100, undefined, context)).items.flatMap((entry) => entryView(entry) ?? []);
	/** Run one user turn in which the model makes these tool calls in order, then answers. */
	const turn = async (calls: [string, Record<string, unknown>][]) => {
		faux.setResponses([...calls.map(([name, args]) => call(name, args)), fauxAssistantMessage("done")]);
		const before = (await entries()).length;
		await (await core.root.submit({ type: "input", content: "go" }, context)).wait(context);
		return (await entries()).slice(before).filter((entry): entry is Extract<EntryView, { role: "tool" }> => entry.role === "tool");
	};
	return { core, faux, work, call, turn, entries };
}

test("write, read, edit and bash work in the conversation's directory", async () => {
	const { work, turn } = await open();
	const [wrote] = await turn([["write", { path: "notes/hello.txt", content: "one\ntwo\nthree\n" }]]);
	expect(wrote!.error).toBeUndefined();
	expect(readFileSync(join(work, "notes", "hello.txt"), "utf8")).toBe("one\ntwo\nthree\n"); // a relative path, and its folder was made

	const [read] = await turn([["read", { path: "notes/hello.txt" }]]);
	expect(read!.text).toContain("one\ntwo\nthree");
	const [part] = await turn([["read", { path: "notes/hello.txt", offset: 2, limit: 1 }]]);
	expect(part!.text).toContain("two");
	expect(part!.text).not.toContain("three\n");

	const [edited] = await turn([["edit", { path: "notes/hello.txt", edits: [{ oldText: "two", newText: "TWO" }] }]]);
	expect(edited!.error).toBeUndefined();
	expect(readFileSync(join(work, "notes", "hello.txt"), "utf8")).toBe("one\nTWO\nthree\n");

	const [ran] = await turn([["bash", { command: "pwd; cat notes/hello.txt | wc -l; echo to-stderr >&2" }]]);
	expect(ran!.text).toContain(work);
	expect(ran!.text).toContain("3");
	expect(ran!.text).toContain("to-stderr");
});

test("every tool takes an optional reasoning argument, and the wire view carries it apart from the arguments", async () => {
	const { core, work, turn, entries } = await open();
	const tools = (await core.root.agent(context)).tools;
	expect(tools.map((tool) => tool.name).sort()).toEqual(["bash", "edit", "fetch_content", "find", "grep", "ls", "read", "web_search", "write"]);
	for (const tool of tools) {
		const schema = tool.parameters as { properties: Record<string, { type?: string }>; required?: string[] };
		expect([tool.name, schema.properties.reasoning?.type]).toEqual([tool.name, "string"]);
		expect(schema.required ?? []).not.toContain("reasoning");
	}
	// A call with a reason works as one without, and the tool does not see it as an argument of its own.
	const [wrote] = await turn([["write", { reasoning: "keep a note for later", path: "n.txt", content: "a\nb\n" }]]);
	expect(wrote!.error).toBeUndefined();
	expect(readFileSync(join(work, "n.txt"), "utf8")).toBe("a\nb\n");
	const call = (await entries()).flatMap((entry) => (entry.role === "assistant" ? entry.calls : [])).at(-1)!;
	expect(call).toEqual({ id: call.id, name: "write", reasoning: "keep a note for later", args: { path: "n.txt", content: "a\nb\n" } });
	// The result summary: an edit says what changed and carries its diff; others say how much came back.
	const [edited] = await turn([["edit", { path: "n.txt", edits: [{ oldText: "b", newText: "B" }] }]]);
	expect(edited!.summary).toBe("+1 −1");
	expect(edited!.diff).toContain("B");
	const [listed] = await turn([["bash", { command: "printf 'x\\ny\\nz\\n'" }]]);
	expect(listed!.summary).toBe("3 lines");
	expect(listed!.diff).toBeUndefined();
	const [quiet] = await turn([["bash", { command: "true" }]]);
	expect(quiet!.summary).toBe("no output");
	const [failed] = await turn([["read", { path: "nope.txt" }]]);
	expect(failed!.summary.length).toBeGreaterThan(0);
	expect(failed!.summary).not.toContain("\n");
});

test("failures come back to the model as errors that say what went wrong", async () => {
	const { work, turn } = await open();
	const [missing] = await turn([["read", { path: "nope.txt" }]]);
	expect(missing!.error).toBe(true);
	expect(missing!.text).toMatch(/nope\.txt|not found|ENOENT/i);
	writeFileSync(join(work, "a.txt"), "alpha\n");
	const [noMatch] = await turn([["edit", { path: "a.txt", edits: [{ oldText: "beta", newText: "x" }] }]]);
	expect(noMatch!.error).toBe(true);
	expect(readFileSync(join(work, "a.txt"), "utf8")).toBe("alpha\n"); // nothing was changed
	const [failed] = await turn([["bash", { command: "echo before; exit 3" }]]);
	expect(failed!.error).toBe(true);
	expect(failed!.text).toContain("before");
	expect(failed!.text).toContain("3");
	const [slow] = await turn([["bash", { command: "sleep 5", timeout: 1 }]]);
	expect(slow!.error).toBe(true);
	expect(slow!.text).toMatch(/timed out after 1 second/);
}, 20_000);

test("Stop ends a running command at once, and its processes with it", async () => {
	const { core, faux, call, work, entries } = await open();
	faux.setResponses([call("bash", { command: `echo $$ > ${join(work, "pid")}; sleep 60 & wait` })]);
	await core.root.submit({ type: "input", content: "go" }, context);
	while (!existsSync(join(work, "pid")) || readFileSync(join(work, "pid"), "utf8").trim() === "") await Bun.sleep(20);
	const pid = Number(readFileSync(join(work, "pid"), "utf8"));
	const started = Date.now();
	await core.root.abort(context);
	expect(Date.now() - started).toBeLessThan(3_000);
	await Bun.sleep(200);
	expect(() => process.kill(pid, 0)).toThrow(); // the shell is gone
	expect((await Bun.$`pgrep -P ${pid} || true`.text()).trim()).toBe(""); // and so is what it started
	const last = (await entries()).at(-1)!;
	expect(last.role).toBe("tool");
	expect((last as { error?: boolean }).error).toBe(true);
}, 20_000);

test("read, write and edit end when Stop comes while they wait on the file system, and change nothing", async () => {
	// An environment whose every call waits, as a stalled disk or a remote one would, until it is
	// let go or told to stop.
	let entered: (() => void) | undefined;
	const slow = (cwd: string) => {
		const real = new NodeExecutionEnv({ cwd });
		return new Proxy(real, {
			get(target, key) {
				const value = Reflect.get(target, key, target);
				if (typeof value !== "function" || key === "cleanup") return typeof value === "function" ? value.bind(target) : value;
				return async (...args: unknown[]) => {
					const signal = (args.at(-1) as { abortSignal?: AbortSignal } | undefined)?.abortSignal;
					entered?.();
					await new Promise<void>((resolve) => (signal?.aborted ? resolve() : signal?.addEventListener("abort", () => resolve(), { once: true })));
					return value.apply(target, args);
				};
			},
		});
	};
	const { core, faux, call, work } = await open({ env: slow });
	writeFileSync(join(work, "keep.txt"), "original\n");
	for (const [name, args] of [["read", { path: "keep.txt" }], ["write", { path: "new.txt", content: "must not appear" }], ["edit", { path: "keep.txt", edits: [{ oldText: "original", newText: "changed" }] }]] as const) {
		const waiting = new Promise<void>((resolve) => (entered = resolve));
		faux.setResponses([call(name, args)]);
		await core.root.submit({ type: "input", content: name }, context);
		await waiting;
		const started = Date.now();
		await core.root.abort(context);
		expect(Date.now() - started).toBeLessThan(3_000);
		expect(existsSync(join(work, "new.txt"))).toBe(false);
		expect(readFileSync(join(work, "keep.txt"), "utf8")).toBe("original\n");
	}
}, 20_000);
