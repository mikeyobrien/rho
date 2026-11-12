# Rho's UX: what is live, what is next, what is being explored

The one list of everything about how rho feels to use. `TASKS.md` holds the record of each
item (what was built, checked and not checked); this file says where each stands and in what
order they come. Update it in the commit that changes a fact here.

Last brought up to date: 2026-11-12. The installed rho ran `09fcc50` then.

## The principles, in the owner's words

Every item below answers to these. They were said on 2026-11-11 and 12.

1. **A human chief of staff.** "I want it to be just like talking to a human chief of
   staff." Plain conversation; the machinery (workers, queues, modes, ids) stays out of
   sight; simpler is better.
2. **Attention is the scarce thing.** Few questions, each with the context needed to
   decide and no more when the topic is fresh. No batches, no lettered menus. "Prompting
   the user with a lot of questions, or making them think more than they need to, adds
   friction."
3. **One thread.** Show things in the chat thread; as little as possible outside it. What
   sits outside and takes height is a cost.
4. **Remote is invisible.** "Users shouldn't even know it's remote." Easy onboarding.
5. **Human names.** A worker is named by its job, never by an id.
6. **No counters about the person's reading.** The reply counter was "tacky" and was
   taken out.

## Live in the installed rho

Built and released. "Seen" says whether the owner has looked at it in a real browser and
said so; nothing is marked seen on the agent's word.

| What | Since | Seen by the owner |
|---|---|---|
| Tool cards fold; a running step shows its time | `7cb3e48` | not said |
| Workers: hand off a whole job, status, tell, Stop | `1e38411` | a row was seen (2026-11-12) |
| Model preferences said in chat; a model per worker | `960d60a` | not said |
| The Running card at the tail of the thread | `960d60a` | seen; led to a fix |
| Report cards: verdict and one line, the rest on a tap | `960d60a` | not said |
| The details page behind ⋯ | `5147e2f` | seen; led to the artifacts change |
| Workers' questions go to the agent, not the person; "Decided without you" on a report | `5147e2f` | not said |
| Workers named by their job on the page | `5147e2f` | not said |
| No questions at the end of a reply (an instruction) | `5147e2f` | judged by reading |
| A message is just a message: no steer or queue controls | `09fcc50` | not said |
| Highlight to reply | `09fcc50` | **not said: the one most likely to misbehave** |
| Artifacts over the whole conversation | `09fcc50` | not said |

## Built, not released

| What | Commit | Note |
|---|---|---|
| The reply counter taken out | `240bbca` | the owner's word |
| The remote tool environment and a command that survives a restart | `28a68ed` | changes nothing the person sees |
| Goal mode: a task run through hats to completion | in progress | being built by a worker, 2026-11-12 |

## Next, in order

The order is the agent's, set on 2026-11-12 from what the owner asked for that day. The
owner has not confirmed the order as a whole.

1. **A real-browser pass over everything live.** Nothing shipped on 2026-11-12 was drawn
   in a real browser before release. Screenshots of each, fixes for what is wrong. It
   takes over the phone's screen for about a minute, so it waits for the owner to say the
   phone is free. Until it is done, "seen" above stays as it is.
2. **Goal mode** (hats). A row in the Running card per goal, one summary report, each
   iteration openable under the goal. Asked for 2026-11-12, modelled on the owner's
   ralph-orchestrator and their own spec for it.
3. **Snapshots of the working tree.** One mechanism, four uses: a worker gets its own
   copy of the project; "undo that"; the change card's numbers; sync to a node.
4. **The change card.** Why, up to five rows of what changed, risk, what was not checked;
   counts and test results filled in by code; a link out to the owner's forge; comments
   there or in the thread come back as work. No diff viewer.
5. **Remote compute, invisible.** The daemon on a node, `rho host add`, placement by code,
   sync by snapshot. Then routes that heal and balancing on live load (from t3code).
6. **Scale: tens to hundreds of workers.** The person deals with outcomes: one row and
   one report per goal, only exceptions reach them, a lead per goal takes its workers'
   reports, workers check workers, a cost ceiling per goal.
7. **Usage left on the plan** (item 18). The feature reviewers miss most in t3code.
8. **Proactivity:** standing goals the owner sets, and the open-items ledger shown to
   them, raised in one bundle at most once a day.

## Waiting on the owner

- **The limit on questions.** The proposed numbers (2 per sitting, 5 a day, 12 open) were
  rejected: "that's the wrong artificial limits." The agent's reading, not confirmed: a
  limit on how many are in front of the person at once, with the main agent merging and
  releasing the next as they answer. No limit is built until the owner says what it is.
