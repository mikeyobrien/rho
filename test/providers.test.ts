import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { context, openCore, type Core, type RhoConfig } from "../src/core.ts";
import { chooseModel, CLAUDE_PLAN_WARNING, keyStore, keyVariables, openModels, setupOf } from "../src/providers.ts";

// Which model a new person gets, from what they have: nothing, a key, a config, a plan.
const dirs: string[] = [];
const cores: Core[] = [];
const servers: { stop(force?: boolean): unknown }[] = [];
afterEach(async () => {
	for (const core of cores.splice(0)) await core.close().catch(() => undefined);
	for (const server of servers.splice(0)) server.stop(true);
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const scratch = () => (dirs.push(mkdtempSync(join(tmpdir(), "rho-providers-test-"))), dirs.at(-1)!);
function open(config: RhoConfig = {}, env: Record<string, string> = {}, dir = scratch()) {
	const logged: string[] = [];
	// The Claude CLI is always the fake one: a test never runs a real `claude` that happens to be installed.
	const claude = join(dir, "fake-claude");
	writeFileSync(claude, `#!/usr/bin/env bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(join(import.meta.dir, "fixtures", "fake-claude.ts"))} "$@"\n`);
	chmodSync(claude, 0o755);
	return { dir, logged, ...openModels({ dir, config, env: { HOME: dir, RHO_CLAUDE: claude, ...env }, log: (line) => logged.push(line) }) };
}

test("with nothing set up there is no model, and the note says how to add a key", async () => {
	const { models, logged } = open();
	expect(await models.getAvailable()).toEqual([]);
	expect(await chooseModel(models, {})).toBeUndefined();
	expect(await setupOf(models, undefined)).toEqual({ ready: false, note: "Rho has no model to use yet. Add an API key with: rho key <provider>   (anthropic, openai, google, openrouter, or see: rho key)" });
	// A conversation made before any key names the documented default; the note then names its provider.
	expect(await setupOf(models, "anthropic/claude-sonnet-5-5")).toEqual({ ready: false, model: "anthropic/claude-sonnet-5-5", note: "Rho has no model to use yet. Add an API key with: rho key anthropic" });
	expect(logged).toEqual([]);
	expect(models.getProvider("claude-code")).toBeUndefined(); // the plan provider is not there unless asked for
});

test("the default is the first preferred model whose provider has a key, from the environment or stored", async () => {
	for (const [env, model] of [
		[{ ANTHROPIC_API_KEY: "k-anthropic" }, "anthropic/claude-sonnet-5-5"],
		[{ OPENAI_API_KEY: "k-openai" }, "openai/gpt-5.5"],
		[{ GEMINI_API_KEY: "k-google" }, "google/gemini-3.1-pro-preview"],
		[{ OPENROUTER_API_KEY: "k-or" }, "openrouter/anthropic/claude-sonnet-5.5"],
		[{ OPENAI_API_KEY: "k-openai", ANTHROPIC_API_KEY: "k-anthropic" }, "anthropic/claude-sonnet-5-5"], // two keys: the order of preference
	] as const) {
		const { models } = open({}, env);
		const chosen = await chooseModel(models, {});
		expect(chosen).toBe(model);
		expect(await setupOf(models, chosen)).toEqual({ ready: true, model });
	}
	// A provider outside the preferred list still gives a model to start with.
	const other = open({}, { DEEPSEEK_API_KEY: "k-deepseek" });
	expect(await chooseModel(other.models, {})).toMatch(/^deepseek\//);
	// A stored key works like one in the environment, and the configured model always wins.
	const stored = open();
	await stored.keys.modify("openai", async () => ({ type: "api_key", key: "k-stored" }));
	expect(await chooseModel(stored.models, {})).toBe("openai/gpt-5.5");
	expect(await chooseModel(stored.models, { model: "openai/gpt-5.4-mini" })).toBe("openai/gpt-5.4-mini");
});

test("every preferred model is one its provider really has", () => {
	const { models } = open();
	for (const id of ["anthropic/claude-sonnet-5-5", "openai/gpt-5.5", "google/gemini-3.1-pro-preview", "openrouter/anthropic/claude-sonnet-5.5"]) expect([id, models.getModel(id.slice(0, id.indexOf("/")), id.slice(id.indexOf("/") + 1)) !== undefined]).toEqual([id, true]);
});

test("stored keys live in keys.json, owner-only, and a broken file means no stored keys", async () => {
	const dir = scratch();
	const keys = keyStore(dir);
	expect(await keys.read("anthropic")).toBeUndefined();
	await Promise.all([keys.modify("anthropic", async () => ({ type: "api_key", key: "a" })), keys.modify("openai", async () => ({ type: "api_key", key: "o" }))]); // serialized: neither write loses the other
	expect(JSON.parse(readFileSync(keys.path, "utf8"))).toEqual({ anthropic: { type: "api_key", key: "a" }, openai: { type: "api_key", key: "o" } });
	expect(statSync(keys.path).mode & 0o777).toBe(0o600);
	expect(await keys.list()).toEqual([{ providerId: "anthropic", type: "api_key" }, { providerId: "openai", type: "api_key" }]);
	await keys.delete("anthropic");
	expect([keys.has("anthropic"), keys.has("openai")]).toEqual([false, true]);
	writeFileSync(keys.path, "{ not json");
	expect(await keys.list()).toEqual([]);
	expect((await open({}, {}, dir).models.getAvailable()).length).toBe(0); // and rho still starts
});

test("the Claude plan is opt-in: off by default, on with its warning, and never ahead of an API key", async () => {
	const off = open({}, {});
	expect(await setupOf(off.models, "claude-code/claude-opus-5-5")).toMatchObject({ ready: false, note: expect.stringContaining('"claudePlan": true') });
	const on = open({ claudePlan: true });
	expect(on.claudePlan).toBe(true);
	expect(on.logged).toEqual([CLAUDE_PLAN_WARNING]);
	expect(CLAUDE_PLAN_WARNING).toContain("This is not an API key");
	expect(CLAUDE_PLAN_WARNING).toContain("charged to usage credits");
	expect(on.models.getProvider("claude-code")).toBeDefined();
	expect(await chooseModel(on.models, { claudePlan: true })).toMatch(/^claude-code\/claude-opus/);
	// With a key as well, the key's provider is the default: the plan is a thing the person picks.
	const both = open({ claudePlan: true }, { ANTHROPIC_API_KEY: "k" });
	expect(await chooseModel(both.models, { claudePlan: true })).toBe("anthropic/claude-sonnet-5-5");
});

test("a server of the person's own is a provider from the config, and it answers", async () => {
	// A stand-in for a local model server: the OpenAI chat API, streaming.
	const seen: { auth: string | null; model: string }[] = [];
	const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: async (request) => {
		const body = (await request.json()) as { model: string };
		seen.push({ auth: request.headers.get("authorization"), model: body.model });
		const chunk = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
		return new Response(`${chunk({ role: "assistant", content: "Hello from " })}${chunk({ content: "the local model." })}${chunk({}, "stop")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
	} });
	servers.push(server);
	const config: RhoConfig = { providers: [{ id: "local", baseUrl: `http://127.0.0.1:${server.port}/v1`, models: ["small-model", { id: "big-model", contextWindow: 200_000 }] }] };
	const { models, dir, logged } = open(config);
	expect((await models.getAvailable()).map((model) => `${model.provider}/${model.id}`)).toEqual(["local/small-model", "local/big-model"]);
	const model = await chooseModel(models, config);
	expect(model).toBe("local/small-model");
	const core = await openCore({ dir, models, config: { ...config, model, cwd: dir }, memory: null });
	cores.push(core);
	const settled = await (await core.root.submit({ type: "input", content: "hello" }, context)).wait(context);
	expect(settled.status).toBe("done");
	const entries = (await core.root.entries({ order: "ascending" }, 10, undefined, context)).items;
	expect(JSON.stringify(entries.at(-1)!.model)).toContain("Hello from the local model.");
	expect(seen).toEqual([{ auth: "Bearer none", model: "small-model" }]);
	expect(logged).toEqual([]);
});

test("the variables that hold provider keys are known, so the daemon can take them out of the shell's environment", async () => {
	const names = await keyVariables({ providers: [{ id: "local", baseUrl: "http://x/v1", apiKeyEnv: "MY_SERVER_KEY", models: ["m"] }] });
	for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY", "HF_TOKEN", "MY_SERVER_KEY"]) expect([name, names.includes(name)]).toEqual([name, true]);
	// Not what the person's own commands need: paths, regions, their cloud login.
	for (const name of ["PATH", "HOME", "AWS_PROFILE", "AWS_ACCESS_KEY_ID", "AWS_REGION"]) expect([name, names.includes(name)]).toEqual([name, false]);
});

test("a bad provider entry is left out with a reason, and the rest still load", async () => {
	const { models, logged } = open({ providers: [{ id: "Bad Id", baseUrl: "http://x/v1", models: ["m"] }, { id: "nourl", baseUrl: "ftp://x", models: ["m"] }, { id: "empty", baseUrl: "http://x/v1", models: [] }, { id: "anthropic", baseUrl: "http://x/v1", models: ["m"] }, { id: "keyed", baseUrl: "http://x/v1", apiKeyEnv: "MY_KEY", models: ["m"] }, { id: "good", baseUrl: "http://x/v1", models: ["m"] }] });
	expect(logged.length).toBe(4);
	expect(logged.join("\n")).toContain("that id is taken by a built-in provider");
	expect(logged.join("\n")).toContain("baseUrl is an http or https address");
	expect((await models.getAvailable()).map((model) => model.provider)).toEqual(["good"]); // "keyed" waits for MY_KEY
	expect(open({ providers: "nope" }).logged).toEqual(["config: providers is a list and was ignored."]);
});

test("a conversation whose model can no longer be used moves to the new default at the next start", async () => {
	const dir = scratch();
	const faux = fauxProvider();
	faux.setResponses([fauxAssistantMessage("still here")]);
	const first = open({ claudePlan: true }, {}, dir);
	const core = await openCore({ dir, models: first.models, config: { model: "claude-code/claude-opus-5-5", cwd: dir }, memory: null });
	expect((await core.root.agent(context)).model).toEqual({ provider: "claude-code", modelId: "claude-opus-5-5" });
	await core.close();
	// The plan is turned off and another provider is set up.
	const second = open({}, {}, dir);
	second.models.setProvider(faux.provider);
	const id = `${faux.getModel().provider}/${faux.getModel().id}`;
	const logged: string[] = [];
	const again = await openCore({ dir, models: second.models, config: { model: id, cwd: dir }, memory: null, log: (line) => logged.push(line) });
	cores.push(again);
	expect((await again.root.agent(context)).model).toEqual({ provider: faux.getModel().provider, modelId: faux.getModel().id });
	expect(logged.join("\n")).toContain(`models: claude-code/claude-opus-5-5 cannot be used; "the first conversation" now uses ${id}.`);
	expect((await (await again.root.submit({ type: "input", content: "hi" }, context)).wait(context)).status).toBe("done");
});
