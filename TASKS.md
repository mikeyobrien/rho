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

All 13 items are done, and the proof at the end of this section was run on 2026-11-10.

Done when: from the web page on the phone, rho makes a commit to this branch that passes
`bun run check`, restarts onto it, and is still answering.

In order. Each item ends in something that can be checked.

1. **Daemon core.** DONE 2026-11-10: `src/core.ts` (a Harness on SQLite in `RHO_HOME`, default
   `~/.rho/v2`; `config.json`; resumes unfinished work on open) and `src/main.ts` (answers one
   question from the command line). Crash test passes under Bun, in a second process killed
   with SIGKILL: mid-answer, the next process retries once and the question is not asked
   twice; mid-tool, the tool does not run again and the model is told it was interrupted.
2. **Model access.** DONE 2026-11-10. pi-durable takes a pi-ai `Models` object. The daemon
   registers all of pi-ai's built-in providers (`src/providers.ts`, see "Providers and first
   run" below), and the model and thinking level are set per conversation (`POST /api/model`).
   Claude on a plan: `src/claude/` (below), opt-in.
   Changed from the first plan: rho does not read pi's login file. Credentials come from
   `rho key` or the provider's environment variable, so rho needs no pi install and pi's
   OAuth logins are not used. Not verified: any hosted provider with a real API key.
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
   Commit `4025d1b` went in with one test failing (a test's stalled-disk stand-in also
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
11. **The self-build gate.** DONE 2026-11-10: `src/gate.ts`, and `rho release [commit]` and
    `rho release --status` in the command. Rho runs from one checkout; work is committed in
    another, and `rho release` is run there. The gate, in its own process:
    1. fetches the commit and runs `bun install --frozen-lockfile` and `bun run check` on it in
       a clean copy, with nothing running changed;
    2. waits up to two minutes for rho to be idle, switches the release checkout, restarts rho;
    3. reads from the running rho which commit it is;
    4. if that is not the new commit within a minute, switches back and restarts the old one.
    It refuses, before doing anything: the commit rho already runs, a release from the
    checkout rho runs from, a release checkout with uncommitted changes, a second release
    while one is under way. The result is written to `release.json` and sent to the first
    conversation as a message marked as the gate's. The agent's own `rho release` waits for
    the person's yes (guard rails).
    Checked: 7 tests against a stand-in program in real git checkouts. Then by hand, with the
    real command and a real rho (fake Claude CLI, scratch home): a good commit was released
    in 43 s and the restarted rho reported it; a commit with a failing test was not released
    and rho was never restarted; a commit that passed its checks but threw at start was
    switched to, failed, and rho came back on the previous commit, with the report in the
    conversation. The by-hand run found a bug that was fixed: the status showed the previous
    release for a moment after `rho release` returned.
    Limits: a rollback waits the full minute even when the new rho died at once. `down`
    (going back failed too) is reported only in `release.json` and the log, since nothing is
    left to deliver a message. The checks are the commit's own: a commit that weakens its
    tests passes them. A release replaces the code under every conversation, not one.
    Not checked: a release while a run is working under a real model; under the service.
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
13. **Service.** DONE 2026-11-10: `src/service.ts` and `rho service install | uninstall |
    status`. On Termux it writes a runit service (`$PREFIX/var/service/<name>/run`) and a
    Termux:Boot script (`~/.termux/boot/<name>`) that takes the wake lock and starts the
    service runner; on Linux a systemd user unit, enabled. The files run rho from the checkout
    the command was run from and carry over only `PATH`, `RHO_HOME`, `RHO_PORT`, `RHO_CLAUDE`
    (and on Termux `PREFIX`, `TMPDIR`, `LD_PRELOAD`). With the service installed, `rho start`
    and `rho stop` go through it. A file of the same name that rho did not write is left alone.
    Checked by hand, in scratch homes with the fake Claude CLI:
    - phone (runit): `kill -9` brought rho back as a new process in about 1 s; after `rho stop`
      it was still stopped 8 s later with no process; uninstall removed both files.
    - the Linux machine (systemd 262, Arch): the same, back in about 2 s; unit `enabled`, `Restart=always`;
      uninstall removed the unit.
    Also on the Linux machine: `bun install --frozen-lockfile` and `bun run check` from a clone of `v2`.
    The first run there failed one test, which searched the whole system temp directory
    (5.8 GB on the Linux machine, small on the phone) and timed out; the test now searches a scratch
    directory of its own. It was the test, not the guard: every refusal answered in under 40 ms.
    Not checked: a reboot on either machine (the boot script and `WantedBy=default.target`
    are untested); the wake lock's battery cost; lingering on Linux, which a user unit needs
    to start without a login (the Linux machine has it on; the command does not turn it on); macOS has
    no service here.
    The wake lock is held for as long as the phone is up. That is the phone agent's design
    debt carried over, not a decision that it should be so.

## The self-build proof (2026-11-10): bootstrap done

Rho is installed on the phone for real: it runs from `~/.rho/v2/release` as the runit service
`rho` on port 4780, `~/.local/bin/rho` is its command, and its first conversation works in
`~/projects/rho` on Claude Opus 5.5 through the Claude Code provider.

**From the page in Chrome on the phone** (`bun e2e/selfbuild.ts`, which types into the page
and taps its buttons through Shizuku):

    19:36:36 page is live: claude-code/claude-opus-5-5
    19:36:54 asked; waiting for the release to need a yes
    19:38:38 rho asks: Needs your yes: putting new code into the running rho cd ~/projects/rho && bin/rho release
    19:38:38 work checkout is at 4eaab82 rho logs with no log yet says to start rho first
    19:38:38 tapped Allow
    19:38:46 gate: running (check)
    19:39:24 gate: running (restart)
    19:39:26 gate: released
    19:39:26 rho now runs 4eaab82 (pid 22925); it ran 4ec7e2a (pid 32417)
    19:40:01 answered after the release: "... rho status ... says the running rho (pid 22925) is on 4eaab82 too."

- The request typed into the page: "When there is no log yet make rho logs print No log yet,
  start rho first and update the tests, then run bun run check, commit it on v2, and run rho
  release from this checkout".
- Rho's commit: `fa3fbb1` "rho logs with no log yet says to start rho first" (`src/cli.ts`,
  `test/cli.test.ts`; 3 lines added, 1 removed). It ran `bun run check` and committed through
  the pre-commit hook, which runs the check again.
