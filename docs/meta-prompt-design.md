# Meta Prompt Injection Design

## Problem

Rho's runtime context is currently split across:
- `AGENTS.md` — static file with hardcoded OS, arch, paths, tenets
- `brain.jsonl` — behaviors, learnings, preferences, identity, context
- `before_agent_start` — appends brain prompt to system prompt

The agent has no **dynamic** awareness of its runtime environment. Everything in AGENTS.md is hardcoded and breaks on different platforms.

## Proposed Solution

Build a `buildMetaPrompt()` function that dynamically generates runtime context and inject it alongside the brain prompt in `before_agent_start`.

### Meta Prompt Sections

```markdown
## Runtime

- **Agent**: rho (from init.toml [agent].name)
- **OS**: Android 14 / Termux 0.118.3 (or Linux 6.x / Ubuntu 24.04, etc.)
- **Arch**: aarch64
- **Shell**: bash
- **Home**: /data/data/com.termux/files/home
- **CWD**: /data/data/com.termux/files/home/.rho
- **Brain**: ~/.rho/brain/brain.jsonl
- **Vault**: ~/.rho/vault (139 notes)

## Capabilities

- **Extensions**: rho, brave-search, vault-search, x-search, email, agent-sop, review, usage-bars, memory-viewer, moltbook-viewer
- **Skills**: memory-clean, session-search, update-pi, vault-clean, soul-update, rho-cloud-email, rho-cloud-onboard
- **Heartbeat**: enabled, 30m interval, leader (PID 12345), next check in 14m
- **Tools**: brain, vault, vault_search, rho_control, rho_subagent, email, review, web_search, x_search

## Session

- **Model**: anthropic/claude-sonnet-4-20250514
- **Thinking**: high
- **Mode**: interactive (or subagent/heartbeat/print)
- **Context**: 42% used
```

### Implementation

1. **`buildMetaPrompt(ctx: ExtensionContext): string`** — pure function, generates the markdown
2. Detect OS/platform dynamically (`os.platform()`, `os.release()`, check for Termux via `$PREFIX`)
3. List loaded extensions and skills from `ctx` (if exposed) or from init.toml
4. Include heartbeat state (enabled/disabled, interval, leader/follower)
5. Include vault stats (note count)
6. Include session info (model, thinking level, mode)

### Injection Point

In `before_agent_start`, prepend the meta prompt before the brain prompt:

```typescript
pi.on("before_agent_start", async (event, ctx) => {
  const metaPrompt = buildMetaPrompt(ctx, hbState, vaultGraph);
  
  if (isBrainCacheStale()) {
    rebuildBrainCache(currentCwd);
  }

  const sections = [metaPrompt, cachedBrainPrompt].filter(Boolean);
  if (sections.length > 0) {
    return { systemPrompt: event.systemPrompt + "\n\n" + sections.join("\n\n") };
  }
});
```

### What This Replaces

The static `AGENTS.md` environment section:
```markdown
## Environment
- **OS**: Android / Termux (dev)    ← hardcoded
- **Arch**: aarch64                  ← hardcoded
- **Shell**: bash                    ← hardcoded
- **Home**: /data/data/...           ← hardcoded
- **Brain**: ~/.rho/brain/brain.jsonl ← hardcoded
```

The tenets/anti-patterns/work-patterns in AGENTS.md should move to brain.jsonl `behavior` entries or stay in AGENTS.md as static guidance. The runtime context becomes dynamic.

### Caching

Cache the meta prompt and invalidate on:
- Heartbeat state changes (enable/disable, interval, leader takeover)
- Vault graph rebuild
- Model switch (Ctrl+P)
- Session mode change

Most of this is stable within a session, so caching is straightforward.

### Budget

Meta prompt is ~300-400 tokens. Add it to the prompt budget accounting alongside brain prompt.
