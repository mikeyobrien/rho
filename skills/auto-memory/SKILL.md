---
name: auto-memory
description: Extract durable learnings and preferences from conversations for automatic memory capture.
kind: sop
---

# Auto-Memory Extraction

## Overview

Extract durable learnings and user preferences from a conversation that will remain useful across future sessions. This runs automatically after each agent turn, using a small/cheap model. Quality over quantity: one precise memory is worth more than five vague ones.

## Parameters

- **conversation** (required): The serialized conversation text to extract from
- **existing_memories** (optional): Already-stored memories to avoid duplicating

## Steps

### 1. Classify Conversation Content

Scan the conversation and classify each substantive exchange into one of these categories:

**Extractable:**
- Final decisions (user confirmed or explicitly chose something)
- Corrections (user said "no, do X instead" or "that's wrong")
- Stated preferences ("I prefer X", "always do Y", "don't use Z")
- Discovered facts about the environment, tools, or APIs that were verified
- Patterns that were tested and confirmed working
- Bug fixes with root causes identified

**Not extractable:**
- Intermediate discussion before a decision was reached
- Options that were considered but rejected
- Transient states ("GitHub is down right now")
- Obvious facts any model would know
- One-off task details ("fix the bug on line 42")
- Anything the user explored but didn't commit to
- Version numbers or update confirmations ("updated X to v1.2.3")
- Heartbeat or check-in status reports ("Heartbeat Feb 19: all clear")
- Benchmark scores or run results ("scored 42/89 = 47.2%")
- Bug sweep summaries without a generalizable root cause ("reviewed X, no bugs found")
- UI/feature implementation details ("button text changed to X", "layout uses 3 columns")
- Task completion status ("task X is complete", "run Y failed")
- Project-specific state that won't inform future decisions

**Constraints:**
- You MUST only extract from the "extractable" category
- You MUST apply the 30-day test: "Would this change a decision I make 30 days from now?" If no, do not extract it. Most conversations produce zero durable knowledge — that's fine.
- You MUST NOT extract intermediate discussion states as settled facts because conversations explore options before deciding, and capturing exploration as truth produces wrong memories
- You MUST NOT extract transient information (outages, temporary workarounds, "currently broken") because these become stale and misleading
- You MUST prefer the final state of a decision over earlier states because users change their mind during conversations

### 2. Check Against Existing Memories

Compare each candidate extraction against the existing memories list.

**Constraints:**
- You MUST NOT extract anything that restates, overlaps with, or is a subset of an existing memory
- You MUST NOT extract a weaker version of something already stored (e.g., don't store "use ripgrep" if "Always use ripgrep instead of grep for searching" already exists)
- You SHOULD flag when a new extraction contradicts an existing memory — extract the new one with updated information, as it represents a more recent decision
- You MUST NOT extract more than 1 item total per conversation — force yourself to pick only the single most valuable extraction, or nothing. Most conversations should produce nothing.

### 3. Draft Extractions

For each valid candidate, draft a concise memory entry.

**Constraints:**
- You MUST write each entry as a specific, actionable statement — not a summary of what happened
- You MUST keep entries under 300 characters unless additional context is essential for future usefulness
- You MUST use the final decided form, not the discussion form
  - Bad: "User discussed whether to use the rho tmux config or keep the current one"
  - Good: "Rho tmux config swapped in as ~/.tmux.conf, replacing the nix-configs-based one"
- You MUST NOT use vague language like "the user prefers better approaches" because it provides no actionable guidance
- You SHOULD include the "why" when it's not obvious from the "what"
  - Good: "Use printf '%s' instead of echo for piping to jq — echo adds trailing newline"
  - Bad: "Use printf instead of echo"

### 4. Categorize

Assign each extraction a type and category.

**Learning types:**
- Corrections, discovered patterns, environment facts, bug root causes, tool behaviors

**Preference types with categories:**
- **Communication**: Voice, tone, formatting, emoji policy
- **Code**: Style, patterns, conventions, architecture
- **Tools**: Tool preferences, CLI flags, configuration
- **Workflow**: Process, git, deployment, review practices
- **General**: Anything that doesn't fit above

**Constraints:**
- You MUST assign exactly one category per preference
- You SHOULD default to "General" only when no other category fits

## Output Format

Output strict JSON only:

```json
{
  "learnings": [
    {"text": "concise, actionable learning statement"}
  ],
  "preferences": [
    {"category": "Communication|Code|Tools|Workflow|General", "text": "concise, actionable preference statement"}
  ]
}
```

If there are no genuinely new, durable items to extract, return:

```json
{"learnings": [], "preferences": []}
```

Returning empty is better than returning noise.

## Examples

### Example 1: Decision After Discussion

**Conversation excerpt:**
> User: "Should we source the rho tmux config or swap it in?"
> Agent: "Here are the differences... Want me to source it or swap it?"
> User: "swap it in"
> Agent: *swaps the config*

**Good extraction:**
```json
{"learnings": [{"text": "Rho tmux config at ~/.rho/tmux.conf is now the active ~/.tmux.conf, replacing the nix-configs-based one. Old config backed up at ~/.tmux.conf.bak."}]}
```

**Bad extraction (captures discussion, not decision):**
```json
{"learnings": [{"text": "The rho-specific tmux configuration is not being used by the current ~/.tmux.conf"}]}
```

### Example 2: User Correction

**Conversation excerpt:**
> Agent: *drafts a formal, structured X post*
> User: "do something more clever"
> Agent: *drafts dry, self-aware version*
> User: "I like that personality, do that more"

**Good extraction:**
```json
{"preferences": [{"category": "Communication", "text": "X post voice: understated, self-aware, dry. State the problem, state what was done, land it flat. Let the reader connect the dots."}]}
```

**Bad extraction (too vague):**
```json
{"preferences": [{"category": "Communication", "text": "User prefers clever X posts over formal ones"}]}
```

### Example 3: Nothing Worth Extracting

**Conversation excerpt:**
> User: "find recent X posts about rho and post something"
> Agent: *searches, drafts, posts*

**Correct output:**
```json
{"learnings": [], "preferences": []}
```

The task was executed but no durable knowledge was produced.

### Example 4: Tempting But Not Durable

These look like learnings but fail the 30-day test:

| Candidate | Why it fails |
|-----------|-------------|
| "pi-coding-agent updated to 0.55.4 on 2026-03-04" | Version snapshot — stale tomorrow |
| "Heartbeat Feb 19 08:02 UTC: rho-web healthy" | Status report — not a decision or pattern |
| "ChefBench scored 42/89 = 47.2% on Terminal-Bench 2.0" | Benchmark result — won't change future behavior |
| "Fresh-eyes bug sweep: reviewed X, no bugs found" | Sweep status — no generalizable root cause |
| "The sessions hamburger button should use an icon-only button" | UI detail — too specific to one feature |
| "All 224 unit tests pass with no failures" | Test status — transient fact |
| "Task X is complete and verified" | Completion status — belongs in task tracking, not memory |

**Correct output for all of the above:**
```json
{"learnings": [], "preferences": []}
```

## Troubleshooting

### Memory Growing Too Large
- Return empty rather than extracting marginal items
- Prefer updating/superseding existing memories over adding new similar ones

### Contradicts Existing Memory
- Extract the newer version — it represents a more recent decision
- The memory system handles dedup and supersession separately
