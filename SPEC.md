# OMP Code — VS Code extension spec

VS Code extension: Claude Code–style chat GUI in the sidebar, backed by the `omp` CLI
(oh-my-pi, installed at `~/.bun/bin/omp`) running in `--mode rpc-ui` (NDJSON over stdio).
User configures custom model providers (e.g. "akemi") and Anthropic Cloud API.

**Language:** extension host = TypeScript (strict), bundled with esbuild to `dist/extension.js` (cjs, external: `vscode`).
Webview = plain vanilla JS/CSS in `media/` (NO frameworks, NO TypeScript, NO imports — single files).
Dependency: `yaml` (bundled). devDeps: `typescript`, `esbuild`, `@types/vscode` (^1.85), `@types/node`.

## File tree (each builder owns ONLY its listed files)

```
package.json  tsconfig.json  esbuild.mjs  .vscodeignore  README.md  media/icon.svg   ← builder A
src/extension.ts  src/ompProcess.ts  src/chatViewProvider.ts  src/modelsSync.ts
src/attachments.ts                                                                    ← builder B
media/main.js                                                                         ← builder C
media/main.css                                                                        ← builder D
```

## package.json (builder A) — exact contributions

- name `omp-code`, displayName `OMP Code`, publisher `local`, version `0.1.0`, engines.vscode `^1.85.0`,
  main `./dist/extension.js`, activationEvents: `onView:ompcode.chat`.
- viewsContainers.activitybar: id `ompcode`, title `OMP Code`, icon `media/icon.svg`.
- views.ompcode: `[{ "type": "webview", "id": "ompcode.chat", "name": "Chat" }]`
- commands:
  - `ompcode.newSession` — "OMP Code: New Chat Tab" (icon `$(add)`)
  - `ompcode.setAnthropicKey` — "OMP Code: Set Anthropic API Key"
  - `ompcode.setKimiKey` — "OMP Code: Set Kimi (Moonshot) API Key"
  - `ompcode.setGlmKey` — "OMP Code: Set GLM (Zhipu BigModel) API Key"
  - `ompcode.setQwenKey` — "OMP Code: Set Qwen (Alibaba Coding Plan) API Key"
  - `ompcode.loginClaude` — "OMP Code: Sign in with Claude (Subscription)"
  - `ompcode.loginKimi` — "OMP Code: Sign in with Kimi Code (Subscription)"
  - `ompcode.openModelsConfig` — "OMP Code: Open models.yml (Custom Providers)"
  - `ompcode.restart` — "OMP Code: Restart Agent"
- menus.view/title: `ompcode.newSession` (group navigation) when `view == ompcode.chat`.
- configuration (`ompcode.*`):
  - `ompPath` string, default `omp`
  - `customProviders` object, default `{}` — same shape as models.yml `providers:` map, e.g.
    `{"akemi": {"baseUrl":"http://host:8000/v1","api":"openai-completions","apiKey":"sk-...","models":[{"id":"akemi-1","name":"Akemi","contextWindow":128000,"maxTokens":32000}]}}`
  - `defaultModel` string, default `""` — `"provider/modelId"` fuzzy, applied via `set_model` after start
  - `thinkingLevel` enum `["off","minimal","low","medium","high","xhigh","max","auto"]` default `"auto"`
  - `approvalMode` enum `["always-ask","write","yolo"]` default `"always-ask"` → passed as `--approval-mode`
  - `hideStartupNotices` boolean, default `true` — drop omp's plumbing notices (`xd://: mounted …`, `inspect_image is now hidden …`); warnings/errors always shown
  - `verifyModels` boolean, default `true` — probe every model with one live request and offer only the ones that answer (see "Model verification")
  - `theme` enum `["violet","coral","emerald","amber","magenta"]` default `"violet"` — accent palette; applied live (`pushTheme()`), never restarts the agent
  - `accentColor` string, default `""` — custom CSS color overriding the palette accent; invalid values are ignored with a toast
- scripts: `build` = `node esbuild.mjs`, `watch`, `package` = `vsce package`.
- esbuild.mjs: bundle `src/extension.ts` → `dist/extension.js`, platform node, format cjs, external `["vscode"]`, minify off, sourcemap.
- media/icon.svg: neutral 24×24 monochrome asterisk/spark (✳ shape, `currentColor`). NOT the Anthropic logo.
- README.md: install (`bun install -g @oh-my-pi/pi-coding-agent`), configuring Akemi provider + Anthropic key, usage. Russian + English short.

