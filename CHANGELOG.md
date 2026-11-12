# Changelog

## 2.0.0

Rho 2 is a new program. It shares no code with rho 1 and does not read rho 1's settings.
See [MIGRATION.md](MIGRATION.md).

### Added

- A daemon on [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) that
  continues an answer or a tool call after it is killed.
- Groundwork for workers on other machines, not used yet: a tool environment that works
  through one "run this script" call, and commands that keep running when the connection or
  rho itself goes, collected when asked again. Nothing you see changes.
- A web page served on loopback: streaming answers, stop, several conversations, a model
  picker, tool cards with output and diffs. A message written while rho works is read at its
  next step, shown in the thread as not read yet until then, and can be taken back; there is
  no mode to choose. Select text in the thread and tap Reply to quote it.
- A details page behind ⋯ and the title, as a chat app's info screen: the conversation's
  workers, its artifacts (photos sent, files changed, reports), what rho remembers, the
  reminders, the settings and the other conversations. Back returns to the thread.
- Photos in a message: picked or pasted in the page, up to four, scaled to what a model takes.
- A `background` tool: a shell command that runs outside rho's turn and reports how it
  ended. One at a time; the same rules as `bash`.
- A `delegate` tool: rho hands a whole job to a worker in its own thread and stays free.
  The page lists workers with their status and a Stop; a worker's command that needs your
  yes shows its card in your thread. Rho can look at what a worker is doing and send it a
  message while it works. What runs beside the conversation (workers, a background command, a
  release) is one card at the end of the thread, and each report is a card that opens on a
  tap. Nothing sits above the message box for them.
- A model per job: say which model suits which work and rho keeps it in a third memory
  list, `models`. `delegate` takes a `model` and `thinking` for a worker, chosen by those
  preferences; with none the worker runs as the conversation does. The model is shown on
  the worker's row, in the worker list and in rho's log. A pick check asks a small model
  whether each choice fits your preferences and only logs the answer (`rho picks`);
  `delegates.check` names its model or turns it off.
- A worker never asks you. Its `ask` sends a question to rho with the default it goes on with,
  and does not wait; rho answers it with `delegate answer` only on a stated basis (your words,
  memory, a goal, an earlier answer), or leaves the default. The question is a quiet line in
  the thread and never a notification. A worker's report card lists what was decided without
  you, folded into one line. Workers are named by their job in the page, not by an id.
- Tool cards: three or more finished steps in a row fold into one row that says what they
  did; a failure and a step outside the working directory stay out. A running step shows
  how long it has run.
- Notifications on Android (Termux:API): when rho needs your yes, a run fails, or a check-in or
  release reports. Not for a finished answer, and not while that conversation is open.
- An answer log: each request for your yes and what you answered, read with `rho answers`.
  Nothing acts on it yet.
- A release shows in the page while it runs (its stage and time, and the restart), and its
  approval card lists the commits it brings in.
- A `settings` tool: rho proposes a change to one of six of its own settings, and it is written
  only after you allow it.
- An optional decider: a decision model labels each shell command with a type, a verdict and
  a confidence, in a log (`rho decisions`). It watches only and blocks nothing.
- The `rho` command: `open`, `start`, `stop`, `status`, `key`, `logs`, `service`, `release`,
  `version`.
- Tools: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`, `web_search`,
  `fetch_content`, `memory`, `reminder`, `settings`, `background`, `delegate`.
- Guard rails: actions that cannot be undone wait for approval; a turn limit per run.
- Memory through a provider contract, with a local file provider and a Honcho provider.
  Memory failing never stops an answer.
- Check-ins: reminders that run unattended at set times. One missed while rho was down runs
  once.
- A release gate so rho can release changes to its own code and go back if they fail.
- Services: runit and Termux:Boot on Termux, a systemd user unit on Linux.
- Model providers from pi-ai with API keys, servers that speak the OpenAI chat API, sign-in
  with a subscription (`rho login`), and an opt-in provider that uses a Claude Code login.

### Not in 2.0

These exist in rho 1 and are not in rho 2: the vault, Telegram and email, subagents, the
terminal client, voice, and import of rho 1's brain and vault.

### Known limits

- macOS is untested.
- No request has been sent to Anthropic, OpenAI, Google or OpenRouter with an API key. Those
  providers are pi-ai's and were tested only against a stand-in server and a local model.
- Starting at boot is untested on both platforms.
- The bash guard matches command text and can be bypassed.
- A release that is killed between stopping rho and starting it leaves rho stopped. Run
  `rho start`.
- An approval (Allow) for a command does not expire until that command is run.

`TASKS.md` has the full record.
