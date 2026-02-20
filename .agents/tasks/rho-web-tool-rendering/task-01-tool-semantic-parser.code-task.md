# Task: Tool Semantic Parser Infrastructure

## Description
Add a tool-aware argument/output parser to rho-web's chat.js that extracts structured display data from native pi tool calls. This replaces the generic "dump raw JSON" approach with tool-specific parsed data that downstream renderers can use.

## Background
rho-web currently renders all tool calls identically: raw JSON args in a `<pre>` block and raw text output in another `<pre>` block. Native pi tools (edit, read, write, bash, brain, vault, email) have well-known argument schemas and output formats. By parsing these into structured data, we can render them semantically instead of as JSON blobs.

The existing code in chat.js already has `isFileEditTool()` and `parseToolOutput()` — this task generalizes that pattern into a registry-based system.

## Technical Requirements
1. Create a `TOOL_REGISTRY` object in chat.js mapping tool names to parser functions
2. Each parser receives `(args, output)` where args is the raw JSON string and output is the raw output string
3. Each parser returns a structured object with tool-specific fields (see schema below)
4. Add a `parseToolSemantic(name, argsString, outputString)` function that looks up the registry and returns parsed data (or null for unknown tools)
5. Integrate into `normalizeMessage()` so each tool_call part gets a `semantic` property alongside existing `args`/`output`
6. The existing `isFileEditTool()`/`parseToolOutput()` functions can be removed or refactored into the new registry
7. Must not break any existing rendering — the `semantic` field is additive

## Parser Schemas Per Tool

### edit
```js
{ tool: 'edit', path: string, hasOldNew: boolean, oldText: string, newText: string, success: boolean }
```

### write
```js
{ tool: 'write', path: string, content: string, success: boolean }
```

### read
```js
{ tool: 'read', path: string, offset: number|null, limit: number|null, fileExtension: string, content: string }
```

### bash
```js
{ tool: 'bash', command: string, timeout: number|null, output: string, lineCount: number, isError: boolean }
```

### brain
```js
{ tool: 'brain', action: string, type: string|null, id: string|null, summary: string }
```

### vault / vault_search
```js
{ tool: 'vault', action: string, slug: string|null, query: string|null, summary: string }
```

### email
```js
{ tool: 'email', action: string, to: string|null, subject: string|null, summary: string }
```

## Dependencies
- `chat.js` in `/home/mobrienv/projects/rho/web/public/js/chat.js`
- Must work with the existing Alpine.js data flow — `normalizeMessage()` → `renderedMessages` → template

## Implementation Approach
1. Read chat.js to understand the current normalizeMessage/normalizeToolCall pipeline
2. Define the TOOL_REGISTRY object with parser functions for each native tool
3. Create parseToolSemantic() dispatcher function
4. Add a `semanticSummary(name, semantic)` function that generates a clean one-line summary string per tool type (used for collapsed headers)
5. Wire into normalizeToolCall() or the tool_call branch of normalizeMessage() to attach `semantic` and `semanticSummary` to each part
6. Remove or integrate the old `isFileEditTool()`/`parseToolOutput()` functions
7. Verify existing rendering still works (semantic is additive, templates haven't changed yet)

## Acceptance Criteria

1. **Registry Exists**
   - Given chat.js is loaded
   - When inspecting TOOL_REGISTRY
   - Then it contains parser entries for: edit, write, read, bash, brain, vault, vault_search, email

2. **Edit Tool Parsing**
   - Given an edit tool call with args `{"path":"/foo/bar.ts","oldText":"a","newText":"b"}`
   - When parseToolSemantic('edit', argsJson, 'Successfully replaced...') is called
   - Then it returns `{ tool: 'edit', path: '/foo/bar.ts', hasOldNew: true, oldText: 'a', newText: 'b', success: true }`

3. **Bash Tool Parsing**
   - Given a bash tool call with args `{"command":"ls -la"}`
   - When parseToolSemantic('bash', argsJson, 'file1\nfile2\n') is called
   - Then it returns `{ tool: 'bash', command: 'ls -la', output: 'file1\nfile2\n', lineCount: 2, isError: false }`

4. **Unknown Tool Returns Null**
   - Given an unknown tool name like 'custom_tool'
   - When parseToolSemantic('custom_tool', ...) is called
   - Then it returns null (fallback to generic rendering)

5. **Integration With normalizeMessage**
   - Given a message with tool_call parts
   - When normalizeMessage() processes it
   - Then each tool_call part has `semantic` (object or null) and `semanticSummary` (string) properties

6. **No Rendering Breakage**
   - Given the existing index.html templates are unchanged
   - When viewing a session with tool calls
   - Then all tool calls render exactly as before (semantic data is unused by templates in this task)

## Metadata
- **Complexity**: Medium
- **Labels**: rho-web, tool-rendering, infrastructure, parser
- **Required Skills**: JavaScript, JSON parsing, Alpine.js data flow