Spawn: `<ompPath> --mode rpc-ui --cwd <workspaceFolder>` (cwd = first workspace folder, else home).
Env: inherit process.env + `ANTHROPIC_API_KEY` from SecretStorage key `ompcode.anthropicApiKey` (if set) and `MOONSHOT_API_KEY` from `ompcode.moonshotApiKey` (if set). For OAuth login when no key is set, the host injects a placeholder `ANTHROPIC_API_KEY="sk-ant-placeholder-for-oauth-login"` so the static catalog loads; it is replaced by a clean restart after login.
Add `~/.bun/bin` to PATH in env if not present. Also pass `--approval-mode <cfg>` when cfg ≠ "always-ask".

stdin: one JSON command per line. stdout: one JSON frame per line (parse per line; ignore unparseable lines).
stderr: log to OutputChannel "OMP Code".

Commands host sends (all optionally carry `id` for correlation):
```
{id, type:"negotiate_protocol", protocolVersion:2}   // first, after "ready" frame
{id, type:"prompt", message, streamingBehavior?:"steer"}   // "steer" sent only while the host knows the agent is streaming (agent_start..agent_end, or state.isStreaming); omitted otherwise
{id, type:"login", providerId}   // OAuth sign-in ("anthropic" | "kimi-code"); open_url frame forwarded host-side
{id, type:"steer", message} {id, type:"abort"} {id, type:"new_session"}
{id, type:"get_state"} {id, type:"get_available_models"} {id, type:"get_available_commands"}
{id, type:"set_model", provider, modelId} {id, type:"set_thinking_level", level}
{id, type:"compact"} {id, type:"get_session_stats"}
{type:"extension_ui_response", id, value|confirmed|cancelled}   // reply to extension_ui_request, id = request id
```

Frames received:
- `{type:"ready", ...}` → then negotiate, then get_state + get_available_models + get_available_commands, then set_model for `defaultModel` (parse `provider/modelId` on first `/`; skip if empty) and set_thinking_level.
- `{id?, type:"response", command, success, data?|error}` — resolve pending request by id.
- `{type:"rpc_chunk", chunkId, index, count, data}` — reassemble: concat `data` of all parts in index order, then JSON.parse → handle as frame.
- Session events (no id): `agent_start`, `turn_start`, `turn_end`, `message_start {message}`, `message_update {message}`, `message_end {message}`, `tool_execution_start {toolCallId,toolName,args}`, `tool_execution_update {toolCallId,toolName,args,partialResult}`, `tool_execution_end {toolCallId,toolName,result,isError}`, `agent_end`, `notice {level,message}`, `auto_retry_start {attempt,maxAttempts,delayMs,errorMessage}`, `auto_retry_end`, `auto_compaction_start`, `auto_compaction_end`, `model_changed`, `available_commands_update {commands}`, plus others — forward ALL to webview.
- `{type:"extension_ui_request", id, method:"select"|"confirm"|"input"|"editor"|"notify"|"setStatus"|"setWidget"|"setTitle"|"set_editor_text"|"open_url"|"cancel", ...}` — forward to webview; `open_url` ALSO handled host-side via `vscode.env.openExternal`.

Message shapes (inside message_* frames):
- user: `{role:"user", content: string | [{type:"text",text}|{type:"image",...}], synthetic?, timestamp}`
- assistant: `{role:"assistant", content: Array<{type:"text",text}|{type:"thinking",thinking}|{type:"toolCall",id,name,arguments}|...>, model, errorMessage?, stopReason, usage}`
- toolResult: `{role:"toolResult", toolCallId, toolName, content:[{type:"text",text}|{type:"image",data,mimeType}], isError, timestamp}`
- `message_update` carries the FULL message so far (no delta assembly needed) — re-render in place.

