# Release Notes Draft

## Unreleased

### Brain-native bootstrap (agentic)

- Bootstrap is now fully agentic (conversation-driven):
  - `rho bootstrap status|run|reapply|upgrade|diff|reset|audit`
- `bootstrap run` activates in-loop identity discovery by writing bootstrap meta/context state:
  - `bootstrap.mode=agentic`, `bootstrap.phase=identity_discovery`, `bootstrap.inject=on`
- `bootstrap reapply` and `bootstrap upgrade` restart the agentic bootstrap flow.
- `bootstrap diff` now reports agentic state (mode/phase/inject) instead of deterministic merge plans.
- Added in-session slash parity:
  - `/bootstrap status|run|reapply|upgrade|diff|reset|audit`
- Improved slash bridge robustness:
  - parses noisy CLI output around JSON payloads
  - strict unknown-subcommand handling with usage hint
- Added bootstrap docs:
  - `docs/bootstrapping-brain.md`
