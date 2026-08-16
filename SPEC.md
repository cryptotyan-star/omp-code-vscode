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
src/extension.ts  src/ompProcess.ts  src/chatViewProvider.ts  src/modelsSync.ts      ← builder B
media/main.js                                                                         ← builder C
media/main.css                                                                        ← builder D
```

## package.json (builder A) — exact contributions

- name `omp-code`, displayName `OMP Code`, publisher `local`, version `0.1.0`, engines.vscode `^1.85.0`,
  main `./dist/extension.js`, activationEvents: `onView:ompcode.chat`.
- viewsContainers.activitybar: id `ompcode`, title `OMP Code`, icon `media/icon.svg`.
- views.ompcode: `[{ "type": "webview", "id": "ompcode.chat", "name": "Chat" }]`
- commands:
  - `ompcode.newSession` — "OMP Code: New Session" (icon `$(add)`)
  - `ompcode.setAnthropicKey` — "OMP Code: Set Anthropic API Key"
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
- scripts: `build` = `node esbuild.mjs`, `watch`, `package` = `vsce package`.
- esbuild.mjs: bundle `src/extension.ts` → `dist/extension.js`, platform node, format cjs, external `["vscode"]`, minify off, sourcemap.
- media/icon.svg: neutral 24×24 monochrome asterisk/spark (✳ shape, `currentColor`). NOT the Anthropic logo.
- README.md: install (`bun install -g @oh-my-pi/pi-coding-agent`), configuring Akemi provider + Anthropic key, usage. Russian + English short.

## omp RPC protocol (used by builder B host, frames forwarded verbatim to webview for builder C)

Spawn: `<ompPath> --mode rpc-ui --cwd <workspaceFolder>` (cwd = first workspace folder, else home).
Env: inherit process.env + `ANTHROPIC_API_KEY` from SecretStorage key `ompcode.anthropicApiKey` (if set).
Add `~/.bun/bin` to PATH in env if not present. Also pass `--approval-mode <cfg>` when cfg ≠ "always-ask".

stdin: one JSON command per line. stdout: one JSON frame per line (parse per line; ignore unparseable lines).
stderr: log to OutputChannel "OMP Code".

Commands host sends (all optionally carry `id` for correlation):
```
{id, type:"negotiate_protocol", protocolVersion:2}   // first, after "ready" frame
{id, type:"prompt", message, streamingBehavior?:"steer"|"followUp"}
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
State (get_state → data): `{model?, thinkingLevel, isStreaming, sessionId, sessionName?, contextUsage?:{tokens?...percent?}, todoPhases, messageCount, ...}` — render model chip + context %. `contextUsage` shape uncertain → webview must render defensively (if `percent` number show `NN%`, else if `tokens`+`contextWindow` compute, else hide).

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
- On `resolveWebviewView`: wait for webview `{t:"ready"}` → ensure OmpProcess started → replay nothing (fresh), send `{t:"boot", cfg:{defaultModel, thinkingLevel}}`.
- Bridge webview→host messages:
  - `{t:"prompt", text}` → if state.isStreaming per last known → send as `{type:"prompt", message:text, streamingBehavior:"steer"}` else plain prompt (host does NOT track streaming precisely; just always send `streamingBehavior:"steer"` — omp queues correctly).
  - `{t:"abort"}` → send abort
  - `{t:"newSession"}` → request new_session then get_state, forward
  - `{t:"setModel", provider, modelId}` / `{t:"setThinking", level}` → request, then get_state, forward state frame
  - `{t:"getModels"}` → request get_available_models → post `{t:"models", models}`
  - `{t:"getState"}` → request get_state → post `{t:"state", state}`
  - `{t:"getCommands"}` → request → post `{t:"commands", commands}`
  - `{t:"uiResponse", frame}` → send frame verbatim (must be `{type:"extension_ui_response", id, ...}`)
  - `{t:"openExternal", url}` → vscode.env.openExternal
  - `{t:"compact"}` → request compact
