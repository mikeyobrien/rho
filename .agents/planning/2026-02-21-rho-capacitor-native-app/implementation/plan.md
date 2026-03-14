# Implementation Plan

## Checklist

- [x] Step 1: Create Android Capacitor app shell and repo wiring
- [x] Step 2: Implement profile metadata store and secure token store
- [x] Step 3: Add rho-web mobile auth exchange and session primitives
- [x] Step 4: Gate rho-web `/api/*` and `/ws` with mobile session auth
- [x] Step 5: Connect native shell flow (profile select -> auth exchange -> open rho-web)
- [x] Step 6: Implement startup resume, last-used profile, and in-app profile switching
- [x] Step 7: Handle auth/session failure recovery (401 + WS auth failures)
- [x] Step 8: Implement HTTP/HTTPS policy UX and Android network security config
- [x] Step 9: Build parity + regression harness across rho-web and mobile wrapper
- [x] Step 10: Ship release-ready Android pipeline (signing, AAB, CI gates)

## Planning instruction

> Convert the design into a series of implementation steps that will build each component in a test-driven manner following agile best practices. Each step must result in a working, demoable increment of functionality. Prioritize best practices, incremental progress, and early testing, ensuring no big jumps in complexity at any stage. Make sure that each step builds on the previous steps, and ends with wiring things together. There should be no hanging or orphaned code that isn't integrated into a previous step.

---

## Step 1: Create Android Capacitor app shell and repo wiring

**Objective**
Create the Android-first Capacitor project scaffold and integrate it into repo scripts/CI without touching existing rho-web behavior.

**Implementation guidance**
- Add a dedicated mobile app directory (e.g., `mobile/rho-android/`).
- Initialize Capacitor Android project and basic shell screen.
- Add npm scripts for mobile sync/build/test entry points.
- Keep shell minimal: profile picker placeholder + launch button to stub flow.

**Test requirements**
- Build check for Android debug target.
- Lint/type checks for new mobile code.
- CI sanity job that compiles shell without server changes.

**Integration with previous work**
- Foundation step; no dependency on prior implementation.

**Demo**
- App installs on Android emulator/device and opens a native shell screen with placeholder profile UI.

---

## Step 2: Implement profile metadata store and secure token store

**Objective**
Persist profile metadata (`name`, `scheme`, `host`, `port`) and per-profile token with secure native storage.

**Implementation guidance**
- Add profile repository for non-secret metadata.
- Add secure storage adapter for token by profile ID.
- Implement create/edit/delete profile flows in shell UI.
- Enforce fail-closed behavior: if secure storage fails, block connect.

**Test requirements**
- Unit tests for profile validation and CRUD.
- Adapter tests for secure token read/write/delete.
- Negative test proving token is never written to plain profile store.

**Integration with previous work**
- Extends Step 1 UI from placeholder to functional profile management.

**Demo**
- User creates two profiles with distinct tokens, closes/reopens app, and sees profiles persisted with tokens retrievable only via secure store path.

---

## Step 3: Add rho-web mobile auth exchange and session primitives

**Objective**
Introduce server-side mobile auth primitives to transform bearer token auth into short-lived web session auth.

**Implementation guidance**
- Add `POST /api/mobile/auth/exchange` and `POST /api/mobile/auth/logout`.
- Add token validator (hashed token config) and session manager.
- Issue short-lived HttpOnly session cookie on successful exchange.
- Add optional auth status endpoint for diagnostics.

**Test requirements**
- Integration tests for success, invalid token, expired/revoked session.
- Cookie issuance assertions (HttpOnly + expected attributes).

**Integration with previous work**
- Server work independent of mobile shell wiring but required before connect flow.

**Demo**
- `curl` with valid bearer token returns success + session cookie; invalid token gets `401`.

---

## Step 4: Gate rho-web `/api/*` and `/ws` with mobile session auth

**Objective**
Apply auth middleware consistently to API and WebSocket paths while preserving normal behavior when auth mode is disabled.

**Implementation guidance**
- Add middleware guard for protected routes (`/api/*`, `/ws`).
- Exempt public/static and mobile auth exchange/logout endpoints.
- Add WS upgrade auth validation path.
- Make behavior config-driven so existing local dev/browser workflows stay intact when not in mobile-auth mode.

**Test requirements**
- Route-level tests for authenticated vs unauthenticated access.
- WS handshake auth pass/fail tests.
- Regression tests for existing rho-web flows when auth gate is disabled.

**Integration with previous work**
- Builds directly on Step 3 session primitives.

