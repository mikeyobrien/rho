/**
 * rho init — Initialize a new Rho configuration.
 *
 * Creates ~/.rho/ with init.toml, packages.toml, and SOUL.md.
 * Preserves existing files — only creates what's missing.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { detectPlatform, planInit } from "../init-core.ts";

const HOME = process.env.HOME || os.homedir();
const RHO_DIR = path.join(HOME, ".rho");

export async function run(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`rho init [--name <agent-name>]

Initialize Rho configuration in ~/.rho/.

Creates init.toml, packages.toml, and SOUL.md with sensible defaults.
Existing files are never overwritten.

Options:
  --name <name>  Agent name (default: "rho")
  --verbose      Show detailed output`);
    return;
  }

  const verbose = args.includes("--verbose");

  // Parse --name flag (or prompt in interactive terminals)
  let name = "rho";
  let nameProvided = false;

  const nameIdx = args.indexOf("--name");
  if (nameIdx !== -1) {
    const val = args[nameIdx + 1];
    if (!val || val.startsWith("--")) {
      console.error("Error: --name requires a value.");
      process.exit(1);
    }
    name = val;
    nameProvided = true;
  }

  if (!nameProvided && process.stdin.isTTY) {
    const rl = createInterface({ input, output });
    try {
      const ans = (await rl.question(`Agent name [${name}]: `)).trim();
      if (ans) name = ans;
    } finally {
      rl.close();
    }
  }

  const platform = detectPlatform();
  if (verbose) console.log(`Platform: ${platform}`);

  // Check what exists
  const existingFiles = new Set<string>();
  if (fs.existsSync(RHO_DIR)) {
    for (const entry of fs.readdirSync(RHO_DIR)) {
      existingFiles.add(entry);
    }
  }

  const plan = planInit({ name, rhoDir: RHO_DIR, existingFiles });

  // Create ~/.rho/ if needed
  if (!fs.existsSync(RHO_DIR)) {
    fs.mkdirSync(RHO_DIR, { recursive: true });
    if (verbose) console.log(`Created ${RHO_DIR}`);
  }

  // Create data directories
  for (const dir of plan.dirsToCreate) {
    const fullPath = path.join(RHO_DIR, dir);
    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true });
      if (verbose) console.log(`Created ${fullPath}`);
    }
  }

  // Write files
  let created = 0;
  for (const [filename, content] of plan.filesToCreate) {
    const fullPath = path.join(RHO_DIR, filename);
    fs.writeFileSync(fullPath, content);
    if (verbose) console.log(`Created ${fullPath}`);
    created++;
  }

  if (plan.existingConfigs.length > 0) {
    console.log(`Preserved existing: ${plan.existingConfigs.join(", ")}`);
  }

  if (created > 0) {
    console.log(
      `Initialized ${RHO_DIR} (${created} file${created > 1 ? "s" : ""} created, agent: ${name})`,
    );
  } else {
    console.log(`${RHO_DIR} already initialized. No files changed.`);
  }

  console.log(`\nNext steps:`);
  console.log(`  1. Edit ~/.rho/init.toml to configure modules`);
  console.log(`  2. Edit ~/.rho/SOUL.md to define your agent's identity`);
  console.log(`  3. Run \`rho sync\` to apply configuration`);
}
