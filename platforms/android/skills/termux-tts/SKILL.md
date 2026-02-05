---
name: termux-tts
description: Text-to-speech — make the device speak text aloud. Use for voice announcements, reading content aloud, or accessibility.
---

# Text-to-Speech

## Speak text
```bash
termux-tts-speak "Hello, this is a test"
# or pipe:
echo "Hello world" | termux-tts-speak
```

## Options
```bash
termux-tts-speak -l en-US "Text"     # language
termux-tts-speak -p 1.2 "Text"       # pitch (0.5 - 2.0)
termux-tts-speak -r 0.8 "Text"       # rate (0.5 - 2.0, slower/faster)
termux-tts-speak -s STREAM_ALARM "Text"  # audio stream
```

## List available engines
```bash
termux-tts-engines
```

Command blocks until speech completes.
