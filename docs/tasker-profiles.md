# Tasker Profiles Setup

The `tasker.ts` extension communicates with Tasker via broadcast intents. You need to create Tasker profiles that listen for these intents and perform the corresponding actions.

## Required Profiles

Each profile should:
1. **Event:** Intent Received → Action: `rho.tasker.<action>`
2. **Task:** Perform the action and write result to `%result_file`

### rho.tasker.click
Click on UI element by text, ID, or coordinates.

**Intent extras:**
- `target` — Text to click
- `elementId` — Element ID (optional)
- `xcoord`, `ycoord` — Coordinates (optional, used if provided)
- `result_file` — Path to write result

**Task:**
1. AutoInput Action → Click (using coords if provided, else elementId, else target text)
2. Write File → `%result_file` with `{"success":true,"clicked":"%target"}`

### rho.tasker.type
Type text into the currently focused field.

**Intent extras:**
- `text` — Text to type
- `result_file` — Path to write result

**Task:**
1. Keyboard → `write(%text)`
2. Write File → `%result_file` with `{"success":true,"typed":"%text"}`

### rho.tasker.read_screen
Read all visible UI elements.

**Intent extras:**
- `result_file` — Path to write result

**Task:**
1. AutoInput UI Query → Get all visible elements
2. Write File → `%result_file` with format:
   ```
   %app
   ~~~
   %coords (comma-separated x,y pairs)
   ~~~
   %ids (comma-separated)
   ~~~
   %texts (comma-separated)
   ~~~
   %err:%errmsg
   ```

### rho.tasker.scroll
Scroll the screen up or down.

**Intent extras:**
- `direction` — "up" or "down"
- `result_file` — Path to write result

**Task:**
1. If `%direction eq down`: AutoInput Gestures → Swipe from 540,1500 to 540,500
2. If `%direction eq up`: AutoInput Gestures → Swipe from 540,500 to 540,1500
3. Write File → `%result_file` with `{"success":true}`

### rho.tasker.read_screenshot
Take a screenshot and save to specified path.

**Intent extras:**
- `screenshot_file` — Path to save screenshot
- `result_file` — Path to write result

**Task:**
1. Take Screenshot → File: `%screenshot_file`
2. Write File → `%result_file` with `{"success":true,"path":"%screenshot_file"}`

**Note:** Requires screenshot permission. Grant via ADB:
```bash
adb shell appops set net.dinglisch.android.taskerm PROJECT_MEDIA allow
```

### rho.tasker.back
Press the back button.

**Intent extras:**
- `result_file` — Path to write result

**Task:**
1. AutoInput Global Action → Back
2. Write File → `%result_file` with `{"success":true}`

### rho.tasker.home
Go to home screen.

**Intent extras:**
- `result_file` — Path to write result

**Task:**
1. AutoInput Global Action → Home
2. Write File → `%result_file` with `{"success":true}`

### rho.tasker.open_url
Open a URL in the browser.

**Intent extras:**
- `url` — URL to open
- `result_file` — Path to write result

**Task:**
1. Browse URL → `%url`
2. Wait → 1-2 seconds
3. Write File → `%result_file` with `{"success":true}`

## Result File Location

All results are written to `/storage/emulated/0/rho/tasker-result.json` (or the path specified in `%result_file`).

## Tips

- Enable AutoInput Accessibility Service in Android settings
- Grant all permissions AutoInput requests
- Test each profile manually before using with the extension
- Use "Continue Task After Error" and write error info to result file for debugging
