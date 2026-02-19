# Task: Rho-Web No-Build Performance Sweep

## Description
Squeeze maximum performance out of rho-web without introducing build tooling or bundlers. The app is vanilla JS (Alpine.js + htmx + marked + highlight.js) served by a Hono/Node.js backend. All changes must preserve the current no-build, no-bundle architecture.

## Background
Rho-web is a chat UI + brain viewer + config editor for the rho agent system. It serves static HTML/JS/CSS from `web/public/` and proxies to pi RPC sessions over WebSocket. Current pain points:
- Large sessions (200+ messages) cause sluggish rendering — every message is DOM-rendered with markdown + syntax highlighting at once
- Static assets served uncompressed with no cache headers
- Two polling loops (15s sessions, 5s reviews) run indefinitely even when idle
- Streaming token deltas trigger markdown re-parse on every `requestAnimationFrame`

The codebase is ~6300 lines of frontend JS + ~2300 lines of server TS. No framework, no build step — and we want to keep it that way.

## Current Status (2026-02-18)

### Phase 1: Server quick wins ✅ DONE
- [x] 1. Add `compress()` middleware to `server.ts` - DONE (verified)
- [x] 2. Add `Cache-Control` headers to static asset routes - DONE (verified)
- [x] 3. Add optional timing middleware (RHO_DEBUG=1) - DONE (verified)
- [x] 4. Refactor `readSession()` to use streaming readline - DONE (verified: loadSessionEntries uses createReadStream + createInterface, not readFile + split)

### Phase 2: Client rendering ✅ DONE
- [x] 5. Lazy markdown rendering via IntersectionObserver - DONE (chat.js: setupLazyRendering(), data-message-id in index.html)
- [x] 6. Batch streaming markdown renders (150ms debounce) - DONE (verified line 1544-1550)
- [x] 7. Cap rendered messages (~100) with "Load earlier" button - DONE (verified line 2215-2218)

### Phase 3: Network ⚠️ PARTIAL  
- [x] 8. Add `<link rel="preload">` tags for CDN scripts - DONE (verified)
- [ ] 9. Replace polling with WebSocket push - PARTIAL: idle detection + Page Visibility API done, full WebSocket push NOT implemented

### Server-side
1. Add gzip/brotli compression via Hono's `compress()` middleware
2. Add `Cache-Control` headers to static asset routes (`/css/*`, `/js/*`, `/assets/*`) — assets already use `?v=` cache busters
3. Refactor `readSession()` to use streaming readline (like `computeSessionInfo()` already does) instead of `readFile` + split for large sessions
4. Add basic request timing middleware (log method, path, duration) gated behind a `RHO_DEBUG` env var

### Client-side
5. Lazy markdown rendering via IntersectionObserver — render message shells on load, only call `marked.parse()` + `hljs.highlightElement()` when the message scrolls into viewport
6. Batch streaming markdown renders — change `scheduleMarkdownRender` from per-`requestAnimationFrame` to a 150ms debounced `setTimeout`
7. Cap rendered messages — only render the last ~100 messages initially, add a "Load earlier messages" button at the top of the thread
8. Add `<link rel="preload">` tags for the 4 CDN scripts (htmx, marked, highlight.js, Alpine.js)
9. Replace the two polling loops (session list + review sessions) with server-push notifications over the existing WebSocket connection

## Dependencies
- Hono compress middleware (`hono/compress`)
- No new client-side dependencies — all changes are vanilla JS
- Existing `IntersectionObserver` browser API (supported everywhere)

## Implementation Approach

### Phase 1: Server quick wins (requirements 1-4)
1. Add `compress()` middleware to `server.ts`
2. Add cache headers to the existing `serveStatic` routes
3. Add optional timing middleware
4. Refactor `readSession()` in `session-reader.ts` to stream-parse JSONL

### Phase 2: Client rendering (requirements 5-7)
5. Add IntersectionObserver to `chat.js` that triggers markdown rendering when messages enter the viewport
6. Change `scheduleMarkdownRender` to use 150ms debounced setTimeout instead of rAF
7. Add message cap with "Load earlier" button — slice `renderedMessages` to last 100, prepend on click

### Phase 3: Network (requirements 8-9)
8. Add preload links to `index.html`
9. Add server-side WebSocket push for session list changes and review session updates; remove client-side `setInterval` polling

## Acceptance Criteria

1. **Compression active**
   - Given the rho-web server is running
   - When a browser requests `/css/style.css` with `Accept-Encoding: gzip`
   - Then the response includes `Content-Encoding: gzip` and transfer size is ~70% smaller

2. **Cache headers present**
   - Given the rho-web server is running
   - When a browser requests a static asset under `/css/`, `/js/`, or `/assets/`
   - Then the response includes a `Cache-Control` header with a reasonable max-age

3. **Lazy markdown rendering**
   - Given a session with 200+ messages is loaded
   - When the session first renders
   - Then only messages visible in the viewport have markdown/hljs applied; off-screen messages show raw text or placeholder until scrolled into view

4. **Streaming render batching**
   - Given the agent is streaming a response
   - When token deltas arrive rapidly
   - Then markdown is re-rendered at most once per ~150ms, not on every animation frame

5. **Message cap**
   - Given a session with 200+ messages
   - When the session loads
   - Then only the last ~100 messages are in the DOM, with a "Load earlier" control at the top

6. **No polling**
   - Given the WebSocket is connected
   - When observing network traffic
   - Then there are no periodic `GET /api/sessions` or `GET /api/review/sessions` requests; updates arrive via WebSocket push

7. **Streaming session reader**
   - Given a large session file (>1MB)
   - When `readSession()` is called
   - Then memory usage does not spike proportionally to file size (no full-file string in memory)

8. **No build step required**
   - Given the full set of changes
   - When verifying the development workflow
   - Then `node --import tsx web/dev.ts` starts the server with no prior build/bundle step needed

9. **Existing functionality preserved**
   - Given all changes are applied
   - When using chat, brain, config, and review features
   - Then all existing functionality works identically to before

## Metadata
- **Complexity**: Medium
- **Labels**: performance, rho-web, no-build, compression, lazy-rendering, websocket
- **Required Skills**: Node.js/Hono middleware, vanilla JS, IntersectionObserver, WebSocket, Alpine.js reactivity
