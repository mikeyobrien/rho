# Web UI Polish Plan

## Bugs Found

### B1: Session titles overflow on mobile (CRITICAL)
- `.chat-session-title` shows raw UUIDs (36+ chars) with no wrapping
- At 360px this blows out the entire layout to 712px
- **Fix:** Add `overflow: hidden; text-overflow: ellipsis; white-space: nowrap` to `.chat-session-title`. Also add `min-width: 0` on flex/grid children to allow shrinking. Consider showing session name when available, falling back to truncated UUID.

### B2: Horizontal overflow at 360px
- Root cause is B1 (UUIDs), but also `.chat-session-meta` has `flex-wrap: wrap` which doesn't help when parent overflows
- **Fix:** Add `overflow: hidden` on `.chat-sessions`, `.chat-list`, and `overflow-x: hidden` on `.app` wrapper. Add `min-width: 0` throughout grid children.

### B3: `x-show` views still occupy DOM space when hidden
- All three views (chat, files, tasks) are always in the DOM. `x-show` toggles `display`, but data is fetched on `x-init` for all three on page load.
- **Fix:** This is minor — could use `x-if` to defer rendering, but `x-show` with `x-cloak` works fine for now. Just ensure init() checks are lazy (only fetch when view becomes active).

### B4: Session names not showing
- API returns session names from `session_info` entries but the UI shows raw UUIDs
- **Fix:** Verify session-reader.ts extracts `name` field and the frontend prefers it over ID.

### B5: Pre blocks overflow on mobile
- `<pre>` blocks in chat messages (code, tool output) don't have constrained width
- **Fix:** Add `max-width: 100%; overflow-x: auto` to all `pre` elements within `.chat-text` and `.chat-block-body`.

### B6: Playwriter screenshots timing out
- `page.screenshot()` hangs after a few successful calls in the same session
- Not a web UI bug per se, but affects testing workflow
- **Fix:** Not actionable here — likely Playwriter/CDP issue. Use accessibility snapshots instead.

---

## Mobile Friendliness

### M1: Session list as collapsible drawer on mobile
- At 360px, the session sidebar and chat thread are stacked vertically, wasting precious vertical space
- **Fix:** On mobile, show session list as a collapsible section (tap to expand/collapse) or a slide-out drawer. Default to collapsed when a session is selected.

### M2: File list as collapsible drawer on mobile
- Same issue as M1 for the files view
- **Fix:** Same approach — collapsible file list on mobile.

### M3: Touch-friendly tap targets
- Buttons and clickable areas need minimum 44px touch targets on mobile
- **Fix:** Ensure all interactive elements have `min-height: 44px` on mobile. Add padding to small buttons.

### M4: Sticky input bar
- On mobile, the chat composer should stick to the bottom of the viewport, not scroll with the content
- **Fix:** Position composer as `position: sticky; bottom: 0` on mobile viewports.

### M5: Nav tab spacing on narrow screens
- The powerline chevrons (`::after` clip-path) overlap on narrow screens
- **Fix:** Already disabled at 480px, but verify. May need to switch to simple underline tabs on mobile.

### M6: Viewport meta tag
- Already has `<meta name="viewport" ...>` ✓
- **Verify:** Ensure `user-scalable=no` is NOT set (allow pinch-to-zoom for accessibility).

---

## Scrollbar Styling

### S1: Custom scrollbars matching theme
- Default browser scrollbars look jarring against the dark terminal aesthetic
- **Fix:** Add WebKit and Firefox scrollbar styles:
  - Track: `var(--bg)` or `var(--bg-alt)`
  - Thumb: `var(--border-bright)` with `var(--green-dim)` on hover
  - Width: thin (8px)
  - Apply to `body`, `.chat-list`, `.chat-thread-body`, `.files-list`, `.files-textarea`, `.tasks-list`, `pre`

### S2: Scrollbar on textarea
- The file editor textarea scrollbar should match
- **Fix:** Same custom scrollbar styles applied to `textarea` elements

---

## Implementation Order

**Phase 1: Critical fixes (bugs that break mobile)**
1. B1 + B2: Fix overflow (session title truncation, `min-width: 0`, `overflow: hidden`)
2. B5: Pre block overflow
3. S1 + S2: Scrollbar styling (quick CSS-only change)

**Phase 2: Mobile UX improvements**
4. M1: Collapsible session list on mobile
5. M2: Collapsible file list on mobile
6. M4: Sticky chat composer on mobile
7. M3: Touch target sizing

**Phase 3: Polish**
8. B4: Session names display
9. M5: Nav refinement on narrow screens
10. General code review and cleanup

---

## Estimated Effort
- Phase 1: ~30 min (all CSS)
- Phase 2: ~45 min (CSS + minor Alpine.js for collapsible sections)
- Phase 3: ~20 min
- Total: ~1.5 hours