Model shape (get_available_models → data.models[]): `{id, name, provider, api, baseUrl, contextWindow, maxTokens, cost?...}` — display `name`, group by `provider`.
State (get_state → data): `{model?, thinkingLevel, isStreaming, sessionId, sessionName?, autoCompactionEnabled, contextUsage?:{tokens, contextWindow, percent}, todoPhases, messageCount, ...}` — render the model chip. `contextUsage.percent` is already 0-100 (omp: `(usedTokens/contextWindow)*100`) and must NOT be rescaled; it is `0` when the window is unknown, so derive from `tokens`/`contextWindow` first and treat a missing window as "unknown", not "empty". Context fill is not a chip: it drives a one-shot notice at 50/75/90%, fed from `get_session_stats` after each turn because `get_state` is not pushed as a conversation grows.

## src/ompProcess.ts (builder B)

`export class OmpProcess extends (EventEmitter-like)`:
- `start(opts {ompPath, cwd, env, approvalMode})` — spawn, wire stdout line-splitter (buffer partial lines), rpc_chunk reassembly map, stderr→OutputChannel callback.
- `request(cmd: object): Promise<any>` — assign `id` (`r${n++}`), write line, resolve/reject on matching response frame (`success:false` → reject Error(error)); 60s timeout for most, NO timeout for `prompt`.
- `send(frame: object)` — fire-and-forget write (extension_ui_response, abort).
- `onFrame(cb)` — all non-response frames.
- `onExit(cb)` — code/signal; host shows status + restart button in webview (`proc-status` msg).
- `stop()` — kill.

## src/chatViewProvider.ts + src/extension.ts (builder B)

`ChatViewProvider implements vscode.WebviewViewProvider` for `ompcode.chat`:
- HTML shell: CSP (`default-src 'none'; style-src ${cspSource}; script-src 'nonce-…'; img-src ${cspSource} data:; font-src ${cspSource}`), links `media/main.css` + `media/main.js` via `asWebviewUri`.
- On `resolveWebviewView`: wait for webview `{t:"ready"}` → ensure OmpProcess started → replay nothing (fresh), send `{t:"boot", cfg:{defaultModel, thinkingLevel, theme, accentColor}}`.
- Bridge webview→host messages:
  - `{t:"prompt", text, attachments?}` → `composePrompt()` (src/attachments.ts) appends an
    `Attached files:` path list to the text, then send as `{type:"prompt", message, streamingBehavior:"steer"}`
    (host does NOT track streaming precisely; omp queues correctly).
  - `{t:"abort"}` → send abort
  - `{t:"newSession"}` → request new_session then get_state, forward
  - `{t:"setModel", provider, modelId}` / `{t:"setThinking", level}` → request, then get_state, forward state frame
  - `{t:"getModels"}` → request get_available_models → post `{t:"models", models}`
  - `{t:"getState"}` → request get_state → post `{t:"state", state}`
  - `{t:"getCommands"}` → request → post `{t:"commands", commands}`
  - `{t:"uiResponse", frame}` → send frame verbatim (must be `{type:"extension_ui_response", id, ...}`)
  - `{t:"openExternal", url}` → vscode.env.openExternal
  - `{t:"copy", text}` → vscode.env.clipboard.writeText (webview clipboard API is gesture-gated)
  - `{t:"login", providerId}` → OAuth sign-in, see "Subscription sign-in" below
  - `{t:"compact"}` → request compact
  - `{t:"restart"}` → stop + start, then **await `initDone`** (the handshake, not just the
    spawn) and post an info notice `Agent restarted — provider/modelId.`; failures report
    through the usual error notice
  - `{t:"pickFiles"}` → `showOpenDialog` (multi-select, rooted at the workspace folder) → `attachPaths()`
  - `{t:"attachPaths", paths}` → entries (plain paths or `file://` URIs) run through
    `parseUriList()`, then `fs.stat` → post `{t:"attached", files, rejected}`. Nothing is
    copied: the agent reads the file in place.
  - `{t:"attachData", token, name, mime, data}` → base64 bytes from the clipboard or an OS
    drag, capped at `MAX_ATTACHMENT_BYTES` (20 MB), written to
    `globalStorageUri/attachments/<stamp>-<safeFileName>` → post `{t:"attached", token, files, rejected}`
