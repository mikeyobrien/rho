import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { context, openCore, type Core } from "../src/core.ts";
import { entryView, type EntryView } from "../src/view.ts";

// grep, find and ls through a real core under Bun; a scripted model decides the calls.
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
type ToolEntry = Extract<EntryView, { role: "tool" }>;
async function open(files: Record<string, string>, options: { git?: boolean; env?: (cwd: string) => NodeExecutionEnv } = {}) {
	const work = scratch("rho-search-work-");
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(join(work, path, ".."), { recursive: true });
		writeFileSync(join(work, path), content);
	}
	if (options.git) Bun.spawnSync(["git", "init", "-q", work]);
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	const core = await openCore({ dir: scratch("rho-search-test-"), models, config: { model: `${faux.getModel().provider}/${faux.getModel().id}`, cwd: work }, env: options.env });
	cores.push(core);
	const call = (name: string, args: object) => fauxAssistantMessage(fauxToolCall(name, args as never), { stopReason: "toolUse" });
	const entries = async () => (await core.root.entries({ order: "ascending" }, 200, undefined, context)).items.flatMap((entry) => entryView(entry) ?? []);
	/** One tool call by the model; returns its result. */
	const use = async (name: string, args: object): Promise<ToolEntry> => {
		faux.setResponses([call(name, args), fauxAssistantMessage("done")]);
		await (await core.root.submit({ type: "input", content: "go" }, context)).wait(context);
		return (await entries()).findLast((entry): entry is ToolEntry => entry.role === "tool")!;
	};
	return { core, faux, work, call, use, entries };
}
const tree = {
	"README.md": "# Project\nThe quick brown fox.\n",
	"src/a.ts": "export const alpha = 1;\n// TODO: rename alpha\nconst beta = alpha + 1;\n",
	"src/deep/b.ts": "import { alpha } from '../a';\nexport const gamma = alpha * 2;\n",
	"src/deep/notes.txt": "nothing to see\nALPHA in capitals\n",
	".env": "SECRET=alpha\n",
	"node_modules/pkg/index.js": "const alpha = 'dependency';\n",
	"dist/out.js": "var alpha=1;\n",
	".gitignore": "dist/\n.env\n",
	"bin/blob.bin": "alpha\0binary\n",
};

test("ls lists a directory, sorted, with directories marked", async () => {
	const { use } = await open(tree);
	expect((await use("ls", {})).text).toBe([".env", ".gitignore", "README.md", "bin/", "dist/", "node_modules/", "src/"].join("\n"));
	expect((await use("ls", { path: "src" })).text).toBe("a.ts\ndeep/");
	expect((await use("ls", { limit: 2 })).text).toBe(".env\n.gitignore\n[2 of 7 entries shown. Raise limit to see more.]");
	const missing = await use("ls", { path: "nope" });
	expect(missing.error).toBe(true);
	const { use: inEmpty } = await open({});
	expect((await inEmpty("ls", {})).text).toBe("The directory is empty.");
});

test("find matches by glob; a bare name matches at any depth; node_modules and .git are skipped", async () => {
	const { use } = await open(tree);
	expect((await use("find", { pattern: "*.ts" })).text).toBe("src/a.ts\nsrc/deep/b.ts");
	expect((await use("find", { pattern: "src/*.ts" })).text).toBe("src/a.ts");
	expect((await use("find", { pattern: "*.ts", path: "src/deep" })).text).toBe("b.ts");
	expect((await use("find", { pattern: "*.js" })).text).toBe("dist/out.js"); // not a git tree: only node_modules is skipped
	expect((await use("find", { pattern: "*.rs" })).text).toBe("No files match.");
	expect((await use("find", { pattern: "*", limit: 2 })).text).toMatch(/^\.env\n\.gitignore\n\[2 of \d+ files shown\. Narrow the pattern or raise limit\.\]$/);
});

test("inside a git work tree, find and grep skip what git ignores, tracked or not", async () => {
	const { use } = await open(tree, { git: true });
	expect((await use("find", { pattern: "*.js" })).text).toBe("No files match."); // dist/ is ignored
	const files = (await use("find", { pattern: "*" })).text.split("\n");
	expect(files).toContain("src/a.ts"); // untracked files count
	expect(files).not.toContain(".env");
	expect(files.some((file) => file.startsWith(".git/"))).toBe(false);
	expect((await use("grep", { pattern: "SECRET" })).text).toBe("No matches.");
});

