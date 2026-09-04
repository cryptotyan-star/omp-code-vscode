# Changelog

All notable changes to OMP Code. Versions follow [semantic versioning](https://semver.org/).

## [Unreleased]

### Added

- **A Processes board watches the whole race at once.** The new `Processes`
  panel in the OMP Code sidebar draws the orchestrator and every workspace as
  one row each: a state stripe along the top edge (violet filling as the
  pipeline moves through создание → работа → diff → verify → merge, green when
  merged, dark red on error, dashed gray while the agent waits for an answer),
  five ticks for the pipeline stages, the elapsed clock, and the live cost of
  every row. A workspace that crosses its cost limit stands out in dark red
  with a «лимит» label instead of silently going idle. Clicking a row brings
  its chat to the front, and hover actions stop or delete the workspace behind
  it — the same commands the `Sessions` view runs. The footer keeps the
  session total, and it turns red the moment the total crosses the session
  limit.
- `ompcode.costLimitPerWorkspaceUsd` and `ompcode.costLimitPerSessionUsd`
  (both default `0`, meaning no limit) cap what a single workspace, and what
  the orchestrator plus all of its workspaces together, may spend. A
  workspace that reaches its limit has its current turn stopped — the
  worktree, the branch and everything already written stay untouched — and
  hitting the session limit makes the orchestrator refuse to start or prompt
  further work until the limit is raised. Both settings are read live, so
  raising one takes effect on the next tick without reloading the window.

- **Every workspace gets its own terminal, and the board shows whose server
  is whose.** `Open Terminal` on a workspace row now opens a terminal pinned
  to its worktree — branch icon, `OMPCODE_WORKSPACE_ID` in the environment —
  and pressing it again brings the same terminal back instead of stacking
  shells. `Run Configured Commands` executes the `run` list from
  `.ompcode/workspace.json` there: everything before the last command is a
  prep step whose failure stops the run, the last one is the dev-server slot
  and is left running. A port scanner walks each workspace's process tree
  and puts what it finds on the row — three agents, three dev servers, and
  `⇡ 3000` says which is whose. The globe action opens the port through
  `asExternalUri`, so it lands on the right machine under Remote-SSH too.
  Scanning idles down to a 30-second cadence when nothing changes and wakes
  back up the moment a terminal opens or closes; `ompcode.portScan` turns it
  off, `ompcode.portScanIgnore` (default `[22, 80, 443]`) names the ambient
  listeners it should never show.
- **The chat runs the workspaces itself.** The main chat now holds the same
  workspace controls the operator has — create one on a named model, prompt it,
  wait for it, read its diff, merge the one that won, delete the rest — as
  tools it can call. One sentence is the whole instruction: "try this on GLM
  and on Sonnet, then show me both diffs" cuts two worktrees, starts two
  agents, waits for both, and comes back with the diffs. What the model creates
  is an ordinary workspace: the same rows appear on the `Sessions` board and in
  `Review`, with the same merge behind them, so anything the agent starts can
  be taken over by hand at any point. `workspace_wait` really does wait —
  several calls run at once, and cancelling the turn cancels them — so a chat
  sitting quiet for ten minutes is the agent watching its workers, not a
  stalled one.
- Only a top-level chat gets those tools. A workspace's own agent never does,
  whatever `ompcode.orchestratorTools` says: a worker that could create workers
  would fork worktrees until the disk filled.
- `OMP Code: Workspace Orchestration Status` prints what the chat sees —
  every workspace with its branch, model, state, cost and churn — into the
  `OMP Code` output channel, so "the model says it is still working" and "the
  board says it went idle" can be told apart.
- `ompcode.orchestratorTools` turns the whole thing off; workspaces then stay
  something you drive by hand from the `Sessions` view. The tool list is
  declared once at agent startup, so changing it restarts the running agents.
- **An operating manual for the chat that runs the workspaces.** Having the
  tools is not the same as using them well: the failure that costs a whole
  unattended night is two workers editing one file, or a worker left standing
  in `asks` because nobody answered it. `OMP Code: Install the Orchestrator
  Instruction` writes that manual into the repository as
  `.omp/agents/orchestrator.md` — how to split files between workers so their
  branches still merge, what belongs in a prompt an agent reads with none of
  your conversation in front of it, which model class each kind of task is
  worth, why a long `workspace_wait` is progress and not a hang, and what to
  read before merging. It is a copy, meant to be edited: trim the model
  routing, add the project's own conventions, and the next extension update
  will not overwrite it. Since only a top-level chat has the workspace tools,
  the command also hands you the one line to put in `AGENTS.md` that points
  the main chat at the file.
- `ompcode.orchestratorMaxWorkspaces` (default 5) caps how many workspaces may
  exist at once. Each one is a full checkout on disk and a metered agent in
  memory, and a model that starts workers faster than it finishes them should
  meet a limit that names itself rather than a full disk. The ceiling is
  counted one create at a time, so three `workspace_create` calls fired in the
  same turn cannot all read "four of five" and all pass. Changing the number
  no longer restarts the running agents — it is the natural thing to do right
  after a create was refused, and killing five live turns to make room for a
  sixth is not a trade anyone would take.
- **The workspace tools are safe to hand an unattended model.**
  `workspace_verify` runs only what the repository itself declares — the
  `verify` list in `.ompcode/workspace.json`, else a `test`/`check`/`build`
  script — or one npm script named by the model; there is no free-form
  command, so nothing the model composes reaches a shell. A workspace it
  creates defaults to the unattended approval tier rather than the window's,
  because a worker nobody is watching cannot answer a modal and would deadlock
  on its first edit; and if one does stop on an approval dialog, the tools now
  say plainly that a human has to clear it instead of sending the model to
  prompt at a worker that cannot hear it. `workspace_delete` refuses an agent
  that is still mid-turn unless forced — a worker that started slower is
  `ahead: 0` on a clean worktree, and git cannot tell it apart from an empty
  leftover. A `workspace_verify` that hangs is now always killed and always
  answers: the tree gets SIGTERM, then SIGKILL, then a hard deadline that
  reports the timeout even when a survivor is still holding the output pipes.
- A workspace that has been asked something but has not started streaming yet
  reads as `working`, not `idle`. `workspace_wait` on a freshly created
  workspace used to settle in that gap and report a worker "done" with nothing
  on disk.

### Fixed

- **Reloading the window no longer closes every chat.** `Developer: Reload
  Window` used to take the chat tabs with it: they are webview panels, and VS
  Code discards a persisted panel unless something claims its view type. A
  serializer now claims `ompcode.chatTab`, and the tab comes back as it was —
  the same folder, the same model the tab was pinned to, and, through
  `switch_session`, the same conversation rather than a blank one. A workspace
  tab is rebound to its workspace record, so its branch, model and approval tier
  return with it. Each tab keeps only an id in its webview state; the rest lives
  in `workspaceState` beside the workspaces. A tab whose workspace was deleted
  while the window was down is not resurrected in a directory that no longer
  exists — it says so and closes.

## [0.14.0] — 2026-08-31

### Added

- **Review: see what each agent wrote, merge the one that won, delete the rest.**
  Three agents on three models in three worktrees produce three branches, and
  until now the only way to compare them was three terminals and a lot of
  `git diff`. A new `Review` view lists every workspace with the size of what it
  changed — `⎇ omp/glm · +412 −38 · 17 files` — and expands into its changed
  files, new and uncommitted ones included: a file the agent created but never
  committed is invisible to plain `git diff`, and the count here goes looking
  for it instead of silently reporting zero. Nothing in the agent's worktree is
  touched to find out — no `git add -N`, which would write to the index of a
  checkout an agent is working in right now. Every diff is taken against the
  commit the workspace was cut from, so two workspaces created an hour apart
  stay comparable even as the base branch moves. Clicking a file opens a normal
  side-by-side diff against that base commit, read-only on the left; a workspace
  row opens all of its files as one multi-file diff. Counting is lazy and
  cached — a workspace is only measured once you expand it, then recounted when
  its worktree actually changes, debounced so an agent mid-edit cannot spawn git
  faster than it finishes. `ompcode.reviewAutoRefresh` turns the watching off on
  a repository big enough to care.
- **Merging a workspace, without the parts that lose work.** `Merge workspace`
  asks for a merge commit or a squash, then checks whether the branch can land
  before it changes anything: whether the two sides conflict (asked of git
  directly, in a scratch index — no test merge in your checkout, no grepping
  files for `<<<<<<<`), whether the main checkout is dirty, whether the base has
  moved since the workspace was cut, whether the worktree still holds
  uncommitted work. Blockers are shown as a list of what is in the way and what
  the merge would do about it, and `Merge anyway` is offered only for the ones
  that can be worked around — never for a conflict. The merge itself commits the
  worktree's loose changes to its own branch first (otherwise they simply would
  not be merged), stashes and restores anything uncommitted in the main
  checkout, and refuses to rewrite the base branch's history: a squash lands
  through `merge --ff-only`, and a rebase that hits a conflict is aborted, not
  left half-applied. On success it offers to delete the workspace that won and
  the ones that lost — `Delete the other workspaces` clears the rest of the race
  in one confirmation. A single file can be rewound to the base on its own,
  which is how a mostly-good branch gets merged without the one file the agent
  ruined. The main checkout is put back on the branch it was standing on when
  you started, and the stash is restored onto *that* branch rather than onto
  the base; whatever the merge did — a worktree committed, a stash still held,
  a merge that could not be aborted — is named in the notification instead of
  being flattened into "done"; cancelling the progress notification stops the
  merge without cancelling its own cleanup; a worktree that is not standing on
  its branch is refused rather than committed to a dangling commit; and
  discarding a renamed file brings the old name back, which is what the dialog
  promises.
