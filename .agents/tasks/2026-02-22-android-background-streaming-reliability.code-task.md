# Task: Android background streaming reliability (Foreground Service + replay resume)

## Description
Implement a policy-safe Android background reliability architecture for rho mobile that is meaningfully better than a browser tab, without risky keepalive hacks and without requiring external push infrastructure. Add an explicit “Live Mode” powered by Android Foreground Service for active streaming windows, plus an Idle Mode that reconnects on foreground/app-active resume using replay-safe semantics.

## Execution Split
This umbrella task is split into two execution tasks:
- `.agents/tasks/2026-02-23-android-background-reliability/task-01-orphan-policy-mitigation.code-task.md`
- `.agents/tasks/2026-02-23-android-background-reliability/task-02-live-mode-native-no-firebase-reliability.code-task.md`

Run Task 01 first as immediate mitigation, then Task 02 for full native reliability.

## Background
Current rho Android wrapper behavior is strong for foreground use, but weak for long background continuity if no explicit mode is enabled:
- `mobile/rho-android/src/session-monitor.ts` uses foreground polling and does not provide durable native background execution.
- WebView/background lifecycle throttling causes socket drops on lock.
- `web/server-rpc-ws-routes.ts` and `web/public/js/chat/rpc-reconnect-runtime.js` already provide replay/reconnect primitives (`lastEventSeq`), but lifecycle wiring must ensure they are applied consistently in mobile flows.
- Fresh-eyes verification confirmed lock failure path: phone lock -> WebView WS disconnect -> server marks RPC session orphaned -> abort/stop. Defaults: `RHO_RPC_ORPHAN_GRACE_MS=60000`, `RHO_RPC_ORPHAN_ABORT_DELAY_MS=5000`.

Android platform and Play policy direction rejects hidden or deceptive keepalive behavior. Reliability must remain explicit and user-visible.

## Reference Documentation
**Required:**
- Design: `.agents/planning/2026-02-21-rho-capacitor-native-app/design/detailed-design.md`
- `.agents/planning/2026-02-21-rho-capacitor-native-app/implementation/plan.md`
- `.agents/planning/2026-02-21-rho-capacitor-native-app/research/android-networking-and-release-readiness.md`
- `.agents/planning/2026-02-21-rho-capacitor-native-app/research/risk-register-and-mitigation-plan.md`
- `mobile/rho-android/src/index.ts`
- `mobile/rho-android/src/app-lifecycle.ts`
- `mobile/rho-android/src/connection-coordinator.ts`
- `mobile/rho-android/src/session-monitor.ts`
- `mobile/rho-android/android/app/src/main/AndroidManifest.xml`
- `web/server-rpc-ws-routes.ts`
- `web/public/js/chat/rpc-reconnect-runtime.js`
- `web/server-mobile-auth-routes.ts`
- `web/server-mobile-auth-middleware.ts`

**Additional References (if relevant to this task):**
- https://developer.android.com/develop/background-work/services/fgs/changes
- https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start
- https://developer.android.com/develop/background-work/background-tasks/persistent/how-to/long-running
- https://capacitorjs.com/docs/apis/background-runner

**Note:** You MUST read the detailed design document before beginning implementation. Read additional references as needed for context.

## Technical Requirements
1. Add an explicit mobile lifecycle mode model:
   - **Live Mode** (user-enabled, active stream reliability), and
   - **Idle Mode** (default background behavior).
2. Implement Android Foreground Service for Live Mode with:
   - visible persistent notification,
   - proper service type declarations/permissions for target SDK,
   - explicit start/stop controls from app UI.
3. Add native-side background continuity coordination for Live Mode independent of WebView JS throttling.
4. Keep Idle Mode simple and no-external-service:
   - no always-on background socket/poll loop,
   - no external push dependency,
   - reconnect/resume when app becomes active again.
5. Wire replay-safe reconnect semantics end-to-end using existing session replay primitives:
   - preserve and reuse `sessionId`/`rpcSessionId`/`lastEventSeq`,
   - recover missed events in-order without duplication.
6. Coordinate server orphan behavior with mobile lifecycle:
   - explicitly handle the current abort path (`RHO_RPC_ORPHAN_GRACE_MS` + `RHO_RPC_ORPHAN_ABORT_DELAY_MS`),
   - ensure Live Mode backgrounding does not trigger orphan abort for active streams,
   - provide documented config defaults for mobile reliability.
7. Keep auth/session behavior fail-closed in background flows:
   - detect expired/revoked auth,
   - clear active context and route user back to profile picker with clear remediation.
