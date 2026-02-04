# Termux Configuration

Rho runs inside Termux on Android. This documents the relevant Termux settings.

## Extra Keys

The extra keys bar is configured in `~/.termux/termux.properties`:

```
extra-keys = [[{key: 'ESC', popup: {macro: "/new ENTER", display: "/new"}},'TAB','CTRL','ALT',{key: '-', popup: '|'},'LEFT','RIGHT','DOWN','UP',{macro: "CTRL b m", display: "🎤"}]]
```

### Key breakdown

| Key | Action | Popup/Notes |
|-----|--------|-------------|
| ESC | Escape | Swipe up: types `/new` + Enter (new pi session) |
| TAB | Tab | |
| CTRL | Ctrl modifier | |
| ALT | Alt modifier | |
| `-` | Hyphen | Swipe up: `\|` (pipe) |
| ←→↓↑ | Arrow keys | |
| 🎤 | `Ctrl+b m` | Triggers tmux mic/speech-to-text binding |

### Mic Button (Speech-to-Text)

The 🎤 key sends `Ctrl+b m`, which is a tmux binding that triggers voice input:

1. **Tap 🎤** → sends `Ctrl+b m` to tmux
2. **tmux** runs `~/bin/stt-send` in the background
3. **stt-send** calls `termux-speech-to-text` (Android speech recognizer)
4. Android shows a listening dialog — speak your input
5. Recognized text is **typed into the active tmux pane** via `tmux send-keys`
6. **Enter is sent automatically** after the text

This means you can tap 🎤, speak a command or message, and it gets typed and submitted to whatever's running in the current pane (pi, bash, etc.).

#### Scripts

**`~/.tmux.conf`**:
```bash
bind-key m run-shell -b "~/bin/stt-send"
```

**`~/bin/stt-send`**:
```bash
#!/data/data/com.termux/files/usr/bin/bash
text=$(termux-speech-to-text 2>/dev/null)
if [ -n "$text" ]; then
    tmux send-keys -l "$text"
    tmux send-keys Enter
fi
```

There's also a standalone `~/bin/stt` script that copies recognized text to the clipboard and outputs to stdout. This is the primary way the user dictates commands and messages to pi hands-free.

### Notes

- After editing `termux.properties`, run `termux-reload-settings` to apply.
- The `display` field supports Unicode characters (emojis, symbols).
- Popup keys are triggered by swiping up on a key.
- Macros send key sequences (e.g., `CTRL b m` sends Ctrl+B then M).

## Other Settings

| Setting | Value | Purpose |
|---------|-------|---------|
| `allow-external-apps` | `true` | Required for Tasker integration |
| `terminal-cursor-blink-rate` | `0` | Reduces flicker |