**Demo**
- Protected API/WS calls fail without session and pass with valid mobile session cookie.

---

## Step 5: Connect native shell flow (profile select -> auth exchange -> open rho-web)

**Objective**
Wire end-to-end connection from selected profile to authenticated rho-web UI.

**Implementation guidance**
- Implement `ConnectionCoordinator` in native shell.
- On connect: read secure token, call `/api/mobile/auth/exchange`, then open rho-web container for that profile.
- Handle base failure states (network unreachable, invalid token, malformed host).

**Test requirements**
- Integration tests with mocked server responses.
- Error-state UI tests for common failure categories.

**Integration with previous work**
- Uses Step 2 stores and Step 3/4 auth stack.

**Demo**
- Selecting a valid profile opens fully functional rho-web UI; invalid token path shows correction prompt.

---

## Step 6: Implement startup resume, last-used profile, and in-app profile switching

**Objective**
Match required session UX: auto-open last used profile and allow profile switching in app.

**Implementation guidance**
- Persist and load `lastUsedProfileId`.
- Auto-connect to last used profile on startup when available.
- Add in-app switch profile action from web container chrome.
- Ensure switch tears down active session/container cleanly.

**Test requirements**
- App restart tests for last-used auto-open.
- Switch flow tests between two profiles.

**Integration with previous work**
- Extends Step 5 end-to-end flow with lifecycle behavior.

**Demo**
- App restarts into last profile, user switches profile in-app, and new target opens correctly.

---

## Step 7: Handle auth/session failure recovery (401 + WS auth failures)

**Objective**
Provide deterministic recovery for expired/invalid sessions.

**Implementation guidance**
- Detect auth failure patterns from API responses and WS close/error events.
- Clear active session context and return to profile picker.
- Prompt re-auth/token update for affected profile.

**Test requirements**
- Simulated session expiry tests.
- WS auth failure tests.
- Verify no stuck loading state and no silent failure loops.

**Integration with previous work**
- Builds on Step 4 guards and Step 5/6 orchestration.

**Demo**
- Forcibly expired session causes automatic return to profile picker with re-auth prompt.

---

## Step 8: Implement HTTP/HTTPS policy UX and Android network security config

**Objective**
Support required HTTP capability while making connection security mode explicit.

**Implementation guidance**
- Add profile-level protocol indicator badges in shell UI.
- Add explicit user confirmation/warning for HTTP profiles.
- Configure Android network security rules required for allowed HTTP behavior.
- Keep HTTPS path default and frictionless.

**Test requirements**
- Matrix tests: localhost HTTP, LAN HTTP, public HTTPS.
- Verify expected block/warn behavior per protocol.

**Integration with previous work**
- Applies policy constraints to existing connect flow.

**Demo**
- HTTPS profile connects directly; HTTP profile requires confirm then connects with visible insecure-state indicator.

---

## Step 9: Build parity + regression harness across rho-web and mobile wrapper

**Objective**
Prove feature parity and no regressions against existing rho-web behavior.

**Implementation guidance**
- Build parity checklist for all major routes/features.
- Add automated smoke paths for: sessions/new/fork, WS chat streaming, tasks/memory/config, review flows.
- Reuse existing web tests where possible; add mobile-targeted wrappers/harness scripts.

**Test requirements**
- Green parity matrix with traceable pass/fail output.
- Regression gate in CI required before merge.

**Integration with previous work**
- Validates Steps 1-8 as a cohesive product increment.

**Demo**
- Parity report shows required feature set passing on both web and Android wrapper path.

---

## Step 10: Ship release-ready Android pipeline (signing, AAB, CI gates)

**Objective**
Complete production-grade release pipeline for Android distribution.

**Implementation guidance**
- Add signing config and secure secret handling.
- Build signed AAB in CI.
- Add release gates: versioning checks, artifact verification, policy checklist tasks.
- Document release runbook.

**Test requirements**
- CI job produces reproducible signed artifact.
- Dry-run release checklist completed end-to-end.

**Integration with previous work**
- Finalizes deployment path after functional and parity validation.

**Demo**
- CI produces signed AAB ready for internal track distribution, with release checklist attached.

---

## Connections

- [[../design/detailed-design.md]]
- [[../idea-honing.md]]
- [[../research/rho-web-baseline-and-gaps.md]]
- [[../research/capacitor-security-and-session-patterns.md]]
- [[../research/android-networking-and-release-readiness.md]]
- [[../research/risk-register-and-mitigation-plan.md]]
- [[../research/dynamic-host-architecture-spike.md]]
