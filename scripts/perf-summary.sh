#!/usr/bin/env bash
# Summarize rho-web perf.jsonl — p50/p95/p99 latency by route.
# Usage: bash scripts/perf-summary.sh [perf.jsonl path]
set -euo pipefail

PERF_FILE="${1:-${RHO_HOME:-$HOME/.rho}/perf/perf.jsonl}"

if [ ! -f "$PERF_FILE" ]; then
  echo "No perf log found at $PERF_FILE"
  echo "Enable with: RHO_PERF=1 npx tsx web/dev.ts"
  exit 1
fi

LINES=$(wc -l < "$PERF_FILE")
echo "═══════════════════════════════════════════"
echo " rho-web perf summary ($LINES entries)"
echo " source: $PERF_FILE"
echo "═══════════════════════════════════════════"
echo ""

node -e "
const fs = require('fs');
const lines = fs.readFileSync('$PERF_FILE', 'utf8').trim().split('\n');
const byRoute = new Map();

for (const line of lines) {
  try {
    const e = JSON.parse(line);
    const key = e.method + ' ' + e.path;
    if (!byRoute.has(key)) byRoute.set(key, []);
    byRoute.get(key).push(e.ms);
  } catch {}
}

function percentile(arr, p) {
  const sorted = arr.slice().sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * p / 100) - 1;
  return sorted[Math.max(0, idx)];
}

const rows = [];
for (const [route, times] of byRoute) {
  rows.push({
    route,
    count: times.length,
    p50: percentile(times, 50),
    p95: percentile(times, 95),
    p99: percentile(times, 99),
    max: Math.max(...times),
  });
}

rows.sort((a, b) => b.p95 - a.p95);

console.log('Route'.padEnd(40) + 'Count'.padStart(7) + 'p50'.padStart(7) + 'p95'.padStart(7) + 'p99'.padStart(7) + 'max'.padStart(7));
console.log('─'.repeat(75));
for (const r of rows.slice(0, 20)) {
  console.log(
    r.route.padEnd(40) +
    String(r.count).padStart(7) +
    (r.p50 + 'ms').padStart(7) +
    (r.p95 + 'ms').padStart(7) +
    (r.p99 + 'ms').padStart(7) +
    (r.max + 'ms').padStart(7)
  );
}
if (rows.length > 20) console.log('  ... and ' + (rows.length - 20) + ' more routes');
"
