#!/usr/bin/env bash
# Shared pre-commit gate: strict Biome + 500-line web limit
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

STAGED_TS_JS=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\.(ts|js)$' || true)

if [ -n "$STAGED_TS_JS" ]; then
  echo "── pre-commit: biome strict (format + lint) ──"
  printf '%s\n' "$STAGED_TS_JS" | xargs npx --no-install @biomejs/biome check --error-on-warnings --no-errors-on-unmatched
  echo "✓ biome strict"
else
  echo "No staged .ts/.js files — skipping Biome"
fi

echo "── pre-commit: line limit (500) ──"
CHECK_STAGED_ONLY=1 bash scripts/check-line-limit.sh

echo ""
echo "✅ pre-commit gates passed"
