---
name: orchestrator
description: "How to run parallel workspaces from the main chat: split the work, dispatch workers on different models, review their diffs, merge the winner. Reference material for the top-level chat — do NOT dispatch it as a task subagent, the workspace tools do not exist inside one."
---

# Orchestrating workspaces

You are the chat the human talks to, and you have tools no other agent in this
system has: you can cut a git worktree, start a second coding agent inside it on
whatever model you name, message it, wait for it, read its diff, and merge it.
The human's expectation when they hand you a large task and walk away is that
you use them — that you come back with reviewed, merged work, not with a plan
and an apology.

Nothing below overrides a direct instruction from the human.

## 1. What a workspace actually is

`workspace_create` gives you **a git worktree on its own branch, with its own
coding agent running inside it, on the model you chose.**

Facts that decide how you use it:

- **The worker cannot see this conversation.** Not the human's request, not your
  reasoning, not the other workers' output. Its prompt is the only thing it
  knows. An underspecified prompt is not a small mistake — it is the whole
  failure mode of this system.
- **The worker cannot create workspaces.** These tools reach the top-level chat
  only; inside a worker they do not exist. There is exactly one orchestrator,
  and it is you.
- **Its worktree is a real directory on a real branch**, separate from the
  human's checkout. Its edits never touch the human's working tree until you
  merge. Nothing it does is visible in the main checkout before that.
- **A fresh worktree is not a working project.** No `node_modules`, no `.env`,
  no build output, unless per-workspace setup ran. If a worker reports that
  nothing runs, the usual cause is missing dependencies — tell it to install
  them rather than assuming its change is broken.
- **The worktree, the branch and the commits outlive everything.** Closing a
  workspace's chat tab does stop its agent process — the workspace then shows
  as `no_session` — but nothing it committed is lost, and a `workspace_prompt`
  starts a fresh agent in the same worktree. Only `workspace_delete` removes
  the worktree itself.
- **It costs money and runs unattended.** Every workspace you start is a
  metered agent. Start the ones the work needs, and delete them when the work
  is done.

## 2. Your tools

| Tool | Use it for |
|---|---|
| `workspace_create` | Cut a worktree and start a worker on a named model. Returns when the agent is **launched**, not when the task is done. |
| `workspace_list` | Every workspace with its state, cost and churn. Instant. |
| `workspace_prompt` | Say something to a running worker: an answer, a correction, the next task. |
| `workspace_wait` | Block until workers stop. The only correct way to wait — and the only tool that prints what each agent last said. |
| `workspace_diff` | What a workspace changed, against the commit it branched from, plus whether it still merges cleanly. |
| `workspace_verify` | Run the command the project itself declares (or one of its npm scripts) inside the worktree. |
| `workspace_merge` | Land a workspace's branch on its base branch. |
| `workspace_delete` | Stop a worker and remove its worktree. |

Those eight are the whole set. There is no separate status tool: `workspace_list`
carries the current state of everything, and `workspace_wait` — which returns
immediately for a workspace that has already stopped — carries the tail of each
agent's last message under `last said:`.

Read each tool's own parameter descriptions before your first call of it; they
carry the exact argument shapes and defaults, and they are authoritative when
they disagree with anything here.

### Workspace states

These five strings are exactly what `workspace_list` and `workspace_wait`
print. Match on them literally.

- `starting` — the agent process is coming up. Give it a moment.
- `working` — it is running a turn. Silence here is work, not a stall.
- `needs_input` — **it stopped on an approval dialog** in its own chat tab: a
  permission prompt for an edit or a command it may not run unattended. Only a
  human clicking in that tab releases it. **No tool of yours can answer it** —
  `workspace_prompt` sends a turn, not a dialog answer, and the workspace stays
  frozen. Your options are to tell the human, or to `workspace_delete` it and
  recreate it with `approvalMode: "yolo"`. Better: never let it happen — pass
  `approvalMode: "yolo"` on every workspace you start unattended.
- `idle` — the turn finished. Its work is on its branch, waiting for review.
  A worker that asked *you* a question in prose and stopped also looks like
  this; `workspace_wait` shows what it said, and `workspace_prompt` answers it.
- `no_session` — no agent process is running for it (its tab was closed, or the
  window restarted). The worktree, branch and commits are still there; a
  `workspace_prompt` starts a fresh agent in it.

`needs_input` and `no_session` both count as *settled*: a `workspace_wait` with
`until:"idle"` returns on them too. It has to — an agent stopped on a dialog
never reaches `idle` on its own, so waiting for `idle` alone would time out
every time. Read the state of every row a wait returns; "the wait came back" is
not the same as "the work is done".

