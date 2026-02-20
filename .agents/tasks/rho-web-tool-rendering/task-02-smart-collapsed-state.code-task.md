# Task: Smart Collapsed State for Tool Calls

## Description
Replace the generic `argsSummary` (truncated JSON) and `outputPreview` (one-line output) in collapsed tool headers with tool-specific, human-readable summaries. Use the `semantic` data from the tool parser (task-01) to render meaningful collapsed views — file path badges, commands, action summaries.

## Background
Currently when a tool call is collapsed, the header shows something like:
`✓ edit  { "path": "/home/mobrienv/projects/rho/web/public/index.html", "oldTe...`

This is noisy and wastes precious mobile screen space. With the semantic parser from task-01, we can show:
`✓ edit  index.html` with the output preview `Successfully replaced text`

Each tool type should have its own collapsed representation optimized for scannability.

## Technical Requirements
1. Modify the tool_call template in index.html to use `semantic` data when available
2. Show a **file path badge** for file-oriented tools (edit, write, read) — just the filename, not the full path, with full path in a tooltip
3. Show the **command** for bash tools (truncated, monospace)
4. Show **action + type** for brain tools (e.g., "add learning")
5. Show **action** for vault tools (e.g., "search: query...")
6. Show **action** for email tools (e.g., "send → user@example.com")
7. Fall back to existing `argsSummary` for unknown tools
8. Replace the generic `outputPreview` with `semanticSummary` when available
9. Add CSS for path badges, command previews, and action labels

## Dependencies
- Task 01 (tool-semantic-parser) must be completed — `semantic` and `semanticSummary` fields on tool_call parts
- `index.html` tool_call template section (~line 292)
- `style.css` tool block styles (~line 1026)

## Implementation Approach
1. Read current index.html tool_call template and style.css tool styles
2. Modify the collapsed header (`chat-block-toggle` button) to conditionally render semantic data
3. Add `.tool-path-badge` — styled inline element showing filename with full path as title attribute
4. Add `.tool-command-preview` — monospace truncated command text
5. Add `.tool-action-label` — compact label for brain/vault/email actions
6. Update `.tool-preview` (the collapsed output preview line) to prefer `semanticSummary` over `outputPreview`
7. Ensure the chevron and duration still render correctly
8. Test with various tool types to verify readability

## Collapsed Header Designs

### edit / write
```
✓ edit  [index.html]                               1.2s ▸
  Successfully replaced text in index.html
```

### read
```
✓ read  [style.css:1-50]                           0.3s ▸
  (50 lines)
```

### bash
```
✓ bash  git add && git commit -m "fix"             2.1s ▸
  2 files changed, 5 insertions(+)
```

### brain
```
✓ brain  add learning                               0.1s ▸
  Added entry abc123
```

### vault
```
✓ vault  search: "tool rendering"                   0.2s ▸
  3 results
```

### Unknown tool (fallback)
```
✓ custom_tool  { "arg1": "value"...                 0.5s ▸
  Some output preview...
```

## Acceptance Criteria

1. **Edit Tool Collapsed Header**
   - Given an edit tool call with semantic data containing path `/home/user/projects/foo/bar.ts`
   - When the tool block is collapsed
   - Then the header shows `✓ edit [bar.ts]` with full path as tooltip, not raw JSON

2. **Bash Tool Collapsed Header**
   - Given a bash tool call with semantic command `cd ~/projects && git status`
   - When the tool block is collapsed
   - Then the header shows the command in monospace, truncated if too long

3. **Brain Tool Collapsed Header**
   - Given a brain tool call with semantic action `add` and type `learning`
   - When the tool block is collapsed
   - Then the header shows `✓ brain add learning`

4. **Fallback For Unknown Tools**
   - Given a tool call where `semantic` is null
   - When the tool block is collapsed
   - Then it renders exactly as before (argsSummary + outputPreview)

5. **Output Preview Uses Semantic Summary**
   - Given a tool call with `semanticSummary` set
   - When the tool block is collapsed and has output
   - Then the preview line shows `semanticSummary` instead of generic `outputPreview`

6. **Path Badge Styling**
   - Given a file-oriented tool with a path badge
   - When rendered
   - Then the badge has subtle background, rounded corners, monospace font, and the full path appears on hover/long-press

7. **Mobile Readability**
   - Given a mobile viewport (< 600px)
   - When viewing collapsed tool headers
   - Then text does not overflow, badges truncate gracefully, and the layout remains single-line

## Metadata
- **Complexity**: Medium
- **Labels**: rho-web, tool-rendering, UI, collapsed-state
- **Required Skills**: HTML templates, CSS, Alpine.js conditionals
