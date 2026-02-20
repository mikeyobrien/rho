/**
 * Tests for cli/config.ts — TOML config parser and validator.
 * Run: npx tsx tests/test-config.ts
 */

// ---- Test harness ----
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

function assertThrows(
	fn: () => void,
	label: string,
	msgIncludes?: string,
): void {
	try {
		fn();
		console.error(`  FAIL: ${label} — expected throw, got none`);
		FAIL++;
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error);
		if (msgIncludes && !message.includes(msgIncludes)) {
			console.error(
				`  FAIL: ${label} — error "${message}" doesn't include "${msgIncludes}"`,
			);
			FAIL++;
		} else {
			console.log(`  PASS: ${label}`);
			PASS++;
		}
	}
}

function normalizePath(value: string): string {
	return value.replaceAll("\\", "/");
}

// ---- Import ----
import {
	type PackagesConfig,
	type RhoConfig,
	type ValidationResult,
	parseInitToml,
	parsePackagesToml,
	validateConfig,
} from "../cli/config.ts";

// ================================================================
// parseInitToml
// ================================================================
console.log("\n-- parseInitToml: valid full config --");
{
	const toml = `
[agent]
name = "tau"

[modules.core]
heartbeat = true
memory = true

[modules.knowledge]
vault = true

[modules.tools]
brave-search = true
x-search = false
email = true
session-search = true
update-pi = true

[modules.ui]
usage-bars = true

[modules.skills]

[settings.heartbeat]
interval = "30m"

[settings.email]
handle = "tau"
`;
	const cfg = parseInitToml(toml);
	assertEq(cfg.agent.name, "tau", "agent.name parsed");
	assertEq(cfg.modules.core.heartbeat, true, "core.heartbeat is true");
	assertEq(cfg.modules.core.memory, true, "core.memory is true");
	assertEq(cfg.modules.knowledge.vault, true, "knowledge.vault is true");
	assertEq(
		cfg.modules.tools["brave-search"],
		true,
		"tools.brave-search is true",
	);
	assertEq(cfg.modules.tools["x-search"], false, "tools.x-search is false");
	assertEq(
		cfg.settings.heartbeat.interval,
		"30m",
		"settings.heartbeat.interval",
	);
	assertEq(cfg.settings.email.handle, "tau", "settings.email.handle");
}

console.log("\n-- parseInitToml: minimal config --");
{
	const toml = `
[agent]
name = "rho"

[modules.core]
heartbeat = true
memory = true
`;
	const cfg = parseInitToml(toml);
	assertEq(cfg.agent.name, "rho", "minimal: agent name");
	assertEq(cfg.modules.core.heartbeat, true, "minimal: core modules present");
	// Missing category sections should be empty objects
	assertEq(cfg.modules.knowledge, {}, "minimal: missing knowledge = empty");
	assertEq(cfg.modules.tools, {}, "minimal: missing tools = empty");
	assertEq(cfg.modules.ui, {}, "minimal: missing ui = empty");
	assertEq(cfg.modules.skills, {}, "minimal: missing skills = empty");
	assertEq(cfg.settings, {}, "minimal: missing settings = empty");
}

console.log("\n-- parseInitToml: projects_dir is top-level and resolved --");
{
	const toml = `
projects_dir = "~/projects"

[agent]
name = "rho"

[modules.core]
heartbeat = true
memory = true
`;
	const cfg = parseInitToml(toml);
	const normalized = normalizePath(cfg.projectsDir ?? "");
	assert(
		normalized.endsWith("/projects"),
		"projects_dir top-level is resolved",
	);
}

console.log("\n-- parseInitToml: agent.projects_dir is ignored --");
{
	const toml = `
[agent]
name = "rho"
projects_dir = "~/wrong"

[modules.core]
heartbeat = true
memory = true
`;
	const cfg = parseInitToml(toml);
	const normalized = normalizePath(cfg.projectsDir ?? "");
	assert(
		normalized.endsWith("/.rho/projects"),
		"agent.projects_dir does not override top-level projects_dir",
	);
}

console.log("\n-- parseInitToml: missing agent section --");
{
	const toml = `
[modules.core]
heartbeat = true
memory = true
`;
	assertThrows(() => parseInitToml(toml), "missing [agent] throws", "agent");
}

console.log("\n-- parseInitToml: missing agent.name --");
{
	const toml = `
[agent]

[modules.core]
heartbeat = true
memory = true
`;
	assertThrows(() => parseInitToml(toml), "missing agent.name throws", "name");
}

console.log("\n-- parseInitToml: invalid TOML syntax --");
assertThrows(
	() => parseInitToml("this is not [valid toml = ="),
	"invalid TOML throws",
);

console.log("\n-- parseInitToml: module value not boolean --");
{
	const toml = `
[agent]
name = "test"

[modules.core]
heartbeat = "yes"
memory = true
`;
	assertThrows(
		() => parseInitToml(toml),
		"non-boolean module value throws",
		"boolean",
	);
}

console.log("\n-- parseInitToml: settings preserved as-is --");
{
	const toml = `
[agent]
name = "test"

[modules.core]
heartbeat = true
memory = true

[settings.heartbeat]
interval = "1h"
custom_flag = true
nested_num = 42
`;
	const cfg = parseInitToml(toml);
	assertEq(cfg.settings.heartbeat.interval, "1h", "settings string value");
	assertEq(cfg.settings.heartbeat.custom_flag, true, "settings bool value");
	assertEq(cfg.settings.heartbeat.nested_num, 42, "settings number value");
}

