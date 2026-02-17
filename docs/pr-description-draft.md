# PR Description Draft

## Title

`feat(bootstrap): make bootstrap fully agentic with in-loop identity discovery and meta-gated injection`

## Summary

This PR removes deterministic/bootstrap-pack behavior and makes bootstrap fully **agentic**.

`/bootstrap run` now activates a conversation-driven bootstrap flow in the normal agent loop by writing bootstrap meta/context state into brain. The agent then resolves identity, user profile, and behavior/preferences in-session.

## What changed

### Bootstrap model
- Removed deterministic profile-pack planning/apply logic.
- Bootstrap activation now writes:
  - `bootstrap.mode=agentic`
  - `bootstrap.phase=identity_discovery`
  - `bootstrap.inject=on`
  - `bootstrap.completed=false`
  - `context bootstrap/agentic.seed` mission prompt

### Runtime injection
- Added meta-gated bootstrap prompt injection in `before_agent_start`.
- Injection is active only while bootstrap is agentic + not completed.
- Completion criteria use brain meta updates (`phase=completed`, `inject=off`, `completed=true`, `completedAt`).

### Command behavior
- `bootstrap run`: activate/reopen agentic bootstrap.
- `bootstrap reapply`: restart identity discovery.
- `bootstrap upgrade`: alias restart behavior (agentic).
- `bootstrap diff`: report agentic state (mode/phase/inject), not merge plans.
- `bootstrap status`: includes bootstrap id/mode/phase/active injection + managed entries.

### Slash bridge
- Removed forced `--non-interactive` behavior.
- Updated `/bootstrap status` and `/bootstrap diff` notifications for agentic state.

### Cleanup
- Removed deterministic bootstrap modules and deterministic bootstrap tests.
- Updated docs and feature spec to match agentic model.
- Renamed revision language from `pa-vN` to `agentic-vN`.

## Testing

```bash
npx tsx tests/test-brain-bootstrap-schema.ts
npx tsx tests/test-brain-bootstrap-state.ts
npx tsx tests/test-bootstrap-command.ts
npx tsx tests/test-bootstrap-slash.ts
```

All passing.

## Backward compatibility

- Existing user brain data is preserved.
- Reset remains explicitly gated by confirmation token.
- Bootstrap now consistently uses agentic resolution instead of deterministic merge/apply behavior.