- **Where a remote job's result lands.** The agent is building toward: into the working
  tree when it applies cleanly, a branch on conflict. Said to the owner, not confirmed.
- **A standing yes scoped to one goal**, for irreversible commands at scale. It loosens
  the rule that each such command waits for its own yes. Not proposed for building.
- **Goal mode: rho's own loop, or drive the real ralph binary.** The owner's spec of
  2026-11-03 rejects a second loop engine; on 2026-11-12 they asked for "built from
  scratch". The build follows the newer word and keeps ralph's hat format unchanged.
- **Things only the owner's eyes can settle:** highlight to reply against Android's own
  selection toolbar; the details page's back gesture; how long Artifacts takes to open
  on a long conversation.

## Exploring

Designed or researched, not committed to. Each names where its thinking is.

| What | Where it stands |
|---|---|
| Dictation | Designed in conversation 2026-11-12, modelled on Earendil's pi-voice (0.2.0). A mic button; the browser records; a local engine if `transcribe-cpp` builds in Termux, which is untested. The owner has not said what it should beat (Gboard's mic already works) or whether audio may leave the phone. |
| An MCP door on the daemon | From t3code's `outside-agents.md`, read in full 2026-11-12: other harnesses hand rho a goal, read progress, collect the result; sign-in with a level. Start loopback-only and read-only. After the daemon exists. |
| List cards | Reminders, goals and open items as rows with Done / Drop / Later in the thread. From the in-thread UI research (item 20). Not built. |
| Cards for gate and check-in notices | They are still plain text. |
| "Undo that" | Needs snapshots (Next, 3). t3code has checkpoints and revert. |
| Quotes drawn as quotes | A highlighted reply shows as text with `>` in the person's bubble. |
| Editing memory on the details page | Read-only today; item 24. |
| A real artifact store | Today artifacts are read from the thread: files made through `bash`, and files a worker changed, are not listed. |
| A non-git folder on a node | A hidden git store beside rho's data; tried locally once (301 files, 355 ms). Limits: large binaries, no ignore file, double the disk. |
| Hats: a "Design hats" mode | In the owner's spec for another host; left out of rho's build. |
| What a chief of staff does | Reading list given 2026-11-12 from memory, unverified: Casnocha's essay, Badowski's *Managing Up*, Whipple's *The Gatekeepers*. A worker could read them for practices to put in rho's instructions. Not started. |

## Dropped, and why

| What | When | The owner's word |
|---|---|---|
| A question tool with multiple choice | 2026-11-12 | "I really dislike the ask user question" |
| Steer and queue controls, and dobo's merge offer and "Steered" mark | 2026-11-12 | "I don't have to think about queue or steering there" |
| The counting line above the message box, then "Workers: N ended" in the menu | 2026-11-12 | "the done one just takes up space now" |
| "Load earlier" for artifacts | 2026-11-12 | "artifacts shouldn't need to load earlier" |
| The reply counter | 2026-11-12 | "reply counter seems tacky" |
| Worker ids shown to the person | 2026-11-12 | "w6 means nothing to me" |
| Model-written HTML or iframes in the thread | 2026-11-12 | the research's advice, accepted |
| A built-in diff viewer or file viewer | 2026-11-12 | "I don't want to build another file viewer or way to view diffs internally" |
| A finished release shown under "Running" | 2026-11-12 | "Running seems stuck even though it's done" |

## Compared with

- **t3code** (searched 2026-11-12; never used): a control surface with native apps, a
  worktree per thread, inline diffs, checkpoints, one-click PR, machines you choose
  between. Rho answers by being less to operate, not by matching panels. Its remote
  access and MCP docs are the reference for Next 5 and the MCP door.
- **dobo** (its docs at `027da28e`; not run; "unproven" by the owner's word): asks, goals,
  a backlog, remote compute, an MCP server. Its steer rule is the one rho now follows
  with the controls removed.
- **ralph-orchestrator** (the owner's): hats, events, backpressure, fresh context each
  iteration. The model for goal mode.

## Known rough edges

- Nothing from 2026-11-12 was seen in a real browser before it was released.
- A worker once wrote a file outside its directory (TASKS item 20, open).
- A rho its service runner has lost is not supervised and says so nowhere.
- The guard stops the agent's own harmless commands when their text names a push or a
  release; it cost the owner several needless cards on 2026-11-12.
- GitHub's `rho2` branch is behind the phone; each send is its own yes.