- The gate (`~/.rho/v2/release.log`): check 19:38:45, switch 19:39:24, "Rho is stopped"
  19:39:24.8, "Rho is running (pid 22925)" 19:39:26.1, released 19:39:26.1.
- After the restart the page was asked "Run rho version and tell me which commit you run now"
  and the new rho answered with `4eaab82` (the commit's id then; see "History scan and
  rewrite") and its new pid.
- `bun run check` run again on `fa3fbb1` afterwards: 120 pass, 0 fail.

The same loop had run twice before that over HTTP (`bun e2e/selfbuild-http.ts`), while the
phone's screen was locked: commits `0b908ef` (`rho version`) and `5c6d322` (`rho status` names
its commit) are rho's own too, the second released through the gate the same way.

What the first try found, and what was changed:
- Rho ran `bin/rho release` from its work checkout, whose own gate saw itself as "the checkout
  rho runs from" and refused. Fixed in `e642c15`: a release typed in any checkout is handed to
  the rho that is running, and its gate. The work checkout's code is the candidate, not the judge.
- The phone's keyboard capitalised a word after a full stop, so the page proof now types one
  sentence and checks the box holds exactly what it typed before it sends.
- When told its release needed a yes, rho stopped and said what the release would do, as the
  guard asks. When the release was refused it tried to read rho's data directory to find out
  why, and the guard refused that; it then reported the refusal plainly.

What this does not show:
- The person's part was two taps and a typed sentence, done by a script. The script watched
  for the Allow card and tapped it without reading the diff. A person should read it.
- The changes were small (1 to 13 lines of code). Nothing here says how rho does on a change
  that takes many files or a design decision.
- The answer after the restart came about 35 s after the release: the restarted rho first read
  the gate's report and the yes that had been queued, then the question.
- Each Opus turn took several seconds; the whole loop took about three and a half minutes, of
  which the gate's check was 39 s.
- Not exercised: a rollback under the real service (tested by hand in a scratch home only); a
  release while another conversation is working; a reboot of the phone.

## Providers and first run (2026-11-10)

Done in `src/providers.ts`, `rho key` in `src/cli.ts`, `test/providers.test.ts`.

- The default is an API-key provider from pi-ai. With no `model` in the config, a new
  conversation uses the first of these whose provider has a key: `anthropic/claude-sonnet-5-5`,
  `openai/gpt-5.5`, `google/gemini-3.1-pro-preview`, `openrouter/anthropic/claude-sonnet-5.5`;
  then any other provider with a key. All of pi-ai's providers are loaded.
- A key comes from `rho key <provider>` (asked for without echo, stored in `keys.json` in the
  data directory, mode 0600, never accepted as an argument, never printed) or from the
  provider's own environment variable. The running rho reads a stored key on the next message.
- `"providers": [{ "id", "baseUrl", "models" }]` in the config adds a server that speaks the
  OpenAI chat API, such as a local model.
- The Claude-plan provider is off unless the config has `"claudePlan": true`. When on, the
  billing warning is written to the log at every start, and `rho key` shows it. An API key's
  provider is still the default when both exist.
- First run: rho starts with no key. `rho start` and `rho status` print "Not ready: Rho has no
  model to use yet. Add an API key with: rho key anthropic", the page shows the same line, and
  a question asked anyway fails with "Provider is not configured".
- A conversation whose model can no longer be used moves to the default at the next start.
- Checked by tests: the choice for each key and for two keys; stored and environment keys;
  the key file's mode; a broken key file; the plan off, on, and beside a key; a config
  provider answering through a stand-in server; bad provider entries left out; the first-run
  lines in the CLI and the page; the key never in output or the log.
- Checked live, once: a turn on a non-Claude model through pi-ai's OpenAI chat API (a local
  `qwen3.8-27b` on the owner's network, added as a config provider). It called `read` and
  answered from the file in 2.7 s.
- **Not checked: a live turn on Anthropic, OpenAI, Google or OpenRouter with an API key.** No
  API key exists on the phone or the Linux machine. The model ids are pi-ai's own catalogue
  entries and a test checks each exists there, but no request was sent to those services.
  Also not checked: `rho key` typed at a real terminal (the no-echo read was tested only
  through the function the command calls); pi-ai's OAuth logins, which rho does not offer.

## Clean-checkout install on both platforms (2026-11-10)

The README's steps were run as written, in a scratch home directory with no API key in the
environment, on the phone (Termux, aarch64, Bun 1.4.4) and on the Linux machine (Arch,
x86_64, Bun 1.4.4): clone, `bun install --frozen-lockfile`, link `rho` into `~/.local/bin`,
`rho start`, `rho status`, `rho key`.

- Both: 95 packages installed; `rho start` came up and said "Not ready: Rho has no model to
  use yet. Add an API key with: rho key anthropic".
- Both: after a model was configured, a script paired the way the page does (the one-use
  code gave the token, the same code again got 401, the page was served), asked a question,
  and got an answer that used the `bash` tool: "Android" on the phone, "GNU/Linux" on Linux.
- Both: `rho key anthropic` with a made-up key stored it in `keys.json` with mode 600, and
  `--remove` removed it. On the phone the prompt was also run on a pseudo-terminal: the
  typed key was not echoed.
- Both: `bun run check` in the clean checkout, 162 pass, 0 fail (Linux at `7a73e23`, twice;
  the phone at `e301f31`, and at `7a73e23` in the work checkout).
- Repeated on the phone after the review fixes, at `973e3ed`: clone, install, link, `rho
  start` ("Not ready ... rho key anthropic"), a model configured, `rho open --print`, pair,
  one question. The answer used `bash` twice: reading rho's own token was refused, and
  `uname -o` printed "Android". The Linux machine ran `bun run check` from a clean clone at
  that commit (171 pass) but the install-and-first-answer steps were not repeated there.