- Host→webview messages: `{t:"frame", frame}` (every event/ui_request), `{t:"models"|"state"|"commands", ...}`, `{t:"proc", status:"starting"|"running"|"exited"|"error", detail?}`, `{t:"boot", cfg}`, `{t:"authStart", providerId}`, `{t:"authDone", providerId, ok, detail?}`, `{t:"attached", files, rejected, token?}`, `{t:"theme", theme, accentColor}`.
- Notice filtering: when `ompcode.hideStartupNotices` is true (default), `handleFrame` drops
  info-level `notice` frames that `isNoisyNotice()` (src/notices.ts) flags — omp's plumbing
  reports, identified by `source` ∈ {xdev, vision, mcp, tools, startup} or by message shape
  (`xd://: …`, `inspect_image is now hidden/available …`). Warnings and errors always pass
  through; dropped notices are logged to the "OMP Code" output channel.

### Model verification (src/probe.ts)

omp lists every model of every provider it finds *a* credential for — a credential
being present says nothing about it being valid. One stale `MOONSHOT_API_KEY` in Secret
Storage produces 17 Kimi models that all answer
`401 Invalid Authentication (type=invalid_authentication_error)`.

`probeModels()` spawns a second, stripped-down agent
(`--no-session --no-tools --no-lsp --no-skills --no-rules --no-extensions --no-title
--thinking off --system-prompt "You are a connectivity check…"`) and, per model:
`new_session` → `set_model` → `prompt "ping"` → wait for `agent_end` (45s cap).
Failure signal is exact, not heuristic: `message_end` with `message.stopReason === "error"`
carries `errorStatus` + `errorMessage`.

- `planProbeOrder()` probes one representative per provider first (cheapest input price,
  then shortest id) so a dead subscription costs one request instead of seventeen.
- `isProviderLevelFailure()` condemns a whole provider **only** on 401 (or an auth-shaped
  message with no status). 403/404 belong to the single model — a Pro/Max subscription
  answers `404 not_found_error` for `claude-3-opus-20240229` while every current Claude
  model works, and that model must not take its 25 siblings down with it.
- Verdicts (`{ok, status?, detail?, checkedAt}` keyed `provider/modelId`) live in
  `globalState["ompcode.probeResults"]`, shared by all sessions, TTL 12h
  (`isCacheFresh`). One run at a time, guarded by `OmpSession.probeRun`.
- Host→webview `{t:"probe", results, running, enabled}` fires per verdict; the picker
  narrows progressively and stays fully populated while `running` so it is never empty.
  Menu footer: "Show all models (N hidden)" (failed entries render struck-through with
  their status) and "Re-check subscriptions" → `{t:"recheckModels"}`.

After a run the session also:
- posts a **warning notice** when the run produced zero verdicts (an empty run used to be
  indistinguishable from "the feature does nothing");
- offers to remove a stored key whose provider failed with 401 (`{t:"deadKey"}` →
  `.deadkey-card` → `{t:"clearKey", which}`), and lists the same action in the ⚙ menu;
- **switches off a dead model**: if the selected model failed, `set_model` moves to a
  passing one (same provider preferred) and says so in a notice — otherwise the first
  prompt after startup still hits the dead model.

Root-cause escape hatch: **OMP Code: Clear Stored API Key** removes a bad key from Secret
Storage (subscription sign-ins are untouched).

### Diagnostics (src/diagnostics.ts)

⚙ → "Run diagnostics" / **OMP Code: Run Diagnostics** renders a markdown report into a new
editor tab: resolved omp path + `--version`, whether `~/.bun/bin` made it onto PATH, the
*names* (never values) of injected API-key env vars, whether a session-less agent reaches
`ready` and `negotiate_protocol` (with its stderr tail when it does not), signed-in
providers from `get_login_providers`, the model list grouped by provider, the cached
verification verdicts, and the effective `ompcode.*` settings.

### Subscription sign-in (OAuth + device code)

`{t:"login", providerId}` → `OmpSession.loginProvider()`:
1. If the agent cannot start for lack of models, bootstrap it with a placeholder
   `ANTHROPIC_API_KEY` so the RPC surface exists.
2. Post `{t:"authStart", providerId}`, then send RPC `{type:"login", providerId}` — this
   request has **no timeout** (a device-code flow stays pending up to 30 min).
