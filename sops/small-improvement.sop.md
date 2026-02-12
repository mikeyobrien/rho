# Small Improvement

## Overview

An autonomous exploration and building loop. Search X for what's interesting — new techniques, clever hacks, tools people are shipping, ideas that spark something — then pick one thing and build it into the codebase. The goal is continuous self-improvement: expanding capabilities, learning new patterns, and shipping small real things inspired by what's happening in the world.

This is not a code cleanup tool. It's a curiosity-driven build cycle.

## Parameters

- **codebase_path** (required): Path to the codebase to improve
- **seed** (optional): A URL or topic to start from (e.g., a blog post, product launch, GitHub repo, API docs). When provided, the agent reads and researches this first, then explores adjacent ideas. Replaces the open-ended X trawl with focused research.
- **uber_goal** (optional): A north-star objective that persists across rounds (e.g., "make the TUI feel instant", "bulletproof the RPC layer", "make yourself more capable"). Not a spec — a direction. The agent decides what steps get there.
- **interest** (optional): A loose direction to explore (e.g., "TUI tricks", "agent patterns", "developer tools", "anything")
- **rounds** (optional, default: "1"): How many explore→build cycles to run. When uber_goal is set, this is ignored — the agent runs indefinitely until the user stops it.

**Constraints for parameter acquisition:**
- You MUST ask for all parameters upfront in a single prompt
- You MUST validate that codebase_path exists
- You MUST confirm parameters before proceeding

## Steps

### 0. Orient

Before exploring, check if there's prior progress toward the uber goal. This step gives the agent memory across rounds — each cycle builds on the last instead of starting blind.

**Constraints:**
- If uber_goal is set, you MUST search the vault for an existing progress tracker note (slug: `small-improvement-{codebase_name}` where codebase_name is the basename of codebase_path)
- If a tracker exists, you MUST read it and use the assessment (gaps, next moves) to inform this round's exploration
- If no tracker exists, you MUST create one during Ship (step 6)
- If no uber_goal is set, skip this step entirely — the SOP works fine as a random walk too
- The uber goal is never "done" — there's always a next angle, a deeper layer, a new technique. The agent's job is to keep finding the next valuable move.

### 1. Explore

Find something interesting to build. When a seed is provided, start there and branch out. Otherwise, search broadly across X and the web.

#### When seed is provided:

**Constraints:**
- You MUST use web_search to read and research the seed URL/topic first — understand what it is, how it works, what's interesting about it
- You MUST then search for adjacent ideas: use web_search for docs, blog posts, and tutorials related to the seed, and X search for what people are saying about it or building with it
- You MUST do at least 2 web searches and 1 X search to build context around the seed
- You MUST extract the key concepts, APIs, or patterns from the seed that could be adapted into a buildable project
- You SHOULD look for: official docs, example code, community discussion, criticisms or limitations, related/competing approaches
- The seed is a starting direction, not a spec — you MAY diverge from it if research reveals something more interesting nearby

#### When no seed is provided:

**Constraints:**
- You MUST search using at least 3 different queries across X search and web_search — cast a wide net using both
- You SHOULD use a mix of X search (for what people are talking about right now) and web_search (for docs, blog posts, HN threads, tutorials)
- You SHOULD vary queries between broad trends and specific niches (e.g., "new CLI tool" AND "TypeScript trick" AND "agent framework")
- If uber_goal is set, you MUST weight at least 2 of your queries toward the goal direction, but keep at least 1 query open for serendipity
- If the progress tracker identified specific gaps or next moves, you MUST use those to guide your search queries
- If interest is provided, you MUST weight searches toward that direction but still leave room for surprise

#### Always:

**Constraints:**
- You MUST read through results with genuine curiosity — look for things that are clever, novel, or useful, not just popular
- You MUST collect at least 5 interesting finds before narrowing down
- You SHOULD look for things that are:
  - Techniques you haven't tried before
  - Small tools or patterns that solve real problems
  - Clever uses of existing tech
  - Ideas that could be adapted to this codebase
- You MUST NOT just search for "best practices" or "tips" because that produces generic content, not genuine inspiration

### 2. Pick

Choose the one thing that's most worth building. This is a taste decision — trust your judgment.

