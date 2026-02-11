/**
 * Regression tests for GitHub issues #7, #8, #9.
 *
 * #7 — rho start fails when pi is only in nvm PATH (not in tmux shell PATH)
 * #8 — Heartbeat tmux window doesn't close (missing -p flag and ; exit)
 * #9 — Heartbeat always uses session model (cheap auto-resolve never fires)
 *
 * Run: node --experimental-strip-types tests/test-regressions.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..");

// ── Test harness ──────────────────────────────────────

let PASS = 0;
let FAIL = 0;

function pass(label: string): void {
  console.log(`  \x1b[32mPASS\x1b[0m: ${label}`);
  PASS++;
}

function fail(label: string): void {
  console.error(`  \x1b[31mFAIL\x1b[0m: ${label}`);
  FAIL++;
}

function assert(condition: boolean, label: string): void {
  if (condition) pass(label);
  else fail(label);
}

function assertMatch(source: string, pattern: RegExp, label: string): void {
  if (pattern.test(source)) pass(label);
  else fail(`${label} — pattern ${pattern} not found`);
}

function assertNoMatch(source: string, pattern: RegExp, label: string): void {
  if (!pattern.test(source)) pass(label);
  else fail(`${label} — pattern ${pattern} found but should not be`);
}

// ── Source helpers ─────────────────────────────────────

function readSource(relPath: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), "utf-8");
}

// ══════════════════════════════════════════════════════
//  Issue #7 — pi PATH resolution
// ══════════════════════════════════════════════════════

console.log("\n=== Issue #7: pi PATH resolution (rho start / doctor) ===\n");

{
  const startSrc = readSource("cli/commands/start.ts");

  // getCommandPath should search process.env.PATH directly (not just sh -lc)
  assertMatch(
    startSrc,
    /process\.env\.PATH/,
    "#7 start: getCommandPath searches process.env.PATH directly",
  );

  assertMatch(
    startSrc,
    /existsSync\(candidate\)/,
    "#7 start: getCommandPath checks candidate exists on disk",
  );

  // ensureTmuxSession should resolve pi's path before passing to tmux
  // It should NOT use bare "pi -c" — it should use the resolved path.
  // Look for getCommandPath("pi") or equivalent before the tmux new-session call.
  assertMatch(
    startSrc,
    /getCommandPath\s*\(\s*["']pi["']\s*\)/,
    "#7 start: ensureTmuxSession resolves pi binary path",
  );

  // The tmux new-session call should use the resolved path, not bare "pi -c"
  assertNoMatch(
    startSrc,
    /new-session.*["']pi -c["']/,
    "#7 start: tmux new-session does NOT use bare 'pi -c'",
  );

  // Should propagate PATH to tmux environment
  assertMatch(
    startSrc,
    /set-environment.*PATH/,
    "#7 start: propagates PATH to tmux server environment",
  );
}

{
  const doctorSrc = readSource("cli/commands/doctor.ts");

  // doctor should resolve binaries via PATH search, not just execSync
  assertMatch(
    doctorSrc,
    /process\.env\.PATH/,
    "#7 doctor: searches process.env.PATH directly",
  );

  assertMatch(
    doctorSrc,
    /resolveBinary|existsSync\(candidate\)/,
    "#7 doctor: resolves binary path on disk",
  );
}

// ── #7 logic test: PATH search ────────────────────────

{
  // Simulate the PATH search logic from getCommandPath / resolveBinary.
  // Verify it finds a binary in a non-standard directory.
  const tmpDir = fs.mkdtempSync(path.join(
    (process.env.TMPDIR || "/tmp"),
    "rho-test-path-",
  ));
  const fakeBinDir = path.join(tmpDir, "fake-nvm-bin");
  fs.mkdirSync(fakeBinDir, { recursive: true });

  // Create a fake "pi" binary
  const fakePi = path.join(fakeBinDir, "pi");
  fs.writeFileSync(fakePi, "#!/bin/sh\necho fake-pi\n");
  fs.chmodSync(fakePi, 0o755);

  // Simulate the PATH search logic
  function searchPath(cmd: string, pathStr: string): string | null {
    const dirs = pathStr.split(path.delimiter);
    for (const dir of dirs) {
      const candidate = path.join(dir, cmd);
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  // 1. Standard PATH that includes the fake dir → found
  const found = searchPath("pi", `${fakeBinDir}:/usr/bin:/bin`);
  assert(found === fakePi, "#7 logic: finds pi in non-standard PATH dir");

  // 2. PATH without the fake dir → not found
  const notFound = searchPath("pi", "/usr/bin:/bin");
  assert(notFound === null, "#7 logic: does not find pi when dir not in PATH");

  // 3. Multiple dirs, pi in last one
  const foundLast = searchPath("pi", `/usr/bin:/bin:${fakeBinDir}`);
  assert(foundLast === fakePi, "#7 logic: finds pi even if last in PATH");

  // Cleanup
  fs.rmSync(tmpDir, { recursive: true });
}

// ══════════════════════════════════════════════════════
//  Issue #8 — Heartbeat window doesn't close
// ══════════════════════════════════════════════════════

console.log("\n=== Issue #8: Heartbeat window lifecycle ===\n");

{
  const rhoSrc = readSource("extensions/rho/index.ts");
  const lines = rhoSrc.split("\n");

  // Find the heartbeat command construction (the line with pi and --no-session
  // inside runHeartbeatInTmux)
  const cmdLineIdx = lines.findIndex(
    (l) => l.includes("const command") && l.includes("pi") && l.includes("--no-session") && l.includes("HEARTBEAT_PROMPT_FILE"),
  );
  assert(cmdLineIdx >= 0, "#8: found heartbeat command line");

  if (cmdLineIdx >= 0) {
    const cmdLine = lines[cmdLineIdx];

    // Must have -p flag (print mode — pi exits after prompt completes)
    assertMatch(
      cmdLine,
      /pi\s+-p\s+--no-session/,
      "#8: heartbeat command uses -p flag (non-interactive)",
    );

    // Must NOT be bare 'pi --no-session' without -p (the old broken pattern)
    assertNoMatch(
      cmdLine,
      /pi\s+--no-session/,
      "#8: heartbeat command is NOT bare pi --no-session (old bug)",
    );
  }

  // The heartbeat window should use remain-on-exit for visibility
  // (maintainer feedback: users need to see heartbeat output)
  const fnSlice = rhoSrc.slice(rhoSrc.indexOf("function runHeartbeatInTmux"), rhoSrc.indexOf("function runHeartbeatInTmux") + 2000);
  assertMatch(
    fnSlice,
    /remain-on-exit/,
    "#8: heartbeat window sets remain-on-exit (preserves output visibility)",
  );

  // Dead pane detection: when remain-on-exit is on, the pane stays after pi
  // exits. The next heartbeat must detect and respawn it.
  assertMatch(
    rhoSrc,
    /heartbeatPaneDead/,
    "#8: heartbeatPaneDead function exists (handles remain-on-exit panes)",
  );

  assertMatch(
    fnSlice,
    /heartbeatPaneDead.*\|\|.*heartbeatPaneBusy|heartbeatPaneBusy.*\|\|.*heartbeatPaneDead/,
    "#8: runHeartbeatInTmux checks both dead and busy panes before respawn",
  );
}

// ══════════════════════════════════════════════════════
//  Issue #9 — Cheap auto-resolve never fires
// ══════════════════════════════════════════════════════

console.log("\n=== Issue #9: Heartbeat model auto-resolve ordering ===\n");

{
  const rhoSrc = readSource("extensions/rho/index.ts");

  // Extract the buildModelFlags function body.
  // It starts with "const buildModelFlags" and ends at the next top-level const/function.
  const startMarker = "const buildModelFlags = async";
  const startIdx = rhoSrc.indexOf(startMarker);
  assert(startIdx >= 0, "#9: found buildModelFlags function");

  if (startIdx >= 0) {
    // Grab ~80 lines from the start of buildModelFlags
    const fnSlice = rhoSrc.slice(startIdx, startIdx + 2000);

    // Find the positions of the three resolution strategies.
    // Use precise patterns to avoid substring matches (e.g. ctx.modelRegistry contains "ctx.model").
    const pinnedPos = fnSlice.indexOf("hbState.heartbeatModel");
    const autoResolvePos = fnSlice.indexOf("resolveHeartbeatModel");
    // Match the ctx.model fallback — the line "if (ctx.model)" that guards the session fallback
    const sessionFallbackMatch = fnSlice.match(/if\s*\(\s*ctx\.model\s*\)/);
    const sessionPos = sessionFallbackMatch ? fnSlice.indexOf(sessionFallbackMatch[0]) : -1;

    assert(pinnedPos >= 0, "#9: buildModelFlags checks pinned model");
    assert(autoResolvePos >= 0, "#9: buildModelFlags calls resolveHeartbeatModel");
    assert(sessionPos >= 0, "#9: buildModelFlags checks session model (if ctx.model)");

    // The critical fix: auto-resolve MUST come BEFORE ctx.model fallback
    if (autoResolvePos >= 0 && sessionPos >= 0) {
      assert(
        autoResolvePos < sessionPos,
        "#9: resolveHeartbeatModel is called BEFORE ctx.model fallback",
      );
    }

    // Pinned should still be first
    if (pinnedPos >= 0 && autoResolvePos >= 0) {
      assert(
        pinnedPos < autoResolvePos,
        "#9: pinned model check comes before auto-resolve",
      );
    }

    // Verify the status display also reflects auto-resolve
    const statusSection = rhoSrc.slice(rhoSrc.indexOf("let hbModelText"));
    assertMatch(
      statusSection,
      /resolveHeartbeatModel/,
      "#9: status display calls resolveHeartbeatModel for auto label",
    );

    assertMatch(
      statusSection,
      /\(auto\)/,
      "#9: status display shows (auto) for auto-resolved model",
    );

    // Should show (session fallback) not bare (session) when falling back
    assertMatch(
      statusSection,
      /session fallback/,
      "#9: status display shows (session fallback) not (session)",
    );
  }
}

// ── Summary ───────────────────────────────────────────

console.log(`\n${"=".repeat(50)}`);
console.log(`Regression tests: ${PASS} passed, ${FAIL} failed`);
if (FAIL > 0) process.exit(1);
