# Contributing

Thanks for looking. This is a GUI on top of the [`omp`](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent)
CLI agent — the extension speaks NDJSON-over-stdio to `omp --mode rpc-ui` and renders the
result. It has no model logic of its own.

## Setup

```bash
npm install
npm run build      # esbuild -> dist/extension.js (does NOT typecheck)
npm test           # typecheck + the full test suite
```

You also need the agent itself, or nothing starts:

```bash
bun install -g @oh-my-pi/pi-coding-agent
```

Press `F5` in VS Code to launch an Extension Development Host with the extension loaded.

## Before opening a pull request

- `npm test` must pass. It runs `tsc --noEmit` first, so a type error fails the suite.
- Keep `npm run build` and `npm test` separate in your head: the build does not typecheck,
  which has bitten people before.
- New user-visible strings go through `t("…")`, with the English text as the key, and need
  a Russian entry in `l10n/ru.json`. The test suite fails on an untranslated string, on a
  translation whose source string is gone, and on a `{0}` placeholder mismatch — so you
  will hear about it rather than shipping a half-translated menu.
- New manifest strings (command titles, setting descriptions) are `%key%` placeholders
  resolved from `package.nls.json` and `package.nls.ru.json`. Same coverage test.

## Things that cost real time to rediscover

- **omp's default approval mode is `yolo`.** Omitting `--approval-mode` does not mean
  "ask" — it silently auto-approves reads, writes and shell commands. The flag is always
  passed.
- **Dotted keys in omp's settings are not universally honoured.** `tools.approval:` as a
  dotted key is silently ignored; the nested form is enforced. `src/profileOverlay.ts`
  expands dotted keys into nested ones for exactly this reason.
- **Approval dialogs already exist** in the webview (`onUiRequest` → `showModal` →
  `respondUi`). Adding a second card produces two dialogs for one approval and wedges the
  modal slot.
- **`contextUsage.percent` is already 0–100.** Multiplying by 100 turns 0.9% into 90%.
- **`t:"state"` does not arrive during a conversation** — only at init and on a
  model/thinking/session change. The per-turn signal is `agent_end`.
- **Session transcripts are the ground truth** for "did the agent actually answer":
  `~/.omp/agent/sessions/<slugged-cwd>/*.jsonl`.
- **The webview modules are ES modules under a nonce.** Two `<script type="module">` tags
  do not share globals; anything used across them must be imported. A missing import
  shows up as "the model never answers", because the error is swallowed by the
  host-message handler. `test/webviewWiring.test.ts` guards this.

## Reporting a bug

Run **OMP Code: Run Diagnostics** from the command palette and attach the report. It shows
the resolved binary path, `omp --version`, which providers hold a credential, which models
the agent offers, and the last verification verdicts — with no key values in it.
