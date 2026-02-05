---
name: termux-stt
description: Speech-to-text — transcribe voice to text using device microphone. Use for voice commands, dictation, or hands-free input.
---

# Speech-to-Text

## Basic usage
```bash
termux-speech-to-text
```

Opens a speech recognition dialog. Returns transcribed text as JSON when user stops speaking.

## Output format
```json
{"result": "the spoken text here"}
```

## Notes
- Requires microphone permission
- Uses Google speech recognition (needs network)
- User must tap the mic or speak; dialog auto-closes on silence
- Returns empty result if canceled or no speech detected
