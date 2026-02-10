# Memory Consolidation

## Overview

Review the agent's brain entries and consolidate: remove duplicates, merge related entries, tombstone stale or superseded items, and tighten wording. Uses the `brain` tool for all mutations — never edits brain.jsonl directly.

Quality gate: the brain should have fewer entries after consolidation, with no loss of actionable information.

## Parameters

- **dry_run** (optional, default: false): If true, report proposed changes without applying them

**Constraints for parameter acquisition:**
- You MUST run `brain action=list` first to get a full inventory before proposing any changes

## Steps

### 1. Inventory

Run `brain action=list` for each relevant type. Record counts.

```
brain action=list type=learning
brain action=list type=preference
brain action=list type=behavior
```

**Constraints:**
- You MUST record the initial count per type
- You MUST read every entry before deciding what to change

### 2. Classify Each Entry

For every learning and preference, assign exactly one label:

| Label | Meaning | Action |
|---|---|---|
| **keep** | Unique, actionable, current | No change |
| **duplicate** | Same meaning as another entry | Remove (keep the better-worded one) |
| **merge** | Related to another entry, combinable | Remove originals, add merged replacement |
| **stale** | About something that no longer exists or applies | Remove |
| **superseded** | Contradicted by a newer entry | Remove the older one |
| **vague** | Too general to be useful ("be helpful") | Remove or rewrite |
| **rewrite** | Correct info but poorly worded | Update in place |

**Constraints:**
- You MUST NOT label a preference as "stale" unless it directly contradicts a newer preference
- You MUST NOT label an entry as "vague" if it contains any specific, actionable detail
- You MUST NOT invent new information — consolidation reduces and clarifies, never adds
- You MUST NOT merge entries about different subjects just because they share keywords (e.g., "4-space indent in Python" and "2-space indent in YAML" are different facts)
- You MUST NOT merge a project-scoped learning with a global learning — they apply to different contexts
- You MUST NOT merge preferences that have the same text but different categories — category is part of the identity
- You MUST NOT touch behavior, meta, identity, user, task, or reminder entries — only learnings and preferences
- Entries that were already tombstoned will not appear in `brain action=list` — do not try to remove them
- When two entries could be either "keep" or "merge", prefer "keep" — merging loses provenance
- When uncertain, label "keep"

### 3. Build Change Plan

Produce a structured change plan as a markdown table:

```markdown
| id | type | label | action | detail |
|---|---|---|---|---|
| abc123 | learning | duplicate | remove | same as def456 |
| def456 | learning | keep | — | — |
| ghi789 | learning | merge | remove | merge with jkl012 |
| jkl012 | learning | merge | replace | "Merged: ..." |
| mno345 | preference | stale | remove | project no longer exists |
| pqr678 | learning | rewrite | update | tighten wording |
```

**Constraints:**
- Every entry MUST appear in the table
- The plan MUST NOT net-add entries (merges: N entries become 1, not N+1)
- If dry_run is true, output the table and stop here

### 4. Execute Changes

Apply the plan in this order:
1. **Rewrites** first (updates to existing entries)
2. **Merges** next (add replacement, then remove originals)  
3. **Removes** last (duplicates, stale, superseded, vague)

For each change:
```
brain action=update id=<id> text="improved wording"
brain action=add type=learning text="Merged: ..."
brain action=remove id=<id> reason="duplicate of <other_id>"
brain action=remove id=<id> reason="stale: <brief explanation>"
```

**Constraints:**
- When merging, add the replacement BEFORE removing originals
- Every remove MUST include a reason
- You MUST NOT remove an entry without having already checked it appears in the change plan

### 5. Verify

Run `brain action=list` again for each type. Compare counts.

**Constraints:**
- Total entries MUST be ≤ initial count
- No entry labeled "keep" should be missing
- Report: entries before, entries after, removed, merged, rewritten, kept

### 6. Report

Output a final summary:

```
## Consolidation Report

Before: 45 entries (30 learnings, 15 preferences)
After:  31 entries (20 learnings, 11 preferences)

Removed: 14 entries
  - 8 duplicates
  - 3 stale
  - 2 superseded  
  - 1 vague

Merged: 4 entries → 2
Rewritten: 3 entries
Kept unchanged: 26 entries
```

## Examples

### Near-duplicate detection

These two entries are duplicates — keep the more specific one:
- `abc1: "Use printf instead of echo"`  
- `def2: "Use printf '%s' instead of echo for piping to jq — echo adds trailing newline"`

Action: remove abc1 (less specific), keep def2.

### Merge candidates

These entries are about the same topic and can be combined:
- `ghi3: "brain tool has 8 actions: add, update, remove, list, decay, task_done, task_clear, reminder_run"`
- `jkl4: "The brain tool uses a single brain.jsonl file"`

Merged: `"The brain tool manages a single brain.jsonl file with 8 actions: add, update, remove, list, decay, task_done, task_clear, reminder_run"`

### Stale entry

- `mno5: "The project uses webpack 4 for bundling"` → project now uses vite. Remove.

### Superseded entry

- `pqr6 (old): "Token budget is 900 tokens"`
- `stu7 (new): "Token budget configurable via config, default 2000"`

Action: remove pqr6, keep stu7.

## Troubleshooting

### Agent removes too aggressively
The safety rule is: when uncertain, keep. One extra entry costs ~4 tokens. One lost entry costs re-discovery.

### Agent invents new learnings during merge
Merges must only combine existing text. If the merge introduces claims not present in either original, it's wrong.

### Contradictory preferences
Keep the newer one. If creation dates are identical, keep both and flag for user review.
