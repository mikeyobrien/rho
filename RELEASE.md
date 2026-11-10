# Releasing rho 2.0.0

For the owner. Nothing here has been run: the branch is not pushed, no tag exists, and
nothing is published. Run the steps in order, on a machine that is logged in to GitHub
(`gh auth status`) and, for step 5, to npm (`npm whoami`).

Two decisions are yours and are marked **Decide**.

## 0. Before you start

Read the "Not checked" lines in [TASKS.md](TASKS.md) and the known limits in
[CHANGELOG.md](CHANGELOG.md). The largest gap: no request has been sent to Anthropic,
OpenAI, Google or OpenRouter with an API key, because none was available. Step 2 closes it.

## 1. Get the branch onto the release machine and check it

The branch exists only on the phone. Move it as a bundle, not by pushing from the phone:

```sh
# on the phone
cd ~/projects/rho && git bundle create rho2.bundle v2
scp rho2.bundle <release-machine>:

# on the release machine
git clone https://github.com/mikeyobrien/rho.git rho-release && cd rho-release
git fetch ../rho2.bundle v2:rho2
git checkout rho2
bun install --frozen-lockfile
bun run check
```

Check: `bun run check` ends with `0 fail`. `git log --oneline | wc -l` matches the phone's
`git -C ~/projects/rho log --oneline | wc -l`.

Do not use the bundle in `~/.cache/rho-backup/` on the phone. It is the history from before
private names were removed.

## 2. Try it with a real API key

```sh
export RHO_HOME=$(mktemp -d) RHO_PORT=4799
bin/rho key anthropic        # paste a key
bin/rho open                 # ask it to list the files in a directory
bin/rho stop
rm -rf "$RHO_HOME"; unset RHO_HOME RHO_PORT
```

Check: `rho status` says `Model: anthropic/claude-sonnet-5-5.` and the page answers using a
tool. If this fails, stop: the documented default does not work, and the release waits.

## 3. Push the branch

**Decide** the branch name. GitHub has a branch `v2/standalone-install`, so a branch named
`v2` cannot be pushed. The README says `rho2`. If you want another name, change the clone
line in `README.md` first and commit that.

```sh
git push origin rho2
```

Check: `git ls-remote --heads origin rho2` prints the same commit as `git rev-parse rho2`.
Then, in a new directory, run the four install lines from the README's Install section and
`rho start`. This is the first time the GitHub address in the README is exercised.

Do not change the repository's default branch yet. `main` is rho 1, and `npm` and existing
users point at it.

## 4. Tag and make the GitHub release

```sh
git tag -a v2.0.0 -m "rho 2.0.0" rho2
git push origin v2.0.0
gh release create v2.0.0 --title "rho 2.0.0" --notes-file CHANGELOG.md --target rho2
```

Check: `gh release view v2.0.0` shows the release, and its tag points at the pushed commit.

## 5. npm

**Decide** whether to publish at all. The documented install is a git checkout, and the
release gate (rho updating itself) works only from a git checkout. A package install was
tried from a packed tarball on the phone: `rho start`, `rho status` and the page work;
`rho release` does not.

The package name `@rhobot-dev/rho` is rho 1's, at 0.1.12. Publishing 2.0.0 with the default
tag makes it `latest`, and everyone who installs or updates rho 1 by name gets a different
program that needs Bun. To publish without that, use the `next` tag:

```sh
bun pm pack --dry-run          # 35 files: bin, src, web and the documents
npm publish --tag next --access public
```

Check: `npm view @rhobot-dev/rho dist-tags` shows `latest: 0.1.12` and `next: 2.0.0`.

To make 2.0.0 the default later: `npm dist-tag add @rhobot-dev/rho@2.0.0 latest`.

A published version cannot be replaced. If the package is wrong, publish 2.0.1.

## 6. Announce

Only after steps 1 to 4 pass. Points that are true and can be said:

- Rho 2 is a rewrite on pi-durable that continues after being killed, for Termux and Linux.
- It remembers through a memory provider, runs reminders unattended, and can release
  changes to its own code through a gate that goes back on failure.
- Rho 1 is untouched on `main`, and nothing is imported from it.

Say also: macOS is untested, and it gives a model a shell on your machine
([SECURITY.md](SECURITY.md)).

## 7. After the release

- The rho installed on the phone was moved to the rewritten history on 2026-11-10 by its
  own gate. To bring it to the released commit: `cd ~/projects/rho && rho release`.
- Delete `~/.cache/rho-backup/` on the phone when you no longer want the old history.
- Changing the default branch to `rho2`, and what happens to `main`, are later decisions.

## If something goes wrong

- A bad push before the tag: `git push origin --delete rho2`, fix, push again.
- A bad tag: `git push origin --delete v2.0.0 && git tag -d v2.0.0`, and
  `gh release delete v2.0.0` if the release was made.
- A bad npm publish: it cannot be undone after 72 hours and should not be undone before.
  Publish a fixed 2.0.1 and `npm deprecate @rhobot-dev/rho@2.0.0 "use 2.0.1"`.
