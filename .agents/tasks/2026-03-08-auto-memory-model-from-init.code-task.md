# Task: Add init.toml support for auto-memory model selection

## Description
Add first-class support for configuring the model used by auto-memory extraction from `~/.rho/init.toml`.

Today auto-memory always resolves to the smallest available model from the current session model's provider, with fallback to the current session model. The goal is to let users explicitly set an auto-memory model in config while preserving the current automatic behavior when no override is set.

## Background
A user asked how to change the auto-memory model from `init.toml` and the answer today is: you cannot. The current implementation in `extensions/rho/index.ts` hardcodes auto-memory model selection to “smallest available model from the same provider as the active session model.”

Relevant current state:
- `docs/configuration.md` documents `[settings.memory]` keys like `auto_memory`, but there is no `auto_memory_model` setting.
- `docs/brain.md` explicitly says auto-memory uses the smallest available model from the same provider.
- `extensions/rho/index.ts` implements this behavior in `resolveSmallModel()`.
- Memory runtime config is currently split: some memory settings are documented in `init.toml`, while the extension also reads `~/.rho/config.json`. This task should avoid adding another ad-hoc path and make the init-backed model override the source of truth for this behavior.

Desired UX:
- Users can set something like:
  ```toml
  [settings.memory]
  auto_memory_model = "openai/gpt-5-mini"
  ```
- Users can also explicitly opt back into current automatic behavior with:
  ```toml
  [settings.memory]
  auto_memory_model = "auto"
  ```
- If unset, behavior remains unchanged.

## Reference Documentation
**Required:**
- `templates/init.toml`
- `docs/configuration.md`
- `docs/brain.md`
- `cli/config.ts`
- `cli/commands/sync.ts`
- `extensions/rho/index.ts`
- `tests/test-config.ts`

**Additional References (if relevant):**
- `skills/auto-memory/SKILL.md`
- `README.md`

**Note:** Read the config/docs/runtime files together before implementing so the final behavior, docs, and parser stay aligned.

## Technical Requirements
1. Add a new memory setting in `init.toml` named `auto_memory_model` under `[settings.memory]`.
2. Support the values:
   - `"auto"` to preserve the existing automatic model selection behavior.
   - `"provider/model-id"` to pin auto-memory to a specific registered model.
3. Keep current behavior unchanged when `auto_memory_model` is unset.
4. Wire the runtime so auto-memory reads this setting from the init-backed configuration path rather than introducing another one-off config source.
5. Extend auto-memory model resolution so it:
   - prefers configured `auto_memory_model` when present,
   - validates the configured model exists in the registry,
   - verifies an API key is available for the chosen model,
   - falls back to current automatic behavior only when config is unset or explicitly `"auto"`.
6. Define and implement failure behavior for invalid configured models:
   - do not silently treat malformed values as valid,
   - surface a clear warning or error signal in logs/UI,
   - use a safe fallback behavior if runtime execution must continue.
7. Ensure auto-memory run metadata/logging reflects the actual model used after resolution.
8. Update user-facing docs and templates so the new setting is discoverable and consistent across docs.
9. Add automated tests for parsing, model resolution, and failure cases.
10. Keep touched `web/**/*.ts`, `web/**/*.js`, and `*.ts` runtime files at `<= 500` lines; refactor if needed.

## Dependencies
- Existing memory settings parsing in `cli/config.ts`
- Existing auto-memory extraction flow in `extensions/rho/index.ts`
- Existing auto-memory run logging in `~/.rho/brain/auto-memory-log.jsonl`
- Existing config/template/docs update flow (`templates/init.toml`, `docs/configuration.md`, `docs/brain.md`)

## Implementation Approach
1. Extend config/template/docs to introduce `[settings.memory].auto_memory_model` with `auto` and `provider/model-id` semantics.
2. Decide the cleanest runtime plumbing so the extension sees the init-backed setting without creating another config source-of-truth split.
3. Replace `resolveSmallModel()` with a resolver that supports both explicit override and legacy automatic selection.
4. Add validation and operator-visible diagnostics for malformed or unavailable configured models.
5. Add targeted tests covering parsing, default behavior, explicit override, `auto`, unknown model IDs, and missing API keys.
6. Verify that auto-memory log entries/reporting show the actual resolved model used.

## Acceptance Criteria

1. **Unset config preserves current behavior**
   - Given `auto_memory_model` is not set in `init.toml`
   - When auto-memory runs
   - Then it uses the current automatic same-provider small-model selection behavior.

2. **Explicit auto preserves current behavior**
   - Given `[settings.memory] auto_memory_model = "auto"`
   - When auto-memory runs
   - Then it uses the current automatic same-provider small-model selection behavior.

3. **Pinned model override is honored**
   - Given `[settings.memory] auto_memory_model = "provider/model-id"`
   - When that model exists in the registry and has an API key available
   - Then auto-memory uses that exact model instead of same-provider auto-selection.

4. **Invalid configured model is surfaced clearly**
   - Given `[settings.memory] auto_memory_model` is malformed or references an unknown model
   - When auto-memory runs
   - Then the system emits a clear warning/error signal and does not silently claim the invalid model was used.

5. **Unavailable credentials are handled safely**
   - Given `[settings.memory] auto_memory_model` points to a registered model with no API key configured
   - When auto-memory runs
   - Then the failure path is explicit and runtime behavior follows the documented safe fallback.

6. **Config parser and template are aligned**
   - Given a fresh `rho init`
   - When the generated `init.toml` is inspected
   - Then `[settings.memory]` documents `auto_memory_model` and `cli/config.ts` can parse the setting correctly.

7. **Docs match implementation**
   - Given the updated docs
   - When a user reads `docs/configuration.md` and `docs/brain.md`
   - Then they can discover the setting, understand `auto` vs pinned behavior, and see the default behavior when unset.

8. **Run metadata reports the actual model used**
   - Given an auto-memory extraction run completes
   - When its metadata/log entry is inspected
   - Then the recorded model reflects the resolved runtime model, including pinned override cases.

9. **Regression coverage exists**
   - Given the implementation is complete
   - When the relevant automated tests run
   - Then config parsing, resolver behavior, invalid-model handling, and default behavior are covered and passing.

## Metadata
- **Complexity**: Medium
- **Labels**: rho, memory, config, auto-memory, models, docs
- **Required Skills**: TypeScript, config parsing, runtime settings plumbing, model registry handling, automated testing, technical documentation
