# Implementation Plan

Convert the design into a series of implementation steps that will build each component in a test-driven manner following agile best practices. Each step must result in a working, demoable increment of functionality. Prioritize best practices, incremental progress, and early testing, ensuring no big jumps in complexity at any stage. Make sure that each step builds on the previous steps, and ends with wiring things together. There should be no hanging or orphaned code that isn't integrated into a previous step.

## Checklist

- [ ] Step 1: Bootstrap the separate Phoenix application and desktop workspace shell
- [ ] Step 2: Ship a working embedded libghostty terminal pane backed by a local PTY
- [ ] Step 3: Add workspace/worktree registry and pi session indexing from disk
- [ ] Step 4: Add pi RPC session management and single-session chat control
- [ ] Step 5: Add streaming transcript rendering, model selection, thinking controls, and slash-command discovery
- [ ] Step 6: Add approvals and the live tool timeline
- [ ] Step 7: Add multi-session and multi-worktree runtime switching with reconnect-safe state restoration
- [ ] Step 8: Add multimodal attachments and per-session attachment history
- [ ] Step 9: Add read-only file preview for session-touched and worktree files
- [ ] Step 10: Add PWA install/reopen behavior, notifications, and production hardening

## 1. Step 1: Bootstrap the separate Phoenix application and desktop workspace shell

**Objective**

Create the standalone Phoenix project, establish the core runtime boundaries, and ship a desktop-oriented shell that can host the later chat, timeline, file, attachment, and terminal panes.

**Implementation guidance**

- Create the new Phoenix repo with LiveView enabled and a desktop-first layout.
- Establish app configuration for localhost-only mode with no auth.
- Build the root shell with:
  - left workspace/session rail
  - center main pane placeholder
  - right context pane placeholder
  - bottom dock placeholder for terminals
- Add initial domain modules for:
  - workspace registry
  - frontend session identity
  - runtime status
  - terminal pane identity
- Define the internal event and process boundaries now, even if some components are still mocked.
- Add app-level supervision tree placeholders for the RPC manager, session indexer, attachment service, and terminal runtime.

**Test requirements**

- Unit tests for workspace/session structs and configuration loading.
- LiveView tests proving the shell renders and desktop panes can be toggled/swapped.
- Smoke test for localhost-only startup.

**How it integrates with previous work**

- This establishes the scaffolding that every later feature plugs into.
- No component added later should need to invent a new top-level layout model.

**Demo**

Run the Phoenix app locally and show a real desktop shell with workspace rail, session area, context pane, bottom dock, and visible runtime status placeholders.

## 2. Step 2: Ship a working embedded libghostty terminal pane backed by a local PTY

**Objective**

Prove the hardest requirement early by delivering one embedded first-class terminal pane inside the app layout, using the libghostty-based approach and a real local PTY.

**Implementation guidance**

- Integrate the chosen libghostty-based browser runtime (`libghostty-vt` / `ghostty-web` style path) through a LiveView hook.
- Create a Phoenix Channel dedicated to terminal I/O.
- Build the Elixir PTY runtime under OTP supervision.
- Bind a terminal pane to a selected worktree path.
- Implement:
  - pane mount
  - keystroke input
  - shell output streaming
  - resize handling
  - pane teardown/reconnect state
  - copy/paste support to the level needed for daily use
- Keep the pane embedded in the real layout, not a standalone prototype page.
- Do not add fallback terminal implementations.

**Test requirements**

- Integration tests for PTY startup, input, output, and resize.
- Browser/E2E test proving the pane renders in-layout and can run commands.
- Failure-path tests for channel disconnect and pane recreation.

**How it integrates with previous work**

- Uses the shell from Step 1 and turns the bottom dock from placeholder into a real subsystem.
- De-risks the strict terminal requirement before the app accumulates too much surrounding surface area.

**Demo**

Open the app, select a worktree, type commands into the embedded pane, see live output, resize the pane, and reconnect without leaving the app shell.

## 3. Step 3: Add workspace/worktree registry and pi session indexing from disk

**Objective**

Make the app aware of multiple local projects/worktrees and historical pi sessions without requiring live RPC processes for every list view.

**Implementation guidance**

- Build the workspace/worktree registry service.
- Add user-manageable local workspace definitions.
- Implement the session indexer that reads pi session JSONL files directly from disk.
- Extract and cache:
  - session name
  - first prompt
  - timestamps
  - cwd/worktree path
  - parent/fork relationships
  - lightweight usage/message counts where cheap
