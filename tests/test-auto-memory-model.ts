/**
 * Tests for auto-memory model selection.
 * Run: npx tsx tests/test-auto-memory-model.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	type AutoMemoryModelLike,
	type AutoMemoryModelRegistryLike,
	readInitAutoMemoryModelSetting,
	resolveAutoMemoryModel,
} from "../extensions/lib/auto-memory-model.ts";

let PASS = 0;
let FAIL = 0;

function assert(condition: boolean, label: string): void {
	if (condition) {
		console.log(`  PASS: ${label}`);
		PASS++;
	} else {
		console.error(`  FAIL: ${label}`);
		FAIL++;
	}
}

function assertEq(actual: unknown, expected: unknown, label: string): void {
	const ok = JSON.stringify(actual) === JSON.stringify(expected);
	if (ok) {
		console.log(`  PASS: ${label}`);
		PASS++;
	} else {
		console.error(
			`  FAIL: ${label} — got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
		);
		FAIL++;
	}
}

type FakeModel = AutoMemoryModelLike & {
	name: string;
	maxTokens?: number;
};

class FakeRegistry implements AutoMemoryModelRegistryLike<FakeModel> {
	constructor(
		private readonly models: FakeModel[],
		private readonly keyed: Set<string>,
	) {}

	find(provider: string, id: string): FakeModel | undefined {
		return this.models.find(
			(model) => model.provider === provider && model.id === id,
		);
	}

	getAll(): FakeModel[] {
		return [...this.models];
	}

	async getApiKey(model: FakeModel): Promise<string | null> {
		return this.keyed.has(`${model.provider}/${model.id}`)
			? `key:${model.id}`
			: null;
	}
}

function createTempInitToml(content: string): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rho-auto-memory-model-"));
	const initPath = path.join(dir, "init.toml");
	fs.writeFileSync(initPath, content);
	return initPath;
}

const CHEAP: FakeModel = {
	provider: "openai",
	id: "gpt-5-mini",
	name: "GPT 5 Mini",
	cost: { output: 0.25 },
};
const EXPENSIVE: FakeModel = {
	provider: "openai",
	id: "gpt-5-pro",
	name: "GPT 5 Pro",
	cost: { output: 2.5 },
};
const OTHER_PROVIDER: FakeModel = {
	provider: "anthropic",
	id: "claude-sonnet-4",
	name: "Claude Sonnet 4",
	cost: { output: 3 },
};

console.log("\n-- readInitAutoMemoryModelSetting --");
{
	const initPath = createTempInitToml(`
[agent]
name = "rho"

[modules.core]
heartbeat = true
memory = true
`);
	assertEq(
		readInitAutoMemoryModelSetting(initPath),
		undefined,
		"unset returns undefined",
	);
}

{
	const initPath = createTempInitToml(`
[agent]
name = "rho"

[modules.core]
heartbeat = true
memory = true

[settings.memory]
auto_memory_model = "auto"
`);
	assertEq(
		readInitAutoMemoryModelSetting(initPath),
		"auto",
		"reads explicit auto setting",
	);
}

{
	const initPath = createTempInitToml(`
[agent]
name = "rho"

[modules.core]
heartbeat = true
memory = true

[settings.memory]
auto_memory_model = "openai/gpt-5-mini"
`);
	assertEq(
		readInitAutoMemoryModelSetting(initPath),
		"openai/gpt-5-mini",
		"reads pinned provider/model setting",
	);
}

console.log("\n-- resolveAutoMemoryModel --");
{
	const registry = new FakeRegistry(
		[EXPENSIVE, CHEAP, OTHER_PROVIDER],
		new Set(["openai/gpt-5-pro", "openai/gpt-5-mini"]),
	);
	const resolved = await resolveAutoMemoryModel({
		configuredModel: undefined,
		currentModel: EXPENSIVE,
		registry,
	});
	assertEq(
		resolved?.model.id,
		"gpt-5-mini",
		"unset config picks cheapest keyed model from same provider",
	);
	assertEq(resolved?.source, "auto", "unset config uses auto source");
}

{
	const registry = new FakeRegistry(
		[EXPENSIVE, CHEAP, OTHER_PROVIDER],
		new Set(["openai/gpt-5-pro", "openai/gpt-5-mini"]),
	);
	const resolved = await resolveAutoMemoryModel({
		configuredModel: "auto",
		currentModel: EXPENSIVE,
		registry,
	});
	assertEq(
		resolved?.model.id,
		"gpt-5-mini",
		"explicit auto preserves legacy behavior",
	);
	assertEq(
		resolved?.requestedModel,
		"auto",
		"explicit auto records requested model",
	);
}

{
	const registry = new FakeRegistry(
		[EXPENSIVE, CHEAP, OTHER_PROVIDER],
		new Set([
			"openai/gpt-5-pro",
			"openai/gpt-5-mini",
			"anthropic/claude-sonnet-4",
		]),
	);
	const resolved = await resolveAutoMemoryModel({
		configuredModel: "anthropic/claude-sonnet-4",
		currentModel: EXPENSIVE,
		registry,
	});
	assertEq(
		resolved?.model.provider,
		"anthropic",
		"pinned config can cross providers",
	);
	assertEq(
		resolved?.model.id,
		"claude-sonnet-4",
		"pinned config uses exact model",
	);
	assertEq(
		resolved?.source,
		"configured",
		"pinned config reports configured source",
	);
}

{
	const registry = new FakeRegistry(
		[EXPENSIVE, CHEAP],
		new Set(["openai/gpt-5-pro", "openai/gpt-5-mini"]),
	);
	const resolved = await resolveAutoMemoryModel({
		configuredModel: "bad-model-id",
		currentModel: EXPENSIVE,
		registry,
	});
	assertEq(
		resolved?.model.id,
		"gpt-5-mini",
		"malformed config falls back to auto",
	);
	assert(
		Boolean(resolved?.warning?.includes("provider/model-id")),
		"malformed config emits warning",
	);
}

{
	const registry = new FakeRegistry(
		[EXPENSIVE, CHEAP],
		new Set(["openai/gpt-5-pro", "openai/gpt-5-mini"]),
	);
	const resolved = await resolveAutoMemoryModel({
		configuredModel: "openai/does-not-exist",
		currentModel: EXPENSIVE,
		registry,
	});
	assertEq(
		resolved?.model.id,
		"gpt-5-mini",
		"unknown configured model falls back to auto",
	);
	assert(
		Boolean(resolved?.warning?.includes("not found")),
		"unknown configured model warns",
	);
}

{
	const registry = new FakeRegistry(
		[EXPENSIVE, CHEAP],
		new Set(["openai/gpt-5-pro", "openai/gpt-5-mini"]),
	);
	const resolved = await resolveAutoMemoryModel({
		configuredModel: "openai/gpt-5-pro",
		currentModel: CHEAP,
		registry: new FakeRegistry(
			[EXPENSIVE, CHEAP],
			new Set(["openai/gpt-5-mini"]),
		),
	});
	assertEq(
		resolved?.model.id,
		"gpt-5-mini",
		"configured model without key falls back safely",
	);
	assert(
		Boolean(resolved?.warning?.includes("API key")),
		"missing API key emits warning",
	);
}

{
	const registry = new FakeRegistry(
		[EXPENSIVE, CHEAP],
		new Set(["openai/gpt-5-mini"]),
	);
	const resolved = await resolveAutoMemoryModel({
		configuredModel: "openai/gpt-5-mini",
		currentModel: null,
		registry,
	});
	assertEq(
		resolved?.model.id,
		"gpt-5-mini",
		"pinned model can resolve without session model",
	);
}

console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
