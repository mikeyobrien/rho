# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/mikeyobrien/rho/compare/v0.1.8...HEAD
[0.1.8]: https://github.com/mikeyobrien/rho/compare/v0.1.7...v0.1.8
