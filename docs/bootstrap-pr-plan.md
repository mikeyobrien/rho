# Bootstrap PR Plan (Agentic)

## Goal

Make bootstrap fully agentic and remove deterministic profile-pack/bootstrap-merge behavior.

## Scope

- Keep bootstrap state machine in brain meta.
- Activate bootstrap via `/bootstrap run` by writing agentic meta/context seed entries.
- Inject bootstrap mission into the main loop while active.
- End bootstrap by writing completion meta keys.
- Remove deterministic planner/mapping/profile-pack modules.

## Command semantics

- `bootstrap status`: report status + bootstrap id + mode/phase/inject + managed entries.
- `bootstrap run`: activate (or reopen with `--force`) agentic bootstrap.
- `bootstrap reapply`: restart identity discovery.
- `bootstrap upgrade`: alias reapply behavior.
- `bootstrap diff`: report agentic state (not merge actions).
- `bootstrap reset`: keep explicit confirmation guard.
- `bootstrap audit`: unchanged lifecycle log surface.

## Verification

```bash
npx tsx tests/test-brain-bootstrap-schema.ts
npx tsx tests/test-brain-bootstrap-state.ts
npx tsx tests/test-bootstrap-command.ts
npx tsx tests/test-bootstrap-slash.ts
```

Expected: all pass.

## Notes

- Remove pa-v/profile-pack terminology in favor of `agentic-vN` revision language.
- Preserve user data; only bootstrap control state and seed context are managed by bootstrap activation.
