# Brain

The brain is Rho's persistent memory system. It lives as a single append-only event log at `~/.rho/brain/brain.jsonl` and carries context across sessions so the agent doesn't start from zero every time.

When a session starts, Rho reads brain.jsonl, folds the entries (applying updates and tombstones), builds a budgeted prompt, and injects it into the system prompt. The agent sees your identity, behavioral guidelines, past learnings, preferences, tasks, and reminders — all without you repeating yourself.

## File Structure

```
~/.rho/brain/
└── brain.jsonl              # Single source of truth — all entry types
```

The file is newline-delimited JSON — one entry per line, append-only. Updates and deletions are represented as new entries that supersede earlier ones (event sourcing).

## Entry Types

### behavior

Behavioral directives — the agent's personality layer. Categories: `do`, `dont`, `value`.

```json
{"id":"b-1","type":"behavior","category":"do","text":"Be direct — skip filler, get to the point","created":"2026-01-01T00:00:00.000Z"}
{"id":"b-6","type":"behavior","category":"dont","text":"Use performative phrases like 'Great question!'","created":"2026-01-01T00:00:00.000Z"}
{"id":"b-9","type":"behavior","category":"value","text":"Clarity over diplomacy","created":"2026-01-01T00:00:00.000Z"}
```

### identity

Key-value pairs describing the agent itself. Keyed — later entries with the same key overwrite earlier ones.

```json
{"id":"id-1","type":"identity","key":"name","value":"rho","created":"2026-01-01T00:00:00.000Z"}
{"id":"id-2","type":"identity","key":"role","value":"A persistent coding agent with memory and heartbeat","created":"2026-01-01T00:00:00.000Z"}
```

### user

Key-value pairs describing the user. Keyed — later entries with the same key overwrite earlier ones.

```json
{"id":"u-1","type":"user","key":"timezone","value":"US/Central","created":"2026-01-15T00:00:00.000Z"}
{"id":"u-2","type":"user","key":"editor","value":"Neovim","created":"2026-01-20T00:00:00.000Z"}
```

### learning

Facts, patterns, and conventions the agent discovers. Subject to decay.

```json
{"id":"a1b2c3d4","type":"learning","text":"This repo uses pnpm not npm","source":"auto","created":"2026-01-15T00:00:00.000Z"}
```

Learnings are ranked by a score based on reinforcement count, recency, and age. The prompt includes the highest-scoring learnings first, within the budget.

### preference

Explicit user choices, organized by category. Categories: `Communication`, `Code`, `Tools`, `Workflow`, `General`.

```json
{"id":"e5f6g7h8","type":"preference","category":"Code","text":"User prefers early returns over nested ifs","created":"2026-01-20T00:00:00.000Z"}
```

Preferences **don't decay**. They represent deliberate user intent and stick around until manually removed.

### context

Project-specific context, matched by working directory path.

```json
{"id":"ctx-1","type":"context","project":"rho","path":"/home/user/projects/rho","content":"TypeScript monorepo. Use pnpm. Extensions in extensions/.","created":"2026-01-01T00:00:00.000Z"}
```

When your cwd is inside a matching path, the project context is included in the prompt.

### task

Lightweight task queue items, surfaced during heartbeat check-ins.

```json
{"id":"t-abc1","type":"task","description":"Fix the flaky test in CI","status":"pending","priority":"high","due":"2026-02-15","tags":["code","ci"],"created":"2026-02-10T00:00:00.000Z"}
```

Status: `pending` or `done`. Priority: `urgent`, `high`, `normal`, `low`.

### reminder

Recurring or scheduled items that the heartbeat acts on.

```json
{"id":"r-def2","type":"reminder","text":"Run backup script","cadence":{"kind":"interval","every":"6h"},"enabled":true,"priority":"normal","tags":["ops"],"last_run":"2026-02-10T12:00:00.000Z","next_due":"2026-02-10T18:00:00.000Z","created":"2026-02-01T00:00:00.000Z"}
```

Cadence types: `{"kind":"interval","every":"2h"}` or `{"kind":"daily","at":"08:00"}`.

### tombstone

Marks an entry as removed. The original entry stays in the file; the tombstone prevents it from appearing in the folded state.

```json
{"id":"a1b2c3d4","type":"tombstone","reason":"Superseded by newer learning","created":"2026-02-10T00:00:00.000Z"}
```

### meta

Metadata markers for system state (e.g., migration tracking).

```json
{"id":"meta-1","type":"meta","key":"migration.v2","value":"done","created":"2026-02-10T00:00:00.000Z"}
```

## The `brain` Tool

The agent uses this tool programmatically during conversations. All persistent memory operations go through it.

