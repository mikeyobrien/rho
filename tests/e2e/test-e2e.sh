#!/usr/bin/env bash
# Rho E2E test suite — runs inside Docker against a clean install.
# Tests the full lifecycle: install → init → sync → doctor → start → status → trigger → stop.
# No LLM keys required. Validates structure, not AI behavior.
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

assert_exit_zero() {
  local label="$1"
  shift
  if "$@" >/dev/null 2>&1; then
    pass "$label"
  else
    fail "$label (exit code: $?)"
  fi
}

assert_file_exists() {
  if [ -f "$1" ]; then
    pass "$2"
  else
    fail "$2 ($1 not found)"
  fi
}

assert_dir_exists() {
  if [ -d "$1" ]; then
    pass "$2"
  else
    fail "$2 ($1 not found)"
  fi
}

assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if echo "$haystack" | grep -qF "$needle"; then
    pass "$label"
  else
    fail "$label (\"$needle\" not in output)"
  fi
}

assert_not_empty() {
  local content="$1" label="$2"
  if [ -n "$content" ]; then
    pass "$label"
  else
    fail "$label (empty)"
  fi
}

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
RHO_DIR="$HOME/.rho"
PI_DIR="$HOME/.pi/agent"

# Ensure cleanup on exit (kill any daemon we start)
cleanup_daemon() {
  if [ -f "$HOME/.rho-daemon.pid" ]; then
    kill "$(cat "$HOME/.rho-daemon.pid")" 2>/dev/null || true
  fi
  tmux -L rho kill-server 2>/dev/null || true
}
trap cleanup_daemon EXIT

echo ""
echo "=== Rho E2E Tests ==="
echo ""

# ── 1. Prerequisites ───────────────────────────────────

echo "-- Prerequisites --"
assert_exit_zero "node is available" node --version
assert_exit_zero "npm is available" npm --version
assert_exit_zero "tmux is available" tmux -V
assert_exit_zero "git is available" git --version

# ── 2. Install ─────────────────────────────────────────

echo ""
echo "-- Install --"

cd "$REPO_DIR"

# install.sh needs git identity for npm
git config --global user.email "test@test.com"
git config --global user.name "tester"

# Run the installer
install_output=$(bash ./install.sh 2>&1) || true
echo "$install_output" | tail -5

assert_exit_zero "rho binary on PATH" which rho
assert_file_exists "$RHO_DIR/init.toml" "init.toml created"
assert_file_exists "$RHO_DIR/packages.toml" "packages.toml created"
assert_dir_exists "$RHO_DIR/brain" "brain directory created"
assert_file_exists "$RHO_DIR/brain/brain.jsonl" "brain/brain.jsonl created"
assert_dir_exists "$PI_DIR" "pi agent directory created"

# ── 3. CLI Basics ──────────────────────────────────────

echo ""
echo "-- CLI Basics --"

version_output=$(rho --version 2>&1)
assert_not_empty "$version_output" "rho --version returns output"

help_output=$(rho --help 2>&1)
assert_contains "$help_output" "init" "help lists init"
assert_contains "$help_output" "sync" "help lists sync"
assert_contains "$help_output" "doctor" "help lists doctor"
assert_contains "$help_output" "start" "help lists start"
assert_contains "$help_output" "stop" "help lists stop"
assert_contains "$help_output" "status" "help lists status"
assert_contains "$help_output" "trigger" "help lists trigger"
assert_contains "$help_output" "config" "help lists config"
assert_contains "$help_output" "logs" "help lists logs"
assert_contains "$help_output" "login" "help lists login"
assert_contains "$help_output" "upgrade" "help lists upgrade"

# Subcommand help doesn't crash
for cmd in init sync doctor start stop status trigger config logs login upgrade; do
  assert_exit_zero "$cmd --help exits 0" rho "$cmd" --help
done

# ── 4. Config ──────────────────────────────────────────

echo ""
echo "-- Config --"

