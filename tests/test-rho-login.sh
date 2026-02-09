#!/usr/bin/env bash
# Acceptance tests for `rho login`
#
# Runs against the repo CLI directly (no legacy rho-login wrapper).
# Uses a temporary HOME so it does not read or mutate real user credentials.

set -u

PASS=0
FAIL=0

assert() {
  local desc="$1" result="$2"
  if [ "$result" = "0" ]; then
    echo "  PASS: $desc"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $desc"
    FAIL=$((FAIL + 1))
  fi
}

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI=(node --experimental-strip-types "$ROOT/cli/index.ts")

TMP="$(mktemp -d)"
export HOME="$TMP/home"
mkdir -p "$HOME/.pi/agent"

# Seed a minimal auth.json so --status output is deterministic.
cat > "$HOME/.pi/agent/auth.json" <<'JSON'
{
  "anthropic": { "type": "api_key" }
}
JSON

echo "Testing rho login..."
echo "  HOME=$HOME"
echo ""

# --help
"${CLI[@]}" login --help 2>&1 | grep -q "rho login"
assert "login --help shows usage" $?

# --status
out="$(${CLI[@]} login --status 2>&1)"
echo "$out" | grep -q "Provider credentials"
assert "login --status shows credentials header" $?

echo "$out" | grep -q "anthropic"
assert "login --status lists anthropic" $?

# --logout unknown provider should exit non-zero and print an error.
out2="$(${CLI[@]} login --logout nonexistent-provider 2>&1 || true)"
echo "$out2" | grep -q "not found"
assert "--logout prints not found" $?

"${CLI[@]}" login --logout nonexistent-provider >/dev/null 2>&1
code=$?
[ "$code" -ne 0 ]
assert "--logout exits non-zero on unknown provider" $?

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
