# Changelog

All notable changes to OMP Code. Versions follow [semantic versioning](https://semver.org/).

## [Unreleased]

### Added

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