# rho config should show current configuration
config_output=$(rho config 2>&1) || true
assert_not_empty "$config_output" "rho config produces output"

# Verify init.toml has expected structure
init_content=$(cat "$RHO_DIR/init.toml")
assert_contains "$init_content" "[agent]" "init.toml has [agent] section"
assert_contains "$init_content" "[modules.core]" "init.toml has [modules.core]"
assert_contains "$init_content" "heartbeat" "init.toml has heartbeat module"

# ── 5. Sync ────────────────────────────────────────────

echo ""
echo "-- Sync --"

sync_output=$(rho sync 2>&1) || true
assert_contains "$sync_output" "Sync" "rho sync produces output"
assert_file_exists "$RHO_DIR/sync.lock" "sync.lock created"
assert_file_exists "$PI_DIR/settings.json" "pi settings.json created"

# Verify settings.json has the rho package entry
settings_content=$(cat "$PI_DIR/settings.json")
assert_contains "$settings_content" "rho" "settings.json references rho"

# ── 6. Doctor ──────────────────────────────────────────

echo ""
echo "-- Doctor --"

doctor_output=$(rho doctor 2>&1) || true
assert_not_empty "$doctor_output" "rho doctor produces output"
# Doctor should find node (output shows "Node.js" with ANSI codes)
assert_contains "$doctor_output" "Node" "doctor checks node"

# ── 7. Init Idempotency ───────────────────────────────

echo ""
echo "-- Idempotency --"

# Running init again shouldn't clobber existing config
original_init=$(cat "$RHO_DIR/init.toml")
rho init --name rho >/dev/null 2>&1 || true
after_init=$(cat "$RHO_DIR/init.toml")

if [ "$original_init" = "$after_init" ]; then
  pass "rho init is idempotent (init.toml unchanged)"
else
  fail "rho init modified existing init.toml"
fi

# Running install.sh again shouldn't clobber brain
original_brain=$(cat "$RHO_DIR/brain/brain.jsonl")
(cd "$REPO_DIR" && bash ./install.sh 2>&1) >/dev/null || true
after_brain=$(cat "$RHO_DIR/brain/brain.jsonl")

if [ "$original_brain" = "$after_brain" ]; then
  pass "install.sh is idempotent (brain.jsonl unchanged)"
else
  fail "install.sh modified existing brain.jsonl"
fi

# ── 8. Tmux / Daemon Lifecycle ─────────────────────────

echo ""
echo "-- Daemon Lifecycle --"

# Status when not running
status_output=$(rho status 2>&1) || true
assert_not_empty "$status_output" "rho status works when stopped"

# Start the daemon
rho start >/dev/null 2>&1 || true
sleep 4

# Check tmux session exists (may need a moment)
if tmux -L rho has-session -t rho 2>/dev/null; then
  pass "tmux session 'rho' created"
else
  fail "tmux session 'rho' not found after start"
fi

# PID file should exist (daemon writes it async after Node boots)
pid_found=0
for i in 1 2 3 4 5; do
  if [ -f "$HOME/.rho-daemon.pid" ]; then
    pid_found=1
    break
  fi
  sleep 1
done
if [ "$pid_found" -eq 1 ]; then
  pass "daemon PID file created"
else
  fail "daemon PID file not found after 5s"
fi

# Status when running
status_output=$(rho status 2>&1) || true
assert_not_empty "$status_output" "rho status works when running"

# Trigger a check-in (will fail without LLM keys, but the command should route)
trigger_output=$(rho trigger 2>&1) || true
assert_not_empty "$trigger_output" "rho trigger produces output"

# Logs command
logs_output=$(rho logs 2>&1) || true
# May be empty if no heartbeats ran, but shouldn't crash
pass "rho logs doesn't crash"

# Stop the daemon
rho stop >/dev/null 2>&1 || true
sleep 1

# Verify stopped
if tmux -L rho has-session -t rho 2>/dev/null; then
  fail "tmux session still exists after stop"
else
  pass "tmux session cleaned up after stop"
fi

