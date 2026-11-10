import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataDir, parseModel, readConfig } from "../src/core.ts";

// The core is run in a real second process (test/fixtures/crash-host.ts) with a scripted model
// and killed with SIGKILL, which is what Android does to it. No model is called.
const host = join(import.meta.dir, "fixtures", "crash-host.ts");
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function scratch(script: object[]): string {
	const dir = mkdtempSync(join(tmpdir(), "rho-core-test-"));
	dirs.push(dir);
	writeFileSync(join(dir, "script.json"), JSON.stringify(script));
	return dir;
}
const lines = (dir: string, file: string) => (existsSync(join(dir, file)) ? readFileSync(join(dir, file), "utf8").trim().split("\n").filter(Boolean) : []);

interface Host { events: any[]; until(event: string, ms?: number): Promise<any>; kill(): Promise<void>; exited: Promise<number> }
function start(dir: string, submit?: [string, string], env: Record<string, string> = {}): Host {
	const child = Bun.spawn([process.execPath, host, dir, join(dir, "script.json"), ...(submit ?? [])], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
	const events: any[] = [];
	const waiters = new Set<() => void>();
	let stderr = "";
	void (async () => { for await (const chunk of child.stderr) stderr += new TextDecoder().decode(chunk); })();
	void (async () => {
		let buffer = "";
		for await (const chunk of child.stdout) {
			buffer += new TextDecoder().decode(chunk);
			let end: number;
			while ((end = buffer.indexOf("\n")) !== -1) {
				try { events.push(JSON.parse(buffer.slice(0, end))); } catch { /* not an event */ }
				buffer = buffer.slice(end + 1);
				for (const waiter of [...waiters]) waiter();
			}
		}
	})();
	void child.exited.then(() => { for (const waiter of [...waiters]) waiter(); });
	return {
		events,
		exited: child.exited,
		until: (event, ms = 20_000) => new Promise((resolve, reject) => {
			const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`timed out waiting for ${event}; saw ${events.map((e) => e.event).join(",")}; stderr: ${stderr.slice(-600)}`)); }, ms);
			const check = () => {
				const found = events.find((e) => e.event === event);
				if (!found && child.exitCode === null) return;
				clearTimeout(timer);
				waiters.delete(check);
				found ? resolve(found) : reject(new Error(`the host exited (${child.exitCode}) before ${event}; stderr: ${stderr.slice(-600)}`));
			};
			waiters.add(check);
			check();
		}),
		kill: async () => { child.kill("SIGKILL"); await child.exited; },
	};
}
const kinds = (idle: any) => idle.entries.map((entry: any) => entry.kind);

test("a question is answered and stored; a second process sees the same conversation", async () => {
	const dir = scratch([{ text: "Tokyo." }]);
	const first = start(dir, ["req-1", "What is the capital of Japan?"]);
	const idle = await first.until("idle");
	expect(kinds(idle)).toEqual(["pi.user", "pi.system", "pi.assistant"]);
	expect(idle.entries.at(-1).text).toBe("Tokyo.");
	expect(await first.exited).toBe(0);
	// Reopened with nothing to do: the same entries, and no new model call.
	const again = await start(dir).until("idle");
	expect(again.entries).toEqual(idle.entries);
	expect(lines(dir, "model.log").length).toBe(1);
});

test("killed while the model is answering: the next process finishes the run, and the question is not asked twice", async () => {
	const dir = scratch([{ text: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen" }, { text: "The answer, after a restart." }]);
	const first = start(dir, ["req-2", "Tell me something."], { FAUX_TPS: "4" }); // slow enough to be killed mid-answer
	await first.until("submitted");
	await Bun.sleep(700);
	await first.kill();
	expect(lines(dir, "model.log").length).toBe(1); // the first request had started
	// The same request id on reopen: the existing submission, not a second question.
	const second = start(dir, ["req-2", "Tell me something."]);
	const idle = await second.until("idle", 40_000);
	const users = idle.entries.filter((entry: any) => entry.kind === "pi.user");
	expect(users.length).toBe(1);
	const answers = idle.entries.filter((entry: any) => entry.kind === "pi.assistant");
	expect(answers.at(-1).text).toBe("The answer, after a restart.");
	expect(answers.at(-1).stop).toBe("stop");
	// The interrupted attempt is kept as a cut-off entry, not lost and not shown as an answer.
	expect(answers.slice(0, -1).every((entry: any) => entry.stop === "aborted")).toBe(true);
	expect(lines(dir, "model.log").length).toBe(2); // one retry, no more
}, 60_000);

test("killed while a tool is running: the tool does not run again, and the model is told it was interrupted", async () => {
	const dir = scratch([{ tool: "effect", args: { label: "send-the-email" } }, { text: "It was interrupted; I did not repeat it." }]);
	const first = start(dir, ["req-3", "Send the email."], { TOOL_MS: "30000" });
	await first.until("tool-started");
	expect(lines(dir, "effects.log")).toEqual(["send-the-email"]);
	await first.kill();
	const second = start(dir, undefined, { TOOL_MS: "0" });
	const idle = await second.until("idle", 40_000);
	expect(lines(dir, "effects.log")).toEqual(["send-the-email"]); // still once
	const result = idle.entries.find((entry: any) => entry.kind === "pi.tool-result");
	expect(result.isError).toBe(true);
	expect(result.text.toLowerCase()).toContain("interrupt");
	expect(idle.entries.at(-1).kind).toBe("pi.assistant");
	expect(idle.entries.at(-1).text).toBe("It was interrupted; I did not repeat it.");
	expect(lines(dir, "model.log").length).toBe(2); // the tool request, then the answer after the interruption
}, 60_000);

test("a finished tool call is not run again by a restart", async () => {
	const dir = scratch([{ tool: "effect", args: { label: "once" } }, { text: "Done." }]);
	const idle = await start(dir, ["req-4", "Do it."]).until("idle");
	expect(kinds(idle)).toEqual(["pi.user", "pi.system", "pi.assistant", "pi.tool-result", "pi.assistant"]);
	await start(dir).until("idle");
	expect(lines(dir, "effects.log")).toEqual(["once"]);
});

test("config and paths", () => {
	expect(parseModel("claude-code/claude-opus-5-5")).toEqual({ provider: "claude-code", modelId: "claude-opus-5-5" });
	expect(parseModel("openrouter/anthropic/claude")).toEqual({ provider: "openrouter", modelId: "anthropic/claude" });
	expect(() => parseModel("no-slash")).toThrow(/provider\/model/);
	expect(dataDir({ RHO_HOME: "/x" })).toBe("/x");
	expect(dataDir({}).endsWith("/.rho2")).toBe(true);
	const dir = scratch([]);
	expect(readConfig(dir)).toEqual({});
	writeFileSync(join(dir, "config.json"), '{"model":"a/b"}');
	expect(readConfig(dir)).toEqual({ model: "a/b" });
	const logged: string[] = [];
	writeFileSync(join(dir, "config.json"), "{nope");
	expect(readConfig(dir, (line) => logged.push(line))).toEqual({});
	expect(logged[0]).toMatch(/not JSON and was ignored/);
});
