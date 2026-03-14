# Task: Native Live Mode + no-Firebase idle reliability for Android streaming

## Description
Implement the full background reliability architecture for rho Android: a native Live Mode (Foreground Service) for active streaming continuity while locked, plus Idle Mode behavior that reconnects/replays on app-active resume without external push or job-scheduler dependencies.

## Background
Task 01 mitigates orphan timing but does not provide true native background continuity. Full reliability requires moving critical lock-window behavior out of WebView JS and into native Android components.

Current constraints:
- WebView/background lifecycle throttling still causes socket drops on lock.
- Replay primitives (`lastEventSeq`) already exist and should be leveraged.
- Reliability baseline should not require external push credentials/services.

Goal for this task: with Live Mode enabled, active streams survive lock periods that previously failed; with Live Mode disabled, reconnect is replay-safe when the app returns to foreground.

## Reference Documentation
**Required:**
- Design: `.agents/planning/2026-02-21-rho-capacitor-native-app/design/detailed-design.md`
- `.agents/tasks/2026-02-22-android-background-streaming-reliability.code-task.md`
- `.agents/tasks/2026-02-23-android-background-reliability/task-01-orphan-policy-mitigation.code-task.md`
- `mobile/rho-android/src/index.ts`
- `mobile/rho-android/src/app-lifecycle.ts`
- `mobile/rho-android/src/connection-coordinator.ts`
- `mobile/rho-android/src/session-monitor.ts`
- `mobile/rho-android/android/app/src/main/AndroidManifest.xml`
- `mobile/rho-android/android/app/build.gradle`
- `mobile/rho-android/android/app/src/main/java/dev/rhobot/rhoandroid/MainActivity.java`
- `web/server-rpc-ws-routes.ts`
- `web/server-core.ts`
- `web/public/js/chat/rpc-reconnect-runtime.js`
- `web/server-mobile-auth-routes.ts`

**Additional References (if relevant to this task):**
- https://developer.android.com/develop/background-work/services/fgs/changes
- https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start
- https://developer.android.com/develop/background-work/services/fgs/timeout
- https://developer.android.com/develop/background-work/background-tasks/persistent/how-to/long-running

**Note:** You MUST read the detailed design document before beginning implementation. Read additional references as needed for context.

## Technical Requirements
1. Add explicit lifecycle modes and transitions:
   - Live Mode (continuous active-stream reliability)
   - Idle Mode (no external wake path; reconnect on app-active resume)
2. Implement Android Foreground Service for Live Mode with:
   - persistent user-visible notification,
   - compliant service type declarations/permissions,
   - explicit user start/stop controls.
3. Ensure Live Mode does not depend on WebView timers/events for continuity.
4. Implement native path to prevent orphan abort while locked:
   - maintain server lease/heartbeat or equivalent lock-safe liveness mechanism for active Live Mode streams.
5. Wire replay-safe reconnect (`sessionId`, `rpcSessionId`, `lastEventSeq`) so resumed sessions are gap-free and deduped.
6. Keep auth fail-closed for all background paths (revoked/expired -> clear state + prompt re-auth).
7. Add UI affordances for mode status and battery/notification tradeoffs.
8. Preserve existing rho-web parity and keep touched `web/**/*.ts`, `web/**/*.js`, `mobile/**/*.ts` at `<= 500` lines.
9. Enforce policy-safe behavior:
   - no silent-audio keepalive,
   - no hidden/deceptive foreground notifications,
   - no exact-alarm abuse.
10. Remove external push/job-scheduler assumptions from implementation and docs in this task area.

## Dependencies
- Task 01 orphan-policy mitigation complete (or equivalent orphan configurability available).
- Android Foreground Service + notification channel implementation.
- Existing mobile auth exchange/session model.
- Existing replay/reconnect event-sequence support in web stack.

## Implementation Approach
1. Define mode state machine + persistence model (mode, active profile, stream context).
2. Build Capacitor/native bridge API for Live Mode control and status.
3. Add Android service implementation + manifest/build wiring + notification channel.
4. Add native mechanism to keep server session alive during lock in Live Mode.
5. Connect replay handoff with existing client/server sequence model (`lastEventSeq`).
6. Add auth failure recovery paths for Live/Idle behavior.
7. Remove stale external-push hooks from server/web/native glue.
8. Add automated tests + emulator/device scripts for lock/unlock, reconnect, and policy checks.

## Acceptance Criteria

1. **Live Mode survives lock beyond previous failure window**
   - Given Live Mode is enabled and an active stream is running
   - When device is locked for > 65 seconds
   - Then the active stream is not aborted by orphan handling and continuity is preserved.

2. **Live Mode provides explicit user-visible service state**
   - Given Live Mode is active
   - When app backgrounds
   - Then a persistent foreground notification is shown and includes a clear stop/return affordance.

3. **Live Mode stop returns to Idle behavior cleanly**
   - Given Live Mode service is running
   - When user disables Live Mode
   - Then service stops deterministically and background behavior reverts to Idle Mode policy.

4. **Idle Mode uses foreground-resume replay, not always-on background sockets**
   - Given Live Mode is disabled
   - When app is backgrounded
   - Then there is no continuous WebView socket keepalive loop.

5. **No Firebase credentials required for baseline reliability**
   - Given a fresh device/dev environment without Firebase setup
   - When using Live Mode and foreground resume paths
   - Then reliability behavior still functions as specified.

6. **Replay resume is lossless and deduplicated**
   - Given a disconnect at `lastEventSeq = N`
   - When reconnect/resume runs
   - Then replay starts from `N` and UI receives missing events exactly once in order.

7. **Auth failures are fail-closed and recoverable**
   - Given session/token expires or is revoked during background operation
   - When next protected action occurs
   - Then app clears active auth state, returns to profile picker, and prompts token remediation.

8. **Policy compliance baseline is met**
   - Given release-candidate build and manifest/runtime review
   - When checking background behavior
   - Then implementation contains no prohibited keepalive hacks and uses explicit compliant foreground service behavior.

9. **Automated + device validation pass**
   - Given implementation completion
   - When running test suite and lock/unlock device scenarios
   - Then all reliability tests pass across Live and Idle paths, including long-lock recovery cases.

## Metadata
- **Complexity**: High
- **Labels**: android, capacitor, foreground-service, rpc, websocket, reliability
- **Required Skills**: Android services/Kotlin, Capacitor native plugins, TypeScript reconnect semantics, auth/session hardening
