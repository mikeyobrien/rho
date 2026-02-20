# Task: Edit/Write Tool Semantic Expanded View

## Description
Create a semantic expanded view for `edit` and `write` tool calls. When expanded, instead of showing raw JSON args and raw text output, render a proper inline diff (oldText→newText) for edit tools and syntax-highlighted content for write tools. The file path appears as a prominent element, and the success output becomes a compact indicator.

## Background
Currently expanding an edit tool shows:
```
ARGS
{ "path": "/home/mobrienv/projects/rho/web/public/index.html",
  "oldText": "<link rel=\"stylesheet\"...",
  "newText": "<link rel=\"stylesheet\"..." }
OUTPUT
Successfully replaced text in /home/mobrienv/projects/rho/web/public/index.html
```

This is hard to read — the escaped JSON obscures the actual change. A proper diff view makes the change immediately scannable.

## Technical Requirements
1. Add a conditional expanded view in the tool_call template that activates when `semantic.tool === 'edit'`
2. Render a **side-by-side or unified diff** showing oldText (red/strikethrough) and newText (green) with line-level granularity
3. For `write` tools, show the written content with syntax highlighting based on file extension
4. Show the file path prominently at the top of the expanded view (not buried in JSON)
5. Replace the verbose "Successfully replaced text in /path" output with a compact success badge
6. Keep raw args/output available via a "raw" toggle for debugging
7. Attempt syntax highlighting of diff content based on file extension (best-effort via hljs)
8. Handle edge cases: very long oldText/newText (truncate with expand), binary content, empty strings

## Dependencies
- Task 01 (semantic parser) — `semantic.path`, `semantic.oldText`, `semantic.newText`, `semantic.content`
- Task 02 (collapsed state) — smart headers already working
- hljs (highlight.js) already loaded globally
- `index.html` tool_call template section
- `style.css`

## Implementation Approach
1. Read current expanded view template in index.html
2. Add conditional template block: `x-if="part.semantic && part.semantic.tool === 'edit'"`
3. Create diff rendering:
   - Split oldText and newText by lines
   - Generate unified diff-style output (context lines, removed lines, added lines)
   - Wrap in styled `<pre>` with diff-specific CSS classes
4. Add write tool view: `x-if="part.semantic && part.semantic.tool === 'write'"`
   - Show content with hljs syntax highlighting
5. Add file path header element
6. Add "show raw" toggle that switches back to the existing JSON view
7. Add CSS for diff rendering (`.semantic-diff`, `.diff-line-add`, `.diff-line-remove`, `.diff-line-context`)
8. Handle truncation for large diffs (>50 lines → show first 20 with "show all" button)

## Acceptance Criteria

1. **Edit Tool Shows Diff**
   - Given an edit tool call with oldText and newText
   - When the tool block is expanded
   - Then a unified diff is shown with red lines for removed text and green lines for added text

2. **Write Tool Shows Content**
   - Given a write tool call with content and path ending in `.ts`
   - When the tool block is expanded
   - Then the content is displayed with TypeScript syntax highlighting

3. **File Path Prominent**
   - Given any edit/write tool call
   - When the tool block is expanded
   - Then the full file path is shown prominently at the top, not in a JSON blob

4. **Success Badge Replaces Verbose Output**
   - Given an edit tool with output "Successfully replaced text in /path"
   - When the tool block is expanded
   - Then a compact green "✓ Applied" badge is shown instead of the full output text

5. **Raw Toggle Available**
   - Given an edit/write tool with semantic view active
   - When the user clicks "raw" toggle
   - Then the view switches to the original raw JSON args + text output display

6. **Large Diff Truncation**
   - Given an edit with oldText/newText that produce >50 diff lines
   - When the tool block is expanded
   - Then only the first 20 lines are shown with a "Show all (N lines)" button

7. **Graceful Fallback**
   - Given an edit tool where semantic parsing failed (semantic is null)
   - When the tool block is expanded
   - Then it renders the existing raw view without errors

## Metadata
- **Complexity**: Medium
- **Labels**: rho-web, tool-rendering, edit, write, diff-view
- **Required Skills**: JavaScript diff generation, CSS, hljs, Alpine.js templates
