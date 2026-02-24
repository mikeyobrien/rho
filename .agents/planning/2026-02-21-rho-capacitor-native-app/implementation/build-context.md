# Build Context — 2026-02-21-rho-capacitor-native-app

## Source artifacts loaded

- Design: `../design/detailed-design.md`
- Plan: `./plan.md`
- Research:
  - `../research/rho-web-baseline-and-gaps.md`
  - `../research/capacitor-security-and-session-patterns.md`
  - `../research/android-networking-and-release-readiness.md`
  - `../research/risk-register-and-mitigation-plan.md`
  - `../research/dynamic-host-architecture-spike.md`

## Validation strategy (user-confirmed)

Use manual + automated verification with human-like app interaction whenever feasible:

1. **Automated checks**
   - `npm run -s mobile:typecheck`
   - `npm run -s mobile:lint`
   - `npm run -s mobile:build`
   - `cd mobile/rho-android && npm test -- --runInBand`

2. **Web/server parity checks**
   - `npx -y tsx tests/test-web-mobile-auth.ts`
   - `npx -y tsx tests/test-web-mobile-auth-gate.ts`
   - `npm run -s parity:smoke`
   - `npm run -s parity:gate`

3. **Manual/runtime checks (environment permitting)**
   - `npm run -s mobile:sync`
   - Android Gradle/AAB build checks when Java/SDK are available.

4. **File verification**
   - Read modified files to verify auth boundaries, fail-closed behavior, and plan alignment.

## Current checklist state

- Total steps: 10
- Completed: 10
- Remaining: 0
- Build status: implementation complete with documented environment limitations for local Android signing runtime.

## Final implementation footprint

### Server/auth
- `web/server-mobile-auth-routes.ts`
- `web/server-mobile-auth-middleware.ts`
- `web/server-mobile-auth-state.ts`
- `web/config.ts` (mobile auth config parsing)
- `web/server.ts` (route/middleware wiring)

### Mobile shell
- `mobile/rho-android/src/index.ts`
- `mobile/rho-android/src/connection-coordinator.ts`
- `mobile/rho-android/src/app-lifecycle.ts`
- `mobile/rho-android/src/session-monitor.ts`
- `mobile/rho-android/src/http-policy.ts`
- `mobile/rho-android/src/storage/profile-repository.ts`
- `mobile/rho-android/src/storage/secure-token-store.ts`

### Android platform/release
- `mobile/rho-android/android/app/src/main/AndroidManifest.xml`
- `mobile/rho-android/android/app/src/main/res/xml/network_security_config.xml`
- `mobile/rho-android/android/app/build.gradle` (env-based release signing)

### Test + parity harness
- `tests/test-web-mobile-auth.ts`
- `tests/test-web-mobile-auth-gate.ts`
- `tests/test-mobile-parity-smoke.ts`
- `tests/parity-checklist.md`
- mobile Jest tests under `mobile/rho-android/tests/*`

### CI/release
- `.github/workflows/mobile-sanity.yml`
- `.github/workflows/parity-gate.yml`
- `.github/workflows/android-release.yml`
- `docs/android-release-runbook.md`

## Residual risks

- Local `./gradlew` release/debug verification is limited in this environment when Java/Android SDK are unavailable.
- Mobile auth sessions are in-memory server state (restart invalidates sessions).
- WS auth-failure fast-path depends on emitted failure signals from the embedded web container; polling fallback is in place.
