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

### rho-web UI improvements (2026-02-18 → 2026-02-20)

#### Added

- Major rho-web UI overhaul across composer, tool rendering, queue behavior, and layout.
- Chat bubbles now use left/right justification with consistent widths and role subtitle timestamps.
- Composer now supports image upload and slash-command autocomplete.
- Sessions UI now supports slide-out navigation with full-height chat.
- Added light/dark theme toggle.
- Added edit/write tool diff rendering in chat.
- Added PWA installability and page-level pull-to-refresh.
- Added deferred review inbox workflow with durable storage.

#### Changed

- Review workflow is integrated into the main web shell.
- Review panel layout and session reader were refreshed.
- Composer controls were realigned, and redundant status UI was removed.
- Emoji affordances were replaced with polished text/glyph labels.
- Mobile UI was tightened (compact footer, improved controls, adjusted text sizing).
- Iosevka is now the primary UI font.

#### Fixed

- Autoscroll reliability across load, refresh, streaming, and lazy-render paths.
- True-bottom scroll behavior by waiting for DOM paint.
- Sticky autoscroll now survives lazy message rendering.
- Session card timestamp rendering and mobile overlap/cramped layout bugs.
- Active-session message count no longer incorrectly shows `0`.
- RPC session recovery after WebSocket reconnect/AFK.
- Abort flow now resets composer to Send mode.
- Multiline user prompts are preserved in chat bubbles.
- Mobile regressions: hidden composer, stale CSS/JS cache behavior, and input/button layout issues.
- Pull-to-refresh indicator positioning/double-init issues.

#### Performance

- Idle/visibility detection now pauses polling when appropriate.
- Review updates are event-driven.
- Session list updates now use WebSocket push instead of relying only on polling.
- Added preload links for CDN script dependencies.
- Web code was modularized, with file-size backpressure (`<=500` lines for web TS/JS files).
