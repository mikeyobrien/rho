---
name: tasker-xml
description: Create Tasker profiles and tasks via XML for Android automation. Use when adding new Tasker functionality, creating Intent Received handlers, or building automation that integrates with the rho.tasker extension.
---

# Tasker XML Creation

Create importable Tasker profiles and tasks via XML files.

## Output Location

Write XML files to `/storage/emulated/0/Download/` for easy import:
```
/storage/emulated/0/Download/MyProfile.prf.xml
```

## File Suffixes

- `.prf.xml` - Profile with linked task(s)
- `.tsk.xml` - Standalone task
- `.prj.xml` - Full project

## Import Instructions

1. Open Tasker app
2. For profiles: Long press PROFILES tab → Import Profile
3. For tasks: Long press TASKS tab → Import Task
4. Navigate to Download folder, select the XML file

## XML Structure

### Basic Profile with Task

```xml
<?xml version="1.0" encoding="UTF-8"?>
<TaskerData sr="" dvi="1" tv="6.3.13">
    <Profile sr="prof1" ve="2">
        <cdate>1706900000000</cdate>
        <edate>1706900000000</edate>
        <id>1</id>
        <mid0>1</mid0>
        <nme>Profile Name</nme>
        <!-- Event/State goes here -->
    </Profile>
    <Task sr="task1">
        <cdate>1706900000000</cdate>
        <edate>1706900000000</edate>
        <id>1</id>
        <nme>Task Name</nme>
        <pri>6</pri>
        <!-- Actions go here -->
    </Task>
</TaskerData>
```

**Important:** Profile `<mid0>` must match Task `<id>`.

## Event Codes (for Profile triggers)

Use inside `<Profile>` with `<Event sr="con0" ve="2">`:

| Code | Event |
|------|-------|
| 599 | Intent Received |
| 461 | Notification |
| 463 | New Window |
| 2078 | App Changed |
| 3050 | Variable Set |

### Intent Received Event (code 599)

```xml
<Event sr="con0" ve="2">
    <code>599</code>
    <Str sr="arg0" ve="3">rho.tasker.my_action</Str>
    <Int sr="arg1" val="0"/>
    <Int sr="arg2" val="0"/>
    <Str sr="arg3" ve="3"/>
    <Str sr="arg4" ve="3"/>
</Event>
```

- `arg0`: Intent action name (e.g., `rho.tasker.open_app`)
- `arg1`: Priority (0 = normal)
- `arg2`: Stop event (0 = no)
- `arg3`: Cat (category filter, usually empty)
- `arg4`: Data filter (usually empty)

## Action Codes (for Task steps)

Use inside `<Task>` with `<Action sr="actN" ve="7">`:

### Common Actions

| Code | Action | Key Args |
|------|--------|----------|
| 20 | Launch App | arg0=app name |
| 25 | Go Home | (none) |
| 30 | Wait | arg0=hours, arg1=mins, arg2=ms, arg3=secs |
| 37 | If | arg0=condition |
| 38 | End If | (none) |
| 43 | Else | (none) |
| 104 | Browse URL | arg0=url |
| 123 | Run Shell | arg0=command, arg1=use root, arg2=timeout |
| 126 | Return | (stops task) |
| 130 | Perform Task | arg0=task name |
| 137 | Stop | (stops task) |
| 410 | Write File | arg0=path, arg1=content |
| 547 | Variable Set | arg0=name, arg1=value |
| 548 | Variable Clear | arg0=name |
| 549 | Variable Add | arg0=name, arg1=value |
| 550 | Variable Subtract | arg0=name, arg1=value |
| 559 | Flash | arg0=text |

### AutoInput Actions (code -1)

AutoInput uses plugin action code `-1` with Bundle configuration.

#### UI Query (Read Screen)
```xml
<Action sr="act0" ve="7">
    <code>-1</code>
    <Bundle sr="arg0">
        <Vals sr="val">
            <com.twofortyfouram.locale.intent.extra.BLURB>Check Screen
Configuration: Check Screen</com.twofortyfouram.locale.intent.extra.BLURB>
            <com.twofortyfouram.locale.intent.extra.BLURB-type>java.lang.String</com.twofortyfouram.locale.intent.extra.BLURB-type>
            <net.dinglisch.android.tasker.subbundled>true</net.dinglisch.android.tasker.subbundled>
            <net.dinglisch.android.tasker.subbundled-type>java.lang.Boolean</net.dinglisch.android.tasker.subbundled-type>
        </Vals>
    </Bundle>
    <Str sr="arg1" ve="3">com.joaomgcd.autoinput</Str>
    <Str sr="arg2" ve="3">com.joaomgcd.autoinput.activity.ActivityConfigUIQuery</Str>
    <Int sr="arg3" val="600"/>
</Action>
```

After this action, these variables are available:
- `%aitext()` - Array of visible text
- `%aiid()` - Array of element IDs
- `%aicoords()` - Array of x,y coordinates
- `%aiapp` - Current app package

