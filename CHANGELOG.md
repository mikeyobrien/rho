# Changelog

## 2.0.0

Rho 2 is a new program. It shares no code with rho 1 and does not read rho 1's settings.
See [MIGRATION.md](MIGRATION.md).

### Added

- A daemon on [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable) that
  continues an answer or a tool call after it is killed.
- A web page served on loopback: streaming answers, stop, steering while rho works, a
  message queue, several conversations, a model picker, tool cards with output and diffs.
- Photos in a message: picked or pasted in the page, up to four, scaled to what a model takes.
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
  `fetch_content`, `memory`, `reminder`, `settings`.
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
terminal client, voice, image input, and import of rho 1's brain and vault.

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
