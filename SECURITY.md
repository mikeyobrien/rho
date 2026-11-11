# Security

Rho is an agent with a shell. This page states what protects you and what does not.

## What rho can do

- The model runs commands with `bash` and changes files **as you**. It has your files, your
  SSH keys, your logins and your network. There is no sandbox.
- Rho is for one person on a machine they trust. Do not run it for other people or expose it
  to them.

## The door

- Rho listens on `127.0.0.1` only. It does not listen on your network.
- Every API call needs a bearer token. The token is made on first start and kept in
  `~/.rho/v2/token`, readable only by you.
- A browser gets the token by trading a one-use pairing code, which `rho open` puts in the
  link it opens. A used code is refused. The page removes the code from the address.
- Requests from another web origin, or with a host name other than `127.0.0.1` or
  `localhost`, are refused. This stops other web pages from driving rho.
- Any program running as you on the same machine can read the token file and use rho. So
  can anyone who can read your home directory.
- The page's own files (HTML, scripts, styles) are served without the token. They hold no
  secrets.
- A photo you send is checked by its bytes: only JPEG, PNG, GIF and WebP are taken, whatever
  the file is called. The event stream says only how many photos a message has. The page
  asks for each picture with the token, and shows it as an image, never as markup.

## Guard rails on tools

- These wait for you to press Allow in the page: `git push`, publishing a package (`npm`,
  `bun`, `pnpm`, `yarn`), merging, releasing or deleting on GitHub with `gh`, and
  `rho release`. Allow grants that exact command once.
- These are refused: deleting a `.git` directory, and reading or writing rho's own data
  directory (its token, keys and storage).
  - `read`, `write`, `edit`, `ls`, `grep` and `find` resolve the path first, so a link or a
    second name for the directory does not get around this.
  - `bash` is refused when the command's text names the directory, when a path written in
    the command resolves into it, or when the command would start inside it. A command that
    builds the path another way (a wildcard, a variable, `cd` to the parent and then a
    relative name) is not caught. See the next point.
- **The guard reads the command's text. It is a seatbelt, not a boundary.** A command that
  hides what it does, through a variable, a script file or another interpreter, passes it.
  A model that is tricked or mistaken can still do harm that the guard does not name, such
  as deleting your files.
- A run stops after 200 tool rounds by default. A check-in stops after 20.
- A check-in runs with nobody watching. An action that needs your Allow is refused there,
  and the model is told to report that it was not done.
- The agent cannot read or write rho's data directory. It can propose a change to five
  settings (`model`, `thinking`, `cwd`, `checkins`, `decider`), which is written only after
  you press Allow on a card that shows the old and the new value. It cannot propose a change
  to keys, providers, memory, the Claude plan or the turn limit. Read the card: a `decider`
  address or a `cwd` you allow is used from the next start.

## Text from the web

- `web_search` and `fetch_content` mark what they return as untrusted text, and the model is
  told not to follow instructions inside it. This lowers the risk of prompt injection. It
  does not remove it.
- `fetch_content` refuses addresses that are private, loopback or link-local, so the model
  cannot be sent to services on your own network. It checks the name before connecting and
  does not defend against a name that changes its address between the check and the
  connection (DNS rebinding).
- `web_search` sends your query to Exa's public search service.

## Keys and logins

- API keys given to `rho key` are stored in `~/.rho/v2/keys.json`, readable only by you,
  as plain text. They are never accepted as command arguments and never printed or logged.
- A key in an environment variable is read when rho starts and then removed from rho's own
  environment, so the model's `bash` cannot print it with `env`. This covers the variables
  of the providers rho knows and `apiKeyEnv` of your own providers. It does not cover your
  AWS variables, `CLAUDE_CODE_OAUTH_TOKEN` (the Claude CLI needs it), or any other secret
  in the environment rho was started with: `bash` sees those. On Linux, a process running as you can still read the environment rho was started
  with from `/proc`.
- `rho login` stores a provider's login (an access token and a refresh token) in the same
  file, as plain text. Rho does its own sign-in and does not read another program's login.
- With `"claudePlan": true`, rho uses your Claude Code login by starting the `claude`
  command. Rho does not read or copy that login. Claude Code sends its own requests, and a
  relay on loopback puts your conversation into them. Anthropic may refuse such use of a
  plan or charge it to usage credits; see the README.
- Your conversations, and the photos in them, are sent to the model provider you chose. A
  photo that rho had to make smaller loses its EXIF data on the way. A small one is sent as
  it is, and a camera photo's EXIF data can say where it was taken. With the Honcho memory
  provider, each turn is also sent to your Honcho server.
- With a `decider` configured, each shell command the agent runs is sent to that server with
  your last message and the working directory. Commands that name rho's own data are not
  sent. The decider only labels commands; it stops nothing, and is not a safeguard yet.

## Memory

- The local memory provider refuses to store text that looks like an instruction to the
  model, a secret, or hidden characters. This is a pattern check and can be evaded.
- Memory is added to every request. Anything stored there is sent to the model provider.

## Data on disk

- Everything rho 2 writes is under `~/.rho/v2/`: conversations, memory, keys, token, logs.
  It is not encrypted. Deleting that directory removes rho 2's state.
- Photos you send are kept inside the conversations, in the same database.
- Two logs are kept there as plain text and grow without limit: each request for your yes
  with your answer, and, with a decider, each shell command it was shown. Both hold the
  commands' text. Delete them when you like; nothing depends on them.

## Reporting a problem

Open an issue at https://github.com/mikeyobrien/rho/issues. For something that should not
be public, use GitHub's private vulnerability reporting on that repository.
