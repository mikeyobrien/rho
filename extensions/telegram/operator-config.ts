import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface TelegramOperatorConfig {
  allowedChatIds: number[];
  allowedUserIds: number[];
}

function normalizeIdList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const unique = new Set<number>();
  for (const item of value) {
    if (
      typeof item !== "number" ||
      !Number.isFinite(item) ||
      !Number.isInteger(item)
    )
      continue;
    unique.add(item);
  }
  return [...unique];
}

export function normalizeOperatorConfig(
  input: Partial<TelegramOperatorConfig> | null | undefined,
): TelegramOperatorConfig {
  return {
    allowedChatIds: normalizeIdList(input?.allowedChatIds),
    allowedUserIds: normalizeIdList(input?.allowedUserIds),
  };
}

export function getOperatorConfigPath(
  homeDir = process.env.HOME || homedir(),
): string {
  return join(homeDir, ".rho", "telegram", "config.json");
}

export function loadOperatorConfig(
  configPath = getOperatorConfigPath(),
): TelegramOperatorConfig | null {
  if (!existsSync(configPath)) return null;
  try {
    const parsed = JSON.parse(
      readFileSync(configPath, "utf-8"),
    ) as Partial<TelegramOperatorConfig>;
    return normalizeOperatorConfig(parsed);
  } catch {
    return null;
  }
}

export function saveOperatorConfig(
  config: TelegramOperatorConfig,
  configPath = getOperatorConfigPath(),
): void {
  const normalized = normalizeOperatorConfig(config);
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(normalized, null, 2));
}
