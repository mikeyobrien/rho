# Cross-Platform Rho — Requirements

## Q&A Record

### Q1: Who is the primary user for cross-platform Rho, and what's the motivating use case?

Is this mainly for you — running Rho on your own Mac/Linux machines alongside your phone? Or are you thinking about other developers installing Rho as a general-purpose agent framework? The answer shapes how much polish the install/onboarding needs vs. just making the core work on multiple platforms.

**A1:** Both. Immediate use case is running Rho on Mac and Linux alongside the phone. Bigger picture is Rho as a general-purpose agent framework anyone can install. The phone angle is a compelling demo/differentiator, but the persistent agent with heartbeat and memory is the real value prop — that should work everywhere. Approach: make it work for me first on all my machines, but design it so install/onboarding is clean enough for other developers.

---

### Q2: Should Rho instances on different machines share state, or are they independent agents?

When you're running Rho on your phone, your Mac, and a Linux box — do they each have their own brain/memory and heartbeat schedule? Or do you want a shared memory layer where your Mac Rho knows what your phone Rho learned? Independent instances are simpler and probably the right v1, but I want to confirm that assumption before it bakes into the design.

**A2:** Independent agents for v1. Each machine gets its own brain, heartbeat, and personality. Shared state is future concern — maybe syncing memory via git or shared JSONL backend, but that's v2+ territory. Each Rho instance is self-contained.

---

### Q3: What's the daemon/service story for macOS and Linux?

On Termux, Rho runs in a tmux session that you interact with directly. On a Mac or Linux server, do you want the same model (tmux session you attach to), or a proper system service (launchd on macOS, systemd on Linux) that runs in the background and survives reboots? The system service route is more "production" but adds complexity — service files, log management, start/stop commands. The tmux route is simpler and consistent with how it works today.

**A3:** Tmux is the primary interface for v1. Keep it consistent across all platforms — tmux session you attach to. Optionally generate service files (launchd plist, systemd unit) that start the tmux session on boot for people who want persistence. Tmux is always the interaction model; system services are just an auto-start mechanism, not a replacement.

---

### Q4: How should platform-specific capabilities be organized — subdirectories in the Rho repo, or separate packages/repos?

Your rough idea flagged this as an open question. The options I see:

1. **Subdirectories in the Rho repo** (e.g., `platforms/android/`, `platforms/macos/`, `platforms/linux/`) — simple, one repo, easy to maintain, but the repo grows with every platform.
2. **Separate npm packages** (e.g., `@rho/platform-android`, `@rho/platform-macos`) — cleaner separation, users only install what they need, but more repos and publish overhead.
3. **Single repo, install script picks the right pieces** — everything lives in one repo but the installer only copies/links platform-relevant skills and extensions. No extra packages to manage.

Option 3 feels like the sweet spot for v1 — keeps the simplicity of a single repo while not dumping Android skills on a Mac user. What's your take?

**A4:** Option 3. Single repo with a `platforms/` directory structure. Install script detects OS and only symlinks relevant platform skills and extensions. Core extensions (rho.ts, brain.ts, brave-search.ts, etc.) always installed. Platform-specific ones (tasker.ts, termux-* skills) only on the matching platform. No package publishing overhead.

---

### Q5: What's the minimum viable set of platform-specific capabilities for macOS and Linux?

On Android you have 11 termux-* skills plus Tasker. For a macOS or Linux Rho to feel useful beyond just the core heartbeat/memory loop, it probably needs at least a few device capabilities. What would you consider the MVP set?

My suggestion for v1:
- **Notifications** — `osascript` on macOS, `notify-send` on Linux. Essential for a heartbeat agent to surface alerts.
- **Clipboard** — `pbcopy`/`pbpaste` on macOS, `xclip` on Linux. Cheap to add, useful.
- **TTS** — `say` on macOS, `espeak` on Linux. Nice-to-have for voice announcements.

Everything else (location, UI automation, camera/mic) feels like v2. Does that match your priorities, or would you add/cut anything?

**A5:** Notifications and clipboard are must-haves. TTS deprioritized below a generic "open URL/app" skill that works cross-platform (`open` on macOS, `xdg-open` on Linux). That's how the agent launches things, opens docs, etc. V1 priority order: notifications, clipboard, open-url/app. TTS can come with the v1 platform pack but isn't blocking.

---

### Q6: How should the install experience work?

