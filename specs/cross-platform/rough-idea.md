# Cross-Platform Rho

## Rough Idea

Rho is currently Android/Termux-only. The core value — a persistent AI agent with heartbeat, memory, and autonomous check-ins — is platform-agnostic. But the install path, device skills, and Tasker integration are all Termux-specific.

**Goal:** Restructure Rho so the core framework runs on any platform (macOS, Linux, Android/Termux), with platform-specific capability layers as optional plugins.

## Current State Analysis

### Already portable (no changes needed):
- `rho.ts` — heartbeat/check-in system (timers + file I/O)
- `brain.ts` — JSONL memory system (pure Node.js)
- `brave-search.ts` — web search
- `memory-viewer.ts`, `moltbook-viewer.ts`, `usage-bars.ts` — TUI extensions
- Skills: `code-assist`, `pdd`, `rho-validate`, `update-pi`
- All templates: AGENTS.md, RHO.md, SOUL.md, HEARTBEAT.md
- `install.sh` already does OS detection for AGENTS.md templating

### Android-specific (needs abstraction or separation):
- `tasker.ts` extension — Tasker + AutoInput UI automation
- 11 skills: `termux-clipboard`, `termux-contacts`, `termux-device`, `termux-dialog`, `termux-location`, `termux-media`, `termux-notification`, `termux-sms`, `termux-stt`, `termux-tts`, `tasker-xml`
- `bootstrap.sh` — uses `pkg` package manager
- Scripts assume Termux paths

### Equivalent capabilities on other platforms:
- **Notifications**: `notify-send` (Linux), `osascript` (macOS)
- **Clipboard**: `xclip`/`xsel` (Linux), `pbcopy`/`pbpaste` (macOS)
- **TTS**: `espeak` (Linux), `say` (macOS)
- **Location**: CoreLocation (macOS), GeoClue (Linux)
- **UI automation**: AppleScript/Hammerspoon (macOS), xdotool (Linux)

## Constraints
- Rho repo should stay generic as a framework (existing preference)
- Must not break existing Android/Termux users
- pi-coding-agent is the underlying runtime and already works cross-platform
- Skills are just markdown files with instructions — portable by nature
- Extensions are TypeScript loaded by pi — also portable

## Open Questions
- Should platform packs be separate repos/packages or subdirectories?
- What's the minimum viable cross-platform story? (just core? core + notifications?)
- Should the install script be one smart script or per-platform scripts?
- How do we handle the Tasker extension which is deeply Android-specific?
- Is there a daemon/service story for macOS (launchd) and Linux (systemd)?
