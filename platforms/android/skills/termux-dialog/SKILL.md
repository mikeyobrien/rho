---
name: termux-dialog
description: Show interactive dialogs for user input — text, confirmations, choices, date/time pickers. Use when you need user input beyond chat.
---

# Interactive Dialogs

## Text input
```bash
termux-dialog text -t "Title" -i "Hint text"
termux-dialog text -m                    # multiline
termux-dialog text -p                    # password (hidden)
termux-dialog text -n                    # numbers only
```

## Confirmation (yes/no)
```bash
termux-dialog confirm -t "Are you sure?"
```

## Radio buttons (pick one)
```bash
termux-dialog radio -t "Choose one" -v "Option A,Option B,Option C"
```

## Checkboxes (pick multiple)
```bash
termux-dialog checkbox -t "Select all that apply" -v "Item 1,Item 2,Item 3"
```

## Spinner dropdown
```bash
termux-dialog spinner -t "Select" -v "Apple,Banana,Cherry"
```

## Bottom sheet
```bash
termux-dialog sheet -t "Pick" -v "Action 1,Action 2,Action 3"
```

## Counter (number picker)
```bash
termux-dialog counter -t "Pick a number" -r "0,100,50"  # min,max,start
```

## Date picker
```bash
termux-dialog date -t "Select date"
termux-dialog date -d "yyyy-MM-dd"       # custom format
```

## Time picker
```bash
termux-dialog time -t "Select time"
```

## Speech input
```bash
termux-dialog speech -t "Speak now"
```

## Output format
```json
{
  "code": 0,
  "text": "user input here"
}
```
- `code: 0` = OK, `code: -1` = canceled
- For checkbox: `"values"` array instead of `"text"`