3. omp answers with `extension_ui_request {method:"open_url", url, launchUrl?, instructions?}`.
   The host opens `launchUrl ?? url`; the webview renders the sign-in card from the same
   frame. `instructions` carries the one-time user code for device-code providers
   (`kimi-code` → `"Enter code: A88O-X4DM"`), without which the browser page is a dead end.
4. On success: post `{t:"authDone", ok:true}` and restart the agent so it picks up the
   credential (stored by omp in `~/.omp/agent/agent.db`, table `auth_credentials`).
   On failure: `{t:"authDone", ok:false, detail}` plus an error notice.

Providers: `anthropic` (Claude Pro/Max, redirect flow), `kimi-code` (Kimi subscription,
device-code flow → models `kimi-code/k3`, `k3-256k`, `kimi-for-coding` on
`https://api.kimi.com/coding/v1`), plus `openai-codex`, `zai`, `github-copilot`, `cursor`.
- After process ready-init sequence: post state+models+commands proactively.
- extension.ts: activate → register provider (retainContextWhenHidden true via `webviewOptions`), commands:
  - newSession → post to webview `{t:"frame",frame:{type:"__newSession"}}`? NO — call provider.newSession() which does the RPC + notifies webview `{t:"reset"}`.
  - set*Key (one command per `KEYED_PROVIDERS` row in src/providers.ts) →
    `window.showInputBox({password:true})` → `context.secrets.store(p.secret, v)` → offer restart.
    `buildEnv()` injects each stored key as the row's `envVar`; the webview
    setup form renders from `{t:"keyStatus", keys, providers}` and saves via
    `{t:"setKeys", keys: {id: value}}`.
  - openModelsConfig → ensure `~/.omp/agent/models.yml` exists (create with commented template incl. `akemi` example) → `window.showTextDocument`.
  - restart → provider.restart().
- On config change of `ompcode.*` → restart process.

## src/modelsSync.ts (builder B)

`export async function syncCustomProviders(cfg: object): Promise<void>`:
if `customProviders` non-empty: read `~/.omp/agent/models.yml` (or `{}`), parse with `yaml`,
deep-merge each provider into `doc.providers[name]` (overwrite per-name), write back (create dir).
Never delete user entries. Called before each process start.

## Webview UI (builder C: media/main.js, builder D: media/main.css)

Look = Claude Code panel. All colors from VS Code CSS vars; accent `#D97757` (coral) as
`--accent`. Fonts: `var(--vscode-font-family)`; code: `var(--vscode-editor-font-family)`.

### Session history (src/sessions.ts)

omp has no "list sessions" RPC. It persists every session as JSONL under
`~/.omp/agent/sessions/<slugged-cwd>/<timestamp>_<id>.jsonl`, so the extension reads that
tree directly: **one flat list for the whole extension, spanning every workspace and every
model**. `summarizeSession()` extracts `title`, `session` (id/cwd/timestamp),
`model_change`, and messages; the model badges come from the `provider`/`model` on
*assistant* messages (distinct, in order of first use), falling back to the last
`model_change` when nothing answered yet. Sessions with zero user messages are dropped —
omp writes a file on every agent start and those shells would bury the real ones. Files
over 4 MB are summarized from their first and last 400 lines. Results are cached per
path+mtime; a full scan of ~22 sessions takes ~30 ms.

UI: clock icon (inline SVG, `currentColor`) in the topbar (also **OMP Code: Session History**) → `{t:"getHistory"}` →
`{t:"history", sessions, cwd}` → `.history-card` with `.history-row`s
(`.history-main` + `.history-meta` holding `.history-badge` per model, relative time,
message count, and the folder name when the session belongs to another workspace).
Clicking a row posts `{t:"openSession", path}`; the host runs RPC
`switch_session {sessionPath}` (it takes a **path**, which is why sessions from other
workspaces open), then `get_messages` → `{t:"reset"}` + `{t:"transcript", messages}`,
which the webview replays through the normal user/assistant/toolResult render paths.

### Title-bar entry point

`ompcode.openChat` (icon `media/icon-{light,dark}.svg`) is contributed to
`menus."editor/title"` with `group: "navigation@100"`, putting the ✳ next to the other
agent extensions' icons. It opens the chat **as an editor tab beside the code**, not the
left sidebar view: `revealChatTab()` reveals the first live chat panel, or creates one at
`chatColumn()` — `ViewColumn.Beside` for the first panel, and thereafter the column an
existing chat already occupies, so later chats become tabs in that same right-hand group
instead of splitting the editor again. `ompcode.showHistory` and both sign-in commands go
through the same helper so they act on the chat the user can see. The sidebar view stays
registered for anyone who prefers it.