- **Workspaces: every agent gets its own checkout.** Two agents told to work at
  once in the same folder overwrite each other's edits, fight over the build
  output and leave a `git status` nobody can read. A workspace is a git worktree
  plus its own branch plus its own omp process: `New Workspace` asks for a name,
  a base branch, a model and an approval mode, cuts `omp/<name>` from the base,
  drops the worktree in `<repo parent>/<repo name>.worktrees/` — outside the
  repository, so watchers and builds in the main checkout never see it — and
  opens a chat already pointed at that folder. The base commit is pinned at
  creation, so a diff stays a diff even after the base branch moves on.
  Model and approval mode are per workspace, not per window: one workspace can
  run a cheap model with full shell access while another runs a careful one that
  asks before every write, and changing the global setting no longer restarts
  the sessions that overrode it. The session board grows a `Workspaces` group
  above `Chats`, each row showing its branch, model, status and cost, with the
  session's subagents underneath; rows carry reveal, terminal and delete
  buttons, and delete says what it is about to throw away — uncommitted files,
  commits that exist nowhere else — before it removes the worktree. Workspaces
  survive a VS Code restart: the record remembers the last session file and
  reopening resumes that conversation. Records whose worktree was removed
  outside the extension are reconciled against git and dropped.
- **Setup scripts, so a fresh worktree can actually run.** A new worktree has no
  `node_modules`, no `.env` and no build output, so the agent would start in a
  project that does not build. `.ompcode/workspace.json` declares `setup`,
  `teardown` and `run` command lists; a repository that already carries
  `.superset/config.json` is read as-is, the schema is the same. Commands run in
  a terminal in the worktree through shell integration, so their exit code is
  known rather than guessed, and `.ompcode/workspace.local.json` adds `before`
  and `after` hooks that stay out of version control. `ompcode.workspaceSetup`
  chooses whether that happens automatically, on confirmation, or never.

