# rho

Personal configuration layer for [pi coding agent](https://github.com/badlogic/pi-mono). Pi is the base, Rho is the personality.

Influenced by [OpenClaw](https://github.com/openclaw/openclaw) — the idea of an agent with continuous presence, periodic check-ins, and persistent memory.

## Structure

```
rho/
├── extensions/         # Custom tools and event handlers
│   ├── rho.ts          # Continuous presence (periodic check-ins)
│   ├── brain.ts        # Persistent memory system
│   ├── brave-search.ts # Web search
│   └── tasker.ts       # Android UI automation via Tasker
├── skills/             # On-demand capability packages
├── scripts/            # Shell scripts for daemon management
│   ├── rho-daemon      # Start background daemon
│   ├── rho-stop        # Stop daemon
│   ├── rho-trigger     # Manual check-in trigger
│   └── rho-status      # Check daemon status
├── tasker/             # Importable Tasker profiles (.prf.xml)
├── brain/              # Default brain files (copied on install)
├── AGENTS.md.template  # Identity template (injected on install)
├── RHO.md.template     # Checklist template for check-ins
└── install.sh          # Setup script
```

## Installation

### Quick install (scripts only)

```bash
# Add rho apt repository
echo "deb [trusted=yes] https://mikeyobrien.github.io/rho/apt ./" > $PREFIX/etc/apt/sources.list.d/rho.list

# Install
pkg update && pkg install rho
```

This installs `rho-daemon`, `rho-status`, `rho-stop`, `rho-trigger` to PATH.

### Full install (extensions, skills, brain)

```bash
git clone https://github.com/mikeyobrien/rho.git ~/projects/rho
cd ~/projects/rho
./install.sh
```

This will:
- Symlink extensions and skills to `~/.pi/agent/`
- Create `~/AGENTS.md` with your runtime environment
- Bootstrap `~/.pi/brain/` with defaults

## Extensions

### rho.ts
Continuous presence system. Periodic check-ins to surface urgent tasks, follow-ups, and session health issues without interrupting flow.

**Commands:**
- `/rho status` — Show check-in state
- `/rho enable/disable` — Toggle check-ins  
- `/rho now` — Trigger check-in immediately
- `/rho interval 30m` — Set interval (5m-24h, or 0 to disable)

**Tools:**
- `rho_control(action, interval?)` — LLM-callable control

**Daemon (runs in background):**
```bash
rho-daemon      # Start background daemon (tmux + wake lock)
rho-stop        # Stop daemon
rho-trigger     # Manual trigger
rho-status      # Check if running
```

**Tasker Integration:**
- `RhoDaemonBoot.prf.xml` — Auto-start on boot
- `RhoPeriodic.prf.xml` — Trigger every 30m  
- `RhoManual.prf.xml` — Intent handler `rho.tasker.check`

**Checklist:** Create `~/RHO.md` for custom checklists (auto-read on each check-in).

### brain.ts
Persistent memory (learnings, preferences, context)

### brave-search.ts
Web search via Brave Search API

### tasker.ts
Android UI automation via Tasker + AutoInput. Enables the agent to control the Android device.

**Actions:**
- `open_url` — Open URL in browser
- `click` — Click element by text or coordinates
- `type` — Type text into focused field
- `read_screen` — Read visible UI text
- `read_elements` — Get UI elements with coordinates for precise clicking
- `screenshot` — Capture screen (requires one-time ADB permission grant)
- `scroll` — Scroll up/down
- `back` / `home` — Navigation
- `wait_for` — Wait for specific text to appear

**Requirements:**
- [Tasker](https://play.google.com/store/apps/details?id=net.dinglisch.android.taskerm) app

**Optional: AutoInput**

[AutoInput](https://play.google.com/store/apps/details?id=com.joaomgcd.autoinput) is a Tasker plugin that enables UI automation (clicking elements, reading screen text, gestures). Required for:
- `click`, `read_screen`, `read_elements`, `scroll` actions
- X/Twitter navigation
- Any app control automation

If you have AutoInput installed, import the Rho Tasker project:

1. Copy `tasker/Rho.prj.xml` to your device
2. Open Tasker → Long-press the home icon (bottom left) → Import Project
3. Select `Rho.prj.xml`
4. Enable the imported profiles

This provides all the Intent handlers (`rho.tasker.*`) needed for UI automation.

**Optional (for screenshot without permission dialog):**
```bash
# Enable wireless ADB in Developer Options, then:
adb pair <ip>:<port> <pairing-code>
adb connect <ip>:<port>
adb shell appops set net.dinglisch.android.taskerm PROJECT_MEDIA allow
adb shell appops set com.joaomgcd.autoinput PROJECT_MEDIA allow
```

## Environment Variables

```bash
export BRAVE_API_KEY="your-key"  # Required for brave-search
```

## Brain

Rho uses a JSONL-based memory system at `~/.pi/brain/`:

- `core.jsonl` — Identity, behavior, user info
- `memory.jsonl` — Learnings and preferences (grows over time)
- `context.jsonl` — Project-specific context (matched by cwd)

Use the `memory` tool or `/brain` command to interact with it.
