# Brain

The brain is Rho's persistent memory system. It lives as a single append-only event log at `~/.rho/brain/brain.jsonl` and carries context across sessions so the agent doesn't start from zero every time.

When a session starts, Rho reads brain.jsonl, folds the entries (applying updates and tombstones), builds a budgeted prompt, and injects it into the system prompt. The agent sees your identity, behavioral guidelines, past learnings, preferences, tasks, and reminders — all without you repeating yourself.

## File Structure

```
~/.rho/brain/
└── brain.jsonl              # Single source of truth — all entry types
```

The file is newline-delimited JSON — one entry per line, append-only. Updates and deletions are represented as new entries that supersede earlier ones (event sourcing).

Override location via environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `RHO_BRAIN_DIR` | `~/.rho/brain` | Directory containing brain.jsonl |
| `RHO_BRAIN_PATH` | `~/.rho/brain/brain.jsonl` | Full path to brain file |

---

## Entry Types

Every entry has three base fields:

```json
{ "id": "...", "type": "...", "created": "2026-01-01T00:00:00.000Z" }
```

### behavior

Behavioral directives — the agent's personality layer. Categories: `do`, `dont`, `value`.

```json
{"id":"b0000001","type":"behavior","category":"do","text":"Be direct — skip filler, get to the point","created":"2026-01-01T00:00:00.000Z"}
{"id":"b0000006","type":"behavior","category":"dont","text":"Use performative phrases like 'Great question!'","created":"2026-01-01T00:00:00.000Z"}
{"id":"b0000009","type":"behavior","category":"value","text":"Clarity over diplomacy","created":"2026-01-01T00:00:00.000Z"}
```

### identity

