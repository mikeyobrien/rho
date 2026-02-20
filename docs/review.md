# Review Extension

A lightweight code review tool for pi — leave line-level comments on any file, like a personal PR review.

Supports:
- `/review` command
- `review` tool (always deferred, non-blocking)
- `review_inbox` tool (list/get/claim/resolve deferred submissions)

## Quick Start

```bash
/review src/server.ts
/review --tui src/server.ts
/review *.ts
/review src/
```

Agent tool examples:

```ts
review({ files: ["src/server.ts"], message: "Check error handling" })
review_inbox({ action: "list" })
review_inbox({ action: "get", id: "<review-id>" })
review_inbox({ action: "claim", id: "<review-id>", actor: "tidepool" })
review_inbox({ action: "resolve", id: "<review-id>", actor: "tidepool" })
```

## Deferred Workflow (default for `review` tool)

1. Agent calls `review(...)`.
2. Review session URL is created and returned immediately.
3. User submits comments later from browser review UI.
4. Any future chat can retrieve with `review_inbox list/get`.
5. Agent can claim/resolve via `review_inbox`.

Review submissions are persisted in:

- `~/.rho/review/reviews.jsonl`

## Modes

### Browser

Uses rho-web review UI (`/review/:id`) with token-gated access.

Features:
- Syntax highlighting via highlight.js
- Click line numbers to comment
- Shift+click range selection
- Edit/delete comments inline
- Submit/cancel via WebSocket

### TUI (`--tui`)

Terminal-native interactive mode.

| Key | Action |
|---|---|
| `j` / `k` / `↑` / `↓` | Scroll |
| `g` / `G` | Top / bottom |
| `Ctrl+d` / `Ctrl+u` | Page down / up |
| `Enter` | Comment current line |
| `v` | Start range selection |
| `Tab` / `Shift+Tab` | Next / previous file |
| `f` | File picker |
| `c` | Comment list (edit/delete) |
| `S` | Submit |
| `Esc` | Cancel |
| `?` | Help |

## File Resolution

Accepted inputs:

| Input | Behavior |
|---|---|
| `path/to/file.ts` | single file |
| `*.ts` | glob |
| `src/` | one-level directory scan |
| multiple args | mixed |

Auto-skipped:
- binary files
- files over 500KB
- missing paths

Warnings are shown in the review UI.

## Tool APIs

### `review`

```ts
{
  files: string[];
  message?: string;
}
```

Behavior:
- always deferred
- returns `review_id` + `url` immediately
- does not block waiting for submit

### `review_inbox`

```ts
{
  action: "list" | "get" | "claim" | "resolve";
  id?: string;
  status?: "inbox" | "submitted" | "claimed" | "resolved" | "cancelled" | "open" | "all";
  claimedBy?: string;
  actor?: string;
  limit?: number;
}
```

- `list`: list persisted submissions
- `get`: fetch comments for one review id
- `claim`: claim review ownership
- `resolve`: mark review resolved

## Architecture

```txt
extensions/review/
├── index.ts          # tools + /review command
├── files.ts          # file resolution
├── format.ts         # markdown formatter
├── server.ts         # rho-web integration + standalone fallback
├── tui.ts            # terminal UI mode
└── web/*             # browser UI assets

web/
├── server.ts         # review API/session routes
└── review-store.ts   # durable review store (jsonl snapshots)
```