### Module wiring (do not break — this failed silently once)

`media/main.mjs` and `media/markdown.mjs` are separate ES modules loaded by two nonce'd
`<script type="module">` tags. **Module exports are not globals**: `main.mjs` must
`import { renderMarkdown } from "./markdown.mjs"`. Without that import every
`renderAssistant()` call threw `ReferenceError: renderMarkdown is not defined`, the
host-message `try/catch` swallowed it, and *no assistant reply ever rendered* while user
bubbles (local echo) and notices (plain `textContent`) kept working — indistinguishable
from "the model does not answer". Guarded by `test/webviewWiring.test.ts`.

Consequently that `catch` must never be silent: it calls `reportUiError()`, which posts
`{t:"uiError", message, context}` to the host (→ "OMP Code" output channel) and shows one
error notice in the transcript.

### DOM skeleton + class names (CONTRACT between C and D — follow exactly)

```html
<div id="app">
  <header class="topbar">
    <div class="topbar-title"><span class="spark">✳</span><span id="session-title">OMP Code</span></div>
    <div class="topbar-actions">
      <button id="btn-new" class="icon-btn" title="New session">＋</button>
      <button id="btn-settings" class="icon-btn" title="Settings">⚙</button>
    </div>
  </header>
  <main id="messages">
    <div class="welcome"><div class="welcome-spark">✳</div>
      <h1>What can I help you build?</h1>
      <p class="welcome-sub">…tips…</p></div>
    <!-- dynamic: -->
    <div class="msg user"><div class="bubble">…text…</div></div>
    <div class="msg assistant">
      <div class="thinking collapsed"><div class="thinking-head">✳ Thinking…</div><div class="thinking-body">…</div></div>
      <div class="md">…rendered markdown…</div>
    </div>
    <div class="tool-card" data-status="running|ok|error" data-id="toolCallId">
      <div class="tool-head"><span class="tool-dot"></span><span class="tool-name">Bash</span><span class="tool-summary">(ls -la)</span><span class="tool-toggle">▸</span></div>
      <div class="tool-body"><pre>…result… (diff lines get .dl-add/.dl-del)</pre><div class="tool-more">… +12 lines</div></div>
    </div>
    <div class="notice info|warning|error">…</div>
    <div id="working" class="status-line hidden"><span class="spark spin">✳</span> Working… <span class="dim">esc to interrupt</span></div>
  </main>
  <div id="modal-holder"></div>   <!-- .ui-modal cards render here, above composer -->
  <footer class="composer">
    <div class="composer-box">
      <div id="slash-popup" class="slash-popup hidden"></div>
      <div id="attachments" class="attachments"></div>   <!-- .att-chip per staged file -->
      <textarea id="input" rows="1" placeholder="Ask OMP Code…"></textarea>
      <div class="composer-row">
        <button id="btn-attach" class="chip attach">📎</button>
        <button id="model-chip" class="chip">model</button>
        <button id="thinking-chip" class="chip">think: auto</button>
        <span class="flex-spacer"></span>
        <button id="btn-send" class="send-btn" title="Send">↑</button>
        <button id="btn-stop" class="send-btn stop hidden" title="Stop">■</button>
      </div>
    </div>
    <div id="proc-banner" class="proc-banner hidden">…agent not running… <button id="btn-restart">Restart</button></div>
  </footer>
  <div id="drop-overlay" class="hidden">…drop target, shown while dragging…</div>
  <div id="menu-holder"></div>    <!-- .menu popup for model/thinking pickers -->
  <div id="toast-holder"></div>
</div>
```

### main.js behavior (builder C)