test("grep finds matches with path and line, and can show context, ignore case, take a literal and filter by glob", async () => {
	const { use } = await open(tree);
	expect((await use("grep", { pattern: "alpha", glob: "*.ts" })).text).toBe(
		["src/a.ts:1: export const alpha = 1;", "src/a.ts:2: // TODO: rename alpha", "src/a.ts:3: const beta = alpha + 1;", "src/deep/b.ts:1: import { alpha } from '../a';", "src/deep/b.ts:2: export const gamma = alpha * 2;"].join("\n"),
	);
	expect((await use("grep", { pattern: "^export const (\\w+)", path: "src" })).text).toBe("a.ts:1: export const alpha = 1;\ndeep/b.ts:2: export const gamma = alpha * 2;");
	expect((await use("grep", { pattern: "alpha", ignoreCase: true, glob: "*.txt" })).text).toBe("src/deep/notes.txt:2: ALPHA in capitals");
	expect((await use("grep", { pattern: "alpha + 1", literal: true })).text).toBe("src/a.ts:3: const beta = alpha + 1;");
	expect((await use("grep", { pattern: "TODO", context: 1 })).text).toBe("src/a.ts-1- export const alpha = 1;\nsrc/a.ts:2: // TODO: rename alpha\nsrc/a.ts-3- const beta = alpha + 1;");
	expect((await use("grep", { pattern: "gamma", path: "src/deep/b.ts" })).text).toBe("src/deep/b.ts:2: export const gamma = alpha * 2;"); // one file
});

test("grep with nothing found, a binary file, a bad pattern and a missing path", async () => {
	const { use } = await open(tree);
	expect((await use("grep", { pattern: "zebra" })).text).toBe("No matches.");
	expect((await use("grep", { pattern: "binary" })).text).toBe("No matches."); // bin/blob.bin holds a NUL
	expect((await use("grep", { pattern: "dependency" })).text).toBe("No matches."); // node_modules is skipped
	const bad = await use("grep", { pattern: "(unclosed" });
	expect(bad.error).toBe(true);
	expect(bad.text).toContain("not a valid regular expression");
	expect((await use("grep", { pattern: "x", path: "nope" })).error).toBe(true);
});

test("limits: matches stop at the limit and say so; a long line is cut; a huge file is skipped", async () => {
	const many = Array.from({ length: 250 }, (_, index) => `needle ${index}`).join("\n");
	const { use } = await open({ "many.txt": many, "long.txt": `needle ${"x".repeat(5_000)}\n`, "huge.txt": `needle\n${"y".repeat(2 * 1024 * 1024 + 10)}` });
	const capped = (await use("grep", { pattern: "needle", glob: "many.txt" })).text.split("\n");
	expect(capped.length).toBe(101);
	expect(capped[99]).toBe("many.txt:100: needle 99");
	expect(capped[100]).toBe("[100 matches shown; there are more. Narrow the pattern or raise limit.]");
	expect((await use("grep", { pattern: "needle", glob: "many.txt", limit: 3 })).text.split("\n").length).toBe(4);
	expect((await use("grep", { pattern: "needle", glob: "many.txt", limit: 1000 })).text.split("\n").length).toBe(250); // all, with no note
	const long = (await use("grep", { pattern: "needle", glob: "long.txt" })).text;
	expect(long.length).toBeLessThan(600);
	expect(long.endsWith("[line cut]")).toBe(true);
	expect((await use("grep", { pattern: "needle", glob: "huge.txt" })).text).toBe("No matches.");
});

test("Stop ends a search that is waiting on the file system", async () => {
	let entered: (() => void) | undefined;
	// An environment whose reads wait, as a stalled or remote disk would, until told to stop.
	const slow = (cwd: string) => {
		const real = new NodeExecutionEnv({ cwd });
		return new Proxy(real, {
			get(target, key) {
				const value = Reflect.get(target, key, target);
				if (typeof value !== "function") return value;
				if (key !== "readTextFile" && key !== "listDir") return value.bind(target);
				return async (...args: unknown[]) => {
					const signal = (args.at(-1) as { abortSignal?: AbortSignal }).abortSignal;
					entered?.();
					await new Promise<void>((resolve) => (signal?.aborted ? resolve() : signal?.addEventListener("abort", () => resolve(), { once: true })));
					return value.apply(target, args);
				};
			},
		});
	};
	const { core, faux, call, entries } = await open(tree, { env: slow });
	for (const [name, args] of [["grep", { pattern: "alpha" }], ["find", { pattern: "*.ts" }], ["ls", {}]] as const) {
		const waiting = new Promise<void>((resolve) => (entered = resolve));
		faux.setResponses([call(name, args)]);
		await core.root.submit({ type: "input", content: name }, context);
		await waiting;
		const started = Date.now();
		await core.root.abort(context);
		expect(Date.now() - started).toBeLessThan(3_000);
		const last = (await entries()).at(-1) as ToolEntry;
		expect([last.role, last.name, last.error]).toEqual(["tool", name, true]);
	}
}, 20_000);
