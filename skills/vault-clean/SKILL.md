---
name: vault-clean
description: Detect and resolve orphaned notes in the vault. Use during heartbeat maintenance or when vault status shows orphans. Finds notes with no inbound wikilinks and either connects them to the graph or flags them for cleanup.
kind: sop
---

# Vault Orphan Cleanup

Resolve orphaned notes in `~/.rho/vault/` -- notes that exist but have no inbound `[[wikilinks]]` from any other note.

## Step 1: Detect Orphans

Run the detection script to get the current orphan list:

```bash
TMPDIR="$PREFIX/tmp"

# All note slugs
find ~/.rho/vault -name "*.md" -not -name "_inbox.md" | while read f; do
  basename "$f" .md
done | sort -u > "$TMPDIR/vault-slugs.txt"

# All wikilink targets
rg -oN '\[\[([^\]]+)\]\]' ~/.rho/vault --no-filename -r '$1' | sort -u > "$TMPDIR/vault-links.txt"

# Orphans: notes with zero inbound links
comm -23 "$TMPDIR/vault-slugs.txt" "$TMPDIR/vault-links.txt" | grep -v "^_index$"
```

## Step 2: Triage Each Orphan

For each orphaned note, read it with `vault read` and classify it:

### A. Connect It (most common)
The note has value but nobody links to it. Fix by:
1. Find the right MOC or parent note (check `_index`, project notes, topic MOCs)
2. Add a `[[slug]]` wikilink from the parent to the orphan
3. If the orphan's own `## Connections` section is missing links, add those too

### B. Merge It
The note duplicates content already in another note. Fix by:
1. Identify the canonical note
2. Move any unique content from the orphan into the canonical note
3. Delete the orphan file: `rm ~/.rho/vault/<type>/<slug>.md`

### C. Promote It
The note is important enough to be a new section in `_index.md`. Fix by:
1. Add it to the appropriate section in `_index.md` (Projects, References, Concepts, Patterns, Logs)
2. Ensure the note has a proper `## Connections` section linking back

### D. Delete It
The note is stale, empty, or no longer relevant. Fix by:
1. Verify it's truly not needed (check if any task or active project references it)
2. Delete: `rm ~/.rho/vault/<type>/<slug>.md`
3. Clean up any outbound links from _index or other notes that might reference it

## Step 3: Verify

After processing, rerun the detection script. Orphan count should decrease.
Report: how many connected, merged, promoted, deleted.

## Batch Processing

When running during heartbeat, process max 5 orphans per cycle to stay lightweight.
Prioritize by:
1. Notes linked *from* `_index.md` that don't exist yet (broken links) -- create stubs
2. Recently created orphans (likely just missed during initial capture)
3. Older orphans (may be stale, more likely to delete)

## Common Orphan Patterns

- **Date-prefixed notes** (e.g. `2026-02-05-email-rollback`): Usually operational runbooks. Connect to the relevant project note.
- **Draft content** (e.g. `reddit-localllama-draft`, `x-drafts`): Connect to a drafts MOC or the project they support.
- **Generic names** (`BACKLOG`, `TODO`, `ENGINEERING`): Often subdirectory artifacts from project imports. Usually merge into the project note or delete if redundant.
- **Newly captured notes**: Just need a link from `_index.md` or the relevant MOC.

## Guardrails

- Never delete a note without reading it first
- If unsure whether to delete, connect it instead (safe default)
- Always update `_index.md` when promoting
- After edits, verify the note renders correctly with `vault read`
