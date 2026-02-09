#!/usr/bin/env -S node --experimental-strip-types
/**
 * rho CLI - Doom-style config management for Rho agent framework.
 *
 * Minimal command router. No heavy CLI framework.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Read version from package.json
const pkgPath = path.resolve(__dirname, "..", "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
const VERSION: string = pkg.version;

// Command definitions: name -> { description, loader }
interface CommandDef {
  description: string;
  load: () => Promise<{ run: (args: string[]) => Promise<void> }>;
}

const COMMANDS: Record<string, CommandDef> = {
  init:    { description: "Initialize Rho config in ~/.rho/",           load: () => import("./commands/init.ts") },
  sync:    { description: "Sync config to pi settings.json",            load: () => import("./commands/sync.ts") },
  doctor:  { description: "Check system health and config validity",    load: () => import("./commands/doctor.ts") },
  upgrade: { description: "Update Rho and sync new modules",            load: () => import("./commands/upgrade.ts") },
  start:   { description: "Start the heartbeat daemon",                 load: () => import("./commands/start.ts") },
  stop:    { description: "Stop the heartbeat daemon",                  load: () => import("./commands/stop.ts") },
  status:  { description: "Show daemon and module status",              load: () => import("./commands/status.ts") },
  trigger: { description: "Force an immediate heartbeat check-in",      load: () => import("./commands/trigger.ts") },
  config:  { description: "Show current configuration",                 load: () => import("./commands/config.ts") },
  logs:    { description: "Show recent heartbeat output",               load: () => import("./commands/logs.ts") },
  login:   { description: "Authenticate with pi providers",            load: () => import("./commands/login.ts") },
};

function printHelp(): void {
  const maxLen = Math.max(...Object.keys(COMMANDS).map((k) => k.length));
  const lines = Object.entries(COMMANDS).map(
    ([name, def]) => `  ${name.padEnd(maxLen + 2)}${def.description}`
  );

  console.log(`rho v${VERSION} - AI agent framework

Usage: rho [command] [options]

Running \`rho\` with no arguments starts the daemon (if needed) and attaches.

Commands:
${lines.join("\n")}

Flags:
  --help       Show this help
  --version    Show version

Run \`rho <command> --help\` for command-specific help.`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Global flags
  if (args.includes("--version") || args.includes("-v")) {
    console.log(VERSION);
    return;
  }

  if (args.includes("--help") || args.includes("-h")) {
    // If --help is combined with a command, let the command handle it
    const cmdName = args.find((a) => !a.startsWith("-"));
    if (cmdName && COMMANDS[cmdName]) {
      const cmd = await COMMANDS[cmdName].load();
      await cmd.run(args.filter((a) => a !== cmdName));
      return;
    }
    printHelp();
    return;
  }

  // Bare `rho` with no args: start daemon if needed, attach foreground
  if (args.length === 0) {
    const cmd = await COMMANDS["start"].load();
    await cmd.run(["--foreground"]);
    return;
  }

  const cmdName = args[0];
  const cmdArgs = args.slice(1);

  if (!COMMANDS[cmdName]) {
    console.error(`Unknown command: ${cmdName}\nRun \`rho --help\` for available commands.`);
    process.exit(1);
  }

  const cmd = await COMMANDS[cmdName].load();
  await cmd.run(cmdArgs);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