- Connect indexed sessions to the left rail UI.
- Support opening a historical session shell view before live RPC is attached.

**Test requirements**

- Unit tests for JSONL parsing and session summary extraction.
- Tests for index refresh and cache invalidation on file changes.
- LiveView tests for workspace and session rail rendering.

**How it integrates with previous work**

- Extends the shell from Step 1 and gives the terminal worktree selection from Step 2 a real backing model.

**Demo**

Register multiple worktrees, switch between them, and browse their pi session history from disk in the sidebar without launching live session processes.

## 4. Step 4: Add pi RPC session management and single-session chat control

**Objective**

Get one selected session fully live by spawning `pi --mode rpc`, sending prompts, and maintaining live runtime state for that session.

**Implementation guidance**

- Implement the supervised RPC manager for live sessions.
- Support:
  - new live session
  - attach/switch to existing session file
  - get current state
  - prompt sending
  - abort
- Normalize identifiers across frontend session id, pi RPC session id, and session file path.
- Store recent events in a replayable buffer.
- Publish runtime updates to LiveView via PubSub or equivalent internal messaging.
- Keep this step focused on one active session flow end-to-end.

**Test requirements**

- Integration tests for spawning pi, sending commands, and parsing JSONL responses/events.
- Tests for identifier mapping and replay buffer behavior.
- Failure tests for process crash or malformed response handling.

**How it integrates with previous work**

- Connects the session list from Step 3 to real live control.
- Establishes the control plane that later steps enrich with streaming UI, approvals, and attachments.

**Demo**

Pick a worktree, start or open a session, send a prompt, and show that the app owns a live pi subprocess with session state reflected in the UI.

## 5. Step 5: Add streaming transcript rendering, model selection, thinking controls, and slash-command discovery

**Objective**

Turn the live session into a usable chat surface with real streaming output and operator controls.

**Implementation guidance**

- Render transcript messages from live events.
- Stream assistant text incrementally.
- Render thinking blocks and tool call mentions as distinct transcript elements.
- Add composer controls for:
  - prompt input
  - per-session model selection
  - thinking-level selection
- Implement `get_commands`-backed slash-command discovery and insertion.
- Keep rendering efficient: patch active messages incrementally and finalize expensive formatting after completion.

**Test requirements**

- Tests for message event sequencing and transcript assembly.
- LiveView tests for model/thinking control UI.
- E2E test proving a streamed answer appears progressively rather than only at completion.

**How it integrates with previous work**

- Builds directly on the RPC manager from Step 4.
- Produces the first serious version of the center pane in the workspace shell.

**Demo**

Start a session, change model and thinking level, send a prompt, and watch the answer stream live into the transcript while slash-command discovery works in the composer.

## 6. Step 6: Add approvals and the live tool timeline

**Objective**

Expose pi's tool execution behavior clearly and preserve pi's native approval semantics through the UI.

**Implementation guidance**

- Map `extension_ui_request` to approval and input dialogs/cards in LiveView.
- Send `extension_ui_response` back to pi for confirm/select/input/editor flows.
- Build the tool timeline pane with:
  - running tools
  - completed tools
  - errors
  - arguments
  - partial and final output
- Ensure cumulative `tool_execution_update.partialResult` replaces visible output.
- Highlight pending approvals in both the timeline and global status layer.

**Test requirements**

- Integration tests for approval round-trips.
- Tests for tool timeline lifecycle from start → partial updates → end.
- Browser/E2E tests showing a user approving a tool and observing the result in the timeline.

**How it integrates with previous work**

- Completes the live operator loop started in Steps 4 and 5.
- Turns the app from chat UI into a serious agent-control surface.

**Demo**

Trigger a prompt that requires tool use and approval, approve it in-app, and watch the full tool lifecycle appear in the timeline with live output and final status.

## 7. Step 7: Add multi-session and multi-worktree runtime switching with reconnect-safe state restoration

**Objective**

Make the application truly workspace-class by supporting multiple active or resumable sessions across multiple worktrees without losing context.

**Implementation guidance**

- Support switching among multiple workspaces and their sessions from the shell.
- Add policies for hot, warm, and cold live sessions if needed to control subprocess count.
- Persist UI restoration state for:
  - selected workspace/worktree
  - selected session
  - open pane context
  - active terminal pane bindings
