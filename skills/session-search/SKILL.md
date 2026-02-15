---
name: session-search
description: Search across pi session JSONL logs (user prompts, tool calls, results). Uses the session-digest tool and ripgrep for fast triage.
kind: sop
---

# Session Search

Search historical pi sessions stored under `~/.pi/agent/sessions/`.

This skill assumes the **session-digest** helper exists at `~/bin/session-digest`.

## Where sessions live

On this Termux setup, sessions are typically stored in:

- `~/.pi/agent/sessions/--data-data-com.termux-files-home--/*.jsonl`

If you are unsure which directory is active, list the session roots:

```bash
ls -la ~/.pi/agent/sessions
```

## Method A (recommended): generate digests, then search the digests

`session-digest` parses session JSONL into readable markdown and writes files to:

- `~/.rho/digests/YYYY-MM-DD.md`

1) Generate digests for a time window:

```bash
# last 7 days
session-digest --week >/dev/null

# or a single date
session-digest 2026-02-04 >/dev/null

# or all history (can be slow)
session-digest --all >/dev/null
```

2) Search the digest markdown:

```bash
rg -n "<query>" ~/.rho/digests
```

Notes:
- This is the safest way to skim history because `session-digest` also flags potential secrets.
- If `session-digest` reports secrets, do NOT paste results into public logs.

## Method B: direct grep over raw JSONL (fastest, messiest)

Search the raw session logs directly:

```bash
SESSION_ROOT=~/.pi/agent/sessions/--data-data-com.termux-files-home--
rg -n --hidden "<query>" "$SESSION_ROOT"/*.jsonl
```

Useful variants:

```bash
# show a little context around matches
rg -n -C 2 "<query>" "$SESSION_ROOT"/*.jsonl

# case-insensitive
rg -n -i "<query>" "$SESSION_ROOT"/*.jsonl
```

## Common queries

- Find when a specific tool was used:
  - `rg -n '"type":"toolCall"' ... | rg '"name":"vault_search"'`
- Find a user prompt:
  - `rg -n '"role":"user"' ... | rg "<phrase>"`
- Find a specific file path mentioned:
  - `rg -n "projects/rho" ...`

## Guardrails

- Session logs can contain credentials (tokens, API keys, private URLs).
- Prefer **Method A** first: it surfaces warnings via secret scanning.
- If you need to share excerpts, redact aggressively and re-run `session-digest` to confirm no secrets are present.
