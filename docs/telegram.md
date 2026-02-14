# Telegram integration (MVP)

Rho includes a polling-first Telegram adapter (`extensions/telegram`) that maps Telegram chats to stable rho sessions.

## What it does

- Polls Telegram `getUpdates` with durable offset state
- Normalizes inbound messages and applies authz gates
- Maps chat -> session deterministically (`dm:<chat_id>`, `group:<chat_id>`)
- Runs prompts through rho RPC (`pi --mode rpc`)
- Transcribes inbound `voice` / `audio` / audio-document messages via ElevenLabs STT
- Supports `/tts <text>` to generate and return Telegram voice replies via ElevenLabs TTS
- Sends responses back with chunking + retry/backoff
- Exposes operator controls via tool + `/telegram` command
- Follows shared slash RPC contract (`docs/slash-command-contract.md`) for classification, execution, and errors

## Enable

In `~/.rho/init.toml`:

```toml
[modules.tools]
telegram = true

[settings.telegram]
enabled = true
mode = "polling"
bot_token_env = "TELEGRAM_BOT_TOKEN"
poll_timeout_seconds = 30
rpc_prompt_timeout_seconds = 60
background_prompt_timeout_seconds = 900
allowed_chat_ids = []
allowed_user_ids = []
require_mention_in_groups = true
```

Set your token:

```bash
export TELEGRAM_BOT_TOKEN="<your-bot-token>"
```

Apply config:

```bash
rho sync
```

## ElevenLabs media features (STT + /tts)

Set an ElevenLabs API key for voice features:

```bash
export ELEVENLABS_API_KEY="<your-elevenlabs-key>"
```

Optional TTS voice override (default is ElevenLabs voice `EXAVITQu4vr4xnSDxMaL`):

```bash
export ELEVENLABS_TTS_VOICE_ID="<voice-id>"
# or legacy alias:
export ELEVENLABS_VOICE_ID="<voice-id>"
```

Behavior:

- Inbound `voice`, `audio`, and `document` messages with `audio/*` MIME type are transcribed and replied to with text.
- `/tts <text>` generates a playable Telegram voice reply.
- Missing key or API failures return actionable in-chat error text instead of crashing the worker.

## Worker lifecycle (important)

Telegram polling is owned by the dedicated worker process.

```bash
rho telegram start
rho telegram status
rho telegram logs -f
rho telegram stop
```

Use `rho start` for heartbeat/session daemon lifecycle; use `rho telegram ...` for Telegram transport lifecycle.

## Onboarding + approval flow

### Guided onboarding

```bash
rho telegram onboard
```

This validates the token, detects chat/user, and can lock allowlists.

### Pending access approvals

When strict allowlists block a sender, they receive a PIN. Operator flow:

```bash
rho telegram pending
rho telegram approve --pin 123456
rho telegram reject --pin 123456
```

## Operator controls

Slash command:

```text
/telegram status
/telegram check
/telegram allow-chat <chat_id>
/telegram revoke-chat <chat_id>
/telegram allow-user <user_id>
/telegram revoke-user <user_id>
```

Tool action interface (`telegram` tool):

- `status`
- `check`
- `send` (`chat_id`, `text`, optional `reply_to_message_id`)
- `allow` / `revoke` (`target=chat|user`, `id`)
- `list_chats`

## Long prompt handling

Telegram keeps a foreground RPC timeout (`rpc_prompt_timeout_seconds`) so one stuck prompt cannot block the queue forever.

If a non-slash prompt hits that timeout, the worker:

1. sends an immediate acknowledgement,
2. continues the prompt in a durable background queue,
3. posts the final result in-thread when complete.

Tune with:

- `rpc_prompt_timeout_seconds` (default `60`)
- `background_prompt_timeout_seconds` (default `900`)

## Security model

- Default-off transport (`settings.telegram.enabled = false`)
- Optional allowlists (`allowed_chat_ids`, `allowed_user_ids`)
- Group activation gate (`require_mention_in_groups`)
- Runtime operator allow/revoke persistence in `~/.rho/telegram/config.json`

## State files

- `~/.rho/telegram/state.json` (poll offset + health)
- `~/.rho/telegram/session-map.json` (chat/session mapping)
- `~/.rho/telegram/log.jsonl` (audit events)
- `~/.rho/telegram/config.json` (runtime allow/revoke overrides)
- `~/.rho/telegram/inbound.queue.json` (durable inbound queue)
- `~/.rho/telegram/outbound.queue.json` (durable outbound queue)
- `~/.rho/telegram/background.queue.json` (durable deferred prompt queue)
- `~/.rho/telegram/pending-approvals.json` (approval requests)

## Smoke test

Run local smoke harness (real Telegram API):

```bash
export TELEGRAM_BOT_TOKEN="<token>"
export TELEGRAM_SMOKE_CHAT_ID="<chat-id>"
npm run telegram:smoke
```

Expected output:

- `sent message_id=... chat_id=...`
- `fetched updates=...`

## Known limits (MVP)

- Polling mode only (webhook deferred)
- Text-first outbound rendering (except `/tts` voice replies)
- STT/TTS depend on ElevenLabs availability and API quotas
- `/tts` currently uses a single configured/default ElevenLabs voice
- Operator controls optimized for single-agent runtime
