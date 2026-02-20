# Review Notes

## Consistency Check
- ✅ Web architecture sections in `README.md` and `AGENTS.md` now explicitly document TS/JS no-build split.
- ✅ Server split files in `web/` match current route-module structure.
- ✅ Session reader split is consistent with exported API surface in `web/session-reader.ts`.

## Completeness Check
- ✅ Core domains (CLI, extensions, skills, web backend/frontend, tests) are covered.
- ✅ Primary interfaces/endpoints and workflows are documented.
- ⚠️ README project tree still requires occasional manual upkeep as module files evolve.

## Identified Gaps / Risks
1. Browser chat module composition currently imports broad helper bundles into feature modules; this is explicit but still heavy.
2. No frontend build step means browser-side JS must remain hand-maintained as JS modules.
3. Route modules share mutable context via `server-core.ts`; acceptable, but further context object isolation could improve testability.

## Recommendations
- Add a small docs-check script that validates key filenames referenced in README project structure.
- Add a thin architecture smoke test that verifies `web/server.ts` imports/registers all route modules.
- If frontend complexity keeps growing, consider introducing optional esbuild for typed browser source.