Key-value pairs describing the agent itself. **Keyed** — later entries with the same `key` overwrite earlier ones. Uses deterministic IDs (see [ID Generation](#id-generation)). Rendered in the prompt as the **Identity** section.

```json
{"id":"a1b2c3d4","type":"identity","key":"name","value":"rho","created":"2026-01-01T00:00:00.000Z"}
{"id":"e5f6g7h8","type":"identity","key":"role","value":"A persistent coding agent with memory and heartbeat","created":"2026-01-01T00:00:00.000Z"}
```

### user

Key-value pairs describing the user. **Keyed** — same dedup behavior as identity. Rendered in the prompt as the **User** section.

```json
{"id":"f1e2d3c4","type":"user","key":"timezone","value":"US/Central","created":"2026-01-15T00:00:00.000Z"}
{"id":"b5a6c7d8","type":"user","key":"editor","value":"Neovim","created":"2026-01-20T00:00:00.000Z"}
```

### learning

Facts, patterns, and conventions the agent discovers. Subject to [decay](#memory-decay). **Deduped** — normalized text comparison prevents storing the same fact twice.

```json
{"id":"a1b2c3d4","type":"learning","text":"This repo uses pnpm not npm","source":"auto","created":"2026-01-15T00:00:00.000Z"}
```

Optional fields: `source` (`"auto"` or `"manual"`), `scope` (`"global"` or `"project"`), `projectPath`.

Learnings are ranked by score and the highest-scoring ones are included first within the [token budget](#prompt-budget).

### preference

Explicit user choices, organized by category. **Deduped** like learnings. **Preferences never decay** — they represent deliberate user intent and stick around until manually removed.

Categories: `Communication`, `Code`, `Tools`, `Workflow`, `General` (or any string).

```json
{"id":"e5f6g7h8","type":"preference","category":"Code","text":"User prefers early returns over nested ifs","created":"2026-01-20T00:00:00.000Z"}
```

### context

Project-specific context, matched by working directory path. **Keyed by `path`** — uses deterministic IDs. When your cwd is inside a matching path, the project context is included in the prompt (longest prefix match wins).

```json
{"id":"ctx00001","type":"context","project":"rho","path":"/home/user/projects/rho","content":"TypeScript monorepo. Use pnpm. Extensions in extensions/.","created":"2026-01-01T00:00:00.000Z"}
```

### task

Lightweight task queue items, surfaced during heartbeat check-ins.

```json
{"id":"t-abc123","type":"task","description":"Fix the flaky test in CI","status":"pending","priority":"high","due":"2026-02-15","tags":["code","ci"],"completedAt":null,"created":"2026-02-10T00:00:00.000Z"}
```

- **Status**: `pending` or `done`
- **Priority**: `urgent`, `high`, `normal`, `low`
- **Tags**: array of lowercase strings (normalized from comma-separated input)
- **Due**: ISO date string or `null`
- **completedAt**: set automatically by `task_done`

### reminder

Recurring or scheduled items that the heartbeat acts on.

```json
{"id":"rem00001","type":"reminder","text":"Run backup script","cadence":{"kind":"interval","every":"6h"},"enabled":true,"priority":"normal","tags":[],"last_run":null,"next_due":null,"last_result":null,"last_error":null,"created":"2026-02-01T00:00:00.000Z"}
```

**Cadence types:**
- `{"kind":"interval","every":"2h"}` — interval units: `m` (minutes), `h` (hours), `d` (days)
- `{"kind":"daily","at":"08:00"}` — daily at a specific time (HH:MM, local time)

**Tracking fields** (updated by `reminder_run`):
- `last_run` — ISO timestamp of last execution
- `next_due` — computed automatically from cadence after each run
- `last_result` — `"ok"`, `"error"`, or `"skipped"`
- `last_error` — error message string or `null`

### tombstone

Marks an entry as removed. The original entry stays in the file; the tombstone prevents it from appearing in the folded state.

```json
{"id":"deadbeef","type":"tombstone","target_id":"a1b2c3d4","target_type":"learning","reason":"decay","created":"2026-02-10T00:00:00.000Z"}
```

Tombstones have their own unique `id` and reference the target via `target_id` and `target_type`.

### meta

Metadata markers for system state (e.g., migration tracking, schema version). **Keyed by `key`** — uses deterministic IDs.

```json
{"id":"meta0001","type":"meta","key":"schema_version","value":"1","created":"2026-02-10T00:00:00.000Z"}
```

---

## Schema Registry

Each entry type has required fields and optional enum constraints. Validation happens before every write.

| Type | Required Fields | Enum Constraints |
|------|----------------|-----------------|
| `behavior` | `category`, `text` | `category`: do, dont, value |
| `identity` | `key`, `value` | — |
| `user` | `key`, `value` | — |
| `learning` | `text` | — |
| `preference` | `text`, `category` | — |
| `context` | `project`, `path`, `content` | — |
| `task` | `description` | — |
| `reminder` | `text`, `cadence`, `enabled` | — |
| `tombstone` | `target_id`, `target_type`, `reason` | — |
| `meta` | `key`, `value` | — |

All entries also require `id`, `type`, and `created` (ISO 8601).

---

## ID Generation

IDs are generated differently depending on the entry type:

**Keyed types** (`identity`, `user`, `meta`, `context`) use deterministic IDs:
```
sha256("type:naturalKey").slice(0, 8)
```
This means re-adding the same key overwrites the previous value during fold — no manual dedup needed.

| Type | Natural Key Field |
|------|------------------|
| `identity` | `key` |
| `user` | `key` |
| `meta` | `key` |
| `context` | `path` |

**Non-keyed types** (`behavior`, `learning`, `preference`, `task`, `reminder`) use random 8-hex-character IDs (`crypto.randomBytes(4).toString("hex")`).

**Tombstones** also get random IDs — they reference the target via `target_id`.

---

## The `brain` Tool

The agent uses this tool programmatically during conversations. All persistent memory operations go through it.

### Actions

| Action | Description |
|--------|-------------|
| `add` | Add a new entry (requires `type` + type-specific fields) |
| `update` | Update an existing entry by ID (merges provided fields) |
| `remove` | Tombstone an entry (by `id`, or by `type` + natural key for keyed types) |
| `list` | List entries, optionally filtered by `type`, `query`, `filter` |
| `decay` | Archive stale learnings (configurable age/score thresholds) |
| `task_done` | Mark a task as done (requires `id`) |
| `task_clear` | Remove all completed tasks |
| `reminder_run` | Record a reminder execution result (requires `id`, `result`) |

### Examples

**Add a learning:**
```
brain action=add type=learning text="This repo uses pnpm not npm"
```

**Add a preference:**
```
brain action=add type=preference text="User prefers early returns" category=Code
```

**Add a behavior:**
```
brain action=add type=behavior text="Be direct" category=do
```

**Add identity info:**
```
brain action=add type=identity key=name value=rho
```

**Add user info:**
```
brain action=add type=user key=timezone value="US/Central"
```

**Add a task:**
```
brain action=add type=task description="Fix the flaky CI test" priority=high due=2026-02-15 tags=code,ci
```

**Add a reminder:**
```
brain action=add type=reminder text="Run backup script" cadence={"kind":"interval","every":"6h"} enabled=true
```

**Update an entry:**
```
brain action=update id=a1b2c3d4 text="This repo uses pnpm (not npm or yarn)"
```

**Remove by ID:**
```
brain action=remove id=a1b2c3d4 reason="No longer accurate"
```

**Remove by natural key** (keyed types only):
```
brain action=remove type=identity key=name
brain action=remove type=context path=/home/user/projects/rho
```

**List all learnings:**
```
brain action=list type=learning
```

**Search entries:**
```
brain action=list query=pnpm
```

**List with full JSON output:**
```
brain action=list type=learning verbose=true
```

**List pending tasks:**
```
brain action=list type=task filter=pending
```

**List active reminders:**
```
brain action=list type=reminder filter=active
```

**Decay stale learnings:**
```
brain action=decay
```

**Complete a task:**
```
brain action=task_done id=t-abc123
```

**Clear completed tasks:**
```
brain action=task_clear
```

**Record reminder execution:**
```
brain action=reminder_run id=rem00001 result=ok
```

**Record failed reminder:**
```
brain action=reminder_run id=rem00001 result=error error="Script exited with code 1"
```

### Dedup Behavior

`learning` and `preference` entries go through text dedup before writing. The candidate text is normalized (lowercased, non-alphanumeric characters collapsed to spaces) and compared against all existing entries. If a match is found, the add is rejected with `"Duplicate learning: already stored"`.

This means the agent can freely attempt to store learnings without worrying about exact duplicates.

### Remove Confirmation

The `remove` action echoes the entry's content in the confirmation message, e.g.:
```
Removed learning a1b2c3d4: This repo uses pnpm not npm
```

---

## Event Sourcing: Read → Fold → Prompt

### Read

Parses all lines from brain.jsonl. Returns entries plus health stats:
- `total` — number of valid entries parsed
- `badLines` — corrupt JSON lines (logged, skipped)
- `truncatedTail` — last line incomplete (file didn't end with `\n`)

### Fold

Applies event sourcing to produce materialized state:

1. Entries are processed in order (oldest first)
2. Same-`id` entries overwrite earlier ones (upsert)
3. Keyed types (`identity`, `user`, `meta`) deduplicate by key via their deterministic ID
4. Tombstones remove the target entry and record the `target_id` as dead
5. A new entry with a previously tombstoned ID **resurrects** it

### Build Prompt

Assembles sections in this order:
1. **Identity** — key-value pairs, sorted alphabetically (fixed cost, not budget-weighted)
2. **User** — key-value pairs, sorted alphabetically (fixed cost, not budget-weighted)
3. **Behavior** — grouped by category (Do / Don't / Values)
4. **Preferences** — grouped by category, sorted alphabetically
5. **Context** — project-specific, longest-prefix-match on cwd
6. **Learnings** — ranked by score, top N within budget

Identity and user sections are rendered in full and their token cost is subtracted before computing the weighted budgets for other sections. `meta` entries are stored and queryable (`brain action=list`) but not injected into the prompt. Tasks and reminders are surfaced separately for heartbeat consumption.

---

## Prompt Budget

The total prompt is capped at a configurable token budget (default **2000 tokens**). Tokens are estimated at ~4 characters each.

Identity and user sections are rendered first at full fidelity — their actual token cost is subtracted from the budget. The remaining budget is then split across weighted sections:

| Section | Weight |
|---------|--------|
| Behavior | 15% of remaining |
| Preferences | 20% of remaining |
| Context | 25% of remaining |
| Learnings | 40% of remaining |

**Surplus cascading**: If a section uses fewer tokens than its allocation, the surplus flows to learnings. This means a brain with few behaviors and no project context gives learnings nearly the entire budget.

Each section is rendered with `takeLinesUntilBudget` — lines are included in order until the budget is exhausted. If lines are omitted, a `(…N more omitted)` marker is appended.

### Injected ID Tracking

The `getInjectedIds()` function mirrors prompt-building logic to compute which entry IDs made it into the prompt. This is used by the memory viewer to distinguish **injected** entries (in the prompt) from **stored** entries (in the file but budget-trimmed).

---

## Learning Scoring

Learnings are scored to determine prompt inclusion order:

| Factor | Points | Description |
|--------|--------|-------------|
| Recency | 0–10 | `10 - floor(age_in_days / 7)`. Newer = higher. |
| Scope boost | +5 | If `scope === "project"` and cwd matches `projectPath` |
| Manual boost | +2 | If `source === "manual"` (explicitly stored by user) |

**Tiebreaker**: newest `created` timestamp first.

Higher-scoring learnings are included first until the budget is exhausted.

---

## Memory Decay

Learnings that go unused get removed automatically:

- After `decayAfterDays` (default **90**) without being updated, a learning is tombstoned
- Learnings with a score of `decayMinScore` or above (default **3**) are exempt regardless of age
- **Preferences never decay** — they're explicit user choices

Trigger decay manually with `brain action=decay`, or let the heartbeat handle it.

---

## Auto-Memory Extraction

Rho automatically extracts memories from conversations. After each agent turn (and before context compaction), a small model analyzes the conversation and pulls out durable learnings and preferences.

How it works:

1. Fires on `agent_end` (every turn) and `session_before_compact` (context window getting full)
2. The conversation is sent to the smallest available model from the same provider
3. The model extracts up to 3 items per pass, each under 200 characters
4. Items go through dedup + limits — duplicates, empty items, over-length items, and over-limit items are skipped with reasons
5. Existing memories are sent as context so the model avoids restating known facts
6. A post-turn receipt appears in TUI notifications with a preview of saved items (`+N saved, M skipped: "..." | "..."`)
7. Every extraction run is appended to `~/.rho/brain/auto-memory-log.jsonl` with run metadata, decisions, and skip reasons
8. Saved auto-memory entries carry provenance fields (`source`, `sourceSessionId`, `sourceLeafId`, `sourceRunId`, `sourceTrigger`) for traceability

### Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `autoMemory` | `true` | Enable/disable. Also: `RHO_AUTO_MEMORY=0` env var |
| — | disabled | Auto-disabled when `RHO_SUBAGENT=1` (avoids noisy extraction from automated runs) |

---

## Configuration

All brain-related settings live in `~/.rho/config.json`:

```json
{
  "autoMemory": true,
  "decayAfterDays": 90,
  "decayMinScore": 3,
  "promptBudget": 2000
}
```

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `autoMemory` | boolean | `true` | Enable auto-memory extraction (also accepts `auto_memory`) |
| `decayAfterDays` | number | `90` | Days without update before a learning is eligible for decay |
| `decayMinScore` | number | `3` | Score threshold — learnings at or above this are exempt from decay |
| `promptBudget` | number | `2000` | Total token budget for the injected brain prompt |

---

## File Locking

All writes to brain.jsonl use file locking (`brain.jsonl.lock`) to prevent corruption from concurrent access (e.g., heartbeat and interactive session writing simultaneously). Both `appendBrainEntry` and `appendBrainEntryWithDedup` acquire the lock before reading or writing.

---

## The `/brain` Command

Quick stats, search, and auto-memory visibility from the TUI:

```
/brain                      # Show stats: counts by type (e.g., "🧠 5L 3P 2T 1R | 11beh 2id 1usr")
/brain stats                # Same as above
/brain search pnpm          # Search all entries for "pnpm"
/brain automemory           # Show recent auto-memory extraction runs
/brain automemory recent 20 # Show last 20 auto-memory runs (max 50)
/brain auto 10              # Shortcut: last 10 runs
```

---

## Memory Maintenance

The **memory-consolidate** skill consolidates memory when it grows large or noisy. It uses `brain action=decay` to archive stale entries, `brain action=remove` to clean up duplicates, mines user sessions since the last consolidation checkpoint, and relocates reference-heavy entries to the vault for ad-hoc search.

---

## Default Brain

New installs start with `brain/brain.jsonl.default`, which seeds:
- 16 behavior entries (do/don't/value directives)
- 1 reminder (daily memory-consolidate at 01:00)
- 1 meta entry (`schema_version: 1`)

The default file is copied to `~/.rho/brain/brain.jsonl` on first run if the file doesn't exist.

---

## Legacy Migration

If you have an older rho install with separate `core.jsonl`, `memory.jsonl`, `context.jsonl`, or `tasks.jsonl` files:

```
/migrate            # Migrate legacy files into unified brain.jsonl
```

This is only for users upgrading from pre-2026 rho installs. New installs use brain.jsonl exclusively. Legacy files are never modified or deleted. A `meta` marker prevents re-running.

---

## Tips: Good vs Bad Memories

**Good learnings** — specific, actionable, useful across sessions:
- "This repo uses pnpm not npm"
- "API uses snake_case for all endpoints"
- "The deploy script requires AWS_PROFILE=prod"

**Bad learnings** — vague, transient, or obvious:
- "User asked about deployment" (session-specific)
- "Fixed a bug in the API" (one-off)
- "TypeScript is a typed language" (obvious)

**Good preferences** — clear choices that affect future behavior:
- "User prefers early returns over nested ifs"
- "Always use fish shell syntax, not bash"

**Bad preferences** — too vague to be useful:
- "User likes clean code" (who doesn't?)
- "Be helpful" (already the default)

The rule of thumb: if a future session with no context would benefit from knowing this, store it. If it only matters right now, don't.