8. Add user-facing controls and status:
   - toggle/indicator for Live Mode,
   - clear statement of battery/notification tradeoffs.
9. Enforce compliance guardrails:
   - no silent-audio keepalive,
   - no hidden/deceptive foreground notifications,
   - no exact-alarm abuse,
   - no dependency on third-party push setup for baseline reliability.
10. Preserve existing foreground parity for chat/tasks/review/config workflows.
11. Keep all touched `web/**/*.ts`, `web/**/*.js`, `mobile/**/*.ts` files at `<= 500` lines (refactor if needed).

## Dependencies
- Existing mobile auth exchange/session endpoints (`/api/auth/exchange`, `/api/auth/status`, `/api/auth/logout`).
- Existing replay/reconnect behavior in WebSocket stack (`lastEventSeq` handling).
- Existing RPC orphan reliability controls in web server (`RHO_RPC_ORPHAN_GRACE_MS`, `RHO_RPC_ORPHAN_ABORT_DELAY_MS`).
- Android native project under `mobile/rho-android/android/`.

## Implementation Approach
1. Reproduce and document the current lock failure baseline (WS drop -> orphan abort/stop) as a regression fixture.
2. Define concise lifecycle contract (Live vs Idle), state transitions, and failure handling matrix.
3. Implement Capacitor-native bridge for Foreground Service control (`startLiveMode`, `stopLiveMode`, `getLiveModeStatus`).
4. Add Android service/notification channel + manifest declarations and runtime permission flows.
5. Integrate reconnect replay handoff in mobile/web glue (`lastEventSeq`, session ids), using existing server/client replay APIs.
6. Align server orphan policy with Live Mode behavior and add documented mobile lock-tolerant guidance.
7. Harden auth failure recovery for background-originated failures.
8. Add regression tests + device verification scripts for lifecycle transitions (including lock-duration cases crossing current orphan thresholds).

## Acceptance Criteria

1. **Live Mode starts compliant foreground service**
   - Given an authenticated profile with Live Mode enabled
   - When the app goes to background during an active stream
   - Then a visible foreground notification is shown and the native service remains active until explicitly stopped.

2. **Live Mode survives beyond current orphan cutoff**
   - Given Live Mode is enabled during an active stream
   - When the phone is locked/backgrounded for longer than current cutoff (`> 65s`)
   - Then the stream is not aborted by orphan handling and continues (or resumes without losing in-flight continuity).

3. **Live Mode stop is deterministic**
   - Given Live Mode service is running
   - When the user disables Live Mode or ends streaming
   - Then the service stops, notification is removed, and background network activity returns to Idle Mode behavior.

4. **Idle Mode avoids continuous background sockets/poll loops**
   - Given Live Mode is disabled
   - When the app remains backgrounded
   - Then no always-on WebView socket/polling loop is used.

5. **No external push dependency for baseline reliability**
   - Given a clean developer/device setup with no Firebase credentials
   - When running Live Mode + foreground resume behavior
   - Then reliability behavior works as designed without push setup.

6. **Replay-based reconnect is gap-free**
   - Given a stream was interrupted after `lastEventSeq = N`
   - When reconnect occurs
   - Then reconnect request includes `lastEventSeq = N` and missing events are replayed exactly once in order.

7. **Auth/session failures recover safely**
   - Given auth is revoked or session expires while backgrounded
   - When the next auth-sensitive operation runs
   - Then the app clears active session context, returns to profile selection, and shows a re-auth/update-token prompt.

8. **Orphan policy is explicit and documented**
   - Given a deployment using mobile wrapper
   - When reading ops docs/config
   - Then orphan timing defaults and recommended values for lock-tolerant behavior are clearly documented, including tradeoffs.

9. **Policy-safe behavior is verifiable**
   - Given a release-candidate build
   - When manifest/runtime behavior is reviewed
   - Then no disallowed keepalive hacks are present (silent audio, hidden notification tricks, exact alarm abuse).

10. **Automated test coverage for lifecycle + reliability**
   - Given the implementation is complete
   - When running mobile and web test suites
   - Then unit/integration tests cover Live Mode service control, replay resume semantics, orphan behavior, and auth failure recovery, and all tests pass.

## Metadata
- **Complexity**: High
- **Labels**: android, capacitor, foreground-service, background-reliability, websocket, auth, mobile
- **Required Skills**: Android/Kotlin services, Capacitor plugin bridging, TypeScript reconnect logic, Hono auth/session testing
