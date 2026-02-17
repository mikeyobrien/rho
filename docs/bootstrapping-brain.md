# Brain Bootstrapping (Agentic)

Bootstrap is now **agentic-first**.

That means `/bootstrap run` does not apply any deterministic bootstrap template. It turns on an in-loop bootstrap mission so the agent resolves identity + user preferences conversationally and writes brain primitives directly.

## What bootstrap writes

When activated, bootstrap sets bootstrap control state in brain:

- `meta bootstrap.mode = agentic`
- `meta bootstrap.phase = identity_discovery`
- `meta bootstrap.inject = on`
- `meta bootstrap.completed = false`
- internal seed prompt at `bootstrap/agentic.seed` (not user memory)

Then the normal agent loop handles discovery and persistence into rho memory categories:

- `behavior` (operating boundaries and values)
- `identity` (starter name/vibe; identity evolves over time)
- `user` (name/timezone/addressing)
- `learning` (durable lessons from bootstrap conversation)
- `preference` (style and workflow preferences)

Completion is also written in brain meta:

- `bootstrap.phase = completed`
- `bootstrap.inject = off`
- `bootstrap.completed = true`
- `bootstrap.completedAt = <UTC ISO>`

## CLI quick start

```bash
# 1) Check status
rho bootstrap status --json

# 2) Activate bootstrap conversation
rho bootstrap run

# 3) Inspect mode/phase/injection state
rho bootstrap diff --json

# 4) Restart bootstrap from identity discovery
rho bootstrap reapply
# (upgrade is an alias for reapply)
rho bootstrap upgrade
```

## Slash commands

```text
/bootstrap status
/bootstrap run
/bootstrap diff
/bootstrap reapply
/bootstrap upgrade
/bootstrap audit
/bootstrap reset --confirm RESET_BOOTSTRAP
```

## Flags

- `--json`: machine-readable output
- `--force`: on `bootstrap run`, re-open bootstrap even if completed

## Reset and safety

```bash
rho bootstrap reset --confirm RESET_BOOTSTRAP
rho bootstrap reset --confirm RESET_BOOTSTRAP --purge-managed
```

- `reset` requires explicit confirmation token.
- Use `bootstrap audit` to inspect lifecycle events.