Today there's `bootstrap.sh` (Termux-specific, uses `pkg`) and `install.sh` (already has some OS detection). For the cross-platform story, what should the user experience look like?

My read: one entry point — a single `install.sh` that detects the OS and does the right thing. On macOS it checks for Homebrew and node/npm, on Linux it checks for the distro's package manager, on Termux it uses `pkg`. Same script, branching logic.

Concrete question: should `install.sh` install system dependencies (node, tmux, git) or just check for them and bail with instructions if they're missing? Installing system packages for the user is convenient but opinionated (e.g., auto-installing Homebrew on a Mac might annoy people). Checking and failing fast is safer and more predictable.

**A6:** Check and bail on macOS/Linux — don't auto-install system packages. People are opinionated about their package managers. Check for node, tmux, git, npm; if any missing, print exactly what's needed and how to install for their platform, then exit. On Termux, stay aggressive since `pkg` is the only option and the bootstrap.sh one-liner is the selling point. Termux bootstrap stays hands-on; desktop install.sh is check-and-bail with clear instructions.

---

### Q7: How should the repo directory structure change?

Currently skills and extensions live at the top level of the repo. With the `platforms/` approach, I'm thinking something like:

```
rho/
├── extensions/          ← core (always installed)
│   ├── rho.ts
│   ├── brain.ts
│   ├── brave-search.ts
│   └── ...
├── skills/              ← core (always installed)
│   ├── code-assist/
│   ├── pdd/
│   └── ...
├── platforms/
│   ├── android/
│   │   ├── extensions/  ← tasker.ts
│   │   ├── skills/      ← termux-*, tasker-xml
│   │   └── bootstrap.sh
│   ├── macos/
│   │   ├── skills/      ← macos-notification, macos-clipboard, etc.
│   │   └── setup.sh     ← platform-specific post-install
│   └── linux/
│       ├── skills/      ← linux-notification, linux-clipboard, etc.
│       └── setup.sh
├── templates/           ← AGENTS.md, SOUL.md, etc.
├── scripts/             ← rho-daemon, rho-status, etc.
├── install.sh           ← main entry point, OS-aware
└── ...
```

Does this layout match your mental model, or would you structure it differently?

**A7:** Close, but keep templates (AGENTS.md.template, etc.) at repo root — no `templates/` subdirectory. `brain/` directory with default JSONL files stays at top level too. The main change is: add `platforms/` directory, move termux/tasker stuff into `platforms/android/`, keep everything else where it is. Minimal disruption to existing structure. Revised layout:

```
rho/
├── extensions/          ← core (always installed)
├── skills/              ← core (always installed)
├── brain/               ← default JSONL files
├── scripts/             ← rho-daemon, rho-status, etc.
├── platforms/
│   ├── android/
│   │   ├── extensions/  ← tasker.ts
│   │   ├── skills/      ← termux-*, tasker-xml
│   │   └── bootstrap.sh
│   ├── macos/
│   │   ├── skills/
│   │   └── setup.sh
│   └── linux/
│       ├── skills/
│       └── setup.sh
├── AGENTS.md.template
├── SOUL.md.template
├── install.sh
└── ...
```

---

### Q8: Should platform skills follow a naming convention, or should they be named generically with platform-specific implementations?

Two approaches:

1. **Platform-prefixed names**: `macos-notification`, `linux-notification`, `termux-notification` — each is a distinct skill. The install script symlinks only the ones for your platform. The agent sees platform-specific skill names.
2. **Generic names with platform dispatch**: a single `notification` skill that internally detects the OS and calls the right command. The agent always sees `notification` regardless of platform.

Option 1 is simpler — skills are just markdown instruction files, no runtime dispatch logic needed. The agent doesn't need to know or care about the platform; it just sees what's available. Option 2 is more elegant from the agent's perspective but means each skill needs conditional logic.

Which direction?

**A8:** Option 1 with a twist: use generic names but platform-specific implementations. `platforms/android/skills/notification/` and `platforms/macos/skills/notification/` both exist. Install script symlinks the right one into `~/.pi/agent/skills/notification/`. Agent just sees "notification" regardless of platform. Skill markdown is different per platform (different commands) but skill name and interface are the same. No runtime dispatch, clean agent experience.

---

### Q9: What about the scripts (rho-daemon, rho-status, rho-stop, rho-trigger) — do they need platform adaptation?

