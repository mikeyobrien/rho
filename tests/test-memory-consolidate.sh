#!/usr/bin/env bash
#
# test-memory-consolidate.sh — LLM-in-the-loop test for the memory-consolidate SOP.
#
# Creates a synthetic brain.jsonl full of problems (dupes, near-dupes, stale,
# merge candidates, contradictions), runs pi --no-session with the SOP,
# then validates the result.
#
# Usage:
#   ./tests/test-memory-consolidate.sh [--dry-run] [--model <model>]
#
# Requires: pi, npx tsx, jq
#
set -euo pipefail
cd "$(dirname "$0")/.."

DRY_RUN=false
MODEL=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run) DRY_RUN=true; shift ;;
    --model)   MODEL="$2"; shift 2 ;;
    *)         echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# ── Setup temp dir ─────────────────────────────────────────────────

TMPDIR=$(mktemp -d)
BRAIN="$TMPDIR/brain.jsonl"
trap 'rm -rf "$TMPDIR"' EXIT

echo "=== Memory Consolidation Test ==="
echo "Temp dir: $TMPDIR"
echo "Dry run:  $DRY_RUN"
[[ -n "$MODEL" ]] && echo "Model:    $MODEL"
echo ""

# ── Generate synthetic brain.jsonl ─────────────────────────────────

npx tsx tests/generate-synthetic-brain.ts "$BRAIN"

