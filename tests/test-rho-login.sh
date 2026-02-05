#!/usr/bin/env bash
# Acceptance tests for rho login
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

echo "Testing rho-login..."
echo ""

# Test --help
rho-login --help 2>&1 | grep -q "Authenticate with LLM providers"
assert "--help shows usage" $?

# Test --status with existing auth.json
rho-login --status 2>&1 | grep -q "Provider credentials"
assert "--status shows credentials" $?

rho-login --status 2>&1 | grep -q "anthropic"
assert "--status lists anthropic" $?

# Test --logout with nonexistent provider (should fail and show error)
rho-login --logout nonexistent-provider 2>&1 | grep -q "not found"
assert "--logout rejects unknown provider" $?

# Test unknown option (should fail and show error)
rho-login --bogus 2>&1 | grep -q "Unknown option"
assert "unknown option shows error" $?

# Test rho subcommand routing
rho login --status 2>&1 | grep -q "Provider credentials"
assert "'rho login --status' routes correctly" $?

rho login --help 2>&1 | grep -q "Authenticate"
assert "'rho login --help' routes correctly" $?

echo ""
echo "Results: $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
