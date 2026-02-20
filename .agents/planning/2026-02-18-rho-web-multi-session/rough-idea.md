# Rough Idea

Build mobile-first multi-session support for the rho web UI so multiple pi sessions can run in parallel from a single browser tab.

## Problem

The current rho web chat frontend is built around a single active session state model. On desktop, users can workaround this by opening multiple browser tabs, but this performs poorly on mobile (background tab suspension, dropped WebSocket state, slow context switching).

## Desired Outcome

Create a messaging-app-style experience where users can:
- Keep multiple sessions active in parallel
- Switch between sessions from a session list/home view
- See live status per session (streaming, waiting, idle, errored)
- Continue receiving progress/events for background sessions
- Get lightweight notifications when background sessions complete or fail

## Design Direction

- Mobile-first UX: session list screen + focused chat screen
- Single WebSocket connection multiplexed across multiple RPC sessions
- Frontend refactor from monolithic single-session state to per-session state objects
- Reuse existing backend/session infrastructure where possible (RPC manager and reliability are already session-scoped)
- Add safe resource management limits for concurrent RPC processes

## Scope Notes

- Preserve current message rendering quality (thinking/tool streaming, markdown, semantic tool rendering)
- Keep desktop support strong using responsive layout (sidebar on wide screens)
- Prioritize incremental implementation with demoable checkpoints and test gates

## Connections

- [[idea-honing.md]]