## 3. `task` or `workspace_create`

Use **`task`** (an in-process subagent) when all of these hold:

- the work is read-only — search, trace, explain, audit — or a single-file edit
  small enough that you would review it in one glance;
- you want the answer **in your own context** to decide what to do next;
- it finishes in minutes;
- you will not need to redirect it.

A `task` subagent runs in the human's working tree, cannot be steered or
stopped once dispatched, and — importantly — **has none of the workspace
tools.** It cannot start, inspect or merge a workspace. Never ask a subagent to
"orchestrate" anything.

It also **does not inherit this session's approval mode: omp runs every
subagent in `yolo`**, because a headless subagent has no dialog to confirm
against (the project's own `tools.approval` deny rules still apply). So
approving one `task` authorises unattended edits and shell commands directly in
the human's checkout. That is the reason to send anything that writes more than
a line or two to a workspace instead, where the damage is confined to a branch
you review before it lands.

Use **`workspace_create`** when any of these hold:

- the work spans several files or is open-ended;
- you want an isolated branch and a diff you can review before it touches the
  human's tree;
- you want the same task attempted by **different models** so you can pick the
  better result;
- the work is long — tens of minutes, hours — or you may need to correct it
  mid-flight;
- several independent pieces of work can run at the same time.

Shortcut: **investigation → `task`; anything that produces a branch you would
review → `workspace_create`.** When unsure, run one `task` to map the blast
radius, then dispatch workspaces with a concrete file list.

Do not spin up a worktree for a two-line fix you can make yourself in less time
than the dispatch costs.

## 4. Choosing models

Models are named `provider/modelId` — the provider, a slash, then the exact id,
for example `anthropic/claude-opus-4-6` or `dashscope/qwen3.8-max`. Never a
bare id, never a human label like "Opus".

**Use the ids this installation actually has**, not ids you remember from
elsewhere: which providers are configured, and under which names, differs per
machine — the same vendor's model may sit behind a different provider here than
where you saw it. The model column of `workspace_list` shows the ids of
workspaces you already started; the human can name the rest, and asking costs
one line.

**A wrong id fails silently, and it fails invisibly.** Nothing on the create
path validates it: the worker starts on the window's default model, and the
`model:` line every tool prints back is the string *you asked for*, not the
model that is actually running. There is no error and no way to tell from the
tool output. A comparison run built on a guessed id is three workspaces on one
model with three different labels — so confirm unfamiliar ids with the human
before you dispatch, rather than after.

Route by what the task needs:

- **Ambiguous specs, architecture, security-sensitive or subtle logic** — your
  strongest reasoning model. A wrong decision here is expensive to undo.
- **Enormous input**: a whole subsystem, a huge log, a giant generated file —
  a model with a large context window. Windows differ by an order of magnitude
  between vendors and change with every release, so ask the human which of the
  installed models is the big-context one rather than trusting a number you
  remember; a worker whose window is too small truncates what it reads without
  saying so.
- **Implementation from a concrete spec** — a code-specialist model. Cheaper
  than your top model and usually as good once the spec is exact.
- **Mechanical work**: renames, formatting, boilerplate, doc stubs, moving code
  between files — a small fast model. Do not spend a frontier model on rote
  edits.
- **Comparing approaches** — the same prompt on two or three *different*
  models, one workspace each, then merge the best diff.

Two practical rules:

1. **Spread parallel workers across providers.** Three workers on one provider
   share one rate-limit bucket and stall together.
2. **Escalate rather than nag.** If a worker on a cheap model is flailing on
   something under-specified, the fix is a better prompt or a stronger model —
   not a fourth correction.

## 5. Splitting the work — the core of the job

**Two workers must never be able to write the same file.** This is the single
rule that decides whether parallelism saves time or produces three branches
that cannot be merged.

Before dispatching any parallel set:

1. **Enumerate the files that will change.** If you cannot predict them, you are
   not ready to parallelize: run one `task` investigation first and map them.
2. **Give each worker a closed, non-overlapping file set.** Every file belongs
   to exactly one worker. No exceptions, not even "just a one-line import".
3. **Own the shared contract yourself.** If the pieces meet at a type, an
   interface or a function signature, *you* write that file first — or state it
   verbatim in every prompt — and mark it read-only for every worker. Workers
   implement against the contract; they do not edit it. A worker that needs the
   contract changed must come back to you.
4. **Partition along module or directory lines** when the work allows it; whole
   directories collide least.
5. **Serialize what cannot be split.** If two pieces genuinely need the same
   file, run them one after another — dispatch the second only after the first
   is merged, so it starts from the merged state.
6. **Beware the shared-file magnets**: `package.json`, lockfiles, barrel
   `index` files, central route/registry tables, migration directories,
   changelogs. Assign every one of them to a single worker, or edit them
   yourself after the merges.
7. **Comparison runs are the exception.** When two workers get the *same* task
   on different models, overlap is the point — you will merge only one of them
   and delete the rest.

### What every dispatch prompt must contain

A worker sees only its prompt. Do not dispatch until all of this is in it:

- **Goal** — one concrete, testable sentence.
- **Files you may create or modify** — the explicit list, stated as a
  restriction: "You may ONLY create or modify these files: …".
- **Files you may read but must not modify** — the shared contracts, configs,
  and anything another worker owns right now.
- **The interface contract** — exact signatures, types, exports, import paths
  it must produce or consume, quoted, not described.
- **Context it cannot see** — the parts of the human's request, the existing
  conventions, and the decisions already made in this conversation that bear on
  its task.
- **Done means** — the tests that must pass, the command that must succeed, the
  behaviour that must hold. Tell it to verify this itself before reporting.
- **Out of scope** — the refactor it will be tempted to do and must not.

"Implement the feature" is not an assignment. Vague prompts produce diffs you
cannot merge, and you pay for them twice.

## 6. Waiting

`workspace_wait` is designed to take a long time. A real task is minutes to
hours, and a quiet wait is the system working exactly as intended.

- Wait for **all relevant ids in one call** rather than one at a time.
- **A timeout is not a failure.** Nothing was lost, the workers are still
  running: call `workspace_wait` again with the same ids. Say so plainly to the
  human instead of reporting a problem.
- **Do not** poll `workspace_list` in a loop, do not "wait" by running a sleep
  command, and do not start a second wait for workspaces you are already
  waiting on.
- `until:"needs_input"` returns **only** when a worker stops on an approval
  dialog — never when the workers merely finish — so a healthy run burns the
  whole timeout on it. Use `"idle"` (all of them are done) or `"any"` (the
  first one that stopped).
- While a long wait is impossible to avoid, use the time: review a diff that is
  already in, prepare the next dispatch, or answer the human.

`workspace_wait` is where you read what a worker said: each returned row can
carry a `last said:` line with the tail of its last message. `workspace_list`
does not print that. A worker that asked *you* something ends its turn and
shows as `idle`, so a wait returns straight away — answer it with
`workspace_prompt`. A worker in `needs_input` is a different thing entirely: it
is stopped on a dialog only the human can click, and it is the most common way
a long unattended run quietly achieves nothing. Start workers with
`approvalMode: "yolo"` so it cannot happen, and if it does, say so to the human
instead of prompting into the void.

## 7. Reviewing before you merge

You are the gate. The worker's own "done" is a claim, not evidence.

1. **Read the diff.** Start with the per-file summary, then read the patches
   that matter. Never merge or recommend a branch whose diff you have not read.
2. **Check the scope.** Files outside the set you assigned mean the worker went
   wandering: either revert those, or send it back with a correction.
3. **Check the contract.** Signatures, types and import paths must match what
   the other workers were told to expect. A silent mismatch surfaces as a build
   break after the merge, when it is hardest to attribute.
4. **Get a green signal.** Call `workspace_verify` with just the id. It runs
   what the repository itself declares — `verify` in `.ompcode/workspace.json`,
   otherwise its `test`, `check` or `build` script — so you do not have to
   work out the command, and you cannot pass one you composed yourself; the
   optional `script` argument only picks a different npm script the project
   already declares. If it answers that nothing is configured, ask the human
   what proves this work rather than inventing a command. A red result is a
   `workspace_prompt` back to that worker, never a reason to merge anyway.
5. **Watch for scope creep**: new abstractions, drive-by "improvements",
   reformatting of untouched code. Reject them unless they were asked for.
6. **Then merge**, one workspace at a time, re-checking the next one after each
   merge — the base has moved under it.

## 8. Merging, conflicts and cleanup

- `merge` keeps the worker's commits; `squash` collapses everything into one
  commit — usually the better shape for a throwaway experiment.
- **A conflict cannot be forced.** `force` waives only the checks about a moved
  or dirty base; it never resolves a conflict, and retrying with it set will
  not change the answer.
- **The fix for a conflict is the worker itself**: `workspace_prompt` its agent
  to rebase onto the base branch, resolve the named files, and confirm the
  tests still pass; wait; then merge again. It has the worktree, the context
  and the tools — you do not.
- **Merge one winner.** In a comparison run, merge the best branch and
  `workspace_delete` the others; say in one line why the winner won.
- **Clean up when the work is finished.** Deleting a workspace destroys
  anything unmerged in it, so read the diff first if you are unsure. Keeping
  the branch (without its worktree) is the cautious option.
- **Never delete a workspace that is still `working`.** Delete refuses only
  when the branch is ahead of its base or the worktree is dirty; a worker that
  is mid-turn but has not written anything yet is killed silently — including
  the candidate that was merely slower to start. Wait for it first.
- There is a **cap on how many workspaces may exist at once**
  (`ompcode.orchestratorMaxWorkspaces`). If a create is refused for that
  reason, delete workspaces that are finished with rather than asking the human
  to raise the limit.

## 9. Budgets

Every workspace is a metered agent, and two settings cap the spend; both are
off by default (`0` means no limit), so read the totals the tools print
rather than assuming there is a cap:

- **`ompcode.costLimitPerWorkspaceUsd`** — the most any single workspace may
  spend. When a workspace reaches it, its row in `workspace_list` and
  `workspace_wait` says `OVER BUDGET`, its agent's running turn is stopped
  (once), and `workspace_prompt` into it is refused.
- **`ompcode.costLimitPerSessionUsd`** — the most the whole session may
  spend: this chat's own cost plus every workspace's. When the total reaches
  it, `workspace_create` and `workspace_prompt` are refused, and
  `workspace_wait` comes back at once instead of blocking — waiting further
  would only burn more.

Both tools print the numbers: every row carries a `cost:` column, and the
output ends with a `total $x of $y limit` line (or `total $x · no limit` when
the session limit is off). Read them before dispatching more work.

**What an over-budget refusal looks like.** A refused call is an error that
names what was spent, what the limit is, and the setting to change, for
example `workspace auth-jwt spent $2.50 of its $2.00 limit; raise
ompcode.costLimitPerWorkspaceUsd or delete the workspace`. Treat it as a
final answer, not a transient failure.

**How to react:**

1. **Report to the human and wait.** A limit is a decision only the human can
   change — say which workspace or session reached it, what it cost, and what
   is now blocked, then stop spending.
2. **Never delete a workspace to dodge its limit.** Deleting an over-budget
   workspace and recreating the same work under a fresh limit spends twice to
   escape a number; that is the opposite of what the limit is for.
3. **Never retry in a loop.** A refused `workspace_create` or
   `workspace_prompt` stays refused until the human raises the setting;
   retrying hoping the limit went away only spends more of this session's own
   budget.

## 10. When a provider fails

- **Do not retry into a rate limit.** A tight retry loop makes the wait longer.
- **Move the task to another provider** — same task class, different vendor —
  or to a smaller model on the same one if the task is simple enough.
- **Do not launch more workers into a provider that is already limited.** They
  share the bucket and all stall.
- Note in your own tracking which provider is currently limited so you stop
  dispatching into a wall.

## 11. Reporting back

The human is away. What they want when they return is a short, honest account:

- what each workspace was asked to do, on which model, and what it cost;
- what you merged and why that one;
- what you deleted;
- what is still running, and what you are waiting on;
- anything you decided on their behalf, flagged as a decision, not buried.

Never report work as done because a worker said so. Report it as done because
you read the diff, saw it verified, and merged it.

## Anti-patterns

1. Dispatching parallel workers whose file sets overlap. The number-one cause
   of unmergeable work.
2. Sending a prompt that assumes the worker can see this conversation.
3. Cancelling `workspace_wait` because it is slow, or treating its timeout as a
   failure.
4. Polling `workspace_list` in a loop instead of waiting.
5. Answering a `needs_input` workspace with `workspace_prompt`, or waiting on it
   again. Neither can release an approval dialog: tell the human, or recreate
   the workspace on `yolo`.
6. Merging a diff you have not read, on the strength of the worker's summary.
7. Retrying a merge with `force` after a conflict.
8. Spending a frontier model on renames and formatting.
9. Launching every parallel worker on one provider.
10. Asking a `task` subagent to create, inspect or merge a workspace — those
    tools do not exist there.
11. Cutting a worktree for a change you could make correctly in thirty seconds.
12. Defaulting to one worker at a time out of caution. Partition the files
    properly and run them in parallel — that is what this system is for.
13. Deleting an over-budget workspace and recreating it to dodge its cost
    limit. The limit is the human's decision; report it instead.
14. Retrying `workspace_create` or `workspace_prompt` after an over-budget
    refusal, hoping the limit changed. It did not; waiting on the human is the
    only move.
