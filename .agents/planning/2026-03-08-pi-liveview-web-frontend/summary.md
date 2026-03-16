# Project Summary

## Overview

This project turns the rough idea of “a web frontend for the pi coding agent using Phoenix LiveView” into a detailed, actionable design package for a separate Phoenix repository.

The resulting concept is a **desktop-class local-first PWA** that runs on `localhost`, controls a local pi process, and aims for **Codex desktop capability parity on the agent-centric surfaces** while intentionally excluding built-in code editing, local git operations, and memory/vault/task views in the first serious version.

## Artifacts Created

### Core planning files
- [[rough-idea.md]]
- [[idea-honing.md]]
- [[design/detailed-design.md]]
- [[implementation/plan.md]]

### Research files
- [[research/README.md]]
- [[research/pi-integration-surface.md]]
- [[research/codex-desktop-benchmark.md]]
- [[research/liveview-pwa-patterns.md]]
- [[research/terminal-embedding-libghostty.md]]
- [[research/multimodal-attachments.md]]

## Brief Design Overview

The design centers on four runtime planes:
1. **LiveView UI plane** for the desktop workspace shell
2. **pi RPC control plane** for spawning and managing `pi --mode rpc` sessions
3. **terminal plane** for embedded libghostty-based panes backed by local PTYs
4. **artifact plane** for session history, file previews, and attachments

Key design commitments:
- separate Phoenix repo
- direct pi RPC integration
- multiple workspaces/worktrees and sessions from the start
- embedded first-class terminal panes via libghostty
- no localhost auth
- per-session model/thinking controls
- per-session attachment history
- read-only file review surfaces
- modest PWA goals: install/reopen cleanly, not fake offline behavior

## Brief Implementation Plan Overview

The implementation plan breaks the work into 10 incremental, demoable steps:
1. bootstrap the Phoenix shell
2. prove the embedded libghostty terminal early
3. add workspace/worktree registry and session indexing
4. add live pi RPC management
5. add streaming chat + model/thinking controls
6. add approvals + tool timeline
7. add multi-session/multi-worktree switching + reconnect-safe restoration
8. add multimodal attachments + session history
9. add read-only file preview
10. add PWA install/reopen, notifications, and hardening

The sequencing intentionally de-risks the hardest hard requirement — the embedded libghostty terminal — near the front rather than treating it as a late integration surprise.

## Areas That May Need Further Refinement

- exact libghostty integration package/build strategy
- terminal lifecycle policies when many sessions/worktrees are open
- exact attachment storage path and metadata persistence approach for localhost mode
- how aggressively to keep multiple pi subprocess sessions hot at once
- the future hosted/remote-pi evolution path once localhost mode is stable

## Recommended Next Steps

1. Review `design/detailed-design.md` for architectural correctness.
2. Review `implementation/plan.md` for sequencing and milestone realism.
3. Create the new Phoenix repository and begin with **Step 1**.
4. Treat **Step 2** as an early hard gate: the embedded libghostty pane must work in the real app shell.

## Connections

- [[rough-idea.md]]
- [[idea-honing.md]]
- [[design/detailed-design.md]]
- [[implementation/plan.md]]
- [[research/README.md]]
- [[research/pi-integration-surface.md]]
- [[research/codex-desktop-benchmark.md]]
- [[research/liveview-pwa-patterns.md]]
- [[research/terminal-embedding-libghostty.md]]
- [[research/multimodal-attachments.md]]
- [[libghostty-embedding-phoenix]]
- [[small-improvement-rho-dashboard]]
- [[rho-dashboard-improvements-2026-02-14]]
- [[rho-dashboard-improvements-2026-02-15-16]]
