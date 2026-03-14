# Project Summary

## Project

- **Name:** 2026-02-21-rho-capacitor-native-app
- **Goal:** Make rho frontend installable as an Android native app via Capacitor, with secure remote host connection and native-only token handling.

## Artifacts created

### Core planning
- `rough-idea.md` — initial project statement.
- `idea-honing.md` — full requirements clarification Q&A.

### Research
- `research/rho-web-baseline-and-gaps.md` — current-state repo audit + integration gaps.
- `research/capacitor-security-and-session-patterns.md` — secure auth/token/session design patterns.
- `research/android-networking-and-release-readiness.md` — Android networking and release constraints.
- `research/risk-register-and-mitigation-plan.md` — risk register and mitigation strategy.
- `research/dynamic-host-architecture-spike.md` — focused spike on dynamic host architecture options.

### Design and implementation
- `design/detailed-design.md` — standalone detailed architecture/design spec.
- `implementation/plan.md` — incremental 10-step implementation plan with checklist and demos.

## Design overview

The design chooses a **split-trust thin-wrapper architecture**:
- native shell manages profiles and secure token storage,
- native auth exchange endpoint converts bearer token to short-lived HttpOnly session,
- existing rho-web UI remains the primary runtime surface for full parity,
- token remains native-only and never exposed to web JavaScript.

This balances parity, security posture, and delivery speed for Android v1.

## Implementation plan overview

The implementation plan is sequenced into 10 demoable increments:
1. Android Capacitor shell scaffold.
2. Profile + secure token storage.
3. Server mobile auth exchange/session primitives.
4. API/WS auth middleware.
5. End-to-end connect flow.
6. Startup resume + profile switch.
7. Auth failure recovery.
8. HTTP/HTTPS policy UX + network config.
9. Parity/regression harness.
10. Release-ready signed Android pipeline.

## Suggested next steps

1. Review `implementation/build-report.md` and `implementation/build-log.md` for full execution details.
2. Configure Android signing secrets in GitHub and dry-run `.github/workflows/android-release.yml`.
3. Run device/emulator acceptance for profile switching + auth-expiry recovery UX.
4. Optionally harden session persistence beyond in-memory server sessions if restart continuity is required.

## Areas that may need refinement during build

- Final session cookie attributes for HTTP vs HTTPS profile handling.
- Dynamic host isolation details in the Capacitor web container implementation.
- Exact release hardening scope for third-party frontend CDN dependencies.

## Connections

- [[rough-idea.md]]
- [[idea-honing.md]]
- [[design/detailed-design.md]]
- [[implementation/plan.md]]
- [[research/rho-web-baseline-and-gaps.md]]
- [[research/capacitor-security-and-session-patterns.md]]
- [[research/android-networking-and-release-readiness.md]]
- [[research/risk-register-and-mitigation-plan.md]]
- [[research/dynamic-host-architecture-spike.md]]
- [[openclaw-runtime-visibility-inspiration]]
