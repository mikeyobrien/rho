---
name: memory-clean
description: Consolidate agent memory by decaying stale entries, removing duplicates, and relocating reference material to the vault. Use when memory has grown large or contains duplicates.
---

# Memory Consolidation

## Overview

Consolidate the agent's brain by reviewing entries in `~/.rho/brain/brain.jsonl`, decaying stale learnings, removing duplicates, and relocating reference-quality entries to the vault. Uses the `brain` tool for all modifications — never edits brain.jsonl directly.

## Parameters

- **brain_path** (default: `~/.rho/brain/brain.jsonl`): Path to the brain file

**Constraints for parameter acquisition:**
- You MUST verify the brain file exists before proceeding
- You MUST run `brain action=list` to get a full inventory of entries by type

## Steps

### 1. Inventory

Run `brain action=list` for each type to get the full picture.

**Constraints:**
- You MUST count entries by type: learnings, preferences, behaviors, identity, user, context, tasks, reminders
- You MUST note the total entry count

### 2. Decay Stale Learnings

Run `brain action=decay` to automatically archive learnings that haven't been reinforced.

**Constraints:**
- This uses the configured `decay_after_days` (default 90) and `decay_min_score` (default 3)
- Report how many entries were decayed

### 3. Identify Duplicates and Merges

Review learnings and preferences for:
- **Exact or near-duplicates**: entries that say the same thing in slightly different words
- **Superseded entries**: older entries contradicted or replaced by newer ones
- **Stale entries**: entries about things that no longer exist or apply
- **Merge candidates**: multiple entries about the same topic that could be combined
- **Vault candidates**: entries with reference-quality knowledge better served as vault notes

**Constraints:**
- You MUST NOT remove a preference unless it directly contradicts a newer preference
- You MUST NOT invent new information — consolidation reduces and clarifies, it does not add
- You SHOULD prefer specific, actionable entries over vague general ones

### 4. Clean Up

For each entry to remove or replace:
- Use `brain action=remove id=<id> reason="..."` to tombstone duplicates/stale entries
- Use `brain action=add type=learning text="..."` to add merged replacements
- Use `brain action=update id=<id> text="..."` to tighten wording on existing entries

**Constraints:**
- When merging multiple entries into one, remove the originals and add a new combined entry
- You MUST NOT remove entries without good reason — when uncertain, keep them

### 5. Vault Relocation

For entries flagged as vault candidates:

**Vault relocation criteria:**
- Architectural decisions and design rationale
- Multi-paragraph knowledge crammed into one line
- Reference material with links that would benefit from being a proper note
- Detailed project context that a new session would need to ramp up

**Constraints:**
- You MUST use the `vault write` tool to create each note before removing the brain entry
- Each vault note MUST have a `## Connections` section with `[[wikilinks]]`
- If a relocated entry has a concrete value needed for quick recall, leave a shorter replacement in the brain pointing to the vault note
- You MUST NOT remove a brain entry without writing the vault note first

### 6. Report

Summarize what changed.

**Constraints:**
- You MUST report:
  - Entry count before and after (total, by type)
  - Number of entries decayed, removed, merged, kept unchanged, relocated to vault
  - Vault notes created or updated (with slugs)
  - A brief list of the most significant changes (up to 10)

## Examples

### Example Output
```
Before: 332 entries (245 learnings, 87 preferences)
After:  189 entries (138 learnings, 51 preferences)

Decayed: 42 stale learnings (>90 days, score <3)
Removed: 47 entries
  - 34 near-duplicates
  - 13 superseded or stale

Merged: 12 groups into 5 entries
Relocated to vault: 4 entries -> 2 notes
  - [[rho-email-architecture]] (new)
  - [[market-scan-2026-02]] (new)

Kept unchanged: 177 entries
```

## Troubleshooting

### Agent is uncertain whether to remove an entry
Keep it. The cost of one extra entry is lower than the cost of losing useful context.

### Contradictory entries found
Keep the newer entry. If both have value, merge into one that captures the current state.

### Entry is borderline between memory and vault
If it works as a one-liner, keep it in the brain. The vault is for entries that need structure or connections.