- Implement reconnect/reopen replay using buffered session events.
- Ensure the UI can reconcile disk-derived session state and live runtime state cleanly.

**Test requirements**

- Integration tests for switching among multiple sessions/worktrees.
- Reconnect tests that restore visible session state after LiveView/socket interruption.
- Tests for keeping terminal and chat runtime associations correct while switching.

**How it integrates with previous work**

- Expands the single-session workflow into the required multi-worktree product shape.
- Uses the event buffer introduced in Step 4 and the shell from Step 1.

**Demo**

Open multiple sessions across multiple worktrees, switch among them, restart/reconnect the UI, and show that the app restores the right workspace/session context cleanly.

## 8. Step 8: Add multimodal attachments and per-session attachment history

**Objective**

Make file uploads a first-class part of the chat workflow and persist them as session artifacts rather than transient composer state.

**Implementation guidance**

- Add composer-side file picking/drag-drop.
- Implement the attachment service with explicit lifecycle states.
- Persist attachment metadata and storage references locally.
- Attach supported files to chat messages and pass them through to pi/model backends.
- Build the session attachment shelf with:
  - visible history
  - status badges
  - reuse/reattach action
  - model compatibility warnings
- Start with the modalities needed to satisfy milestone one, but keep the data model general.

**Test requirements**

- Unit tests for attachment state transitions and compatibility checks.
- Integration tests for upload → send → history persistence.
- Browser/E2E tests for attaching a file, seeing it in the transcript, and reusing it from session history.

**How it integrates with previous work**

- Extends the composer from Step 5.
- Adds the attachment shelf to the right/context pane established in Step 1.

**Demo**

Attach a file in chat, send it to a live session, see it appear in the message, and then reattach it later from the session attachment history shelf.

## 9. Step 9: Add read-only file preview for session-touched and worktree files

**Objective**

Provide review-oriented file visibility without turning the app into an editor.

**Implementation guidance**

- Track file references surfaced by pi transcript and tool output.
- Expose worktree browsing within active workspace boundaries.
- Build read-only previews for:
  - text files
  - images
  - basic document previews where reasonable
- Show provenance so users know whether a file came from session activity or broader worktree browsing.
- Keep all interactions read-only in v1.

**Test requirements**

- Tests for provenance extraction and path boundary enforcement.
- Integration tests for previewing both session-linked and worktree-linked files.
- Browser/E2E tests for opening a file from the timeline or attachment/session context.

**How it integrates with previous work**

- Uses session and worktree data from Steps 3 and 7.
- Completes the review-oriented context pane beside chat and tools.

**Demo**

Open a file referenced by pi from the session timeline, preview it read-only, then browse another file in the active worktree from the same UI.

## 10. Step 10: Add PWA install/reopen behavior, notifications, and production hardening

**Objective**

Turn the working app into a reliable desktop-style localhost product that installs, reopens cleanly, communicates runtime health clearly, and survives real operator behavior.

**Implementation guidance**

- Add manifest, icons, and service worker/app-shell caching for localhost installability.
- Persist enough shell state to reopen into the prior workspace/session context.
- Add status and notification surfaces for:
  - disconnected pi runtime
  - pending approvals
  - upload failures
  - terminal failures
  - active streaming/running state
- Harden replay, reconnect, and process cleanup paths.
- Add observability for runtime health, active sessions, terminal lifecycles, and event lag.
- Polish desktop keyboard navigation and layout behavior.

**Test requirements**

- Browser/E2E tests for install/reopen flows.
- Reconnect and restart tests for Phoenix/pi runtime interruptions.
- Regression suite covering the main operator journey end-to-end.

**How it integrates with previous work**

- Finalizes the shell and runtime systems created in Steps 1–9 into a cohesive desktop-class product.
- Ensures nothing remains as a fragile prototype-only path.

**Demo**

Install the app as a PWA, reopen it, recover the last workspace/session shell, see status/notifications update as the runtime changes, and continue working without losing the operator context.

## Connections

- [[../design/detailed-design.md]]
- [[../research/README.md]]
- [[../research/pi-integration-surface.md]]
- [[../research/codex-desktop-benchmark.md]]
- [[../research/liveview-pwa-patterns.md]]
- [[../research/terminal-embedding-libghostty.md]]
- [[../research/multimodal-attachments.md]]
- [[../idea-honing.md]]
