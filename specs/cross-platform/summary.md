# Cross-Platform Rho — Summary

## Artifacts

| File | Description |
|------|-------------|
| `rough-idea.md` | Original idea with current state analysis and open questions |
| `requirements.md` | 13 Q&A pairs covering audience, architecture, install, naming, migration, and acceptance criteria |
| `design.md` | Full design document with architecture diagrams, component details, data models, error handling, acceptance criteria, and appendices |
| `plan.md` | 10-step implementation plan with checklist, guidance, test requirements, and integration notes |
| `summary.md` | This file |

All artifacts are in `~/projects/rho/specs/cross-platform/`.

## Overview

Restructure Rho from an Android/Termux-only agent into a cross-platform framework that runs on macOS, Linux, and Android. The core value (persistent AI agent with heartbeat, memory, autonomous check-ins) already works anywhere — the work is reorganizing platform-specific code and making the install path OS-aware.

### Key Decisions
- **Single repo** with `platforms/{android,macos,linux}/` directories
- **Generic skill names** — `notification`, `clipboard`, `open-url` — with per-platform implementations swapped by the install script
- **Independent instances** — no shared state between machines in v1
- **Tmux everywhere** — consistent interaction model across all platforms
- **Check-and-bail install** on desktop (respect user's package manager), hands-on bootstrap on Termux
- **Individual file symlinks** to merge core + platform extensions cleanly
- **Config file** at `~/.config/rho/config` (shell-sourceable) for portable scripts

### What's In v1
- Core framework on all 3 platforms
- Platform skills: notification, clipboard, open-url, tts
- OS-aware install.sh with idempotent migration
- Config-driven scripts
- Updated README

### What's Deferred
- Shared state / memory sync (v2+)
- launchd / systemd service files (v2+)
- Desktop UI automation (v2+)
- Automated cross-platform CI (v2+)

## Next Steps

Use the `code-assist` skill with `plan.md` to begin implementation, starting at Step 1.
