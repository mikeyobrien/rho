#!/usr/bin/env bash
# Reproduce & test: rho start on fresh npm install
set -euo pipefail

PASS=0
FAIL=0
ERRORS=()

pass() { echo -e "  \033[32mPASS\033[0m: $1"; PASS=$((PASS + 1)); }
fail() { echo -e "  \033[31mFAIL\033[0m: $1"; FAIL=$((FAIL + 1)); ERRORS+=("$1"); }

RHO_PKG=$(npm -g root)/@rhobot-dev/rho

echo ""
echo "=== rho start bug repro (npm install route) ==="
echo ""

echo "-- environment --"
echo "  node: $(node --version)"
echo "  rho:  $(rho --version 2>/dev/null)"
echo "  rho:  $(which rho)"
echo "  pi:   $(which pi)"
echo "  pkg:  $RHO_PKG"
echo ""

# ── Check rho.mjs and tsx ──────────────────────────────

echo "-- rho.mjs shim --"

if [ -f "$RHO_PKG/cli/rho.mjs" ]; then
  pass "rho.mjs exists"
else
  fail "rho.mjs missing from package"
fi

if [ -d "$RHO_PKG/node_modules/tsx" ]; then
  pass "tsx installed in package"
else
  fail "tsx NOT installed in package"
fi

# Test: can node run rho.mjs without crashing?
if timeout 3 node "$RHO_PKG/cli/rho.mjs" --version >/dev/null 2>&1; then
  pass "rho.mjs --version works"
else
  fail "rho.mjs --version crashes"
  echo "    error:"
  timeout 3 node "$RHO_PKG/cli/rho.mjs" --version 2>&1 | head -5 | sed 's/^/    /'
fi

# ── Test rho start ─────────────────────────────────────

echo ""
echo "-- rho start --"

# Create pi settings.json manually (normally rho sync does this)
mkdir -p "$HOME/.rho/agent"
echo '{"packages":[]}' > "$HOME/.rho/agent/settings.json"

START_OUTPUT=$(rho start 2>&1) || true
START_EXIT=$?
echo "  output: $START_OUTPUT"
echo "  exit:   $START_EXIT"

sleep 2

# Check if tmux session exists
if tmux -L rho has-session -t rho 2>/dev/null; then
  pass "rho start: tmux session created (rho socket)"
elif tmux has-session -t rho 2>/dev/null; then
  pass "rho start: tmux session created (default socket)"
else
  fail "rho start: NO tmux session found"

  echo ""
  echo "  -- debug --"

  # Try running the monitor directly to see the error
  echo "  running monitor directly..."
  timeout 5 node "$RHO_PKG/cli/rho.mjs" start --monitor 2>&1 | head -10 | sed 's/^/    /'

  # Check if --experimental-strip-types would work instead
  if [ -f "$RHO_PKG/cli/index.ts" ]; then
    echo "  trying --experimental-strip-types..."
    timeout 5 node --experimental-strip-types "$RHO_PKG/cli/index.ts" --version 2>&1 | head -3 | sed 's/^/    /'
  fi
fi

# ── Cleanup ────────────────────────────────────────────

rho stop 2>/dev/null || true
tmux -L rho kill-server 2>/dev/null || true
tmux kill-server 2>/dev/null || true

# ── Results ────────────────────────────────────────────

echo ""
echo "================================="
echo "  Results: $PASS passed, $FAIL failed"
echo "================================="

if [ "$FAIL" -gt 0 ]; then
  echo ""
  echo "Failures:"
  for err in "${ERRORS[@]}"; do
    echo "  - $err"
  done
  exit 1
fi
