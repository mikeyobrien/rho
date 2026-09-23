/**
 * Rho v2 path isolation. Run: npx tsx tests/test-standalone-paths.ts
 */
import * as path from "node:path";
import {
  LAYOUT_VERSION,
  buildPiChildEnv,
  classifyInstall,
  piLaunchArgs,
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

assert(paths.piAgentDir === path.join(home, ".rho", "pi-agent"), "agent dir");
assert(paths.sessionDir === path.join(home, ".rho", "sessions"), "session dir");
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

const env = buildPiChildEnv(paths, { PATH: "/bin", HOME: "/other" });
assert(env.PI_CODING_AGENT_DIR === paths.piAgentDir, "child agent dir");
assert(env.PI_CODING_AGENT_SESSION_DIR === paths.sessionDir, "child sessions");
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
assert(args.includes("--session-dir"), "session flag");
assert(args.includes(paths.sessionDir), "session flag value");
assert(args.at(-1) === "-c", "caller args preserved");

if (failed > 0) {
  console.error(`\n${failed} failed`);
  process.exit(1);
}
console.log("\nstandalone paths: ok");
