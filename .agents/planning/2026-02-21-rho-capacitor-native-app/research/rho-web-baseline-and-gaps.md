# rho-web Baseline and Integration Gaps

## Scope

Audit the current rho web implementation and identify early integration gaps for an Android-first Capacitor thin-wrapper app with:
- user-defined host+port profiles,
- native-only token handling,
- full route/feature parity,
- minimal shell additions.

## Current rho-web baseline (repo evidence)

### 1) Web server assumes trusted/local operator use

- Server binds to `0.0.0.0` by default in `rho web` command flow.
  - `cli/commands/web.ts` (`DEFAULT_HOST = "0.0.0.0"`, server listen path).
- Route modules expose broad APIs (`/api/config`, `/api/sessions`, `/api/memory`, `/api/tasks`, `/api/git/*`, `/api/rpc/sessions`) without a shared auth middleware.
  - `web/server-*.ts` route registration.

### 2) Frontend assumes same-origin API + WS

- API calls are relative (`/api/...`) and WebSocket URL is derived from `window.location`.
  - `web/public/js/chat/rendering-and-usage.js` (`buildWsUrl()`), multiple `fetch("/api/...")` usages.
- This is good for parity if the app loads the remote rho host directly, but incompatible with token-in-header requirements unless the server adds session bootstrap/auth logic.

### 3) Current review auth is URL token scoped, not general app auth

- Review routes validate per-review token query param (`?token=`).
  - `web/server-core.ts` + `web/server-review-routes.ts`.
- No general user/app auth layer exists for non-review APIs.

### 4) Web UI currently depends on external CDNs

- `web/public/index.html` and `web/public/review/index.html` load scripts/fonts from unpkg/jsdelivr/cdnjs/google fonts.
- For mobile release reliability and deterministic behavior, this is a risk (network dependency, CDN outage, asset drift).

## Architecture delta required

```mermaid
flowchart LR
  A[Capacitor Shell] --> B[Profile: scheme/host/port]
  B --> C[Native secure token store]
  C --> D[Native bootstrap call]
  D --> E[/api/mobile/auth/exchange]
  E --> F[HttpOnly mobile session cookie]
  F --> G[Embedded rho web UI]
  G --> H[/api/* + /ws same-origin session auth]
```

## Early surprises / likely implementation blockers

1. **No app-level auth exists today in rho-web**
   - Must add auth/session primitives before mobile shell can be secure.

2. **Capacitor dynamic-host model is non-trivial**
   - Multi-profile arbitrary hosts conflict with static allowlist patterns (`server.url` / `allowNavigation` are generally not a production-favored path for arbitrary external origins).

3. **HTTP support requirement increases release/security complexity**
   - Android cleartext allowances require explicit manifest/network config choices.

4. **Feature parity + no regressions implies auth retrofit must be transparent**
   - Existing browser workflows and WebSocket session behavior cannot regress while adding auth.

## Research implications for design phase

- Prefer server-issued short-lived HttpOnly mobile session after native token exchange.
- Keep tokens entirely out of web JS and out of URL params.
- Add explicit auth gate for all `/api/*` and `/ws` except public health/static paths.
- Treat mobile parity as an auth transport retrofit, not a UI rewrite.

## Sources

### Repository
- `cli/commands/web.ts`
- `web/server.ts`
- `web/server-core.ts`
- `web/server-config-sessions-routes.ts`
- `web/server-rpc-ws-routes.ts`
- `web/server-tasks-memory-routes.ts`
- `web/public/js/chat/rendering-and-usage.js`
- `web/public/index.html`
- `web/public/review/index.html`

### External
- https://capacitorjs.com/docs/config
- https://capacitorjs.com/docs/guides/security

## Connections

- [[../idea-honing.md]]
- [[../rough-idea.md]]
- [[capacitor-security-and-session-patterns.md]]
- [[android-networking-and-release-readiness.md]]
- [[risk-register-and-mitigation-plan.md]]
- [[_index]]
- [[openclaw-runtime-visibility-inspiration]]
