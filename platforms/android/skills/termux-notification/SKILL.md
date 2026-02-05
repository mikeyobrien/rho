---
name: termux-notification
description: Show Android system notifications with optional buttons, sounds, and actions. Use for alerts, reminders, or persistent status messages.
---

# System Notifications

## Basic notification
```bash
termux-notification -t "Title" -c "Content message"
```

## With ID (for updating/removing)
```bash
termux-notification --id mynotif -t "Title" -c "Message"
termux-notification-remove mynotif
```

## Options
- `-t/--title` — notification title
- `-c/--content` — body text
- `--id` — unique ID (update existing, or remove later)
- `--sound` — play notification sound
- `--vibrate 500,200,500` — vibration pattern (ms)
- `--priority high|low|max|min` — importance level
- `--ongoing` — pin notification (can't swipe away)
- `--led-color RRGGBB` — LED color
- `--icon icon-name` — Material icon (see material.io/icons)
- `--image-path /path/to/image` — show image

## With action buttons
```bash
termux-notification -t "Alert" -c "Something happened" \
  --button1 "Open" --button1-action "termux-open-url https://example.com" \
  --button2 "Dismiss" --button2-action "termux-notification-remove mynotif" \
  --id mynotif
```

## List active notifications
```bash
termux-notification-list
```