#### Click by Text
```xml
<Action sr="act0" ve="7">
    <code>-1</code>
    <Bundle sr="arg0">
        <Vals sr="val">
            <com.twofortyfouram.locale.intent.extra.BLURB>Action: Click [ Type:Text Value:%target ]</com.twofortyfouram.locale.intent.extra.BLURB>
            <com.twofortyfouram.locale.intent.extra.BLURB-type>java.lang.String</com.twofortyfouram.locale.intent.extra.BLURB-type>
            <action_type>click</action_type>
            <action_type-type>java.lang.String</action_type-type>
            <value>%target</value>
            <value-type>java.lang.String</value-type>
            <type>text</type>
            <type-type>java.lang.String</type-type>
            <net.dinglisch.android.tasker.subbundled>true</net.dinglisch.android.tasker.subbundled>
            <net.dinglisch.android.tasker.subbundled-type>java.lang.Boolean</net.dinglisch.android.tasker.subbundled-type>
        </Vals>
    </Bundle>
    <Str sr="arg1" ve="3">com.joaomgcd.autoinput</Str>
    <Str sr="arg2" ve="3">com.joaomgcd.autoinput.activity.ActivityConfigAction</Str>
    <Int sr="arg3" val="600"/>
</Action>
```

#### Click by Coordinates
```xml
<Action sr="act0" ve="7">
    <code>-1</code>
    <Bundle sr="arg0">
        <Vals sr="val">
            <com.twofortyfouram.locale.intent.extra.BLURB>Action: Click [ Type:Point Value:%xcoord,%ycoord ]</com.twofortyfouram.locale.intent.extra.BLURB>
            <com.twofortyfouram.locale.intent.extra.BLURB-type>java.lang.String</com.twofortyfouram.locale.intent.extra.BLURB-type>
            <action_type>click</action_type>
            <action_type-type>java.lang.String</action_type-type>
            <value>%xcoord,%ycoord</value>
            <value-type>java.lang.String</value-type>
            <type>point</type>
            <type-type>java.lang.String</type-type>
            <net.dinglisch.android.tasker.subbundled>true</net.dinglisch.android.tasker.subbundled>
            <net.dinglisch.android.tasker.subbundled-type>java.lang.Boolean</net.dinglisch.android.tasker.subbundled-type>
        </Vals>
    </Bundle>
    <Str sr="arg1" ve="3">com.joaomgcd.autoinput</Str>
    <Str sr="arg2" ve="3">com.joaomgcd.autoinput.activity.ActivityConfigAction</Str>
    <Int sr="arg3" val="600"/>
</Action>
```

## Action Examples

### Variable Set (code 547)
```xml
<Action sr="act0" ve="7">
    <code>547</code>
    <Str sr="arg0" ve="3">%my_var</Str>
    <Str sr="arg1" ve="3">my value</Str>
    <Int sr="arg2" val="0"/>
    <Int sr="arg3" val="0"/>
    <Int sr="arg4" val="0"/>
    <Int sr="arg5" val="3"/>
    <Int sr="arg6" val="0"/>
</Action>
```

### Launch App (code 20)
```xml
<Action sr="act0" ve="7">
    <code>20</code>
    <Str sr="arg0" ve="3">Telegram</Str>
    <Str sr="arg1" ve="3"/>
    <Int sr="arg2" val="0"/>
    <Int sr="arg3" val="0"/>
    <Int sr="arg4" val="0"/>
</Action>
```

### Wait (code 30)
```xml
<Action sr="act0" ve="7">
    <code>30</code>
    <Int sr="arg0" val="0"/>
    <Int sr="arg1" val="0"/>
    <Int sr="arg2" val="500"/>
    <Int sr="arg3" val="0"/>
    <Int sr="arg4" val="0"/>
</Action>
```
- arg0=hours, arg1=minutes, arg2=milliseconds, arg3=seconds

### Write File (code 410)
```xml
<Action sr="act0" ve="7">
    <code>410</code>
    <Str sr="arg0" ve="3">/storage/emulated/0/rho/result.txt</Str>
    <Str sr="arg1" ve="3">Content to write
Can be multiline
Variables work: %myvar</Str>
    <Int sr="arg2" val="0"/>
    <Int sr="arg3" val="0"/>
    <Int sr="arg4" val="0"/>
</Action>
```

### Flash (code 559)
```xml
<Action sr="act0" ve="7">
    <code>559</code>
    <Str sr="arg0" ve="3">Toast message here</Str>
    <Int sr="arg1" val="0"/>
</Action>
```

### Go Home (code 25)
```xml
<Action sr="act0" ve="7">
    <code>25</code>
    <Int sr="arg0" val="0"/>
    <Int sr="arg1" val="0"/>
</Action>
```

