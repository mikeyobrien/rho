# Configuration

Rho uses a Doom Emacs-style config model: declare what you want in config files, then sync to apply. You never edit pi's `settings.json` directly — Rho owns that.

Two files control everything:

- `~/.rho/init.toml` — modules and settings
- `~/.rho/packages.toml` — third-party pi packages

Both are created by `rho init`. Edit either one, then run `rho sync`.

## init.toml

### Agent identity

```toml
[agent]
name = "rho"
```

The agent name displayed in status output.

### Modules

Modules are organized into five categories. Each module maps to extensions and/or skills in the [registry](../cli/registry.ts).

```toml
[modules.core]
heartbeat = true      # Heartbeat daemon, check-ins, memory consolidation
memory = true         # Memory browser and viewer

[modules.knowledge]
vault = true          # Knowledge vault with FTS and orphan cleanup

[modules.tools]
brave-search = true   # Web search via Brave API
x-search = true       # X/Twitter search via xAI Grok
email = false         # Agent email at name@rhobot.dev

[modules.skills]
session-search = true # Search across pi session logs
update-pi = true      # Update pi to latest version

[modules.ui]
usage-bars = true     # Token/cost usage display
```

**Core modules are always on.** Setting `heartbeat = false` or `memory = false` has no effect — they're forced enabled. You'll get a warning from `rho sync` if you try.

**Disabling a module** removes its extensions and skills from what pi loads. Set it to `false` or delete the line:

```toml
[modules.tools]
brave-search = true
x-search = false      # disabled — extensions/x-search won't load
email = false
```

### Settings

Configure individual modules with `[settings.<module>]` sections. Settings only matter when the corresponding module is enabled.

```toml
[settings.heartbeat]
interval = "30m"                    # "15m", "1h", "2h", etc.
# prompt = "~/.rho/heartbeat-prompt.txt"   # Custom heartbeat prompt file
# tmux_socket = "rho"              # Dedicated tmux socket name
# tmux_config = "builtin"          # Use Rho's shipped tmux.conf
# tmux_config = "~/.rho/tmux.conf" # Or point to your own

[settings.email]
# handle = "myagent"               # Your @rhobot.dev handle

[settings.brave-search]
# api_key_env = "BRAVE_API_KEY"    # Env var containing the API key

[settings.memory]
# prompt_budget = 2000             # Max tokens for brain prompt in system prompt
# decay_after_days = 90            # Days before unused learnings are decayed
# decay_min_score = 3              # Learnings with this score or higher are exempt from decay
# auto_memory = true               # Auto-extract learnings/preferences from conversations
```

#### Memory settings

The `[settings.memory]` section controls brain.jsonl behavior:

| Setting | Default | Description |
|---------|---------|-------------|
| `prompt_budget` | `2000` | Maximum tokens allocated for the brain prompt injected into the system prompt. Learnings are ranked and trimmed to fit. |
| `decay_after_days` | `90` | Number of days a learning can go unreinforced before being automatically decayed (tombstoned). |
| `decay_min_score` | `3` | Learnings with a reinforcement score at or above this threshold are exempt from decay regardless of age. |
| `auto_memory` | `true` | Whether to automatically extract learnings and preferences from conversations. Can also be controlled via `RHO_AUTO_MEMORY` env var (env overrides config). |

**Adding custom settings:** Add a `[settings.<name>]` section for any module in the registry. If `<name>` doesn't match a known module, `rho sync` warns you and ignores it. There's no freeform settings namespace — settings are always tied to a module.

## packages.toml

Manages third-party pi packages. Each `[[packages]]` entry needs a `source` and optionally filters what loads:

```toml
# Install everything from an npm package
[[packages]]
source = "npm:cool-pi-tools"

# Install from git, only load specific pieces
[[packages]]
source = "git:github.com/user/repo"
extensions = ["extensions/specific.ts"]
skills = ["skills/specific"]
```

Rho tracks which packages it manages via a `sync.lock` file. When you remove an entry from `packages.toml` and sync, the package gets cleaned out of pi's settings too.

## rho sync

The sync command reads your config and writes pi's `settings.json`. Run it after any config change:

```bash
rho sync
```

What it does:

1. **Reads** `~/.rho/init.toml` and `~/.rho/packages.toml`
2. **Validates** config against the module registry (catches typos, wrong categories, unknown modules)
3. **Builds** a Rho package entry with exclusion filters for disabled modules
4. **Merges** third-party packages from `packages.toml`
5. **Removes** packages that were in the previous `sync.lock` but no longer in `packages.toml`
6. **Writes** `~/.pi/agent/settings.json` with the updated packages array
7. **Writes** `~/.rho/sync.lock` to track managed state

The Rho entry in `settings.json` uses `_managed_by: "rho"` as a marker. Don't edit it by hand — the next sync overwrites it.

### How module filtering works

Sync doesn't cherry-pick files to include. It starts with everything (`extensions/**/*.ts`, `skills/*`) and adds exclusion patterns (`!extensions/x-search/**`) for disabled modules. This means new extensions/skills added to Rho load automatically unless you explicitly disable their module.

### Validation

Sync catches common mistakes:

- **Unknown module** — typo in a module name → error
- **Wrong category** — module exists but listed under the wrong `[modules.*]` section → error
- **Disabled core module** — `heartbeat = false` → warning (ignored, stays enabled)
- **Settings for unknown module** — `[settings.foo]` where `foo` isn't in the registry → warning

## Workflow

Typical flow after initial setup:

```bash
# Enable a module
vim ~/.rho/init.toml    # set x-search = true
rho sync

# Add a third-party package
vim ~/.rho/packages.toml
rho sync

# Change heartbeat interval
vim ~/.rho/init.toml    # set interval = "1h"
rho sync
```

To verify everything looks right:

```bash
rho doctor    # checks config, paths, dependencies
rho status    # shows running state
```
