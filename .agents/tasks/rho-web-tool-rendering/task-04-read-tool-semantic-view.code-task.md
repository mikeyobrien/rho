# Task: Read Tool Semantic Expanded View

## Description
Create a semantic expanded view for the `read` tool. When expanded, show the file path prominently with line range info, and syntax-highlight the output content based on file extension. Replace the generic "ARGS / OUTPUT" labels with a file-viewer style layout.

## Background
Currently expanding a read tool shows:
```
ARGS
{ "path": "/home/mobrienv/projects/rho/web/public/css/style.css", "offset": 1, "limit": 50 }
OUTPUT
.chat-block.tool {
    border-color: rgba(251, 191, 36, 0.4);
}
...
```

The args JSON is noise — the user just wants to see the file content. The output is already the file content but lacks syntax highlighting, making it harder to scan than it needs to be.

## Technical Requirements
1. Add a conditional expanded view in the tool_call template for `semantic.tool === 'read'`
2. Show a **file header bar** with: filename, full path (tooltip), line range (e.g., "lines 1-50"), total line indicator if truncated
3. **Syntax highlight** the output content using hljs with the language detected from file extension
4. Map common extensions to hljs language names (`.ts`→typescript, `.js`→javascript, `.css`→css, `.html`→html, `.md`→markdown, `.json`→json, `.py`→python, `.sh`→bash, `.yml`/`.yaml`→yaml, `.toml`→toml, `.rs`→rust, `.go`→go)
5. Show **line numbers** in the gutter (starting from offset if provided)
6. Handle image outputs gracefully (read tool can return image attachments — skip syntax highlighting)
7. Keep raw toggle available for debugging
8. Truncate very long file content (>100 lines visible, "show all" toggle for the rest)

## Dependencies
- Task 01 (semantic parser) — `semantic.path`, `semantic.offset`, `semantic.limit`, `semantic.fileExtension`, `semantic.content`
- Task 02 (collapsed state) — smart headers already working
- hljs loaded globally in index.html
- `index.html` tool_call template section
- `style.css`

## Implementation Approach
1. Read current template and identify insertion point for read tool view
2. Create file extension → hljs language mapping function
3. Add template block with file header bar
4. Render output content through hljs with detected language
5. Add line number gutter using CSS counters or JS-generated spans
6. Add CSS for file viewer layout (`.semantic-file-header`, `.semantic-file-content`, `.line-numbers`)
7. Add truncation logic: if content >100 lines, show first 60 with "show all" toggle
8. Wire up raw toggle

## Acceptance Criteria

1. **Read Tool Shows Highlighted Content**
   - Given a read tool call for a `.ts` file
   - When the tool block is expanded
   - Then the content is displayed with TypeScript syntax highlighting via hljs

2. **File Header Shows Path and Range**
   - Given a read tool with path `/home/user/foo/bar.css` and offset=10, limit=20
   - When the tool block is expanded
   - Then a header shows `bar.css` (full path on hover) and `lines 10-29`

3. **Line Numbers Displayed**
   - Given a read tool output with multiple lines
   - When the tool block is expanded
   - Then line numbers appear in a gutter, starting from the offset value (or 1 if no offset)

4. **Extension Detection Works**
   - Given read tool calls for .js, .py, .md, .json, .yaml, .html files
   - When each is expanded
   - Then each gets appropriate syntax highlighting (not all rendered as plain text)

5. **Long Content Truncated**
   - Given a read tool output with 200 lines
   - When the tool block is expanded
   - Then first ~60 lines are shown with a "Show all (200 lines)" toggle

6. **Raw Toggle Available**
   - Given a read tool with semantic view active
   - When the user clicks "raw" toggle
   - Then the original raw JSON args + text output view is shown

7. **Graceful Fallback for Unknown Extensions**
   - Given a read tool for a file with no extension or unknown extension
   - When the tool block is expanded
   - Then content is shown as plain text without highlighting errors

## Metadata
- **Complexity**: Medium
- **Labels**: rho-web, tool-rendering, read, syntax-highlighting, file-viewer
- **Required Skills**: JavaScript, hljs API, CSS line numbers, Alpine.js templates
