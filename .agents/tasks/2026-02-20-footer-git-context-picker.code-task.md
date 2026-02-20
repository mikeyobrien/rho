# Task: Clickable footer project picker with session-scoped git context

## Description
Make the footer Git context element clickable. Clicking it opens a picker that lets the user choose a Git repository under a configured `projects_dir`.

Selection is **repo-only** (no commit picker). The selected repo context is tied to the currently loaded chat session, and the footer + review page reflect that session-scoped context.

## Background
The footer currently shows project/branch. Next step is turning it into a session-aware project switcher across local repos.

Behavior requested:
- config key should be **top-level** (`projects_dir`) so it can be shared by web and TUI workflows
- default: `~/.rho/projects`
- user override target: `~/projects`
- desktop/larger screens show full path in footer; smaller screens keep compact format
- AGENTS handling should be **automatic and abstracted away** (no manual pin action)

## Reference Documentation
**Required:**
- `templates/init.toml`
- `cli/config.ts`
- `web/server-git-routes.ts`
- `web/public/index.html`
- `web/public/js/chat/chat-model-and-extension-ui.js`
- `web/public/js/chat/chat-session-ui.js`
- `web/public/js/review-panel.js`

**Pi best-practice references (required for AGENTS behavior):**
- `/home/mobrienv/.npm-global/lib/node_modules/@mariozechner/pi-coding-agent/README.md` (Context Files)
- `/home/mobrienv/.npm-global/lib/node_modules/@mariozechner/pi-coding-agent/docs/sdk.md` (cwd + DefaultResourceLoader context discovery)
- `/home/mobrienv/.npm-global/lib/node_modules/@mariozechner/pi-coding-agent/examples/sdk/07-context-files.ts`

**Additional References (if relevant):**
- `tests/test-config.ts`
- `tests/test-web-session-usage.ts`
- `tests/test-web-line-limit.ts`

## Technical Requirements
1. Add **top-level** `projects_dir` parsing in `cli/config.ts`:
   - default to `~/.rho/projects` when unset
   - expand `~` and normalize to absolute path
2. Update `templates/init.toml` to document top-level `projects_dir` and include example override `~/projects`.
3. Add backend APIs in `web/server-git-routes.ts`:
   - `GET /api/git/projects` -> list repositories under `projects_dir`
   - `POST /api/git/context` -> set session-scoped context `{ sessionId, repoId }`
   - (optional if needed) `GET /api/git/context?sessionId=...` -> resolve current session context
4. Remove commit-selection scope from this task (no `/api/git/commits`, no commit persistence).
5. Store git context as **session-scoped repo cwd mapping** (no commit/ref persistence).
6. Footer UI:
   - project label is clickable/focusable
   - opens repo picker modal/popover
   - desktop (`>=1024px`) shows full `path/branch`
   - smaller screens show compact `project/branch`
7. Session coupling:
   - context applies to active chat session only
   - when switching chat sessions, footer and review page reflect the selected session’s repo context
   - design with future parallel session support in mind (no singleton global context assumption)
8. AGENTS behavior must be automatic and abstracted:
   - no explicit “pin AGENTS.md” user action
   - implement idiomatic pi approach based on docs (cwd-driven AGENTS discovery via DefaultResourceLoader)
   - include a short design note in implementation artifacts describing the chosen mechanism and why
9. Security and validation:
   - reject path traversal and absolute path injection
   - only allow repos inside resolved `projects_dir`
   - graceful empty-state when `projects_dir` does not exist or has no repos
10. Keep all `web/**/*.ts` and `web/**/*.js` files at `<= 500` lines.

## Dependencies
- Existing git context plumbing in `web/server-git-routes.ts`
- Existing footer rendering in `web/public/js/chat/chat-model-and-extension-ui.js`
- Existing session UI state in `web/public/js/chat/session-ui-state.js`
- Config parser in `cli/config.ts`
- Existing `git_context_changed` UI event channel

## Implementation Approach
1. Add top-level `projects_dir` config model + normalization utility.
2. Implement safe repo discovery under `projects_dir` and stable repo IDs.
3. Implement session-scoped context set/get endpoints.
4. Update git status resolution path to use session-scoped context (with sane fallback).
5. Add repo picker UI and wire footer click + session switch synchronization.
6. Ensure review page reads the same active session context source as footer.
7. Implement AGENTS auto-application via idiomatic pi mechanism (cwd/resource-loader based), not manual pinning UI.
8. Add tests for config, route guards, session switching sync, and AGENTS auto-behavior.
9. Run manual end-to-end verification with Playwriter CLI for all acceptance criteria.

## Acceptance Criteria

1. **Top-level projects_dir default works**
   - Given no `projects_dir` is set in `init.toml`
   - When `/api/git/projects` is queried
   - Then repositories are listed from `~/.rho/projects`.

2. **Top-level projects_dir override works**
   - Given `projects_dir = "~/projects"` in `init.toml`
   - When `/api/git/projects` is queried
   - Then repositories are listed from `~/projects`.

3. **Footer element is interactive**
   - Given chat view is open
   - When the footer project label is clicked (or keyboard-activated)
   - Then a repo picker opens.

4. **Repo-only selection updates context**
   - Given a repo is selected for active session `S1`
   - When user confirms
   - Then session context is updated for `S1` and UI updates immediately.

5. **Session switching reflects session context**
   - Given `S1` is mapped to repo A and `S2` is mapped to repo B
   - When user switches between `S1` and `S2`
   - Then footer and review page context switch accordingly.

6. **Responsive footer formatting**
   - Given selected repo context with branch
   - When viewport is desktop/larger
   - Then footer shows full `path/branch`.
   - When viewport is smaller
   - Then footer shows compact `project/branch`.

7. **AGENTS auto-loading is abstracted**
   - Given a selected repo contains `AGENTS.md`
   - When session context is applied
   - Then AGENTS instructions are applied through idiomatic pi context discovery, without manual pin action.

8. **No commit-picker behavior**
   - Given the picker UI
   - When user opens it
   - Then only repo selection is presented (no commit selection UI/API).

9. **Safety checks enforced**
   - Given malformed/traversal repo identifiers
   - When routes are called
   - Then requests are rejected with 4xx and no filesystem escape occurs.

10. **Verification discipline**
   - Given implementation is complete
   - When verification runs
   - Then automated tests pass, web line limit passes, and Playwriter manual verification covers all acceptance criteria.

## Implementation Notes
- Session-scoped repo context is persisted in `~/.rho/git-context-sessions.json` keyed by session ID.
- RPC startup now resolves session ID hints and starts/reuses the RPC process with the session repo `cwd`.
- This keeps AGENTS behavior automatic and idiomatic: pi discovers `AGENTS.md` from `cwd` via its normal context loader, with no manual pinning UX.

## Metadata
- **Complexity**: Medium
- **Labels**: rho-web, git, session-state, config, pi-context, security
- **Required Skills**: TypeScript, Hono routes, frontend state/UI wiring, session-scoped state design, secure path handling, Playwriter E2E verification