- **Subagents are visible.** omp has always been able to fan a turn out across
  subagents — each on its own model, sometimes its own provider — but the extension
  dropped every frame that reported them, so a running fleet looked like one stalled
  chat. The session board now hangs the subagents under their session with the model
  each resolved to, the tool it is running, its cost and its token count, and the chat
  draws the same rows inside the parent `task` card. A row opens that subagent's own
  JSONL transcript. Progress arrives dozens of times a second per agent, so the host
  coalesces it to at most four snapshots a second before it reaches the webview or a
  paired phone; lifecycle changes are forwarded at once. Subagents run auto-approved
  whatever the session's approval mode is, and the rows say so rather than leaving it
  to be discovered. `ompcode.subagentSubscription` turns the stream down or off.

- **GLM on a pay-as-you-go key, alongside the Coding Plan.** The GLM row the extension
  already had is the Coding Plan subscription; this one is an open-platform key from
  bigmodel.cn, billed per token against your balance. Both can be configured at once,
  and the picker groups them separately with ten GLM models (4.5 through 5.3) priced
  from omp's catalog. omp has no env var for the platform endpoint
  (`open.bigmodel.cn/api/paas/v4`), so this key is written into
  `~/.omp/agent/models.yml` at spawn and taken back out when it is cleared — a keyless
  block fails validation, and omp answers that by disabling every custom provider in
  the file.

