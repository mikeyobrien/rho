# Moving from rho 1 to rho 2

Rho 2 is a different program, not an upgrade of rho 1. You can run both on one machine.

## What happens to rho 1

- Nothing. Rho 2 reads and writes only `~/.rho/v2/`. Rho 1's files in `~/.rho` (`brain/`,
  `vault/`, `init.toml`, `telegram/` and the rest) are never changed, moved or deleted.
- Rho 1 keeps working. It is on the `main` branch and is still the `@rhobot-dev/rho` 0.1
  package.
- When rho 2 starts and finds rho 1 data, it writes one line to its log saying what it found.
- To remove rho 2, stop it, run `rho service uninstall` if you installed the service, and
  delete `~/.rho/v2/`.

## What is not carried over

**Rho 2.0 imports nothing from rho 1.** There is no import of the brain, the vault or
`init.toml`. Rho 2 starts with an empty memory.

If you want rho 2 to know something from your rho 1 brain, tell it in conversation, or put
standing instructions in `~/.rho/v2/AGENTS.md`.

## What is different

| Rho 1 | Rho 2 |
| --- | --- |
| A set of pi extensions, run inside pi | Its own daemon, started with `rho start` |
| Node.js | Bun |
| `~/.rho/init.toml` | `~/.rho/v2/config.json` |
| Brain (`brain.jsonl`) | Memory provider: local files or Honcho |
| Heartbeat | Check-ins set with the `reminder` tool |
| Vault | Not in 2.0 |
| Telegram, email | Not in 2.0 |
| Subagents | Not in 2.0 |
| Web UI and terminal UI | A web page on loopback |
| pi's model settings | `rho key` and `config.json` |

## The command name

Both versions install a command called `rho`. If rho 1's is on your `PATH`, the one found
first wins. Check with `rho version`: rho 2 prints a git commit. To keep both, link rho 2
under another name, for example `ln -sf ~/rho/bin/rho ~/.local/bin/rho2`.