### Actions

| Action | Description |
|--------|-------------|
| `add` | Add a new entry (requires `type` + type-specific fields) |
| `update` | Update an existing entry by ID (merges provided fields) |
| `remove` | Tombstone an entry (requires `id`, optional `reason`) |
| `list` | List entries, optionally filtered by `type`, `query`, `filter`, `scope` |
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
brain action=add type=reminder text="Run backup script" cadence={"kind":"interval","every":"6h"} priority=normal
```

**Update an entry:**
```
brain action=update id=a1b2c3d4 text="This repo uses pnpm (not npm or yarn)"
```

**Remove an entry:**
```
brain action=remove id=a1b2c3d4 reason="No longer accurate"
```

**List all learnings:**
```
brain action=list type=learning
```

**Search entries:**
```
brain action=list query=pnpm
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
brain action=task_done id=t-abc1
```

**Clear completed tasks:**
```
brain action=task_clear
```

**Record reminder execution:**
```
brain action=reminder_run id=r-def2 result=ok
```

## How the Brain Prompt Is Built

At session start (and before each agent turn if the file has changed), the brain is read and folded into a prompt:

1. **Read**: Parse all lines from brain.jsonl
2. **Fold**: Apply event sourcing — later entries for the same `id` overwrite earlier ones; tombstones remove entries; keyed types (identity, user) deduplicate by key
3. **Build prompt**: Assemble sections in this order:
   - **Identity** — key-value pairs
   - **User** — key-value pairs
   - **Behaviors** — grouped by category (do/don't/values)
   - **Learnings** — ranked by score, top N within budget
   - **Preferences** — grouped by category
   - **Context** — project-specific, matched by cwd
   - **Tasks** — pending tasks summary
   - **Reminders** — active reminders summary
4. **Budget**: The total prompt is capped at `prompt_budget` tokens (default 2000). Learnings are ranked by score and trimmed to fit. Other sections are included in full.

### Learning Ranking

Learnings are scored to determine which ones make the cut:

- **Reinforcement count**: Each `update` that bumps `used` adds to the score
- **Recency**: More recently used learnings score higher
- **Age bonus**: Older learnings that are still being used get a small boost

The highest-scoring learnings are included first until the budget is exhausted.

## Memory Decay

Learnings that go unused get removed automatically:

- After **90 days** without being reinforced, a learning is tombstoned (configurable via `decay_after_days`)
- Learnings with a score of **3+** are exempt from decay regardless of age (configurable via `decay_min_score`)
- **Preferences never decay** — they're explicit user choices

Trigger decay manually with `brain action=decay`, or let the heartbeat handle it.

## Auto-Memory Extraction

Rho automatically extracts memories from conversations. At the end of each session (or during context compaction), a small model analyzes the conversation and pulls out durable learnings and preferences.

How it works:

1. The conversation is serialized and sent to a cheap model (smallest available from the same provider)
2. The model extracts up to 3 new items per pass, each under 200 characters
3. Duplicates are detected and skipped via dedup check before appending
4. Existing memories are sent as context so the model avoids restating known facts
5. Stored items appear as a notification

### Configuration

- **Enabled by default.** Disable with `RHO_AUTO_MEMORY=0` or in config
- **Disabled for subagents** (`RHO_SUBAGENT=1`) to avoid noisy extraction from automated runs

## The `/brain` Command

Quick stats and search from the command line:

```
/brain              # Show stats: counts by type
/brain stats        # Same as above
/brain search pnpm  # Search all entries for "pnpm"
```

## The `/migrate` Command

Migrate legacy brain files (core.jsonl, memory.jsonl, context.jsonl, tasks.jsonl) into the unified brain.jsonl:

```
/migrate            # Run migration, deduplicating against existing entries
```

Legacy files are never modified or deleted. A `meta` marker prevents re-running.

## Memory Maintenance

The **memory-clean** skill consolidates memory when it grows large or noisy. It uses `brain action=decay` to archive stale entries and `brain action=remove` to clean up duplicates.

## Migration from Legacy Format

If you're upgrading from the old multi-file brain format:

1. **Detection**: At session start, Rho checks for legacy files (core.jsonl, memory.jsonl, context.jsonl, tasks.jsonl) alongside brain.jsonl
2. **Notification**: If legacy files exist and haven't been migrated, you'll see a notification
3. **Run `/migrate`**: This reads all legacy files, deduplicates against existing brain.jsonl entries, and appends migrated entries with `source: "migration"`
4. **Verify**: Run `/brain stats` to confirm entry counts

Legacy files are **never modified or deleted**. You can safely run migration multiple times — it's idempotent.

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
