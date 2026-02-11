#!/usr/bin/env bash
# Regression E2E tests for issues #7, #8, #9.
# Runs inside Docker (see Dockerfile.regressions).
set -euo pipefail

# ── Test Harness ────────────────────────────────────────

PASS=0
FAIL=0
ERRORS=()

pass() {
  echo -e "  \033[32mPASS\033[0m: $1"
  PASS=$((PASS + 1))
}

fail() {
  echo -e "  \033[31mFAIL\033[0m: $1"
  FAIL=$((FAIL + 1))
  ERRORS+=("$1")
}

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
RHO_DIR="$HOME/.rho"

# ── nvm PATH simulation ───────────────────────────────
# Pi was installed into ~/.fake-nvm/bin/ by the Dockerfile (NOT on system PATH).
# Add it to this process's PATH — simulating the user's interactive shell
# where nvm has prepended its bin dir.

FAKE_NVM_BIN="$HOME/.fake-nvm/bin"
export PATH="$FAKE_NVM_BIN:$HOME/.local/bin:$HOME/.npm-global/bin:$PATH"

# Cleanup
cleanup() {
  if [ -f "$HOME/.rho-daemon.pid" ]; then
    kill "$(cat "$HOME/.rho-daemon.pid")" 2>/dev/null || true
  fi
  tmux -L rho kill-server 2>/dev/null || true
  tmux kill-server 2>/dev/null || true
}
trap cleanup EXIT

echo ""
echo "=== Regression E2E Tests (Issues #7, #8, #9) ==="
echo ""

# ── Environment validation ─────────────────────────────

echo "-- Environment --"

if command -v pi &>/dev/null; then
  pass "pi available (via fake-nvm PATH)"
else
  fail "pi not found — test setup broken"
  echo "  PATH=$PATH"
  echo "  contents of $FAKE_NVM_BIN:"
  ls -la "$FAKE_NVM_BIN" 2>/dev/null || echo "    (dir missing)"
  exit 1
fi

pi_path=$(command -v pi)
pass "pi at: $pi_path"

# Verify pi is NOT on the *default* system PATH (strip our additions).
# This confirms the nvm-like isolation is working.
SYSTEM_PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
if env PATH="$SYSTEM_PATH" sh -c 'command -v pi' &>/dev/null; then
  fail "pi found on system PATH — nvm simulation not working"
else
  pass "pi NOT on system PATH (nvm-like isolation confirmed)"
fi

# ── Install rho ────────────────────────────────────────

echo ""
echo "-- Setup --"

cd "$REPO_DIR"
git config --global user.email "test@test.com"
git config --global user.name "tester"

install_output=$(bash ./install.sh 2>&1) || true

if command -v rho &>/dev/null; then
  pass "rho installed"
else
  fail "rho not found after install"
  exit 1
fi

rho sync >/dev/null 2>&1 || true

# ══════════════════════════════════════════════════════
#  Issue #7: rho start finds pi despite nvm-isolated PATH
# ══════════════════════════════════════════════════════

echo ""
echo "-- Issue #7: rho start with nvm-isolated pi --"

# rho doctor should find pi
doctor_output=$(rho doctor 2>&1) || true
if echo "$doctor_output" | grep -qP '✓.*pi|pi.*\d+\.\d+'; then
  pass "#7 doctor: finds pi"
else
  fail "#7 doctor: pi not found"
  echo "  doctor output:"
  echo "$doctor_output" | grep -i pi || true
fi

# rho start should work — the fix resolves pi's full path
# before passing it to the tmux session.
rho start >/dev/null 2>&1 || true
sleep 4

if tmux -L rho has-session -t rho 2>/dev/null; then
  pass "#7 start: tmux session created"

  # Give pi a moment to start, then check the pane
  sleep 2
  pane_cmd=$(tmux -L rho list-panes -t rho -F '#{pane_current_command}' 2>/dev/null | head -1 || echo "")
  if [ -n "$pane_cmd" ]; then
    pass "#7 start: pane running ($pane_cmd)"
  else
    fail "#7 start: pane empty"
  fi
