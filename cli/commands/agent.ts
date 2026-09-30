/**
 * rho agent — foreground Rho agent.
 * Runs Pi's engine in this process so the session is rho, not a `pi` command.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { refuseLegacy } from "../install-kind.ts";
import { buildPiChildEnv, resolveRhoPaths } from "../rho-paths.ts";

function findPiBin(): string {
  // Prefer this process's PATH. A login shell can reorder PATH (mise, profile.d)
  // and return a different pi than the one the caller put first.
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "pi");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  const resolved = spawnSync("bash", ["-lc", "command -v pi"], { encoding: "utf8" });
  return resolved.stdout.trim();
}

function piCliPath(): string {
  const bin = findPiBin();
  if (!bin) throw new Error("pi is not installed.");
  const body = fs.readFileSync(bin, "utf8");
  const quoted = body.match(/"([^"]*pi-coding-agent[^"]*cli\.js)"/);
  if (quoted?.[1]) return quoted[1].replace("$HOME", os.homedir());
  const bare = body.match(/(\S*pi-coding-agent\S*cli\.js)/);
  if (bare?.[1]) return bare[1].replace("$HOME", os.homedir());
  throw new Error(`Could not find Pi's cli.js from ${bin}`);
}

export async function run(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`rho agent

Start the Rho agent. \`rho\` with no arguments does the same thing.`);
    return;
  }

  const paths = refuseLegacy(resolveRhoPaths(process.env.HOME || os.homedir()));
  const env = buildPiChildEnv(paths);
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  process.chdir(paths.workspaceDir);
  const keepRhoIdentity = () => {
    process.title = "rho";
  };
  keepRhoIdentity();

  const cli = piCliPath();
  process.argv = [process.execPath, cli, "-c", ...args.filter((arg) => arg !== "--")];
  await import(pathToFileURL(cli).href);
  // Pi's CLI sets process.title to "pi" during import. Herdr reads that as the
  // agent executable, so put the identity back and keep it there.
  keepRhoIdentity();
  const identity = setInterval(keepRhoIdentity, 1000);
  identity.unref();
}
