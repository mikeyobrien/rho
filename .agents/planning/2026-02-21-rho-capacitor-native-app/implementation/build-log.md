# Build Log — 2026-02-21-rho-capacitor-native-app

## Session start

- Timestamp (UTC): 2026-02-21T23:36:05Z
- Start step: 1
- Execution mode: sequential step execution with Gemini 3.1 delegation + validation gates.

## Step 1 — Create Android Capacitor app shell and repo wiring

- Timestamp (UTC): 2026-02-22T00:15:37Z
- Validation result: PASS
- Commands run:
  - `npm run -s mobile:install`
  - `npm run -s mobile:typecheck`
  - `npm run -s mobile:lint`
  - `npm run -s mobile:build`
  - `npm run -s mobile:sync`
- Notable decisions:
  - Added dedicated `mobile/rho-android/` shell.
  - Added mobile scripts in root `package.json`.
  - Added `.github/workflows/mobile-sanity.yml`.

## Step 2 — Implement profile metadata store and secure token store

- Timestamp (UTC): 2026-02-22T01:10:26Z
- Validation result: PASS
- Delegation:
  - `subagent` -> `gemini-coder` (`google/gemini-3.1-pro-preview`)
- Commands run:
  - `npm run -s mobile:typecheck`
  - `npm run -s mobile:lint`
  - `npm run -s mobile:build`
  - `cd mobile/rho-android && npm test -- --runInBand`
  - `npm run -s mobile:sync`
- Notable decisions:
  - Hardened `ProfileRepository.saveProfile()` to persist only safe metadata fields.
  - Added negative test proving token never lands in plain `Preferences` profile JSON.

## Step 3 — Add rho-web mobile auth exchange and session primitives

- Timestamp (UTC): 2026-02-22T01:39:00Z
- Validation result: PASS
- Delegation:
  - `subagent` -> `gemini-coder` (`google/gemini-3.1-pro-preview`)
- Commands run:
  - `npx -y tsx tests/test-web-mobile-auth.ts`
- Notable decisions:
  - Added `POST /api/mobile/auth/exchange`, `POST /api/mobile/auth/logout`, `GET /api/mobile/auth/status`.
  - Added hashed-token validation + short-lived HttpOnly mobile session cookie issuance.
  - Added mobile auth config parsing in `web/config.ts`.

## Step 4 — Gate rho-web `/api/*` and `/ws` with mobile session auth

- Timestamp (UTC): 2026-02-22T01:55:00Z
- Validation result: PASS
- Delegation:
  - `subagent` -> `gemini-coder` (`google/gemini-3.1-pro-preview`)
- Commands run:
  - `npx -y tsx tests/test-web-mobile-auth-gate.ts`
  - `npx -y tsx tests/test-web-rpc-sessions-api.ts`
  - `npx -y tsx tests/test-web-chat-ws-routing.ts`
- Notable decisions:
  - Added middleware guard for `/api/*` and `/ws`.
  - Exempted `/api/health` and mobile auth bootstrap endpoints.
  - Preserved existing behavior when mobile auth is disabled.

## Step 5 — Connect native shell flow (profile select -> auth exchange -> open rho-web)

- Timestamp (UTC): 2026-02-22T02:15:00Z
- Validation result: PASS
- Delegation:
  - `subagent` -> `gemini-coder` (`google/gemini-3.1-pro-preview`)
- Commands run:
  - `npm run -s mobile:typecheck`
  - `npm run -s mobile:lint`
  - `npm run -s mobile:build`
  - `cd mobile/rho-android && npm test -- --runInBand`
- Notable decisions:
  - Added `ConnectionCoordinator` for token read -> auth exchange -> web container open.
  - Added explicit handling for malformed URL / network / invalid token / missing token.
  - Updated fetch calls to use cookie-aware flow (`credentials: 'include'`).

## Step 6 — Implement startup resume, last-used profile, and in-app profile switching

- Timestamp (UTC): 2026-02-22T02:30:00Z
- Validation result: PASS
- Delegation:
  - `subagent` -> `gemini-coder` (`google/gemini-3.1-pro-preview`)
- Commands run:
  - `npm run -s mobile:typecheck`
  - `npm run -s mobile:lint`
  - `npm run -s mobile:build`
  - `cd mobile/rho-android && npm test -- --runInBand`
- Notable decisions:
  - Added `lastUsedProfileId` persistence in `ProfileRepository`.
  - Added `AppLifecycle` orchestration for startup auto-connect and clean profile switching.
  - Added in-app web container chrome with switch-profile action.

## Step 7 — Handle auth/session failure recovery (401 + WS auth failures)

- Timestamp (UTC): 2026-02-22T02:45:00Z
- Validation result: PASS
- Delegation:
  - `subagent` -> `gemini-coder` (`google/gemini-3.1-pro-preview`)
