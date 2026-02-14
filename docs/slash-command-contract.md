# Slash command RPC contract (Web Chat + Telegram)

This document defines the channel-agnostic slash-command behavior for rho adapters that execute through `pi --mode rpc`.

## Scope

Applies to:
- Web Chat (`web/public/js/chat.js` + `web/public/js/slash-contract.js`)
- Telegram worker (`extensions/telegram/rpc.ts` + `extensions/telegram/worker-runtime.ts`)

## Decision model

1. Parse inbound text as slash/non-slash (including Telegram `/<command>@<bot>` forms; `@<bot>` is stripped for classification/execution).
2. If slash, classify using RPC `get_commands` inventory and interactive-only built-ins list.
3. Route supported slash commands through RPC `prompt`.
4. Reject unsupported/interactive-only slash commands with actionable user guidance.

## Classification table

| Input | Inventory contains command | Interactive-only built-in | Classification | Action |
|---|---:|---:|---|---|
| `hello` | n/a | n/a | `not_slash` | normal prompt flow |
| `/telegram status` | yes | no | `supported` | execute via `prompt` |
| `/settings` | no | yes | `interactive_only` | reject before execution |
| `/nope` | no | no | `unsupported` | reject before execution |
| `/` | n/a | n/a | `invalid` | reject with syntax guidance |

## RPC constraints that drive behavior

From pi RPC semantics:
- `get_commands` is the discoverable slash inventory for RPC channels.
- Built-in TUI commands (`/settings`, `/hotkeys`, etc.) are **not** returned by `get_commands` and do not execute over RPC.
- Slash commands execute through `prompt` (not `steer`/`follow_up` for extension commands).
- During streaming, non-extension slash commands may require `streamingBehavior: "steer"`; extension slash commands execute immediately via `prompt`.

## Completion semantics

`prompt` response contract is authoritative:
- `response { command: "prompt", success: true }` = prompt accepted.
- `response { command: "prompt", success: false }` = prompt failed with error text.

Telegram normalizes slash success as:
- assistant text when present, otherwise deterministic fallback: `✅ /command executed.`

Web Chat and Telegram both treat `prompt` failures using the same category mapping.

## Standardized user-facing error categories

- **unsupported**: `Unsupported slash command /name. Choose a command returned by get_commands.`
- **interactive_only**: `Unsupported slash command /name. This command only runs in the interactive TUI.`
- **busy**: `Slash command /name could not run because the session is busy. Retry in a moment.`
- **timeout**: `Slash command /name timed out. Retry in a moment.`
- **generic**: `Slash command /name failed: <error>`

Non-slash prompt failures stay channel-specific (e.g., Telegram prefixes with `⚠️`).

## Regression coverage

- `tests/test-web-chat-slash.ts` — Web slash classification/streaming/failure mapping.
- `tests/test-telegram.ts` — Telegram prompt lifecycle + slash inventory classification.
- `tests/test-slash-contract-parity.ts` — parity checks for classification + user-facing messaging across Web and Telegram contracts.
