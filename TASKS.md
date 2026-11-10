# Rho 2.0 tasks

Rho 2.0 is written from scratch on pi-durable, in TypeScript on Bun. This file is the work
list the agent reads when it builds itself. Written 2026-11-10; nothing below is built yet.

## Bootstrap: the least that lets rho build rho

Done when: from the web page on the phone, rho makes a commit to this branch that passes
`bun run check`, restarts onto it, and is still answering.

In order. Each item ends in something that can be checked.

1. **Daemon core.** One process: a Harness on SQLite, `~/.rho/config.json`, a log. First test:
   kill the process mid-run under Bun, reopen, the run finishes and no tool ran twice.
2. **Model access.** Claude through `@earendil-works/pi-claude-code`, the same provider pi
   uses on this phone: it drives the Claude Code CLI, which holds the Max login, and reads no
   credentials itself. Call `refresh` once at start so the current models are listed. Model
   and thinking level per conversation. Default: `claude-code/claude-opus-5-5`, medium.
   Other pi-ai providers (OpenAI through pi's login file) stay possible, not built first.
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

- DECIDED: Claude builds rho, through pi-claude-code (below).
- Which search provider `web_search` starts with.
- Whether rho 2.0 may push to GitHub itself, or only the person pushes.

## Known facts

- Bun 1.4.4 on Termux runs pi-durable 1.5.1 with SQLite storage; Bun and Node read each
  other's databases. TypeScript 6.0.3 type-checks here; TypeScript 7 has no Android build.
- pi-claude-code under Bun, checked 2026-11-10 with no model request made: `claude auth status`
  reports logged in on the Max plan in 0.2 s, and after a refresh 14 models are listed,
  including `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-fable-5-2`.
  Not checked: an actual turn, tool calls through its relay, or a crash mid-turn.
- It is pinned to commit `d5b5e04` from GitHub (it is not on npm) and imported by file path
  (`.../pi-claude-code/src/provider.ts`), since the package declares no entry point. It pulls
  in pi's coding agent and terminal UI as peer packages, which rho does not use.
- The Claude Code CLI must be on `PATH` (`~/.pi/agent/bin/claude` here, a proot wrapper), so
  the service has to set `PATH` or `PI_CLAUDE_CODE_COMMAND`.
- The provider's README warns that Anthropic may move `claude -p` use to separate credits;
  if a turn is billed as usage credits it fails unless explicitly allowed.
- `bun install` blocked two postinstall scripts; which packages, and whether they matter,
  was not checked.
- An idle Bun server woke about three times a second in one 20-second sample; Node almost
  never. Unexplained.
- Research notes behind the memory and check-in items are in `~/TASKS.md` on the phone.
