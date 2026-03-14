# Dynamic Host Architecture Spike (Capacitor Android)

## Research question

How should an Android-first Capacitor app support **user-defined rho host+port profiles** while preserving:
- native-only token handling,
- thin-wrapper parity with existing rho-web routes/features,
- release-ready posture.

## Constraints from clarified requirements

- Multi-profile host+port (including localhost/LAN).
- API token auth only; token per profile.
- Token must remain native-only.
- Thin wrapper, full rho-web feature parity.
- Android first, release-ready, standard OS trust.
- HTTP allowed in v1.

## Architecture options

### Option A — Direct remote WebView via Capacitor `server.url` / broad `allowNavigation`

**Summary:** load selected host as the app WebView target directly.

- Pros: strongest parity (server serves full rho-web UI unchanged).
- Cons: Capacitor docs flag `server.url` / `allowNavigation` as not intended for broad production use; bigger bridge/trust risk for arbitrary hosts.
- Risk: high, especially with arbitrary user-entered domains.

### Option B — Local bundled UI + dynamic remote API base

**Summary:** keep app origin local, but point API/WS traffic at selected remote host.

- Pros: aligns with conservative Capacitor deployment model.
- Cons: substantial web-layer changes (base URL plumbing, CORS/WS/cookie complexity, origin/storage edge cases), higher parity drift risk.
- Risk: medium-high (complexity/regression risk).

### Option C — Split-trust shell (recommended for this project)

**Summary:**
- Keep a trusted local native shell for profile/token/session bootstrap.
- After bootstrap, open selected rho host in an isolated in-app webview context with reduced native bridge exposure.

- Pros: keeps thin-wrapper parity (remote rho-web unchanged) while reducing plugin bridge attack surface compared to Option A.
- Cons: more native wiring than Option A; needs explicit session bootstrap/cookie handoff.
- Risk: medium (manageable with strict controls).

### Option D — Stable gateway/BFF origin that routes to selected hosts

**Summary:** app connects to one controlled origin; backend brokers selected hosts.

- Pros: strongest client trust boundary and easier mobile policy posture.
- Cons: adds infra/ops complexity and latency; not as KISS for v1.
- Risk: medium (engineering/ops heavy).

## Tradeoff table

| Option | Parity | Security posture | Complexity | v1 fit |
|---|---|---|---|---|
| A: direct remote via server.url/allowNavigation | Excellent | Weakest (for arbitrary hosts) | Low | Risky |
| B: local UI + remote APIs | Medium | Better | High | Fragile |
| C: split-trust shell + isolated remote webview | Excellent | Better than A | Medium | **Best balance** |
| D: gateway/BFF broker | High | Strongest | High | Heavy for v1 |

## Recommended direction for design

Use **Option C** for v1:

1. Native profile manager stores token in secure storage.
2. Native performs token exchange with selected host (`/api/mobile/auth/exchange`).
3. Server issues short-lived HttpOnly session.
4. App opens remote rho-web UI in constrained webview context.
5. On 401/session expiry, return to profile picker + re-auth flow.

```mermaid
flowchart LR
  A[Native shell: profiles + secure token store] --> B[Native auth exchange]
  B --> C[Selected rho host]
  C --> D[Set HttpOnly mobile session]
  D --> E[Open remote rho-web UI]
  E --> F[/api/* + /ws via session]
  F --> G[On auth fail -> back to profile picker]
```

## Controls to require early

- Strict scheme/host validation before navigation.
- HTTPS-first UX; explicit HTTP warning state.
- Keep token out of web JS and URLs.
- Minimize/disable native bridge exposure in remote-host context where feasible.
- Regression matrix covering sessions, WS, review routes, tasks/memory/config flows.

## Early failure modes to test in spike harness

- Profile switch between HTTPS host and HTTP localhost.
- Session bootstrap success but WS handshake failure.
- Cookie/session persistence across app restart.
- Session expiry -> automatic fallback to picker/re-auth.
- Host typo/malformed URL hard-fail behavior.

## Sources

- https://capacitorjs.com/docs/config
- https://capacitorjs.com/docs/guides/security
- https://capacitorjs.com/docs/apis/http
- https://capacitorjs.com/docs/apis/inappbrowser
- https://developer.android.com/privacy-and-security/risks/unsafe-uri-loading
- https://developer.android.com/privacy-and-security/risks/insecure-webview-native-bridges
- https://developer.android.com/develop/ui/views/layout/webapps/webview
- https://developer.android.com/develop/ui/views/layout/webapps/managing-webview

## Connections

- [[../idea-honing.md]]
- [[rho-web-baseline-and-gaps.md]]
- [[capacitor-security-and-session-patterns.md]]
- [[android-networking-and-release-readiness.md]]
- [[risk-register-and-mitigation-plan.md]]
- [[_index]]
- [[openclaw-runtime-visibility-inspiration]]
