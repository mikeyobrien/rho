# Rho 2.0 tasks

Rho 2.0 is written from scratch on pi-durable, in TypeScript on Bun. This file is the work
list the agent reads when it builds itself. Written 2026-11-10; nothing below is built yet.

## Bootstrap: the least that lets rho build rho

Done when: from the web page on the phone, rho makes a commit to this branch that passes
`bun run check`, restarts onto it, and is still answering.

In order. Each item ends in something that can be checked.

1. **Daemon core.** DONE 2026-11-10: `src/core.ts` (a Harness on SQLite in `RHO_HOME`, default
   `~/.rho/v2`; `config.json`; resumes unfinished work on open) and `src/main.ts` (answers one
   question from the command line). Crash test passes under Bun, in a second process killed
   with SIGKILL: mid-answer, the next process retries once and the question is not asked
   twice; mid-tool, the tool does not run again and the model is told it was interrupted.
2. **Model access.** PARTLY DONE. pi-durable takes a pi-ai `Models` object, so every pi-ai
   provider works once the host registers it and a credential exists. Claude on the Max plan:
   DONE, `src/claude/` (below). Still to do in the daemon: register the built-in providers,
   read pi's login file for their credentials, model and thinking level per conversation.
3. **HTTP and the event stream.** Loopback only, bearer token on every API call, one-time
   pairing. Submit, stop, new chat, steer and queue, earlier entries, models.
4. **Web page.** Thread, composer, streaming answer, stop, queue, model picker. Markdown
   rendered without parsing markup.
5. **Coding tools.** pi-durable's `read`, `write`, `edit`, `bash` over a Node environment, with
   a working directory per conversation. Unverified: that environment under Bun.
6. **Search tools.** `grep`, `find`, `ls` as tools of their own, so searching does not go
   through `bash`.
7. **Tidy tools.** Every tool takes a short `reasoning` argument; the page shows each call as
   two lines (the goal, then the target and a result summary), with the full output and the
   diff on demand.
8. **Project context.** `AGENTS.md` files and an environment summary as prompt sections.
9. **Conversations.** More than one, each with its own directory: list, open, new.
10. **Web access.** `web_search` (one provider to start) and `fetch_content` (a page as
    readable text). Everything fetched reaches the model inside untrusted-content fences.
11. **The self-build gate.** Rho runs from a release checkout and works in a separate one. A
    `release` step runs `bun run check`, switches the service to the new commit, health-checks
    it, and goes back to the last good commit if it does not answer.
12. **Guard rails for `bash`.** Refuse deleting a git directory, writing rho's own data
    directory, and `git push` without a yes. A turn limit per run.
13. **Service.** runit service and boot script, as the phone agent has.

## Soon after: what makes dogfooding pleasant

14. Memory provider contract and the Honcho provider (rewrite of the phone agent's, in
    TypeScript). Person `<person peer>`, agent `phone-agent`, workspace `<workspace>`.
15. Skills: `SKILL.md` directories listed in a prompt section and loaded with `read`.
16. A question tool: the model asks the person a structured question and waits.
17. Notices through `termux-notification`: needs you, failed, looks stuck. Not on done.
18. Usage and cost per conversation, shown in the page.
19. Image input: a pasted or shared screenshot reaches the model.
20. Subagents: a task-owned child conversation with its own model.
21. A terminal client over the same API.

## Rho's own features, after it can build itself

22. Check-ins: a sleeping task, due-ness decided in code, a missed one fires once.
23. Transcript search tool over stored entries.
24. Memory page with review.
25. Vault, Termux tools, channels (Telegram, email) with effect records.
26. The phone agent becomes a host for this core.

## Decisions

- DECIDED: Claude builds rho, through rho's own Claude Code provider with a relay (below).
- Which search provider `web_search` starts with.
- Whether rho 2.0 may push to GitHub itself, or only the person pushes.

## Known facts

- Bun 1.4.4 on Termux runs pi-durable 1.5.1 with SQLite storage; Bun and Node read each
  other's databases. TypeScript 6.0.3 type-checks here; TypeScript 7 has no Android build.
