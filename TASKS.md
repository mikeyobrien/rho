# Rho 2.0 tasks

The work list, and the record of what was verified and what was not. `AGENTS.md` has the rules.

## What rho 2 is for

One agent that belongs to one person and runs on their own machine: it stays up, survives
being killed, remembers them, and reaches them when something needs them. It is built to be
developed by itself, on a phone. Decisions follow from that:

- A kill is a normal event, so pi-durable is the engine and every effect is committed first.
- One process owns the state. Screens are remote controls over a narrow wire.
- Memory is a provider, not a file format. The owner's Honcho is the first one.
- It runs on the owner's Claude plan through Claude Code's own requests.
- Small enough to hold in one context: a feature that rho 1 needed machinery for is taken
  only in the form pi-durable gives it.

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
3. **HTTP and the event stream.** DONE 2026-11-10: `src/http.ts`, `src/view.ts`; `src/main.ts`
   is now a daemon (port `RHO_PORT`, default 4780). Loopback only, bearer token, one-time
   pairing, origin and host checks. Submit (with `requestId`, steer or follow-up), stop, new
   chat, unqueue, model and thinking level, models, earlier entries, health. The stream sends a
   whole `StateView` on each change and a keepalive every 15 s.
4. **Web page.** DONE 2026-11-10: `web/` (plain JavaScript, no build), served by the daemon
   without a token under a strict content policy. Thread, composer, streaming answer, tool
   cards, stop, steer and queue with a flip, model and thinking pickers, new chat, earlier
   messages, a kept "Not sent yet" outbox, safe Markdown with tables. `bin/rho` and
   `src/cli.ts`: start, stop, status, open (the pairing link), logs.
5. **Coding tools.** DONE 2026-11-10: pi-durable's `read`, `write`, `edit`, `bash` installed in
   the core over its Node environment. Each conversation's tools work in that conversation's
   directory (`config.cwd`, default home; `POST /api/cwd` changes it; shown in `StateView`).
6. **Search tools.** DONE 2026-11-10: `src/tools/search.ts`: `grep`, `find`, `ls`, read-only and
   `replay: "safe"`, over the conversation's environment. In a git work tree they list what
   git lists (ignored files skipped); elsewhere they walk. `.git` and `node_modules` are
   always skipped. 7 tests: matches, no matches, limits, a bad pattern, binary and huge files,
   and Stop while waiting on the file system.
   Not checked: speed on a large repository (each file is read whole, in JavaScript; no
   ripgrep), symlink loops outside git, non-UTF-8 text.