- `const vscode = acquireVsCodeApi();` post `{t:"ready"}` on load.
- Incoming `{t:"frame"|"models"|"state"|"commands"|"proc"|"boot"|"reset"}` — handlers per spec above.
- Frame handling: maintain `byToolCallId` map for tool cards; assistant message keyed by object identity per message_start→update→end cycle (keep ref to current streaming msg element; `message_update` full re-render of `.md` from `message.content` text blocks; thinking blocks → `.thinking` collapsible; toolCall blocks → ensure tool-card exists (may arrive before tool_execution_start)).
- toolResult messages (`message_start` with role toolResult) → attach content text into matching tool-card body.
- User prompt: render `.msg.user` immediately on send; clear input; show #working; btn-send↔btn-stop swap.
- `agent_end` → hide #working, swap stop→send. `notice` → `.notice`. auto_retry_* → notice info.
- extension_ui_request:
  - `confirm` → modal card: title, message (md-lite), buttons **Allow** (accent) / **Deny** → `{t:"uiResponse", frame:{type:"extension_ui_response", id, confirmed:true|false}}`
  - `select` → modal with title + option buttons → `{...,value:option}`
  - `input`/`editor` → modal with textarea (+prefill) + OK/Cancel → `{value}` or `{cancelled:true}`
  - `notify` → toast 4s. `setStatus`/`setTitle` → #session-title / status. `set_editor_text` → input.value. `cancel` → remove modal with matching targetId, no response. `open_url` → also toast "Opening browser…". `setWidget` → ignore (host handles nothing).
  - Modals queue (one at a time), Esc = cancel `{cancelled:true}`.
