# Cross-Platform Rho Implementation

## Context

This is a structural refactor to make Rho cross-platform (macOS, Linux, Android/Termux).

- **Design document**: `specs/cross-platform/design.md`
- **Implementation plan**: `specs/cross-platform/plan.md`
- **Requirements**: `specs/cross-platform/requirements.md`

## Task

Implement all 10 steps from `specs/cross-platform/plan.md` in order.

Key points:
- Steps 1-2 are `git mv` operations to restructure the repo
- Steps 3-5 create new platform skill SKILL.md files
- Step 6 is the critical install.sh rewrite
- Step 7 updates scripts to source config
- Steps 8-9 are setup scripts and README
- Step 10 is verification (do what you can from this environment)

**Important constraints:**
- Use `git mv` for file moves so git tracks renames
- Do NOT push to remote
- Skills are markdown SKILL.md files with YAML frontmatter (look at existing ones for format)
- The install.sh must be idempotent
- Keep the existing brain/ directory at repo root
- Templates (*.template) stay at repo root
- Follow the directory structure in design.md exactly

## Working directory

This repo root: `~/projects/rho`
