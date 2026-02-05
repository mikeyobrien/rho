# Rho Engineering Status

> Auto-updated by PM heartbeat. Source of truth for what's happening technically.

## Active Subagents

| ID | Task | Preset | Started | Status |
|----|------|--------|---------|--------|
| _(none)_ | | | | |

## Completed Work

| Date | Task | Method | Details |
|------|------|--------|---------|
| 2026-02-05 | Landing site in repo + updates | Direct | Moved rho-site into `site/`. Universal bootstrap.sh (Termux/macOS/Linux). Providers, iPhone/SSH, cost comparison sections. Canonical install URL. |
| 2026-02-05 | iPhone/Termius support | Direct | SSH-friendly tmux config, setup guides (iPhone + VPS), install.sh integration, README update. 28 new tests. |
| 2026-02-05 | Smart heartbeat routing | Direct | Cross-provider cheapest model resolution, --thinking off, /rho model command, pinning, 15 BDD scenarios. |
| 2026-02-05 | `rho login` command | Direct (trivial) | New subcommand: `rho login`, `--status`, `--logout`. 7 acceptance tests. |
| 2026-02-05 | Cross-platform refactor | Ralph loop (17 iter, 27m) | All 10 steps. 13 local commits. Platforms dir, OS-aware install, config support, README rewrite. |
| 2026-02-04 | MIT license + FUNDING.yml | Direct | Added LICENSE and .github/FUNDING.yml |

## Recent Deployments

| Date | What | Where |
|------|------|-------|
| 2026-02-04 | Landing page v1 | rho-site.pages.dev / runrho.dev |

## Build Health

- **GitHub Issues**: 1 open (#1 README diagram -- verified resolved by cross-platform README rewrite, close after push)
- **CI**: No CI configured yet
- **Site**: https://runrho.dev -- deployed via `wr pages deploy`
- **Local vs Remote**: 23 commits ahead of origin/main (cross-platform + rho login + smart heartbeat + iPhone/Termius + site-in-repo)

## Pending Approval (External Actions)

- `cd ~/projects/rho && git push origin main` -- Push 23 commits (cross-platform + rho login + smart heartbeat + iPhone/Termius + site-in-repo)
- `gh issue close 1 -R mikeyobrien/rho -c "Resolved by cross-platform README rewrite"` -- Close issue #1 after push
- `cd ~/projects/rho/site && wr pages deploy . --project-name=rho-site` -- Deploy updated site (providers, iPhone/SSH, cost sections)

## Architecture Decisions

| Date | Decision | Context |
|------|----------|---------|
| 2026-02-05 | Cross-provider heartbeat model resolution | Resolve cheapest model across ALL providers (not just same-provider like brain.ts). 5m cache. Pinnable via /rho model. |
| 2026-02-05 | `rho login` wraps pi's `/login` slash command | Pi 0.51.6 has built-in OAuth provider selector via `/login`. No need to reimplement. |
| 2026-02-04 | Single repo + platforms/ directory | Cross-platform: no separate packages, install script picks pieces |
| 2026-02-04 | Cloudflare Pages for site | Free tier, custom domain, deploy via wrangler |
| 2026-02-04 | Workers + D1 for future sync API | Free tier covers early growth, natural fit for brain JSONL |
| 2026-02-04 | workerd stub on Termux | `--ignore-scripts` install, stub main.js. Remote ops only, no local dev |

## Tech Debt

- [ ] No CI/CD pipeline -- deploys are manual `wr pages deploy`
- [x] ~~No automated tests~~ -- 35 tests across 3 suites (rho-login: 7, tmux-config: 11, iphone-docs: 17)
- [x] ~~rho-site not in git yet~~ -- moved to `site/` 2026-02-05
- [ ] bootstrap.sh untested on fresh Termux
- [x] ~~features/ not committed to repo yet~~ -- committed 2026-02-05
