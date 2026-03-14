/**
 * Tests for memory settings migration and init-backed reads.
 * Run: npx tsx tests/test-memory-settings.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	DEFAULT_MEMORY_SETTINGS,
	type MemorySettings,
	migrateLegacyMemoryConfigToInitToml,
	readConfiguredMemorySettings,
	readMemorySettings,
	setInitAutoMemoryEnabled,
} from "../extensions/lib/memory-settings.ts";

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

function makeTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "rho-memory-settings-"));
}

function writeInitToml(dir: string, content: string): string {
	const initPath = path.join(dir, "init.toml");
	fs.writeFileSync(initPath, content);
	return initPath;
}

function writeLegacyConfig(
	dir: string,
	content: Record<string, unknown>,
): string {
	const configPath = path.join(dir, "config.json");
	fs.writeFileSync(configPath, JSON.stringify(content, null, 2));
	return configPath;
}

function readFile(filePath: string): string {
	return fs.readFileSync(filePath, "utf-8");
}

console.log("\n-- readMemorySettings defaults --");
{
	const dir = makeTempDir();
	const initPath = writeInitToml(
		dir,
		`
[agent]
name = "rho"

[modules.core]
heartbeat = true
memory = true
`,
	);
	assertEq(
		readConfiguredMemorySettings(initPath),
		{},
		"configured settings empty when section missing",
	);
	assertEq(
		readMemorySettings(initPath),
		DEFAULT_MEMORY_SETTINGS,
		"defaults returned when memory section missing",
	);
}

console.log("\n-- readMemorySettings from init.toml --");
{
	const dir = makeTempDir();
	const initPath = writeInitToml(
		dir,
		`
[agent]
name = "rho"

[modules.core]
heartbeat = true
memory = true

[settings.memory]
auto_memory = false
auto_memory_model = "openai/gpt-5-mini"
prompt_budget = 111
decay_after_days = 12
decay_min_score = 7
`,
	);
	const expected: MemorySettings = {
		autoMemory: false,
		autoMemoryModel: "openai/gpt-5-mini",
		promptBudget: 111,
		decayAfterDays: 12,
		decayMinScore: 7,
	};
	assertEq(
		readMemorySettings(initPath),
		expected,
		"init-backed memory settings override defaults",
	);
}

console.log(
	"\n-- migrateLegacyMemoryConfigToInitToml copies missing values --",
);
{
	const dir = makeTempDir();
	const initPath = writeInitToml(
		dir,
		`
[agent]
name = "rho"

[modules.core]
heartbeat = true
memory = true
`,
	);
	const configPath = writeLegacyConfig(dir, {
		autoMemory: false,
		promptBudget: 444,
		decayAfterDays: 15,
		decayMinScore: 9,
	});
	const result = migrateLegacyMemoryConfigToInitToml(initPath, configPath);
	assertEq(
		result.changed,
		true,
		"migration changes init.toml when legacy values exist",
	);
	assertEq(
		result.migratedKeys.sort(),
		["auto_memory", "decay_after_days", "decay_min_score", "prompt_budget"],
		"expected legacy keys migrated",
	);
	const migrated = readFile(initPath);
	assert(
		migrated.includes("[settings.memory]"),
		"migration adds settings.memory section",
	);
	assert(
		migrated.includes("auto_memory = false"),
		"migration writes auto_memory",
	);
	assert(
		migrated.includes("prompt_budget = 444"),
		"migration writes prompt_budget",
	);
	assertEq(
		readMemorySettings(initPath).promptBudget,
		444,
		"runtime reads migrated prompt_budget",
	);
}

console.log(
	"\n-- migrateLegacyMemoryConfigToInitToml preserves init values --",
);
{
	const dir = makeTempDir();
	const initPath = writeInitToml(
		dir,
		`
[agent]
name = "rho"

[modules.core]
heartbeat = true
memory = true

[settings.memory]
auto_memory = true
prompt_budget = 999
`,
	);
	const configPath = writeLegacyConfig(dir, {
		autoMemory: false,
		promptBudget: 111,
		decayAfterDays: 22,
		decayMinScore: 5,
	});
	const result = migrateLegacyMemoryConfigToInitToml(initPath, configPath);
	assertEq(result.changed, true, "migration still writes missing keys");
	assertEq(
		result.migratedKeys.sort(),
		["decay_after_days", "decay_min_score"],
		"only missing keys are migrated",
	);
	const settings = readMemorySettings(initPath);
	assertEq(
		settings.autoMemory,
		true,
		"init auto_memory wins over legacy config",
	);
	assertEq(
		settings.promptBudget,
		999,
		"init prompt_budget wins over legacy config",
	);
	assertEq(
		settings.decayAfterDays,
		22,
		"missing decay_after_days seeded from legacy config",
	);
}

console.log("\n-- setInitAutoMemoryEnabled updates canonical config --");
{
	const dir = makeTempDir();
	const initPath = writeInitToml(
		dir,
		`
[agent]
name = "rho"

[modules.core]
heartbeat = true
memory = true

[settings.memory]
# auto_memory = true               # Auto-extract learnings/preferences from conversations
`,
	);
	setInitAutoMemoryEnabled(false, initPath);
	const updated = readFile(initPath);
	assert(
		updated.includes("auto_memory = false"),
		"toggle writes uncommented canonical value",
	);
	assertEq(
		readMemorySettings(initPath).autoMemory,
		false,
		"updated init value is readable",
	);
}

console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
