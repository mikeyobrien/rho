---
name: termux-sms
description: Read and send SMS messages. Use for checking texts, 2FA codes, or sending SMS alerts.
---

# SMS Operations

## Read recent messages
```bash
termux-sms-list                        # last 10 messages
termux-sms-list -l 5                   # last 5 messages
termux-sms-list -t inbox               # inbox only
termux-sms-list -t sent                # sent only
```

## Filter by sender
```bash
termux-sms-list -f "+1234567890" -l 5  # from specific number
```

## Get conversations list
```bash
termux-sms-list --conversation-list
```

## Send SMS
```bash
termux-sms-send -n "+1234567890" "Message text"
```

## Output format (list)
```json
[
  {
    "threadid": 1,
    "type": "inbox",
    "read": true,
    "number": "+1234567890",
    "received": "2024-01-15 10:30:00",
    "body": "Message content here"
  }
]
```

## Message types
- `all` (default), `inbox`, `sent`, `draft`, `outbox`, `failed`, `queued`

**Note:** Requires SMS permissions in Termux:API app settings.
