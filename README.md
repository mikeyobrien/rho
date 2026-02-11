# rho

[![@tau_rho_ai](https://img.shields.io/badge/@tau__rho__ai-000000?logo=x)](https://x.com/tau_rho_ai)

An AI agent that stays running, remembers what you told it yesterday, and checks in on its own. Runs on macOS, Linux, and Android.

Your data stays on your device. No cloud for your memories. Bring your own LLM provider. You own everything.

Built on [pi coding agent](https://github.com/badlogic/pi-mono).

![Rho demo](docs/demo.gif)

## Quick start

### Install with your agent

If you already have a coding agent running, give it the [`SKILL.md`](SKILL.md) install runbook:

```bash
curl -fsSL https://raw.githubusercontent.com/mikeyobrien/rho/main/SKILL.md -o /tmp/install-rho.md
```

Then ask your agent to read it and follow the steps. Works with Claude Code, Codex, pi, or any agent that can run shell commands.

### npm

```bash
npm install -g @rhobot-dev/rho
rho init && rho sync
rho login && rho start
```

Prerequisites: Node.js (18+), tmux, git.

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
```

Inside a session:

```
/rho status           Show heartbeat state
/rho now              Trigger check-in immediately
/rho interval 30m     Set check-in interval
/rho enable/disable   Toggle heartbeat
/subagents            Check spawned subagent status
/vault inbox          View captured items
/brain                Interact with memory
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
| `memory-clean` | ✓ | ✓ | ✓ | Consolidate memory, decay stale entries, optional session mining |
| `update-pi` | ✓ | ✓ | ✓ | Update pi to latest version |

### Extensions

| Extension | Platforms | Description |
|-----------|-----------|-------------|
| `rho/` | All | Heartbeat, memory, tasks, and vault tooling |
| `brave-search/` | All | Web search via Brave API |
| `x-search/` | All | X (Twitter) search via xAI Grok (`x_search`) |
| `memory-viewer/` | All | Browse and search memories |
| `usage-bars/` | All | Token/cost usage display |

| `email/` | All | Agent inbox at name@rhobot.dev |
| `vault-search/` | All | Full-text search over the vault (FTS + ripgrep fallback) |
| `tasker.ts` | Android | UI automation via Tasker |

### Skills vs extensions

Skills are markdown files. The agent reads them and follows the instructions using its built-in tools (bash, read, write, edit). No code runs. Think of them as runbooks. They're compatible with Claude Code and Codex too, since they follow the [Agent Skills spec](https://agentskills.io).

Extensions are TypeScript that runs inside pi's process. They register new tools the LLM can call, hook into lifecycle events, persist state, add commands, and build custom UI. The heartbeat, the brain, and the vault are all extensions.

If the agent can already do it and just needs to know how, write a skill. If you need code running to make it possible, write an extension.

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

The `memory-clean` skill runs automatically to:
- **Decay** stale learnings (>90 days, low score)
- **Consolidate** duplicates and merge related entries
- **Mine sessions** for new learnings and preferences

Run manually:
```
Run memory-clean with session mining
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
│   ├── memory-clean/
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

- [Demo walkthrough](docs/demo.md)
- [iPhone/iPad setup](docs/iphone-setup.md)
- [VPS setup guide](docs/vps-setup.md)
- [pi coding agent](https://github.com/badlogic/pi-mono)
- [@tau_rho_ai](https://x.com/tau_rho_ai), Tau, an agent running on rho
