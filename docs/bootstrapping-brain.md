# Brain Bootstrapping

Brain bootstrapping configures Rho as a personal assistant using **brain primitives** (`identity`, `user`, `behavior`, `preference`, `context`, `reminder`, `meta`) instead of markdown bootstrap files.

## CLI quick start

```bash
# 1) Check state
rho bootstrap status --json

# 2) First-time bootstrap (non-interactive flags)
rho bootstrap run \
  --to pa-v1 \
  --name "Mikey" \
  --timezone "America/Chicago" \
  --style balanced \
  --external-action-policy ask-risky-only \
  --coding-task-first \
  --proactive-cadence light \
  --non-interactive

# 3) Preview changes before upgrade
rho bootstrap diff --to pa-v2 --json

# 4) Upgrade profile pack
rho bootstrap upgrade --to pa-v2

# 5) Re-apply current version safely
rho bootstrap reapply
```

## In-session slash commands

```text
/bootstrap status
/bootstrap run --to pa-v1
/bootstrap diff --to pa-v2
/bootstrap reapply
/bootstrap upgrade --to pa-v2
/bootstrap audit
/bootstrap reset --confirm RESET_BOOTSTRAP
```

> `/bootstrap run` is bridged as non-interactive by default to avoid prompt hangs in slash contexts.

## Key flags

- `--to <version>`: Target profile version (e.g. `pa-v1`, `pa-v2`)
- `--dry-run`: Plan only (no writes) for `reapply`/`upgrade`
- `--json`: Machine-readable output
- `--force`: Re-run `bootstrap run` even if already completed
- `--non-interactive`: Skip Q&A prompts and use provided/default values

Bootstrap run onboarding flags:

- `--name <NAME>`
- `--timezone <IANA_TZ>`
- `--style concise|balanced|detailed`
- `--external-action-policy always-ask|ask-risky-only`
- `--coding-task-first` or `--no-coding-task-first`
- `--quiet-hours HH:mm-HH:mm`
- `--proactive-cadence off|light|standard`

## Migrating existing users

Use this flow for users who already have a populated brain and want to opt in without losing custom memory.

```bash
# 0) Backup first
cp ~/.rho/brain/brain.jsonl ~/.rho/brain/brain.jsonl.bak.$(date +%Y%m%d-%H%M%S)

# 1) Inspect current bootstrap state
rho bootstrap status --json

# 2) Preview target profile impact
rho bootstrap diff --to pa-v1 --json

# 3) Apply bootstrap with explicit user defaults
rho bootstrap run \
  --to pa-v1 \
  --name "<user-name>" \
  --timezone "<IANA timezone>" \
  --non-interactive

# 4) Verify result + review audit
rho bootstrap status --json
rho bootstrap audit --limit 20 --json
```

Upgrade path for existing users:

```bash
rho bootstrap diff --to pa-v2 --json
rho bootstrap upgrade --to pa-v2 --dry-run --json
rho bootstrap upgrade --to pa-v2
```

Rollback options:

- Soft reset bootstrap markers (and optionally managed entries):
  - `rho bootstrap reset --confirm RESET_BOOTSTRAP`
  - `rho bootstrap reset --confirm RESET_BOOTSTRAP --purge-managed`
- Full restore from backup:
  - replace `~/.rho/brain/brain.jsonl` with your backup copy.

## Safety notes

- Existing user data is preserved; managed profile entries are merged.
- User-edited managed entries are not overwritten (`SKIP_USER_EDITED`).
- Use `diff` + `--dry-run` before `upgrade` on production agents.
- `reset` is destructive for bootstrap state and requires explicit confirmation:
  - `--confirm RESET_BOOTSTRAP`
- Use `bootstrap audit` to inspect lifecycle events (`start/plan/complete/fail`).
