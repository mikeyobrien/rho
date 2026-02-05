---
name: termux-contacts
description: Access phone contacts and call log. Use for looking up contact info or checking recent calls.
---

# Contacts & Calls

## List all contacts
```bash
termux-contact-list
```

Output:
```json
[
  {
    "name": "John Doe",
    "number": "+1234567890"
  }
]
```

## Call log
```bash
termux-call-log                    # recent calls
termux-call-log -l 20              # last 20 calls
termux-call-log -o 10              # offset (skip first 10)
```

Output:
```json
[
  {
    "name": "John Doe",
    "phone_number": "+1234567890",
    "type": "INCOMING",
    "date": "2024-01-15 14:30:00",
    "duration": "120"
  }
]
```

Call types: `INCOMING`, `OUTGOING`, `MISSED`, `REJECTED`

## Make a phone call
```bash
termux-telephony-call "+1234567890"
```
Opens the dialer with the number (user must confirm).

## Phone info
```bash
termux-telephony-deviceinfo        # IMEI, carrier, etc.
termux-telephony-cellinfo          # cell tower info
```

**Note:** Requires contacts/phone permissions.
