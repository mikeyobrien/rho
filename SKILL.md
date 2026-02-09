---
name: install-rho
description: "Install and configure Rho from scratch (Doom-style init.toml + sync). Only prereq: a coding agent that can run shell commands."
---

# Install Rho

Rho is a persistent AI agent framework. It runs in tmux, checks in on a heartbeat, accumulates memory across sessions, and manages a knowledge vault. This skill installs it from scratch.

**Prerequisites:** A coding agent that can run shell commands. That's it.

**What gets installed:**
- System deps (Node.js 18+, npm, tmux, git)
- [pi coding agent](https://github.com/badlogic/pi-mono) (the runtime rho extends)
- [rho](https://github.com/mikeyobrien/rho) (the agent framework)
- Config files in `~/.rho/` (AGENTS.md, SOUL.md, RHO.md, init.toml)

**Time:** ~5 minutes on a decent connection.

## Parameters

- **agent_name** (optional, default: `rho`): Name written into `~/.rho/init.toml` and templates.
- **heartbeat_interval** (optional, default: `30m`): How often the agent checks in. Written to `[settings.heartbeat].interval`.

## Steps

### 1. Detect environment

Print OS, shell, and dependency versions. This determines the install path.

**Constraints:**
- You MUST print OS + shell + node version (if present).
- You MUST NOT assume Termux unless `$TERMUX_VERSION` is set.

```bash
uname -a
printf "SHELL=%s\n" "$SHELL"
command -v node >/dev/null && node -v || echo "node: missing"
command -v npm  >/dev/null && npm -v  || echo "npm: missing"
command -v tmux >/dev/null && tmux -V || echo "tmux: missing"
command -v git  >/dev/null && git --version || echo "git: missing"
command -v pi   >/dev/null && pi --version || echo "pi: missing"
command -v rho  >/dev/null && rho --version || echo "rho: missing"
```

### 2. Install system dependencies

**Constraints:**
- You MUST ensure: Node.js >= 18, npm, tmux, git.
- You MUST detect the platform and use the correct package manager.
- You MUST NOT blindly run `sudo apt install` — detect the package manager first.

#### Android / Termux

```bash
pkg update -y
pkg install -y nodejs-lts tmux git
```

#### macOS

```bash
brew install node tmux git
```

#### Linux

Detect the package manager:

| Distro | Command |
|--------|---------|
| NixOS | Add to `environment.systemPackages` or `nix-shell -p nodejs tmux git` |
| Debian/Ubuntu | `sudo apt update && sudo apt install -y nodejs npm tmux git` |
| Arch | `sudo pacman -S nodejs npm tmux git` |
| Fedora | `sudo dnf install nodejs npm tmux git` |

If Node.js version is < 18, use [NodeSource](https://github.com/nodesource/distributions) or nvm.

### 3. Install pi coding agent

pi is the runtime that rho extends. Install it globally.

**Constraints:**
- You MUST install pi globally if `command -v pi` fails.
- You MUST verify the install succeeded.

```bash
command -v pi >/dev/null || npm install -g @mariozechner/pi-coding-agent
pi --version
```

### 4. Install rho

Clone the repo and run the installer. The installer handles config bootstrapping, CLI setup, and template generation.

**Constraints:**
- You MUST clone to `~/.rho/project` (the default path).
- You MUST NOT clone if the repo already exists (pull instead).
- You MUST run `install.sh` from within the repo directory.

```bash
if [ -d ~/.rho/project/.git ]; then
  echo "Rho repo exists, pulling latest..."
  cd ~/.rho/project && git pull --ff-only
else
  git clone https://github.com/mikeyobrien/rho.git ~/.rho/project
fi

cd ~/.rho/project && bash install.sh
```

The installer will:
1. Detect your platform
2. Check/install remaining dependencies
3. Install Node deps for the project
4. Set up the `rho` CLI on your PATH
5. Run `rho init` (generates `~/.rho/init.toml`, `~/.rho/AGENTS.md`, `~/.rho/SOUL.md`, `~/.rho/RHO.md`, brain defaults)
6. Run `rho sync` (writes pi's `settings.json` from your config)

### 5. Configure heartbeat interval (optional)

If the user requested a non-default interval, edit `~/.rho/init.toml`:

```bash
# Find the [settings.heartbeat] section and set the interval
sed -i 's/interval = "30m"/interval = "'"${HEARTBEAT_INTERVAL}"'"/' ~/.rho/init.toml
rho sync
```

### 6. Verify installation

**Constraints:**
- You MUST run `rho doctor` and report any failures.
- You MUST NOT declare success if doctor reports errors.

```bash
rho doctor
```

### 7. Authenticate

**Constraints:**
- You MUST tell the user to run `rho login` to set up their LLM provider.
- You MUST NOT run `rho login` automatically (it's interactive).

Tell the user:

> Run `rho login` to authenticate with your LLM provider (Anthropic, OpenAI, etc). This is interactive — you'll need to provide API keys or log in via browser.

### 8. Start rho (optional)

**Constraints:**
- You MUST ask before starting background processes.

```bash
rho
```

This starts the daemon if needed and attaches to the tmux session.

### 9. Post-install orientation

Share these essentials with the user:

**Key files:**
- `~/.rho/init.toml` — Main config (Doom-style: modules, settings, platform overrides)
- `~/.rho/AGENTS.md` — Agent operating principles (injected into system prompt)
- `~/.rho/SOUL.md` — Agent personality and identity
- `~/.rho/RHO.md` — Heartbeat checklist (read on every check-in)
- `~/.rho/HEARTBEAT.md` — Scheduled/time-based tasks

**CLI basics:**
- `rho` — Start and attach
- `rho status` — Show daemon and module status
- `rho doctor` — Health check
- `rho trigger` — Force immediate heartbeat
- `rho stop` — Stop daemon
- `rho upgrade` — Update rho and sync new modules

**Inside a session:**
- `/rho status` — Heartbeat state
- `/rho now` — Trigger check-in
- `/rho interval 30m` — Set check-in interval

**tmux essentials (if unfamiliar):**
- Detach: `Ctrl-b d`
- List sessions: `tmux -L rho ls`
- Attach: `tmux -L rho attach -t rho`

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `rho sync` says pi missing | `npm install -g @mariozechner/pi-coding-agent` |
| `rho doctor` shows settings out of sync | `rho sync` |
| `rho` not found after install | Add `~/.local/bin` to PATH |
| tmux missing | Install with your platform's package manager |
| Node.js < 18 | Upgrade via nvm or NodeSource |
| `install.sh` fails on NixOS | Dependencies must be in your nix config, not installed via apt |
