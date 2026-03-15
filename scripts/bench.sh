#!/usr/bin/env bash
# Quick local benchmarks for rho-web API routes using autocannon.
# Usage: bash scripts/bench.sh [base_url]
#   base_url defaults to http://localhost:3141
#
# Requires: npx autocannon (auto-installed via npx)
# Start the server first: npx tsx web/dev.ts
set -euo pipefail

BASE="${1:-http://localhost:3141}"
DURATION="${BENCH_DURATION:-5}"
CONNECTIONS="${BENCH_CONNECTIONS:-10}"

echo "═══════════════════════════════════════════"
echo " rho-web benchmark"
echo " target: $BASE"
echo " duration: ${DURATION}s  connections: $CONNECTIONS"
echo "═══════════════════════════════════════════"
echo ""

# Check server is reachable
if ! curl -sf "$BASE/api/tasks" > /dev/null 2>&1; then
  echo "✗ Server not reachable at $BASE"
  echo "  Start it first: npx tsx web/dev.ts"
  exit 1
fi

ROUTES=(
  "/api/sessions"
  "/api/memory"
  "/api/tasks"
  "/js/chat/index.js"
)

LABELS=(
  "GET /api/sessions  (session list)"
  "GET /api/memory    (brain fold)"
  "GET /api/tasks     (task list)"
  "GET /js/chat/index (static asset)"
)

RESULTS_DIR="${RHO_HOME:-$HOME/.rho}/bench"
mkdir -p "$RESULTS_DIR"
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
REPORT="$RESULTS_DIR/bench-$TIMESTAMP.json"

echo "[" > "$REPORT"
FIRST=1

for i in "${!ROUTES[@]}"; do
  ROUTE="${ROUTES[$i]}"
  LABEL="${LABELS[$i]}"

  echo "── $LABEL ──"
  RESULT=$(npx -y autocannon -c "$CONNECTIONS" -d "$DURATION" -j "$BASE$ROUTE" 2>/dev/null)

  # Extract key metrics
  P50=$(echo "$RESULT" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.latency.p50 ?? d.latency.average)")
  P95=$(echo "$RESULT" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.latency.p97_5 ?? d.latency.p99 ?? '-')")
  P99=$(echo "$RESULT" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.latency.p99 ?? '-')")
  RPS=$(echo "$RESULT" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8')); console.log(d.requests.average)")

  printf "  p50: %sms  p95: %sms  p99: %sms  req/s: %s\n\n" "$P50" "$P95" "$P99" "$RPS"

  # Append to JSON report
  if [ "$FIRST" = "1" ]; then FIRST=0; else echo "," >> "$REPORT"; fi
  echo "$RESULT" | node -e "
    const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
    console.log(JSON.stringify({
      route: '$ROUTE',
      label: '${LABEL//\'/\\\'}',
      timestamp: '$TIMESTAMP',
      latency: { p50: d.latency.p50, p95: d.latency.p95, p99: d.latency.p99, avg: d.latency.average },
      requests: { avg: d.requests.average, total: d.requests.total },
      throughput: { avg: d.throughput.average },
      errors: d.errors,
      duration: $DURATION,
      connections: $CONNECTIONS
    }))
  " >> "$REPORT"
done

echo "]" >> "$REPORT"

echo "═══════════════════════════════════════════"
echo " Report saved: $REPORT"
echo "═══════════════════════════════════════════"