// ================================================================
// parsePackagesToml
// ================================================================
console.log("\n-- parsePackagesToml: valid config --");
{
	const toml = `
[[packages]]
source = "npm:some-package"

[[packages]]
source = "git:github.com/user/repo"
extensions = ["extensions/foo.ts"]
skills = ["skills/bar"]
`;
	const pkg = parsePackagesToml(toml);
	assertEq(pkg.packages.length, 2, "two packages parsed");
	assertEq(pkg.packages[0].source, "npm:some-package", "first package source");
	assertEq(
		pkg.packages[0].extensions,
		undefined,
		"first package no extensions filter",
	);
	assertEq(
		pkg.packages[1].source,
		"git:github.com/user/repo",
		"second package source",
	);
	assertEq(
		pkg.packages[1].extensions,
		["extensions/foo.ts"],
		"second package extensions filter",
	);
	assertEq(
		pkg.packages[1].skills,
		["skills/bar"],
		"second package skills filter",
	);
}

console.log("\n-- parsePackagesToml: empty --");
{
	const toml = "# No packages yet";
	const pkg = parsePackagesToml(toml);
	assertEq(pkg.packages, [], "empty packages = empty array");
}

console.log("\n-- parsePackagesToml: missing source --");
{
	const toml = `
[[packages]]
extensions = ["extensions/foo.ts"]
`;
	assertThrows(
		() => parsePackagesToml(toml),
		"package without source throws",
		"source",
	);
}

console.log("\n-- parsePackagesToml: invalid TOML --");
assertThrows(
	() => parsePackagesToml("[[packages\nbroken"),
	"invalid TOML throws",
);

// ================================================================
// validateConfig
// ================================================================
console.log("\n-- validateConfig: valid config --");
{
	const cfg: RhoConfig = {
		agent: { name: "tau" },
		modules: {
			core: { heartbeat: true, memory: true },
			knowledge: { vault: true },
			tools: { "brave-search": true, email: false },
			ui: { "usage-bars": true },
			skills: { "session-search": true },
		},
		settings: { heartbeat: { interval: "30m" } },
	};
	const result = validateConfig(cfg);
	assertEq(result.valid, true, "valid config passes");
	assertEq(result.errors.length, 0, "no errors");
}

console.log("\n-- validateConfig: unknown module name --");
{
	const cfg: RhoConfig = {
		agent: { name: "test" },
		modules: {
			core: { heartbeat: true, memory: true },
			knowledge: { "nonexistent-module": true },
			tools: {},
			ui: {},
			skills: {},
		},
		settings: {},
	};
	const result = validateConfig(cfg);
	assertEq(result.valid, false, "unknown module fails");
	assert(
		result.errors.some((e) => e.includes("nonexistent-module")),
		"error mentions bad module",
	);
}

console.log("\n-- validateConfig: module in wrong category --");
{
	const cfg: RhoConfig = {
		agent: { name: "test" },
		modules: {
			core: { heartbeat: true, memory: true },
			knowledge: {},
			tools: { vault: true }, // vault belongs in knowledge, not tools
			ui: {},
			skills: {},
		},
		settings: {},
	};
	const result = validateConfig(cfg);
	assertEq(result.valid, false, "wrong category fails");
	assert(
		result.errors.some((e) => e.includes("vault")),
		"error mentions vault",
	);
}

console.log("\n-- validateConfig: core module set to false --");
{
	const cfg: RhoConfig = {
		agent: { name: "test" },
		modules: {
			core: { heartbeat: false, memory: true },
			knowledge: {},
			tools: {},
			ui: {},
			skills: {},
		},
		settings: {},
	};
	const result = validateConfig(cfg);
	// Should have a warning, not an error — core modules are forced on
	assert(result.warnings.length > 0, "core=false produces warning");
	assert(
		result.warnings.some((w) => w.includes("heartbeat")),
		"warning mentions heartbeat",
	);
}

console.log("\n-- validateConfig: settings for unknown module --");
{
	const cfg: RhoConfig = {
		agent: { name: "test" },
		modules: {
			core: { heartbeat: true, memory: true },
			knowledge: {},
			tools: {},
			ui: {},
			skills: {},
		},
		settings: { "fake-module": { key: "val" } },
	};
	const result = validateConfig(cfg);
	assert(result.warnings.length > 0, "settings for unknown module warns");
	assert(
		result.warnings.some((w) => w.includes("fake-module")),
		"warning mentions fake-module",
	);
}

console.log("\n-- validateConfig: empty agent name --");
{
	const cfg: RhoConfig = {
		agent: { name: "" },
		modules: {
			core: { heartbeat: true, memory: true },
			knowledge: {},
			tools: {},
			ui: {},
			skills: {},
		},
		settings: {},
	};
	const result = validateConfig(cfg);
	assertEq(result.valid, false, "empty name fails");
	assert(
		result.errors.some((e) => e.includes("name")),
		"error mentions name",
	);
}

// ---- Summary ----
console.log(`\n=== Results: ${PASS} passed, ${FAIL} failed ===\n`);
process.exit(FAIL > 0 ? 1 : 0);