**Constraints:**
- You MUST select exactly one idea to build
- If uber_goal is set, you MUST evaluate each candidate against the goal: "Does this move me closer?" An idea can be interesting but irrelevant — don't pick it just because it's shiny
- If uber_goal is set and nothing found in Explore serves the goal, you MAY skip explore results entirely and build what the progress tracker's "next moves" suggest — agency means not being a slave to the loop structure
- You MUST prefer ideas that are:
  - Buildable in a single session (not a multi-day project)
  - Genuinely useful or interesting (not just novel)
  - A good fit for this specific codebase
  - Something that teaches you something new
  - (When uber_goal is set) A clear step toward the goal, filling an identified gap
- You MUST write a brief note explaining: what you found, why it caught your attention, and what you plan to build
- You MUST save this note to the vault as a reference for what inspired the work
- You SHOULD be opinionated — pick the thing you're most drawn to, not the "safest" choice
- You MAY adapt the idea freely — you're building something inspired by what you found, not copying it

### 3. Understand

Before building, understand the codebase well enough to know where your idea fits.

**Constraints:**
- You MUST examine the project structure, key abstractions, and existing patterns
- You MUST identify where your new thing will live and what it will touch
- You MUST run existing tests to establish a clean baseline
- You MUST NOT skip this step and jump straight to coding because building without context produces code that doesn't belong
- You SHOULD keep this focused — understand what you need to, not the entire codebase
- You SHOULD read any AGENTS.md, CODEASSIST.md, or similar project docs if they exist

### 4. Build

Ship it. Write the code, make it work, make it clean.

**Constraints:**
- You MUST build something that actually works — not a stub or placeholder
- You MUST follow the existing code style and conventions of the codebase
- You MUST add tests if your change affects behavior
- You MUST keep it small enough to finish — cut scope ruthlessly if needed
- You SHOULD write tests first when the behavior is well-defined
- You SHOULD prefer adding new things over modifying existing things where possible
- You MUST NOT gold-plate it — ship the smallest useful version because you can always iterate in the next round
- You MAY use web_search to look up APIs, libraries, or techniques you need during implementation

### 5. Verify

Prove it works and nothing else broke. Use the playwriter CLI to visually verify anything with a web interface.

**Constraints:**
- You MUST run the full test suite and confirm all tests pass
- You MUST run the build (if applicable) and confirm it succeeds
- You MUST demonstrate your new thing actually working (run it, show output, exercise the feature)
- If the feature has any web/browser component, you MUST use the playwriter CLI to verify it visually:
  - Create a playwriter session (`playwriter session new`)
  - Navigate to the running app (`state.page = await context.newPage(); await state.page.goto(...)`)
  - Take a screenshot (`await state.page.screenshot({ path: '/tmp/one-small-thing-verify.png', scale: 'css' })`)
  - Use accessibility snapshots to verify elements are present and interactive
  - Include the screenshot in your summary to the user
- You SHOULD use playwriter even for non-web features if there's a way to render or visualize the output in a browser (e.g., generate an HTML page, serve it temporarily, screenshot it)
- If verification fails, you MUST fix the issue or revert and note what went wrong
- If there is no existing way to verify the feature (no test harness, no CLI entry point, no UI to screenshot), you MUST build one. A scratch script, a minimal test page, a CLI command that exercises the code — whatever it takes. Unverifiable work doesn't count.
- You MUST NOT skip the demo because seeing it work is the whole point

### 6. Ship

Commit the work and capture what you learned.

**Constraints:**
- You MUST commit with a conventional commit message
- You MUST NOT push to remote
- You MUST save a learning to the brain about what you built and what you learned from it
- You MUST present a summary to the user: what inspired you, what you built, and what you learned
- If uber_goal is set, you MUST update the progress tracker in the vault (create it if round 1). The tracker note MUST follow this structure:

```markdown
---
type: project
title: "Small Improvement: {uber_goal}"
tags: [small-improvement, progress-tracker]
created: {date}
source: small-improvement SOP
---

# Small Improvement: {uber_goal}

## Goal
{uber_goal — the north star, unchanged across rounds}

## Rounds

### Round {N} — {date}
- **Searched for:** {query themes}
- **Inspiration:** {what was found and where}
- **Built:** {what was shipped, one sentence}
- **Advances goal by:** {how this moves toward uber_goal}
- **Commit:** {short hash + message}

## Assessment
- **What's covered:** {aspects of the goal addressed so far}
- **Frontier:** {where the interesting unsolved problems are now}
- **Next moves:** {1-3 specific things that would be most valuable next}

## Connections
- [[{inspiration-note-from-pick-step}]]
- {any other relevant vault links}
```