- Markdown mini-renderer (own function, ~100 lines): fenced code (``` lang) → `<pre class="code"><div class="code-lang">lang</div><code>`, inline `` ` ``, **bold**, *italic*, headings #–###, links `[t](url)` (click → `{t:"openExternal"}`), ul/ol, blockquote, hr. Escape HTML first. No raw HTML passthrough.
- Composer: Enter=send (Shift+Enter newline), textarea autogrow (max ~8 lines), Esc→`{t:"abort"}` when working. Send is allowed with attachments and no text; a prompt is refused while an attachment is still copying.
- Slash popup: on input starting with `/` show filtered command list (name+description) from commands; ↑↓+Enter/Tab insert `/name `; send as normal prompt text.
- Model chip: click → `.menu` popup listing models grouped by provider (from models); click → `{t:"setModel"}`, update chip. Thinking chip → levels list (off,minimal,low,medium,high,xhigh,max,auto) → `{t:"setThinking"}`.
- State msg → chip texts: model chip = `state.model?.name ?? state.model?.id ?? "model"`; thinking chip shows the user's selector (`auto → high` when auto resolves); access chip shows the approval tier.
- Autoscroll: stick to bottom unless user scrolled up >80px (re-stick on send).
- Tool cards: collapsed body max-height ~4 lines with `.tool-more` expander; click head toggles; `data-status` drives dot color. Summary = first arg value truncated 60ch (prefer args.command/path/file_path/url, else JSON).
- `proc` status → #proc-banner show/hide; `reset` → clear #messages (keep welcome), reset maps.
- Persist nothing (state lives in DOM; retainContextWhenHidden keeps it).
- Attachments (`#attachments`, one `.att-chip` each): 📎 button → `{t:"pickFiles"}`; `paste`
  event with `clipboardData.files` → `attachData` per file (FileReader → base64, chunked so
  `String.fromCharCode` cannot blow the stack); `drop` → `application/vnd.code.uri-list` /
  `text/uri-list` first (paths, nothing copied), else `dataTransfer.files`, else a single
  absolute path pasted as text. **VS Code forwards a drop into a webview only while Shift is
  held** — without Shift the editor consumes the drag and no DOM event arrives.
  `dragenter`/`dragleave` toggle `#drop-overlay`. Pending chips carry a `token` and are
  replaced by the host's `{t:"attached"}` reply; `rejected` entries surface as a toast.
  Sending posts `{t:"prompt", text, attachments}` and echoes `.att-echo-item` chips into the
  user bubble, then clears the tray. `reset` clears it too.
- Palette: `applyTheme(theme, accentColor)` sets `body[data-theme]` and, for a custom accent,
  writes `--accent`/`--accent-strong`/`--accent-quiet` through the CSSOM — CSP forbids an
  inline `<style>`, but CSSOM writes are allowed. `CSS.supports("color", …)` gates the value.

### main.css (builder D)

- Root vars: `--accent:#8B7BF7` (violet default) plus `--accent-strong/-quiet/-fg`, `--ok`, and the accent-tinted derivations `--accent-wash/-line`, `--surface`, `--bubble-bg`, `--glow` built with `color-mix()`. Other palettes are `body[data-theme="coral"|"emerald"|"amber"|"magenta"]` overriding only the accent trio. VS Code vars used by a `color-mix()` need literal fallbacks, otherwise the whole mix is invalid and the tint silently disappears.
- Layout: #app flex column 100vh; #messages flex:1 overflow-y auto, padding 12px 14px; composer sticky bottom padding 10px.
- `.msg.user .bubble`: background var(--bubble-bg), border 1px var(--accent-line) with a 2px var(--accent) left edge, radius 8px, padding 8px 10px, margin 10px 0.
- `.msg.assistant .md`: plain, line-height 1.55; code blocks: background var(--vscode-textCodeBlock-background), radius 6px, `.code-lang` tiny muted label; inline code subtle bg.
- `.tool-card`: margin 6px 0, radius 6px, border 1px var(--border), background color-mix(in srgb, var(--bg) 92%, var(--fg) 8%)…keep simple: `var(--vscode-editorWidget-background)`. `.tool-dot` 8px circle — running: var(--accent) + pulse animation; ok: #4caf7d; error: var(--vscode-errorForeground). `.tool-head` monospace 12px, cursor pointer. `.tool-body pre` 12px monospace, muted, `⎿`-style left padding + left border 2px var(--border); collapsed max-height 5.5em overflow hidden. `.dl-add{color:#4caf7d}.dl-del{color:var(--vscode-errorForeground)}`.
- `.thinking`: muted italic; head cursor pointer; collapsed body hidden.
- Composer `.composer-box`: border 1px var(--border), radius 10px, background var(--input-bg), focus-within border var(--accent); textarea transparent no-outline resize none font inherit.
- `.chip`: 11px, padding 2px 8px, radius 999px, border 1px var(--border), muted; hover fg. `.send-btn`: 26px circle, background var(--accent), color white; disabled muted; `.stop` background var(--vscode-errorForeground).
- `.status-line`: muted 12px; `.spark.spin` animation rotate 2s linear infinite (also used welcome). `.welcome`: centered, pad top 18vh; `.welcome-spark` 42px color var(--accent); h1 16px 600.
- `.ui-modal`: card above composer (in #modal-holder, position static margin 8px 14px), border 1px var(--accent), radius 8px, padding 12px, background var(--vscode-editorWidget-background); buttons row right; primary button accent bg white text, secondary bordered.
- `.ui-modal.auth-card`: sign-in card, built from the `open_url` ui-request. Children: `.modal-title`, `.modal-msg`, `.auth-code` (device code, 20px mono, letter-spacing 2px, `user-select:all`, accent border — only when `instructions` yields a code), `.auth-instructions` (raw instructions fallback), `.auth-url` (11px muted, break-all, `user-select:all`), `.auth-status`, `.modal-buttons` (Copy code / Open page again / Hide). Removed on `{t:"authDone"}`; "Hide" only removes the card, the login RPC keeps polling.
- `.menu`: absolute popup anchored bottom-left above composer, max-height 40vh scroll, radius 8px, border, background var(--vscode-editorWidget-background), item hover var(--vscode-list-hoverBackground), group label muted 10px uppercase.
- `.att-chip`: 11px pill, border var(--accent-line), background var(--accent-wash), `.att-name` ellipsis at 190px, `.att-size` muted 10px, `.att-remove` ✕ button; `.pending` at .6 opacity. `.att-echo-item` is the same pill inside a sent user bubble. `#drop-overlay`: fixed inset 0, dashed 2px var(--accent) border, accent-washed background, centered `.drop-title`.
- `.slash-popup`: like .menu but anchored above textarea, full composer width.
- `.proc-banner`: warning bg `var(--vscode-inputValidation-warningBackground)`, radius 6px, 12px.
- `.toast`: fixed bottom-right stack, dark card, fade.
- `.notice.error` color errorForeground, `.warning` editorWarning-foreground, `.info` muted. `.hidden{display:none}`.
- Scrollbars: thin, `var(--vscode-scrollbarSlider-background)`.
```
