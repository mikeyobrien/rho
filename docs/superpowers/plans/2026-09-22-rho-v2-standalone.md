# Rho v2 standalone installation — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Rho v2 use the installed Pi engine while keeping its agent settings, auth, packages, sessions, and workspace separate from ordinary Pi.

**Architecture:** One shared path resolver owns every Rho-managed Pi location. CLI, daemon, web, and channel launches pass that resolver's environment to Pi children. Legacy `~/.rho` installs are detected by the absence of a v2 layout marker and refuse mixed operation until an explicit migration.

**Tech Stack:** TypeScript ESM, Node test scripts run with `npx tsx`, existing Rho CLI modules.

**Spec:** `docs/superpowers/specs/2026-09-22-rho-v2-standalone-design.md`

## Global Constraints

- Reuse the installed `pi` executable. Do not bundle or fork Pi.
- Defaults are `~/.rho/agent`, `~/.rho/agent/sessions/<encoded-cwd>`, and `~/.rho/workspace`.
- Set `PI_CODING_AGENT_DIR` only on Rho's Pi children. Do not set `PI_CODING_AGENT_SESSION_DIR` or pass `--session-dir`.
- Fresh init/sync must not read or write `~/.pi/agent`.
- No fallback to `~/.pi/agent` when Pi or an isolated path is unavailable.
- Legacy installs are not converted unless `rho migrate --apply` is confirmed.
- Do not copy `~/.pi/agent/auth.json` unless `--copy-auth` is explicit.
- Do not stage unrelated formatter changes.

## Review Focus

- A fresh install must not stat `~/.pi/agent` at all.
- A missing `pi` binary must exit before creating a tmux session.
- Tmux launch arguments must include both isolation environment variables.
- Migration preview must not create destination files.
- A legacy `init.toml` without a layout marker must not be treated as v2.

---

### Task 1: Path resolver and install classification

**Files:**
- Create: `cli/rho-paths.ts`
- Test: `tests/test-standalone-paths.ts`

**Interfaces:**
- Produces: `resolveRhoPaths(home: string): RhoPaths`, `buildPiChildEnv(paths, baseEnv)`, `classifyInstall({ initTomlExists, markerVersion })`.

- [ ] Write tests for default paths, child env isolation, fresh/v2/legacy classification, and refusal to substitute `~/.pi/agent`.
- [ ] Implement the pure module.
- [ ] Run `npx tsx tests/test-standalone-paths.ts`.

### Task 2: Wire CLI lifecycle to isolated paths

**Files:**
- Modify: `cli/commands/init.ts`, `sync.ts`, `login.ts`, `doctor.ts`, `start.ts`, `skills.ts`, `install.sh`
- Test: `tests/test-standalone-launch.ts`

- [ ] Test command builders for init, sync, login, start, and doctor. Assert ordinary Pi paths are absent from planned writes and Pi child env.
- [ ] Replace hardcoded `~/.pi/agent` with `resolveRhoPaths`.
- [ ] Make `start` fail when `pi` is missing and pass isolation env through tmux `set-environment`.
- [ ] Make external skill providers fail with an explanation if they cannot target the Rho agent directory.

### Task 3: Wire web and channel readers

**Files:**
- Modify: `web/session-reader-types.ts`, `web/rpc-manager.ts`, `web/server-config-sessions-routes.ts`, `extensions/telegram/session-map.ts`, `extensions/lib/provider-usage.ts`
- Test: `tests/test-standalone-launch.ts`

- [ ] Test default session dir, RPC spawn env, and Telegram session file placement.
- [ ] Pass the same child env and session directory used by the CLI.

### Task 4: Explicit migration

**Files:**
- Create: `cli/migrate-core.ts`, `cli/commands/migrate.ts`
- Modify: `cli/index.ts`
- Test: `tests/test-standalone-migrate.ts`

- [ ] Test preview writes nothing, apply copies settings/sessions without auth, repeated apply does not duplicate, and collision/interruption leaves originals intact.
- [ ] Implement preview and confirmed apply. Removal of the old Pi package entry is a separate confirmed flag.

### Task 5: Docs and acceptance

**Files:**
- Modify: `README.md`, `docs/configuration.md`

- [ ] Document the isolated paths, separate login, and `rho migrate` preview/apply flow.
- [ ] Run the new tests and a temporary-home install check. Do not claim isolation before those commands pass.
