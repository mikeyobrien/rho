/**
 * Rho v2 path isolation. Run: npx tsx tests/test-standalone-paths.ts
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  LAYOUT_VERSION,
  buildPiChildEnv,
  classifyInstall,
  encodeSessionBucket,
  piLaunchArgs,
  relocateLegacyAgentLayout,
  resolveRhoPaths,
} from "../cli/rho-paths.ts";

let failed = 0;

function assert(condition: boolean, label: string): void {
  if (condition) {
    console.log(`  PASS: ${label}`);
    return;
  }
  failed += 1;
  console.error(`  FAIL: ${label}`);
}

const home = "/tmp/rho-home";
const paths = resolveRhoPaths(home);

assert(paths.piAgentDir === path.join(home, ".rho", "agent"), "agent dir");
assert(
  paths.sessionDir === path.join(home, ".rho", "agent", "sessions"),
  "session dir",
);
assert(
  encodeSessionBucket("/tmp/project") === "--tmp-project--",
  "cwd bucket matches Pi",
);
assert(
  paths.workspaceDir === path.join(home, ".rho", "workspace"),
  "workspace dir",
);
assert(
  paths.settingsPath === path.join(paths.piAgentDir, "settings.json"),
  "settings path",
);
assert(
  paths.ordinaryPiAgentDir === path.join(home, ".pi", "agent"),
  "ordinary pi dir stays distinct",
);
assert(!paths.piAgentDir.includes(`${path.sep}.pi${path.sep}`), "not .pi");

const env = buildPiChildEnv(paths, {
  PATH: "/bin",
  HOME: "/other",
  PI_CODING_AGENT_SESSION_DIR: "/bad",
});
assert(env.PI_CODING_AGENT_DIR === paths.piAgentDir, "child agent dir");
assert(
  env.PI_CODING_AGENT_SESSION_DIR === undefined,
  "child does not force a session dir",
);
assert(env.HOME === home, "child home is rho home");
assert(env.PATH === "/bin", "base env preserved");

assert(
  classifyInstall({ initTomlExists: false, markerVersion: null }) === "fresh",
  "fresh",
);
assert(
  classifyInstall({
    initTomlExists: true,
    markerVersion: LAYOUT_VERSION,
  }) === "v2",
  "v2",
);
assert(
  classifyInstall({ initTomlExists: true, markerVersion: null }) === "legacy",
  "legacy without marker",
);
assert(
  classifyInstall({ initTomlExists: false, markerVersion: 1 }) === "legacy",
  "unknown marker is legacy",
);

const args = piLaunchArgs(paths, ["-c"]);
assert(!args.includes("--session-dir"), "session flag is not forced");
assert(args.at(-1) === "-c", "caller args preserved");

const installArgs = piLaunchArgs(paths, ["install", "npm:pi-subagents"]);
assert(installArgs.at(0) === "install", "package subcommand remains first");
assert(
  installArgs.at(1) === "npm:pi-subagents",
  "package source remains second",
);

const relocateHome = fs.mkdtempSync(path.join(os.tmpdir(), "rho-relocate-"));
const oldAgent = path.join(relocateHome, ".rho", "pi-agent");
const flatSessions = path.join(relocateHome, ".rho", "sessions");
fs.mkdirSync(oldAgent, { recursive: true });
fs.mkdirSync(flatSessions, { recursive: true });
fs.writeFileSync(path.join(oldAgent, "settings.json"), "{}\n");
const sessionCwd = "/tmp/project";
const sessionName = "2026-01-01T00-00-00-000Z_abc.jsonl";
fs.writeFileSync(
  path.join(flatSessions, sessionName),
  `${JSON.stringify({ type: "session", cwd: sessionCwd })}\n`,
);
const relocated = resolveRhoPaths(relocateHome);
relocateLegacyAgentLayout(relocated);
assert(
  fs.readFileSync(path.join(relocated.piAgentDir, "settings.json"), "utf8") ===
    "{}\n",
  "old agent dir moves to agent",
);
assert(!fs.existsSync(oldAgent), "old agent dir is removed");
assert(
  fs.existsSync(
    path.join(
      relocated.sessionDir,
      encodeSessionBucket(sessionCwd),
      sessionName,
    ),
  ),
  "flat session moves into the cwd bucket",
);
assert(!fs.existsSync(flatSessions), "flat session dir is removed");

if (failed > 0) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nstandalone paths: ok");
