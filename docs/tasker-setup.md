# Tasker Setup for Rho

This guide sets up Tasker to receive commands from Termux and perform UI automation.

## Requirements

1. **Tasker** - [Play Store](https://play.google.com/store/apps/details?id=net.dinglisch.android.taskerm)
2. **AutoInput** - Tasker plugin for UI interaction
3. **Termux:Tasker** - Optional, for Tasker → Termux calls

## How It Works

```
Termux (rho)                    Tasker
     │                             │
     │  am broadcast ──────────►   │ Profile: Intent Received
     │  rho.tasker.click           │ Action: rho.tasker.click
     │  -e target "Sign In"        │
     │                             ▼
     │                        AutoInput: Click
     │                        target = %target
     │                             │
     │                             ▼
     │  ◄────────────────────  Write File
     │  ~/.rho/tasker-result.json  │
     │  {"success": true}          │
     ▼                             │
  Read result                      │
```

## Tasker Configuration

### Step 1: Create Result Writer Task

**Task: RhoWriteResult**

```
A1: Variable Set
    Name: %result_file
    To: %par1
    
A2: Variable Set
    Name: %success
    To: %par2
    
A3: Variable Set
    Name: %data
    To: %par3
    
A4: Write File
    File: %result_file
    Text: {"success": %success, "data": %data}
    Append: Off
```

### Step 2: Create Action Tasks

#### Task: RhoOpenUrl

```
A1: Browse URL
    URL: %url
    
A2: Wait
    Seconds: 2
    
A3: Perform Task
    Name: RhoWriteResult
    Parameter 1: %result_file
    Parameter 2: true
    Parameter 3: {"action": "open_url", "url": "%url"}
```

#### Task: RhoClick

```
A1: AutoInput Action
    Type: Text
    Value: %target
    Action: Click
    
A2: If %err Set
      A3: Perform Task
          Name: RhoWriteResult
          Parameter 1: %result_file
          Parameter 2: false
          Parameter 3: {"error": "Element not found: %target"}
    Else
      A4: Perform Task
          Name: RhoWriteResult
          Parameter 1: %result_file
          Parameter 2: true
          Parameter 3: {"clicked": "%target"}
    End If
```

#### Task: RhoType

```
A1: AutoInput Action
    Type: Text
    Value: %target
    Action: Click
    (Skip if %target not set)
    
A2: AutoInput Action
    Type: Key
    Value: %text
    Action: Write
    
A3: Perform Task
    Name: RhoWriteResult
    Parameter 1: %result_file
    Parameter 2: true
    Parameter 3: {"typed": "%text"}
```

#### Task: RhoScreenshot

```
A1: Take Screenshot
    File: %output
    
A2: Perform Task
    Name: RhoWriteResult
    Parameter 1: %result_file
    Parameter 2: true
    Parameter 3: {"path": "%output"}
```

#### Task: RhoReadScreen

```
A1: AutoInput UI Query
    Variables: %texts, %ids
    
A2: Variable Join
    Name: %texts
    Joiner: |||
    
A3: Perform Task
    Name: RhoWriteResult
    Parameter 1: %result_file
    Parameter 2: true
    Parameter 3: {"texts": "%texts"}
```

#### Task: RhoBack

```
A1: Back Button

A2: Perform Task
    Name: RhoWriteResult
    Parameter 1: %result_file
    Parameter 2: true
    Parameter 3: {}
```

#### Task: RhoHome

```
A1: Home Button

A2: Perform Task
    Name: RhoWriteResult
    Parameter 1: %result_file
    Parameter 2: true
    Parameter 3: {}
```

### Step 3: Create Intent Profiles

Create a profile for each action:

**Profile: Rho Open URL**
- Event: Intent Received
- Action: `rho.tasker.open_url`
- Task: RhoOpenUrl
- Pass variables: `%url`, `%result_file`

**Profile: Rho Click**
- Event: Intent Received  
- Action: `rho.tasker.click`
- Task: RhoClick
- Pass variables: `%target`, `%result_file`

**Profile: Rho Type**
- Event: Intent Received
- Action: `rho.tasker.type`
- Task: RhoType
- Pass variables: `%text`, `%target`, `%result_file`

**Profile: Rho Screenshot**
- Event: Intent Received
- Action: `rho.tasker.screenshot`
- Task: RhoScreenshot
- Pass variables: `%output`, `%result_file`

**Profile: Rho Read Screen**
- Event: Intent Received
- Action: `rho.tasker.read_screen`
- Task: RhoReadScreen
- Pass variables: `%result_file`

**Profile: Rho Back**
- Event: Intent Received
- Action: `rho.tasker.back`
- Task: RhoBack
- Pass variables: `%result_file`

**Profile: Rho Home**
- Event: Intent Received
- Action: `rho.tasker.home`
- Task: RhoHome
- Pass variables: `%result_file`

## Testing

From Termux:

```bash
# Test open URL
am broadcast --user 0 -a rho.tasker.open_url \
  -e url "https://example.com" \
  -e result_file "/data/data/com.termux/files/home/.rho/tasker-result.json"

# Check result
cat ~/.rho/tasker-result.json

# Or use the rho command
/tasker open_url https://example.com
```

## Troubleshooting

1. **Intent not received**: Check Tasker is running, battery optimization disabled
2. **AutoInput not working**: Enable Accessibility Service for AutoInput
3. **Permission denied on result file**: Tasker needs storage permission for Termux home
4. **Timeout**: Increase timeout or check Tasker logs

## Alternative: Shared Storage

If Tasker can't write to Termux home, use shared storage:

```
Result file: /storage/emulated/0/rho/tasker-result.json
```

Update `RESULT_FILE` in `tasker.ts` accordingly.