### Run Shell (code 123)
```xml
<Action sr="act0" ve="7">
    <code>123</code>
    <Str sr="arg0" ve="3">echo "Hello"</Str>
    <Int sr="arg1" val="0"/>
    <Int sr="arg2" val="10"/>
    <Str sr="arg3" ve="3">%output</Str>
    <Str sr="arg4" ve="3">%err_output</Str>
    <Str sr="arg5" ve="3"/>
</Action>
```

### If/Else/End If (codes 37, 43, 38)
```xml
<!-- If %direction equals "down" -->
<Action sr="act0" ve="7">
    <code>37</code>
    <Str sr="arg0" ve="3">%direction</Str>
    <Int sr="arg1" val="0"/>
    <Str sr="arg2" ve="3">down</Str>
    <Int sr="arg3" val="0"/>
</Action>
<!-- Actions for down -->
<Action sr="act1" ve="7">
    <code>43</code>
</Action>
<!-- Else actions -->
<Action sr="act2" ve="7">
    <code>38</code>
</Action>
```

## Rho Integration Pattern

For rho.tasker.* handlers, use this standard pattern:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<TaskerData sr="" dvi="1" tv="6.3.13">
    <Profile sr="prof1" ve="2">
        <cdate>1706900000000</cdate>
        <edate>1706900000000</edate>
        <id>1</id>
        <mid0>1</mid0>
        <nme>Rho Action Name</nme>
        <Event sr="con0" ve="2">
            <code>599</code>
            <Str sr="arg0" ve="3">rho.tasker.action_name</Str>
            <Int sr="arg1" val="0"/>
            <Int sr="arg2" val="0"/>
            <Str sr="arg3" ve="3"/>
            <Str sr="arg4" ve="3"/>
        </Event>
    </Profile>
    <Task sr="task1">
        <cdate>1706900000000</cdate>
        <edate>1706900000000</edate>
        <id>1</id>
        <nme>Rho Action Handler</nme>
        <pri>6</pri>
        
        <!-- A1: Get result_file from intent -->
        <Action sr="act0" ve="7">
            <code>547</code>
            <Str sr="arg0" ve="3">%result_file</Str>
            <Str sr="arg1" ve="3">%result_file</Str>
            <Int sr="arg2" val="0"/>
            <Int sr="arg3" val="0"/>
            <Int sr="arg4" val="0"/>
            <Int sr="arg5" val="3"/>
            <Int sr="arg6" val="0"/>
        </Action>
        
        <!-- A2: Do the actual work here -->
        
        <!-- A3: AutoInput UI Query to get screen state -->
        <Action sr="act1" ve="7">
            <code>-1</code>
            <Bundle sr="arg0">
                <Vals sr="val">
                    <com.twofortyfouram.locale.intent.extra.BLURB>Check Screen
Configuration: Check Screen</com.twofortyfouram.locale.intent.extra.BLURB>
                    <com.twofortyfouram.locale.intent.extra.BLURB-type>java.lang.String</com.twofortyfouram.locale.intent.extra.BLURB-type>
                    <net.dinglisch.android.tasker.subbundled>true</net.dinglisch.android.tasker.subbundled>
                    <net.dinglisch.android.tasker.subbundled-type>java.lang.Boolean</net.dinglisch.android.tasker.subbundled-type>
                </Vals>
            </Bundle>
            <Str sr="arg1" ve="3">com.joaomgcd.autoinput</Str>
            <Str sr="arg2" ve="3">com.joaomgcd.autoinput.activity.ActivityConfigUIQuery</Str>
            <Int sr="arg3" val="600"/>
        </Action>
        
        <!-- A4: Write result file in standard format -->
        <Action sr="act2" ve="7">
            <code>410</code>
            <Str sr="arg0" ve="3">%result_file</Str>
            <Str sr="arg1" ve="3">%aiapp
~~~
%aicoords()
~~~
%aiid()
~~~
%aitext()
~~~
%err</Str>
            <Int sr="arg2" val="0"/>
            <Int sr="arg3" val="0"/>
            <Int sr="arg4" val="0"/>
        </Action>
    </Task>
</TaskerData>
```

## Result File Format

The rho.tasker extension expects results in this format:
```
app_name
~~~
x1,y1,x2,y2,...
~~~
id1,id2,...
~~~
text1|||text2|||...
~~~
error_message_or_empty
```

Use `%aiapp`, `%aicoords()`, `%aiid()`, `%aitext()` from AutoInput.

## Tips

1. **Action numbering**: Actions use `sr="act0"`, `sr="act1"`, etc. Sequential.

2. **Profile/Task IDs**: Use unique IDs (100+) to avoid conflicts with existing Tasker config.

3. **Intent extras**: Variables from intent extras are automatically available with same name (e.g., `%app_name` from intent extra `app_name`).

4. **Test incrementally**: Start with a Flash action to verify the profile triggers, then add complexity.

5. **Debugging**: Add Flash actions to show variable values during development.