7. **Tidy tools.** DONE 2026-11-10: `src/tools/tidy.ts` adds an optional `reasoning` argument
   to every tool the core installs, its own or an extension's; no tool reads it. `StateView`
   carries it apart from the arguments, and each tool result carries a summary ("+1 −1",
   "3 lines", "no output", or an error's first line) and, for an edit, its diff. The page
   draws a call as two lines (the tool and why; what it acted on and how it went), closed,
   with the diff and output inside.
   Checked: tests for the schema of all seven tools, the view and the card; live on Haiku, 6
   of 6 calls came with a reasoning phrase.
   Not checked: the cards in a real browser (their look was never seen); a model that fills
   reasoning poorly; the phrase's effect on answer quality or cost.
8. **Project context.** DONE 2026-11-10: `src/context.ts`. A `project` prompt section: an
   environment summary (directory, git or not, system, home, date, and on Termux what differs
   there), then every `AGENTS.md` from the root down to the conversation's directory,
   outermost first, preceded by the person's own `<data dir>/AGENTS.md`. One file is cut at
   16,000 characters with a pointer to the rest; all together at 48,000.
   The section is sticky: every request of a conversation repeats the same bytes, so the
   prompt cache holds. It is read again when the directory changes, in a new chat, and after
   a compaction. So an `AGENTS.md` edited mid-conversation is not seen until then, and the
   date line is the day the context was read, not today.
   Checked: 5 tests on what the scripted model receives, including byte-identical system
   messages across four requests with a tool round, an edited file and a changed date.
   Commit `bfa172d` went in with one test failing (a test's stalled-disk stand-in also
   stalled the new section's own read); the next commit fixed the test and added a
   pre-commit hook so a failing check now blocks the commit.
   Not checked: the re-read after a real compaction (reasoned from pi-durable's `shown`,
   not run); a live model's prompt-cache numbers with the section in place.
9. **Conversations.** DONE 2026-11-10. The core keeps a list of the person's conversations
   (a session document); each has its own thread, directory, model and thinking level,
   stored with it. Every HTTP call names its conversation with `?c=<id>` (none: the first).
   `GET /api/conversations` lists them with title, directory, model and whether one is
   working; `POST /api/conversations` makes one, optionally in a given directory. A
   conversation is named from its first message. The page lists them in the menu, opens
   one, and makes a new one where the current one works; "New chat" is now "Clear context".
   Checked: 6 tests over HTTP and in the page (create, list, switch; separate threads, tools
   in separate directories, each answered by its own model; all kept after a restart; a
   reload reopens the open one; a message kept while offline goes to the conversation it was
   written in; a stored conversation that is gone falls back to the first). The page test
   found a bug that was fixed: switching to an empty conversation left the old thread drawn.
   Not built: renaming, deleting or archiving a conversation; the list grows without end.
   Not checked: the conversation list in a real browser; two runs working at once under a
   real model (each starts its own Claude CLI process).
10. **Web access.** DONE 2026-11-10: `src/tools/web.ts`. `web_search` uses Exa's key-less MCP
    endpoint (`mcp.exa.ai`); `fetch_content` returns a page's readable text. Both are
    read-only and `replay: "safe"`. Everything they return is inside a fence that says it is
    data, not instructions; the fence's tag carries a random mark and the text inside cannot
    close it. `fetch_content` takes only http and https, refuses any address that is not the
    public web (loopback, local networks, tailnets, link-local, a name that resolves to one),
    checks each redirect the same way, downloads at most 2 MB and returns at most 20,000
    characters a call.
    Checked: 10 tests against a fake search service and fake pages. Live, once, real web:
    a search returned three fenced results in 0.5 s; `https://example.com/` came back fenced
    in 85 ms; an http address redirected to https and a 35,626-character page was returned
    400 characters at a time with the offset to read on; `localhost` and a tailnet host name
    were refused before any request.
    Not covered: the DNS answer is checked and then the name is fetched, so a name that
    changes its answer in between (DNS rebinding) is not stopped; the page text is a
    regex strip, not a real parser, so navigation clutter comes through and pages built by
    script come back empty; no PDF, no GitHub shortcut; Exa's free endpoint is rate limited
    and its limits were not measured; search queries go to Exa.
11. **The self-build gate.** Rho runs from a release checkout and works in a separate one. A
    `release` step runs `bun run check`, switches the service to the new commit, health-checks
    it, and goes back to the last good commit if it does not answer.
12. **Guard rails.** DONE 2026-11-10: `src/tools/guard.ts`, wrapped around every tool that
    touches files or runs commands.
    - Refused: `rm` of a `.git` directory or anything in one; any tool reading, writing,
      listing or searching rho's own data directory (its token and storage), by path, by a
      relative path, or through a link. Searches from above pass over it.
    - Waits for a yes: `git push`, publishing a package, a GitHub release, merge or repo
      delete. The command does not run; the page shows it with Allow and Deny. Allow grants
      that exact command once; the answer reaches the agent as the person's message. The
      request and the grant are a conversation document and survive a restart.
    - A run stops after `maxTurns` tool rounds (default 200) and says so.
    Checked: 8 tests, one of them a real `git push` to a bare repository that did not happen
    until the yes and happened once after it. The test for links found a hole (a new file
    written through a link into rho's data) that was then closed.
    Limits, stated in a test: the rules read the command's text. `g=git; $g push`, a script
    that pushes, another interpreter deleting `.git`, `find -exec rm`, and a glob that reaches
    the token all pass. The model runs as the person, with the person's shell; this stops
    mistakes, not intent. Text that merely names a push (`echo 'run git push yourself'`)
    asks needlessly. Not checked: a live model's behaviour when refused or made to wait.
    No notification is sent for a waiting request; the person sees it when they open the page.
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

## Taken from dobo and mov-agent

Asked by the owner 2026-11-10: include the best of pi-dobo (`~/Projects/pi-dobo` on the Linux machine,
`027da28e`) and mov-agent (`dsh-mov-agent`, same host). Read for this: dobo's philosophy,
invariants (first 180 lines), heartbeat, asks, steer arbiter (as-built part), memory, principles,
secrets and notices; mov-agent's README, ingress gate and the head of VERIFICATION.md. Most of
dobo's source and all of mov-agent's `index.js` were not read.

Built now:
- A message sent while rho works is a **steer**: it joins the work at its next step and the
  model decides what it means. The person can make it wait ("Wait for the answer") or bring it
  forward ("Steer now"); the row says which, once. Alt+Enter queues. (dobo's arbiter as built
  with no decision model; mov-agent's explicit `/steer` and `/queue`.)
- **One process owns the data** (dobo I7): `rho.lock` names its owner's pid and start time; a
  second rho on the directory is refused, and a dead owner's lock is taken over. Tested.
- **A failed run does not strand what is queued behind it** (dobo I135): `afterFailedRun:
  "continue"`.
- Dobo's core rule is in rho's instructions: spend attention only where it changes the outcome;
  a report is a claim; reversible work goes on and irreversible work waits for a yes.

Already the same, arrived at separately: commit before show; `requestId` makes a resend one
message; the stream is whole snapshots with a 15 s keepalive; loopback and a token; an
interrupted tool is not run again; the wire is narrower than the engine.

Goes into tasks already planned:
- tidy tools: the `reasoning` argument is optional and the tool never reads it (dobo I11).
- memory: dobo's provider contract; the sticky section; a fact about the person is saved only
  from the person's own words; a full file is refused, never cut; new entries are scanned for
  instructions and secrets; every save is said in the reply.
- check-ins: dobo's heartbeat shape. A pure check in code decides, with no model call while
  nothing is due; the run is hidden beside the main conversation; "no action" shows nothing;
  the person's message always goes first and Stop pauses it; off until turned on.
- guard rails: irreversible actions wait for a yes.
- self-build gate: the gate checks the commit and the live state itself, not the agent's word.
- docs: an invariants table where each rule names the test that holds it (dobo); acceptance
  checks written before the work and "unverified" said plainly (mov-agent's VERIFICATION.md).

New tasks for 2.0 (proposed to the owner as goal tasks):
- `ask_person`: decisions that wait on the person, durable across restarts and compaction. Ids
  come from the store; a reversible decision names its default; an irreversible one has none.
- Notices: one pure rule decides what interrupts (needs you, failed, looks stuck; never a
  finished reply), sent through `termux-notification` or `notify-send`.
- `request_secret`: a credential goes from the person to a private file; the agent gets the
  file's name. This is also how a new user gives rho an API key.
- A decision log (mov-agent): one bounded line per steer/queue choice and per guard refusal,
  with no message text.

Not taken for 2.0: compute providers and remote work trees, delegations and workers, the pulse
feed, the Telegram host, the arbiter's heuristics and judge model, the backlog, review gates,
principles as a store (rho has `AGENTS.md`; skills come after 2.0), the phone app, TLA+ models.

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
- HTTP, checked 2026-11-10: 12 tests on a real server with a scripted model. Once live on
  Haiku: the daemon started, listed 13 models, took a question over HTTP, streamed the partial
  answer then the stored one, and exited 0 on SIGTERM with no process left.
  - A tool that ignores its abort signal holds Stop open: `abort()` waits for the tool to
    return. Every rho tool must end when `context.abortSignal` fires. (Found when a test
    tool did not, and Stop hung.)
  - Not checked: the keepalive and a client's idle timeout over a long silence; many clients;
    a slow client that stops reading; the server under a kill (only the core was killed).
  - Not built: `rho open` (the pairing link), serving the page's files, a service.
- Page and command, checked 2026-11-10: 16 tests run the page's real script against a real
  daemon on a stand-in DOM; 6 run the command against a real daemon process. In Chrome on the
  phone (`bun e2e/page.ts`, driven through Shizuku, one Haiku request): `rho open`'s link
  opened the page paired and empty with the code gone from the address; Send, the message
  box and the menu button measured at least 44 css px and inside the page; a typed question
  was answered "Tokyo" and drawn once; the menu showed the model and thinking pickers.
  Screenshots were looked at by eye.
  - Not checked in the browser: a tool card, the queue row and its flip, the offline notice,
    earlier messages, a long thread's scrolling, a narrow (folded) screen, Markdown tables,
    any browser but Chrome. The stand-in DOM tests cover their logic, not their look.
  - The browser check leaves its tab open in Chrome each time it runs (four were left today).
  - Chrome's accessibility tree gives the thread as one run of text, so the check proves the
    question and answer each appear once, not that they are separate bubbles; the screenshot
    shows they are.
- Coding tools, checked 2026-11-10 under Bun (`test/tools.test.ts`): write, read (whole and a
  range), edit and bash in the conversation's directory; a missing file, an edit with no
  match, a non-zero exit and a timeout each come back as an error that says why; Stop ends a
  running `bash` and what it started within 3 s; read, write and edit end on Stop while they
  wait on a stalled file system, and change nothing. Live on Haiku in a scratch directory:
  asked to fix a typo in a script and run it, the model read, edited, ran it, and reported
  "hello world"; the file was changed. 6.2 s for four model requests.
  - Paths are not confined: a tool can read and write anywhere the user can. `bash` makes any
    confinement of the others moot; the guard-rails task covers what is refused.
  - Not checked: images through `read` (no image processor is installed, so large images are
    refused), binary files, very large outputs and their spill files, Windows.
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

