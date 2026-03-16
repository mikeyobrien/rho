# Task: Remove the memory config split between init.toml and config.json

## Description
Unify Rho memory configuration so `~/.rho/init.toml` is the single user-facing source of truth for memory settings.

Today memory configuration is split awkwardly across two places:
- `docs/configuration.md` and `templates/init.toml` present memory settings as init-backed
- runtime in `extensions/rho/index.ts` still reads most memory settings from `~/.rho/config.json`

This task should remove that split, preserve behavior, and perform a one-time auto-migration for existing users rather than keeping a permanent fallback path.

## Background
Recent work added `auto_memory_model` as an init-backed setting. That improved one part of the story, but it also made the underlying inconsistency more obvious.

Current state:
- `init.toml` / docs expose `[settings.memory]`
- runtime still reads:
  - `autoMemory`
  - `decayAfterDays`
  - `decayMinScore`
  - `promptBudget`
  from `~/.rho/config.json`
- `/rho automemory toggle` currently writes to the legacy runtime config path
- `docs/brain.md` now has to explain the split instead of giving a clean model

Desired end state:
- users configure memory via `[settings.memory]` in `~/.rho/init.toml`
- runtime reads memory settings from init-backed config
- legacy `config.json` memory fields are auto-migrated into `init.toml` once, then stop participating in normal runtime reads
- docs stop describing a split model

## Reference Documentation
**Required:**
- `templates/init.toml`
- `docs/configuration.md`
- `docs/brain.md`
- `cli/config.ts`
- `cli/commands/sync.ts`
- `extensions/rho/index.ts`
- `extensions/lib/auto-memory-model.ts`
- `tests/test-config.ts`
- `tests/test-auto-memory-model.ts`

**Additional References (if relevant):**
- `.agents/tasks/2026-03-08-auto-memory-model-from-init.code-task.md`
- `README.md`

**Note:** Read the current runtime config code and the slash-command toggle paths together before implementing. The hard part is not parsing — it is making mutation and migration behavior coherent.

## Technical Requirements
1. Make `[settings.memory]` in `~/.rho/init.toml` the canonical source for memory settings:
   - `auto_memory`
   - `auto_memory_model`
   - `prompt_budget`
   - `decay_after_days`
   - `decay_min_score`
2. Add a single init-backed memory settings reader that runtime code can use consistently.
3. Remove direct dependence on `~/.rho/config.json` as the normal runtime source for those settings.
4. Preserve current runtime behavior when settings are unset by keeping the same defaults.
5. Implement one-time auto-migration for existing installs that still have memory settings in `config.json`:
   - if a setting is already present in `[settings.memory]`, keep the init value
   - if a setting is missing in `[settings.memory]` and present in `config.json`, copy it into `init.toml`
   - after successful migration, normal runtime reads must come from `init.toml`, not `config.json`
6. Define clear precedence rules and document them explicitly:
   - `init.toml` wins
   - legacy `config.json` only seeds missing values during migration
   - defaults apply when neither source provides a value
7. Update `/rho automemory toggle` (and any related memory config mutation path) so it edits `init.toml` instead of continuing the split.
8. If editing `init.toml` programmatically is introduced, it must be conservative and safe:
   - avoid clobbering unrelated config
   - preserve formatting/comments where practical, or document limitations clearly
9. Do not keep a permanent runtime fallback to `config.json` for memory settings once migration is in place.
10. Remove split-language from docs once runtime behavior is unified.
11. Keep touched `*.ts`, `web/**/*.ts`, and `web/**/*.js` files at `<= 500` lines; refactor if needed.

## Dependencies
- Existing init parser in `cli/config.ts`
- Existing memory runtime configuration in `extensions/rho/index.ts`
- Existing auto-memory model helper in `extensions/lib/auto-memory-model.ts`
- Existing slash command / rho control behavior for automemory toggling
- Existing docs/template coverage for memory settings

## Implementation Approach
1. Inventory all memory setting reads/writes in runtime and slash-command paths.
2. Create a small shared helper for reading init-backed memory settings with defaults.
3. Add a migration helper that copies legacy `config.json` memory values into missing `[settings.memory]` keys in `init.toml`.
4. Run that migration from the most appropriate lifecycle point (preferably `rho sync`, with a runtime safety net only if needed).
5. Route runtime memory settings through the init-backed helper and remove normal runtime dependence on `config.json`.
6. Update `/rho automemory toggle` so it edits `init.toml` directly.
7. Update docs/template to present one clean configuration model.
8. Add tests for defaults, init-backed overrides, migration precedence, and toggle behavior.

## Acceptance Criteria

1. **Init-backed settings drive runtime behavior**
   - Given `[settings.memory]` is set in `~/.rho/init.toml`
   - When rho loads memory settings
   - Then runtime behavior reflects those init-backed values.

2. **Defaults remain stable when unset**
   - Given memory settings are absent from `init.toml`
   - When rho loads memory settings
   - Then current default values are preserved.

3. **Legacy users are auto-migrated**
   - Given an existing install still has memory settings in `~/.rho/config.json`
   - When migration runs
   - Then missing `[settings.memory]` keys are copied into `~/.rho/init.toml`, existing init values are preserved, and subsequent runtime reads do not depend on `config.json`.

4. **Auto-memory model and auto-memory enablement are coherent**
   - Given both `auto_memory` and `auto_memory_model` are configured in `[settings.memory]`
   - When auto-memory runs
   - Then enablement and model selection are resolved from the same configuration model.

5. **Runtime mutation path writes the canonical config**
   - Given the user invokes `/rho automemory toggle`
   - When the command completes
   - Then `init.toml` is updated and the old split-brain config path is not used as the canonical write target.

6. **Docs describe one primary config model**
   - Given a user reads `templates/init.toml`, `docs/configuration.md`, and `docs/brain.md`
   - When they look for memory settings
   - Then they are pointed to `~/.rho/init.toml` as the primary configuration surface.

7. **No permanent fallback remains**
   - Given migration has completed successfully
   - When rho loads memory settings afterward
   - Then it reads canonical memory settings from `init.toml` rather than continuing to rely on `config.json`.

8. **Regression coverage exists**
   - Given implementation is complete
   - When relevant tests run
   - Then defaults, init overrides, migration behavior, and command behavior are covered and passing.

## Metadata
- **Complexity**: Medium
- **Labels**: rho, memory, config, migration, docs, runtime
- **Required Skills**: TypeScript, config design, runtime settings plumbing, safe migration design, CLI/command behavior, technical documentation
