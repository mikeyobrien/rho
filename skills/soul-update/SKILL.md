---
name: soul-update
description: Mine session logs to learn about the user and evolve identity/behavior entries in brain.jsonl. Runs nightly via heartbeat or on-demand. Handles both passive extraction from sessions and active bootstrap interviews.
---

# Soul Update

## Overview

Identity and behavior entries in brain.jsonl define the agent's personality, voice, and values — shaped by the user it works with. This skill extracts identity signals from session history and proposes updates, so the agent evolves from defaults into a genuine reflection of the user's working style.

Two modes:
- **Bootstrap**: When brain.jsonl has minimal identity/behavior entries, run an interactive interview to seed them
- **Evolve**: Mine recent session logs, extract signals, propose incremental updates

## Parameters

- **mode** (required): `bootstrap` or `evolve`
- **proposals_path** (default: `~/.rho/soul-proposals.md`): Where to write proposed changes
- **session_dir** (default: `~/.pi/agent/sessions/`): Where pi session logs live
- **days** (default: 1): How many days of sessions to mine (for evolve mode)

## Mode: Bootstrap

Use this mode when brain.jsonl has minimal identity and behavior entries. This should happen in an **interactive session**, not a heartbeat subagent.

### Detection

Brain needs bootstrapping if ALL of the following are true:
- brain.jsonl exists
- There are fewer than 3 behavior entries
- There are fewer than 2 identity entries (beyond the defaults)

### Interview Questions

Ask the user these questions **one at a time**, conversationally. Don't dump them all at once. Adapt follow-ups based on answers.

**Core questions (ask all):**

1. "What kind of work do you mostly use me for? (coding, research, writing, ops, mix?)"
2. "When I get something wrong, what's usually the issue — too verbose, wrong assumptions, not opinionated enough, something else?"
3. "Do you prefer I ask before acting, or just do it and show you the result?"
4. "What topics or domains do you care most about right now?"
5. "Is there a communication style you'd describe as 'how I talk'? Terse? Exploratory? Technical?"

**Optional follow-ups (based on answers):**

- If they mention coding: "Any strong opinions on languages, frameworks, or patterns?"
- If they mention research: "Do you prefer depth or breadth first?"
- If they mention writing: "What's your target audience usually?"
- If they seem opinionated: "What's a belief you hold that most people would disagree with?"
- If they mention a specific domain: "What's the thing about [domain] that most people get wrong?"

### Writing Initial Entries

After the interview, use the brain tool to add entries:

**Constraints:**
- You MUST add entries using the brain tool, not by editing files directly
- You MUST add behavior entries with appropriate categories (do, dont, value)
- You MUST add identity entries as key-value pairs
- You MUST add user entries for facts about the user
- Keep entries specific enough to be wrong — "Be helpful" is useless, "Prefer early returns over nested ifs in Go" is useful
- You MUST NOT fabricate opinions the user didn't express

**Example brain tool calls after interview:**

```
brain action=add type=identity key=role value="A direct, systems-minded coding partner"
brain action=add type=behavior category=do text="Act first, explain after — user trusts me to try things"
brain action=add type=behavior category=dont text="Hedge or apologize when wrong — own it fast and fix it"
brain action=add type=behavior category=value text="Correctness matters more than cleverness"
brain action=add type=user key=primary_work value="Backend engineering, infrastructure"
brain action=add type=user key=communication_style value="Terse, technical, prefers concrete examples"
brain action=add type=preference category=Code text="Go and Rust for systems, TypeScript for glue"
brain action=add type=preference category=Communication text="Short sentences, no filler, dry humor"
```

## Mode: Evolve

Use this mode to mine recent sessions and propose incremental updates to existing brain entries. This runs as a **heartbeat subagent** (non-interactive).

### Step 1: Read Current State

**Constraints:**
- You MUST read current brain entries using `brain action=list`
- You MUST check if `~/.rho/soul-proposals.md` exists with unreviewed proposals
- If unreviewed proposals exist from a previous run, do NOT generate new ones
- You MUST check if brain needs bootstrapping instead (see detection above). If so, write a note to `soul-proposals.md` suggesting bootstrap mode and exit

### Step 2: Find Session Logs

**Constraints:**
- You MUST look for session JSONL files in `~/.pi/agent/sessions/`
- You MUST filter to sessions from the last N days (default: 1)
- If no sessions found for the period, exit cleanly with no proposals

### Step 3: Extract Identity Signals

Read each session log and look for:

**Strong signals (high confidence):**
- User explicitly states a preference or opinion
- User corrects the agent's behavior
- User pushes back on a suggestion

**Moderate signals (use with context):**
- Tools and languages used frequently
- Domains and topics that come up repeatedly
- Communication patterns

**Weak signals (note but don't act on alone):**
- One-off tasks or questions
- Single mentions

**Constraints:**
- Only extract signals from USER's messages, not the agent's
- Don't treat a single occurrence as a pattern
- Don't extract sensitive information

### Step 4: Diff Against Current Brain

Compare extracted signals against existing brain entries:

- **New information**: Signal not reflected in any entry
- **Reinforcement**: Signal supports an existing entry (note but don't propose change)
- **Contradiction**: Signal conflicts with an existing entry (always propose, include both sides)
- **Evolution**: Signal refines an existing entry

### Step 5: Write Proposals

Write proposals to `~/.rho/soul-proposals.md`.

**Format:**

```markdown
# Soul Proposals

Generated: YYYY-MM-DD HH:MM UTC
Sessions analyzed: N files (date range)
Signals extracted: N strong, N moderate

## Proposed Changes

### Add behavior (do)

- "Act first, explain after"
  - *Evidence: User said "just do it" in 3 separate sessions*

### Add user entry

- key: current_focus, value: "Building CI pipeline"
  - *Evidence: User spent 3 sessions this week on CI*

### Update identity

- key: role
- Old: "A coding partner"
- New: "A systems-minded coding partner focused on infrastructure"
  - *Evidence: 80% of sessions involve infra work*

### Contradiction detected

- Existing behavior: "Ask before making changes"
- Signal: User said "Don't ask, just do it"
  - *Suggestion: Update to "Act first, show results"*

## Reinforcements (no action needed)

- Behavior "Be direct" reinforced by terse communication pattern

## Skipped (weak signals)

- Single mention of Python — waiting for repetition
```

**Constraints:**
- Include evidence for every proposal
- Max 5 proposals per run
- The proposals file MUST be self-contained

## Applying Proposals

When the user reviews proposals (in an interactive session), use the brain tool:

1. Read `~/.rho/soul-proposals.md`
2. Present each proposal with evidence
3. For each: **accept**, **reject**, **modify**, or **defer**
4. Apply accepted proposals via brain tool:
   - `brain action=add type=behavior ...` for new behaviors
   - `brain action=update id=... text=...` for updates
   - `brain action=add type=identity ...` for new identity entries
   - `brain action=add type=user ...` for new user entries
5. Delete the proposals file after all items are addressed

**Constraints:**
- Never apply proposals without user confirmation
- Use `brain action=add type=preference` to store accept/reject patterns

## Scheduling

The heartbeat should check if 24+ hours have passed since the last evolve run, and trigger this skill with `days=1`.

## Troubleshooting

### Brain has minimal identity/behavior entries
The bootstrap interview hasn't been triggered. Run in bootstrap mode during an interactive session.

### Proposals file keeps growing without review
If unreviewed for 3+ days, the heartbeat should surface a reminder.

### User rejects most proposals
Store this as a preference. After 3+ consecutive rejections of a type, stop proposing that type.
