/* OMP Code — webview UI. ESM module; runs under a nonce'd script tag. */

  // markdown.mjs is a module: its exports are NOT globals. Without this import
  // every renderAssistant() call threw ReferenceError, which the host-message
  // try/catch swallowed — assistant replies silently never rendered.
  import { renderMarkdown } from "./markdown.mjs";

  var vscode = acquireVsCodeApi();
  function post(msg) {
    try { vscode.postMessage(msg); } catch (e) { /* host gone */ }
  }

  /* Static skeleton lives in the host-provided HTML (ompSession.getHtml). */

  var messagesEl = document.getElementById("messages");
  var welcomeEl = messagesEl.querySelector(".welcome");
  var workingEl = document.getElementById("working");
  var workingText = document.getElementById("working-text");
  var modalHolder = document.getElementById("modal-holder");
  var menuHolder = document.getElementById("menu-holder");
  var toastHolder = document.getElementById("toast-holder");
  var input = document.getElementById("input");
  var slashPopup = document.getElementById("slash-popup");
  var atPopup = document.getElementById("at-popup");
  var modelChip = document.getElementById("model-chip");
  var profileChip = document.getElementById("profile-chip");
  var thinkingChip = document.getElementById("thinking-chip");
  var approvalChip = document.getElementById("approval-chip");
  var btnSend = document.getElementById("btn-send");
  var btnStop = document.getElementById("btn-stop");
  var btnHistory = document.getElementById("btn-history");
  var btnNew = document.getElementById("btn-new");
  var btnSettings = document.getElementById("btn-settings");
  var btnRestart = document.getElementById("btn-restart");
  var btnAttach = document.getElementById("btn-attach");
  var attachmentsEl = document.getElementById("attachments");
  var dropOverlay = document.getElementById("drop-overlay");
  var procBanner = document.getElementById("proc-banner");
  var procText = document.getElementById("proc-text");
  var sessionTitle = document.getElementById("session-title");
  var fileChip = document.getElementById("file-chip");
  var statsChip = document.getElementById("stats-chip");

  /* ------------------------------------------------------------------ */
  /* State                                                               */
  /* ------------------------------------------------------------------ */

  var COLLAPSE_LINES = 5;
  var THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"];

  // Shown under each thinking level. The ladder itself is per-model — omp
  // reports it as `model.thinking.efforts` — so these are descriptions only,
  // never the source of which levels exist.
  var THINKING_HINTS = {
    off: "No reasoning — fastest and cheapest answer",
    minimal: "Brief consideration — for simple, mechanical edits",
    low: "Light reasoning — small changes in familiar code",
    medium: "Balanced — the usual choice for everyday work",
    high: "Deep analysis — tricky bugs, unfamiliar code",
    xhigh: "Very deep — slower and more expensive",
    max: "Maximum — hardest problems, slowest, priciest",
    auto: "omp classifies each request and picks a level for it",
  };

  // omp has exactly three approval tiers (`--approval-mode`). Native harnesses
  // have four to six, so these are the honest mapping, not an equivalence.
  // Approving a `task` call hands its subagent the same tier, so "asks before
  // commands" holds for the main agent but not for work it delegates — the
  // hints say so rather than promising a guarantee the tier does not give.
  var APPROVAL_MODES = [
    { id: "always-ask", short: "ask", label: "Ask before changes",
      hint: "Reads files freely; asks before writing a file or running a command" },
    { id: "write", short: "write", label: "Write freely, ask to run",
      hint: "Reads and edits files on its own; asks before running a command" },
    { id: "yolo", short: "full", label: "Full access",
      hint: "Reads, edits and runs shell commands with no confirmation" },
  ];

  // Resolver layer → words. `base`/`builtin`/`user` are the profile resolver's
  // internal names; the inspector has to say where a value came from in terms
  // the reader can act on.
  var PROVENANCE_LABELS = {
    base: "default",
    builtin: "built-in",
    user: "your settings",
  };

  var byToolCallId = new Map();
  var anonToolSeq = 0;
  var currentAssistant = null;   // { root } for the streaming assistant message
  var models = [];
  var commands = [];
  var currentModel = null;       // full Model from get_state — carries `thinking`
  var currentThinking = null;   // level the agent reports — drives the chip
  // What the user actually picked. `auto` resolves to a different concrete
  // level on every turn, so the agent's reported level must not be mistaken
  // for the selection — otherwise the ✓ jumps to a level nobody chose and
  // `auto` becomes impossible to see as active.
  var thinkingChoice = null;
  var currentApproval = "always-ask";
  // Resolved ModelProfile for the current model, pushed by the host as
  // `{ t: "profile", profile }`. Stays null on a host that never sends it,
  // which is exactly the pre-profile UI: no badge, no inspector.
  var currentProfile = null;
  var working = false;
  var stuck = true;              // autoscroll stick-to-bottom
  var pendingLocalUser = 0;      // user bubbles rendered locally, skip echoes
  var retryNotice = null;
  var compactNotice = null;
  // Attachments staged for the next prompt: { path, name, size } once the host
  // confirms them, or { token, name, pending:true } while bytes are in flight.
  var attachments = [];
  var attachSeq = 0;
  var dragDepth = 0;

  var modalQueue = [];
  var activeModal = null;        // { frame, el }

  var openMenuEl = null;
  var openMenuAnchor = null;

  var slashItems = [];
  var slashSel = 0;

  // Sent prompts, newest last; ↑ in the composer walks them like a shell.
  var promptHistory = [];
  var historyIdx = -1;      // -1 = editing, not browsing
  var historyDraft = "";

  /* ------------------------------------------------------------------ */
  /* Small helpers                                                       */
  /* ------------------------------------------------------------------ */

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function trunc(s, n) {
    s = String(s == null ? "" : s).replace(/\s+/g, " ").trim();
    n = n || 60;
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  function hideWelcome() {
    if (welcomeEl) welcomeEl.classList.add("hidden");
  }

  function appendToMessages(el) {
    hideWelcome();
    messagesEl.insertBefore(el, workingEl);
    scrollBottom();
  }

  function scrollBottom() {
    if (stuck) messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  messagesEl.addEventListener("scroll", function () {
    stuck = (messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight) < 80;
  });

  function toast(text, ms) {
    if (!text) return;
    var el = document.createElement("div");
    el.className = "toast";
    el.textContent = String(text);
    toastHolder.appendChild(el);
    setTimeout(function () {
      el.classList.add("fade-out");
      setTimeout(function () { el.remove(); }, 400);
    }, ms || 4000);
  }

  /** Extract plain text from a message `content` field (string or block array). */
  function contentText(content) {
    if (content == null) return "";
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      var out = [];
      for (var i = 0; i < content.length; i++) {
        var b = content[i];
        if (b == null) continue;
        if (typeof b === "string") { out.push(b); continue; }
        if (b.type === "text" && typeof b.text === "string") out.push(b.text);
        else if (b.type === "image") out.push("[image]");
        else if (typeof b.text === "string") out.push(b.text);
      }
      return out.join("\n");
    }
    if (typeof content === "object" && typeof content.text === "string") return content.text;
    return String(content);
  }

  /* ------------------------------------------------------------------ */
  /* Messages: user / assistant                                          */
  /* ------------------------------------------------------------------ */
  function addUserBubble(text, files) {
    var list = Array.isArray(files) ? files : [];
    if (!text && list.length === 0) return;
    var msg = document.createElement("div");
    msg.className = "msg user";
    var bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.style.whiteSpace = "pre-wrap";
    bubble.textContent = String(text || "");
    if (list.length) {
      // The host appends the paths to the prompt; the bubble shows what went
      // along so the transcript is not silently different from what was sent.
      var echo = document.createElement("span");
      echo.className = "att-echo";
      list.forEach(function (f) {
        var item = document.createElement("span");
        item.className = "att-echo-item";
        var range = f.selection ? ":" + f.selection.startLine + "-" + f.selection.endLine : "";
        item.textContent = (f.selection ? "✂ " : "📎 ") + f.name + range;
        item.title = f.path;
        echo.appendChild(item);
      });
      bubble.appendChild(echo);
    }
    msg.appendChild(bubble);
    appendToMessages(msg);
  }

  function newAssistantEntry() {
    var root = document.createElement("div");
    root.className = "msg assistant";
    appendToMessages(root);
    return { root: root };
  }

  // Signature of a content block for change detection.
  function blockSig(b) {
    if (!b) return "";
    if (b.type === "text") return "t:" + (b.text != null ? b.text : "");
    if (b.type === "thinking") return "k:" + (b.thinking != null ? b.thinking : (b.text != null ? b.text : ""));
    if (b.type === "toolCall") return "c:" + (b.id != null ? b.id : "") + ":" + (b.name != null ? b.name : "");
    return b.type + ":" + JSON.stringify(b);
  }

  // Render assistant message incrementally: only rebuild DOM from the first
  // content block whose signature changed. Streaming appends to the last
  // block, so the common case is "everything matches except the tail" — we
  // patch only that tail instead of wiping the whole root.
  function renderAssistant(entry, message) {
    var root = entry.root;
    var content = message && message.content;
    if (typeof content === "string") content = [{ type: "text", text: content }];
    if (!Array.isArray(content)) content = [];

    // Capture expanded-state of existing thinking blocks before any rebuild.
    var expanded = {};
    if (!entry.sigs) {
      var prev = root.querySelectorAll(".thinking");
      for (var i = 0; i < prev.length; i++) {
        if (!prev[i].classList.contains("collapsed")) expanded[i] = true;
      }
    }

    // Find first diverging index.
    var oldSigs = entry.sigs || [];
    var firstDiff = content.length;
    for (var j = 0; j < content.length; j++) {
      if (blockSig(content[j]) !== (oldSigs[j] || "")) { firstDiff = j; break; }
    }
    // If nothing changed, nothing to do.
    if (entry.sigs && firstDiff === content.length && oldSigs.length === content.length) {
      return;
    }

    // Remove DOM children from the first diverging block onward. Children of
    // root are only .md and .thinking (toolCall blocks render as #messages
    // siblings, not inside root), so we can drop trailing nodes directly.
    var kids = Array.prototype.slice.call(root.children);
    // Map content indices that produced a DOM node up to firstDiff.
    var domIdx = 0;
    for (var k = 0; k < firstDiff; k++) {
      var bk = content[k];
      if (bk && (bk.type === "text" ? bk.text : (bk.type === "thinking" ? (bk.thinking != null ? bk.thinking : bk.text) : null))) {
        domIdx++;
      }
    }
    // drop everything from domIdx onward
    for (var d = domIdx; d < kids.length; d++) kids[d].remove();

    // Rebuild from firstDiff.
    var newSigs = [];
    for (var j2 = 0; j2 < firstDiff; j2++) newSigs[j2] = oldSigs[j2];
    var ti = domIdx; // thinking-block index for expanded-state continuity
    for (var m = firstDiff; m < content.length; m++) {
      var block = content[m];
      newSigs[m] = blockSig(block);
      if (!block) continue;
      if (block.type === "text") {
        if (!block.text) continue;
        var md = document.createElement("div");
        md.className = "md";
        md.innerHTML = renderMarkdown(block.text);
        root.appendChild(md);
      } else if (block.type === "thinking") {
        var ttext = block.thinking != null ? block.thinking : block.text;
        if (!ttext) continue;
        var t = document.createElement("div");
        t.className = "thinking" + (expanded[ti] ? "" : " collapsed");
        t.innerHTML = '<div class="thinking-head">✳ Thinking…</div><div class="thinking-body"></div>';
        t.querySelector(".thinking-body").innerHTML = renderMarkdown(ttext);
        root.appendChild(t);
        ti++;
      } else if (block.type === "toolCall") {
        ensureToolCard(block.id, block.name, block.arguments);
      }
    }
    entry.sigs = newSigs;
    scrollBottom();
  }

  function onMessageStart(m) {
    if (!m) return;
    if (m.role === "user") {
      if (pendingLocalUser > 0) { pendingLocalUser--; return; }
      if (m.synthetic) return;
      addUserBubble(contentText(m.content));
    } else if (m.role === "assistant") {
      currentAssistant = newAssistantEntry();
      renderAssistant(currentAssistant, m);
    } else if (m.role === "toolResult") {
      attachToolResult(m);
    }
  }

  function onMessageUpdate(m) {
    if (!m) return;
    if (m.role === "assistant") {
      if (!currentAssistant) currentAssistant = newAssistantEntry();
      renderAssistant(currentAssistant, m);
    } else if (m.role === "toolResult") {
      attachToolResult(m);
    }
  }

  function onMessageEnd(m) {
    if (!m) return;
    if (m.role === "assistant") {
      if (!currentAssistant) currentAssistant = newAssistantEntry();
      renderAssistant(currentAssistant, m);
      if (m.errorMessage) addNotice("error", m.errorMessage);
      currentAssistant = null;
    } else if (m.role === "toolResult") {
      attachToolResult(m);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Tool cards                                                          */
  /* ------------------------------------------------------------------ */

  function toolSummary(args) {
    if (args == null) return "";
    if (typeof args === "string") return trunc(args);
    if (typeof args !== "object") return trunc(String(args));
    var v = args.command != null ? args.command
      : args.path != null ? args.path
      : args.file_path != null ? args.file_path
      : args.url != null ? args.url
      : null;
    if (typeof v === "string" && v) return trunc(v);
    for (var k in args) {
      if (Object.prototype.hasOwnProperty.call(args, k) && typeof args[k] === "string" && args[k]) {
        return trunc(args[k]);
      }
    }
    try { return trunc(JSON.stringify(args)); } catch (e) { return ""; }
  }

  function ensureToolCard(id, name, args) {
    var key = id != null ? String(id) : null;
    var card = key ? byToolCallId.get(key) : null;
    if (!card) {
      card = document.createElement("div");
      card.className = "tool-card";
      card.dataset.status = "running";
      card.dataset.id = key || ("anon-" + (anonToolSeq++));
      card.innerHTML =
        '<div class="tool-head">' +
          '<span class="tool-dot"></span>' +
          '<span class="tool-name"></span>' +
          '<span class="tool-summary"></span>' +
          '<span class="tool-toggle">▸</span>' +
        '</div>' +
        '<div class="tool-body collapsed hidden"><pre></pre><div class="tool-more hidden"></div></div>';
      appendToMessages(card);
      if (key) byToolCallId.set(key, card);
    }
    if (name) card.querySelector(".tool-name").textContent = String(name);
    var sum = toolSummary(args);
    if (sum) card.querySelector(".tool-summary").textContent = "(" + sum + ")";
    return card;
  }

  function setToolBody(card, text) {
    if (!card) return;
    var body = card.querySelector(".tool-body");
    var pre = card.querySelector(".tool-body pre");
    if (!body || !pre) return;
    text = String(text == null ? "" : text).replace(/\n+$/, "");
    if (!text) { body.classList.add("hidden"); return; }
    body.classList.remove("hidden");
    var lines = text.split("\n");
    // Only color +/- lines when the body actually looks like a diff.
    var isDiff = /^@@ .*@@/m.test(text) || (/^\+\+\+ /m.test(text) && /^--- /m.test(text));
    pre.innerHTML = lines.map(function (l) {
      if (isDiff && /^\+/.test(l)) return '<span class="dl-add">' + esc(l) + "</span>";
      if (isDiff && /^-/.test(l)) return '<span class="dl-del">' + esc(l) + "</span>";
      return esc(l);
    }).join("\n");
    card._lineCount = lines.length;
    updateToolMore(card);
    scrollBottom();
  }

  function updateToolMore(card) {
    var body = card.querySelector(".tool-body");
    var more = card.querySelector(".tool-more");
    if (!body || !more) return;
    var collapsed = body.classList.contains("collapsed");
    var hiddenLines = (card._lineCount || 0) - COLLAPSE_LINES;
    if (collapsed && hiddenLines > 0) {
      more.textContent = "… +" + hiddenLines + " lines";
      more.classList.remove("hidden");
    } else {
      more.classList.add("hidden");
    }
  }

  function toggleTool(card) {
    if (!card) return;
    var body = card.querySelector(".tool-body");
    var toggle = card.querySelector(".tool-toggle");
    if (!body) return;
    body.classList.remove("hidden");
    var nowCollapsed = body.classList.toggle("collapsed");
    if (toggle) toggle.textContent = nowCollapsed ? "▸" : "▾";
    updateToolMore(card);
  }

  function resultText(r) {
    if (r == null) return "";
    if (typeof r === "string") return r;
    if (typeof r === "object") {
      if (r.content != null) return contentText(r.content);
      if (typeof r.text === "string") return r.text;
      if (typeof r.output === "string") return r.output;
      try { return JSON.stringify(r, null, 2); } catch (e) { return String(r); }
    }
    return String(r);
  }

  function attachToolResult(m) {
    if (!m || m.toolCallId == null) return;
    var card = ensureToolCard(m.toolCallId, m.toolName);
    setToolBody(card, contentText(m.content));
    if (m.isError) card.dataset.status = "error";
    else if (card.dataset.status === "running") card.dataset.status = "ok";
  }

  /* ------------------------------------------------------------------ */
  /* Notices                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * Surface a webview-side exception: once in the transcript (so it cannot go
   * unnoticed) and always to the host's output channel (so it can be read).
   */
  var uiErrorShown = false;
  function reportUiError(err, context) {
    var detail = (err && (err.stack || err.message)) ? String(err.stack || err.message) : String(err);
    post({ t: "uiError", message: detail, context: context != null ? String(context) : "" });
    if (uiErrorShown) return;
    uiErrorShown = true;
    addNotice("error", "UI error while rendering — see the \"OMP Code\" output channel: " +
      detail.split("\n")[0]);
  }

  /* ------------------------------------------------------------------ */
  /* Context-fill warning                                                */
  /* ------------------------------------------------------------------ */

  // Steps already announced this session. A single 50% warning is easy to
  // scroll past in a long transcript, and the risk grows as the window fills,
  // so each step speaks once and the later ones are more insistent.
  var CONTEXT_STEPS = [50, 75, 90];
  var contextStepsFired = {};
  var contextNotice = null;
  // Last known auto-compaction state — get_session_stats does not carry it.
  var autoCompaction = true;

  /**
   * Warn as the context window fills, instead of showing a percentage that
   * reads "2%" for most of a session.
   *
   * When omp's own auto-compaction is on it will handle this without help, so
   * the message says so rather than demanding an action; the button is still
   * there for compacting at a chosen moment rather than mid-task.
   */
  /**
   * Fill percentage from omp's `contextUsage`, or null when unknowable.
   *
   * omp emits `{tokens, contextWindow, percent}` with `percent` already on a
   * 0-100 scale (session-stats.ts: `(usedTokens / contextWindow) * 100`).
   * It must NOT be rescaled — a genuine 0.9% reading would become 90%.
   * When the model's window is unknown omp reports `percent: 0`, which is a
   * placeholder rather than a measurement, so the token fallback runs first.
   */
  function contextPercent(cu, model) {
    if (cu == null) return null;
    if (typeof cu === "number") return isFinite(cu) ? cu : null;
    if (typeof cu !== "object") return null;

    var win = typeof cu.contextWindow === "number" && cu.contextWindow > 0 ? cu.contextWindow
      : (model && typeof model === "object" && typeof model.contextWindow === "number" && model.contextWindow > 0)
        ? model.contextWindow : null;
    if (typeof cu.tokens === "number" && win) return (cu.tokens / win) * 100;
    if (typeof cu.percent === "number" && isFinite(cu.percent) && cu.percent > 0) return cu.percent;
    return null;
  }

  function noteContextFill(pct, autoCompacts) {
    if (pct == null || !isFinite(pct) || pct < 0) return;

    // Re-arm from the measurement itself, never from a compaction frame: a
    // manual compact goes through the `compact` RPC, which returns a plain
    // response and emits no auto_compaction_end, so a frame-only re-arm would
    // leave the ladder spent after the user compacts by hand. The 10-point
    // gap keeps a reading hovering on a boundary from re-announcing itself.
    for (var s = 0; s < CONTEXT_STEPS.length; s++) {
      if (contextStepsFired[CONTEXT_STEPS[s]] && pct < CONTEXT_STEPS[s] - 10) {
        contextStepsFired[CONTEXT_STEPS[s]] = false;
      }
    }

    var step = null;
    for (var i = CONTEXT_STEPS.length - 1; i >= 0; i--) {
      if (pct >= CONTEXT_STEPS[i]) { step = CONTEXT_STEPS[i]; break; }
    }
    if (step == null || contextStepsFired[step]) return;
    // Every step at or below the current fill counts as spoken for, so a
    // later dip cannot follow a severe warning with a milder one.
    CONTEXT_STEPS.forEach(function (t) { if (pct >= t) contextStepsFired[t] = true; });

    if (contextNotice && contextNotice.isConnected) contextNotice.remove();

    var text = step >= 90
      ? "Context is " + Math.round(pct) + "% full — close to the limit."
      : step >= 75
        ? "Context is " + Math.round(pct) + "% full — a good moment to compact."
        : "Context is about half full.";
    var hint = autoCompacts
      ? "omp compacts automatically before it runs out; compacting now just picks the moment."
      : "Auto-compaction is off. Compacting summarizes the history so the chat can continue.";

    contextNotice = addNoticeWithAction(
      step >= 75 ? "warning" : "info",
      text + " " + hint,
      "Compact now",
      function () {
        // Compaction aborts whatever the agent is doing, so it is offered
        // only between turns rather than silently killing a running tool.
        if (working) {
          toast("Finish or stop the current turn first", 3000);
          return;
        }
        // Un-fire the step: a compact can be refused ("already in progress",
        // "session too small"), and the fill will not drop, so without this
        // the warning and its button would be gone for good.
        contextStepsFired[step] = false;
        post({ t: "compact" });
        toast("Compacting context…", 3000);
      },
    );
  }

  /** A fresh or compacted session starts the warning ladder over. */
  function resetContextWarnings() {
    contextStepsFired = {};
    if (contextNotice && contextNotice.isConnected) contextNotice.remove();
    contextNotice = null;
  }

  /** Notice carrying one button — the button removes the notice when used. */
  function addNoticeWithAction(level, text, actionText, onAction) {
    var el = addNotice(level, text);
    if (!el) return null;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "notice-action";
    btn.textContent = String(actionText);
    btn.addEventListener("click", function () {
      el.remove();
      if (contextNotice === el) contextNotice = null;
      onAction();
    });
    el.appendChild(btn);
    return el;
  }

  function addNotice(level, text) {
    if (!text) return null;
    level = (level === "warning" || level === "error") ? level : "info";
    var el = document.createElement("div");
    el.className = "notice " + level;
    el.textContent = String(text);
    appendToMessages(el);
    return el;
  }

  /* ------------------------------------------------------------------ */
  /* Working indicator / send-stop swap                                  */
  /* ------------------------------------------------------------------ */

  function setWorking(on) {
    working = !!on;
    workingEl.classList.toggle("hidden", !working);
    btnSend.classList.toggle("hidden", working);
    btnStop.classList.toggle("hidden", !working);
    if (!working) workingText.textContent = "Working…";
    if (working) { hideWelcome(); scrollBottom(); }
  }

  /* ------------------------------------------------------------------ */
  /* extension_ui_request: modal queue + immediate methods               */
  /* ------------------------------------------------------------------ */

  function respondUi(id, payload) {
    var frame = { type: "extension_ui_response", id: id };
    for (var k in payload) {
      if (Object.prototype.hasOwnProperty.call(payload, k)) frame[k] = payload[k];
    }
    post({ t: "uiResponse", frame: frame });
  }

  function onUiRequest(f) {
    var method = f.method;
    switch (method) {
      case "confirm":
      case "select":
      case "input":
      case "editor":
        modalQueue.push(f);
        pumpModals();
        return;
      case "notify":
        toast(f.message != null ? f.message : f.text, 4000);
        return;
      case "setStatus": {
        var s = f.status != null ? f.status : (f.message != null ? f.message : f.text);
        workingText.textContent = s ? String(s) : "Working…";
        return;
      }
      case "setTitle": {
        var t = f.title != null ? f.title : f.text;
        sessionTitle.textContent = t ? String(t) : "OMP Code";
        return;
      }
      case "set_editor_text":
        input.value = String(f.text != null ? f.text : (f.value != null ? f.value : ""));
        autogrow();
        return;
      case "open_url":
        // The host already opened the browser. Device-code providers also send
        // a one-time code in `instructions` — without it the page is a dead end.
        showAuthCard(f.url, f.instructions);
        return;
      case "cancel": {
        var target = f.targetId != null ? f.targetId : (f.requestId != null ? f.requestId : f.cancelId);
        if (target == null) return;
        modalQueue = modalQueue.filter(function (q) { return q.id !== target; });
        if (activeModal && activeModal.frame && activeModal.frame.id === target) {
          activeModal.el.remove();
          activeModal = null;
          pumpModals();
        }
        return; // no response for cancel
      }
      case "setWidget":
        return; // intentionally ignored
      default:
        return; // unknown methods: ignore silently
    }
  }

  function pumpModals() {
    if (activeModal || !modalQueue.length) return;
    showModal(modalQueue.shift());
  }

  function closeActiveModal() {
    if (!activeModal) return;
    activeModal.el.remove();
    activeModal = null;
    pumpModals();
  }

  function cancelActiveModal() {
    if (!activeModal) return;
    var id = activeModal.frame && activeModal.frame.id;
    closeActiveModal();
    respondUi(id, { cancelled: true });
  }

  function modalButton(label, primary, onClick) {
    var b = document.createElement("button");
    b.className = primary ? "btn primary" : "btn";
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  }

  function showModal(frame) {
    var el = document.createElement("div");
    el.className = "ui-modal";
    var method = frame.method;
    var id = frame.id;

    var titleText = frame.title != null ? String(frame.title)
      : method === "confirm" ? "Confirm"
      : method === "select" ? "Select"
      : method === "editor" ? "Edit"
      : "Input";
    var title = document.createElement("div");
    title.className = "modal-title";
    title.textContent = titleText;
    el.appendChild(title);

    var msgText = frame.message != null ? frame.message
      : (frame.prompt != null ? frame.prompt : "");
    if (msgText) {
      var msg = document.createElement("div");
      msg.className = "modal-msg md";
      msg.innerHTML = renderMarkdown(String(msgText));
      el.appendChild(msg);
    }

    var buttons = document.createElement("div");
    buttons.className = "modal-buttons";

    if (method === "confirm") {
      buttons.appendChild(modalButton("Deny", false, function () {
        closeActiveModal();
        respondUi(id, { confirmed: false });
      }));
      buttons.appendChild(modalButton("Allow", true, function () {
        closeActiveModal();
        respondUi(id, { confirmed: true });
      }));
      el.appendChild(buttons);
    } else if (method === "select") {
      var opts = Array.isArray(frame.options) ? frame.options
        : Array.isArray(frame.items) ? frame.items : [];
      var list = document.createElement("div");
      list.className = "modal-options";
      opts.forEach(function (opt) {
        var label, value;
        if (opt != null && typeof opt === "object") {
          label = opt.label != null ? opt.label : (opt.name != null ? opt.name : (opt.title != null ? opt.title : opt.value));
          value = opt.value != null ? opt.value : label;
        } else {
          label = String(opt);
          value = opt;
        }
        list.appendChild(modalButton(String(label != null ? label : ""), false, function () {
          closeActiveModal();
          respondUi(id, { value: value });
        }));
      });
      el.appendChild(list);
      buttons.appendChild(modalButton("Cancel", false, function () {
        closeActiveModal();
        respondUi(id, { cancelled: true });
      }));
      el.appendChild(buttons);
    } else { // input | editor
      var ta = document.createElement("textarea");
      ta.className = "ui-modal-input";
      ta.rows = method === "editor" ? 8 : 2;
      var prefill = frame.value != null ? frame.value
        : frame.prefill != null ? frame.prefill
        : frame.text != null ? frame.text
        : frame.default != null ? frame.default : "";
      ta.value = String(prefill);
      if (frame.placeholder) ta.placeholder = String(frame.placeholder);
      el.appendChild(ta);
      var submit = function () {
        closeActiveModal();
        respondUi(id, { value: ta.value });
      };
      if (method === "input") {
        ta.addEventListener("keydown", function (e) {
          if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
        });
      }
      buttons.appendChild(modalButton("Cancel", false, function () {
        closeActiveModal();
        respondUi(id, { cancelled: true });
      }));
      buttons.appendChild(modalButton("OK", true, submit));
      el.appendChild(buttons);
      setTimeout(function () { ta.focus(); }, 0);
    }

    modalHolder.appendChild(el);
    activeModal = { frame: frame, el: el };
  }

  /* ------------------------------------------------------------------ */
  /* API key setup card                                                  */
  /* ------------------------------------------------------------------ */

  // Rendered from the extension's keyed-provider table: keys = {id: configured},
  // keyedProviders = [{id,label,envVar,placeholder}] driving the setup form.
  var keyStatus = {};
  var keyedProviders = [];
  var setupCard = null;

  function keyPlaceholder(configured, hint) {
    return configured ? "configured ✓ (paste to replace)" : hint;
  }

  function showSetupCard() {
    if (setupCard) return;
    var el = document.createElement("div");
    el.className = "ui-modal setup-card";

    var title = document.createElement("div");
    title.className = "modal-title";
    title.textContent = "Connect API keys";
    el.appendChild(title);

    var msg = document.createElement("div");
    msg.className = "modal-msg";
    msg.textContent = "Sign in with your Claude subscription (no API key needed), or paste API keys below. Everything is stored in VS Code Secret Storage; the agent restarts after saving.";
    el.appendChild(msg);

    function signinRow(label, providerId) {
      var row = document.createElement("div");
      row.className = "modal-buttons setup-signin";
      row.appendChild(modalButton(label, true, function () {
        post({ t: "login", providerId: providerId });
        toast("Opening browser for sign-in…", 5000);
        closeSetupCard();
      }));
      el.appendChild(row);
    }
    signinRow("Sign in with Claude (Pro/Max)", "anthropic");
    signinRow("Sign in with Kimi Code (subscription)", "kimi-code");

    var divider = document.createElement("div");
    divider.className = "setup-divider";
    divider.textContent = "— or use API keys —";
    el.appendChild(divider);

    function field(labelText, hint, configured) {
      var wrap = document.createElement("div");
      wrap.className = "setup-field";
      var label = document.createElement("label");
      label.textContent = labelText;
      var inp = document.createElement("input");
      inp.type = "password";
      inp.placeholder = keyPlaceholder(configured, hint);
      inp.setAttribute("autocomplete", "off");
      wrap.appendChild(label);
      wrap.appendChild(inp);
      el.appendChild(wrap);
      return inp;
    }

    var inputs = [];
    keyedProviders.forEach(function (p) {
      var inp = field(p.label + " API key (" + p.envVar + ")", p.placeholder, keyStatus[p.id]);
      inputs.push({ id: p.id, inp: inp });
    });

    var buttons = document.createElement("div");
    buttons.className = "modal-buttons";
    buttons.appendChild(modalButton("Cancel", false, function () {
      closeSetupCard();
    }));
    buttons.appendChild(modalButton("Save & Restart", true, function () {
      var keys = {};
      var any = false;
      inputs.forEach(function (entry) {
        var v = entry.inp.value.trim();
        if (v) { keys[entry.id] = v; any = true; }
      });
      if (!any) { toast("Enter at least one key", 3000); return; }
      post({ t: "setKeys", keys: keys });
      toast("Saving keys, restarting agent…", 4000);
      closeSetupCard();
    }));
    el.appendChild(buttons);

    modalHolder.appendChild(el);
    setupCard = el;
    setTimeout(function () { if (inputs.length) inputs[0].inp.focus(); }, 0);
  }

  function closeSetupCard() {
    if (setupCard) { setupCard.remove(); setupCard = null; }
  }

  /* ------------------------------------------------------------------ */
  /* Session history                                                     */
  /* ------------------------------------------------------------------ */

  var historyCard = null;
  var historyList = null;

  function relativeTime(ms) {
    var diff = Date.now() - ms;
    if (!isFinite(diff)) return "";
    var min = Math.round(diff / 60000);
    if (min < 1) return "just now";
    if (min < 60) return min + "m ago";
    var hours = Math.round(min / 60);
    if (hours < 24) return hours + "h ago";
    var days = Math.round(hours / 24);
    if (days < 30) return days + "d ago";
    return new Date(ms).toLocaleDateString();
  }

  /** "kimi-code/k3" → "k3"; the provider is already implied by the model name. */
  function shortModel(id) {
    var s = String(id);
    var slash = s.indexOf("/");
    return slash >= 0 ? s.slice(slash + 1) : s;
  }

  function folderName(p) {
    var s = String(p || "").replace(/\/+$/, "");
    var slash = s.lastIndexOf("/");
    return slash >= 0 ? s.slice(slash + 1) : s;
  }

  function showHistoryCard() {
    closeHistoryCard();
    var el = document.createElement("div");
    el.className = "ui-modal history-card";

    var title = document.createElement("div");
    title.className = "modal-title";
    title.textContent = "Session history";
    el.appendChild(title);

    var filter = document.createElement("input");
    filter.className = "history-filter";
    filter.type = "text";
    filter.placeholder = "Filter sessions…";
    filter.setAttribute("aria-label", "Filter sessions");
    filter.addEventListener("input", function () {
      renderHistoryRows(filter.value.trim().toLowerCase());
    });
    el.appendChild(filter);

    historyList = document.createElement("div");
    historyList.className = "history-list";
    historyList.textContent = "Loading…";
    el.appendChild(historyList);

    var buttons = document.createElement("div");
    buttons.className = "modal-buttons";
    buttons.appendChild(modalButton("Close", false, function () { closeHistoryCard(); }));
    el.appendChild(buttons);

    modalHolder.appendChild(el);
    historyCard = el;
    filter.focus();
  }

  function closeHistoryCard() {
    if (historyCard) { historyCard.remove(); historyCard = null; historyList = null; }
  }

  /**
   * One flat list for the whole extension: every session, whatever model ran in
   * it. The model is a small badge on the row, not a grouping.
   */
  var historySessions = [];
  var historyCwd = "";

  function renderHistory(sessions, cwd) {
    historySessions = sessions;
    historyCwd = cwd || "";
    renderHistoryRows("");
  }

  function renderHistoryRows(query) {
    if (!historyList) return;
    historyList.textContent = "";
    var sessions = !query ? historySessions : historySessions.filter(function (s) {
      var hay = ((s.title || "") + " " + (s.preview || "") + " " + (s.cwd || "") +
        " " + (s.models || []).join(" ")).toLowerCase();
      return hay.indexOf(query) !== -1;
    });
    if (!sessions.length) {
      historyList.textContent = query ? "No sessions match." : "No sessions yet.";
      return;
    }
    sessions.forEach(function (s) {
      var row = document.createElement("div");
      row.className = "history-row";

      var main = document.createElement("div");
      main.className = "history-main";
      main.textContent = s.title || s.preview || "(untitled session)";
      row.appendChild(main);

      var meta = document.createElement("div");
      meta.className = "history-meta";

      (s.models || []).forEach(function (m) {
        var badge = document.createElement("span");
        badge.className = "history-badge";
        badge.textContent = shortModel(m);
        badge.title = m;
        meta.appendChild(badge);
      });

      var when = document.createElement("span");
      when.className = "history-dim";
      when.textContent = relativeTime(s.updatedAt) + " · " + s.userMessages +
        (s.userMessages === 1 ? " message" : " messages");
      meta.appendChild(when);

      if (s.cwd && historyCwd && s.cwd !== historyCwd) {
        var where = document.createElement("span");
        where.className = "history-dim";
        where.textContent = "· " + folderName(s.cwd);
        where.title = s.cwd;
        meta.appendChild(where);
      }

      row.appendChild(meta);
      row.addEventListener("click", function () {
        post({ t: "openSession", path: s.path });
        toast("Opening session…", 3000);
        closeHistoryCard();
      });
      historyList.appendChild(row);
    });
  }

  /** Replay a stored transcript into an empty view (host sends {t:"reset"} first). */
  function renderTranscript(messages) {
    currentAssistant = null;
    for (var i = 0; i < messages.length; i++) {
      var m = messages[i];
      if (!m) continue;
      if (m.role === "user") {
        if (m.synthetic) continue;
        addUserBubble(contentText(m.content));
      } else if (m.role === "assistant") {
        renderAssistant(newAssistantEntry(), m);
      } else if (m.role === "toolResult") {
        attachToolResult(m);
      }
    }
    currentAssistant = null;
    scrollBottom();
  }

  /* ------------------------------------------------------------------ */
  /* Sign-in card (OAuth redirect + device-code flows)                   */
  /* ------------------------------------------------------------------ */

  var authCard = null;
  var authProvider = null;

  var PROVIDER_LABELS = {
    "anthropic": "Claude (Pro / Max)",
    "kimi-code": "Kimi Code",
    "openai-codex": "OpenAI Codex",
    "zai": "Z.ai",
    "github-copilot": "GitHub Copilot",
    "cursor": "Cursor",
  };

  function providerLabel(id) {
    return PROVIDER_LABELS[id] || String(id || "provider");
  }

  /** Pull the one-time user code out of instructions like "Enter code: H6UP-C8H2". */
  function extractUserCode(instructions) {
    if (!instructions) return "";
    var m = String(instructions).match(/[A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+/);
    return m ? m[0] : "";
  }

  function showAuthCard(url, instructions) {
    closeAuthCard();
    var el = document.createElement("div");
    el.className = "ui-modal auth-card";

    var title = document.createElement("div");
    title.className = "modal-title";
    title.textContent = "Sign in to " + providerLabel(authProvider);
    el.appendChild(title);

    var code = extractUserCode(instructions);

    var msg = document.createElement("div");
    msg.className = "modal-msg";
    msg.textContent = code
      ? "A browser tab was opened. Confirm this code on the page, then come back — the agent restarts by itself once authorization goes through."
      : "A browser tab was opened. Finish the sign-in there; if a code is requested back here, an input box appears.";
    el.appendChild(msg);

    if (code) {
      var codeBox = document.createElement("div");
      codeBox.className = "auth-code";
      codeBox.textContent = code;
      el.appendChild(codeBox);
    } else if (instructions) {
      var raw = document.createElement("div");
      raw.className = "auth-instructions";
      raw.textContent = String(instructions);
      el.appendChild(raw);
    }

    if (url) {
      var link = document.createElement("div");
      link.className = "auth-url";
      link.textContent = String(url);
      el.appendChild(link);
    }

    var status = document.createElement("div");
    status.className = "auth-status";
    status.textContent = "Waiting for authorization…";
    el.appendChild(status);

    var buttons = document.createElement("div");
    buttons.className = "modal-buttons";
    if (code) {
      buttons.appendChild(modalButton("Copy code", false, function () {
        post({ t: "copy", text: code });
        toast("Code copied", 2000);
      }));
    }
    if (url) {
      buttons.appendChild(modalButton("Open page again", false, function () {
        post({ t: "openExternal", url: String(url) });
      }));
    }
    buttons.appendChild(modalButton("Hide", true, function () {
      closeAuthCard();
      toast("Sign-in still running in the background", 4000);
    }));
    el.appendChild(buttons);

    modalHolder.appendChild(el);
    authCard = el;
  }

  function closeAuthCard() {
    if (authCard) { authCard.remove(); authCard = null; }
  }

  /* ------------------------------------------------------------------ */
  /* Rejected-key card                                                   */
  /* ------------------------------------------------------------------ */

  var deadKeyCard = null;

  function showDeadKeyCard(which, label) {
    if (deadKeyCard) return;
    var el = document.createElement("div");
    el.className = "ui-modal deadkey-card";

    var title = document.createElement("div");
    title.className = "modal-title";
    title.textContent = "Stored " + label + " API key is rejected";
    el.appendChild(title);

    var msg = document.createElement("div");
    msg.className = "modal-msg";
    msg.textContent = "The provider answers 401 for every model behind this key, so they are hidden from the picker. Removing the key does not touch your subscription sign-ins.";
    el.appendChild(msg);

    var buttons = document.createElement("div");
    buttons.className = "modal-buttons";
    buttons.appendChild(modalButton("Keep it", false, function () {
      closeDeadKeyCard();
    }));
    buttons.appendChild(modalButton("Remove key", true, function () {
      post({ t: "clearKey", which: which });
      toast(label + " key removed — restarting agent", 4000);
      closeDeadKeyCard();
    }));
    el.appendChild(buttons);

    modalHolder.appendChild(el);
    deadKeyCard = el;
  }

  function closeDeadKeyCard() {
    if (deadKeyCard) { deadKeyCard.remove(); deadKeyCard = null; }
  }

  /* ------------------------------------------------------------------ */
  /* Menus (model / thinking / settings)                                 */
  /* ------------------------------------------------------------------ */

  function closeMenu() {
    if (openMenuEl) { openMenuEl.remove(); openMenuEl = null; openMenuAnchor = null; }
  }

  function addMenuLabel(menu, text) {
    var el = document.createElement("div");
    el.className = "menu-group-label";
    el.textContent = String(text);
    menu.appendChild(el);
  }

  function addMenuItem(menu, text, onClick) {
    var el = document.createElement("div");
    el.className = "menu-item";
    el.textContent = String(text);
    el.addEventListener("click", onClick);
    menu.appendChild(el);
    return el;
  }

  /**
   * Two-line menu row: the value on top, what it actually does underneath.
   * `current` draws the ✓ so a menu answers "what is set now" without a
   * second glance at the chip.
   */
  function addMenuChoice(menu, text, hint, current, onClick) {
    var el = document.createElement("div");
    el.className = "menu-item menu-choice" + (current ? " menu-choice-on" : "");
    var head = document.createElement("div");
    head.className = "menu-choice-head";
    head.textContent = (current ? "✓ " : "") + String(text);
    el.appendChild(head);
    if (hint) {
      var sub = document.createElement("div");
      sub.className = "menu-choice-hint";
      sub.textContent = String(hint);
      el.appendChild(sub);
    }
    el.addEventListener("click", onClick);
    menu.appendChild(el);
    return el;
  }

  /** Reflect the tier the agent is running under onto the access chip. */
  function setApprovalChip(mode) {
    if (!approvalChip) return;
    var m = null;
    for (var i = 0; i < APPROVAL_MODES.length; i++) {
      if (APPROVAL_MODES[i].id === mode) { m = APPROVAL_MODES[i]; break; }
    }
    if (!m) return;
    currentApproval = m.id;
    approvalChip.textContent = "access: " + m.short;
    approvalChip.title = m.label + " — " + m.hint;
    // Full access is the one setting that can run shell commands unattended;
    // it should not look like the other two.
    approvalChip.classList.toggle("chip-warn", m.id === "yolo");
  }

  /* ---- Model-family badge + profile inspector ---------------------- */

  /**
   * Show which family profile is in force. The host resolves a ModelProfile
   * per model and pushes it as `{ t: "profile", profile }`; anything unmatched
   * resolves to BASE_PROFILE, whose badge is the empty string — the chip hides
   * rather than showing an empty pill.
   */
  function setProfileChip(profile) {
    currentProfile = profile && typeof profile === "object" ? profile : null;
    if (!profileChip) return;
    var wasOpen = openMenuAnchor === profileChip;
    var badge = currentProfile && currentProfile.badge != null ? String(currentProfile.badge) : "";
    if (!badge) {
      profileChip.textContent = "";
      profileChip.removeAttribute("title");
      profileChip.classList.add("hidden");
      if (wasOpen) closeMenu();
      return;
    }
    var family = currentProfile.family != null ? String(currentProfile.family) : badge;
    profileChip.textContent = badge;
    profileChip.title = currentProfile.note
      ? family + " profile — " + String(currentProfile.note)
      : family + " profile — click to see what it sets";
    profileChip.classList.remove("hidden");
    // A profile can arrive while the card is open (model switch): rebuild it
    // in place rather than leaving stale values on screen.
    if (wasOpen) { closeMenu(); openMenu(profileChip, buildProfileMenu); }
  }

  function provenanceOf(profile, path) {
    var p = profile && profile.provenance;
    if (!p || typeof p !== "object") return null;
    return p[path] != null ? String(p[path]) : null;
  }

  function profileValueText(v) {
    if (v == null) return "—";
    if (typeof v === "string") return v;
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  }

  /**
   * One read-only inspector line: the effective value, and the layer that put
   * it there. Deliberately not a `menu-item` — nothing in this card is
   * clickable, and a hover highlight would promise otherwise.
   */
  function addProfileRow(menu, label, value, source) {
    // Only the three known layers reach the class name: a value off the wire
    // must never be pasted into `className` unchecked.
    var known = source && PROVENANCE_LABELS[source] ? String(source) : "";
    var row = document.createElement("div");
    row.className = "profile-row" + (known ? " profile-row-" + known : "");
    var head = document.createElement("div");
    head.className = "profile-row-head";
    var name = document.createElement("span");
    name.className = "profile-row-label";
    name.textContent = String(label);
    var val = document.createElement("span");
    val.className = "profile-row-value";
    val.textContent = profileValueText(value);
    head.appendChild(name);
    head.appendChild(val);
    row.appendChild(head);
    var src = document.createElement("div");
    src.className = "profile-row-src";
    src.textContent = known ? PROVENANCE_LABELS[known] : "unknown";
    row.appendChild(src);
    menu.appendChild(row);
    return row;
  }

  function buildProfileMenu(menu) {
    var p = currentProfile;
    if (!p) {
      addMenuLabel(menu, "profile");
      addMenuItem(menu, "No profile resolved yet", function () { closeMenu(); });
      return;
    }
    addMenuLabel(menu, "profile — " + (p.family != null ? String(p.family) : "generic"));

    if (p.note) {
      var note = document.createElement("div");
      note.className = "profile-note";
      note.textContent = String(p.note);
      menu.appendChild(note);
    }

    var runtime = p.runtime && typeof p.runtime === "object" ? p.runtime : {};
    var spawn = p.spawn && typeof p.spawn === "object" ? p.spawn : {};
    var rows = 0;

    if (p.contextFile != null && p.contextFile !== "") {
      addProfileRow(menu, "instructions file", p.contextFile, provenanceOf(p, "contextFile"));
      rows++;
    }
    if (runtime.thinking != null) {
      addProfileRow(menu, "thinking", runtime.thinking, provenanceOf(p, "runtime.thinking"));
      rows++;
    }
    if (spawn.approvalMode != null) {
      var accessRow = addProfileRow(menu, "tool access", spawn.approvalMode,
        provenanceOf(p, "spawn.approvalMode"));
      // The raw id is what a settings row would carry, so that is what the
      // value shows; the plain-English reading goes on the tooltip.
      for (var i = 0; i < APPROVAL_MODES.length; i++) {
        if (APPROVAL_MODES[i].id === spawn.approvalMode) {
          accessRow.title = APPROVAL_MODES[i].label + " — " + APPROVAL_MODES[i].hint;
          break;
        }
      }
      rows++;
    }

    var overlay = spawn.overlay && typeof spawn.overlay === "object" ? spawn.overlay : null;
    var keys = overlay ? Object.keys(overlay) : [];
    if (keys.length) {
      addMenuLabel(menu, "settings overlay");
      keys.forEach(function (k) {
        // The resolver records provenance for `spawn.overlay` as a single
        // field. A per-key entry wins if a later layer ever records one.
        var src = provenanceOf(p, "spawn.overlay." + k) || provenanceOf(p, "spawn.overlay");
        addProfileRow(menu, k, overlay[k], src);
      });
      rows += keys.length;
    }

    if (!rows) {
      addMenuItem(menu, "This profile sets nothing", function () { closeMenu(); });
    }
    addMenuLabel(menu, "read-only — edit ompcode.modelProfiles to change");
  }

  /**
   * Which thinking levels this model actually accepts.
   *
   * omp reports the real ladder per model as `thinking.efforts` and it differs
   * sharply — claude-opus-5 is [low..max] with no `minimal`, qwen3.8-max is
   * [minimal..high] with no `xhigh`, kimi-code/k3 is [low, high, max] and
   * cannot be turned off at all (`requiresEffort`). A model with
   * `reasoning: false` has no ladder whatsoever. Offering the full 8-item list
   * everywhere means most entries silently clamp to something else.
   */
  function thinkingChoicesFor(model) {
    var t = model && typeof model === "object" ? model.thinking : null;
    var efforts = t && Array.isArray(t.efforts) ? t.efforts.slice() : null;
    if (!efforts || !efforts.length) {
      // No reasoning support, or a model omp could not classify (custom
      // provider). Fall back to the full list rather than an empty menu.
      var reasons = model && typeof model === "object" && model.reasoning === false;
      return { levels: reasons ? [] : THINKING_LEVELS.slice(), unknown: !reasons, none: !!reasons };
    }
    var out = [];
    // `off` only when thinking is not mandatory server-side.
    if (!t.requiresEffort) out.push("off");
    efforts.forEach(function (e) { if (THINKING_HINTS[e] != null) out.push(e); });
    out.push("auto");
    return { levels: out, unknown: false, none: false };
  }

  function openMenu(anchor, build) {
    if (openMenuEl && openMenuAnchor === anchor) { closeMenu(); return; }
    closeMenu();
    var menu = document.createElement("div");
    menu.className = "menu";
    build(menu);
    menuHolder.appendChild(menu);
    menu.style.position = "fixed";
    var r = anchor.getBoundingClientRect();
    var w = menu.offsetWidth || 200;
    var left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
    // Menus anchored near the right edge (e.g. the settings gear) right-align.
    if (r.right > window.innerWidth - 24) {
      left = Math.max(8, r.right - w);
    }
    menu.style.left = left + "px";
    // Anchors in the top half (topbar) open downward; bottom ones upward.
    if (r.top < window.innerHeight / 2) {
      menu.style.top = (r.bottom + 6) + "px";
      menu.style.bottom = "auto";
      menu.style.maxHeight = Math.max(80, window.innerHeight - r.bottom - 14) + "px";
    } else {
      menu.style.bottom = (window.innerHeight - r.top + 6) + "px";
      menu.style.top = "auto";
      menu.style.maxHeight = Math.max(80, r.top - 14) + "px";
    }
    openMenuEl = menu;
    openMenuAnchor = anchor;
  }

  document.addEventListener("mousedown", function (e) {
    if (!openMenuEl) return;
    if (openMenuEl.contains(e.target)) return;
    if (openMenuAnchor && openMenuAnchor.contains(e.target)) return; // let click toggle
    closeMenu();
  });

  /** Verified-model state, pushed by the host as probes land. */
  var probe = { results: {}, running: false, enabled: true };
  var showAllModels = false;

  function probeVerdict(m) {
    return probe.results[String(m.provider) + "/" + String(m.id)];
  }

  /**
   * Models the picker offers. With verification on, that's the ones that
   * answered a live request; unprobed models stay visible while the run is
   * still going so the menu is never empty.
   */
  function usableModels() {
    if (!probe.enabled || showAllModels) return models;
    var verified = models.filter(function (m) {
      var v = probeVerdict(m);
      return v && v.ok;
    });
    if (verified.length) return verified;
    return probe.running ? models : [];
  }

  function buildModelMenu(menu) {
    if (!models.length) {
      addMenuLabel(menu, "models");
      addMenuItem(menu, "Loading models…", function () { closeMenu(); });
      return;
    }
    var list = usableModels();
    var hidden = models.length - list.length;

    if (probe.enabled && probe.running) {
      addMenuLabel(menu, "checking subscriptions…");
    }
    if (!list.length) {
      addMenuLabel(menu, "models");
      addMenuItem(menu, "No model answered — check your sign-ins", function () { closeMenu(); });
    }

    var byProv = {};
    var order = [];
    list.forEach(function (m) {
      if (!m) return;
      var p = m.provider != null ? String(m.provider) : "other";
      if (!byProv[p]) { byProv[p] = []; order.push(p); }
      byProv[p].push(m);
    });
    order.forEach(function (prov) {
      addMenuLabel(menu, prov);
      byProv[prov].forEach(function (m) {
        var label = m.name != null ? m.name : (m.id != null ? m.id : "?");
        var v = probeVerdict(m);
        if (showAllModels && v && !v.ok) {
          label += "  ✕ " + (v.status != null ? v.status : "failed");
        }
        var item = addMenuItem(menu, label, function () {
          post({ t: "setModel", provider: m.provider, modelId: m.id });
          modelChip.textContent = m.name != null ? m.name : (m.id != null ? m.id : "model");
          closeMenu();
        });
        if (v && !v.ok) item.classList.add("menu-item-dead");
      });
    });

    if (!probe.enabled) return;
    addMenuLabel(menu, "verification");
    if (hidden > 0 || showAllModels) {
      addMenuItem(menu, showAllModels ? "Hide models that failed" : "Show all models (" + hidden + " hidden)", function () {
        showAllModels = !showAllModels;
        closeMenu();
        openMenu(modelChip, buildModelMenu);
      });
    }
    addMenuItem(menu, probe.running ? "Checking…" : "Re-check subscriptions", function () {
      if (probe.running) return;
      post({ t: "recheckModels" });
      toast("Checking which models answer…", 4000);
      closeMenu();
    });
  }

  modelChip.addEventListener("click", function () {
    if (!models.length) post({ t: "getModels" });
    openMenu(modelChip, buildModelMenu);
  });

  thinkingChip.addEventListener("click", function () {
    openMenu(thinkingChip, function (menu) {
      var choice = thinkingChoicesFor(currentModel);
      var name = currentModel && currentModel.name ? currentModel.name
        : (currentModel && currentModel.id ? currentModel.id : null);
      addMenuLabel(menu, name ? "thinking — " + name : "thinking");

      if (choice.none) {
        addMenuChoice(menu, "Not supported", "This model does not reason — nothing to set", false, function () {
          closeMenu();
        });
        return;
      }
      if (choice.unknown) {
        addMenuLabel(menu, "levels unverified for this model");
      }
      choice.levels.forEach(function (level) {
        addMenuChoice(menu, level, THINKING_HINTS[level], level === thinkingChoice, function () {
          post({ t: "setThinking", level: level });
          thinkingChoice = level;
          currentThinking = level;
          thinkingChip.textContent = "think: " + level;
          closeMenu();
        });
      });
    });
  });

  // Guarded like btnHistory: an older skeleton without this chip must degrade
  // to "no access chip", never to a module-level throw.
  if (approvalChip) {
    approvalChip.addEventListener("click", function () {
      openMenu(approvalChip, function (menu) {
        addMenuLabel(menu, "tool access");
        APPROVAL_MODES.forEach(function (m) {
          addMenuChoice(menu, m.label, m.hint, m.id === currentApproval, function () {
            closeMenu();
            if (m.id === currentApproval) return;
            post({ t: "setApproval", mode: m.id });
            setApprovalChip(m.id);
            toast("Tool access: " + m.label + " — restarting agent", 4000);
          });
        });
        addMenuLabel(menu, "changing this restarts the agent");
      });
    });
  }

  // Guarded like btnHistory and the access chip: the badge is optional, so an
  // older skeleton must degrade to "no badge", never to a module-level throw.
  if (profileChip) {
    profileChip.addEventListener("click", function () {
      openMenu(profileChip, buildProfileMenu);
    });
  }

  btnSettings.addEventListener("click", function () {
    openMenu(btnSettings, function (menu) {
      addMenuLabel(menu, "OMP Code");
      addMenuItem(menu, "New chat tab", function () {
        closeMenu();
        post({ t: "openNewTab" });
      });
      addMenuItem(menu, "Clear this session", function () {
        closeMenu();
        post({ t: "newSession" });
      });
      addMenuItem(menu, "Export transcript as Markdown", function () {
        closeMenu();
        post({ t: "exportTranscript" });
      });
      addMenuItem(menu, "Sign in with Claude (Pro/Max)", function () {
        closeMenu();
        post({ t: "login", providerId: "anthropic" });
        toast("Opening browser for sign-in…", 5000);
      });
      addMenuItem(menu, "Sign in with Kimi Code", function () {
        closeMenu();
        post({ t: "login", providerId: "kimi-code" });
        toast("Opening browser for sign-in…", 5000);
      });
      addMenuItem(menu, "API keys…", function () {
        closeMenu();
        showSetupCard();
      });
      keyedProviders.forEach(function (p) {
        if (!keyStatus[p.id]) return;
        addMenuItem(menu, "Remove stored " + p.label + " API key", function () {
          closeMenu();
          post({ t: "clearKey", which: p.id });
          toast(p.label + " key removed — restarting agent", 4000);
        });
      });
      addMenuItem(menu, "Re-check which models work", function () {
        closeMenu();
        post({ t: "recheckModels" });
        toast("Checking which models answer…", 4000);
      });
      addMenuItem(menu, "Run diagnostics", function () {
        closeMenu();
        post({ t: "diagnostics" });
        toast("Running diagnostics…", 4000);
      });
      addMenuItem(menu, "Compact context", function () {
        post({ t: "compact" });
        toast("Compacting context…", 3000);
        closeMenu();
      });
      addMenuItem(menu, "Restart agent", function () {
        post({ t: "restart" });
        toast("Restarting agent…", 3000);
        closeMenu();
      });
    });
  });

  /* ------------------------------------------------------------------ */
  /* Slash command popup                                                 */
  /* ------------------------------------------------------------------ */

  function cmdName(c) {
    if (c == null) return "";
    if (typeof c === "string") return c.replace(/^\//, "");
    var n = c.name != null ? c.name : (c.command != null ? c.command : "");
    return String(n).replace(/^\//, "");
  }

  function cmdDesc(c) {
    if (c == null || typeof c !== "object") return "";
    return String(c.description != null ? c.description : "");
  }

  function slashVisible() {
    return !slashPopup.classList.contains("hidden");
  }

  function hideSlash() {
    slashPopup.classList.add("hidden");
    slashPopup.innerHTML = "";
    slashItems = [];
    slashSel = 0;
  }

  function updateSlash() {
    var m = /^\/(\S*)$/.exec(input.value);
    if (!m || !commands.length) { hideSlash(); return; }
    var q = m[1].toLowerCase();
    slashItems = commands.filter(function (c) {
      return cmdName(c).toLowerCase().indexOf(q) !== -1;
    }).slice(0, 30);
    if (!slashItems.length) { hideSlash(); return; }
    if (slashSel >= slashItems.length) slashSel = slashItems.length - 1;
    renderSlash();
  }

  function renderSlash() {
    slashPopup.innerHTML = "";
    slashItems.forEach(function (c, i) {
      var el = document.createElement("div");
      el.className = "menu-item" + (i === slashSel ? " active" : "");
      if (i === slashSel) el.style.background = "var(--vscode-list-hoverBackground)";
      var name = document.createElement("span");
      name.className = "slash-name";
      name.textContent = "/" + cmdName(c);
      el.appendChild(name);
      var desc = cmdDesc(c);
      if (desc) {
        var d = document.createElement("span");
        d.className = "slash-desc";
        d.textContent = " " + desc;
        el.appendChild(d);
      }
      el.addEventListener("mousedown", function (e) { e.preventDefault(); pickSlash(i); });
      slashPopup.appendChild(el);
    });
    slashPopup.classList.remove("hidden");
  }

  function pickSlash(i) {
    var c = slashItems[i];
    if (!c) return;
    input.value = "/" + cmdName(c) + " ";
    hideSlash();
    input.focus();
    autogrow();
  }

  /* ------------------------------------------------------------------ */
  /* @-mention file popup                                                */
  /* ------------------------------------------------------------------ */

  var atItems = [];
  var atSel = 0;
  var atSeq = 0;          // request token; stale replies are dropped
  var atPendingToken = "";
  var atDebounce = 0;

  function atVisible() {
    return !atPopup.classList.contains("hidden");
  }

  function hideAt() {
    atPopup.classList.add("hidden");
    atPopup.innerHTML = "";
    atItems = [];
    atSel = 0;
    atPendingToken = "";
    if (atDebounce) { clearTimeout(atDebounce); atDebounce = 0; }
  }

  /** The `@query` token ending at the caret, if the caret is inside one. */
  function atQuery() {
    var caret = input.selectionStart;
    if (caret !== input.selectionEnd) return null; // selection, not a caret
    var m = /(^|[\s(])@([\w./+-]*)$/.exec(input.value.slice(0, caret));
    return m ? { query: m[2], start: caret - m[2].length - 1 } : null;
  }

  function updateAt() {
    var hit = atQuery();
    if (!hit || !hit.query) { hideAt(); return; }
    clearTimeout(atDebounce);
    atDebounce = setTimeout(function () {
      var token = "f" + (++atSeq);
      atPendingToken = token;
      post({ t: "findFiles", query: hit.query, token: token });
    }, 120);
  }

  function renderAt() {
    atPopup.innerHTML = "";
    atItems.forEach(function (f, i) {
      var el = document.createElement("div");
      el.className = "menu-item" + (i === atSel ? " active" : "");
      if (i === atSel) el.style.background = "var(--vscode-list-hoverBackground)";
      var name = document.createElement("span");
      name.className = "slash-name";
      name.textContent = f.name;
      el.appendChild(name);
      var dir = document.createElement("span");
      dir.className = "slash-desc";
      dir.textContent = " " + f.relative;
      el.appendChild(dir);
      el.addEventListener("mousedown", function (e) { e.preventDefault(); pickAt(i); });
      atPopup.appendChild(el);
    });
    atPopup.classList.remove("hidden");
  }

  function pickAt(i) {
    var f = atItems[i];
    if (!f) return;
    // Remove the `@query` token; the file itself travels as a chip, so the
    // agent gets a validated absolute path rather than loose text.
    var hit = atQuery();
    if (hit) {
      var caret = input.selectionStart;
      input.value = input.value.slice(0, hit.start) + input.value.slice(caret);
      input.selectionStart = input.selectionEnd = hit.start;
    }
    hideAt();
    attachPaths([f.path]);
    input.focus();
    autogrow();
  }

  /* ------------------------------------------------------------------ */
  /* Palette                                                             */
  /* ------------------------------------------------------------------ */

  var THEMES = ["violet", "coral", "emerald", "amber", "magenta"];

  /**
   * Palette comes from settings: the preset switches body[data-theme], the
   * optional custom accent is written through the CSSOM because our CSP
   * forbids an inline <style> block.
   */
  function applyTheme(theme, accentColor) {
    var id = THEMES.indexOf(String(theme || "")) >= 0 ? String(theme) : "violet";
    document.body.setAttribute("data-theme", id);
    var custom = String(accentColor || "").trim();
    var root = document.documentElement;
    if (custom && window.CSS && CSS.supports && CSS.supports("color", custom)) {
      root.style.setProperty("--accent", custom);
      root.style.setProperty("--accent-strong", custom);
      root.style.setProperty("--accent-quiet", custom);
    } else {
      root.style.removeProperty("--accent");
      root.style.removeProperty("--accent-strong");
      root.style.removeProperty("--accent-quiet");
      if (custom) toast("Ignoring ompcode.accentColor: " + custom + " is not a CSS color", 6000);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Attachments                                                         */
  /* ------------------------------------------------------------------ */

  /** 12345 → "12.3k" — token counts on the stats chip. */
  function compactNum(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(1) + "k";
    return String(Math.round(n));
  }

  function formatSize(bytes) {    if (typeof bytes !== "number" || !isFinite(bytes) || bytes < 0) return "";
    if (bytes < 1024) return bytes + " B";
    var units = ["KB", "MB", "GB"];
    var value = bytes / 1024;
    var unit = 0;
    while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
    return (value < 10 ? value.toFixed(1) : Math.round(value)) + " " + units[unit];
  }

  function renderAttachments() {
    attachmentsEl.innerHTML = "";
    attachments.forEach(function (att, i) {
      var chip = document.createElement("span");
      chip.className = "att-chip" + (att.pending ? " pending" : "") + (att.selection ? " selection" : "");
      var range = att.selection ? ":" + att.selection.startLine + "-" + att.selection.endLine : "";
      chip.title = att.pending ? "Copying…" : att.path + (att.selection ? " (lines " + att.selection.startLine + "–" + att.selection.endLine + ")" : "");

      var icon = document.createElement("span");
      icon.className = "att-icon";
      icon.textContent = att.selection ? "✂" : "📎";
      chip.appendChild(icon);

      var name = document.createElement("span");
      name.className = "att-name";
      name.textContent = att.name + range;
      chip.appendChild(name);

      var size = formatSize(att.size);
      if (size) {
        var sizeEl = document.createElement("span");
        sizeEl.className = "att-size";
        sizeEl.textContent = size;
        chip.appendChild(sizeEl);
      }

      var rm = document.createElement("button");
      rm.className = "att-remove";
      rm.type = "button";
      rm.title = "Remove";
      rm.setAttribute("aria-label", "Remove " + att.name);
      rm.textContent = "✕";
      rm.addEventListener("click", function () {
        attachments.splice(i, 1);
        renderAttachments();
      });
      chip.appendChild(rm);

      attachmentsEl.appendChild(chip);
    });
  }

  /** Confirmed attachments only — pending ones are not sendable yet. */
  function readyAttachments() {
    return attachments.filter(function (a) { return !a.pending && a.path; });
  }

  function addAttachment(att) {
    // Same file twice = one chip, but a whole file and a selection from it
    // (or two different ranges) are distinct context.
    var key = att.path + (att.selection ? "#L" + att.selection.startLine + "-" + att.selection.endLine : "");
    var already = attachments.some(function (a) {
      var k = a.path + (a.selection ? "#L" + a.selection.startLine + "-" + a.selection.endLine : "");
      return a.path && k === key;
    });
    if (already) return;
    attachments.push(att);
  }

  /** Ask the host to resolve real filesystem paths (picker, editor drags). */
  function attachPaths(paths) {
    if (!paths || !paths.length) return;
    post({ t: "attachPaths", paths: paths });
  }

  /**
   * Bytes with no path (clipboard image, Finder drag): show a pending chip and
   * ship the payload to the host, which spills it to extension storage.
   */
  function attachFile(file) {
    if (!file) return;
    var token = "a" + (++attachSeq);
    attachments.push({ token: token, name: file.name || "pasted-file", size: file.size, pending: true });
    renderAttachments();
    var reader = new FileReader();
    reader.onload = function () {
      var buf = reader.result;
      var bytes = new Uint8Array(buf);
      var binary = "";
      var CHUNK = 0x8000; // String.fromCharCode blows the stack on big arrays
      for (var i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
      }
      post({
        t: "attachData",
        token: token,
        name: file.name || "pasted-file",
        mime: file.type || "",
        data: btoa(binary),
      });
    };
    reader.onerror = function () {
      dropPending(token);
      toast("Could not read " + (file.name || "the pasted file"), 5000);
    };
    reader.readAsArrayBuffer(file);
  }

  function dropPending(token) {
    attachments = attachments.filter(function (a) { return a.token !== token; });
    renderAttachments();
  }

  /**
   * One entry point for every source of files: prefer real paths (nothing is
   * copied), fall back to bytes.
   */
  function ingestDataTransfer(dt) {
    if (!dt) return false;
    var paths = [];
    var types = dt.types ? Array.prototype.slice.call(dt.types) : [];
    ["application/vnd.code.uri-list", "text/uri-list"].forEach(function (type) {
      if (types.indexOf(type) < 0) return;
      var raw = "";
      try { raw = dt.getData(type); } catch (e) { raw = ""; }
      if (raw) paths.push(raw);
    });
    if (paths.length) {
      attachPaths(paths.join("\n").split(/\r?\n/));
      return true;
    }
    var files = dt.files;
    if (files && files.length) {
      for (var i = 0; i < files.length; i++) attachFile(files[i]);
      return true;
    }
    // A single absolute path pasted as plain text is a file reference too.
    var text = "";
    try { text = dt.getData("text/plain") || ""; } catch (e) { text = ""; }
    var trimmed = text.trim();
    if (trimmed && /^(\/|[A-Za-z]:[\\/])/.test(trimmed) && trimmed.indexOf("\n") < 0) {
      attachPaths([trimmed]);
      return true;
    }
    return false;
  }

  btnAttach.addEventListener("click", function () { post({ t: "pickFiles" }); });

  // Ctrl/Cmd+V: files on the clipboard become attachments, text keeps its
  // default paste behaviour.
  document.addEventListener("paste", function (e) {
    var dt = e.clipboardData;
    if (!dt) return;
    var hasFiles = (dt.files && dt.files.length > 0) ||
      (dt.types && Array.prototype.indexOf.call(dt.types, "Files") >= 0);
    if (!hasFiles) return;
    e.preventDefault();
    if (!ingestDataTransfer(dt)) {
      toast("Nothing attachable on the clipboard", 4000);
    }
  });

  // Drag & drop. VS Code only forwards a drop into a webview while Shift is
  // held; without it the editor swallows the drag and nothing arrives here.
  window.addEventListener("dragenter", function (e) {
    if (!e.dataTransfer) return;
    dragDepth++;
    dropOverlay.classList.remove("hidden");
  });
  window.addEventListener("dragover", function (e) {
    if (!e.dataTransfer) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    dropOverlay.classList.remove("hidden");
  });
  window.addEventListener("dragleave", function () {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropOverlay.classList.add("hidden");
  });
  window.addEventListener("drop", function (e) {
    e.preventDefault();
    dragDepth = 0;
    dropOverlay.classList.add("hidden");
    if (!ingestDataTransfer(e.dataTransfer)) {
      toast("Nothing attachable in that drop", 4000);
    }
    input.focus();
  });

  /* ------------------------------------------------------------------ */
  /* Composer                                                            */
  /* ------------------------------------------------------------------ */

  function autogrow() {
    input.style.height = "auto";
    var max = 168; // ~8 lines
    input.style.height = Math.min(input.scrollHeight, max) + "px";
  }

  function sendPrompt() {
    var text = input.value.trim();
    var files = readyAttachments();
    if (!text && files.length === 0) return;
    if (attachments.length !== files.length) {
      toast("Still copying an attachment…", 3000);
      return;
    }
    post({ t: "prompt", text: text, attachments: files });
    if (text && promptHistory[promptHistory.length - 1] !== text) {
      promptHistory.push(text);
      if (promptHistory.length > 100) promptHistory.shift();
    }
    historyIdx = -1;
    historyDraft = "";
    pendingLocalUser++;
    addUserBubble(text, files);
    input.value = "";
    attachments = [];
    renderAttachments();
    autogrow();
    hideSlash();
    hideAt();
    setWorking(true);
    stuck = true;
    scrollBottom();
  }

  input.addEventListener("input", function () {
    autogrow();
    updateSlash();
    updateAt();
  });

  input.addEventListener("keydown", function (e) {
    if (atVisible()) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        atSel = (atSel + 1) % atItems.length;
        renderAt();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        atSel = (atSel - 1 + atItems.length) % atItems.length;
        renderAt();
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickAt(atSel);
        return;
      }
    }
    if (slashVisible()) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        slashSel = (slashSel + 1) % slashItems.length;
        renderSlash();
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        slashSel = (slashSel - 1 + slashItems.length) % slashItems.length;
        renderSlash();
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        pickSlash(slashSel);
        return;
      }
    }
    if (e.key === "ArrowUp" && promptHistory.length && input.selectionStart === 0 && input.selectionEnd === 0) {
      // Shell-style recall, only when the caret sits at the very start so a
      // multi-line draft keeps its normal cursor movement everywhere else.
      e.preventDefault();
      if (historyIdx === -1) {
        historyDraft = input.value;
        historyIdx = promptHistory.length - 1;
      } else if (historyIdx > 0) {
        historyIdx--;
      }
      input.value = promptHistory[historyIdx];
      input.selectionStart = input.selectionEnd = input.value.length;
      autogrow();
      return;
    }
    if (e.key === "ArrowDown" && historyIdx !== -1 && input.selectionStart === input.value.length) {
      e.preventDefault();
      historyIdx++;
      if (historyIdx >= promptHistory.length) {
        historyIdx = -1;
        input.value = historyDraft;
      } else {
        input.value = promptHistory[historyIdx];
      }
      input.selectionStart = input.selectionEnd = input.value.length;
      autogrow();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendPrompt();
    }
  });

  btnSend.addEventListener("click", sendPrompt);
  btnStop.addEventListener("click", function () { post({ t: "abort" }); });
  // Guarded: a skeleton without this button must degrade to "no history
  // button", never to a module-level throw that kills the whole webview.
  if (btnHistory) {
    btnHistory.addEventListener("click", function () {
      if (historyCard) { closeHistoryCard(); return; }
      showHistoryCard();
      post({ t: "getHistory" });
    });
  }

  btnNew.addEventListener("click", function () { post({ t: "openNewTab" }); });
  btnRestart.addEventListener("click", function () {
    post({ t: "restart" });
    procBanner.classList.add("hidden");
    toast("Restarting agent…", 3000);
  });

  // Global Escape: modal > menu > slash popup > abort
  document.addEventListener("keydown", function (e) {
    if (e.key !== "Escape") return;
    if (activeModal) { cancelActiveModal(); return; }
    if (openMenuEl) { closeMenu(); return; }
    if (slashVisible()) { hideSlash(); return; }
    if (atVisible()) { hideAt(); return; }
    if (working) post({ t: "abort" });
  });

  // Delegated clicks: markdown links, thinking + tool card toggles
  document.addEventListener("click", function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var a = t.closest("a[data-href]");
    if (a) {
      e.preventDefault();
      post({ t: "openExternal", url: a.getAttribute("data-href") });
      return;
    }
    var th = t.closest(".thinking-head");
    if (th && th.parentElement) {
      th.parentElement.classList.toggle("collapsed");
      return;
    }
    var diffBtnEl = t.closest(".tool-diff");
    if (diffBtnEl) {
      post({ t: "openDiff", toolCallId: diffBtnEl.getAttribute("data-id") });
      return;
    }
    var head = t.closest(".tool-head");
    if (head) { toggleTool(head.closest(".tool-card")); return; }
    var more = t.closest(".tool-more");
    if (more) { toggleTool(more.closest(".tool-card")); return; }
    var insertBtn = t.closest(".code-insert");
    if (insertBtn) {
      var block = insertBtn.closest(".code-block");
      var src = block && block.querySelector("pre code");
      if (src) {
        post({ t: "insertAtCursor", text: src.textContent });
        insertBtn.textContent = "inserted";
        setTimeout(function () { insertBtn.textContent = "insert"; }, 1500);
      }
      return;
    }
    var copyBtn = t.closest(".code-copy");
    if (copyBtn) {
      var pre = copyBtn.closest(".code-block") && copyBtn.closest(".code-block").querySelector("pre code");
      if (pre) {
        var text = pre.textContent;
        try {
          navigator.clipboard.writeText(text).then(function () {
            copyBtn.textContent = "copied";
            copyBtn.classList.add("copied");
            setTimeout(function () {
              copyBtn.textContent = "copy";
              copyBtn.classList.remove("copied");
            }, 1500);
          });
        } catch (err) { /* clipboard unavailable */ }
      }
      return;
    }
  });

  /* ------------------------------------------------------------------ */
  /* State / models / commands rendering                                 */
  /* ------------------------------------------------------------------ */

  function applyState(state) {
    if (!state || typeof state !== "object") return;
    var model = state.model;
    if (model && typeof model === "object") {
      currentModel = model;
      modelChip.textContent = model.name != null ? model.name : (model.id != null ? model.id : "model");
    } else if (typeof model === "string" && model) {
      modelChip.textContent = model;
    }
    if (state.thinkingLevel != null) {
      currentThinking = String(state.thinkingLevel);
      // Under `auto` the reported level changes per turn and is a result, not
      // a selection — keep the ✓ on `auto` but show what it resolved to.
      if (thinkingChoice === "auto") {
        thinkingChip.textContent = "think: auto → " + currentThinking;
      } else {
        thinkingChoice = currentThinking;
        thinkingChip.textContent = "think: " + currentThinking;
      }
    }
    if (state.sessionName) sessionTitle.textContent = String(state.sessionName);

    // Context fill is not shown as a chip: a number that reads 2% for most of
    // a session is noise. It surfaces only once it starts to matter.
    autoCompaction = state.autoCompactionEnabled !== false;
    noteContextFill(contextPercent(state.contextUsage, model), autoCompaction);

    if (typeof state.isStreaming === "boolean") setWorking(state.isStreaming);
  }

  /* ------------------------------------------------------------------ */
  /* Reset                                                               */
  /* ------------------------------------------------------------------ */

  function resetView() {
    var kids = Array.prototype.slice.call(messagesEl.children);
    kids.forEach(function (el) {
      if (el === welcomeEl || el === workingEl) return;
      el.remove();
    });
    welcomeEl.classList.remove("hidden");
    byToolCallId.clear();
    currentAssistant = null;
    pendingLocalUser = 0;
    retryNotice = null;
    compactNotice = null;
    resetContextWarnings();
    attachments = [];
    renderAttachments();
    setWorking(false);
    hideSlash();
    hideAt();
    closeMenu();
    modalQueue = [];
    if (activeModal) { activeModal.el.remove(); activeModal = null; }
    stuck = true;
    sessionTitle.textContent = "OMP Code";
  }

  /* ------------------------------------------------------------------ */
  /* Frame dispatch                                                      */
  /* ------------------------------------------------------------------ */

  function handleFrame(f) {
    if (!f || typeof f !== "object") return;
    switch (f.type) {
      case "agent_start":
        setWorking(true);
        break;
      case "agent_end":
        setWorking(false);
        currentAssistant = null;
        break;
      case "turn_start":
      case "turn_end":
        break;
      case "message_start":
        onMessageStart(f.message);
        break;
      case "message_update":
        onMessageUpdate(f.message);
        break;
      case "message_end":
        onMessageEnd(f.message);
        break;
      case "tool_execution_start": {
        var c1 = ensureToolCard(f.toolCallId, f.toolName, f.args);
        c1.dataset.status = "running";
        break;
      }
      case "tool_execution_update": {
        var c2 = ensureToolCard(f.toolCallId, f.toolName, f.args);
        if (f.partialResult != null) setToolBody(c2, resultText(f.partialResult));
        break;
      }
      case "tool_execution_end": {
        var c3 = ensureToolCard(f.toolCallId, f.toolName);
        c3.dataset.status = f.isError ? "error" : "ok";
        if (f.result != null) setToolBody(c3, resultText(f.result));
        break;
      }
      case "notice":
        addNotice(f.level, f.message);
        break;
      case "auto_retry_start": {
        var att = f.attempt != null ? f.attempt : "?";
        var max = f.maxAttempts != null ? f.maxAttempts : "?";
        var txt = "Retrying (" + att + "/" + max + ")" +
          (typeof f.delayMs === "number" ? " in " + Math.round(f.delayMs / 100) / 10 + "s" : "") +
          (f.errorMessage ? " — " + f.errorMessage : "");
        if (retryNotice && retryNotice.isConnected) retryNotice.textContent = txt;
        else retryNotice = addNotice("info", txt);
        break;
      }
      case "auto_retry_end":
        if (retryNotice) { retryNotice.remove(); retryNotice = null; }
        break;
      case "auto_compaction_start":
        compactNotice = addNotice("info", "Compacting context…");
        break;
      case "auto_compaction_end":
        if (compactNotice) { compactNotice.remove(); compactNotice = null; }
        else addNotice("info", "Context compacted.");
        break;
      case "model_changed":
        post({ t: "getState" });
        break;
      case "available_commands_update":
        commands = Array.isArray(f.commands) ? f.commands : [];
        break;
      case "extension_ui_request":
        onUiRequest(f);
        break;
      default:
        break; // unknown frames are ignored
    }
  }

  /* ------------------------------------------------------------------ */
  /* Host message bridge                                                 */
  /* ------------------------------------------------------------------ */

  window.addEventListener("message", function (e) {
    var m = e.data;
    if (!m || typeof m !== "object") return;
    try {
      switch (m.t) {
        case "frame":
          handleFrame(m.frame);
          break;
        case "models":
          models = Array.isArray(m.models) ? m.models : [];
          if (openMenuEl && openMenuAnchor === modelChip) {
            // Async reply arrived while the menu is open — rebuild it in place.
            closeMenu();
            openMenu(modelChip, buildModelMenu);
          }
          break;
        case "promptFailed":
          setWorking(false);
          if (pendingLocalUser > 0) pendingLocalUser--;
          break;
        case "state":
          applyState(m.state);
          break;
        case "commands":
          commands = Array.isArray(m.commands) ? m.commands : [];
          break;
        case "proc": {
          var status = m.status;
          if (status === "exited" || status === "error") {
            if (m.needsSetup) {
              procText.textContent = "No API keys configured — the agent has no models to use.";
              showSetupCard();
            } else {
              procText.textContent = "Agent is not running" +
                (m.detail ? " (" + m.detail + ")" : "") + ".";
            }
            procBanner.classList.remove("hidden");
            setWorking(false);
          } else {
            procBanner.classList.add("hidden");
          }
          break;
        }
        case "keyStatus":
          keyStatus = m.keys || {};
          if (Array.isArray(m.providers)) keyedProviders = m.providers;
          break;
        case "showHistory":
          showHistoryCard();
          post({ t: "getHistory" });
          break;
        case "history":
          renderHistory(Array.isArray(m.sessions) ? m.sessions : [], m.cwd);
          break;
        case "transcript":
          renderTranscript(Array.isArray(m.messages) ? m.messages : []);
          break;
        case "deadKey":
          showDeadKeyCard(m.which, m.label != null ? m.label : "provider");
          break;
        case "probe":
          probe = {
            results: m.results && typeof m.results === "object" ? m.results : {},
            running: !!m.running,
            enabled: m.enabled !== false,
          };
          if (openMenuEl && openMenuAnchor === modelChip) {
            // Verdicts arrived while the picker is open — rebuild it in place.
            closeMenu();
            openMenu(modelChip, buildModelMenu);
          }
          break;
        case "authStart":
          authProvider = m.providerId;
          toast("Opening browser for " + providerLabel(authProvider) + "…", 4000);
          break;
        case "authDone":
          closeAuthCard();
          if (m.ok) {
            closeSetupCard();
            toast("Signed in to " + providerLabel(m.providerId), 4000);
          }
          authProvider = null;
          break;
        case "attached": {
          if (m.token) dropPending(m.token);
          var incoming = Array.isArray(m.files) ? m.files : [];
          incoming.forEach(function (f) {
            if (f && f.path) addAttachment({ path: f.path, name: f.name || f.path, size: f.size });
          });
          renderAttachments();
          var rejected = Array.isArray(m.rejected) ? m.rejected : [];
          if (rejected.length) toast("Not attached — " + rejected.join("; "), 6000);
          if (incoming.length) input.focus();
          break;
        }
        case "attachContext": {
          // Editor selection sent via "OMP Code: Add Selection to Chat".
          var att = m.attachment;
          if (att && att.path) {
            addAttachment(att);
            renderAttachments();
            input.focus();
          }
          break;
        }
        case "activeFile": {
          var file = m.file;
          if (file && file.path) {
            fileChip.textContent = file.name || file.path;
            fileChip.title = file.path;
            fileChip.classList.remove("hidden");
          } else {
            fileChip.classList.add("hidden");
          }
          break;
        }
        case "theme":
          applyTheme(m.theme, m.accentColor);
          break;
        case "fileCandidates": {
          // Stale reply (user kept typing) — the newest query owns the popup.
          if (m.token !== atPendingToken || !atPendingToken) break;
          atItems = Array.isArray(m.files) ? m.files : [];
          atSel = 0;
          if (!atItems.length) { hideAt(); break; }
          renderAt();
          break;
        }
        case "sessionStats": {
          var st = m.stats && typeof m.stats === "object" ? m.stats : {};
          // get_session_stats runs after every turn and carries a fresh
          // contextUsage; t:"state" does not, so this is the only signal that
          // tracks a conversation as it grows.
          noteContextFill(contextPercent(st.contextUsage, currentModel), autoCompaction);
          var tok = st.tokens && typeof st.tokens === "object" ? st.tokens : {};
          var parts = [];
          if (typeof tok.input === "number" && tok.input > 0) parts.push("↑" + compactNum(tok.input));
          if (typeof tok.output === "number" && tok.output > 0) parts.push("↓" + compactNum(tok.output));
          var cost = typeof st.cost === "number" ? st.cost : 0;
          if (cost > 0) parts.push("$" + (cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)));
          if (parts.length) {
            statsChip.textContent = parts.join(" ");
            var tip = "Session usage";
            if (tok.reasoning > 0) tip += " · reasoning " + compactNum(tok.reasoning);
            if (tok.cacheRead > 0) tip += " · cache read " + compactNum(tok.cacheRead);
            statsChip.title = tip;
            statsChip.classList.remove("hidden");
          }
          break;
        }
        case "diffAvailable": {
          var diffCard = byToolCallId.get(String(m.toolCallId));
          var diffHead = diffCard && diffCard.querySelector(".tool-head");
          if (diffHead && !diffHead.querySelector(".tool-diff")) {
            var diffBtn = document.createElement("button");
            diffBtn.className = "tool-diff";
            diffBtn.type = "button";
            diffBtn.textContent = "diff";
            diffBtn.title = "Open diff (before ↔ current)";
            diffBtn.setAttribute("data-id", String(m.toolCallId));
            var toggle = diffHead.querySelector(".tool-toggle");
            diffHead.insertBefore(diffBtn, toggle || null);
          }
          break;
        }
        case "approval":
          if (m.mode) setApprovalChip(String(m.mode));
          break;
        case "profile":
          // Resolved ModelProfile for the current model. Never arriving is a
          // supported state — the badge just stays hidden.
          setProfileChip(m.profile);
          break;
        case "boot": {
          var cfg = m.cfg || {};
          if (cfg.thinkingLevel) {
            currentThinking = String(cfg.thinkingLevel);
            thinkingChoice = currentThinking;
            thinkingChip.textContent = "think: " + cfg.thinkingLevel;
          }
          if (cfg.approvalMode) setApprovalChip(String(cfg.approvalMode));
          if (cfg.defaultModel) {
            var mm = String(cfg.defaultModel);
            var slash = mm.indexOf("/");
            modelChip.textContent = slash >= 0 ? mm.slice(slash + 1) : mm;
          }
          applyTheme(cfg.theme, cfg.accentColor);
          break;
        }
        case "reset":
          resetView();
          break;
        default:
          break;
      }
    } catch (err) {
      // Keep the UI alive, but never swallow silently: a ReferenceError in the
      // render path once made every assistant reply vanish with no trace.
      reportUiError(err, m && m.t);
    }
  });

  /* ------------------------------------------------------------------ */
  /* Boot                                                                */
  /* ------------------------------------------------------------------ */

  autogrow();
  input.focus();
  post({ t: "ready" });