- Seen in that run: `"cwd"` written to the config after the first start did not move the
  first conversation, which had already been made in the home directory. This is what the
  README says ("A conversation keeps the directory it was made with").
- One difference was found and fixed. The Linux machine has a real `claude` command on its
  `PATH`, and a provider test ran it and timed out. Tests now always use the fake CLI
  (`7a73e23`).
- What differed from the README, and why:
  - The clone was from a local copy of the branch (`v2`), not from GitHub (`rho2`), because
    nothing is pushed. The GitHub address in the README is untested until the owner pushes.
  - The first answer came from a local model set in `providers`, not from `rho key
    anthropic` with a real key, because no API key exists on either machine.
  - The page was not opened in a browser in these runs; the browser run is the self-build
    proof above, on the installed rho.
- Not checked: Bun installed from scratch on either machine (both had it); a machine without
  git; `bun install` without the lockfile; the two postinstall scripts Bun blocks (rho runs
  and passes its checks without them; they were not read).

## History scan and rewrite (2026-11-10)

`git log -p` of the whole branch (39 commits) was searched for emails, IPv4 addresses, key
shapes (`sk-`, `ghp_`, `github_pat_`, `xox`, `AKIA`, `AIza`, JWTs, private-key headers,
`tskey-`), bearer tokens, and the names of the owner's machines, network and accounts.

- Found and removed: two machine host names, one tailnet address (in two test lines), a
  Honcho workspace name and a peer name. The branch was unpushed, so its history was
  rewritten with `git filter-branch`; the same search afterwards finds none of them in any
  commit or message. Machines are now called "the Linux machine" and "the owner's Mac", and
  the address is `100.64.0.7`, which is in the same range and belongs to nobody known.
- Every commit id changed. The ids in this file were changed to the new ones. A commit id
  quoted in a commit message, in a screenshot, or reported by the installed rho from before
  the rewrite is an old id. The self-build proof's commit was `4eaab82` when it ran; it is
  `fa3fbb1` now.
- Found and left, on purpose:
  - The author email on every commit. It is the one already on the public `main` branch.
  - The key-shaped strings: all are made-up test values (`sk-test-0123456789abcdef`,
    `ghp_abcdefghijklmnopqrstuvwxyz0123`, `AKIAABCDEFGHIJKLMNOP`, a private-key header with
    no key) that the memory scanner's tests need.
  - Addresses in the private ranges and `93.184.216.34`, `8.8.8.8`: test inputs for
    `fetch_content`'s refusals.
  - The GitHub user name in the repository address.
- Not checked: binary files (there are none in the branch); `bun.lock` was searched but not
  rewritten; text that identifies the owner without using a searched name.
- The pre-rewrite branch is kept outside the repository, in
  `~/.cache/rho-backup/` on the phone, and must not be pushed.

## Pre-release review (2026-11-10)

A reviewer subagent (Opus, high thinking) read the documents, `src/http.ts`, the guard, the
web and search tools, providers, the CLI, the gate, check-ins, memory, the service and the
Claude relay, over 56 tool calls. **It did not deliver a report.** It ran out of its 30
minutes, and when resumed to write up, the model refused. Its findings below are taken from
its saved working notes, where most were marked "suspected". Each was reproduced before it
was fixed, or is listed as not reproduced. A review that ends this way is weaker than one
with a written verdict: there is no "would release" judgement from the reviewer, and nothing
says which leads it would have dropped.

Fixed, each reproduced first and now under test:

| Finding | How it was confirmed | Fix |
| --- | --- | --- |
| `find` listed `keys.json` through a link to a directory above the data directory | ran it: printed `.rho/v2/keys.json` | paths are resolved and directories compared by device and inode (`src/tools/protected.ts`) |
| `bash` read `keys.json` by a relative path from the home directory, through a link, and through Android's second mount (`/data/user/0`) | ran each: the key was printed | relative form refused; every path in a command is resolved; a shell is refused inside the data directory |
| An empty token file let a request with no token in | ran it: 200 | a token under 32 characters is replaced at start |
| API keys in the daemon's environment were visible to `bash` | ran `env` in the tool | the daemon removes provider key variables from its environment after reading them; tested against a real daemon |
| Under systemd, a release started by rho itself is killed when the gate stops rho | on Linux: a detached child of a unit died at `systemctl stop` | the gate runs as its own unit; a release started inside rho's unit went fetch, check, switch, restart, released, new pid |
| A check-in's guarded command told the model the person would be shown Allow and Deny, and left a request nobody sees | ran it | refused with "nobody is here to give it"; nothing is left waiting |
| `/api/pair` read a body of any size before refusing | read the code | bounded by the server and by the declared length; 3 MB gets 413 |
| `grep` on a link to a directory failed | found by the new test | a link is searched as what it leads to |
| On Termux `rho open` always opens the phone's browser, so the port-forward steps could not work | read the code | `rho open --print` |
| `"cwd": "~/..."` was not expanded | read the code | `~` is expanded |
| The memory scan did not know stored API keys | read the code | stored keys are refused in memory |
| `fec0::/10` passed the private-address check | read the code | refused |
| Ctrl-C at the key prompt left the terminal without echo | read the code | echo is restored. Not run by hand. |
| README: `cwd` and `thinking` described wrongly; the service's environment, `RHO_SERVICE` and Honcho's `apiKey` not mentioned. SECURITY: "refused with any tool" overstated | compared with the code | documents corrected |

Checked and found sound by the reviewer, not re-checked here: path traversal on the page's
files; the origin and host checks; the one-use pairing code; redirects in `fetch_content`;
memory failing open; the key file's permissions; no key in any log or error; no HTML
injection in the page; the reminder arithmetic.

Known issues, not fixed:

