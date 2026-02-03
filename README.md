# rho

Personal configuration layer for [pi coding agent](https://github.com/badlogic/pi-mono). Pi is the base, Rho is the personality.

## Structure

```
rho/
├── extensions/         # Custom tools and event handlers
│   ├── brave-search.ts # Web search
│   ├── brain.ts        # Persistent memory system
│   └── tasker.ts       # Android UI automation via Tasker
├── skills/             # On-demand capability packages
├── brain/              # Default brain files (copied on install)
├── AGENTS.md.template  # Identity template (injected on install)
└── install.sh          # Setup script
```

## Installation

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
- [AutoInput](https://play.google.com/store/apps/details?id=com.joaomgcd.autoinput) plugin
- Tasker profiles for each `rho.tasker.*` intent (see docs/tasker-profiles.md)

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