- Crash and resume, checked 2026-11-10. With a scripted model: 4 tests (`test/core.test.ts`).
  Once on real Claude (Haiku): a tool round ran its tool once; a second process was killed
  with SIGKILL 2.5 s into a long answer; the reopened core finished the answer (300 of 300
  lines) with one user entry, keeping the cut-off attempt as an `aborted` entry.
  - A SIGKILL leaves rho's Claude CLI processes running (3 seen: wrapper, proot, CLI). They
    ended by themselves within seconds. It also leaves a turn directory in the temp
    directory, holding that turn's system prompt and tool list; `sweepStale()` removes those
    older than ten minutes at the next start.
  - The interrupted answer costs a second model request for the whole answer.
  - Not checked: a kill between a tool finishing and its result being stored; repeated kills
    (pi-durable's restart limit); storage failure; two rho processes on one data directory.
  - `src/main.ts` is not a daemon yet: it exits after one question. No HTTP, no service.
- Data directory (decided 2026-11-10): rho 2 shares `~/.rho` with rho 1 and writes only
  `~/.rho/v2/` (`src/home.ts`). Rho 1 uses none of the names `v2`, `rho.sqlite`, or a
  top-level `config.json`, and never deletes the directory, so the two run side by side and
  rho 2 is removed by deleting `v2/`. Tested: opening and running rho 2 in a rho 1 layout
  leaves every rho 1 file byte-identical. At start rho 2 logs what rho 1 data it found and
  what has not been carried over.
  - Migration is copy, never move, recorded per step in `v2/migrated.json`. What exists now is
    the detection and the record. The steps themselves are not built: brain (needs the memory
    provider, item 14), vault (item 25), heartbeat interval and agent name (items 22, 2).
    Rho 1's Telegram state, results, logs and package list are left alone and reported.
  - A real rho 1 directory exists on the owner's Mac (brain, vault, telegram, init.toml and more). None
    on the phone or the Linux machine. The Mac's was listed by name only; nothing in it was read.
- **Rho's own Claude provider** (`src/claude/`; reworked 2026-11-10 to match pi's
  `pi-claude-code`, so requests are billed as Claude Code's own). The CLI builds and sends its
  own request: its headers (`claude-cli` user agent, `x-app: cli`), its billing and identity
  system lines, its environment message, tools through an inert MCP inventory. Rho supplies
  the system prompt, the history as frames, and thinking/effort/output limit through
  `CLAUDE_CODE_EXTRA_BODY`. A loopback relay changes only: user messages are put back to rho's
  (dropping the CLI's reminders, the account email among them); the environment messages keep
  their first-request place when history is replayed, with the cache marks moved as pi does;
  one request per turn. pi-ai's Anthropic adapter converts to and from pi messages.
  - Brought over from pi-claude-code: usage-credits detection from Claude Code's own
    `rate_limit_event`, and its wording for Anthropic refusing the plan; warm process reuse (2
    processes, 5 minutes, plain continuations only); tool schema simplification; scaled-image
    copies and their size notes kept; model list and selection names from the CLI's own
    catalog; conflicting auth settings removed from the CLI's environment.
  - Not brought over: Windows launching, mid-conversation tool additions and removals (a
    change replays with the current tools), pi's status command and diagnostics.
  - Checked live (Claude Code 2.1.322, about 25 requests): Opus 5.5 at medium through a tool
    round and two follow-ups; the warm process reused; prompt cache read on every later turn;
    signed thinking replayed; an image; effort low and xhigh reach the request; cancel stops
    upstream and the process. Every request: status 200, plan usage (overage "rejected",
    claim "seven_day"), no email or reminder in a user message, no process left.
  - 18 tests with a fake CLI and fake upstream, no model calls.
  - Not checked: a turn actually charged to usage credits (the detection is pi's, but no such
    turn occurred); the large-context `[1m]` route (this login is not offered one); a long
    session; a Claude Code update that changes its request.
  - Opus turns took 4.6 to 5.5 s here against 1.5 to 2.2 s for Sonnet; reuse saved little.
  - The model sees Claude Code's environment block (working directory, OS, date) and
    "You are a Claude agent, built on Anthropic's Claude Agent SDK." before rho's prompt.
  - The login's headers pass through rho's process in memory for each request; not stored.
  - The CLI must be on `PATH` (`~/.pi/agent/bin/claude` here) or named in `RHO_CLAUDE`.
  - pi-claude-code is not a dependency; it is MIT, by Armin Ronacher, and was read for the
    protocol.
- Claude Code provider spike, 2026-11-10 (14 real requests, Claude Code 2.1.322, harness in
  `~/.cache/rho-spike/`). No relay was used; a pass-through proxy only observed.
  - Works: a plain answer; a tool request through an inert MCP inventory (tool names arrive
    as `mcp__rho__<name>`); two tool requests in one response; replay of history into a fresh
    process, including a signed thinking block, which upstream accepted.
  - Replay rule: mark only earlier *user* frames `shouldQuery:false`, write frames one at a
    time, and wait for the zero-turn `result` after each marked frame. Writing all frames at
    once reorders the history. Marking assistant frames hangs the CLI (two runs timed out).
  - A tool request ends the CLI with exit 1 and `error_max_turns` after one upstream request;
    the response itself is intact. Unmarked history made it send two requests.
  - Claude Code adds, and a relay-free provider cannot remove: a billing line and "You are a
    Claude agent, built on Anthropic's Claude Agent SDK." in the system prompt; a reminder
    holding the account email on the newest user message; an environment block (working
    directory, OS, model name, date).
  - Thinking blocks arrive with a signature and empty text. First token in about 1.0-1.3 s
    including process start. Every turn reported plan usage, not overage.
  - Not settled: cancel. SIGTERM at 2.5 s did not stop the stream; the answer finished 0.6 s
    later. Kill the process group, or cut the upstream connection, and test again.
- `bun install` blocked two postinstall scripts; which packages, and whether they matter,
  was not checked.
- An idle Bun server woke about three times a second in one 20-second sample; Node almost
  never. Unexplained.
- Research notes behind the memory and check-in items are in `~/TASKS.md` on the phone.
