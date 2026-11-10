# Rho 2.0 tasks

Rho 2.0 is written from scratch on pi-durable, in TypeScript on Bun. This file is the work
list the agent reads when it builds itself. Written 2026-11-10; nothing below is built yet.

## Bootstrap: the least that lets rho build rho

Done when: from the web page on the phone, rho makes a commit to this branch that passes
`bun run check`, restarts onto it, and is still answering.

In order. Each item ends in something that can be checked.

1. **Daemon core.** One process: a Harness on SQLite, `~/.rho/config.json`, a log. First test:
   kill the process mid-run under Bun, reopen, the run finishes and no tool ran twice.
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
- **Rho's own Claude provider** (`src/claude/relay.ts`, `provider.ts`; 2026-11-10). pi-ai's
  Anthropic adapter builds the request and parses the response. A `fetch` it is given starts
  the Claude Code CLI for one turn with a placeholder prompt, pointed at a loopback relay on a
  random port behind a random path. The relay replaces the CLI's request with rho's, keeping
  the CLI's login headers and its two leading system lines (billing, "You are a Claude
  agent..."), forwards it, and hands the response to rho. One request per turn; anything else
  the CLI sends is refused. The CLI is killed (whole process group) once rho has the response.
  - Checked live (about 12 requests, Claude Code 2.1.322): a plain answer; a tool request under
    rho's own tool name; the conversation continued with rho's tool result; a thinking turn
    whose signed thinking was replayed and accepted; effort reaches the request; cancel ends
    the upstream request within 2 ms and leaves no process. Nothing the CLI adds (account
    email reminder, environment block) reached upstream. About 1.2 to 2.1 s per short turn.
  - 10 tests with a fake CLI and a fake upstream, no model calls.
  - Not checked: a usage-credits turn (the detection reads rate-limit headers and is a guess
    at their overage form; every observed turn was on the plan); images; the 1M context
    beta; a long run of turns; what happens when Claude Code updates and changes its request.
  - Each turn starts a new CLI process (no reuse), and the login's headers pass through rho's
    process in memory for that request. They are not logged or stored.
  - The CLI must be on `PATH` (`~/.pi/agent/bin/claude` here) or named in `RHO_CLAUDE`.
  - Anthropic may change how this kind of use is billed (see pi-claude-code's README).
  - pi-claude-code is no longer a dependency.
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
