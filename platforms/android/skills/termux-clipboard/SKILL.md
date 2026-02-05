---
name: termux-clipboard
description: Read or write the Android clipboard. Use when copying/pasting text, transferring data between apps, or accessing clipboard contents.
---

# Clipboard Operations

## Read clipboard
```bash
termux-clipboard-get
```

## Write to clipboard
```bash
termux-clipboard-set "text to copy"
# or pipe:
echo "text" | termux-clipboard-set
```

Returns the clipboard contents as plain text.
