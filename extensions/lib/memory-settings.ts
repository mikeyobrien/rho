import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseInitToml } from "../../cli/config.ts";

const HOME = process.env.HOME || os.homedir();
export const DEFAULT_INIT_TOML_PATH = path.join(HOME, ".rho", "init.toml");
export const DEFAULT_LEGACY_MEMORY_CONFIG_PATH = path.join(
	HOME,
	".rho",
	"config.json",
);

export interface MemorySettings {
	autoMemory: boolean;
	autoMemoryModel?: string;
	promptBudget: number;
	decayAfterDays: number;
	decayMinScore: number;
}

export const DEFAULT_MEMORY_SETTINGS: MemorySettings = {
	autoMemory: true,
	autoMemoryModel: undefined,
	promptBudget: 2000,
	decayAfterDays: 90,
	decayMinScore: 3,
};

export interface ConfiguredMemorySettings {
	autoMemory?: boolean;
	autoMemoryModel?: string;
	promptBudget?: number;
	decayAfterDays?: number;
	decayMinScore?: number;
}

interface LegacyMemorySettings {
	autoMemory?: boolean;
	promptBudget?: number;
	decayAfterDays?: number;
	decayMinScore?: number;
}

export interface MemorySettingsMigrationResult {
	changed: boolean;
	migratedKeys: string[];
}

type InitMemoryTomlKey =
	| "auto_memory"
	| "auto_memory_model"
	| "prompt_budget"
	| "decay_after_days"
	| "decay_min_score";

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function readInitRawMemorySettings(initPath: string): Record<string, unknown> {
	try {
		if (!fs.existsSync(initPath)) return {};
		const raw = fs.readFileSync(initPath, "utf-8");
		const config = parseInitToml(raw);
		return (
			(config.settings.memory as Record<string, unknown> | undefined) ?? {}
		);
	} catch {
		return {};
	}
}

function canParseInitToml(initPath: string): boolean {
	try {
		if (!fs.existsSync(initPath)) return false;
		parseInitToml(fs.readFileSync(initPath, "utf-8"));
		return true;
	} catch {
		return false;
	}
}

export function readConfiguredMemorySettings(
	initPath: string = DEFAULT_INIT_TOML_PATH,
): ConfiguredMemorySettings {
	const memory = readInitRawMemorySettings(initPath);
	const autoMemory =
		typeof memory.auto_memory === "boolean" ? memory.auto_memory : undefined;
	const autoMemoryModel =
		typeof memory.auto_memory_model === "string" &&
		memory.auto_memory_model.trim()
			? memory.auto_memory_model.trim()
			: undefined;
	const promptBudget = isFiniteNumber(memory.prompt_budget)
		? memory.prompt_budget
		: undefined;
	const decayAfterDays = isFiniteNumber(memory.decay_after_days)
		? memory.decay_after_days
		: undefined;
	const decayMinScore = isFiniteNumber(memory.decay_min_score)
		? memory.decay_min_score
		: undefined;

	return {
		autoMemory,
		autoMemoryModel,
		promptBudget,
		decayAfterDays,
		decayMinScore,
	};
}

function readLegacyMemorySettings(
	configPath: string = DEFAULT_LEGACY_MEMORY_CONFIG_PATH,
): LegacyMemorySettings {
	try {
		if (!fs.existsSync(configPath)) return {};
		const raw = fs.readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(raw) as unknown;
		if (!parsed || typeof parsed !== "object") return {};
		const obj = parsed as Record<string, unknown>;
		const autoMemory =
			typeof obj.autoMemory === "boolean"
				? obj.autoMemory
				: typeof obj.auto_memory === "boolean"
					? obj.auto_memory
					: undefined;
		const promptBudget = isFiniteNumber(obj.promptBudget)
			? obj.promptBudget
			: undefined;
		const decayAfterDays = isFiniteNumber(obj.decayAfterDays)
			? obj.decayAfterDays
			: undefined;
		const decayMinScore = isFiniteNumber(obj.decayMinScore)
			? obj.decayMinScore
			: undefined;
		return { autoMemory, promptBudget, decayAfterDays, decayMinScore };
	} catch {
		return {};
	}
}

export function readMemorySettings(
	initPath: string = DEFAULT_INIT_TOML_PATH,
): MemorySettings {
	const configured = readConfiguredMemorySettings(initPath);
	return {
		autoMemory: configured.autoMemory ?? DEFAULT_MEMORY_SETTINGS.autoMemory,
		autoMemoryModel:
			configured.autoMemoryModel ?? DEFAULT_MEMORY_SETTINGS.autoMemoryModel,
		promptBudget:
			configured.promptBudget ?? DEFAULT_MEMORY_SETTINGS.promptBudget,
		decayAfterDays:
			configured.decayAfterDays ?? DEFAULT_MEMORY_SETTINGS.decayAfterDays,
		decayMinScore:
			configured.decayMinScore ?? DEFAULT_MEMORY_SETTINGS.decayMinScore,
	};
}

