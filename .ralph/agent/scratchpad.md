# Cross-Platform Rho Implementation — Scratchpad

## Plan Overview

10 steps from specs/cross-platform/plan.md. Steps 1-2 are git mv operations, 3-5 create new skills, 6 is the critical install.sh rewrite, 7-8 are script updates, 9-10 are docs and verification.

## Task IDs

- Step 1: task-1770266933-6351 (ready)
- Step 2: task-1770266936-6723 (blocked by step 1)
- Step 3: task-1770266941-4ac7 (blocked by step 2)
- Step 4: task-1770266941-7a2e (blocked by step 2)
- Step 5: task-1770266941-9e3a (blocked by step 2)
- Step 6: task-1770266947-c69c (blocked by steps 3-5)
- Step 7: task-1770266947-ef25 (blocked by step 5)
- Step 8: task-1770266947-150b (blocked by steps 3-4)
- Step 9: task-1770266947-3a21 (after steps 6-8 logically)
- Step 10: task-1770266947-5b3c (final verification)

## Key Decisions

- Use `git mv` for all moves so git tracks renames
- Individual file symlinks (Option A from design) for extensions
- Generic skill names: drop termux- prefix, platform is implicit
- Config at ~/.config/rho/config, shell-sourceable
- BIN_DIR: $PREFIX/bin on Termux, ~/.local/bin elsewhere

## Current State

- Repo is clean (only untracked .ralph/, PROMPT.md, ralph.yml, specs/)
- Step 1 is ready to start