else
  fail "#7 start: tmux session NOT found (pi not resolved — the bug!)"
  echo "  This is the core issue #7 failure"
fi

rho stop >/dev/null 2>&1 || true
sleep 1

# ══════════════════════════════════════════════════════
#  Issue #8: Heartbeat command includes -p, uses remain-on-exit
# ══════════════════════════════════════════════════════

echo ""
echo "-- Issue #8: Heartbeat command structure --"

rho_ext="$REPO_DIR/extensions/rho/index.ts"
if [ -f "$rho_ext" ]; then
  hb_cmd_line=$(grep 'const command.*pi.*--no-session.*HEARTBEAT_PROMPT_FILE' "$rho_ext" || echo "")

  if [ -n "$hb_cmd_line" ]; then
    pass "#8: heartbeat command line found"

    if echo "$hb_cmd_line" | grep -q 'pi -p'; then
      pass "#8: uses -p flag (exits after prompt)"
    else
      fail "#8: missing -p flag"
    fi

    if echo "$hb_cmd_line" | grep -qP 'pi\s+--no-session'; then
      fail "#8: bare 'pi --no-session' without -p (the old bug)"
    else
      pass "#8: no bare 'pi --no-session'"
    fi
  else
    fail "#8: heartbeat command line not found in source"
  fi

  if grep -q 'remain-on-exit' "$rho_ext"; then
    pass "#8: remain-on-exit (output visibility preserved)"
  else
    fail "#8: no remain-on-exit"
  fi

  if grep -q 'heartbeatPaneDead' "$rho_ext"; then
    pass "#8: dead pane detection exists"
  else
    fail "#8: no dead pane handling"
  fi
else
  fail "#8: extension source not found"
fi

# ══════════════════════════════════════════════════════
#  Issue #9: buildModelFlags ordering
# ══════════════════════════════════════════════════════

echo ""
echo "-- Issue #9: Model resolution ordering --"

if [ -f "$rho_ext" ]; then
  bmf_body=$(sed -n '/const buildModelFlags = async/,/^  };$/p' "$rho_ext")

  if [ -n "$bmf_body" ]; then
    pass "#9: found buildModelFlags"

    pinned_line=$(echo "$bmf_body" | grep -n 'hbState\.heartbeatModel' | head -1 | cut -d: -f1)
    auto_line=$(echo "$bmf_body" | grep -n 'resolveHeartbeatModel' | head -1 | cut -d: -f1)
    session_line=$(echo "$bmf_body" | grep -n 'if (ctx\.model)' | head -1 | cut -d: -f1)

    if [ -n "$pinned_line" ] && [ -n "$auto_line" ] && [ -n "$session_line" ]; then
      pass "#9: three strategies found (pinned:$pinned_line auto:$auto_line session:$session_line)"

      if [ "$auto_line" -lt "$session_line" ]; then
        pass "#9: auto-resolve BEFORE session fallback"
      else
        fail "#9: session fallback before auto-resolve (the bug)"
      fi

      if [ "$pinned_line" -lt "$auto_line" ]; then
        pass "#9: pinned checked first"
      else
        fail "#9: pinned not checked first"
      fi
    else
      fail "#9: missing strategies (pinned=$pinned_line auto=$auto_line session=$session_line)"
    fi
  else
    fail "#9: buildModelFlags not found"
  fi
else
  fail "#9: extension source not found"
fi

# ══════════════════════════════════════════════════════
#  Unit tests
# ══════════════════════════════════════════════════════

echo ""
echo "-- Unit: test-regressions.ts --"

cd "$REPO_DIR"
if node --experimental-strip-types tests/test-regressions.ts >/dev/null 2>&1; then
  pass "test-regressions.ts: all pass"
else
  fail "test-regressions.ts: failures"
  node --experimental-strip-types tests/test-regressions.ts 2>&1 | grep FAIL || true
fi

# ── Results ────────────────────────────────────────────

echo ""
echo "================================="
echo "  Regression Results: $PASS passed, $FAIL failed"
echo "================================="

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "Failures:"
  for err in "${ERRORS[@]}"; do
    echo "  - $err"
  done
  echo ""
  exit 1
fi

exit 0
