---
status: completed
created: 2026-02-16
started: 2026-02-16
completed: 2026-02-16
owner: openclaw
---
# Task: Telegram API cleanup — enforce grammy-only surface (remove compatibility shims)

## Description
Remove the temporary Telegram compatibility layer and standardize the Telegram extension on **grammy-only** APIs and error types.

This task exists to pay down deliberate short-term debt added to unblock release-readiness tests. The target state is a single code path (grammy signatures + grammy errors), with no legacy object-style API wrappers.

## Why
Current compatibility shims add duplicate paths and maintenance burden:
- two method call conventions (grammy positional vs legacy object payload)
- duplicate error model handling (`TelegramApiError` + `GrammyError`/`HttpError`)
- compatibility file (`extensions/telegram/retry.ts`) reintroduced only for old tests

The desired state is simpler and more maintainable: one API, one error model, one behavior path.

## Scope
### In scope
- Telegram extension runtime/API internals and tests in `projects/rho`
- Removal of legacy compatibility exports and wrappers
- Test migration to grammy-native mocks/assertions

### Out of scope
- New Telegram product features
- Behavior changes to polling, queueing, STT/TTS semantics (except what is required by API surface cleanup)

## Affected Areas (expected)
- `extensions/telegram/api.ts`
- `extensions/telegram/worker-runtime.ts`
- `extensions/telegram/index.ts` (only if needed for type/signature cleanup)
- `extensions/telegram/retry.ts` (delete or retire if no longer needed)
- `tests/test-telegram.ts`
- `tests/test-telegram-worker-runtime.ts`
- Any additional test files importing legacy Telegram symbols

## Implementation Plan (BDD/TDD-first)
1. **RED: add/adjust tests to express grammy-only contract**
   - Tests should no longer import/use `TelegramApiError` or `TelegramClient` from adapter compatibility layer.
   - Worker runtime tests should mock grammy-style method signatures only.
   - Add explicit assertions that legacy symbols are not required.

2. **GREEN: remove compatibility code**
   - Remove `TelegramApiError` and `TelegramClient` exports from `extensions/telegram/api.ts`.
   - Remove legacy helper compatibility branches from worker runtime (e.g., legacy object payload adapters).
   - Remove or replace `extensions/telegram/retry.ts` if obsolete.

3. **REFACTOR: simplify and tighten types**
   - Keep `TelegramClientLike` strictly grammy-shaped.
   - Remove dead branches and conversion helpers.
   - Ensure error utility functions are grammy-native and minimal.

4. **Validation**
   - Run targeted Telegram tests.
   - Run full `npm test`.
   - Run `npm pack --dry-run`.

## Acceptance Criteria
1. `extensions/telegram/api.ts` does **not** export `TelegramApiError` or `TelegramClient`.
2. `extensions/telegram/worker-runtime.ts` contains no legacy compatibility wrappers (object-style call adapters).
3. `extensions/telegram/retry.ts` is deleted or no longer required by runtime/tests.
4. Telegram tests pass with grammy-only mocks/signatures.
5. Full test suite passes: `npm test`.
6. Packaging smoke passes: `npm pack --dry-run`.
7. Grep checks confirm legacy symbol removal:
   - no imports/usages of `TelegramApiError`
   - no imports/usages of `TelegramClient` (adapter compatibility class)

## Suggested Validation Commands
- `grep -R "TelegramApiError\|TelegramClient" -n extensions tests`
- `npx -y tsx tests/test-telegram-worker-runtime.ts`
- `npx -y tsx tests/test-telegram.ts`
- `npm test`
- `npm pack --dry-run`

## Risks & Mitigations
- **Risk:** test mocks still assume legacy payload signatures.
  - **Mitigation:** migrate all mocks to grammy-style signatures in same task.
- **Risk:** hidden call sites rely on legacy exports.
  - **Mitigation:** exhaustive grep + compile/test pass before merge.
- **Risk:** retry/error tests become brittle due to grammy error construction details.
  - **Mitigation:** centralize test error factory helpers for grammy errors.

## Definition of Done
- All acceptance criteria met.
- No compatibility shim leftovers.
- Change is reviewed/approved before implementation.