# Count from folded state (accurate after tombstones)
BEFORE_STATS=$(RHO_BRAIN_PATH="$BRAIN" RHO_BRAIN_DIR="$TMPDIR" npx tsx -e "
import { readBrain, foldBrain } from './extensions/lib/brain-store.ts';
const { entries, stats } = readBrain('$BRAIN');
const brain = foldBrain(entries);
console.log(JSON.stringify({
  lines: stats.total,
  learnings: brain.learnings.length,
  preferences: brain.preferences.length,
  behaviors: brain.behaviors.length,
  meta: brain.meta.size,
  tombstones: brain.tombstoned.size,
}));
")
BEFORE_LINES=$(echo "$BEFORE_STATS" | jq -r '.lines')
BEFORE_LEARNINGS=$(echo "$BEFORE_STATS" | jq -r '.learnings')
BEFORE_PREFS=$(echo "$BEFORE_STATS" | jq -r '.preferences')
BEFORE_BEHAVIORS=$(echo "$BEFORE_STATS" | jq -r '.behaviors')
BEFORE_META=$(echo "$BEFORE_STATS" | jq -r '.meta')

echo "Generated synthetic brain (folded):"
echo "  Total lines:  $BEFORE_LINES"
echo "  Learnings:    $BEFORE_LEARNINGS"
echo "  Preferences:  $BEFORE_PREFS"
echo "  Behaviors:    $BEFORE_BEHAVIORS"
echo "  Meta:         $BEFORE_META"
echo ""

# ── Build the prompt ───────────────────────────────────────────────

SOP_PATH="$(pwd)/sops/memory-consolidate.sop.md"

DRY_FLAG=""
if $DRY_RUN; then
  DRY_FLAG="Set dry_run=true — only output the change plan, do not apply."
fi

PROMPT="You are running memory consolidation on a brain.jsonl file.

Follow the SOP at: $SOP_PATH

The brain tool is already configured to use the file at: $BRAIN

$DRY_FLAG

Start by running brain action=list to inventory entries, then follow every step in the SOP.
At the end, output your consolidation report."

echo "=== Running pi --no-session ==="
echo ""

# ── Run pi ─────────────────────────────────────────────────────────

MODEL_FLAG=""
[[ -n "$MODEL" ]] && MODEL_FLAG="--model $MODEL"

RHO_BRAIN_PATH="$BRAIN" RHO_BRAIN_DIR="$TMPDIR" \
  pi -p --no-session $MODEL_FLAG "$PROMPT" 2>&1 | tee "$TMPDIR/pi-output.txt"

echo ""
echo "=== Validation ==="
echo ""

# ── Validate results ───────────────────────────────────────────────

if $DRY_RUN; then
  echo "Dry run — skipping mutation validation."
  echo "Check $TMPDIR/pi-output.txt for the change plan."
  # Keep tmpdir for inspection
  trap - EXIT
  echo "Temp dir preserved: $TMPDIR"
  exit 0
fi

AFTER_LINES=$(wc -l < "$BRAIN" | tr -d ' ')

# Use brain-store to get accurate folded counts
AFTER_STATS=$(RHO_BRAIN_PATH="$BRAIN" npx tsx -e "
import { readBrain, foldBrain } from './extensions/lib/brain-store.ts';
const { entries, stats } = readBrain('$BRAIN');
const brain = foldBrain(entries);
const out = {
  total_lines: stats.total,
  bad_lines: stats.badLines,
  learnings: brain.learnings.length,
  preferences: brain.preferences.length,
  behaviors: brain.behaviors.length,
  tasks: brain.tasks.length,
  tombstones: brain.tombstoned.size,
};
console.log(JSON.stringify(out));
")

echo "After consolidation:"
echo "  Raw lines:   $AFTER_LINES"
echo "  Stats:       $AFTER_STATS"
echo ""

# Parse stats
AFTER_LEARNINGS=$(echo "$AFTER_STATS" | jq -r '.learnings')
AFTER_PREFS=$(echo "$AFTER_STATS" | jq -r '.preferences')
AFTER_BEHAVIORS=$(echo "$AFTER_STATS" | jq -r '.behaviors')
TOMBSTONES=$(echo "$AFTER_STATS" | jq -r '.tombstones')
BAD_LINES=$(echo "$AFTER_STATS" | jq -r '.bad_lines')

PASS=0
FAIL=0

check() {
  local label="$1" cond="$2"
  if eval "$cond"; then
    echo "  PASS: $label"
    PASS=$((PASS + 1))
  else
    echo "  FAIL: $label"
    FAIL=$((FAIL + 1))
  fi
}

# ── Core invariants ────────────────────────────────────────────────
check "no bad lines in brain.jsonl" "[[ $BAD_LINES -eq 0 ]]"
check "behaviors untouched (still $BEFORE_BEHAVIORS)" "[[ $AFTER_BEHAVIORS -eq $BEFORE_BEHAVIORS ]]"
check "at least 1 tombstone created" "[[ $TOMBSTONES -gt 0 ]]"
check "learnings reduced" "[[ $AFTER_LEARNINGS -lt $BEFORE_LEARNINGS ]]"
check "file is append-only (lines >= before)" "[[ $AFTER_LINES -ge $BEFORE_LINES ]]"

# ── Duplicate/stale removal ────────────────────────────────────────
LEARNINGS_REMOVED=$((BEFORE_LEARNINGS - AFTER_LEARNINGS))
check "removed at least 3 duplicate/stale learnings" "[[ $LEARNINGS_REMOVED -ge 3 ]]"

# ── Contradictory preferences ─────────────────────────────────────
PREF_CHECKS=$(RHO_BRAIN_PATH="$BRAIN" RHO_BRAIN_DIR="$TMPDIR" npx tsx -e "
import { readBrain, foldBrain } from './extensions/lib/brain-store.ts';
const { entries } = readBrain('$BRAIN');
const brain = foldBrain(entries);
const newerKept = brain.preferences.some(p => p.text.includes('tabs for indentation'));
const olderGone = !brain.preferences.some(p => p.text === 'Use 2 spaces for indentation');
console.log(JSON.stringify({ newerKept, olderGone }));
")
check "newer contradictory preference kept" "[[ $(echo "$PREF_CHECKS" | jq -r '.newerKept') == 'true' ]]"
check "older contradictory preference removed" "[[ $(echo "$PREF_CHECKS" | jq -r '.olderGone') == 'true' ]]"

# ── Keeper survival ───────────────────────────────────────────────
KEEP_SURVIVED=$(RHO_BRAIN_PATH="$BRAIN" RHO_BRAIN_DIR="$TMPDIR" npx tsx -e "
import { readBrain, foldBrain } from './extensions/lib/brain-store.ts';
const { entries } = readBrain('$BRAIN');
const brain = foldBrain(entries);
const keepers = [
  'API rate limit is 100 requests per minute per key',
  'Always run tests before committing',
  'The deploy pipeline takes 12 minutes',
  'Use pnpm not npm in this monorepo',
  'Fish shell config lives in ~/.config/fish',
];
const found = keepers.filter(k => brain.learnings.some(l => l.text.includes(k)));
console.log(found.length);
")
check "all 5 keeper learnings survived" "[[ '$KEEP_SURVIVED' == '5' ]]"

# ── Semantically different entries must NOT merge ──────────────────
SIMILAR_CHECKS=$(RHO_BRAIN_PATH="$BRAIN" RHO_BRAIN_DIR="$TMPDIR" npx tsx -e "
import { readBrain, foldBrain } from './extensions/lib/brain-store.ts';
const { entries } = readBrain('$BRAIN');
const brain = foldBrain(entries);
const pythonIndent = brain.learnings.some(l => l.text.includes('4-space indent in Python'));
const yamlIndent = brain.learnings.some(l => l.text.includes('2-space indent in YAML'));
console.log(JSON.stringify({ pythonIndent, yamlIndent }));
")
check "Python indent learning kept (not merged with YAML)" "[[ $(echo "$SIMILAR_CHECKS" | jq -r '.pythonIndent') == 'true' ]]"
check "YAML indent learning kept (not merged with Python)" "[[ $(echo "$SIMILAR_CHECKS" | jq -r '.yamlIndent') == 'true' ]]"

# ── Scoped vs global must NOT merge ───────────────────────────────
SCOPE_CHECKS=$(RHO_BRAIN_PATH="$BRAIN" RHO_BRAIN_DIR="$TMPDIR" npx tsx -e "
import { readBrain, foldBrain } from './extensions/lib/brain-store.ts';
const { entries } = readBrain('$BRAIN');
const brain = foldBrain(entries);
const scopedRedis = brain.learnings.some(l => l.text.includes('5 minutes'));
const globalRedis = brain.learnings.some(l => l.text.includes('1 hour') && l.text.includes('billing'));
console.log(JSON.stringify({ scopedRedis, globalRedis }));
")
check "scoped Redis TTL learning kept" "[[ $(echo "$SCOPE_CHECKS" | jq -r '.scopedRedis') == 'true' ]]"
check "global Redis TTL learning kept" "[[ $(echo "$SCOPE_CHECKS" | jq -r '.globalRedis') == 'true' ]]"

# ── Same-text different-category preferences must keep both ────────
CROSS_CAT=$(RHO_BRAIN_PATH="$BRAIN" RHO_BRAIN_DIR="$TMPDIR" npx tsx -e "
import { readBrain, foldBrain } from './extensions/lib/brain-store.ts';
const { entries } = readBrain('$BRAIN');
const brain = foldBrain(entries);
const explicit = brain.preferences.filter(p => p.text === 'Prefer explicit over implicit');
console.log(explicit.length);
")
check "same-text different-category prefs both kept ($CROSS_CAT)" "[[ '$CROSS_CAT' -ge 2 ]]"

# ── Meta entry survived ───────────────────────────────────────────
META_OK=$(RHO_BRAIN_PATH="$BRAIN" RHO_BRAIN_DIR="$TMPDIR" npx tsx -e "
import { readBrain, foldBrain } from './extensions/lib/brain-store.ts';
const { entries } = readBrain('$BRAIN');
const brain = foldBrain(entries);
const sv = brain.meta.get('schema_version');
console.log(sv?.value === '1' ? 'yes' : 'no');
")
check "meta schema_version=1 survived" "[[ '$META_OK' == 'yes' ]]"

# ── Preference count sanity ────────────────────────────────────────
# Started with 8 prefs (2 contradictory + 2 cross-category + 4 keepers)
# Should lose exactly 1 (the old contradictory one), keep 7
check "preferences lost at most 1 (was $BEFORE_PREFS, now $AFTER_PREFS)" "[[ $AFTER_PREFS -ge $((BEFORE_PREFS - 1)) ]]"

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

# Preserve tmpdir on failure for debugging
if [[ $FAIL -gt 0 ]]; then
  trap - EXIT
  echo "Temp dir preserved for debugging: $TMPDIR"
  exit 1
fi
