# Plan: Refactor `web/public/js/chat.js`

## Why

`chat.js` has grown to ~4.7k LOC and currently mixes:
- pure normalization/parsing helpers,
- WebSocket/RPC transport,
- session/fork lifecycle,
- streaming message assembly,
- composer/queue/slash/image handlers,
- extension dialog/toast UI behavior.

This makes maintenance, testing, and safe changes harder.

## Goals

1. Reduce cognitive load by splitting into focused modules.
2. Keep runtime behavior and template contract stable during migration.
3. Preserve existing tests and avoid regressions.
4. End with no single chat module over ~500 LOC.

## Guardrails

- Keep `web/public/js/chat.js` as a stable entrypoint initially.
- Preserve current Alpine method names used by template/tests.
- Do not change behavior while extracting (move first, then improve).
- Run focused tests after each extraction slice.

## Test Baseline (must stay green)

- `tests/test-web-chat-reconnect.ts`
- `tests/test-web-session-usage.ts`
- `tests/test-web-chat-slash.ts`

Recommended before migration:
- add characterization coverage for prompt queue + image flow.

## Target Structure

```txt
web/public/js/chat.js                  # thin compatibility/bootstrap entry
web/public/js/chat/index.js            # Alpine data registration + composition
web/public/js/chat/state.js            # initial reactive state

web/public/js/chat/utils/
  strings.js                           # safeString/clamp/extract helpers
  time.js                              # timestamp + ISO helpers
  usage.js                             # usage parsing + formatting
  markdown.js                          # renderMarkdown/highlightCodeBlocks
  model.js                             # formatModel/context window/thinking helpers

web/public/js/chat/normalize/
  tool-registry.js                     # semantic tool parser + aliases
  content.js                           # normalizeContentItem/normalizeParts
  message.js                           # normalizeMessage

web/public/js/chat/features/
  rpc.js                               # ws connect/reconnect/send/replay/dispatch
  messages.js                          # streaming deltas/tool execution/message end
  sessions.js                          # load/select/apply/new/fork/session labels
  composer.js                          # submit/input/paste/drag/drop/images/queue
  slash.js                             # autocomplete/classify/send slash
  ui.js                                # polling/idle/visibility/scroll/theme/footer
  extensions.js                        # extension dialogs/widget/toasts
```

## Execution Plan (incremental)

### Phase 1 — Extract pure helpers
- Move pure utility functions into `chat/utils/*`.
- Move model/thinking/usage helpers into dedicated files.
- Keep imports wired from `chat.js`.
- No behavior changes.

Validation:
- run 3 baseline web-chat tests + `npm test`.

### Phase 2 — Extract normalization layer
- Move tool semantic registry and content/message normalization to `chat/normalize/*`.
- Keep exact output shapes.

Validation:
- baseline tests + quick manual check on message rendering.

### Phase 3 — Create composed Alpine module
- Add `chat/index.js` and `chat/state.js`.
- Compose feature method objects via spread into one Alpine object.
- Keep `chat.js` as thin shim that registers `rhoChat` from `chat/index.js`.

Validation:
- baseline tests should continue to import `chat.js` unchanged.

### Phase 4 — Extract streaming + RPC features
- Move WebSocket/RPC methods to `features/rpc.js`.
- Move message/tool/stream handlers to `features/messages.js`.
- Keep event routing behavior identical.

Validation:
- emphasize reconnect and sequence-handling tests.

### Phase 5 — Extract sessions + composer + slash
- Move session lifecycle to `features/sessions.js`.
- Move composer/image/queue to `features/composer.js`.
- Move slash autocomplete/command dispatch to `features/slash.js`.

Validation:
- slash tests + manual queue/image smoke.

### Phase 6 — Extract UI and extension affordances
- Move polling/idle/visibility/scroll/footer/theme to `features/ui.js`.
- Move extension dialog/widget/toasts to `features/extensions.js`.

Validation:
- baseline tests + manual extension UI smoke.

### Phase 7 — Cleanup and tighten boundaries
- Remove dead wrappers and duplicate helper paths.
- Keep compatibility exports only where needed.
- Ensure `chat.js` stays thin.

Validation:
- full test suite (`npm test`) and manual end-to-end chat smoke.

## Smoke Checklist (manual)

- Load sessions and select session.
- Send prompt and receive streaming output.
- Simulate reconnect and confirm banner/recovery behavior.
- Slash autocomplete + slash submission.
- Image paste/drop + send.
- Queue prompt during streaming and auto-send after `agent_end`.
- Model and thinking level changes.
- Extension dialogs + toast rendering.

## Done Criteria

- `chat.js` reduced to bootstrap/compat only.
- Functional behavior preserved.
- Baseline tests and full test suite green.
- Module boundaries documented and readable.
