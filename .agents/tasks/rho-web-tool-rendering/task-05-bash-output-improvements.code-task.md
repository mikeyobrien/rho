# Task: Bash Tool Semantic Expanded View

## Description
Create a semantic expanded view for `bash` tool calls. Show the command prominently with syntax highlighting, add smart output truncation with a "show all (N lines)" toggle, and provide intelligent output previews that detect common patterns (git operations, test results, errors).

## Background
Currently the bash tool expanded view shows:
```
ARGS
{ "command": "cd ~/projects/rho && git add web/public/css/style.css && git commit -m 'fix: bump text size' && git push" }
OUTPUT
No staged .ts/.js files – skipping checks
[ui-improvements 0efc918] ui: bump mobile text size up a notch
 2 files changed, 5 insertions(+), 6 deletions(-)
To https://github.com/mikeyobrien/rho.git
    6557845..0efc918  ui-improvements -> ui-improvements
```

The JSON wrapper around the command is pure noise. And long outputs (e.g., test runs, build output) dump hundreds of lines with no truncation.

## Technical Requirements
1. Add conditional expanded view in the tool_call template for `semantic.tool === 'bash'`
2. Render the **command** in a styled shell prompt block (`$ command`) with bash syntax highlighting
3. Render the **output** with smart truncation:
   - If ≤ 25 lines: show all
   - If > 25 lines: show first 15 + last 10 with a "show N hidden lines" expander in between
4. Add **error detection**: if the tool status is 'error' or output contains common error patterns (stderr markers, "Error:", "FAIL", non-zero exit), apply error styling
5. Detect **common output patterns** for smarter previews:
   - Git: extract commit hash, branch, files changed
   - Test runners: extract pass/fail counts
   - Build output: extract success/failure status
6. Apply basic output syntax highlighting (ANSI-stripped, but color error lines red)
7. Keep raw toggle available
8. Handle multi-line commands (joined with `&&` or `;`) gracefully in the display

## Dependencies
- Task 01 (semantic parser) — `semantic.command`, `semantic.output`, `semantic.lineCount`, `semantic.isError`
- Task 02 (collapsed state) — smart headers already working
- `index.html` tool_call template section
- `style.css`

## Implementation Approach
1. Read current template and identify insertion point
2. Create shell prompt rendering: `<div class="semantic-bash-cmd">$ {command}</div>`
3. Implement output truncation logic:
   - Split output by lines
   - If within threshold, render all
   - Otherwise, render first N + collapse indicator + last M
4. Add "show all" toggle that reveals hidden lines
5. Add error detection patterns and corresponding CSS classes
6. Add pattern detection for collapsed preview (git commits, test results)
7. Add CSS for bash-specific semantic view
8. Test with various bash outputs (short, long, errors, git, tests)

## Acceptance Criteria

1. **Command Rendered as Shell Prompt**
   - Given a bash tool call with command `ls -la /tmp`
   - When the tool block is expanded
   - Then the command is shown as `$ ls -la /tmp` in a styled prompt block, not wrapped in JSON

2. **Short Output Fully Visible**
   - Given a bash tool with 10 lines of output
   - When the tool block is expanded
   - Then all 10 lines are visible without truncation

3. **Long Output Truncated With Expander**
   - Given a bash tool with 150 lines of output
   - When the tool block is expanded
   - Then first ~15 lines + last ~10 lines are shown with a "Show 125 hidden lines" toggle between them

4. **Error Output Styled**
   - Given a bash tool call with status 'error'
   - When the tool block is expanded
   - Then the output has error styling (red border or background tint)

5. **Expand Toggle Works**
   - Given a truncated bash output
   - When the user clicks "Show N hidden lines"
   - Then all output lines become visible

6. **Raw Toggle Available**
   - Given a bash tool with semantic view active
   - When the user clicks "raw" toggle
   - Then the original JSON args + text output view is shown

7. **Multi-line Commands Display Well**
   - Given a bash command like `cd ~/projects/rho && git add . && git commit -m "msg" && git push`
   - When expanded
   - Then the full command is readable (wraps or scrolls horizontally, not cut off)

## Metadata
- **Complexity**: Medium
- **Labels**: rho-web, tool-rendering, bash, output-truncation
- **Required Skills**: JavaScript, CSS, Alpine.js templates, string processing