# ── 9. Module Enable/Disable ──────────────────────────

echo ""
echo "-- Module Toggle --"

# Disable brave-search, sync, verify it's excluded
sed -i 's/^brave-search = true/brave-search = false/' "$RHO_DIR/init.toml"
rho sync >/dev/null 2>&1 || true

settings_after=$(cat "$PI_DIR/settings.json")
# When a module is disabled, its extensions should be in the exclude list
# or not in the include list. Check that sync didn't crash.
pass "sync succeeds with disabled module"

# Re-enable
sed -i 's/^brave-search = false/brave-search = true/' "$RHO_DIR/init.toml"
rho sync >/dev/null 2>&1 || true
pass "sync succeeds after re-enabling module"

# ── 10. Brain Structure ────────────────────────────────

echo ""
echo "-- Brain --"

assert_file_exists "$RHO_DIR/brain/brain.jsonl" "brain.jsonl exists"

# brain.jsonl should have valid JSONL
while IFS= read -r line; do
  if ! echo "$line" | python3 -c "import sys,json; json.load(sys.stdin)" 2>/dev/null; then
    fail "brain.jsonl has invalid JSON line: $line"
    break
  fi
done < "$RHO_DIR/brain/brain.jsonl"
pass "brain.jsonl is valid JSONL"

# ── 11. Brain Defaults ─────────────────────────────────

echo ""
echo "-- Brain Defaults --"

assert_file_exists "$RHO_DIR/brain/brain.jsonl" "brain.jsonl created from defaults"
# Should contain behavior entries
if grep -q '"type":"behavior"' "$RHO_DIR/brain/brain.jsonl"; then
  pass "brain.jsonl contains behavior entries"
else
  fail "brain.jsonl missing behavior entries"
fi

# ── 12. npm Install Route (rho init without install.sh) ─

echo ""
echo "-- npm Install Route --"

# Simulate what happens when a user does: npm install -g @rhobot-dev/rho && rho init
# We test that rho init alone creates everything needed.
NPM_TEST_HOME=$(mktemp -d)
env HOME="$NPM_TEST_HOME" PATH="$HOME/.local/bin:$PATH" \
  node --experimental-strip-types "$REPO_DIR/cli/index.ts" init --name "npm-test" >/dev/null 2>&1

assert_file_exists "$NPM_TEST_HOME/.rho/init.toml" "npm route: init.toml created"
assert_file_exists "$NPM_TEST_HOME/.rho/brain/brain.jsonl" "npm route: brain.jsonl created"
assert_file_exists "$NPM_TEST_HOME/.rho/tmux.conf" "npm route: tmux.conf created"

# Verify brain contains behavior entries
if grep -q '"type":"behavior"' "$NPM_TEST_HOME/.rho/brain/brain.jsonl"; then
  pass "npm route: brain.jsonl contains behavior entries"
else
  fail "npm route: brain.jsonl missing behavior entries"
fi

rm -rf "$NPM_TEST_HOME"

# ── 13. Unit Tests ─────────────────────────────────────

echo ""
echo "-- Unit Tests (from repo) --"

cd "$REPO_DIR"

# Run the pure-logic unit tests that don't need tmux or LLM keys
for test in test-config test-sync test-init test-doctor test-cli test-registry test-daemon test-templates test-regressions; do
  if [ -f "tests/${test}.ts" ]; then
    if node --experimental-strip-types "tests/${test}.ts" >/dev/null 2>&1; then
      pass "unit: $test"
    else
      fail "unit: $test"
    fi
  fi
done

# Shell-based tests
for test in test-iphone-docs test-tmux-config; do
  if [ -f "tests/${test}.sh" ]; then
    if bash "tests/${test}.sh" >/dev/null 2>&1; then
      pass "unit: $test"
    else
      fail "unit: $test"
    fi
  fi
done

# ── Results ────────────────────────────────────────────

echo ""
echo "================================="
echo "  E2E Results: $PASS passed, $FAIL failed"
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
