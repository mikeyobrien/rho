# Rho — Agent Operating Principles

> Rho is an agent configuration + extension bundle for pi: persistent memory via brain.jsonl, heartbeat check-ins, and a knowledge vault.

**Read brain.jsonl at session start for identity, behavior, and active tasks.**

---

## Environment

- **OS**: Android / Termux (dev)
- **Arch**: aarch64
- **Shell**: bash
- **Home**: /data/data/com.termux/files/home
- **Brain**: ~/.rho/brain/brain.jsonl

---

## The Tenets

1. **Fresh Context Is Reliability** — Each check-in starts clean. Read brain.jsonl, re-verify state, plan before acting. Don't assume persistence is perfect.

2. **Backpressure Over Prescription** — Don't micromanage how; create gates that reject bad work. Tests, verification, clear pass/fail criteria.

3. **The Plan Is Disposable** — Regenerating a plan is cheap. Never fight to save a broken plan.

4. **Disk Is State** — Files on disk are ground truth. The brain is continuity between sessions.

5. **Steer With Signals, Not Scripts** — When something fails, add a learning, a test, or a behavior entry.

6. **Let Agent Agent** — User sits on the loop, not in it. Tune like a guitar, don't conduct.

---

## Work Patterns

### Extensions Layout (pi loader rules)
Pi discovers extensions as either single files (`extensions/*.ts`) or one-level-deep directories with an entrypoint (`extensions/*/index.ts`). It does not recurse further.

Conventions in this repo:
- **One extension per folder**: `extensions/<name>/index.ts`
- **Shared code lives in `extensions/lib/`**
- **Do not create `extensions/lib/index.ts` or `index.js`**. Pi will treat `extensions/lib/` as an extension and try to load it.
- Use `extensions/lib/mod.ts` as the barrel export instead.

### Web Code Layout (No-Build Split)
Rho-web intentionally uses a no-build split between Node and browser runtime code:

- `web/*.ts` = server/runtime code executed by Node (`tsx`/strip-types)
- `web/public/js/*.js` = browser runtime modules served directly

Rules:
- Do **not** add browser `.ts` files under `web/public/` unless a compile step is introduced.
- Keep browser modules explicit (ES module imports), avoid script-order/global coupling.
- Keep `web/**/*.ts` and `web/**/*.js` at **<= 500 lines** per file.
- Respect pre-commit backpressure gates: strict Biome on staged `.ts/.js` (`check --error-on-warnings`) + staged web 500-line limit (`scripts/pre-commit.sh`).

### Documentation Entry Point
- Generated architecture/reference docs live in `.agents/summary/`.
- Start with `.agents/summary/index.md` for AI-oriented routing to deeper docs.

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
