/**
 * rho skills — unified wrapper for external skill providers.
 *
 * Providers:
 * - vercel (default): wraps `npx skills`
 * - clawhub: wraps `npx clawhub@latest`
 *
 * Canonical verbs (provider-agnostic):
 * - install, list, show, update, remove, search
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { spawnSync } from "node:child_process";

type Provider = "vercel" | "clawhub";

import { refuseLegacy } from "../install-kind.ts";
import { skillProviderScope } from "../pi-launch.ts";
import { resolveRhoPaths } from "../rho-paths.ts";

const HOME = process.env.HOME || os.homedir();
const PATHS = resolveRhoPaths(HOME);
const DEFAULT_PROVIDER: Provider = "vercel";

// Rho-owned Pi path. Do not write ordinary ~/.pi/agent.
const PI_AGENT_DIR = PATHS.piAgentDir;
const PI_SKILLS_DIR = path.join(PI_AGENT_DIR, "skills");

// Vercel skills canonical global store
const VERCEL_STORE_DIR = path.join(HOME, ".agents", "skills");
const VERCEL_LOCKFILE = path.join(HOME, ".agents", ".skill-lock.json");

// ClawHub defaults
const CLAWHUB_WORKDIR = PI_AGENT_DIR;
const CLAWHUB_DIR = "skills";

const LONG_FLAGS_WITH_VALUE = new Set([
  // shared
  "--provider",

  // vercel skills
  "--agent",
  "--skill",

  // clawhub
  "--workdir",
  "--dir",
  "--site",
  "--registry",
  "--version",
  "--limit",
  "--sort",
  "--tag",
  "--file",
  "--token",
  "--label",
  "--slug",
  "--name",
  "--fork-of",
  "--changelog",
  "--tags",
]);

const SHORT_FLAGS_WITH_VALUE = new Set([
  // vercel skills
  "-a",
  "-s",
]);

export async function run(args: string[]): Promise<void> {
  const parsed = parseProvider(args);
  if (parsed.error) {
    console.error(`Error: ${parsed.error}`);
    process.exit(1);
  }

  const provider = parsed.provider;
  const forwarded = parsed.forwarded;

  if (forwarded.length === 0 || (forwarded.length === 1 && isHelpFlag(forwarded[0]))) {
    printHelp();
    return;
  }

  refuseLegacy(PATHS);
  const scope = skillProviderScope(provider, PATHS);
  if (!scope.ok) {
    console.error(`Error: ${scope.error}`);
    process.exit(1);
  }
  ensureNpxAvailable();

  if (provider === "vercel") {
    runVercel(forwarded);
    return;
  }

  runClawhub(forwarded);
}

function runVercel(forwarded: string[]): never {
  const analysis = analyzeArgs(forwarded);
  const rawCommand = analysis.positionals[0] ?? "";
  const commandIndex = analysis.positionalIndices[0] ?? -1;

  if (rawCommand === "show") {
    runVercelShow(analysis.positionals[1] ?? "");
    process.exit(0);
  }

  // Canonical mapping
  const mappedCommand = mapVercelCommand(rawCommand);
  const args = [...forwarded];

  if (commandIndex >= 0 && mappedCommand !== rawCommand) {
    args[commandIndex] = mappedCommand;
  }

  // update <skill> is unsupported by vercel provider CLI
  if (mappedCommand === "update" && analysis.positionals.length > 1) {
    console.error("Error: provider=vercel does not support update <skill>. Use `rho skills update`.");
    process.exit(1);
  }

  const hadAgentFlag = hasAnyOption(args, ["--agent", "-a"]);
  const hadGlobalFlag = hasAnyOption(args, ["--global", "-g"]);

  // Pi-oriented defaults for canonical CRUD commands
  if ((mappedCommand === "add" || mappedCommand === "remove" || mappedCommand === "list") && !hadAgentFlag) {
    args.push("--agent", "pi");
  }
  if ((mappedCommand === "add" || mappedCommand === "remove" || mappedCommand === "list") && !hadGlobalFlag) {
    args.push("--global");
  }

  const r = spawnSync("npx", ["skills", ...args], { stdio: "inherit" });
  if (r.error) {
    console.error(`Error: failed to run npx skills (${r.error.message}).`);
    process.exit(1);
  }

  const status = r.status ?? 1;
  if (status === 0) {
    if (mappedCommand === "add") {
      const pkg = analysis.positionals[1] ?? "<package>";
      console.log("");
      console.log("Provider:   vercel");
      console.log(`Package:    ${pkg}`);
      console.log(`Pi skills:  ${PI_SKILLS_DIR}`);
      console.log(`Store:      ${VERCEL_STORE_DIR}`);
      console.log(`Lockfile:   ${VERCEL_LOCKFILE}`);
    } else if (mappedCommand === "remove") {
      const skill = analysis.positionals[1] ?? "<interactive>";
      console.log("");
      console.log("Provider:   vercel");
      console.log(`Removed:    ${skill}`);
      console.log(`Pi skills:  ${PI_SKILLS_DIR}`);
      console.log(`Store:      ${VERCEL_STORE_DIR}`);
    } else if (mappedCommand === "list") {
      console.log("");
      console.log("Provider:   vercel");
      console.log(`Pi skills:  ${PI_SKILLS_DIR}`);
      console.log(`Store:      ${VERCEL_STORE_DIR}`);
      console.log(`Lockfile:   ${VERCEL_LOCKFILE}`);
    }
  }

  process.exit(status);
}

function runVercelShow(skill: string): void {
  const trimmed = skill.trim();
  if (!trimmed) {
    console.error("Error: show requires a skill name. Example: rho skills show web-design-guidelines");
    process.exit(1);
  }

  if (!fs.existsSync(VERCEL_LOCKFILE)) {
    console.error(`No Vercel lockfile found: ${VERCEL_LOCKFILE}`);
    console.error("Install a skill first: rho skills install <package> --skill <name>");
    process.exit(1);
  }

  let parsed: any;
  try {
    parsed = JSON.parse(fs.readFileSync(VERCEL_LOCKFILE, "utf-8"));
  } catch {
    console.error(`Could not parse lockfile: ${VERCEL_LOCKFILE}`);
    process.exit(1);
  }

  const entry = parsed?.skills?.[trimmed];
  if (!entry || typeof entry !== "object") {
    console.error(`Skill not found in lockfile: ${trimmed}`);
    console.error("Tip: run `rho skills list` to see installed skills.");
    process.exit(1);
  }

  console.log(`Provider:   vercel`);
  console.log(`Skill:      ${trimmed}`);
  console.log(`Source:     ${String(entry.source ?? "unknown")}`);
  console.log(`Source URL: ${String(entry.sourceUrl ?? "unknown")}`);
  console.log(`Installed:  ${String(entry.installedAt ?? "unknown")}`);
  console.log(`Updated:    ${String(entry.updatedAt ?? "unknown")}`);
  console.log(`Pi path:    ${path.join(PI_SKILLS_DIR, trimmed)}`);
  console.log(`Store path: ${path.join(VERCEL_STORE_DIR, trimmed)}`);
  console.log(`Lockfile:   ${VERCEL_LOCKFILE}`);
}

function runClawhub(forwarded: string[]): never {
  const analysis = analyzeArgs(forwarded);
  const rawCommand = analysis.positionals[0] ?? "";
  const commandIndex = analysis.positionalIndices[0] ?? -1;

  const mappedCommand = mapClawhubCommand(rawCommand);
  const args = [...forwarded];

  if (commandIndex >= 0 && mappedCommand !== rawCommand) {
    args[commandIndex] = mappedCommand;
  }

  const hasWorkdir = hasAnyOption(args, ["--workdir"]);
  const hasDir = hasAnyOption(args, ["--dir"]);

  const npxArgs: string[] = ["clawhub@latest"];
  if (!hasWorkdir) npxArgs.push("--workdir", CLAWHUB_WORKDIR);
  if (!hasDir) npxArgs.push("--dir", CLAWHUB_DIR);
  npxArgs.push(...args);

  const r = spawnSync("npx", npxArgs, { stdio: "inherit" });
  if (r.error) {
    console.error(`Error: failed to run npx clawhub@latest (${r.error.message}).`);
    process.exit(1);
  }

  const status = r.status ?? 1;
  if (status === 0) {
    const workdir = path.resolve(getOptionValue(args, "--workdir") ?? CLAWHUB_WORKDIR);
    const dir = getOptionValue(args, "--dir") ?? CLAWHUB_DIR;
    const installRoot = path.resolve(workdir, dir);

    if (mappedCommand === "install") {
      const slug = analysis.positionals[1] ?? "<slug>";
      console.log("");
      console.log("Provider:   clawhub");
      console.log(`Pi skills:  ${installRoot}`);
      console.log(`Installed:  ${path.join(installRoot, slug)}`);
      console.log(`Lockfile:   ${path.join(workdir, ".clawhub", "lock.json")}`);
    } else if (mappedCommand === "uninstall") {
      const slug = analysis.positionals[1] ?? "<slug>";
      console.log("");
      console.log("Provider:   clawhub");
      console.log(`Removed:    ${path.join(installRoot, slug)}`);
      console.log(`Lockfile:   ${path.join(workdir, ".clawhub", "lock.json")}`);
    } else if (mappedCommand === "list") {
      console.log("");
      console.log("Provider:   clawhub");
      console.log(`Pi skills:  ${installRoot}`);
      console.log(`Lockfile:   ${path.join(workdir, ".clawhub", "lock.json")}`);
    }
  }

  process.exit(status);
}

function mapVercelCommand(raw: string): string {
  switch (raw) {
    case "install":
      return "add";
    case "search":
      return "find";
    case "remove":
      return "remove";
    case "list":
      return "list";
    case "update":
      return "update";
    case "show":
      return "show";
    default:
      return raw;
  }
}

function mapClawhubCommand(raw: string): string {
  switch (raw) {
    case "remove":
      return "uninstall";
    case "show":
      return "inspect";
    case "search":
      return "search";
    case "install":
      return "install";
    case "list":
      return "list";
    case "update":
      return "update";
    default:
      return raw;
  }
}

function printHelp(): void {
  console.log(`rho skills [--provider vercel|clawhub] <command> [args]

Unified skill manager with provider routing.

Canonical commands (provider-agnostic):
  install   Install skill package/slug
  list      List installed skills
  show      Show details for one installed skill
  update    Update installed skills
  remove    Remove installed skill
  search    Discover skills

Default provider:
  --provider vercel

Providers:
  vercel  -> wraps \`npx skills\`
             install/list/remove defaults: --agent pi --global
  clawhub -> wraps \`npx clawhub@latest\`
             defaults: --workdir ~/.rho/pi-agent --dir skills

Examples:
  rho skills install vercel-labs/agent-skills --skill web-design-guidelines
  rho skills list
  rho skills show web-design-guidelines
  rho skills remove web-design-guidelines -y
  rho skills search react

  rho skills --provider clawhub search sonos
  rho skills --provider clawhub show sonoscli --versions
  rho skills --provider clawhub install sonoscli

Install paths:
  Vercel provider writes canonical copies to: ${VERCEL_STORE_DIR}
  and links Pi skills under:                ${PI_SKILLS_DIR}

  ClawHub provider installs directly to:    ${PI_SKILLS_DIR}
`);
}

function ensureNpxAvailable(): void {
  const r = spawnSync("npx", ["--version"], { stdio: "ignore" });
  if (r.error || r.status !== 0) {
    console.error("Error: npx is not available.");
    console.error("Install Node.js 18+ and ensure npm/npx are on PATH.");
    process.exit(1);
  }
}

function parseProvider(args: string[]): {
  provider: Provider;
  forwarded: string[];
  error?: string;
} {
  let provider: Provider = DEFAULT_PROVIDER;
  const forwarded: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--provider") {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) {
        return { provider, forwarded, error: "--provider requires a value (vercel|clawhub)." };
      }
      i += 1;
      if (!isProvider(value)) {
        return { provider, forwarded, error: `unsupported provider "${value}". Use vercel or clawhub.` };
      }
      provider = value;
      continue;
    }

    if (arg.startsWith("--provider=")) {
      const value = arg.slice("--provider=".length);
      if (!isProvider(value)) {
        return { provider, forwarded, error: `unsupported provider "${value}". Use vercel or clawhub.` };
      }
      provider = value;
      continue;
    }

    forwarded.push(arg);
  }

  return { provider, forwarded };
}

function isProvider(value: string): value is Provider {
  return value === "vercel" || value === "clawhub";
}

function isHelpFlag(value: string): boolean {
  return value === "--help" || value === "-h";
}

function hasAnyOption(args: string[], names: string[]): boolean {
  for (const arg of args) {
    for (const name of names) {
      if (arg === name) return true;
      if (name.startsWith("--") && arg.startsWith(`${name}=`)) return true;
    }
  }
  return false;
}

function getOptionValue(args: string[], name: string): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === name) {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) return null;
      return value;
    }
    if (arg.startsWith(`${name}=`)) {
      return arg.slice(name.length + 1);
    }
  }
  return null;
}

function analyzeArgs(args: string[]): { positionals: string[]; positionalIndices: number[] } {
  const positionals: string[] = [];
  const positionalIndices: number[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "--") {
      for (let j = i + 1; j < args.length; j++) {
        positionals.push(args[j]);
        positionalIndices.push(j);
      }
      break;
    }

    if (arg.startsWith("--")) {
      const [flag] = arg.split("=", 1);
      if (!arg.includes("=") && LONG_FLAGS_WITH_VALUE.has(flag)) {
        i += 1;
      }
      continue;
    }

    if (SHORT_FLAGS_WITH_VALUE.has(arg)) {
      i += 1;
      continue;
    }

    if (arg.startsWith("-")) continue;

    positionals.push(arg);
    positionalIndices.push(i);
  }

  return { positionals, positionalIndices };
}
