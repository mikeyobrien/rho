# Mobile Parity Checklist — Step 9

Tracks feature parity between the rho-web browser surface and the Capacitor
Android wrapper.  Each row maps a route/feature to its smoke-test coverage and
expected behaviour under mobile auth.

> **Gate**: `npm run parity:gate` must be green before any PR to `main` that
> touches `web/`, `mobile/`, or `.github/workflows/` is merged.

---

## Auth Exchange

| # | Feature | Endpoint | Auth Required | Smoke Test | Status |
|---|---------|----------|---------------|------------|--------|
| A1 | Exchange bearer token → session cookie | `POST /api/auth/exchange` | No (public) | § 1 | ✅ |
| A2 | Reject missing Authorization header | `POST /api/auth/exchange` | No | § 1 | ✅ |
| A3 | Reject invalid/wrong bearer token | `POST /api/auth/exchange` | No | § 1 | ✅ |
| A4 | Cookie is HttpOnly | `POST /api/auth/exchange` | No | § 1 | ✅ |
| A5 | Auth status check | `GET /api/auth/status` | No (public) | § 6 | ✅ |
| A6 | Session logout + cookie clear | `POST /api/auth/logout` | Session | § 6 | ✅ |

---

## Auth Gate (Middleware)

| # | Feature | Endpoint | Auth Required | Smoke Test | Status |
|---|---------|----------|---------------|------------|--------|
| G1 | Health endpoint public | `GET /api/health` | No | § 0 | ✅ |
| G2 | Sessions list blocked without session | `GET /api/sessions` | Yes | § 0 | ✅ |
| G3 | Sessions new blocked without session | `POST /api/sessions/new` | Yes | § 0 | ✅ |
| G4 | Config blocked without session | `GET /api/config` | Yes | § 0 | ✅ |
| G5 | Tasks blocked without session | `GET /api/tasks` | Yes | § 0 | ✅ |
| G6 | Memory blocked without session | `GET /api/memory` | Yes | § 0 | ✅ |
| G7 | Review sessions blocked without session | `GET /api/review/sessions` | Yes | § 0 | ✅ |
| G8 | Review submissions blocked without session | `GET /api/review/submissions` | Yes | § 0 | ✅ |
| G9 | Expired session rejected | `GET /api/sessions` | Yes | § 6 | ✅ |
| G10 | Post-logout session rejected | `GET /api/sessions` | Yes | § 6 | ✅ |

---

## Sessions / Fork

| # | Feature | Endpoint | Auth Required | Smoke Test | Status |
|---|---------|----------|---------------|------------|--------|
| S1 | List sessions | `GET /api/sessions` | Yes | § 2 | ✅ |
| S2 | Create new session | `POST /api/sessions/new` | Yes | § 2 | ✅ |
| S3 | Fork session — auth gate passes (400 on empty session is expected) | `POST /api/sessions/:id/fork` | Yes | § 2 | ✅ |
| S4 | New session returns sessionId | `POST /api/sessions/new` | Yes | § 2 | ✅ |

---

## WebSocket Chat

| # | Feature | Endpoint | Auth Required | Smoke Test | Status |
|---|---------|----------|---------------|------------|--------|
| W1 | WS handshake rejected without session | `WS /ws` | Yes | § 3 | ✅ |
| W2 | WS handshake allowed with valid session | `WS /ws` | Yes | § 3 | ✅ |
| W3 | WS streaming / ping flow | `WS /ws` (live) | Yes | manual / e2e | 🔲 |

> W3 requires a live WebSocket server and is covered by the playwriter E2E suite
> (`tests/e2e/`) rather than the unit smoke harness.

---

## Tasks / Memory / Config

| # | Feature | Endpoint | Auth Required | Smoke Test | Status |
|---|---------|----------|---------------|------------|--------|
| T1 | Get config | `GET /api/config` | Yes | § 4 | ✅ |
| T2 | List tasks | `GET /api/tasks` | Yes | § 4 | ✅ |
| T3 | List memory | `GET /api/memory` | Yes | § 4 | ✅ |

---

## Review Flows

| # | Feature | Endpoint | Auth Required | Smoke Test | Status |
|---|---------|----------|---------------|------------|--------|
| R1 | List review sessions | `GET /api/review/sessions` | Yes | § 5 | ✅ |
| R2 | Create review session | `POST /api/review/sessions` | Yes | § 5 | ✅ |
| R3 | List review submissions | `GET /api/review/submissions` | Yes | § 5 | ✅ |
| R4 | Claim/resolve submission | `POST /api/review/submissions/:id/claim` | Yes | existing web tests | ✅ |

---

## Legend

| Symbol | Meaning |
|--------|---------|
| ✅ | Covered by automated smoke or existing web test |
| 🔲 | Manual / E2E only — not in unit harness |
| ❌ | Gap — not yet covered |

---

## Running the Gate

```bash
# Quick parity smoke only
npm run parity:smoke

# Full gate (parity smoke + mobile typecheck/lint)
npm run parity:gate
```

## CI Integration

The `.github/workflows/parity-gate.yml` workflow runs `parity:gate` on every PR
targeting `main` and blocks merge if any check fails.
