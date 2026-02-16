# Bootstrap PR Plan (A–H)

Use this as a PR description skeleton and single-commit planning guide.

## Suggested PR title

`feat(bootstrap): brain-native personal assistant onboarding, profile packs, merge-safe upgrades, and slash parity`

## Why

Rho should support personal-assistant behavior bootstrapping using brain primitives only, with safe retrofit for existing users and no markdown dependency for core behavior.

## Scope by milestone

### A) Schema + state primitives
- Add bootstrap schema validation and managed metadata helpers.
- Add bootstrap state derivation (`not_started|partial|completed`) and completion marker writing.

### B) Onboarding validation + mapping
- Validate onboarding answers (name/timezone/style/risk policy/etc).
- Map onboarding answers to brain primitives (`user`, `preference`, `context`, `behavior`, `reminder`).

### C) Profile pack registry
- Add versioned profile packs (`personal-assistant@pa-v1`, `pa-v2`).
- Keep deterministic managed keys for idempotent merges.

### D) Merge policy engine
- Implement merge planning actions: `ADD`, `UPDATE`, `NOOP`, `SKIP_USER_EDITED`, `SKIP_CONFLICT`, `DEPRECATE`.
- Preserve user edits across reapply/upgrade.

### E) CLI command surface
- Add `rho bootstrap status|run|reapply|upgrade|diff|reset|audit`.
- Support JSON output, dry-run paths, and explicit reset confirmation.

### F) Safety + observability
- Add local bootstrap audit event log.
- Include status metadata (managed count, last op/result/timestamp).

### G) BDD/TDD coverage
- Add `features/brain-bootstrap.feature` scenarios.
- Add unit/integration tests for schema/state/onboarding/merge/command/apply.

### H) Slash parity + docs
- Add `/bootstrap` command bridge with strict unknown-subcommand handling.
- Add noisy CLI-output JSON parsing hardening.
- Add docs:
  - `docs/bootstrapping-brain.md`
  - `docs/release-notes-draft.md`

## Verification summary

Run:

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

Expected: all pass.

## Backward compatibility notes

- Existing users are preserved by merge-safe behavior.
- User-edited managed entries are not overwritten.
- Reset remains gated behind explicit confirmation token.
- Slash `/bootstrap run` defaults to non-interactive bridge mode.

## Follow-ups (optional)

- Add richer in-app onboarding prompts for non-CLI sessions.
- Add migration wizard command alias for existing-user retrofit flow.
- Add docs link from installation sections to bootstrap guide.
