# Rho 2

Rho is a personal agent that stays running on its owner's machine, remembers, and checks in.
This branch (`v2`) is a from-scratch rewrite on pi-durable, in TypeScript on Bun. `main` is
rho 1 and shares no history with it.

`TASKS.md` is the work list and the record of what was verified and what was not. Read its
bootstrap section before choosing work; update it in the commit that changes the facts.

## Rules that are not visible in the code

- **Durable first.** Anything that must survive a kill is a commit, a document or a task in
  pi-durable. Memory in the process (maps, timers, watchers) is a cache that a restart may
  lose, and is written so that losing it is harmless.
- **A tool with an effect outside rho is `replay: "unsafe"`** (the default). Mark a tool
  `"safe"` only when running it twice gives the same end state.
- **The wire is narrower than the engine.** A client is shown `StateView` (`src/view.ts`) and
  nothing else: no storage paths, system prompts or raw entries. A new field there is a
  decision about what leaves the machine.
- **Loopback only, token always.** The HTTP server binds `127.0.0.1` and every API call but
  pairing needs the bearer token.
- **Claude requests are Claude Code's own.** `src/claude/` lets the CLI build and send its
  request so it is billed to the plan. Change what reaches Anthropic only by changing the
  CLI's inputs or restoring rho's own user messages; a new rewrite of the request body needs
  a live check that the turn is still billed to the plan (`TASKS.md` says how it was done).
- **Rho 1's files are read-only.** Rho 2 writes only under `~/.rho/v2/`. Migration copies.

## Working here

- `bun run check` (type-check, then tests) passes before a commit. The hook in `.githooks/`
  enforces it; turn it on once per checkout with `git config core.hooksPath .githooks`.
- Tests call no model: use pi-ai's `fauxProvider`, and `test/fixtures/fake-claude.ts` for the
  Claude CLI. A live model check is run by hand, on Haiku unless the model is the point, and
  its result is written into `TASKS.md` with what it did not cover.
- Behaviour that only shows under a kill is tested by killing a real second process
  (`test/core.test.ts`).
- Only erasable TypeScript: Bun runs the files as they are. No enums or parameter properties.
- TypeScript stays on 6.x: TypeScript 7 has no Android build, and rho is developed on a phone.
- On Termux there is no `/tmp` or `/usr`; use `os.tmpdir()` and `#!/usr/bin/env`.
