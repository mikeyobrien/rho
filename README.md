# rho

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/mikeyobrien/rho)
[![@tau_rho_ai](https://img.shields.io/badge/@tau__rho__ai-000000?logo=x)](https://x.com/tau_rho_ai)

An AI agent that stays running, remembers what you told it yesterday, and checks in on its own. Runs on macOS, Linux, and Android.

Your data stays on your device. No cloud for your memories. Bring your own LLM provider. You own everything.

Built on [pi coding agent](https://github.com/badlogic/pi-mono).

![Rho demo](docs/demo.gif)

## Quick start

### Install with your agent

Ask your coding agent to fetch and follow the [install runbook](https://raw.githubusercontent.com/mikeyobrien/rho/main/SKILL.md).

### npm

```bash
npm install -g @rhobot-dev/rho
rho init && rho sync
rho login && rho start
```

### pi

```bash
pi install npm:@rhobot-dev/rho
rho init && rho sync
rho login && rho start
```

Prerequisites for both: Node.js (18+), tmux, git.

### macOS / Linux

```bash
git clone https://github.com/mikeyobrien/rho.git ~/.rho/project
cd ~/.rho/project && ./install.sh
```

Prerequisites: Node.js (18+), tmux, git. The installer checks and tells you what's missing. NixOS is detected and supported.

### Android (Termux)

Install [Termux](https://f-droid.org/packages/com.termux/) and [Termux:API](https://f-droid.org/packages/com.termux.api/) from F-Droid, then:

```bash
curl -fsSL https://rhobot.dev/install | bash
```

Or step by step:

```bash
pkg install nodejs-lts tmux git
npm install -g @mariozechner/pi-coding-agent
git clone https://github.com/mikeyobrien/rho.git ~/.rho/project
cd ~/.rho/project && ./install.sh
```

### iPhone / iPad (via SSH)

Rho runs on a server you SSH into. Use [Termius](https://apps.apple.com/app/termius-terminal-ssh-client/id549039908) or any SSH client.

```bash
# On your server (VPS, home machine, or free Oracle Cloud instance):
git clone https://github.com/mikeyobrien/rho.git ~/.rho/project
cd ~/.rho/project && ./install.sh
rho login && rho start

# On your iPhone: connect via SSH, then:
rho
```

Full guide: [docs/iphone-setup.md](docs/iphone-setup.md), including Termius config, Tailscale for home servers, and free VPS options.

## Run

```bash
rho                      # Start and attach
rho init                 # Initialize Rho config in ~/.rho/
rho sync                 # Sync config to pi settings.json
rho doctor               # Check system health and config validity
rho login                # Authenticate with pi providers
rho start                # Start in background
rho stop                 # Stop
rho status               # Show daemon and module status
rho trigger              # Force an immediate heartbeat check-in
rho config               # Show current configuration
rho logs                 # Show recent heartbeat output
rho upgrade              # Update Rho and sync new modules
rho skills <args>        # Unified skills CRUD (default provider: vercel)
```

Inside a session:

```
/rho status              Show heartbeat state
/rho now                 Trigger check-in immediately
/rho interval 30m        Set check-in interval
/rho enable/disable      Toggle heartbeat
/bootstrap status        Show bootstrap state + managed count + agentic phase
/bootstrap run           Activate agentic bootstrap conversation
/bootstrap diff          Show agentic bootstrap mode/phase/injection state
/bootstrap reapply       Restart agentic bootstrap from identity discovery
/bootstrap upgrade       Alias for reapply (agentic restart)
/bootstrap reset --confirm RESET_BOOTSTRAP
                         Reset bootstrap state safely
/bootstrap audit         Show recent bootstrap lifecycle events
/subagents               Check spawned subagent status
/vault inbox             View captured items
/brain                   Interact with memory
/skill run pdd           Run the Prompt-Driven Development workflow
/skill run code-assist   Run the code implementation workflow
```

## What it does

The **heartbeat** checks in periodically (default: every 30 min). Each check-in reads reminders and tasks from the **brain**, runs what needs running, and reports back.

The **brain** persists across sessions as a single `brain.jsonl` file. It stores behaviors, identity, learnings, preferences, tasks, reminders, and context — everything the agent needs to remember.

**Agent email** gives your agent a real email address at `name@rhobot.dev`. People and services can email your agent directly. The agent polls its inbox, reads messages, and can reply. Free tier gets receive + 1 outbound email per hour. Register with:

```
Ask your agent: "Set up my agent email at <name>@rhobot.dev"
```

Or use the `/email` command once registered:

```
/email check        Poll inbox for new mail
/email list         Show unread messages
/email send <to> <subject>   Send a quick email
```

**Telegram channel adapter** lets the agent receive prompts from Telegram and reply in-thread.

Quick setup:

```bash
# 1) Set bot token in your shell profile
export TELEGRAM_BOT_TOKEN="<bot-token>"

# 2) Enable in ~/.rho/init.toml
# [settings.telegram]
# enabled = true

rho sync
rho telegram onboard
rho telegram start
```

Operator controls:

```
/telegram status
/telegram check
/telegram allow-chat <chat_id>
/telegram allow-user <user_id>
```

Common Telegram shortcuts:

```
/status    -> /telegram status
/check     -> /telegram check
/telegram  -> /telegram status
```

Approval flow for blocked senders:

```bash
rho telegram pending
rho telegram approve --pin 123456
rho telegram reject --pin 123456
```

Security model (MVP):
- Polling-only transport (`getUpdates`) with durable offset state
- Optional `allowed_chat_ids` / `allowed_user_ids` gates
- Group activation gate via `require_mention_in_groups`
- Bounded retries for transient send failures and 429 rate-limits

Rollout notes:
- MVP is polling-first; webhook mode is reserved for future work
- Keep allowlists tight before exposing in group chats
- If the module is disabled (`settings.telegram.enabled = false`), it is idle/no-op

Troubleshooting:
- `Missing token env`: export `TELEGRAM_BOT_TOKEN` (or your configured `bot_token_env`)
- No group replies: mention the bot (or set `require_mention_in_groups = false`)
- Delivery delays: check `/telegram status` for retry/failure counters
- Long prompts: foreground soft-timeout (`rpc_prompt_timeout_seconds`) now forks work into durable `/jobs` tasks; use `/jobs`, `/job <id>`, `/cancel <id>` to manage long-running work

See full setup and smoke validation guide: [docs/telegram.md](docs/telegram.md).

**Skills** are capability packages the agent loads on demand. The installer detects your OS and installs the right ones. Notifications, clipboard, and text-to-speech work on every platform. Android gets SMS, speech-to-text, camera, GPS, and Tasker automation on top of that.

### Skills

| Skill | Android | macOS | Linux | Description |
|-------|:-------:|:-----:|:-----:|-------------|
| `notification` | ✓ | ✓ | ✓ | System notifications |
| `clipboard` | ✓ | ✓ | ✓ | Clipboard read/write |
| `tts` | ✓ | ✓ | ✓ | Text-to-speech |
| `open-url` | ✓ | ✓ | ✓ | Open URLs and apps |
| `sms` | ✓ | | | Read and send SMS |
| `stt` | ✓ | | | Speech-to-text |
| `media` | ✓ | | | Audio, camera, recording |
| `location` | ✓ | | | GPS/network location |
| `contacts` | ✓ | | | Contact lookup |
| `device` | ✓ | | | Battery, torch, vibration |
| `dialog` | ✓ | | | Interactive input dialogs |
| `tasker-xml` | ✓ | | | Create Tasker automations |
| `rho-cloud-onboard` | ✓ | ✓ | ✓ | Register an agent email address |
| `rho-cloud-email` | ✓ | ✓ | ✓ | Manage agent email address |
| `memory-consolidate` | ✓ | ✓ | ✓ | Consolidate memory, decay stale entries, and mine sessions since last consolidation |
| `update-pi` | ✓ | ✓ | ✓ | Update pi to latest version |

### Extensions

| Extension | Platforms | Description |
|-----------|-----------|-------------|
| `rho/` | All | Heartbeat, memory, tasks, vault tooling, plus workflow aliases (`/plan`, `/code`) |
| `brave-search/` | All | Web search via Brave API |
| `x-search/` | All | X (Twitter) search via xAI Grok (`x_search`) |
| `telegram/` | All | Telegram adapter (polling MVP, chat/session bridge, operator controls) |
| `email/` | All | Agent inbox at name@rhobot.dev |
| `vault-search/` | All | Full-text search over the vault (FTS + ripgrep fallback) |
| `memory-viewer/` | All | Browse and search memories |
| `usage-bars/` | All | Token/cost usage display |
| `tasker.ts` | Android | UI automation via Tasker |

### Skills vs extensions

Skills are markdown files. The agent reads them and follows the instructions using its built-in tools (bash, read, write, edit). No code runs. Think of them as runbooks. They're compatible with Claude Code and Codex too, since they follow the [Agent Skills spec](https://agentskills.io).

SOPs are a **skill subtype** (`kind: sop` in frontmatter). Run them with `/skill run <name>` — there is no separate legacy sop command surface.

Extensions are TypeScript that runs inside pi's process. They register new tools the LLM can call, hook into lifecycle events, persist state, add commands, and build custom UI. The heartbeat, the brain, and the vault are all extensions.

If the agent can already do it and just needs to know how, write a skill. If you need code running to make it possible, write an extension.

### External skills providers

Rho ships a unified `rho skills` wrapper with provider routing.

Canonical commands:
- `install`
- `list`
- `show`
- `update`
- `remove`
- `search`

Default provider is **vercel**:

```bash
rho skills install vercel-labs/agent-skills --skill web-design-guidelines
```

This uses `npx skills` with Pi defaults (`--agent pi --global`) so skills are available under:
- `~/.pi/agent/skills/` (Pi-visible links)
- `~/.agents/skills/` (canonical store)

Use **clawhub** when you want registry-based installs like `sonoscli`:

```bash
rho skills --provider clawhub search sonos
rho skills --provider clawhub inspect sonoscli --versions
rho skills --provider clawhub install sonoscli
```

ClawHub installs directly under:
- `~/.pi/agent/skills/<slug>`
- lockfile: `~/.pi/agent/.clawhub/lock.json`

## Web UI

<img width="1816" height="1530" alt="image" src="https://github.com/user-attachments/assets/83f73af7-9016-4a8a-887e-e736d779deaa" />


A browser-based interface for chatting, browsing memory, managing tasks, and editing config. Useful for phones, tablets, or any device on your network.

```bash
rho web                  # Start on default port (3141)
rho web --port 4000      # Custom port
rho web --open           # Start and open browser
```

Then visit `http://localhost:3141` (or your machine's IP for remote access — the server binds `0.0.0.0` by default).

### Web code architecture (no-build)

Rho-web is intentionally split between server-side TypeScript and browser-side JavaScript:

- `web/*.ts` runs in Node (via `tsx`/strip-types) for the Hono server, RPC bridge, and backend routes.
- `web/public/js/*.js` runs directly in the browser and is served as static assets (no frontend bundler/transpiler step).
- Chat frontend code is ES modules in `web/public/js/chat/` with `web/public/js/chat.js` as the module entrypoint.

Why this matters:

- Browsers do not execute `.ts` directly, so browser runtime code stays in `.js` unless we add a build step.
- Keep imports and boundaries explicit in browser modules; avoid implicit global/script-order coupling.
- Enforce the 500-line limit for `web/**/*.ts` and `web/**/*.js` to keep files maintainable.
- Pre-commit hooks run strict Biome (`check --error-on-warnings`) on staged `.ts/.js` plus staged-only web line-limit checks.

Hooks are installed automatically when running `npm install` in this repo (`prepare` -> `simple-git-hooks`).

### Views

| View | Description |
|------|-------------|
| **Chat** | Browse sessions, fork from any message, start new conversations. Model and thinking level selectable per session. |
| **Memory** | Filter, search, create, edit, and delete brain entries (learnings, preferences, behaviors, etc.) |
| **Tasks** | View and manage tasks from brain.jsonl |
| **Config** | Edit `~/.rho/init.toml` directly in the browser |

The Chat view connects to pi over RPC and WebSocket — responses stream in real-time. Forking creates a branch from any user message in a session's history.

### Code Review

Extensions can open files for line-level review in the browser. The review UI supports multi-line selection, inline commenting, and submitting or cancelling. Access active reviews at `/review`.

### Configuration

Add to `~/.rho/init.toml` to configure the web server:

```toml
[settings.web]
port = 3141       # Server port (default: 3141)
enabled = false   # Auto-start with `rho start`
```

## Customize

### Brain

Everything lives in `~/.rho/brain/brain.jsonl` — a single append-only log of structured entries:

| Type | Stores |
|---|---|
| `behavior` | How the agent acts (do, don't, value) |
| `identity` | Who the agent is |
| `user` | Facts about the user |
| `preference` | User likes/dislikes by category |
| `learning` | Things discovered in sessions |
| `context` | Project-specific settings |
| `task` | Checklist items |
| `reminder` | Time-based triggers |

**Modify via the brain tool:**
```
/brain                           # Open memory viewer
brain action=add type=behavior category=do text="..."
brain action=add type=reminder text="Check weather" cadence={kind:"daily",at:"08:00"}
brain action=add type=task text="Review PRs" priority=high
```

**Or edit directly** (the file is plain JSONL, one entry per line).

### Auto-extraction

The `memory-consolidate` skill runs to:
- **Decay** stale learnings (>90 days, low score)
- **Consolidate** duplicates and merge related entries
- **Mine sessions** since the last consolidation checkpoint
- **Relocate** reference-heavy entries to the vault for ad-hoc search

Run manually:
```
Run memory-consolidate with session mining
```


### Vault

For reference material that needs structure (architecture docs, research, project overviews), use the vault:

```
vault write slug=my-project-arch type=concept
```

Creates markdown notes with wikilinks in `~/.rho/vault/`.

## Tasker setup (Android, optional)

For UI automation (reading screens, tapping elements, controlling apps):

1. Install [Tasker](https://play.google.com/store/apps/details?id=net.dinglisch.android.taskerm) and [AutoInput](https://play.google.com/store/apps/details?id=com.joaomgcd.autoinput)
2. In Tasker: long-press home icon > Import Project > select `tasker/Rho.prj.xml`
3. Enable the imported profiles

Optional (screenshot without permission dialog):
```bash
# Enable wireless ADB in Developer Options, then:
adb pair <ip>:<port> <pairing-code>
adb connect <ip>:<port>
adb shell appops set net.dinglisch.android.taskerm PROJECT_MEDIA allow
```

## Project structure

```
rho/
├── cli/                     # Node.js CLI (rho init/sync/doctor/upgrade/...)
│   ├── index.ts
│   ├── config.ts
│   ├── registry.ts
│   ├── sync-core.ts
│   ├── doctor-core.ts
│   ├── daemon-core.ts
│   └── commands/
├── templates/               # Default ~/.rho/*.toml templates
│   ├── init.toml
│   └── packages.toml
├── extensions/              # Core pi extensions (loaded via pi package entry)
│   ├── brave-search/
│   ├── email/
│   ├── memory-viewer/
│   ├── rho/
│   ├── usage-bars/
│   ├── vault-search/
│   └── lib/                  # shared modules (NOT an extension)
│       └── mod.ts            # barrel exports (do not name this index.ts)
├── skills/                  # Core skills (loaded via pi package entry)
│   ├── memory-consolidate/
│   ├── pdd/
│   ├── code-assist/
│   ├── small-improvement/
│   ├── vault-clean/
│   ├── rho-cloud-email/
│   ├── rho-cloud-onboard/
│   ├── session-search/
│   └── update-pi/
├── platforms/               # Platform-only local skills/extensions installed by install.sh
│   ├── android/
│   │   ├── extensions/      # tasker.ts
│   │   ├── skills/          # notification, clipboard, sms, stt, tts, ...
│   │   └── scripts/bin/     # stt, stt-send
│   ├── macos/
│   │   ├── skills/          # notification, clipboard, open-url, tts
│   │   └── setup.sh
│   └── linux/
│       ├── skills/          # notification, clipboard, open-url, tts
│       └── setup.sh
├── web/                     # Web UI backend + frontend (no-build browser JS)
│   ├── server.ts            # Server composition entrypoint
│   ├── server-core.ts       # Shared Hono app/runtime context
│   ├── server-*-routes.ts   # Route modules (review/git/config/sessions/tasks/memory/ws/static)
│   ├── session-reader.ts    # Session reader public API
│   ├── session-reader-*.ts  # Session reader internals (types/io/parse/api)
│   ├── rpc-manager.ts       # pi RPC process manager
│   ├── config.ts            # Web config helpers
│   └── public/              # Static assets (HTML, CSS, JS)
│       └── js/chat/         # Chat frontend ES modules
├── configs/                 # Configuration files
│   └── tmux-rho.conf        # SSH-friendly tmux config (used by rho's tmux socket)
├── brain/                   # Default brain.jsonl with core behaviors
├── tasker/                  # Importable Tasker profiles (Android)
├── SKILL.md                 # Portable install skill (works with any agent)
├── bootstrap.sh             # Universal installer (curl | bash)
└── install.sh               # Cross-platform installer (platform extras + rho init/sync)
```

## Configuration

Doom-style config lives in:
- `~/.rho/init.toml` (modules + settings)
- `~/.rho/packages.toml` (third-party pi packages)

`install.sh` installs the `rho` command on your PATH (typically `$PREFIX/bin` on Termux or `~/.local/bin` on macOS/Linux).

After editing either file, run:

```bash
rho sync
```

## Adding a platform

1. Create `platforms/<name>/skills/` with SKILL.md files for the platform
2. Optionally add `platforms/<name>/extensions/` for platform-specific extensions
3. Optionally add `platforms/<name>/setup.sh` to check/install dependencies
4. Add a detection case in `install.sh` (`detect_platform` function)
5. Submit a PR

## Environment variables

```bash
BRAVE_API_KEY="..."     # For web search (optional)
```

## Links

- [Brain bootstrapping guide](docs/bootstrapping-brain.md)
- [Skills providers (vercel + clawhub)](docs/skills.md)
- [Demo walkthrough](docs/demo.md)
- [iPhone/iPad setup](docs/iphone-setup.md)
- [VPS setup guide](docs/vps-setup.md)
- [pi coding agent](https://github.com/badlogic/pi-mono)
- [@tau_rho_ai](https://x.com/tau_rho_ai), Tau, an agent running on rho
