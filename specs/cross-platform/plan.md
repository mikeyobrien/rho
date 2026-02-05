# Cross-Platform Rho — Implementation Plan

## Checklist

- [ ] Step 1: Create platforms/ directory structure and move Android files
- [ ] Step 2: Rename Android skills to generic names
- [ ] Step 3: Write macOS platform skills
- [ ] Step 4: Write Linux platform skills
- [ ] Step 5: Create Android open-url skill
- [ ] Step 6: Rewrite install.sh with OS-aware logic
- [ ] Step 7: Add config file support to scripts
- [ ] Step 8: Write platform setup.sh scripts
- [ ] Step 9: Update README.md
- [ ] Step 10: End-to-end testing and migration verification

---

## Step 1: Create platforms/ directory structure and move Android files

**Objective:** Establish the `platforms/` directory and relocate all Android-specific code from the repo root into `platforms/android/`.

**Implementation guidance:**
- Create `platforms/android/{extensions,skills,scripts/bin}/`
- Create `platforms/macos/skills/`, `platforms/linux/skills/`
- `git mv extensions/tasker.ts platforms/android/extensions/tasker.ts`
- `git mv skills/tasker-xml platforms/android/skills/tasker-xml`
- `git mv skills/termux-clipboard platforms/android/skills/termux-clipboard` (rename happens in Step 2)
- Repeat for all 11 termux-* skills
- `git mv scripts/bin/stt platforms/android/scripts/bin/stt`
- `git mv scripts/bin/stt-send platforms/android/scripts/bin/stt-send`
- Remove empty `scripts/bin/` if nothing else is in it
- `git mv bootstrap.sh platforms/android/bootstrap.sh`

**Test requirements:**
- Verify all files are in their new locations
- Verify `git status` shows renames, not delete+add
- Verify no broken references within moved files (grep for old paths)

**Integration notes:**
- Do NOT run install.sh yet — it still has the old logic. Symlinks will be stale until Step 6.
- Existing install is temporarily broken after this step — that's expected.

**Demo:** `find platforms/ -type f` shows the full Android tree. Core `extensions/` and `skills/` only contain platform-agnostic files.

---

## Step 2: Rename Android skills to generic names

**Objective:** Drop the `termux-` prefix from Android skill directories so they match the generic naming convention.

**Implementation guidance:**
- Within `platforms/android/skills/`:
  - `git mv termux-clipboard clipboard`
  - `git mv termux-contacts contacts`
  - `git mv termux-device device`
  - `git mv termux-dialog dialog`
  - `git mv termux-location location`
  - `git mv termux-media media`
  - `git mv termux-notification notification`
  - `git mv termux-sms sms`
  - `git mv termux-stt stt`
  - `git mv termux-tts tts`