- **A settings window, instead of a settings menu.** The gear held accounts, keys,
  models, three Remote Control commands, five session actions and diagnostics in one
  dropdown. It opens a full-screen window now — the same window in VS Code and on the
  phone, grouped into Accounts and keys, Models, Remote Control, This chat and
  Diagnostics, with every row saying what it actually does. Three ways out: the close
  button, Escape, and Android Back. The window sits above the modal layer, so a queued
  approval reclaims the screen rather than waiting invisibly underneath it.
- **ChatGPT, by subscription or by key.** `ChatGPT Plus/Pro` signs in through the
  Codex subscription flow, and `OPENAI_API_KEY` joins the keyed providers, so the API
  key is settable from the API-keys card and from the command palette like every
  other one. The subscription flow is desktop-only for the same reason as GLM and
  Qwen: it comes back on a loopback callback port.
- **Sign in to GLM and Qwen.** The settings window offers four subscriptions now:
  Claude Pro/Max, Kimi Code, GLM Coding Plan (Z.AI) and Qwen Portal. One registry in
  `src/providers.ts` decides which flows exist, and the host refuses any id the UI
  never offered. GLM and Qwen are desktop-only on purpose: Z.AI answers on a loopback
  callback port and Qwen hands back a token to paste, so both need the browser on the
  machine running the agent — a phone would reach a dead end, and the remote link
  refuses them for the same reason.
- **One-press pairing to every open project.** `Connect a phone — all sessions` skips
  the grant picker and grants exactly the all-sessions scope, which never includes
  credential access. The picker stays for the narrower and the wider choices.
- **A pairing QR can be refreshed.** A QR lives ten minutes, and missing that window
  used to mean walking back through the grant prompt. `OMP Code: Refresh Remote Pairing
  QR` — also a link in the Remote Control panel and `/remote-qr` in the chat — mints a
  fresh one-time secret inside the room that already has the consent: same room, same
  key epoch, same scope, same frozen workspace roots. Refreshing while a phone is
  already enrolled hands the room to whoever scans next, so that case is confirmed
  first. The panel now says when the code stops working, and says so when it has.

### Fixed

- **The Android phone showed an empty screen instead of the chat.** Android WebView
  resolves every viewport-height unit — `vh`, `dvh`, `svh`, `lvh` — to zero while its
  layout height is unconstrained, and Compose's `AndroidView` hands the WebView exactly
  that kind of layout. `#app` was sized in those units, so with `overflow: hidden` the
  whole UI collapsed to nothing: only the native drawer button stayed on a bare
  background. Measured on WebView 150: `100dvh` came back as `0px` against a real 866px
  viewport, which also zeroed the `max-height` of every popover, menu and modal sheet.
  The renderer now takes its height from the pixel viewport it already publishes
  (`--app-vh`) with `100%` as the floor, and the WebView is mounted in a container that
  states its size, so the units work again too. Verified from 356×515 CSS px (folded
  cover screen) up to 1280×800.
- **A dead renderer is no longer a dead screen.** A lost WebView render process left an
  empty panel with no message and no way back, because the crash callback was never
  wired. The renderer is now rebuilt in place, the session on the computer is untouched,
  and the sessions drawer has an explicit "Reload chat view".
- **Modal state reached the native shell only once the WebView was attached.** It is now
  delivered on the main looper instead of the view's run queue, so an approval dialog
  cannot strand the phone's Back handling.

## [0.7.0] — 2026-08-22

### Added

- **`revert` on every edit card.** The before-snapshot each edit/write tool call already
  carries is now actionable: one click writes it back, or deletes a file the agent
  created. Refuses while the file is open with unsaved changes; a snapshot is one-shot.
- **Route one prompt through another model.** The model menu arms a `route:` chip in the
  composer; the next prompt alone goes through the picked model, then the session snaps
  back. A failed switch means the prompt is never sent, and an interrupted turn restores
  the original model on the next one.
- **The Sessions board.** A sidebar view listing every running chat with model, state
  (working / waiting for approval / idle) and session cost, plus stop and close per row.
- **Android Remote Control.** Pair a companion phone with a short-lived QR and continue
  the same active desktop `omp` sessions through an outbound, end-to-end encrypted relay.
  Desktop-selected capabilities scope sessions, settings and credentials; durable
  counters, ACK-windowed resync, revocation and remote process leases cover reconnects.

## [0.6.0] — 2026-08-20

### Added