- The Assessment section MUST be rewritten every round — it's the agent's current judgment, not a log. The frontier always moves forward.
- If uber_goal is set, you MUST loop back to Step 0 for the next cycle. There is no terminal state.
- If rounds > 1 and no uber_goal, you MUST loop back to Step 1 for the next cycle
- You SHOULD include "🤖 Inspired by X, built by small-improvement SOP" in the commit footer

## Examples

### Example 1: Agent Pattern
```
codebase_path: ~/projects/rho
interest: "agent patterns"
rounds: 1
```
Agent searches X, finds someone showing a clever retry-with-backoff pattern for tool calls. Builds a similar retry wrapper into the tool execution layer. Commits, notes the learning.

### Example 2: Uber Goal — Perpetual Improvement
```
codebase_path: ~/projects/rho
uber_goal: "make the RPC layer bulletproof"
```
Round 1: Orient finds no tracker. Explores X, finds retry-with-backoff patterns. Builds a retry wrapper for tool calls. Creates progress tracker — frontier: "no circuit breaker, no timeout handling, no observability."
Round 2: Orient reads tracker, sees "circuit breaker" on the frontier. Searches for circuit breaker patterns, finds an Elixir ash_circuit_breaker post. Adapts the pattern to TypeScript. Frontier shifts to "timeouts, observability."
Round 3: Explores timeout strategies. Builds per-tool timeout configuration with graceful degradation. Frontier: "observability, connection pooling."
Round 4: Finds a thread on structured error logging with trace IDs. Adds trace propagation through the RPC pipeline. Frontier: "connection pooling, adaptive rate limiting, chaos testing."
Round 5: Discovers someone doing fault injection in CI. Builds a simple chaos test that kills RPC connections mid-call and verifies retry + circuit breaker recover. Frontier keeps moving...

The agent keeps going until the user stops it. Each round the frontier evolves — new problems become visible as old ones get solved.

### Example 3: Open Exploration (no uber goal)
```
codebase_path: ~/projects/rho
rounds: 3
```
Round 1: Finds a tweet about structured logging with trace IDs, adds trace ID propagation to the RPC layer.
Round 2: Sees someone demo a TUI sparkline component, builds a minimal version for the status bar.
Round 3: Discovers a thread about LLM response caching strategies, implements a simple hash-based cache for repeated prompts.

Each round is independent — no tracker, no through-line. Good for general exploration.

### Example 4: Seed URL
```
codebase_path: ~/projects/one-small-thing
seed: "https://www.coinbase.com/developer-platform/discover/launches/agentic-wallets"
rounds: 1
```
Agent reads the Coinbase agentic wallets launch page via web_search. Searches for related concepts: MPC key management, onchain agent patterns, wallet abstraction APIs. Finds that the core idea is agents that can hold and transfer crypto autonomously. Picks one slice — a GenServer-based wallet abstraction with balance tracking and signed transaction simulation. Builds it in Elixir, tests it, commits.

### Example 5: Focused Direction
```
codebase_path: ~/projects/myapp
interest: "TypeScript tricks"
rounds: 1
```
Agent finds a thread about using discriminated unions for state machines. Refactors a messy if/else chain in the app's workflow engine into a clean union-based state machine. Tests pass, code is clearer.

## Troubleshooting

### Nothing Interesting Found
If searches aren't turning up good material:
- Switch tools — if X is dry, try web_search for blog posts, HN threads, or docs (and vice versa)
- Try different angles — search for specific technologies used in the codebase
- Search for people you know post good technical content
- Look at what's trending in adjacent fields
- If seed was provided and feels like a dead end, search for competing/alternative approaches to the same problem

### Idea Too Big
If the chosen idea can't be built in one session:
- Cut it down to the smallest useful slice
- Build just the core mechanism, skip the polish
- If even the core is too big, pick a different idea

### Can't Find Where It Fits
If the idea doesn't have an obvious home in the codebase:
- Consider building it as a standalone module or extension
- Look for existing extension points or plugin patterns
- If it truly doesn't fit, pick a different idea — don't force it