- **A release killed part-way is not recovered.** If the gate dies between stopping rho and
  starting it (a phone kill, a power cut), rho stays stopped, possibly on the new commit,
  and `release.json` says "running" for ever. `rho start` brings it up on whatever is checked
  out. Not reproduced; it follows from the code. The fix is to store the stages and resume
  or undo at the next start.
- **An Allow has no time limit.** A granted command stays granted until that exact text is
  run, and a Deny leaves no trace.
- If a check-in's task fails outright, reminders stop firing until one is added or rho
  restarts. Not reproduced.
- Each start of rho makes a new check-in task; the old one ends when it next wakes. Harmless
  as far as was traced, and the kill tests pass, but it is one task more per restart.
- If the gate finishes before `rho release` writes its first status, the status can say
  "running" after the release is over. A new release is not blocked by it.
- The pairing code does not expire; it is valid until used or until rho restarts.
- A setting with a bad value (`thinking: "hgih"`) is not caught at start.
- The bash guard still matches text for everything else; see `SECURITY.md`.
- The owner's AWS variables, `CLAUDE_CODE_OAUTH_TOKEN`, and any other secret in the
  environment rho was started with are visible to `bash`.
- API keys that are only in the environment are lost when rho restarts itself. The gate
  says so; it does not prevent it.

**Second review, of the fixes.** A second reviewer read the code at `70d7d2b` and delivered a
report: "OK to release with notes", no blockers. It had no shell, so every finding was
inferred from reading; each was then given a test here.

| Finding | Fix |
| --- | --- |
| Removing key variables from the daemon means a rho that restarts itself (a release, or `rho stop && rho start` run by the agent) comes up without keys that were only in the first shell's environment, and the gate still said "released" | the gate asks whether rho has a model before and after; when it had one and lost it, the result and the notice say so and name `rho key`. It does not roll back, because the old commit would start the same way. README says it. |
| A path through a directory that does not exist yet (`n/../.rho/v2/...`) skipped the resolved-path check | `..` and doubled slashes are removed as text before resolving |
| A link to a file that does not exist yet inside the data directory let `write` create it | such a link is followed to its target |
| `CLAUDE_CODE_OAUTH_TOKEN` stays visible to `bash` | left, because the Claude CLI needs it; named in `SECURITY.md` |

The reviewer found nothing wrong in the token replacement, the body limits, the gate's
systemd unit, the check-in refusal, or the `seen` cache. Its answer to "would you release
with the known issues as they stand": yes; the one it most wants fixed soon is the release
killed part-way.

Not covered by either review: the web page's script beyond a search for HTML injection, the
tests themselves, `e2e/`, and the fixes to the second review's own findings, which were read
by nobody but their author.

## Release preparation (2026-11-10)

