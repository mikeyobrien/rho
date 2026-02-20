# Idea Honing

This document captures iterative requirements clarification as Q&A.

## Questions and Answers

### Q1
**Question:** For v1, what exact multi-session behavior should we guarantee when one session is streaming and the user switches to another session?

**Answer (final):** Keep background sessions running, but do not live-render their message deltas while unfocused. Track lightweight status only (streaming/done/error + unread badge). On refocus, perform a fresh session reload (`/api/sessions/:id`) plus RPC `get_state` sync.

**Alternatives considered:**
- Pause background sessions when unfocused (rejected: less useful, surprising behavior)
- Fully live-render all background sessions (rejected for v1: higher complexity and mobile performance risk)

### Q2
**Question:** For v1, how many concurrent active RPC sessions should we allow by default, and what should happen when the user tries to start one beyond that limit?

**Answer (final):** No enforced limit in v1.

**Notes:** This prioritizes flexibility and keeps control in the user's hands. Any guardrails should be informational (observability/warnings), not hard caps.

### Q3
**Question:** In the mobile-first session list, what should tapping a session do if it has no live RPC process yet (historical session only)?

**Answer (final):** Auto-start RPC immediately and open as a live chat.

**Rationale:** Fast path with minimal friction; users should not need an extra activation step.

### Q4
**Question:** What should count as “unread” for a background session badge in v1?

Suggested options:
- A) Any new event while unfocused
- B) New assistant/user-visible message completion only (`message_end`)
- C) Session-level milestones only (`agent_end`, errors)

**Answer (final):** Session-level milestones only (`agent_end`, errors).

**Rationale:** Keep signaling low-noise and actionable.

### Q5
**Question:** Should background session completion/error also trigger a toast notification, or should we rely on badges only?

**Answer (final):** Badges only.

**Rationale:** Keep it KISS and avoid notification noise.

### Q6
**Question:** On full page reload, should the UI restore previously active sessions automatically, or start with a clean slate and only reopen when the user taps sessions?

**Answer (final):** Restore previously active sessions automatically.

**Rationale:** Preserve continuity and reduce reopening friction.

### Q7
**Question:** Should users be able to explicitly close/deactivate an active session from the session list (stopping its RPC process), or should sessions only expire via existing idle/orphan behavior?

**Answer (final):** Keep it KISS for v1: no explicit close/deactivate UI. Sessions continue to rely on existing idle/orphan lifecycle behavior.

### Q8
**Question:** For the session list ordering, what should be pinned at the top?

Suggested options:
- A) Streaming first, then active non-streaming by recent activity, then inactive history
- B) Last focused first regardless of status
- C) Strict chronological (last activity only)

**Answer (final):** A — streaming first, then active non-streaming by recent activity, then inactive history.

### Q9
**Question:** Should the user be allowed to send prompts to multiple sessions concurrently (e.g., start a prompt in B while A is still streaming), or should prompt submission be blocked to one active stream globally?

**Answer (final):** Allow concurrent prompts across sessions. User should be able to jump around and run multiple active streams as needed.

### Q10
**Question:** For v1, do we need any new server APIs/events for multi-session management, or should we constrain the solution to existing endpoints/protocols unless absolutely necessary?

**Answer (final):** New backend APIs/events are allowed where needed.

**Guidance:** Prefer reuse of existing surfaces when practical, but do not block clean implementation.

### Q11
**Question:** Do you want session state restore scope to include only the list of active session IDs + focused session ID, or also draft composer text per session?

Suggested options:
- A) Restore active IDs + focus only
- B) Restore active IDs + focus + per-session draft text

**Answer (final):** B — restore active IDs, focused session, and per-session draft composer text.

### Q12
**Question:** Any hard no-go for v1 scope that we should explicitly exclude (e.g., split-screen simultaneous rendering, cross-session global queue, desktop notifications, explicit process controls)?

**Answer (final):** Yes — exclude all listed examples for v1. Keep scope to a rock-solid POC.

**Explicit exclusions for v1:**
- Split-screen simultaneous multi-chat rendering
- Cross-session global queue UX
- Desktop/toast notifications for background milestones
- Explicit process controls (close/deactivate/stop buttons)

### Q13
**Question:** What are the minimum pass/fail acceptance criteria for calling this POC “rock-solid” (top 3 checks)?

**Answer (final):** Include all three baseline checks:
1. Survive reload and restore active multi-session context
2. Handle concurrent streams without cross-talk between sessions
3. Preserve background run continuity when switching sessions, with correct resync on refocus

### Q14
**Question:** For the reload-restore acceptance test, what target number of simultaneously active sessions should we explicitly validate in v1 (e.g., 2, 3, 5)?

**Answer (final):** Validate with 5 simultaneously active sessions.

### Q15
**Question:** For v1 persistence, is browser localStorage acceptable for restoring active sessions/focus/drafts, with graceful fallback if storage is unavailable?

**Answer (final):** Yes.

### Q16
**Question:** If restoring an active session fails on reload (session missing, RPC start error, or session file unreadable), should we drop just that session and continue restoring others, while surfacing a lightweight error state for the failed one?

**Answer (final):** Yes — fail session-by-session, continue restoring the rest, and surface a lightweight error state for failures.

### Q17
**Question:** Requirements checkpoint: do you feel requirements clarification is complete enough to move to research/design, or do you want more requirement questions first?

**Answer (final):** Requirements clarification is complete enough. Proceed to research and design.

## Connections

- [[rough-idea.md]]
