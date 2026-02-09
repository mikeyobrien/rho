/**
 * rho config — Show current configuration.
 *
 * Reads ~/.rho/init.toml and displays the effective configuration:
 * agent name, enabled/disabled modules, and settings.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { parseInitToml } from "../config.ts";

const HOME = process.env.HOME || os.homedir();
const RHO_DIR = path.join(HOME, ".rho");
const INIT_TOML = path.join(RHO_DIR, "init.toml");

export async function run(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`rho config

Show the current Rho configuration from ~/.rho/init.toml.

Options:
  --json       Output as JSON
  -h, --help   Show this help`);
    return;
  }

  if (!fs.existsSync(INIT_TOML)) {
    console.error(`No config found. Run \`rho init\` to create ~/.rho/init.toml.`);
    process.exit(1);
  }

  let config;
  try {
    config = parseInitToml(fs.readFileSync(INIT_TOML, "utf-8"));
  } catch (err: any) {
    console.error(`Error parsing init.toml: ${err.message}`);
    process.exit(1);
  }

  if (args.includes("--json")) {
    console.log(JSON.stringify(config, null, 2));
    return;
  }

  // Agent
  console.log(`Agent: ${config.agent.name}`);
  console.log("");

  // Modules
  console.log("Modules:");
  const categories = ["core", "knowledge", "tools", "skills", "ui"] as const;
  for (const cat of categories) {
    const mods = config.modules[cat] ?? {};
    const entries = Object.entries(mods);
    if (entries.length === 0) continue;
    const parts = entries.map(([name, enabled]) => `${name} ${enabled ? "✓" : "✗"}`);
    console.log(`  ${cat.padEnd(12)} ${parts.join("  ")}`);
  }

  // Settings
  const settingsKeys = Object.keys(config.settings);
  if (settingsKeys.length > 0) {
    console.log("");
    console.log("Settings:");
    for (const [section, values] of Object.entries(config.settings)) {
      for (const [key, val] of Object.entries(values as Record<string, unknown>)) {
        const display = typeof val === "string" ? `"${val}"` : String(val);
        console.log(`  ${section}.${key} = ${display}`);
      }
    }
  }
}