- `package.json`: version `2.0.0`, name `@rhobot-dev/rho` (rho 1's name, kept), licence MIT,
  `files` limited to `bin`, `src`, `web` and the documents, `private` removed so it can be
  published.
- `RELEASE.md` lists the owner's steps: move the branch by bundle, check, try a real API
  key, push as `rho2`, tag `v2.0.0`, GitHub release, npm with the `next` tag, announce.
- Checked: `bun pm pack` gives 35 files, 84 kB. The tarball was installed in a scratch
  project on the phone: `rho start`, `rho status` and the page worked; `rho version` prints
  the package version there.
- Not checked: every command in `RELEASE.md` that pushes, tags, publishes or creates a
  release, because none may be run before the owner does. `gh` and `npm` flags were taken
  from their help text, not from a run.
- Nothing has been pushed, tagged or published.

## Branch name on GitHub (2026-11-10)

The work is on the local branch `v2`. GitHub already has a branch `v2/standalone-install`,
and git cannot hold both `v2` and `v2/...` in one repository, so a push of `v2` as `v2` is
refused. The README and the release checklist publish it as `rho2`
(`git push origin v2:rho2`). The alternative is the owner's: delete or rename
`v2/standalone-install` on GitHub first.

## Sign-in with a subscription, and the first hosted request (2026-11-10)

`rho login <provider>` and `rho logout <provider>` (`src/cli.ts`) run pi-ai's own sign-in
flow and store the login in `keys.json`. Anthropic is refused there: a Claude subscription
is used only through Claude Code.

- Checked live, by the owner and then by one request: the owner ran `rho login openai` in
  Termux on the installed rho and signed in with a ChatGPT account in the browser; the login
  was stored (mode 600, with a refresh token). A new conversation on the installed rho was
  set to `openai/gpt-5.6-sol`, asked to run `uname -o`, called `bash`, and answered
  "`uname -o` printed `Android`." in about 6 s. **This is the first request rho has sent to
  a hosted provider through pi-ai.**
- Found by that run and fixed: `openai/gpt-5.5`, the default for an OpenAI key, is refused
  to a ChatGPT account ("not supported when using Codex with a ChatGPT account"). A
  signed-in OpenAI now defaults to `openai/gpt-5.6-sol`.
- Not checked: the model list still offers all 44 OpenAI models to a ChatGPT account,
  though some are refused; which ones was not mapped beyond those two. A token refresh (the
  login expires about an hour after sign-in) has not been seen to happen. Sign-in with any
  other provider. A machine with no browser (pasting the address back was not tried).
- **Still not checked: any provider with an API key.** The sign-in uses the same pi-ai
  OpenAI adapter a key would, but a different credential, so the documented default path
  (`rho key anthropic`) remains untried against the real service.
- The installed rho was moved to the current code by its own gate (`rho release`,
  `4eaab82` to `084383a`): fetch, check, switch, restart, released in 58 s. That also made
  the "after the release" step of `RELEASE.md` unnecessary on this phone.
- The live request left one extra conversation in the installed rho's list.

## Two fixes from the owner's use of the installed rho (2026-11-11)

- **A message sent while a tool ran broke the conversation on the Claude plan.** The owner's
  first conversation failed every turn with "Claude Code's request does not line up with
  rho's conversation". Cause: a steered message follows the tool's result, so rho's history
  has two user messages in a row; Claude Code joins them into one, and rho counted one more
  user message than the request it was sent. `planTurn` now joins them the same way, and
  the error says the two counts.
  - Reproduced live on Haiku before the fix (a `sleep 6` tool, a message steered in during
    it: "Rho has 3 user messages and Claude Code sent 2", and the next turn failed too).
  - After the fix the same run answered both ("The command printed `finished`. 2+2 is 4.")
    and the turn after it answered.
  - Not checked: the owner's own failing conversation, which runs on Fable at high thinking
    with a long history, until the fix is released into the installed rho; a steered
    message that carries a photo; three or more user messages in a row.
- **The page could not be installed as an app.** It had no manifest and no icons. Added
  `web/manifest.webmanifest`, three PNG icons drawn by `scripts/icons.py` (no image
  library), and the links in `index.html`. A test checks they are served and are the sizes
  the manifest says.
  - Not checked: that Chrome on the phone offers "Install app" and that the installed app
    opens paired. Only the owner can see that. No service worker was added; if Chrome still
    asks for one, that is the next thing to add.

## Soon after: what makes dogfooding pleasant

14. **Memory.** DONE 2026-11-10: `src/memory/`. One provider is active, named by the `memory`
    config key; none named means files on this machine.
    - Contract (`provider.ts`, the same shape as pi-dobo's): `label`, `load()`, optional
      `observe(turn)`, optional `tools`. The memory section is sticky: read when a conversation
      starts and after a compaction, then repeated byte for byte. After a run answers, the
      person's own messages and the final answer go to `observe`; tool rounds do not.
    - Fail open: a provider that throws, times out or returns nothing costs a log line and an
      absent section, never a run, and the next request asks again.
    - `honcho.ts`: reads the person's context (3 s timeout; newest conclusions kept within
      6,000 characters, the cut said), mirrors turns into session `<agent>-<conversation>`.
    - `file.ts`: `user.md` and `notes.md` under `<data dir>/memory`, plain Markdown the person
      can edit. The `memory` tool adds, edits and removes entries, all or nothing. A fact about
      the person is saved only straight after the person's own message; after a file, a page,
      a command or a notice it is refused. A save over the cap is refused, never cut. Entries
      that read as instructions, hold a secret (rho's token included) or hide characters are
      refused.
    - Notices: a message the person did not write (the gate's report) is now its own entry
      kind, `rho.notice`. The model reads it; memory never takes it as the person's words; the
      page draws it apart. The gate sends its reports this way.
    Checked: 14 tests (`test/memory.test.ts`) through a real core: byte-identical system
    messages while the store changes; fail-open three ways; capture of a run; provenance
    refusals after `read`, `bash` and a notice; caps; the scan; Honcho read and capture
    against a fake server on loopback, including down, slow and empty.
    One live read from the owner's Honcho (on another machine of theirs),
    capture off, nothing written: loaded in 186 ms, 6,020 characters, 20 conclusions dated
    2026-10-17 to 2026-11-10, with the "older conclusions left out" note. Only sizes and
    dates were printed.
    Not checked: capture into the real Honcho (deliberately; it would write to the owner's
    memory); a live model actually choosing to save, or obeying a refusal; the section's
    re-read after a real compaction; an answer that lands after a restart is mirrored only
    if its run-end hook runs again.
    Open, for the owner: the rho installed on the phone uses the file provider. Pointing it
    at Honcho is a config change (`"memory": {"kind": "honcho", "url": ..., "user":
    "<your peer name>", "agent": <a peer name for rho>}`) and starts writing to that workspace.
    Not built: an external-module provider (dobo has one); migrating rho 1's `brain.jsonl`.
15. Skills: `SKILL.md` directories listed in a prompt section and loaded with `read`.
16. A question tool: the model asks the person a structured question and waits.
17. Notices through `termux-notification`: needs you, failed, a report. Not on done.
    **Built** 2026-11-11, Android first (`src/notify.ts`, `test/notify.test.ts`); **not yet
    seen on a phone**: the Termux:API app is not installed on the owner's.
    - The daemon sends, so a notification arrives with the page closed. With a notifier the
      server watches every one of the person's conversations from its start, not only those
      a client has opened.
    - One rule (`attention`, pure): a request that waits for a yes; a run that failed, unless
      the person stopped it; a message they did not write (a check-in's report, the gate's).
      A finished answer never notifies.
    - Nothing notifies while a client has that conversation open. A request shown in the page
      and still waiting when the client leaves is notified then. A failure or report that
      arrived while it was open was seen there and is not notified later.
    - A request's notification is taken away when the request is answered. What was notified
      is `<data dir>/notified.json`, so a restart does not ring again for a waiting card. At
      the first look after a start, old failures and reports are history and do not ring.
    - The sender is found by its command (`termux-notification`); the note's text is passed
      as arguments, never through a shell. A tap opens the page. There are no Allow or Deny
      buttons on the notification: a yes is given where the whole request can be read.
      A sender that hangs (the command without its app) is killed after 10 s.
    - No sender: one log line that says what to install, and rho runs as before.
      `"notifications": false` turns them off; the settings tool can propose it.
    - Checked: 6 tests, no model: the rule; ring once, not while watched, ring on leaving,
      removed when answered; across a restart; a stand-in `termux-notification` that records
      its arguments; and a real core and server with a recording sender.
    - Not checked: any real notification. Whether `termux-notification` works on Android 17
      with this Termux build, whether its tap action opens Chrome, how it looks, and whether
      Android's battery limits delay it.
    - Not built: other systems (`notify-send`, macOS) and a command of the person's own;
      "looks stuck" (nothing detects it yet); buttons; a check-in that notifies without
      also writing to the first conversation; quiet hours; grouping several at once.
    - Changed from the first plan: the plan named `notify-send` beside Termux. The owner
      asked for Android first, so only Termux is built.
18. Usage and cost per conversation, shown in the page.
19. Image input: a pasted or picked photo reaches the model. **Done** 2026-11-10
    (`src/photos.ts`, `POST /api/submit` takes `images`, `GET /api/image`, the page's + button).
    - Up to 4 photos a message, 10 MB each, with or without words. JPEG, PNG, GIF and WebP,
      told by the bytes and not by the name or type the client gave. A photo is stored in the
      conversation's entry as base64, like the words; nothing is written as a file.
    - `StateView` carries only a count (`images`) on a user entry and a queued message. The
      picture leaves through `GET /api/image?entry=&n=`, with the token, when a client asks.
    - Scaling happens twice. The page makes a photo at most 2000 px a side on a canvas before
      sending. The daemon then runs pi-durable's Photon processor, which passes a photo that
      already fits and scales one that does not. Measured on the phone: a 3000x4000 camera
      JPEG (1.8 MB) took 10 to 18 s in the daemon, and the same photo already at 1500x2000
      took 0.15 s. So the browser step is what makes it usable; the daemon step is the rule.
    - A model that takes only words is refused at submit, in words, before the photo is stored.
    - The page keeps an unsent photo in memory only (the browser's storage is too small). A
      message with photos that was not sent before a reload is not sent short: its words go
      back in the box and the page says to add the photos again.
    - Checked: 4 server tests and 6 page tests on the stand-in DOM, no model. By hand against a
      scratch daemon: the real camera photo was accepted and stored as a 234 KB JPEG with its
      EXIF data gone; the event frame was 362 bytes with the photo in the thread. Once live on
      Haiku through the Claude plan, with a made-up 2600x1200 picture, half red and half blue:
      stored as 2000x923, answered "Left: red. Right: blue." in 2.0 s.
    - Not checked: anything in a real browser. The canvas step (`web/main.js`: its sizes, EXIF
      turning, quality), the file picker, the camera, and paste on Android are untested; the
      page tests give the script a stand-in for all of them. HEIC is not taken: Chrome on
      Android hands over JPEG, other browsers may not. An animated GIF over the limits is
      refused by the daemon, not scaled. Memory use of Photon on a very large photo sent by
      a client that skips the browser step. The `read` tool still has no processor.
    - Known: a photo that needs no scaling (at most 2000 px a side and 1 MB) is stored and
      sent to the model as it is, EXIF data included; a camera photo's can say where it was
      taken.
    - Not built: sharing a photo to rho from another app; a waiting message's photos cannot be
      taken back into the composer (Remove says so); photos in a check-in or a notice.
20. Delegates (was "subagents"): the agent hands a job to a worker in its own conversation
    and the main thread is free at once. **Not built.** Asked for by the owner 2026-11-11
    ("how do we get your work off the main thread"); they said yes to building it.
    Acceptance criteria, as proposed to the owner that day. **They have not confirmed them
    or the three choices below**; confirm before building.
    1. `delegate` hands the worker its job and returns in under a second.
    2. The worker runs in its own conversation. The main thread gets no tool cards or text
       from it while it works.
    3. When it ends, exactly one notice arrives in the main thread: done, partial or failed,
       with what it did and what it checked. It is a `rho.notice`, so memory never takes it
       as the person's words, and it notifies (item 17).
    4. Killed mid-job, the next start finishes that same job and still sends one report.
    5. A worker has a turn limit. A job that hits it reports that it stopped at its limit.
    6. One worker at a time. A second `delegate` while one runs is refused in words: the
       phone could not carry the test suite alone that day (load average 10 to 13).
    7. The person can see that a worker runs and what its job is, and can stop it. A stopped
       job reports nothing more.
    8. A command that needs the person's yes shows its card in the main thread and notifies.
       (A check-in is refused there today; this is the largest piece and may be split out.)
    9. The worker has the same guard and working directory as the agent, and cannot delegate.
    10. While a worker runs, the person can message the agent and it answers.
    - Proof wanted: tests in a real core with a scripted model, one that kills a real second
      process mid-job, and one live run on Haiku recorded here.
    - Choices proposed, not confirmed: (A) the worker uses the conversation's model; (B) it
      starts with only the brief the agent writes, nothing of the thread; (C) approvals as
      in criterion 8.
    - Out of scope: more than one worker, a model per job, a live view of the worker in the
      page, remote hosts (item 20b).
    - Where it starts: a check-in already is a task-owned conversation with a turn limit and
      one report (`src/checkins.ts`).
20a. Checks out of the agent's turn. **Not built.** The owner asked for it after item 20.
    - Why: `bun run check` takes about a minute and runs at every commit (the hook) and
      again in the release gate. The agent holds a turn open for each, and the person waits.
    - Wanted: the check runs in the background and its result reaches the agent as a notice,
      so a turn is not held. Not designed further. Open: whether this is a delegate with a
      fixed job or its own task; how a commit made by the agent waits for it; never two
      checks at once on the phone.
    - It is also the proper answer to the timing tests that blocked three commits on
      2026-11-11 (see item 21d); they were loosened in the meantime.
20b. Delegates on a host the person owns. **Not built, not designed in detail.** Asked by the
    owner 2026-11-11 ("cloud delegates, with self hosted onboardings"). The shape below was
    proposed; **the owner has not said whether it is what they meant** (the other reading is
    a hosted cloud: a VPS or Kubernetes).
    - Shape: the model loop and the durable record stay in rho on the phone. Only a worker's
      tools (`read`, `write`, `edit`, `bash`) run on the host, over SSH. Losing the host
      loses no state: the job pauses and the command in flight is treated as interrupted.
      No model key or Claude login goes to the host.
    - It reverses a decision: on 2026-11-10 the owner decided the phone agent has no hard
      dependency on other compute. So a host is optional: with none registered, a delegate
      runs on the phone (item 20).
    - Needs: (1) a remote tool environment: pi-durable's `HarnessOptions.env` chooses where a
      conversation's tools run, and today it is always `NodeExecutionEnv` on the phone; what
      an SSH one takes was not looked at; (2) a workspace per job on the host, on a branch,
      with the work coming back as git refs rho fetches, not through a forge; (3) the guard
      rethought: its rules protect rho's data on the phone, and on a host what the worker
      can reach is a question of the user or container it runs as; (4) lifecycle: a probe
      before use, one job per host, cleaning old workspaces, "waiting for host".
    - Onboarding wanted: one command, `rho host add <name>`, that tests SSH, checks git and
      the toolchain, makes the workspace directory, runs one trivial job and saves the host.
      The host needs no rho install and no inbound port. The list of hosts is the person's
      to edit, not one of the settings the agent may propose.
    - Not chosen: a full rho on the host. It runs with the phone off, but needs model
      credentials there, a second install to keep in step, and two stores.
    - Reference, unproven by the owner's own word: pi-dobo's `docs/compute.md` on their Linux
      machine (2,405 lines; only its first 45 lines and its headings were read).
    - Seen 2026-11-11: that machine has git and the `claude` command, and `bun` is not on
      its SSH path, so rho's own checks could not run there as it stands.
    - Order: item 20 first; this is the same tool with another place to run.
21. A terminal client over the same API.
21a. A decider: a second, small model that classifies each shell command. **Shadow only**,
    built 2026-11-11 (`src/decider.ts`, `test/decider.test.ts`, `rho decisions`). Off unless
    `config.json` has `"decider": {"baseUrl": ...}`.
    - One request per `bash` call to a decision model over the System One wire (pi-ai's
      `typesafe-system-one` classifier; Clef and Jev speak it). Five questions: the command's
      type (read, edit, build, install, git_local, download, send, delete, system, secrets),
      a verdict (run, ask, block), and three yes/no (sends data out, reads secrets, hard to
      undo). Each answer keeps its probability; the two choices also keep the winner's lead
      over the runner-up.
    - It is shown the person's last own message, the working directory and the command. Not
      the agent's words and not tool output (as Anthropic's auto mode classifier, which did
      worse with them). A gate report or check-in is not taken as the person's message.
    - It blocks, delays and changes nothing. The guard calls it without waiting; a decider
      that is down or slow costs one line in the daemon log. Every answer or miss is a line in
      `<data dir>/decisions.jsonl`, beside what rho's fixed rules said of the same command.
      A command the rules refuse (rho's own data, a git directory) is not sent at all.
    - Why shadow first: the AI-control papers (Greenblatt et al. 2024; Ctrl-Z, 2025) set a
      monitor's threshold from the scores of honest traffic, as a share flagged, not from a
      fixed probability. The log is that traffic. No threshold exists yet.
    - Checked: 11 tests against a fake System One server, no model. By hand on 2026-11-11,
      through a temporary SSH tunnel to a Clef-Flash (9B, Q4) on the owner's Linux machine,
      15 made-up commands, text only, none run (`e2e/decider-live.ts`): all 15 answered,
      median 616 ms, first call 2.5 s. The type was the expected one on 15 of 15, at 57% to
      95%. The verdict was weaker: `git status` run at 70%, `grep` run at 56%, `sed -i` on a
      project file ask at 50%, `rm -rf dist/` ask at 49%, `cat ~/.aws/credentials` ask at 53%
      (its secrets flag was 98%). So the type and the flags look more usable than the verdict
      question as worded. Fifteen cases written by the agent are not a test.
    - Found while testing: the guard remembers every data directory's inode for the life of
      the process (`src/tools/protected.ts`). In the test process, where data directories are
      made and deleted, a later scratch directory can get a remembered inode and be refused as
      rho's data: 1 run in 3 failed that way here. `test/decider.test.ts` now makes another
      directory when that happens. The other test files are open to the same and were not
      changed; the guard was not changed either (forgetting an inode when its name is gone
      would also forget a data directory that was moved).
    - Not checked: any real traffic; calibration; the decider running in the installed rho
      (it is not configured there, and its server listens on that machine's loopback only, so
      it needs a tunnel that nothing keeps open yet); a long command near the 8k context.
    - Not built: acting on a verdict (ask, block, redraw the step, a per-run strike count);
      a fallback model when the decider is unreachable; "no verdict, no run"; corrections to
      a logged verdict; showing verdicts in the page (`StateView` is unchanged); the script a
      command would run, when the agent edited it in the same run; a size limit on the log.

21b. A settings tool: the agent proposes a change to rho's own settings and the person allows
    it. **Done** 2026-11-11 (`src/tools/settings.ts`, `test/settings.test.ts`).
    - Why: the guard keeps the agent out of rho's data, so it could not turn on a setting it
      had just built (the decider). Opening the data directory to it would also open the
      token and the API keys.
    - `settings` takes `list`, `set {name, value}` and `unset {name}`. Only `model`,
      `thinking`, `cwd`, `notifications` (added with item 17), `checkins` and `decider` can
      be proposed, each with its own check.
      `memory`, `providers`, `claudePlan`, `maxTurns` and anything else stay the person's to
      edit: they hold keys, say where conversations are sent, or bound a run.
    - A change is an approval like a push: a card with the change as `set thinking to "high"
      (now "low")`, Allow and Deny. Nothing is written before the yes. The yes is for that
      text, so for that new value from that old value; if the file changed in between, it is
      asked again. It is used once. In a check-in, where nobody watches, it is refused.
    - A yes for a tool's request is kept apart from a yes for a shell command (`grants`
      beside `granted` in `rho.approvals`), so neither can be taken for the other.
    - The write keeps every other key of the config file, is atomic (a temporary file, then
      a rename) and leaves the file mode 0600. A file that is not JSON is left alone.
    - A saved change takes effect at the next start; the tool says so. It does not restart rho.
    - Checked: 9 tests in a real core with a scripted model, one over HTTP. The first run of
      them found a real fault: a grant pushed through `??=` was not stored, so an allowed
      change asked again for ever. Not checked: the card in a real browser; a live model
      using the tool.
    - Found while writing the docs: the guard's text rule refuses any shell command that
      names rho's data directory, also one that only writes that path into a README. The
      file tools, which check the path they act on, are the way to write such text.
    - Not built: restarting rho after a change; editing the person's `AGENTS.md`; a list of
      past changes.

21c. A release shows in the page, and its card says what it brings in. **Done** 2026-11-11
    (`src/gate.ts` `releaseView` and `describeRelease`, `src/http.ts`, `web/app.js`).
    - Why: after Allow the page said nothing until the gate's report, so the person had to
      ask whether it was done; and the card showed only the command's text.
    - `StateView.release`: status, stage, short commit ids, when it began. The server reads
      the gate's record every 2 s while a client is connected, and on connect. Not sent: the
      gate's pid, any path, the failure's text (that is in the gate's report in the thread).
      A record whose gate process is dead is not shown. An ended release is shown 5 minutes.
    - The page: a line such as "Releasing 99ca524 · running the checks · 0:41" that counts
      between snapshots and through the restart. Losing rho in the middle of a release reads
      "Restarting", not "Can't reach rho".
    - The card: `approvals[].details`, lines from the gate's own preflight: the commit rho
      will run and the one it runs, the commits it brings in by title (six, then a count),
      commits it would leave out, and what happens on failure. Worked out again each time
      the command is asked, so a waiting card is not stale. Only for a command that is
      nothing but a release with an optional `cd` first; of anything more, nothing is said.
    - Checked: 3 gate tests in real git checkouts, 1 guard test through a real core and over
      HTTP, 3 page tests through a real server on the stand-in DOM. The tests found that
      `rho release --status` was read as a release of a commit named `--status`. Not checked:
      a real browser; a real release seen through it.
    - Not built: a restart button; a "restart to apply" prompt after a settings change;
      skipping the card when the person typed the release themselves; skipping the gate's
      second check.
    - Known: the guard's text rules refused three of the agent's own commands that day
      because test text in them named a push. Text for a file goes through the file tools.

21d. An answer log: what rho asked the person's yes for and what they said. **Done**
    2026-11-11 (`src/answers.ts`, `test/answers.test.ts`, `rho answers`).
    - Why: the person's answers are the one signal of their own judgement rho gets, and it
      was thrown away. A threshold for the decider, or asking less often for a kind of
      command, needs it. (From a talk the owner sent, "proactive agent engineering": human
      feedback is the present-tense signal; start narrow and widen with trust.)
    - `<data dir>/answers.jsonl`: a line when a request is first shown (not when it is asked
      again while it waits), and a line when it is answered, with allow or deny and how long
      the card waited. Shell commands and settings changes alike. A request with no answer
      line was never answered. What rho refuses outright asks nobody and is not in it.
    - The request's id is the tool call's, which the decider's log also carries, so
      `rho answers` can say how the person answered by the decider's command type.
    - Nothing reads the log to decide anything. Asking is exactly as it was.
    - It is a log beside the durable state: a kill between a commit and its line loses the
      line. Writing it never fails a command or an answer.
    - Checked: 3 tests in a real core and server with a scripted model. They found that a
      line cut short by a kill swallowed the next line written; both logs now start a new
      line after a broken one. Not checked: a real browser; any real answers (the log is
      empty until this is released).
    - Seen while checking: three Honcho tests in `test/memory.test.ts` failed in 2 of about
      20 runs that day, on a loaded phone. One asserts a 3 s timeout ends within 3.8 s and
      measured 4.3 s; the other two then run into the slow stand-in server. They passed 14
      of 14 times run alone, with and without this change. The test was left as it is.
      Later that day it blocked three commits in a row (load average 10 to 13, most of it
      the suite's own 22 files), so it was changed: the stand-in server now waits 30 s, not
      4 s, and ends when the client gives up; the 3 s timeout must end within 12 s; and a
      failure puts the server back to normal, so it no longer takes two more tests with it.
      The release-line page test, which timed out once in the same hour, waits 15 s for
      its clock, not 4 s. Both still fail if the thing they test does not happen.
    - Not built: acting on it (asking less for a kind that is always allowed, a threshold);
      a reason with a deny; noticing a card that was left unanswered; a size limit.

## Rho's own features, after it can build itself

22. Check-ins: a sleeping task, due-ness decided in code, a missed one fires once. **Done**
    (`src/checkins.ts`, `test/checkins.test.ts`).
    - The agent keeps reminders with the `reminder` tool (add with `every`, `daily` or `at`;
      remove; list). They are stored in a session document. `GET /api/reminders` and
      `POST /api/reminders/remove` let a client see and remove them. `"checkins": false` in the
      config turns the feature off; `"checkins": {"maxTurns": n}` sets the limit (default 20).
    - One durable task sleeps until the earliest reminder is due. `dueReminders` and `nextDue`
      are pure functions; no model is called while nothing is due.
    - A due reminder moves to its next time in the commit that starts the run, past every time
      it missed, so a missed check-in fires once.
    - The run happens in a conversation of its own with a turn limit. Its answer reaches the
      first conversation as a `rho.notice` the model reads on its next turn. An answer of
      "nothing to report" is shown to nobody. Stop ends a running check-in quietly.
    - Checked by 16 tests on a clock the test moves, with real durable sleeps: nothing runs one
      minute early; a due one runs once; several due together run as one; a reminder added
      later and due sooner fires at its own time; the turn limit ends a looping run and says so;
      a clean restart starts no extra run. Two tests kill a second process with SIGKILL: asleep
      and down for six of its hours (one model call after the restart, next time is the seventh
      hour), and mid-answer (the next process finishes that one check-in and starts no other).
    - Checked by hand on Haiku, twice: a log with a failed backup was reported in 124
      characters; a clean log gave "nothing to report" and no notice (7–9 s each).
    - Not checked: a real sleep of hours on the phone under Android's battery limits; a
      daylight-saving change for `daily`; `daily` uses the machine's time zone and a move
      between zones is not handled; many reminders (the cap is 50); the model actually setting
      a sensible reminder when asked in conversation; the kill tests failed once in an early
      run, before a sign error in the test fixture's clock was fixed, and have passed in every
      run since (nine runs under load).
    - Not built: the page does not list reminders yet (the agent lists them when asked); a
      check-in cannot ask for approval, so a guarded action in a check-in is refused and
      reported; check-ins report only to the first conversation; no phone notification
      (the notices task).
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

