# Task: Lock-resilience quick mitigation via RPC orphan policy tuning

## Description
Implement a short-term mitigation that reduces lock-screen stream interruptions by making RPC orphan timing explicitly configurable and mobile-aware. This task should deliver immediate practical improvement before full native Live Mode + no-Firebase reliability work lands.

## Background
Fresh-eyes verification confirmed current failure mode:
- Phone lock/background causes WebView socket loss.
- Server sees no subscribers and triggers orphan cleanup.
- Current defaults are `RHO_RPC_ORPHAN_GRACE_MS=60000` and `RHO_RPC_ORPHAN_ABORT_DELAY_MS=5000`.
- Result: active stream is typically aborted around ~65 seconds after lock.

This is expected given current design, but we can reduce pain quickly by making orphan policy tunable from config and documenting recommended mobile values.

## Reference Documentation
**Required:**
- Design: `.agents/planning/2026-02-21-rho-capacitor-native-app/design/detailed-design.md`
- `.agents/tasks/2026-02-22-android-background-streaming-reliability.code-task.md`
- `web/server-core.ts`
- `web/rpc-reliability.ts`
- `web/config.ts`
- `templates/init.toml`
- `tests/test-web-rpc-orphan-smoke.ts`

**Additional References (if relevant to this task):**
- `README.md` (web runtime/env documentation section)
- `docs/` files covering `rho web` configuration behavior

**Note:** You MUST read the detailed design document before beginning implementation. Read additional references as needed for context.

## Technical Requirements
1. Add web-config support for orphan reliability settings in `init.toml` under `[settings.web]`:
   - `rpc_orphan_grace_ms`
   - `rpc_orphan_abort_delay_ms`
2. Keep existing env-var overrides (`RHO_RPC_ORPHAN_GRACE_MS`, `RHO_RPC_ORPHAN_ABORT_DELAY_MS`) with clear precedence rules.
3. Validate and clamp malformed values to safe minimums (no crash/no NaN behavior).
4. Wire effective values into `RpcSessionReliability` construction in `web/server-core.ts`.
5. Add startup observability (debug log or explicit trace point) showing effective orphan policy values when web server starts.
6. Update `templates/init.toml` with documented defaults and mobile-recommended override examples.
7. Add/update tests proving:
   - defaults still work,
   - config values are honored,
   - env overrides beat config,
   - orphan timing behavior follows configured values.
8. Keep all touched `web/**/*.ts` and `web/**/*.js` files at `<= 500` lines.

## Dependencies
- Existing RPC reliability implementation in `web/rpc-reliability.ts`.
- Existing orphan smoke test harness (`tests/test-web-rpc-orphan-smoke.ts`).
- Existing `init.toml` parsing in `web/config.ts`.

## Implementation Approach
1. Extend `web/config.ts` with a typed helper (e.g., `getRpcReliabilityConfig()`).
2. Refactor server-core orphan timing reads to use config helper + env precedence.
3. Add config docs in `templates/init.toml` with explicit mobile lock-tolerant example values.
4. Add focused tests for parsing/precedence and behavior timing.
5. Re-run orphan smoke test with overridden values to verify delayed abort in mitigation scenario.

## Acceptance Criteria

1. **Config-driven orphan grace works**
   - Given `settings.web.rpc_orphan_grace_ms = 300000`
   - When server starts
   - Then orphan handling uses 300000ms grace (unless env override is set).

2. **Env override precedence is deterministic**
   - Given both config and `RHO_RPC_ORPHAN_GRACE_MS` are set
   - When server starts
   - Then env value is used and this precedence is documented.

3. **Malformed values fail safe**
   - Given invalid non-numeric orphan config values
   - When server starts
   - Then server does not crash and falls back to safe defaults.

4. **Mitigation reduces lock-induced aborts**
   - Given lock-tolerant orphan settings (e.g., grace >= 10 minutes)
   - When client disconnects for 2–3 minutes (simulated lock window)
   - Then RPC session is not aborted by orphan policy during that window.

5. **Docs are actionable**
   - Given a user deploying rho mobile wrapper
   - When reading `templates/init.toml` and related docs
   - Then they can configure lock-tolerant orphan behavior with clear tradeoff notes.

6. **Regression safety**
   - Given the implementation
   - When running existing web auth/parity/orphan tests
   - Then tests pass without behavior regression outside configured orphan settings.

## Metadata
- **Complexity**: Medium
- **Labels**: rho-web, rpc, reliability, config, mobile-mitigation
- **Required Skills**: TypeScript config parsing, Hono server wiring, reliability testing, documentation clarity