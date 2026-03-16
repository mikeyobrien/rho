# Idea Honing

## Connections

- [[rough-idea.md]]

## Question 1

What do you want this LiveView frontend to actually do on day one: just chat with pi, or also expose things like session history, tool call visibility, file browsing/editing, model controls, and task/memory/vault workflows?

## Answer 1

Final answer: Start with feature parity with the Codex desktop application.

Interpretation note: the initial release should aim beyond basic chat and cover the core desktop-style agent workflow surface rather than a narrow messaging UI.

## Question 2

When you say feature parity with the Codex desktop app, do you want that treated as near-full parity across the main surfaces, or should v1 deliberately exclude anything like built-in code editing, terminal panes, or local git operations and focus on the agent-centric parts first?

## Answer 2

Final answer: Exclude built-in code editing and local git operations from v1. Include terminal panes via libghostty.

Alternatives considered: full parity including editor and git surfaces, but those are intentionally deferred.

## Question 3

What is the intended runtime shape: should this be a local-first desktop-style app served by Phoenix on the user's machine and connected to a local pi process, or a remotely hosted web app that can drive pi sessions on another box?

## Answer 3

Final answer: Local-first desktop-style app, delivered as a PWA, running on localhost against a local pi process.

Future direction: the architecture should leave room for an eventually hosted mode that can drive a remote pi instance.

## Question 4

What are the must-have surfaces for the first serious version? For example: chat thread, session list, streaming output, tool call timeline, approvals, terminal panes, settings/model selection, file explorer/read-only file preview, memory/vault/task views, notifications, and multi-session support.

## Answer 4

Final answer: Include all of those core surfaces except memory, vault, and task views.

Included surfaces: chat thread, session list, streaming output, tool call timeline, approvals, terminal panes, settings/model selection, file explorer/read-only file preview, notifications, and multi-session support.

Explicit exclusions for the first serious version: memory views, vault views, and task views.

## Question 5

For approvals and tool execution, should the app preserve pi's existing approval model and event stream pretty much as-is, or do you want the UI to introduce a more opinionated workflow layer on top of pi from the start?

## Answer 5

Final answer: Keep pi's existing approval model and event stream as-is for the first version.

Design implication: the frontend should adapt to pi rather than redesign pi's workflow semantics up front.

## Question 6

Do you want the UI to be tightly modeled on the Codex desktop app's information architecture and interaction patterns, or just match capability while taking a cleaner Phoenix/LiveView-native approach where it makes sense?

## Answer 6

Final answer: Match capability, but take a clear Elixir/Phoenix/LiveView-native approach.

Rationale: the goal is not pixel-copy parity; it is a strong desktop-class agent UI expressed idiomatically in the target stack.

## Question 7

How important is offline or degraded-mode behavior for the PWA? For example, should it merely install and reopen cleanly, or should it also cache prior session history/UI shells and remain partially usable when the local pi process is down?

## Answer 7

Final answer: Keep PWA expectations modest for v1 — it should install and reopen cleanly.

Explicit non-goal for v1: meaningful offline workflow support or cached partial operation while pi is unavailable.

## Question 8

What platforms matter first? Just desktop browsers installed as a PWA, or do you also want tablet/mobile layouts to be first-class from the beginning?

## Answer 8

Final answer: Desktop browsers first.

Explicit non-goal for v1: first-class tablet/mobile layouts.

## Question 9

Do you have a preference on where this should live architecturally: inside the pi repo itself, as a separate Phoenix app that talks to pi over RPC/stdin-websocket bridges, or as a module embedded into an existing Elixir system?

## Answer 9

Final answer: Build it as a separate Phoenix app in its own repository.

Design implication: integration boundaries with pi should be explicit and network/process based rather than in-process coupling.

## Question 10

What should success look like for the first milestone? Pick the smallest outcome that would make you say this is real: e.g. connect to a local pi instance, list sessions, open one, stream chat replies, show tool calls, and render one working terminal pane.

## Answer 10

Final answer: The first milestone should prove the core interactive workflow is real.

Must include:
- connect to a local pi instance
- chat with streaming replies
- model selection and thinking-level controls in chat
- file uploads for multimodal models

Interpretation note: milestone one is not just transport connectivity; it must demonstrate meaningful operator control over model behavior and attachments.

## Question 11

For file uploads, should v1 support only passing attachments through to pi/model backends from the chat composer, or do you also want an asset library / per-session attachment history UI from the start?

## Answer 11

Final answer: Include a per-session attachment history UI in v1.

Design implication: attachments should be treated as first-class session artifacts, not just transient composer inputs.

## Question 12

For the read-only file preview surface, should it show only files pi has touched or referenced in a session, or should the app also provide broader workspace browsing from the start?

## Answer 12

Final answer: Support both files pi has touched/referenced in the session and files available in the current git worktree.

Design implication: the file preview model should distinguish between session-linked artifacts and broader worktree-visible files, while remaining read-only in v1.

## Question 13

Should v1 assume a single active local pi/workspace connection at a time, or should the UI support switching among multiple local projects/worktrees and their associated pi sessions from the start?

## Answer 13

Final answer: Support switching among multiple local projects/worktrees and their associated pi sessions from the start.

Design implication: connection/workspace selection is a first-class concept, not an afterthought.

## Question 14

Do you already have any constraints or opinions about authentication and access control for localhost mode? For example: no auth on localhost, lightweight local session auth, or something else.

## Answer 14

Final answer: No auth for localhost mode.

Design implication: v1 should optimize for local trust and low friction rather than local account management.

## Question 15

For terminal panes via libghostty, do you want them treated as embedded first-class panes inside the main app layout, or is opening/managing detached terminal windows acceptable for an early version?

## Answer 15

Final answer: Embedded first-class terminal panes.

Design implication: terminals are part of the main interaction model, not a sidecar escape hatch.

## Question 16

Does the requirements clarification feel complete for now, or do you want to keep refining it before we switch to research? If you're ready, I’d suggest research next on pi’s RPC/event surface, Codex desktop capability benchmarks, Phoenix LiveView desktop/PWA patterns, libghostty embedding, and multimodal attachment handling.

## Answer 16

Final answer: Requirements clarification is complete for now. Proceed to research, and use parallel research subagents.

Next-step note: run parallel research on the main technical and product-shaping topics before drafting the design.