- Update the `name:` field in each SKILL.md frontmatter to the generic name (e.g., `name: notification` instead of `name: termux-notification`)
- Update the `description:` field to remove Termux-specific language where appropriate — the skill content stays Termux-specific (it's the Android implementation), but the name/description should be generic

**Test requirements:**
- Verify each SKILL.md has updated frontmatter
- Verify no duplicate skill names between core `skills/` and `platforms/android/skills/`

**Integration notes:**
- `tasker-xml` keeps its name — it's Android-only with no cross-platform equivalent, so no generic name needed.

**Demo:** `ls platforms/android/skills/` shows clean generic names: `clipboard/`, `contacts/`, `notification/`, etc.

---

## Step 3: Write macOS platform skills

**Objective:** Create the four macOS platform skills: notification, clipboard, open-url, tts.

**Implementation guidance:**

Each skill is a `SKILL.md` with YAML frontmatter following the existing skill format.

`platforms/macos/skills/notification/SKILL.md`:
- Name: `notification`
- Description: Show macOS system notifications
- Commands: `osascript -e 'display notification "body" with title "title"'`
- Cover: title, body, sound (`with sound name "default"`)
- Note: for richer notifications, suggest `terminal-notifier` as optional dep

`platforms/macos/skills/clipboard/SKILL.md`:
- Name: `clipboard`
- Description: Read and write the macOS clipboard
- Commands: `pbpaste` (read), `echo "text" | pbcopy` (write), `pbcopy < file`

`platforms/macos/skills/open-url/SKILL.md`:
- Name: `open-url`
- Description: Open URLs and launch apps on macOS
- Commands: `open <url>`, `open -a "App Name"`, `open /path/to/file`

`platforms/macos/skills/tts/SKILL.md`:
- Name: `tts`
- Description: Text-to-speech on macOS
- Commands: `say "text"`, `say -v voice "text"`, `say -o output.aiff "text"`
- Note: list voices with `say -v '?'`

**Test requirements:**
- Each SKILL.md has valid YAML frontmatter with `name` and `description`
- Commands are correct and tested on macOS
- Skill format matches existing skill conventions (see `skills/code-assist/SKILL.md` for reference)

**Integration notes:**
- These don't need to work on the current Termux machine — they'll be tested on macOS in Step 10.

**Demo:** `find platforms/macos -name SKILL.md` shows all four skills.

---

## Step 4: Write Linux platform skills

**Objective:** Create the four Linux platform skills: notification, clipboard, open-url, tts.

**Implementation guidance:**

`platforms/linux/skills/notification/SKILL.md`:
- Name: `notification`
- Description: Show Linux desktop notifications
- Commands: `notify-send "title" "body"`, with urgency and icon options
- Note: requires `libnotify` / `notify-send` package

`platforms/linux/skills/clipboard/SKILL.md`:
- Name: `clipboard`
- Description: Read and write the Linux clipboard
- Commands: `xclip -selection clipboard -o` (read), `echo "text" | xclip -selection clipboard` (write)
- Alternative: `xsel --clipboard --output` / `xsel --clipboard --input`
- Note: on Wayland, use `wl-copy` / `wl-paste` instead

`platforms/linux/skills/open-url/SKILL.md`:
- Name: `open-url`
- Description: Open URLs and files on Linux
- Commands: `xdg-open <url>`, `xdg-open <file>`
- Note: respects default application settings

`platforms/linux/skills/tts/SKILL.md`:
- Name: `tts`
- Description: Text-to-speech on Linux
- Commands: `espeak "text"`, `espeak -v voice "text"`, pipe support
- Alternative: `spd-say "text"` (speech-dispatcher)

**Test requirements:**
- Each SKILL.md has valid YAML frontmatter
- Commands cover common distros (Debian/Ubuntu, Arch, Fedora)
- Wayland alternatives noted where relevant

**Integration notes:**
- Same as macOS — tested on Linux in Step 10.

**Demo:** `find platforms/linux -name SKILL.md` shows all four skills.

---

## Step 5: Create Android open-url skill

**Objective:** Create the missing `open-url` skill for Android that handles both URLs and app launching.

**Implementation guidance:**

`platforms/android/skills/open-url/SKILL.md`:
- Name: `open-url`
- Description: Open URLs and launch apps on Android
- URL commands: `termux-open-url <url>`, `am start -a android.intent.action.VIEW -d <url>`
- App launch commands: `am start -n <package/activity>`, `monkey -p <package> -c android.intent.category.LAUNCHER 1`
- Common examples: opening browser, launching specific apps
- Note: `termux-open-url` is simpler for URLs, `am start` gives more control

**Test requirements:**
- Skill covers both URL opening and app launching
- Examples include common use cases
- Commands verified on Termux

**Integration notes:**
- This is new functionality — Android didn't have a dedicated open-url skill before (it was done ad-hoc via Tasker or `am start`).

**Demo:** Agent can open a URL or launch an app by name using the `open-url` skill on Android.

---

## Step 6: Rewrite install.sh with OS-aware logic

**Objective:** Replace the current install.sh with a cross-platform version that detects the OS, checks dependencies, and symlinks the correct core + platform files.

**Implementation guidance:**

Structure the script in functions:
```
detect_platform()     → sets PLATFORM (android|macos|linux)
check_dependencies()  → verifies node, npm, tmux, git; exits with instructions if missing
cleanup_old()         → removes old symlinks in ~/.pi/agent/
install_extensions()  → symlinks core + platform extensions as individual files
install_skills()      → symlinks core + platform skills as individual dirs
install_scripts()     → symlinks rho-* to BIN_DIR, platform scripts if applicable
write_config()        → writes ~/.config/rho/config
bootstrap_templates() → copies *.template files if targets don't exist
bootstrap_brain()     → copies brain/*.jsonl.default if targets don't exist
run_platform_setup()  → runs platforms/$PLATFORM/setup.sh if it exists
```

Key behaviors:
- `detect_platform()`: Check `$TERMUX_VERSION` first (Android), then `uname -s` (Darwin=macOS, Linux=linux)
- `check_dependencies()`: On Android, skip or auto-install. On macOS, suggest `brew install ...`. On Linux, suggest `apt install ...` / `pacman -S ...` / `dnf install ...` based on available package manager.
- `cleanup_old()`: `rm -f ~/.pi/agent/extensions/*.ts`, `rm -rf ~/.pi/agent/skills/*/` — wipe and recreate for idempotency
- `install_extensions()`: Loop over `extensions/*.ts` and `platforms/$PLATFORM/extensions/*.ts`, create individual symlinks
- `install_skills()`: Loop over `skills/*/` and `platforms/$PLATFORM/skills/*/`, symlink each dir
- `install_scripts()`: BIN_DIR is `$PREFIX/bin` if `$PREFIX` set, else `~/.local/bin`. Warn if `~/.local/bin` not in PATH.
- Platform-specific: on Android, also install `platforms/android/scripts/bin/stt*` to `~/bin/`

**Test requirements:**
- Run on Termux: all core + Android extensions/skills symlinked, no macOS/Linux skills present
- Idempotent: running twice produces the same result
- Old symlinks cleaned up before new ones created
- Config file written with correct values
- Missing deps produce clear error messages with install instructions

**Integration notes:**
- This is the critical step — after this, the install actually works on all platforms.
- The old install.sh should be committed as a rename/delete so git tracks the history.

**Demo:** Run `./install.sh` on Termux, verify `ls -la ~/.pi/agent/extensions/` shows core + tasker.ts, `ls -la ~/.pi/agent/skills/` shows core + Android skills with generic names.

---

## Step 7: Add config file support to scripts

**Objective:** Update all rho scripts to source `~/.config/rho/config` for portability.

**Implementation guidance:**

Add to the top of each script (`rho`, `rho-daemon`, `rho-status`, `rho-stop`, `rho-trigger`):
```bash
# Source rho config
if [ -f "$HOME/.config/rho/config" ]; then
  . "$HOME/.config/rho/config"
fi
RHO_DIR="${RHO_DIR:-$HOME/projects/rho}"
```

Replace any hardcoded paths with `$RHO_DIR` references. Review each script for Termux-specific assumptions (e.g., `$PREFIX` paths, Termux-specific commands) and make them conditional.

**Test requirements:**
- Scripts work when config file exists
- Scripts fall back to defaults when config file is missing
- `rho-daemon` starts a tmux session correctly using `$RHO_DIR`
- No Termux-specific commands on non-Termux platforms

**Integration notes:**
- After this step, `rho-daemon` should work on any platform where the install has been run.

**Demo:** On Termux, `rho-daemon` starts normally. Config file at `~/.config/rho/config` shows correct values.

---

## Step 8: Write platform setup.sh scripts

**Objective:** Create optional post-install scripts for macOS and Linux that check for platform-specific tool availability.

**Implementation guidance:**

`platforms/macos/setup.sh`:
```bash
#!/bin/bash
echo "Checking macOS platform dependencies..."
# These are optional — skills degrade gracefully if missing
command -v osascript &>/dev/null && echo "✓ osascript (notifications)" || echo "• osascript not found (unexpected on macOS)"
command -v pbcopy &>/dev/null && echo "✓ pbcopy/pbpaste (clipboard)" || echo "• pbcopy not found (unexpected on macOS)"
command -v say &>/dev/null && echo "✓ say (text-to-speech)" || echo "• say not found (unexpected on macOS)"
echo ""
echo "All core macOS tools are built-in. No additional installs needed."
```

`platforms/linux/setup.sh`:
```bash
#!/bin/bash
echo "Checking Linux platform dependencies..."
MISSING=0
command -v notify-send &>/dev/null && echo "✓ notify-send (notifications)" || { echo "⚠ notify-send not found. Install: sudo apt install libnotify-bin"; MISSING=1; }
command -v xclip &>/dev/null && echo "✓ xclip (clipboard)" || { echo "⚠ xclip not found. Install: sudo apt install xclip"; MISSING=1; }
command -v xdg-open &>/dev/null && echo "✓ xdg-open (open URLs/files)" || { echo "⚠ xdg-open not found. Install: sudo apt install xdg-utils"; MISSING=1; }
if [ $MISSING -eq 1 ]; then
  echo ""
  echo "Some optional tools are missing. Platform skills will note alternatives."
fi
```

**Test requirements:**
- Scripts are executable and run without errors
- Correct tools checked for each platform
- Missing tools produce actionable install instructions

**Integration notes:**
- These are informational only — they don't block install. The install.sh calls them at the end as a courtesy.

**Demo:** Running `./install.sh` on Linux prints a summary of available/missing platform tools.

---

## Step 9: Update README.md

**Objective:** Rewrite the README to reflect cross-platform support with platform-specific sections.

**Implementation guidance:**

Revised README structure:
1. **Header/tagline** — update to mention macOS, Linux, Android
2. **Quick Start** — three paths:
   - **macOS/Linux:** `git clone ... && cd rho && ./install.sh`
   - **Android/Termux:** `curl ... | bash` (bootstrap one-liner)
3. **What You Get** — core features (heartbeat, memory, check-ins) that work everywhere
4. **Platform Capabilities** — table showing which skills are available per platform
5. **Running Rho** — `rho-daemon` (same on all platforms)
6. **Customizing** — SOUL.md, HEARTBEAT.md, RHO.md templates
7. **Extensions** — table of core + platform extensions
8. **Skills** — table of core + platform skills
9. **Project Structure** — updated directory layout showing `platforms/`
10. **Contributing** — how to add a new platform

**Test requirements:**
- All commands in README are correct and copy-pasteable
- Platform table accurately reflects what's available
- No broken links
- Termux bootstrap one-liner still works (update path to `platforms/android/bootstrap.sh` if URL changes)

**Integration notes:**
- The bootstrap.sh one-liner URL may need updating if the file moved. If using raw GitHub URLs, the path changes from `bootstrap.sh` to `platforms/android/bootstrap.sh`.

**Demo:** README reads clearly for a new user on any platform.

---

## Step 10: End-to-end testing and migration verification

**Objective:** Verify the full install-to-running-heartbeat flow on all three platforms, plus migration on the existing Termux setup.

**Implementation guidance:**

**Termux migration test:**
1. Pull latest repo (with all changes from Steps 1-9)
2. Run `./install.sh`
3. Verify old symlinks replaced with new ones: `ls -la ~/.pi/agent/extensions/`, `ls -la ~/.pi/agent/skills/`
4. Verify core extensions present: brain.ts, brave-search.ts, rho.ts, memory-viewer.ts, usage-bars.ts, moltbook-viewer.ts
5. Verify Android extensions present: tasker.ts
6. Verify Android skills have generic names: `notification/`, `clipboard/`, not `termux-notification/`
7. Verify core skills present: `code-assist/`, `pdd/`, etc.
8. Verify `~/.config/rho/config` has `RHO_PLATFORM=android`
9. Verify brain untouched: `ls ~/.pi/brain/`
10. Start `rho-daemon`, verify heartbeat fires

**macOS fresh install test:**
1. Clone repo on Mac
2. Run `./install.sh`
3. Verify dep check passes (or fails gracefully if something missing)
4. Verify only core + macOS skills/extensions installed
5. Verify no tasker.ts, no Android skills
6. Verify `~/.config/rho/config` has `RHO_PLATFORM=macos`
7. Start `rho-daemon`, verify heartbeat fires
8. Test notification skill, clipboard skill, open-url skill

**Linux fresh install test:**
1. Clone repo on Linux machine
2. Run `./install.sh`
3. Same verifications as macOS but for Linux skills
4. Verify setup.sh reports on tool availability
5. Start `rho-daemon`, verify heartbeat fires

**Test requirements:**
- All acceptance criteria from design.md pass
- No regressions on existing Termux functionality
- Scripts work from `~/.local/bin` on desktop

**Integration notes:**
- This is the final verification step. Any issues found loop back to the relevant step.

**Demo:** Working Rho heartbeat on all three platforms. Agent sees platform-appropriate skills.
