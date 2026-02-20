#!/usr/bin/env bash
# Enforce a hard 500-line limit for web code files (.ts/.js).
# Set LINE_LIMIT_TARGET to override scope (default: web).
set -euo pipefail

LIMIT=500
TARGET_DIR="${LINE_LIMIT_TARGET:-web}"
FAILED=0

if [ "${CHECK_STAGED_ONLY:-}" = "1" ]; then
  FILES=$(git diff --cached --name-only --diff-filter=ACM | grep -E "^${TARGET_DIR}/.*\.(ts|js)$" || true)
else
  FILES=$(find "$TARGET_DIR" -type f \( -name '*.ts' -o -name '*.js' \) | grep -v node_modules | sort)
fi

for f in $FILES; do
  [ -f "$f" ] || continue
  LINES=$(wc -l < "$f")
  if [ "$LINES" -gt "$LIMIT" ]; then
    echo "  ✗ $f ($LINES lines > $LIMIT limit)"
    FAILED=1
  fi
done

if [ "$FAILED" = "1" ]; then
  echo ""
  echo "Web files exceed the $LIMIT line limit. Split them up."
  exit 1
fi

echo "✓ web line limit ($LIMIT)"
