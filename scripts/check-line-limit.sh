#!/usr/bin/env bash
# Check that staged .ts/.js files stay under the line limit.
# New files or files crossing the limit for the first time: hard fail.
# Files already over the limit: allow up to 30% growth (formatter normalization).
# Set CHECK_STAGED_ONLY=1 to only check staged files.
set -euo pipefail

LIMIT=500
MAX_GROWTH_PCT=30
FAILED=0

if [ "${CHECK_STAGED_ONLY:-}" = "1" ]; then
  FILES=$(git diff --cached --name-only --diff-filter=ACM | grep -E '\.(ts|js)$' || true)
else
  FILES=$(find . -name '*.ts' -o -name '*.js' | grep -v node_modules | grep -v '.worktrees')
fi

for f in $FILES; do
  [ -f "$f" ] || continue
  LINES=$(wc -l < "$f")
  if [ "$LINES" -gt "$LIMIT" ]; then
    OLD_LINES=$(git show HEAD:"$f" 2>/dev/null | wc -l 2>/dev/null || echo 0)
    if [ "$OLD_LINES" -gt "$LIMIT" ]; then
      THRESHOLD=$(( OLD_LINES + OLD_LINES * MAX_GROWTH_PCT / 100 ))
      if [ "$LINES" -gt "$THRESHOLD" ]; then
        echo "  ✗ $f ($OLD_LINES → $LINES lines, >${MAX_GROWTH_PCT}% growth). Split it."
        FAILED=1
      fi
    else
      echo "  ✗ $f ($LINES lines > $LIMIT limit)"
      FAILED=1
    fi
  fi
done

if [ "$FAILED" = "1" ]; then
  echo ""
  echo "Files exceed the $LIMIT line limit. Split them up."
  exit 1
fi

echo "✓ line limit ($LIMIT)"