- **The profile inspector edits two of its fields in place.** Clicking `thinking` or
  `tool access` opens the list of values that field accepts, and choosing one writes a row
  into `ompcode.modelProfiles` for that family. A field the user has overridden also
  offers "reset to the built-in value", which prunes the key — and the row with it, once
  nothing is left — so the inspector stops claiming the value came from your settings.

  Only these two are editable, because both are scalars with a closed set of values: the
  menu can offer every legal one and cannot produce an illegal one. The overlay bag, the
  instruction file and the note stay in settings.json, reachable from the same menu.

  This is not the `think:` / `access:` chips in another shape. Those steer the current
  session; a profile is a standing rule for every model of the family, which is why the
  agent restarts to pick the change up — warmly, with the conversation reattached.

### Fixed

- **`off` was offered as a thinking level for models that cannot turn reasoning off.**
  A variable rename in 0.5.0 left the check reading a property off the translation
  function instead of the model descriptor; a missing property is not an error, so it
  silently read as "reasoning is optional". The test suite now refuses any source file
  that shadows `t` or reads a property from it.

## [0.5.0] — 2026-08-20

### Added

- **English and Russian interface.** New `ompcode.language` setting (`auto` | `en` | `ru`),
  independent of the VS Code display language — an English editor can hold a Russian chat
  with no Language Pack. Command titles and setting descriptions still follow VS Code
  itself, because it resolves those before the extension loads.
- `npm run dist` builds the hand-out archive (`.vsix` plus sources) reproducibly.

### Changed

- **The extension id changed** from `local.omp-code` to `cryptotyan-star.omp-code`, because
  the old publisher was a placeholder. VS Code identifies an extension by
  `<publisher>.<name>`, so this installs *alongside* an earlier build rather than
  upgrading it: two copies means two icons in the editor title bar and every command
  listed twice. Remove the old one with
  `code --uninstall-extension local.omp-code`, then reload the window.

  API keys are the one thing that does not carry over — VS Code scopes Secret Storage per
  extension id, so they have to be entered again. Subscription sign-ins are unaffected;
  those credentials belong to the `omp` agent, not to the extension.

### Fixed

- **Windows: `omp` installed as a batch shim now starts.** A global install can leave
  `omp.cmd` rather than `omp.exe`, which `CreateProcess` cannot run — the launch failed in
  a way that read as "omp is not installed". The path is now resolved the way Windows
  resolves it (`PATH` × `PATHEXT`) and a `.cmd`/`.bat` is started through `cmd.exe`, with
  the command line quoted by the extension rather than by Node: a workspace path
  containing a space or an `&` would otherwise have broken the launch or run whatever
  followed it.
- **Diagnostics report the real reason a launch failed.** Any spawn failure, including the
  long-standing "binary not found" case, used to wait out the 60-second timeout and then
  blame a missing `ready` frame.

## [0.4.0] — 2026-08-20

### Added

- **Per-model profiles.** Selecting a model pulls in the working mode of its native
  harness — Claude behaves as in Claude Code, GLM as in ZCode, and so on. Profiles cover
  the family instruction file, per-tool access, and a settings overlay applied at spawn.
- Model-family badge in the composer with a read-only profile inspector showing what each
  value is and where it came from.
- Warm restart: changing a spawn-level setting reattaches the conversation instead of
  losing it, and a crashed agent restarts the same way.
- `ompcode.modelProfiles` setting for layering your own rows over the built-in ones.

## [0.3.4] — 2026-08-19

### Changed

- Removed the context percentage from the status bar; the composer warning covers it.

## [0.3.3] — 2026-08-19

### Fixed

- The context-fill warning fired at the wrong times — both never, after a fresh boot, and
  too eagerly once it did.

## [0.3.2] — 2026-08-19

### Added

- Per-model thinking levels and a tool-access picker in the composer.
- Context-fill warning replacing the raw percentage chip.
- GLM (Zhipu BigModel) and Qwen (Alibaba Coding Plan) API key support; keyed providers are
  driven from one table.

### Fixed

- A duplicate approval prompt left one dialog permanently occupying the modal slot.

## [0.2.0] — 2026-08-18

### Added

- Editor context in the composer, the edit-feedback loop (diff button and new-diagnostics
  notices), auto-restart, multi-root support, transcript export, session history search.

## [0.1.0] — 2026-08-16

- First working version: chat over `omp --mode rpc-ui`, model picker, API keys in Secret
  Storage, subscription sign-in, custom providers.
