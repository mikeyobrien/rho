# Task: Brain/Vault/Email Tool Compact Rendering

## Description
Create semantic expanded views for `brain`, `vault`, `vault_search`, and `email` tool calls. Instead of dumping raw JSON output, render structured, scannable displays — memory entries as compact cards, vault notes with titles and links, email actions with recipient/subject info.

## Background
Currently brain/vault/email tools dump their full JSON responses as raw text. For example, a `brain action=list` call outputs dozens of lines of JSON with every field. A vault search returns raw JSON arrays. These are the agent's most-used operational tools, and they're the least readable in the current UI.

## Technical Requirements
1. Add conditional expanded view for `semantic.tool === 'brain'`
2. Add conditional expanded view for `semantic.tool === 'vault'`
3. Add conditional expanded view for `semantic.tool === 'email'`
4. **Brain tool rendering:**
   - Show action prominently (add, list, update, remove, task_done, reminder_run)
   - For `list` results: parse output as entries, render as compact cards with type badge, text preview, and ID
   - For `add`/`update`: show the entry that was added/modified with its fields
   - For `remove`: show what was removed with the reason
   - For `task_done`: show the completed task
5. **Vault tool rendering:**
   - For `search`/`list`: parse results and show as a list of note titles with type badges and relevance snippets
   - For `read`: show note title and rendered content (markdown)
   - For `write`/`capture`: show what was written/captured
6. **Email tool rendering:**
   - For `send`: show To, Subject, and a preview of the body
   - For `check`/`list`/`read`: show messages in a compact inbox-style layout
7. All views must have a raw toggle for debugging
8. Graceful fallback: if output parsing fails, show raw output (don't crash)

## Dependencies
- Task 01 (semantic parser) — `semantic.action`, `semantic.summary`, etc.
- Task 02 (collapsed state) — smart headers already working
- `index.html` tool_call template section
- `style.css`

## Implementation Approach
1. Read current template and add insertion points for brain/vault/email
2. Create output parsers that attempt to extract structured data from tool output text:
   - Brain list: look for JSON array or line-separated entries
   - Vault search: look for JSON results array
   - Email: look for message objects
3. Render brain entries as compact cards: `[type-badge] text-preview ... (id: abc123)`
4. Render vault results as linked items: `[type] title — snippet`
5. Render email as mini inbox: `From: ... Subject: ... preview`
6. Add CSS for card layouts, type badges, compact lists
7. Add raw toggle for each
8. Wrap all output parsing in try/catch — if it fails, fall back to raw

## Acceptance Criteria

1. **Brain List Renders As Cards**
   - Given a brain `list` call that returns multiple entries
   - When the tool block is expanded
   - Then entries appear as compact cards with type badges (learning, behavior, task, etc.) and truncated text

2. **Brain Add Shows Entry**
   - Given a brain `add` call
   - When the tool block is expanded
   - Then the added entry is shown with its type, text, and assigned ID

3. **Vault Search Renders As List**
   - Given a vault `search` call with results
   - When the tool block is expanded
   - Then results appear as a list with note titles, types, and relevance snippets

4. **Email Send Shows Details**
   - Given an email `send` call
   - When the tool block is expanded
   - Then it shows To, Subject, and a body preview in a mail-like layout

5. **Raw Toggle Available**
   - Given any brain/vault/email tool with semantic view
   - When the user clicks "raw" toggle
   - Then the original raw output is shown

6. **Parse Failure Graceful Fallback**
   - Given a brain tool with unexpected output format
   - When the semantic parser fails to extract structured data
   - Then the raw output is shown without errors or blank screens

7. **Type Badges Styled**
   - Given brain entries with different types (learning, behavior, task, preference)
   - When rendered as cards
   - Then each type has a distinct subtle color badge for quick visual scanning

## Metadata
- **Complexity**: Medium
- **Labels**: rho-web, tool-rendering, brain, vault, email, compact-view
- **Required Skills**: JavaScript, JSON parsing, CSS card layouts, Alpine.js templates
