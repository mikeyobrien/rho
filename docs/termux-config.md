# Termux Configuration

Rho runs inside Termux on Android. This documents the relevant Termux settings.

## Extra Keys

The extra keys bar is configured in `~/.termux/termux.properties`:

```
extra-keys = [[{key: 'ESC', popup: {macro: "/new ENTER", display: "/new"}},'TAB','CTRL','ALT',{key: '-', popup: '|'},'LEFT','DOWN','UP','RIGHT',{macro: "CTRL b m", display: "🎤"}]]
```

### Key breakdown

| Key | Action | Popup/Notes |
|-----|--------|-------------|
| ESC | Escape | Swipe up: types `/new` + Enter (new pi session) |
| TAB | Tab | |
| CTRL | Ctrl modifier | |
| ALT | Alt modifier | |
| `-` | Hyphen | Swipe up: `\|` (pipe) |
| ←↓↑→ | Arrow keys | |
| 🎤 | `Ctrl+b m` | Triggers tmux mic/speech-to-text binding |

### Mic Button (Speech-to-Text)

The 🎤 key sends `Ctrl+b m`, which is a tmux binding that triggers voice input. This is the primary way to dictate commands and messages to pi hands-free.

#### Flow

1. **Tap 🎤** → sends `Ctrl+b m` to tmux
2. **Haptic vibration** (100ms) confirms the tap registered
3. **Android speech dialog** appears via `termux-dialog speech`
4. Speak your input — the recognizer listens until you stop
5. Recognized text is **typed into the active tmux pane** via `tmux send-keys`
6. **Enter is sent automatically** after the text
7. **Second vibration** (50ms) confirms speech was captured

#### Why `termux-dialog speech` over `termux-speech-to-text`

`termux-speech-to-text` has a known bug ([termux-api #288](https://github.com/termux/termux-api/issues/288)) where the last 1-2 words of speech are cut off. It streams partial results and loses the final recognition. `termux-dialog speech` uses a different code path that returns the complete recognized text as JSON, avoiding the cutoff issue.

#### Scripts

`install.sh` symlinks the STT scripts into `~/bin` (`stt-send` and `stt`) during setup, so the paths below are correct on a standard install. Only change them if you move the scripts.

**`~/.tmux.conf`**:
```bash
# STT: prefix + m (microphone) → speak → text typed + enter
bind-key m run-shell -b "~/bin/stt-send"
```

**`~/bin/stt-send`**:
```bash
#!/data/data/com.termux/files/usr/bin/bash
# Run STT and type result into the active tmux pane, then press Enter
# Uses termux-dialog speech instead of termux-speech-to-text
# to avoid the known last-word cutoff bug (termux-api #288)

# Immediate haptic feedback so user knows the tap registered
termux-vibrate -d 100 -f
sleep 0.1

result=$(termux-dialog speech -t "Speak" 2>/dev/null)
text=$(echo "$result" | jq -r '.text // empty' 2>/dev/null)

if [ -n "$text" ]; then
    termux-vibrate -d 50 -f &
    tmux send-keys -l "$text"
    tmux send-keys Enter
fi
```

**`~/bin/stt`** (standalone, for scripting/clipboard):
```bash
#!/data/data/com.termux/files/usr/bin/bash
# Speech-to-text → clipboard + stdout
result=$(termux-speech-to-text 2>/dev/null)
text=$(echo "$result" | jq -r '.result // empty' 2>/dev/null)

if [ -z "$text" ]; then
    echo "No speech detected" >&2
    exit 1
fi

echo -n "$text" | termux-clipboard-set 2>/dev/null
echo "$text"
```

### Notes

- After editing `termux.properties`, run `termux-reload-settings` to apply.
- The `display` field supports Unicode characters (emojis, symbols).
- Popup keys are triggered by swiping up on a key.
- Macros send key sequences (e.g., `CTRL b m` sends Ctrl+B then M).
- The `-i hint` option on `termux-dialog speech` only sets placeholder UI text — it does not bias the recognizer's vocabulary.

## Other Settings

| Setting | Value | Purpose |
|---------|-------|---------|
| `allow-external-apps` | `true` | Required for Tasker integration |
| `terminal-cursor-blink-rate` | `0` | Reduces flicker |