- Host→webview messages: `{t:"frame", frame}` (every event/ui_request), `{t:"models"|"state"|"commands", ...}`, `{t:"proc", status:"starting"|"running"|"exited"|"error", detail?}`, `{t:"boot", cfg}`.
- After process ready-init sequence: post state+models+commands proactively.
- extension.ts: activate → register provider (retainContextWhenHidden true via `webviewOptions`), commands:
  - newSession → post to webview `{t:"frame",frame:{type:"__newSession"}}`? NO — call provider.newSession() which does the RPC + notifies webview `{t:"reset"}`.
  - setAnthropicKey → `window.showInputBox({password:true})` → `context.secrets.store("ompcode.anthropicApiKey", v)` → offer restart.
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
      <textarea id="input" rows="1" placeholder="Ask OMP Code…"></textarea>
      <div class="composer-row">
        <button id="model-chip" class="chip">model</button>
        <button id="thinking-chip" class="chip">think: auto</button>
        <span id="ctx-chip" class="chip ghost hidden"></span>
        <span class="flex-spacer"></span>
        <button id="btn-send" class="send-btn" title="Send">↑</button>
        <button id="btn-stop" class="send-btn stop hidden" title="Stop">■</button>
      </div>
    </div>
    <div id="proc-banner" class="proc-banner hidden">…agent not running… <button id="btn-restart">Restart</button></div>
  </footer>
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
- Composer: Enter=send (Shift+Enter newline), textarea autogrow (max ~8 lines), Esc→`{t:"abort"}` when working.
- Slash popup: on input starting with `/` show filtered command list (name+description) from commands; ↑↓+Enter/Tab insert `/name `; send as normal prompt text.
- Model chip: click → `.menu` popup listing models grouped by provider (from models); click → `{t:"setModel"}`, update chip. Thinking chip → levels list (off,minimal,low,medium,high,xhigh,max,auto) → `{t:"setThinking"}`.
- State msg → chip texts: model chip = `state.model?.name ?? state.model?.id ?? "model"`, ctx-chip = context % if derivable.
- Autoscroll: stick to bottom unless user scrolled up >80px (re-stick on send).
- Tool cards: collapsed body max-height ~4 lines with `.tool-more` expander; click head toggles; `data-status` drives dot color. Summary = first arg value truncated 60ch (prefer args.command/path/file_path/url, else JSON).
- `proc` status → #proc-banner show/hide; `reset` → clear #messages (keep welcome), reset maps.
- Persist nothing (state lives in DOM; retainContextWhenHidden keeps it).

### main.css (builder D)

- Root vars: `--accent:#D97757; --bg:var(--vscode-sideBar-background); --fg:var(--vscode-foreground); --muted:var(--vscode-descriptionForeground); --border:var(--vscode-panel-border, rgba(128,128,128,.25)); --input-bg:var(--vscode-input-background);`
- Layout: #app flex column 100vh; #messages flex:1 overflow-y auto, padding 12px 14px; composer sticky bottom padding 10px.
- `.msg.user .bubble`: background var(--input-bg), border 1px var(--border), radius 8px, padding 8px 10px, margin 10px 0.
- `.msg.assistant .md`: plain, line-height 1.55; code blocks: background var(--vscode-textCodeBlock-background), radius 6px, `.code-lang` tiny muted label; inline code subtle bg.
- `.tool-card`: margin 6px 0, radius 6px, border 1px var(--border), background color-mix(in srgb, var(--bg) 92%, var(--fg) 8%)…keep simple: `var(--vscode-editorWidget-background)`. `.tool-dot` 8px circle — running: var(--accent) + pulse animation; ok: #4caf7d; error: var(--vscode-errorForeground). `.tool-head` monospace 12px, cursor pointer. `.tool-body pre` 12px monospace, muted, `⎿`-style left padding + left border 2px var(--border); collapsed max-height 5.5em overflow hidden. `.dl-add{color:#4caf7d}.dl-del{color:var(--vscode-errorForeground)}`.
- `.thinking`: muted italic; head cursor pointer; collapsed body hidden.
- Composer `.composer-box`: border 1px var(--border), radius 10px, background var(--input-bg), focus-within border var(--accent); textarea transparent no-outline resize none font inherit.
- `.chip`: 11px, padding 2px 8px, radius 999px, border 1px var(--border), muted; hover fg. `.send-btn`: 26px circle, background var(--accent), color white; disabled muted; `.stop` background var(--vscode-errorForeground).
- `.status-line`: muted 12px; `.spark.spin` animation rotate 2s linear infinite (also used welcome). `.welcome`: centered, pad top 18vh; `.welcome-spark` 42px color var(--accent); h1 16px 600.
- `.ui-modal`: card above composer (in #modal-holder, position static margin 8px 14px), border 1px var(--accent), radius 8px, padding 12px, background var(--vscode-editorWidget-background); buttons row right; primary button accent bg white text, secondary bordered.
- `.menu`: absolute popup anchored bottom-left above composer, max-height 40vh scroll, radius 8px, border, background var(--vscode-editorWidget-background), item hover var(--vscode-list-hoverBackground), group label muted 10px uppercase.
- `.slash-popup`: like .menu but anchored above textarea, full composer width.
- `.proc-banner`: warning bg `var(--vscode-inputValidation-warningBackground)`, radius 6px, 12px.
- `.toast`: fixed bottom-right stack, dark card, fade.
- `.notice.error` color errorForeground, `.warning` editorWarning-foreground, `.info` muted. `.hidden{display:none}`.
- Scrollbars: thin, `var(--vscode-scrollbarSlider-background)`.
```