- Commands run:
  - `npm run -s mobile:typecheck`
  - `npm run -s mobile:lint`
  - `npm run -s mobile:build`
  - `cd mobile/rho-android && npm test -- --runInBand`
- Notable decisions:
  - Added `SessionMonitor` auth-status polling + explicit failure routing.
  - Added deterministic recovery path: clear active session, teardown web container, return to picker, prompt re-auth.
  - Added WS-auth-failure signal path via `postMessage` hook + monitor test coverage.

## Step 8 — Implement HTTP/HTTPS policy UX and Android network security config

- Timestamp (UTC): 2026-02-22T03:00:00Z
- Validation result: PASS
- Delegation:
  - `subagent` -> `gemini-coder` (`google/gemini-3.1-pro-preview`)
- Commands run:
  - `npm run -s mobile:typecheck`
  - `npm run -s mobile:lint`
  - `npm run -s mobile:build`
  - `cd mobile/rho-android && npm test -- --runInBand`
- Notable decisions:
  - Added profile protocol badges and HTTP warning/confirm policy helper.
  - Added matrix tests for localhost HTTP, LAN HTTP, and public HTTPS paths.
  - Added Android network security config + cleartext-enabled manifest settings for explicit HTTP support.

## Step 9 — Build parity + regression harness across rho-web and mobile wrapper

- Timestamp (UTC): 2026-02-22T03:20:00Z
- Validation result: PASS
- Delegation:
  - `subagent` -> `gemini-coder` (`google/gemini-3.1-pro-preview`)
- Commands run:
  - `npm run -s parity:smoke`
  - `npm run -s parity:web`
  - `npm run -s parity:gate`
- Notable decisions:
  - Added `tests/test-mobile-parity-smoke.ts` with traceable pass/fail coverage for sessions/new/fork, `/ws`, tasks/memory/config, and review flows.
  - Added `tests/parity-checklist.md` parity matrix.
  - Added `.github/workflows/parity-gate.yml` PR gate.

## Step 10 — Ship release-ready Android pipeline (signing, AAB, CI gates)

- Timestamp (UTC): 2026-02-22T03:35:00Z
- Validation result: PASS (CI/runtime design complete; local release build toolchain-limited)
- Delegation:
  - `subagent` -> `gemini-coder` (`google/gemini-3.1-pro-preview`)
- Commands run:
  - `npm run -s parity:gate`
  - `npm run -s mobile:build`
  - `npm run -s mobile:sync`
- Notable decisions:
  - Added env-based Android release signing config in `mobile/rho-android/android/app/build.gradle`.
  - Added `.github/workflows/android-release.yml` with secrets gate, parity gate, version checks, signed `bundleRelease`, checksum, and AAB artifact upload.
  - Added `docs/android-release-runbook.md` with required secrets and dry-run checklist.

## Final status

- Checklist completion: **10 / 10 complete**.
- End-to-end validation gates passing in this environment:
  - `npm run -s mobile:typecheck`
  - `npm run -s mobile:lint`
  - `npm run -s mobile:build`
  - `cd mobile/rho-android && npm test -- --runInBand`
  - `npm run -s parity:gate`
- Environment limitation:
  - Local Gradle Android assemble/release verification may fail without local Java/Android SDK provisioning; CI workflow now covers signed AAB path with required secrets.

## Post-plan connectivity hardening — `tidepool:3141` real-device fix

- Timestamp (UTC): 2026-02-22T05:20:00Z
- Validation result: PASS (real Samsung device over wireless ADB)
- Commands run:
  - `npx -y tsx tests/test-web-mobile-auth.ts`
  - `npm run -s mobile:typecheck`
  - `cd mobile/rho-android && npm test -- --runInBand`
  - `npm run -s mobile:build && npm run -s mobile:sync`
  - `cd mobile/rho-android/android && ./gradlew assembleDebug`
  - `adb -s 192.168.1.62:39311 install -r app/build/outputs/apk/debug/app-debug.apk`
- Root causes addressed:
  - Launch button remained disabled after save without an explicit card reselect.
  - WebView mixed-content block (`https://localhost` shell -> `http://tidepool:3141`).
  - CORS preflight block on `/api/mobile/auth/exchange` from shell origin `http://localhost`.
  - False `missing_cookie` session teardown in cross-host mode from shell polling.
- Notable decisions:
  - Set Capacitor Android shell scheme to `http` for explicit HTTP-profile support.
  - Added mobile-auth endpoint CORS handling for Capacitor localhost origins.
  - Taught `SessionMonitor` to ignore cross-host `missing_cookie` false positives.
  - Verified real-device connect flow to `http://tidepool:3141` remains stable past polling interval.
