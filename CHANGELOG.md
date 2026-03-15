# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.12] - 2026-03-15

### Added

- Embedded terminal drawer powered by ghostty-web and node-pty.
- Auto-memory settings UI, status API, and memory dashboard.
- Session mtime sorting, provider usage API, and config UI panel.
- Grouped assistant turns in chat for cleaner conversation flow.
- Android: side-by-side RC installs and Tailscale HTTP profile support.
- Android store distribution prep and mobile Tailscale setup guide.
- Nix dev shell upgraded to Android SDK 35 with emulator support.

### Changed

- Extracted WebSocket module from chat; improved scroll behavior and session routing.
- Server wiring cleanup, performance logging, asset gates, and UI polish.

### Fixed

- Codex auto-memory prompt handling now works correctly.
- Regression test for heartbeat pane detection now handles multiline code.
- Session thrashing on reconnect and duplicate switch_session guards in rpc chat.

## [0.1.11] - 2026-03-14

### Added

- Added the rho-android wrapper app with a native Live Mode foreground service and release workflows/docs for mobile validation.

### Changed

- Unified memory settings under `init.toml` and wired rho-web auth/live-mode integration for the mobile client.

### Fixed

- npm packaging now excludes local `.worktrees/` directories so `npm pack` and releases do not scoop up sibling worktree contents.
- rho-web runtime now avoids TypeScript parameter properties in Node strip-types paths.

## [0.1.10] - 2026-03-10

### Fixed

- Fresh npm installs now ship the Brave Search extension with the non-conflicting `brave_search` tool and `/brave-search` command instead of the legacy `web_search` and `/search` names that collided with `pi-web-access`.

## [0.1.9] - 2026-02-25

### Added

- Default package registry now includes the nicobailon extension set in generated config (`templates/init.toml`) and sync behavior.
- Added a Nix Android/Java development shell (`flake.nix`) with setup docs for mobile development.

### Changed

- RPC orphan handling is now config-driven via `[settings.web]` with deterministic precedence (`env > config > default`) and validation clamps.
- Configuration docs expanded with attribution and package links for nicobailon-contributed defaults.

## [0.1.8] - 2026-02-21

### Added

- Session-scoped Git project picker and context routing in rho-web chat.
- RPC sessions observability endpoint (`/api/rpc/sessions`).
- Playwright multi-session acceptance gates for reload restore, concurrency integrity, and background continuity.
- New SOP skill: `release-changelog` for changelog-driven tag releases.

### Changed

- rho-web multi-session runtime hardening across reconnect, restore persistence, routing, ordering, and per-session state isolation.
- README restructured to foreground the web UI and memory observability.
- Git hygiene improvements: ignore and untrack agent artifact logs (`.agents/artifacts/**/*.log`).

### Fixed

- Review panel no longer keeps stale submitted inbox items after status transitions.
- Chat composer action overlap on narrow widths (Abort vs Attach/Queue controls).

[Unreleased]: https://github.com/mikeyobrien/rho/compare/v0.1.12...HEAD
[0.1.12]: https://github.com/mikeyobrien/rho/compare/v0.1.11...v0.1.12
[0.1.11]: https://github.com/mikeyobrien/rho/compare/v0.1.10...v0.1.11
[0.1.10]: https://github.com/mikeyobrien/rho/compare/v0.1.9...v0.1.10
[0.1.9]: https://github.com/mikeyobrien/rho/compare/v0.1.8...v0.1.9
[0.1.8]: https://github.com/mikeyobrien/rho/compare/v0.1.7...v0.1.8
