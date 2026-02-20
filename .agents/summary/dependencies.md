# Dependencies

## Runtime Dependencies (package.json)
- `hono`, `@hono/node-server`, `@hono/node-ws`
  - Web server routing, static assets, websocket transport
- `grammy`, `@grammyjs/auto-retry`
  - Telegram bot integration
- `smol-toml`
  - TOML parsing for config/templates
- `tsx`
  - TypeScript execution in Node for scripts/tests/dev runtime

## Peer/Dev Dependencies
- `@mariozechner/pi-coding-agent`, `@mariozechner/pi-ai`, `@mariozechner/pi-tui`
  - Pi runtime/tooling integration surface
- `@sinclair/typebox`
  - Schema typing support in extension ecosystem

## External Service Interfaces
- Brave search API (optional via `BRAVE_API_KEY`)
- Telegram Bot API (when telegram module enabled)
- Rhobot mail APIs (when email module enabled)

## Dependency Topology
```mermaid
graph LR
  Rho[rho package] --> Hono[Hono stack]
  Rho --> Grammy[grammy]
  Rho --> Pi[@mariozechner/pi-*]
  Rho --> Toml[smol-toml]
  Tests[tests/*] --> Tsx[tsx]
```

## Notes
- Browser frontend intentionally avoids npm frontend runtime dependencies and serves plain JS modules.
- Most project complexity is in internal module boundaries, not third-party library count.
