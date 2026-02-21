# rho

[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/mikeyobrien/rho)
[![@tau_rho_ai](https://img.shields.io/badge/@tau__rho__ai-000000?logo=x)](https://x.com/tau_rho_ai)

An always-on personal AI operator that:
- stays running in the background,
- remembers context across sessions,
- and checks in proactively on a schedule.

Runs on **macOS**, **Linux**, and **Android** (plus **iPhone/iPad via SSH**).

<p align="center">
  <img alt="rho web ui" src="docs/web-ui-hero.jpg" />
</p>

Built on [pi coding agent](https://github.com/badlogic/pi-mono).

<details>
<summary><b>Terminal demo</b></summary>

![Rho demo](docs/demo.gif)

</details>

---

## Why rho

Most AI tools are stateless chat tabs. rho is built for ongoing operation.

- **Persistent memory**: durable context across sessions
- **Memory observability**: inspect, search, and edit what the agent has learned
- **Proactive heartbeat**: check-ins every 30m by default
- **Local-first state**: your memory and config stay on your machine
- **BYO model/provider**: use your own pi/provider setup
- **Multi-surface control**: terminal, web UI, Telegram, and agent email

---

## 2-minute quick start (recommended)

Prerequisites: **Node.js 18+**, **tmux**, **git**

```bash
npm install -g @rhobot-dev/rho
rho init && rho sync
rho login && rho start
rho
```

That gives you:
- initialized config in `~/.rho/`
- authenticated provider access via pi
- background heartbeat daemon
- an attached interactive session

### First 5 minutes

Run these after install:

```bash
rho status                # daemon + module health
/rho status               # heartbeat status (inside session)
/rho now                  # trigger immediate check-in
/brain                    # open memory viewer
/vault inbox              # see captured knowledge items
```

---

## Web UI (first-class, built in)

rho includes a browser workspace for day-to-day operation:

- chat with real-time streaming responses
- session browsing + forking from any message
- memory management (`/brain` entries)
- task management
- config editing (`~/.rho/init.toml`)
- line-level code review at `/review`

### Lightweight + performant by design

- **No-build web split**: server logic in `web/*.ts`, browser runtime in `web/public/js/*.js` (no frontend bundler/transpile pipeline).
- **Lean server runtime**: Hono-based routes with response compression enabled.
- **Low-latency updates**: live RPC/WebSocket streaming for chat responses.
- **Push over poll where possible**: server emits `sessions_changed` UI events; client updates immediately.
- **Idle-aware behavior**: polling pauses when the tab is hidden or user is idle, then resumes on activity.
- **Render throttling for streams**: markdown updates are debounced (150ms) to reduce UI churn during rapid token deltas.
- **Session metadata caching**: session info is cached by file `mtime` to avoid unnecessary re-reads.

```bash
rho web
rho web --port 4000
rho web --open
```

Then open `http://localhost:3141` (or your host IP).

### Positioning vs OpenClaw / nanobot

| Project | Web experience emphasis |
|---|---|
| **rho** | Built-in operator workspace with stronger memory observability and a lightweight no-build stack (chat, learned-memory inspection/editing, tasks, config, review) |
| **OpenClaw** | Strong Gateway Control UI + WebChat control plane |
| **nanobot** | README primarily emphasizes CLI + channel gateway flows |

---

## Install alternatives

<details>
<summary><b>pi package install</b></summary>

```bash
pi install npm:@rhobot-dev/rho
rho init && rho sync
rho login && rho start
```

</details>

<details>
<summary><b>macOS / Linux (installer script)</b></summary>

```bash
git clone https://github.com/mikeyobrien/rho.git ~/.rho/project
cd ~/.rho/project && ./install.sh
```

The installer checks missing dependencies and supports NixOS.

</details>

<details>
<summary><b>Android (Termux)</b></summary>

Install [Termux](https://f-droid.org/packages/com.termux/) and [Termux:API](https://f-droid.org/packages/com.termux.api/) from F-Droid, then:

```bash
curl -fsSL https://rhobot.dev/install | bash
```

</details>

<details>
<summary><b>iPhone / iPad via SSH</b></summary>

Run rho on a server/VPS/home machine, then connect from iOS using Termius (or any SSH client).

Guide: [docs/iphone-setup.md](docs/iphone-setup.md)

</details>

---

## What you can do with rho

| Use case | What rho does |
|---|---|
| **Daily operator loop** | Keeps reminders/tasks alive between sessions and runs periodic check-ins |
| **Memory-backed coding copilot** | Stores durable behavior/preferences/learnings, and lets you inspect/edit that learned state directly |
| **Inbox agent** | Gets `name@rhobot.dev`, polls, reads, and replies to email |
| **Telegram-controlled agent** | Receives prompts from Telegram and responds in-thread |
| **Browser control panel** | Web UI for chat, memory, tasks, and config |

---

## Surfaces and modules

### Core runtime
- **Heartbeat**: scheduled autonomous check-ins
- **Brain**: append-only structured memory (`brain.jsonl`)
- **Vault**: markdown knowledge graph (`~/.rho/vault/`)

### Channels
- **Email**: agent inbox at `name@rhobot.dev`
- **Telegram**: polling adapter with allowlist + moderation flow

### Interface
- **CLI**: `rho ...` commands
- **Session slash commands**: `/rho`, `/brain`, `/vault`, `/skill`, `/telegram`, `/email`
- **Web UI**: chat + memory/tasks/config in browser

---

## Security and ownership model

- **Your memory is local** (`~/.rho/brain/brain.jsonl`)
- **Your config is local** (`~/.rho/init.toml`, `~/.rho/packages.toml`)
- **Your providers are yours** (`rho login` via pi)
- **Telegram controls**: allowlists and mention gating
- **Email controls**: sender controls + outbound policy limits

No hosted rho memory backend required.

---

## Command quick reference

```bash
rho                      # start and attach
rho init                 # initialize ~/.rho config
rho sync                 # sync rho config to pi
rho doctor               # health + config checks
rho login                # authenticate providers
rho start                # start background daemon
rho stop                 # stop daemon
rho status               # daemon/module status
rho trigger              # force heartbeat now
rho logs                 # recent heartbeat output
rho config               # show effective config
rho calc "2 + 2 * 3"     # quick arithmetic calculator
rho upgrade              # update and resync
rho skills <args>        # skills provider wrapper
```

Inside a session:

```text
/rho status              heartbeat state
/rho now                 immediate check-in
/rho interval 30m        set check-in interval
/rho enable/disable      toggle heartbeat
/bootstrap status        bootstrap lifecycle state
/brain                   memory operations
/vault inbox             captured vault items
/skill run pdd           planning workflow
/skill run code-assist   implementation workflow
```

---

## Platform support

| Platform | Status | Notes |
|---|---|---|
| Linux | Supported | Native install + daemon + web UI |
| macOS | Supported | Native install + daemon + web UI |
| Android (Termux) | Supported | Extra mobile capabilities via platform skills |
| iPhone/iPad | Supported (SSH client) | Run rho remotely, connect via SSH |

---

## Docs map

- [Demo walkthrough](docs/demo.md)
- [Telegram setup + troubleshooting](docs/telegram.md)
- [iPhone/iPad setup](docs/iphone-setup.md)
- [VPS setup guide](docs/vps-setup.md)
- [Skills providers (vercel + clawhub)](docs/skills.md)
- [Brain bootstrapping guide](docs/bootstrapping-brain.md)
- [Configuration reference](docs/configuration.md)

---

## For contributors

Project structure and internals are intentionally modular:
- `cli/` for command surface and daemon orchestration
- `extensions/` for runtime tools/modules
- `skills/` for portable markdown runbooks
- `platforms/` for platform-specific installs/capabilities
- `web/` for browser UI + RPC bridge

For full tree + extension/skill details, see current `README.md` and `docs/`.

---

## Links

- [pi coding agent](https://github.com/badlogic/pi-mono)
- [@tau_rho_ai](https://x.com/tau_rho_ai)
