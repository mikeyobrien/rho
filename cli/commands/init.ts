/**
 * rho init — Initialize a new Rho configuration.
 *
 * Creates ~/.rho/ with init.toml, packages.toml, brain defaults, tmux config,
 * and platform-specific skills/extensions.
 *
 * Preserves existing files — only creates what's missing.
 * This is the single entry point for both:
 *   - Clone route:  git clone ... && ./install.sh  (install.sh calls rho init)
 *   - npm route:    npm install -g @rhobot-dev/rho && rho init
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { detectPlatform, planInit, planBootstrap } from "../init-core.ts";

const HOME = process.env.HOME || os.homedir();
const RHO_DIR = path.join(HOME, ".rho");
const PI_DIR = path.join(HOME, ".pi", "agent");

export async function run(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`rho init [--name <agent-name>]

Initialize Rho in ~/.rho/.

Creates config files (init.toml, packages.toml), bootstraps brain defaults,
tmux config, and platform-specific skills/extensions.

Existing files are never overwritten.

Options:
  --name <name>  Agent name (default: "rho")
  --force        Force regeneration of template files
  --verbose      Show detailed output`);
    return;
  }

  const verbose = args.includes("--verbose");
  const force = args.includes("--force");

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

  // Read name from existing init.toml if present and not provided via flag
  if (!nameProvided) {
    const existingName = readAgentNameFromToml();
    if (existingName) {
      name = existingName;
      nameProvided = true;
    }
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

  // ── Phase 1: Config files (init.toml, packages.toml) ──

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

  // Write config files
  let created = 0;
  for (const [filename, content] of plan.filesToCreate) {
    const fullPath = path.join(RHO_DIR, filename);
    fs.writeFileSync(fullPath, content);
    if (verbose) console.log(`✓ Created ${fullPath}`);
    created++;
  }

  // ── Phase 2: Bootstrap (templates, brain, tmux, platform) ──

  // Re-read existing files after phase 1
  const existingRhoFiles = new Set<string>();
  if (fs.existsSync(RHO_DIR)) {
    for (const entry of fs.readdirSync(RHO_DIR)) {
      existingRhoFiles.add(entry);
    }
  }

  const existingBrainFiles = new Set<string>();
  const brainDir = path.join(RHO_DIR, "brain");
  if (fs.existsSync(brainDir)) {
    for (const entry of fs.readdirSync(brainDir)) {
      existingBrainFiles.add(entry);
    }
  }

  const bootstrap = planBootstrap({
    name,
    rhoDir: RHO_DIR,
    piDir: PI_DIR,
    platform,
    existingRhoFiles,
    existingBrainFiles,
    tmuxConfigExists: fs.existsSync(path.join(RHO_DIR, "tmux.conf")),
    force,
  });

  // Write template files
  for (const [filename, content] of bootstrap.filesToCreate) {
    const fullPath = path.join(RHO_DIR, filename);
    fs.writeFileSync(fullPath, content);
    if (verbose) console.log(`✓ Created ${fullPath}`);
    created++;
  }

  // Copy brain defaults
  for (const [src, target] of bootstrap.brainFilesToCopy) {
    fs.copyFileSync(src, target);
    if (verbose) console.log(`✓ Created ${path.basename(target)}`);
    created++;
  }

  // Copy tmux config
  if (bootstrap.tmuxConfig) {
    fs.copyFileSync(bootstrap.tmuxConfig.source, bootstrap.tmuxConfig.target);
    if (verbose) console.log(`✓ Installed tmux config -> ~/.rho/tmux.conf`);
    created++;
  }

  // Symlink platform skills
  if (bootstrap.platformSkillLinks.length > 0) {
    fs.mkdirSync(path.join(PI_DIR, "skills"), { recursive: true });
    for (const link of bootstrap.platformSkillLinks) {
      try {
        // Remove existing symlink if present (re-link on upgrade)
        if (fs.lstatSync(link.target).isSymbolicLink()) {
          fs.unlinkSync(link.target);
        }
      } catch {
        // doesn't exist, that's fine
      }
      fs.symlinkSync(link.source, link.target);
    }
    if (verbose) console.log(`✓ Installed ${platform} skills (${bootstrap.platformSkillLinks.length})`);
  }

  // Symlink platform extensions
  if (bootstrap.platformExtensionLinks.length > 0) {
    fs.mkdirSync(path.join(PI_DIR, "extensions"), { recursive: true });
    for (const link of bootstrap.platformExtensionLinks) {
      try {
        if (fs.lstatSync(link.target).isSymbolicLink()) {
          fs.unlinkSync(link.target);
        }
      } catch {
        // doesn't exist
      }
      fs.symlinkSync(link.source, link.target);
    }
    if (verbose) console.log(`✓ Installed ${platform} extensions (${bootstrap.platformExtensionLinks.length})`);
  }

  // ── Summary ──

  const allSkipped = [...plan.existingConfigs, ...bootstrap.skipped];
  if (allSkipped.length > 0) {
    console.log(`Preserved existing: ${allSkipped.join(", ")}`);
  }

  if (created > 0) {
    console.log(
      `Initialized ${RHO_DIR} (${created} file${created > 1 ? "s" : ""} created, agent: ${name}, platform: ${platform})`,
    );
  } else {
    console.log(`${RHO_DIR} already initialized. No files changed.`);
  }

  console.log(`\nNext steps:`);
  console.log(`  1. Run \`rho sync\` to apply configuration`);
  console.log(`  2. Edit ~/.rho/init.toml to configure modules`);
  console.log(`  3. Use the brain tool to define agent identity and behavior`);
}

/** Read agent name from existing init.toml, if present. */
function readAgentNameFromToml(): string | null {
  try {
    const tomlPath = path.join(RHO_DIR, "init.toml");
    if (!fs.existsSync(tomlPath)) return null;
    const content = fs.readFileSync(tomlPath, "utf-8");
    const match = content.match(/^name\s*=\s*"([^"]*)"/m);
    return match?.[1] || null;
  } catch {
    return null;
  }
}
