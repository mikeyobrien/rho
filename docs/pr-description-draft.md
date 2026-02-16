# PR Description Draft

## Title

`feat(bootstrap): brain-native personal assistant onboarding, profile packs, merge-safe upgrades, and slash parity`

## Summary

This PR adds a full **brain-native bootstrap** system so Rho can onboard and operate like a personal assistant using memory primitives instead of markdown bootstrap dependencies.

It includes:

- bootstrap schema/state primitives
- onboarding validation + mapping
- versioned profile packs (`pa-v1`, `pa-v2`)
- merge-safe reapply/upgrade behavior
- CLI lifecycle commands (`rho bootstrap ...`)
- slash parity (`/bootstrap ...`)
- audit/status observability
- docs + BDD/TDD coverage

## Why

Rho needs a safe, repeatable way to personalize assistant behavior for both new and existing users while preserving user edits and avoiding brittle prompt-only bootstrap patterns.

## What changed

### Core bootstrap primitives
- Added bootstrap schema validation + managed metadata utilities.
- Added bootstrap state derivation (`not_started|partial|completed`) and completion marker writes.

### Onboarding + mapping
- Added onboarding answer validation for:
  - name, timezone, style, external action policy, coding task-first, quiet hours, proactive cadence.
- Added mapping from onboarding answers to brain primitives (`user`, `preference`, `context`, `behavior`, `reminder`).

### Profile packs + merge policy
- Added versioned profile packs:
  - `personal-assistant@pa-v1`
  - `personal-assistant@pa-v2`
- Added merge planning actions:
  - `ADD`, `UPDATE`, `NOOP`, `SKIP_USER_EDITED`, `SKIP_CONFLICT`, `DEPRECATE`
- Preserves user-edited managed entries across reapply/upgrade.

### CLI lifecycle
- Added `rho bootstrap` command group:
  - `status`, `run`, `reapply`, `upgrade`, `diff`, `reset`, `audit`
- Added non-interactive onboarding flag support to `bootstrap run`.
- Added explicit reset safety token requirement.

### Slash parity
- Added `/bootstrap` command bridge with parity to CLI behavior.
- Enforced strict unknown-subcommand handling + usage hint.
- Hardened JSON parsing for noisy CLI output wrappers.

### Observability + docs
- Added local bootstrap audit log behavior and status summaries.
- Added docs:
  - `docs/bootstrapping-brain.md`
  - `docs/release-notes-draft.md`
  - `docs/bootstrap-pr-plan.md`

## Testing

### Commands

```bash
npx tsx tests/test-brain-bootstrap-schema.ts
npx tsx tests/test-brain-bootstrap-state.ts
npx tsx tests/test-bootstrap-onboarding.ts
npx tsx tests/test-bootstrap-merge-policy.ts
npx tsx tests/test-bootstrap-command.ts
npx tsx tests/test-bootstrap-apply.ts
npx tsx tests/test-bootstrap-run-onboarding.ts
npx tsx tests/test-bootstrap-slash.ts
```

### Results

All passing.

- `test-brain-bootstrap-schema.ts`: 9 passed, 0 failed
- `test-brain-bootstrap-state.ts`: 9 passed, 0 failed
- `test-bootstrap-onboarding.ts`: 13 passed, 0 failed
- `test-bootstrap-merge-policy.ts`: 6 passed, 0 failed
- `test-bootstrap-command.ts`: 17 passed, 0 failed
- `test-bootstrap-apply.ts`: 23 passed, 0 failed
- `test-bootstrap-run-onboarding.ts`: 11 passed, 0 failed
- `test-bootstrap-slash.ts`: 31 passed, 0 failed

**Total: 119 passed, 0 failed**

## Backward compatibility

- Existing user brain data is preserved by merge-safe behavior.
- User-edited managed entries are not overwritten (`SKIP_USER_EDITED`).
- Destructive bootstrap reset remains gated behind explicit confirmation.
- Slash `/bootstrap run` defaults to non-interactive bridge mode to avoid prompt hangs.

## Follow-ups (optional)

- richer interactive onboarding in pure slash contexts
- migration wizard aliases for existing-user retrofit
- additional docs links from install/onboarding paths

## Commit message options

### Single commit option
`feat(bootstrap): add brain-native onboarding, profile packs, merge-safe upgrades, and /bootstrap parity`

### Two-commit option
1. `feat(bootstrap): implement brain-native bootstrap lifecycle, packs, and merge policy`
2. `docs/tests(bootstrap): add slash parity coverage, migration docs, and PR prep artifacts`

### Squash message option
`feat(bootstrap): ship brain-native personal assistant bootstrap with CLI/slash parity, safe upgrades, and full test coverage`