Currently these are symlinked from `$PREFIX/bin` on Termux. On macOS/Linux, `$PREFIX` doesn't exist in the same way. A few questions bundled here:

- Should the scripts be installed to `~/.local/bin` (common convention on desktop Linux/macOS) or somewhere else?
- Do any of the scripts themselves have Termux-specific behavior, or are they already just bash/tmux commands that would work anywhere?

**A9:** Scripts are basically tmux wrappers — should work anywhere with minor path changes. Install to `~/.local/bin` on macOS/Linux (ensure PATH includes it). On Termux, keep `$PREFIX/bin`. Install script handles symlink target based on platform. Scripts reference the rho project dir via an env var or config file (`~/.config/rho/config` or similar).

---

### Q10: What about extensions — does the tasker.ts extension need a cross-platform equivalent, or is it Android-only with no desktop counterpart?

The Tasker extension provides UI automation (click, type, read screen, scroll) via Android's accessibility services. On desktop:
- macOS has AppleScript/Hammerspoon/Shortcuts
- Linux has xdotool/ydotool

But these are fundamentally different paradigms. Is a cross-platform "UI automation" extension something you want for v1, or is that firmly v2+ and the Tasker extension just doesn't exist on desktop platforms?

**A10:** Firmly v2+. UI automation is deeply platform-specific, paradigms too different to abstract cleanly. For v1, tasker.ts lives only in `platforms/android/extensions/` and doesn't get installed on desktop. Desktop Rho is powerful through the terminal — bash, commands, APIs. Screen-touching is what makes the phone special, fine as an Android differentiator. No desktop UI automation extension for v1.

---

### Q11: How should the install script handle existing Termux installations during the migration?

This is a real concern — you and any existing Android users already have Rho installed with the current structure. When the repo reorganizes (moving termux skills into `platforms/android/`), the install script needs a migration path. Options:

1. **Clean break** — next `install.sh` run detects old structure, removes old symlinks, re-links from new paths. Existing brain/memory untouched.
2. **Gradual** — support both old and new paths for a transition period.

Option 1 seems right since you're the primary user and the user base is small. The install script just needs to be idempotent — safe to re-run, cleans up old links, creates new ones. Sound right?

**A11:** Clean break. Install script is idempotent — re-run it and it does the right thing. Remove old symlinks, create new ones. Brain and memory are in `~/.pi/brain/` which is completely separate from the repo structure, so untouched. Only things that change are symlinks from `~/.pi/agent/extensions/` and `~/.pi/agent/skills/` pointing to new paths in the repo.

---

### Q12: What does success look like for this project? What's the concrete "done" criteria for v1?

Let me propose acceptance criteria and you can adjust:

1. `git clone` + `./install.sh` works on a fresh macOS, Linux, and Termux machine
2. `rho-daemon` starts a tmux session with a working heartbeat on all three platforms
3. Core extensions (rho.ts, brain.ts, brave-search.ts, memory-viewer, usage-bars) work on all platforms
4. Platform skills (notification, clipboard, open-url) are available and functional on each platform
5. Existing Termux setup migrates cleanly by re-running install.sh
6. Tasker extension + termux-specific skills only appear on Android
7. Optional launchd/systemd service file generation works

Anything to add, change, or cut?

**A12:** Cut #7 (service file generation) — nice-to-have but not v1 core. Revised done criteria:

1. `git clone` + `./install.sh` works on a fresh macOS, Linux, and Termux machine
2. `rho-daemon` starts a tmux session with a working heartbeat on all three platforms
3. Core extensions (rho.ts, brain.ts, brave-search.ts, memory-viewer, usage-bars) work on all platforms
4. Platform skills (notification, clipboard, open-url) are available and functional on each platform
5. Existing Termux setup migrates cleanly by re-running install.sh
6. Tasker extension + termux-specific skills only appear on Android
7. README updated to reflect cross-platform install with platform-specific sections
8. Repo structure change doesn't break any existing tests or CI

---

### Q13: Remaining topics (config, testing, moltbook)

**Q:** Config file format? Testing strategy? moltbook-viewer.ts — core or move?

**A13:** Config file: minimal, `~/.config/rho/config` as a simple shell-sourceable file (`RHO_DIR=~/projects/rho`, `RHO_PLATFORM=android/macos/linux`). Testing: manual on own machines, no automated cross-platform CI for v1. moltbook-viewer.ts: keep in `extensions/` as core — it's personal but not worth separating.
