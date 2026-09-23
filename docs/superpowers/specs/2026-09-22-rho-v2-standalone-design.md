# Rho v2 standalone installation — design

## Purpose and success criteria

Build a local Rho v2 fork that runs on an installed Pi engine but has a distinct agent identity. An ordinary `pi` invocation must keep its current settings, auth, packages, sessions, and workspace. A fresh `rho` installation must not read or write `~/.pi/agent` or install Rho into ordinary Pi. Rho's brain and heartbeat continue to work. This project is separate from the user's open Pi goal.

This is a local development branch, not a published v2 release or upstream proposal. “Standalone” means isolated application state, **not** a bundled engine or OS sandbox. The Pi executable remains an explicit prerequisite; the user authenticates Rho separately.

## Existing system and evidence

Rho currently stores its brain/config under `~/.rho`, but `cli/commands/{init,sync,login,doctor,skills}.ts` assume `~/.pi/agent`. `install.sh` removes old symlinks there, `cli/commands/start.ts` starts `pi -c` in tmux without an isolated agent environment, and `web/rpc-manager.ts` launches `pi --mode rpc`. `web/session-reader-types.ts`, session-related web routes, `extensions/telegram/session-map.ts`, `extensions/lib/provider-usage.ts`, and `extensions/rho/index.ts` contain paths derived from the ordinary Pi home. All launch, install, diagnostic, and read paths must be audited; changing only `rho sync` is insufficient. Feynman's dedicated Pi agent directory and session directory demonstrate the boundary, but Rho will keep its current Pi dependency rather than bundle another engine.

## State ownership and paths

Rho owns one shared path resolver usable by its CLI, extensions, and web layer, with defaults rooted at `~/.rho`:

| Resource | Rho v2 default | Ordinary Pi remains |
| --- | --- | --- |
| Rho configuration, brain, vault, daemon state | `~/.rho/` existing structure | Unchanged |
| Pi agent settings, auth, models, extensions, skills | `~/.rho/pi-agent/` | `~/.pi/agent/` |
| Pi sessions | `~/.rho/sessions/` | Existing Pi session store |
| Interactive/daemon/web working directory | `~/.rho/workspace/` | Caller-selected Pi cwd |
| Rho-managed package installation | Scoped to Rho's Pi agent directory | No Rho package entry added |

The `rho` process sets `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` only for its Pi children, not globally in the user's shell. It launches Pi with Rho's workspace as cwd unless the user intentionally chooses another project cwd for a Rho session; even then the agent and session directories stay isolated. This is a state boundary, not a filesystem sandbox: tools can still reach paths available to the OS user. Paths are resolved once and passed explicitly across module boundaries rather than independently recomputed as `HOME/.pi/agent`. No symlink or shared settings file is used to emulate isolation.

## Install and runtime flow

1. `rho init` seeds the Rho-owned agent directory and workspace without modifying ordinary Pi. `install.sh` must never delete or relink resources in `~/.pi/agent`; the development-link route targets only the Rho-owned directory.
2. `rho sync` reconciles Rho package and module settings in the isolated `settings.json`. Every `pi install`/`pi remove` subprocess receives the same scoped environment. Existing entries in the ordinary Pi settings file remain byte-for-byte unchanged.
3. `rho login` opens Pi under the Rho agent directory and displays the isolated auth path. It neither silently copies nor reads existing Pi credentials. The normal `pi` command keeps its existing login.
4. `rho start`, attach, trigger, daemon recovery, web RPC, and channel sessions launch Pi with the same agent directory, session directory, and workspace. Tmux propagation must be explicit so an existing tmux server's environment cannot silently drop the boundary. Session browsing and Telegram's session map point only at Rho sessions.
5. `rho doctor` reports the effective paths and detects wrong-directory settings, missing Pi executable, inaccessible directories, or an already-running legacy daemon. It does not repair or delete foreign files without explicit user action.
6. Rho's memory, usage display, and skill-provider paths resolve against Rho-owned storage; shared user-level skill locations are not written by default. Any optional external skill provider that cannot be scoped must fail with an explanation rather than install into ordinary Pi.

The first launch fails early with an actionable error if Pi is missing or the isolated path cannot be created. No fallback to `~/.pi/agent` is allowed. Command failures retain their exit status; partially written settings are not reported as successful. Use an atomic settings write and preserve the last valid configuration on failure. Existing daemon or RPC processes must be restarted to pick up changed paths; `rho doctor` warns about stale processes.

## Existing installation and explicit migration

Fresh v2 installs use the isolated layout. `rho init` creates a versioned local layout marker under `~/.rho` only when no prior `init.toml` exists. A pre-existing `~/.rho/init.toml` without that marker is classified as legacy; `rho init` does not relabel it. Until migrated, commands that could operate on mixed old/new state fail with a migration instruction rather than touching ordinary Pi. Fresh init/sync must not probe `~/.pi/agent`; only an explicitly invoked migration may inspect it. The marker is written atomically only after the isolated layout has been validated.

Provide a `rho migrate` preview with source/destination paths, detected Rho package entry in ordinary Pi, session count, and collision warnings. An explicit confirmation applies a backup-first, idempotent migration. Preserve `~/.rho/brain` and the vault in place. Copy selected Rho-owned settings and optionally old Rho sessions into isolated destinations without overwriting existing files. Never copy `~/.pi/agent/auth.json` by default: use `rho login` for isolated credentials. Do not delete old sessions. Removing the old Rho entry from ordinary Pi is a separately confirmed action after verification, not a side effect of the copy. Migration must be retryable after an interruption without corrupting either store.

## Verification and acceptance

Use temporary HOME directories and a stub Pi executable for hermetic CLI tests. Assert fresh init/sync/login/start/doctor/skill operations and web RPC/session reads use the isolated agent/session/workspace paths; include a tmux-environment test or a command-builder test covering daemon launch. Seed sentinel bytes in `~/.pi/agent/settings.json`, `auth.json`, and a session and verify all remain identical. Test a missing Pi executable, unwritable destination, sync/install failure, stale daemon, and migration collision/interruption. Test migration preview has no writes, applied migration preserves originals, and repeated migration does not duplicate entries.

Run the repository's relevant tests plus the new isolated-install and migration tests. Document the installation commands and effective paths in the README/configuration reference. Verify a fresh install by running `rho doctor`, `rho start`, and `rho status` in a clean environment, then confirm ordinary `pi` is unchanged. No claims of isolation are made until both CLI and web/channel paths have been exercised.

## Out of scope

No embedded or forked Pi binary, OS-user/container security boundary, automatic credential sharing, silent session import, upstream release or registry publishing, and no redesign of brain identity/personality storage. Pre-existing formatter output in the checkout is unrelated and must not be staged into this branch's v2 commits.
