#!/usr/bin/env bash
# Pre-commit gate: shipped asset size budgets for web/public.
# Prevents accidental bloat in the no-build frontend.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

JS_DIR="web/public/js"
CSS_DIR="web/public/css"

# Budgets (bytes)
JS_FILE_WARN=20480    # 20KB per file
JS_FILE_FAIL=30720    # 30KB per file
JS_TOTAL_FAIL=307200  # 300KB total
CSS_TOTAL_FAIL=102400 # 100KB total

FAILED=0
WARNED=0

# --- JS per-file check ---
if [ "${CHECK_STAGED_ONLY:-}" = "1" ]; then
  JS_FILES=$(git diff --cached --name-only --diff-filter=ACM | grep -E "^${JS_DIR}/.*\.js$" || true)
else
  JS_FILES=$(find "$JS_DIR" -type f -name '*.js' 2>/dev/null | sort)
fi

for f in $JS_FILES; do
  [ -f "$f" ] || continue
  SIZE=$(wc -c < "$f")
  if [ "$SIZE" -gt "$JS_FILE_FAIL" ]; then
    echo "  ✗ $f ($(( SIZE / 1024 ))KB > $(( JS_FILE_FAIL / 1024 ))KB limit)"
    FAILED=1
  elif [ "$SIZE" -gt "$JS_FILE_WARN" ]; then
    echo "  ⚠ $f ($(( SIZE / 1024 ))KB > $(( JS_FILE_WARN / 1024 ))KB warn)"
    WARNED=1
  fi
done

# --- JS total check ---
JS_TOTAL=0
for f in $(find "$JS_DIR" -type f -name '*.js' 2>/dev/null); do
  SIZE=$(wc -c < "$f")
  JS_TOTAL=$(( JS_TOTAL + SIZE ))
done

if [ "$JS_TOTAL" -gt "$JS_TOTAL_FAIL" ]; then
  echo "  ✗ JS total: $(( JS_TOTAL / 1024 ))KB > $(( JS_TOTAL_FAIL / 1024 ))KB limit"
  FAILED=1
else
  echo "  ✓ JS total: $(( JS_TOTAL / 1024 ))KB / $(( JS_TOTAL_FAIL / 1024 ))KB"
fi

# --- CSS total check ---
CSS_TOTAL=0
for f in $(find "$CSS_DIR" -type f -name '*.css' 2>/dev/null); do
  SIZE=$(wc -c < "$f")
  CSS_TOTAL=$(( CSS_TOTAL + SIZE ))
done

if [ "$CSS_TOTAL" -gt "$CSS_TOTAL_FAIL" ]; then
  echo "  ✗ CSS total: $(( CSS_TOTAL / 1024 ))KB > $(( CSS_TOTAL_FAIL / 1024 ))KB limit"
  FAILED=1
else
  echo "  ✓ CSS total: $(( CSS_TOTAL / 1024 ))KB / $(( CSS_TOTAL_FAIL / 1024 ))KB"
fi

if [ "$FAILED" = "1" ]; then
  echo ""
  echo "Asset size budget exceeded. Refactor or split the offending files."
  exit 1
fi

if [ "$WARNED" = "1" ]; then
  echo ""
  echo "⚠ Some files approaching size limit — consider splitting soon."
fi

echo "✓ asset size budgets"
