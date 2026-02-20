# Plan: Deferred Review Inbox (Always Non-Blocking)

## Objective

Refactor review flow so review collection is decoupled from the active chat session:

- A chat can create a review request and continue immediately.
- The user can submit comments later (same session or a different one).
- Any later chat can fetch submitted reviews and address feedback.
- `review` tool is **always deferred** (never blocks waiting for submit).

## Product Decision (Locked)

1. `review` tool will **not** wait on WebSocket submission.
2. Review submissions are persisted durably on disk.
3. Retrieval/claim/resolve is done via a separate inbox tool + API.
4. “Live in-memory only” behavior is removed for submitted outcomes.

## Current Pain

Today, review data is tied to a live tool call + in-memory `reviewSessions` lifecycle. If the originating chat/tool call is gone, results are hard/impossible to retrieve from another chat.

## Target Design

### 1) Durable Review Store

Add `web/review-store.ts` using append-only JSONL (brain-style lock discipline):

- path: `~/.rho/review/reviews.jsonl`
- records include:
  - `id`
  - `status`: `open | submitted | cancelled | claimed | resolved`
  - `createdAt`, `submittedAt`, `updatedAt`, `resolvedAt`
  - `request`: `{ files, warnings, message, cwd?, branch?, commit? }`
  - `submission`: `{ comments[] }` when submitted
  - `claim`: `{ claimedBy?, claimedAt? }`
  - `resultSummary`: `{ commentCount }`

Use fold semantics (last-write-wins by `id`) with tombstone/archive support later.

### 2) State Split

In `web/server.ts`:

- Keep socket registries in memory only (`toolSockets`, `uiSockets`).
- Move review lifecycle source-of-truth to durable store.
- On submit/cancel, write immediately to store.
- On process restart, submitted reviews remain discoverable.

### 3) New Inbox API

Add server endpoints:

- `GET /api/review/submissions?status=submitted|claimed|resolved|all&claimedBy=...`
- `GET /api/review/submissions/:id`
- `POST /api/review/submissions/:id/claim`
- `POST /api/review/submissions/:id/resolve`

Keep existing session APIs for active UI flows:

- `POST /api/review/sessions` (create/open)
- `GET /api/review/sessions` (active/lobby)

### 4) Tool Contract Changes

In `extensions/review/index.ts`:

#### `review` (changed behavior)

- Input stays: `{ files: string[], message?: string }`
- New output: immediate acknowledgment text containing:
  - `review_id`
  - `url`
  - retrieval hint (`use review_inbox list/get`)
- No waiting for `review_result` event.

#### `review_inbox` (new tool)

- `action: "list" | "get" | "claim" | "resolve"`
- `id` required for `get/claim/resolve`
- `get` returns formatted markdown using existing `formatReviewMessage(...)`

### 5) UI Adjustments

- `web/public/js/review-panel.js`:
  - keep “active reviews” section
  - add “submitted inbox” section
- optional: show claim/resolution metadata badges
- ensure dashboard can open submitted review detail safely

### 6) Retention

- Do not auto-delete submitted reviews after 10m.
- Keep until resolved + retention window (e.g., 30 days).
- Add cleanup pass for old resolved records.

## State Machine

- `open` -> `submitted`
- `open` -> `cancelled`
- `submitted` -> `claimed`
- `claimed` -> `resolved`
- `submitted` -> `resolved` (allow direct resolve)

Guards:

- cannot claim cancelled
- cannot submit after resolved
- idempotent resolve

## Implementation Steps

- [ ] **Step 1 — Durable store module + tests**
  - Add `web/review-store.ts`
  - Implement `appendEvent`, `loadState`, `list`, `get`, `updateStatus`, `claim`, `resolve`
  - Add lock usage (`extensions/lib/file-lock.ts`)
  - Add unit tests for fold, restart safety, status transitions

- [ ] **Step 2 — Server integration for create/submit/cancel persistence**
  - Wire `POST /api/review/sessions` to create store entry (`open`)
  - Persist on websocket `submit` and `cancel`
  - Keep websocket fanout behavior for active participants
  - Remove ephemeral deletion path for submitted sessions

- [ ] **Step 3 — Add inbox endpoints**
  - Implement `/api/review/submissions*` endpoints
  - Add filtering/sorting (newest submitted first)
  - Add claim/resolve validation and conflict responses

- [ ] **Step 4 — Make `review` tool always deferred**
  - Update `extensions/review/server.ts` create flow to return early metadata
  - Update `extensions/review/index.ts` tool execute to return immediate text
  - Keep `/review` command behavior for manual browser/TUI use

- [ ] **Step 5 — Add `review_inbox` tool**
  - Register tool in `extensions/review/index.ts`
  - Implement actions list/get/claim/resolve via HTTP API
  - Reuse `formatReviewMessage` for `get`

- [ ] **Step 6 — UI dashboard updates**
  - Add submitted inbox table/list in review panel
  - Add actions/badges for claim + resolve (or read-only first)

- [ ] **Step 7 — Docs + migration notes**
  - Update `docs/review.md` with deferred-first workflow
  - Document new tool usage examples

- [ ] **Step 8 — Verification gates**
  - Add/adjust tests for:
    - cross-session retrieval
    - restart persistence
    - claim/resolve transitions
    - tool non-blocking behavior
  - Add a manual E2E verification pass using `playwriter` covering: create deferred review -> submit from UI -> retrieve via inbox -> claim/resolve.
  - Run targeted tests + full relevant suite

## File-Level Change Map

- `web/review-store.ts` (new)
- `web/server.ts`
- `extensions/review/index.ts`
- `extensions/review/server.ts`
- `web/public/js/review-panel.js`
- `docs/review.md`
- tests:
  - `web/review-store.test.ts` (new)
  - `extensions/review/server.test.ts` (update)
  - server API tests for new submissions endpoints

## Acceptance Criteria

1. Calling `review(...)` returns immediately (<1s after session creation) with `review_id` and URL.
2. User can submit review later from browser UI.
3. Submitted review is retrievable from a different chat via `review_inbox get`.
4. Submitted review survives rho-web restart.
5. Claim/resolve workflow prevents accidental double-processing.
6. Existing active review UI remains functional.
7. Manual E2E behavior is verified with `playwriter` (deferred creation, delayed submission, cross-chat retrieval, claim/resolve).

## Risks / Notes

- Token handling: avoid exposing raw token where not needed outside direct review URL.
- Concurrency: claim/resolve updates must be atomic under lock.
- Backward compatibility: some agents may expect old blocking `review` behavior; update docs/tool descriptions clearly.

## Suggested Rollout

1. Ship store + API + tests behind compatibility path.
2. Flip `review` tool to always deferred.
3. Add `review_inbox` and update agent prompts/docs.
4. Monitor for regressions in existing review UI.
