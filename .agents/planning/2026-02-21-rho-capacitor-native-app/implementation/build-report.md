# Build Report — 2026-02-21-rho-capacitor-native-app

## Summary

- Total steps in plan: **10**
- Steps executed: **10**
- Checklist state: **10/10 complete**
- Primary execution mode: sequential, step-gated, Gemini 3.1 delegation + local verification

## Attempt quality

- Passed on first implementation attempt: **10**
- Required retries after validation failure: **0 hard retries**
- Post-step hardening edits: **yes** (cookie-credential handling, WS test noise cleanup, docs/workflow tightening)

## Final implemented scope

### Mobile shell
- Multi-profile metadata + per-profile secure token storage
- Connection coordinator: secure token read -> auth exchange -> open web container
- Startup auto-resume from `lastUsedProfileId`
- In-app profile switching with teardown/logout best effort
- Session failure recovery (status polling + explicit failure signal handling)
- HTTP/HTTPS security-mode UX (badges + explicit HTTP confirmation)

### rho-web server
- Mobile auth endpoints:
  - `POST /api/mobile/auth/exchange`
  - `POST /api/mobile/auth/logout`
  - `GET /api/mobile/auth/status`
- Hashed token validation + short-lived HttpOnly session cookie
- Middleware auth gate for `/api/*` and `/ws` with exempt public/bootstrap routes
- Disabled-mode compatibility preserved for existing web workflows

### Android platform/release
- `network_security_config.xml` added and wired in manifest
- Cleartext support explicitly configured for v1 HTTP requirement
- Env-based release signing path in Gradle
- CI release workflow builds signed AAB + checksum + artifact upload

### Parity/regression harness
- `tests/test-mobile-parity-smoke.ts` for route/path smoke matrix
- `tests/parity-checklist.md` traceability matrix
- PR CI parity gate workflow

## Validation results

### Mobile
- `npm run -s mobile:typecheck` ✅
- `npm run -s mobile:lint` ✅
- `npm run -s mobile:build` ✅
- `cd mobile/rho-android && npm test -- --runInBand` ✅ (7 suites, 53 tests)

### Web/mobile-auth + parity
- `npx -y tsx tests/test-web-mobile-auth.ts` ✅
- `npx -y tsx tests/test-web-mobile-auth-gate.ts` ✅
- `npm run -s parity:smoke` ✅
- `npm run -s parity:gate` ✅

### Post-plan real-device verification (`tidepool:3141`)
- Wireless ADB validation on `SM_F966U1` ✅
- `POST /api/mobile/auth/exchange` observed on server with CORS preflight ✅
- Rho web bundle/API/WS traffic loaded from `http://tidepool:3141` ✅
- Session remained stable past monitor interval (no forced `missing_cookie` fallback) ✅

## Deviations from original design

- Session storage is currently in-memory server state (restart invalidates sessions). This is acceptable for v1 but not durable across server restarts.
- WS auth-failure fast path in the shell supports explicit failure signals; fallback polling is the deterministic baseline.

## Known limitations / manual attention

1. Local Android release builds still depend on local Java/Android SDK availability.
2. CI signed AAB path requires GitHub secrets:
   - `ANDROID_KEYSTORE_BASE64`
   - `ANDROID_KEYSTORE_PASSWORD`
   - `ANDROID_KEY_ALIAS`
   - `ANDROID_KEY_PASSWORD`
3. Before distribution, run the runbook checklist in `docs/android-release-runbook.md`.

## Recommended next steps

1. Run Android emulator/device acceptance for profile switching + auth-expiry recovery.
2. Optionally add persistent session backing store (if restart persistence is desired).
3. Wire real WS auth-failure signal emission from web runtime for faster-than-poll recovery.
4. Dry-run `android-release.yml` with secrets in GitHub Actions and validate produced AAB on internal track.
