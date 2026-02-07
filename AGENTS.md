# Rho — Agent Operating Principles

> Rho is an agent configuration + extension bundle for pi: persistent memory, heartbeat check-ins, and a knowledge vault.

**Read SOUL.md at session start for identity and voice guidelines (if present).**

---

## Environment

- **OS**: Android / Termux (dev)
- **Arch**: aarch64
- **Shell**: bash
- **Home**: /data/data/com.termux/files/home

---

## The Tenets

1. **Fresh Context Is Reliability** — Each check-in starts clean. Re-read RHO.md, re-verify state, plan before acting. Don't assume persistence is perfect.

2. **Backpressure Over Prescription** — Don’t micromanage how; create gates that reject bad work. Tests, verification, clear pass/fail criteria.

3. **The Plan Is Disposable** — Regenerating a plan is cheap. Never fight to save a broken plan.

4. **Disk Is State, RHO.md Is Handoff** — Files on disk are ground truth. RHO.md is the coordination layer between sessions.

5. **Steer With Signals, Not Scripts** — When something fails, add a checklist item, a test, or a note.

6. **Let Agent Agent** — User sits on the loop, not in it. Tune like a guitar, don’t conduct.

---

## Work Patterns

### Extensions Layout (pi loader rules)
Pi discovers extensions as either single files (`extensions/*.ts`) or one-level-deep directories with an entrypoint (`extensions/*/index.ts`). It does not recurse further.

Conventions in this repo:
- **One extension per folder**: `extensions/<name>/index.ts`
- **Shared code lives in `extensions/lib/`**
- **Do not create `extensions/lib/index.ts` or `index.js`**. Pi will treat `extensions/lib/` as an extension and try to load it.
- Use `extensions/lib/mod.ts` as the barrel export instead.

### Verification Before Declaration
- Run tests before declaring code done.
- Verify files were actually written/modified.
- Check command exit codes.

---

## Tools Philosophy

- **bash**: exploration + system interaction
- **read**: inspect before editing
- **edit**: surgical changes
- **write**: new files or full rewrites only

Prefer explicit over implicit. Show your work.
