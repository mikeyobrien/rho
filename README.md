# rho

Rho is a personal agent that runs on your own machine and stays running. You talk to it in a
browser page. It can read and change files, run commands, search the web, remember what you
tell it, and do things at times you set. It is built to work on a phone under Termux, where
the system kills processes without warning.

This is rho 2, a rewrite on [pi-durable](https://www.npmjs.com/package/@earendil-works/pi-durable).
Rho 1 is on the `main` branch; see [MIGRATION.md](MIGRATION.md) if you use it.

**Status: 2.0, new.** It is tested on Android (Termux) and on Linux. macOS is untested.
[TASKS.md](TASKS.md) records what was checked and what was not.

## What it does

- **Survives being killed.** Every step is stored before it takes effect. After a kill or a
  reboot, rho continues the answer or the tool call it was in.
- **Works on code.** Tools: `read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`,
  `web_search`, `fetch_content`. Each conversation has its own working directory.
- **Sees photos.** Add up to four photos to a message with the + button, or paste a
  screenshot. Large ones are made smaller before they are sent to the model.
- **Asks before what cannot be undone.** `git push`, publishing a package, and merging or
  releasing on GitHub wait for you to press Allow.
- **Remembers.** A small memory of facts about you and your projects is put in front of the
  model every turn. It is kept in two local files by default, or in a
  [Honcho](https://github.com/plastic-labs/honcho) server.
- **Checks in.** Ask it to do something every two hours, daily at 08:00, or once at a set
  time. It runs unattended and tells you only what you need to know.
- **Builds itself.** Rho can change its own code in a second checkout and release it. A gate
  runs the checks, restarts rho on the new commit, and goes back if it does not come up.

## Install

You need [Bun](https://bun.sh) 1.4 or later and git.

On Termux:

```sh
pkg install bun git
```

On Linux, install Bun with its installer (`curl -fsSL https://bun.sh/install | bash`) and git
with your package manager.

Then, on either:

```sh
git clone -b rho2 https://github.com/mikeyobrien/rho.git ~/rho
cd ~/rho
bun install --frozen-lockfile
mkdir -p ~/.local/bin && ln -sf ~/rho/bin/rho ~/.local/bin/rho
```

Make sure `~/.local/bin` is on your `PATH`. Rho runs from this checkout, so keep it.

## First run

Rho needs a model. Give it an API key for a provider:

```sh
rho key anthropic
```

It asks for the key without showing it and stores it in `~/.rho/v2/keys.json`, readable only
by you. `openai`, `google` and `openrouter` work the same way, and `rho key` lists the rest.
A key in the provider's usual environment variable (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`GEMINI_API_KEY`, `OPENROUTER_API_KEY`) also works.

Then open it:

```sh
rho open
```

This starts rho and opens its page in your browser, already paired. Type a question. If no
browser can be opened, the command prints the address to open instead.

Rho listens only on `127.0.0.1`. To use it from another device, forward the port, for example
`ssh -L 4780:127.0.0.1:4780 your-machine`, then run `rho open --print` on the machine and
open the address it prints on your device. The address works once.

If rho has no key, `rho status` and the page say so and name the command to run.

### Signing in with a subscription instead

```sh
rho login openai
```

This runs the provider's own sign-in in your browser and stores the login in the same
`keys.json`. `rho login` lists the providers that have one, and `rho logout <provider>`
removes it. It is a subscription, not an API key: the provider decides what it may be used
for and can refuse or limit requests. An API key is the supported way to use rho.

## Commands

| Command | What it does |
| --- | --- |
| `rho open` | Start rho if needed and open the page with a one-use pairing link. `--print` prints the link instead. |
| `rho start`, `rho stop`, `rho status` | Start, stop, or show whether it runs and on which model. |
| `rho key [provider]` | Store an API key, or list the providers that have one. `--remove` deletes it. |
| `rho login <provider>`, `rho logout <provider>` | Sign in with a subscription through the provider's own flow, or remove that login. |
| `rho logs [lines]` | The last lines of rho's log. |
| `rho service install` | Run rho as a service that restarts it and starts it at boot. |
| `rho service uninstall`, `rho service status` | Remove the service, or show its state. |
| `rho release [commit]` | Release a commit from a work checkout into the running rho. |
| `rho version` | The commit this checkout is at. |

## Keeping it running

```sh
rho service install
rho start
```

On Termux this writes a runit service and a Termux:Boot script. It needs
`pkg install termux-services` (open a new Termux session afterwards), and the
[Termux:Boot](https://f-droid.org/packages/com.termux.boot/) app for a start at boot. The
boot script holds a wake lock for as long as the phone is up, which costs battery.

On Linux it writes and enables a systemd user unit. For rho to start at boot without you
logging in, turn on lingering once: `loginctl enable-linger $USER`.

The service does not get your shell's environment. It keeps `PATH`, `RHO_HOME`, `RHO_PORT`
and `RHO_CLAUDE` from the shell that installed it, and nothing else. **An API key that is
only in an environment variable is not seen by the service.** Store it with `rho key`.
The same holds without a service when rho restarts itself, as a release does: the new rho
does not have the variables of the shell you first started it from.

A reboot has not been tested on either platform.

## Settings

Settings are in `~/.rho/v2/config.json`. All are optional. Restart rho after a change.
Rho cannot open this file. It can propose a change to `model`, `thinking`, `cwd`, `checkins` or
`decider`: you are shown the old and the new value, and it is written only after you press Allow.

| Setting | Meaning |
| --- | --- |
| `model` | `provider/model` for new conversations. Default: the first of `anthropic/claude-sonnet-5-5`, `openai/gpt-5.5`, `google/gemini-3.1-pro-preview`, `openrouter/anthropic/claude-sonnet-5.5` whose provider has a key. |
| `thinking` | `off`, `minimal`, `low`, `medium` (default), `high`, `xhigh` or `max`, for new conversations. |
| `cwd` | The directory new conversations work in. Default: your home directory. `~` is your home directory. A conversation keeps the directory it was made with; change an existing one from the page's menu. |
| `maxTurns` | Most tool rounds in one run. Default 200. |
| `memory` | `{"kind": "file"}` (default), `{"kind": "honcho", "url": "...", "workspace": "...", "user": "...", "agent": "..."}`, or `{"kind": "off"}`. Honcho also takes `"apiKey"`, which is then stored in this file as plain text. |
| `decider` | `{"baseUrl": "http://127.0.0.1:8098", "model": "clef-flash"}`: a decision model (the System One API) that labels each shell command with a type and a confidence. It only watches: nothing is blocked. Read its log with `rho decisions`. Default: off. |
| `checkins` | `false` turns reminders off. `{"maxTurns": 20}` sets the limit of one check-in. |
| `providers` | Servers that speak the OpenAI chat API, such as a local model: `[{"id": "local", "baseUrl": "http://127.0.0.1:8080/v1", "models": ["model-name"]}]`. Add `"apiKeyEnv": "NAME"` if the server needs a key. |
| `claudePlan` | `true` adds Claude through your Claude Code login. See below. |

Environment variables: `RHO_HOME` (default `~/.rho`; rho 2 uses the `v2` directory inside
it), `RHO_PORT` (default 4780), `RHO_CLAUDE` (path of the `claude` command), `RHO_SERVICE`
(the service's name, default `rho`).

Rho also reads `AGENTS.md` files: `~/.rho/v2/AGENTS.md` for your standing instructions, and
the ones in a conversation's working directory and its parents.

### Using a Claude plan instead of an API key

With `"claudePlan": true`, rho adds the models of your Claude Code login. You need the
`claude` command installed and logged in. Rho starts Claude Code and lets it send its own
requests.

**Read this before you turn it on.** This is not an API key. Anthropic decides what a plan
may be used for and has changed it before. Requests can be refused, or charged to usage
credits instead of your plan. Rho stops a turn when Claude Code reports that it was charged
to credits, but it learns this only after that request was sent. An API key is the supported
way to use rho.

## Rho building rho

Rho runs from one checkout and you (or rho) work in another:

```sh
git clone ~/rho ~/rho-work
cd ~/rho-work && bun install --frozen-lockfile
```

Set `"cwd"` to the work checkout, ask rho for a change, and have it commit. Then
`rho release` in the work checkout (rho asks you first when it runs this itself) does the
following: runs `bun run check` on the commit in a clean copy, waits for rho to be idle,
switches the running checkout to the commit, restarts rho, and confirms it runs that commit.
If rho does not come up, the gate switches back and restarts the old commit. The result
appears in the conversation and in `rho release --status`. The card that asks you lists the
commits the release brings in, and the page shows the release's stage while it runs.

## Development

```sh
bun run check     # type check, then the tests
```

The tests call no model. `AGENTS.md` has the rules of the codebase and `TASKS.md` the record
of what was verified. Run `git config core.hooksPath .githooks` to have the check run before
each commit.

## Security

Rho runs commands as you, with your files and your shell. Read [SECURITY.md](SECURITY.md)
before you run it.

## Licence

MIT. See [LICENSE](LICENSE).