export function getAutoMemoryEffective(options?: {
	initPath?: string;
	env?: NodeJS.ProcessEnv;
}): { enabled: boolean; source: "env" | "init" | "default" } {
	const env = options?.env ?? process.env;
	if (env.RHO_SUBAGENT === "1") return { enabled: false, source: "env" };

	const envValue = (env.RHO_AUTO_MEMORY || "").trim().toLowerCase();
	if (envValue === "0" || envValue === "false" || envValue === "off") {
		return { enabled: false, source: "env" };
	}
	if (envValue === "1" || envValue === "true" || envValue === "on") {
		return { enabled: true, source: "env" };
	}

	const configured = readConfiguredMemorySettings(options?.initPath);
	if (typeof configured.autoMemory === "boolean") {
		return { enabled: configured.autoMemory, source: "init" };
	}
	return { enabled: DEFAULT_MEMORY_SETTINGS.autoMemory, source: "default" };
}

function serializeTomlValue(value: boolean | number | string): string {
	if (typeof value === "boolean" || typeof value === "number") {
		return String(value);
	}
	return JSON.stringify(value);
}

function findMemorySectionRange(
	lines: string[],
): { start: number; end: number } | null {
	const start = lines.findIndex((line) => line.trim() === "[settings.memory]");
	if (start === -1) return null;
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (lines[i].trim().startsWith("[")) {
			end = i;
			break;
		}
	}
	return { start, end };
}

function upsertMemorySettingLine(
	lines: string[],
	key: InitMemoryTomlKey,
	value: boolean | number | string,
): void {
	const rendered = serializeTomlValue(value);
	const range = findMemorySectionRange(lines);
	if (!range) {
		if (lines.length > 0 && lines[lines.length - 1].trim() !== "") {
			lines.push("");
		}
		lines.push("[settings.memory]", `${key} = ${rendered}`);
		return;
	}

	const matcher = new RegExp(
		`^(\\s*)#?\\s*${key.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}\\s*=.*?(\\s+#.*)?$`,
	);
	for (let i = range.start + 1; i < range.end; i++) {
		const line = lines[i];
		const match = line.match(matcher);
		if (!match) continue;
		const indent = match[1] ?? "";
		const comment = match[2] ?? "";
		lines[i] = `${indent}${key} = ${rendered}${comment}`;
		return;
	}

	lines.splice(range.end, 0, `${key} = ${rendered}`);
}

function writeMemorySettingsToInitToml(
	initPath: string,
	settings: Partial<Record<InitMemoryTomlKey, boolean | number | string>>,
): boolean {
	if (!fs.existsSync(initPath)) return false;
	const original = fs.readFileSync(initPath, "utf-8");
	const lines = original.split("\n");
	for (const [key, value] of Object.entries(settings)) {
		if (value === undefined) continue;
		upsertMemorySettingLine(lines, key as InitMemoryTomlKey, value);
	}
	const updated = lines.join("\n");
	if (updated === original) return false;
	fs.writeFileSync(initPath, updated);
	return true;
}

export function migrateLegacyMemoryConfigToInitToml(
	initPath: string = DEFAULT_INIT_TOML_PATH,
	configPath: string = DEFAULT_LEGACY_MEMORY_CONFIG_PATH,
): MemorySettingsMigrationResult {
	if (!canParseInitToml(initPath)) {
		return { changed: false, migratedKeys: [] };
	}

	const configured = readConfiguredMemorySettings(initPath);
	const legacy = readLegacyMemorySettings(configPath);
	const pending: Partial<Record<InitMemoryTomlKey, boolean | number | string>> =
		{};
	const migratedKeys: string[] = [];

	if (
		configured.autoMemory === undefined &&
		typeof legacy.autoMemory === "boolean"
	) {
		pending.auto_memory = legacy.autoMemory;
		migratedKeys.push("auto_memory");
	}
	if (
		configured.promptBudget === undefined &&
		typeof legacy.promptBudget === "number"
	) {
		pending.prompt_budget = legacy.promptBudget;
		migratedKeys.push("prompt_budget");
	}
	if (
		configured.decayAfterDays === undefined &&
		typeof legacy.decayAfterDays === "number"
	) {
		pending.decay_after_days = legacy.decayAfterDays;
		migratedKeys.push("decay_after_days");
	}
	if (
		configured.decayMinScore === undefined &&
		typeof legacy.decayMinScore === "number"
	) {
		pending.decay_min_score = legacy.decayMinScore;
		migratedKeys.push("decay_min_score");
	}

	if (migratedKeys.length === 0) {
		return { changed: false, migratedKeys: [] };
	}

	const changed = writeMemorySettingsToInitToml(initPath, pending);
	return { changed, migratedKeys: changed ? migratedKeys : [] };
}

export function setInitAutoMemoryEnabled(
	enabled: boolean,
	initPath: string = DEFAULT_INIT_TOML_PATH,
): boolean {
	return writeMemorySettingsToInitToml(initPath, { auto_memory: enabled });
}
