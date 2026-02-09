/**
 * rho upgrade — Upgrade Rho and reconcile config.
 *
 * Implements the Doom-style flow:
 * 1) npm update -g @rhobot-dev/rho
 * 2) detect new modules added to the registry
 * 3) append them to ~/.rho/init.toml as commented-out entries (opt-in)
 * 4) run rho sync
 *
 * Notes:
 * - We do NOT auto-enable new modules.
 * - We do NOT auto-edit for removed/renamed modules; we warn only.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { REGISTRY, type ModuleEntry } from "../registry.ts";
import { parseInitToml } from "../config.ts";

const HOME = process.env.HOME || os.homedir();
const RHO_DIR = path.join(HOME, ".rho");
const INIT_TOML_PATH = path.join(RHO_DIR, "init.toml");

export async function run(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`rho upgrade

Upgrade Rho (npm global install) and re-sync configuration.

Options:
  --no-sync    Do not run rho sync after upgrade
  --dry-run    Show what would change without editing init.toml
  --verbose    Show npm output
  -h, --help   Show this help`);
    return;
  }

  const noSync = args.includes("--no-sync");
  const dryRun = args.includes("--dry-run");
  const verbose = args.includes("--verbose");

  const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const pkgJsonPath = path.join(pkgRoot, "package.json");
  const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
  const pkgName: string = pkgJson.name ?? "@rhobot-dev/rho";
  const beforeVersion: string = pkgJson.version ?? "unknown";

  const oldRegistryKeys = new Set(Object.keys(REGISTRY));

  console.log(`Upgrading ${pkgName} (current: ${beforeVersion})...`);

  const npm = spawnSync("npm", ["update", "-g", pkgName], {
    stdio: verbose ? "inherit" : "pipe",
    encoding: "utf-8",
  });

  if (npm.error || npm.status !== 0) {
    const msg = (npm.stderr || npm.stdout || "").trim();
    console.error(`npm update failed${msg ? `: ${msg}` : ""}`);
    process.exit(1);
  }

  // Re-read package.json from disk after update.
  let afterVersion = beforeVersion;
  try {
    const nextPkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
    if (typeof nextPkg.version === "string") afterVersion = nextPkg.version;
  } catch {
    // ignore
  }

  console.log(`Upgrade complete (now: ${afterVersion}).`);

  // Load new registry from disk (cache-busted import) so we can diff.
  let newRegistry: Record<string, ModuleEntry> | null = null;
  try {
    const registryUrl = new URL("../registry.ts", import.meta.url).href + `?t=${Date.now()}`;
    const mod = (await import(registryUrl)) as any;
    newRegistry = mod.REGISTRY as Record<string, ModuleEntry>;
  } catch {
    // If we can't import, skip diffing.
    newRegistry = null;
  }

  if (newRegistry) {
    const newKeys = new Set(Object.keys(newRegistry));
    const added = [...newKeys].filter((k) => !oldRegistryKeys.has(k));

    if (added.length > 0) {
      console.log(`New module(s) available: ${added.join(", ")}`);
      if (fs.existsSync(INIT_TOML_PATH)) {
        if (!dryRun) {
          const updated = appendNewModulesToInitToml({
            initTomlPath: INIT_TOML_PATH,
            newRegistry,
            addedModules: added,
            versionLabel: afterVersion,
          });
          if (updated.changed) {
            console.log(`Updated ${INIT_TOML_PATH}: added ${updated.addedCount} commented module(s).`);
          } else {
            console.log(`No changes needed in ${INIT_TOML_PATH}.`);
          }
        } else {
          console.log(`(dry-run) Would add ${added.length} commented module(s) to ${INIT_TOML_PATH}.`);
        }
      } else {
        console.log(`init.toml not found. Run \`rho init\` to create it, then re-run \`rho upgrade\`.`);
      }
    }

    // Warn about modules in init.toml that no longer exist.
    if (fs.existsSync(INIT_TOML_PATH)) {
      try {
        const config = parseInitToml(fs.readFileSync(INIT_TOML_PATH, "utf-8"));
        const configured = new Set<string>();
        for (const cat of Object.values(config.modules)) {
          for (const name of Object.keys(cat)) configured.add(name);
        }
        const removed = [...configured].filter((k) => !newKeys.has(k));
        if (removed.length > 0) {
          console.log("");
          console.log(`Warning: init.toml references unknown module(s): ${removed.join(", ")}`);
          console.log("  Fix by removing/renaming them in init.toml (upgrade does not auto-edit for breaking changes).");
        }
      } catch {
        // ignore
      }
    }
  }

  if (!noSync) {
    if (dryRun) {
      console.log("(dry-run) Skipping rho sync.");
      return;
    }

    console.log("Running rho sync...");

    // Spawn a fresh Node process to ensure we run the on-disk CLI (post-upgrade).
    const cliPath = path.join(pkgRoot, "cli", "index.ts");
    const r = spawnSync(process.execPath, ["--experimental-strip-types", cliPath, "sync"], {
      stdio: "inherit",
      env: { ...process.env },
    });

    if (r.status !== 0) {
      process.exit(r.status ?? 1);
    }
  }
}

function appendNewModulesToInitToml(input: {
  initTomlPath: string;
  newRegistry: Record<string, ModuleEntry>;
  addedModules: string[];
  versionLabel: string;
}): { changed: boolean; addedCount: number } {
  const raw = fs.readFileSync(input.initTomlPath, "utf-8");
  const lines = raw.split("\n");

  let changed = false;
  let addedCount = 0;

  const byCategory = new Map<string, Array<{ name: string; entry: ModuleEntry }>>();
  for (const name of input.addedModules) {
    const entry = input.newRegistry[name];
    if (!entry) continue;
    const list = byCategory.get(entry.category) ?? [];
    list.push({ name, entry });
    byCategory.set(entry.category, list);
  }

  for (const [category, mods] of byCategory) {
    const header = `[modules.${category}]`;

    // Find section
    const start = lines.findIndex((l) => l.trim() === header);
    if (start === -1) {
      // Fallback: append at end if section missing
      lines.push("", `# New modules (added by rho upgrade ${input.versionLabel})`, header);
      for (const m of mods) {
        const line = commentedModuleLine(m.name, m.entry.description, input.versionLabel);
        if (!hasModuleLine(lines, m.name)) {
          lines.push(line);
          changed = true;
          addedCount++;
        }
      }
      continue;
    }

    // Find end of section (next table header)
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      if (lines[i].trim().startsWith("[")) {
        end = i;
        break;
      }
    }

    // Insert just before end
    const insertAt = end;

    const insertLines: string[] = [];
    insertLines.push("", `# New modules (added by rho upgrade ${input.versionLabel})`);

    for (const m of mods) {
      if (hasModuleLine(lines, m.name)) continue;
      insertLines.push(commentedModuleLine(m.name, m.entry.description, input.versionLabel));
      changed = true;
      addedCount++;
    }

    if (insertLines.length > 2) {
      lines.splice(insertAt, 0, ...insertLines);
    }
  }

  if (changed) {
    fs.writeFileSync(input.initTomlPath, lines.join("\n"));
  }

  return { changed, addedCount };
}

function hasModuleLine(lines: string[], moduleName: string): boolean {
  const re = new RegExp(`^\\s*#?\\s*${escapeRegExp(moduleName)}\\s*=`, "i");
  return lines.some((l) => re.test(l));
}

function commentedModuleLine(name: string, description: string, versionLabel: string): string {
  const desc = description ? `# ${description}` : "";
  const suffix = versionLabel && versionLabel !== "unknown" ? ` (new in ${versionLabel})` : "";
  return `# ${name} = true  ${desc}${suffix}`.trimEnd();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");
}
