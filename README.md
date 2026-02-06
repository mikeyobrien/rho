# rho

[![@tau_rho_ai](https://img.shields.io/badge/@tau__rho__ai-000000?logo=x)](https://x.com/tau_rho_ai)

An AI agent that stays running, remembers what you told it yesterday, and checks in on its own. Runs on macOS, Linux, and Android.

Your data stays on your device. No cloud for your memories. Bring your own LLM provider. You own everything.

Built on [pi coding agent](https://github.com/badlogic/pi-mono).

![Rho demo](docs/demo.gif)

## Quick start

### macOS / Linux

```bash
git clone https://github.com/mikeyobrien/rho.git ~/projects/rho
cd ~/projects/rho && ./install.sh
```

Prerequisites: Node.js (18+), tmux, git. The installer checks and tells you what's missing.

### Android (Termux)

Install [Termux](https://f-droid.org/packages/com.termux/) and [Termux:API](https://f-droid.org/packages/com.termux.api/) from F-Droid, then:

```bash
curl -fsSL https://rhobot.dev/install | bash
```

Or step by step:

```bash
pkg install nodejs-lts tmux git
npm install -g @mariozechner/pi-coding-agent
git clone https://github.com/mikeyobrien/rho.git ~/projects/rho
cd ~/projects/rho && ./install.sh
```

### iPhone / iPad (via SSH)

Rho runs on a server you SSH into. Use [Termius](https://apps.apple.com/app/termius-terminal-ssh-client/id549039908) or any SSH client.

```bash
# On your server (VPS, home machine, or free Oracle Cloud instance):
git clone https://github.com/mikeyobrien/rho.git ~/projects/rho
cd ~/projects/rho && ./install.sh
rho login && rho -d

# On your iPhone: connect via SSH, then:
rho
```

Full guide: [docs/iphone-setup.md](docs/iphone-setup.md), including Termius config, Tailscale for home servers, and free VPS options.

## Run

```bash
rho           # Start and attach
rho -d        # Start in background
rho status    # Is it running?
rho stop      # Stop
```

Inside a session:

```
/rho status           Show heartbeat state
/rho now              Trigger check-in immediately
/rho interval 30m     Set check-in interval
/rho enable/disable   Toggle heartbeat
```

## What it does

The **heartbeat** checks in periodically (default: every 30 min). Each check-in reads your `~/RHO.md` checklist and `~/HEARTBEAT.md` scheduled tasks, runs what needs running, and reports back.

The **brain** persists across sessions. Learnings, preferences, and context accumulate in `~/.rho/brain/`.

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
| `update-pi` | ✓ | ✓ | ✓ | Update pi to latest version |

### Extensions

| Extension | Platforms | Description |
|-----------|-----------|-------------|
| `rho.ts` | All | Heartbeat and check-in loop |
| `brain.ts` | All | Persistent memory across sessions |
| `brave-search.ts` | All | Web search via Brave API |
| `memory-viewer.ts` | All | Browse and search memories |
| `usage-bars.ts` | All | Token/cost usage display |
| `moltbook-viewer.ts` | All | Moltbook post viewer |
| `email.ts` | All | Agent inbox at name@rhobot.dev |
| `tasker.ts` | Android | UI automation via Tasker |

### Skills vs extensions

Skills are markdown files. The agent reads them and follows the instructions using its built-in tools (bash, read, write, edit). No code runs. Think of them as runbooks. They're compatible with Claude Code and Codex too, since they follow the [Agent Skills spec](https://agentskills.io).

Extensions are TypeScript that runs inside pi's process. They register new tools the LLM can call, hook into lifecycle events, persist state, add commands, and build custom UI. The heartbeat, the brain, and the vault are all extensions.

If the agent can already do it and just needs to know how, write a skill. If you need code running to make it possible, write an extension.

## Customize

### RHO.md

Your checklist. The heartbeat reads this on every check-in.

```markdown
# RHO Checklist

## Quick Scan
- [ ] Any unread notifications?
- [ ] Battery below 20%?

## Active Work  
- [ ] Check build status on ~/projects/myapp

## Recurring
- [ ] Run ~/backup.sh every 6 hours
```

### HEARTBEAT.md

Time-based triggers.

```markdown
# Heartbeat Tasks

## Weather
- Schedule: 8am daily
- Action: Check weather and notify if rain expected

## Journal
- Schedule: 9pm daily
- Action: Write daily journal entry to ~/.rho/vault/log/
```

### SOUL.md

Your agent's voice and identity. Who it is, what it cares about, how it talks.

### Brain

Lives at `~/.rho/brain/`:

- `core.jsonl` -- Behavior, identity
- `memory.jsonl` -- Learnings and preferences (grows over time)
- `context.jsonl` -- Project-specific context
- `memory/YYYY-MM-DD.md` -- Daily memory log

Use the `memory` tool or `/brain` command to interact with it.

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
├── extensions/              # Core extensions (all platforms)
│   ├── brain.ts
│   ├── brave-search.ts
│   ├── memory-viewer.ts
│   ├── moltbook-viewer.ts
│   ├── rho.ts
│   └── usage-bars.ts
├── skills/                  # Core skills (all platforms)
│   └── update-pi/
├── platforms/
│   ├── android/
│   │   ├── extensions/      # tasker.ts
│   │   ├── skills/          # notification, clipboard, sms, stt, tts, ...
│   │   ├── scripts/bin/     # stt, stt-send
│   │   └── bootstrap.sh     # One-command Termux installer
│   ├── macos/
│   │   ├── skills/          # notification, clipboard, open-url, tts
│   │   └── setup.sh         # Dependency checker
│   └── linux/
│       ├── skills/          # notification, clipboard, open-url, tts
│       └── setup.sh         # Dependency checker
├── scripts/                 # Daemon management
│   ├── rho                  # Start/attach
│   ├── rho-daemon           # Background daemon
│   ├── rho-status           # Status check
│   ├── rho-stop             # Stop daemon
│   └── rho-trigger          # Trigger check-in
├── configs/                 # Configuration files
│   └── tmux-rho.conf        # SSH-friendly tmux config (installed on macOS/Linux)
├── brain/                   # Default brain files
├── tasker/                  # Importable Tasker profiles (Android)
├── install.sh               # Cross-platform installer
├── AGENTS.md.template       # Agent operating principles
├── RHO.md.template          # Check-in checklist
├── HEARTBEAT.md.template    # Scheduled tasks
└── SOUL.md.template         # Personality/voice
```

## Configuration

The installer writes `~/.config/rho/config` with:

```bash
RHO_DIR=/path/to/rho          # Where the repo lives
RHO_PLATFORM=android|macos|linux  # Detected platform
```

Scripts source this file at startup. You can override values manually.

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
