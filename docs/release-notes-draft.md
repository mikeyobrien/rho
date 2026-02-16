# Release Notes Draft

## Unreleased

### Brain-native bootstrap (personal assistant profile)

- Added a full brain-native bootstrap lifecycle:
  - `rho bootstrap status|run|reapply|upgrade|diff|reset|audit`
- Added onboarding-aware bootstrap run flow with validated user preferences:
  - name, timezone, style, external-action policy, coding-task-first, quiet hours, proactive cadence
- Added managed profile packs (`personal-assistant@pa-v1`, `@pa-v2`) with merge planning and safe upgrade behavior.
- Added user-protection semantics in merge planning:
  - preserves user-edited managed entries (`SKIP_USER_EDITED`)
- Added in-session slash parity:
  - `/bootstrap status|run|reapply|upgrade|diff|reset|audit`
- Improved slash bridge robustness:
  - parses noisy CLI output around JSON payloads
  - strict unknown-subcommand handling with usage hint
- Added bootstrap docs:
  - `docs/bootstrapping-brain.md`
