/* OMP Code — webview UI (vanilla JS, no imports). Runs under a nonce'd script tag. */
(function () {
  "use strict";

  var vscode = acquireVsCodeApi();

  function post(msg) {
    try { vscode.postMessage(msg); } catch (e) { /* host gone */ }
  }

  /* ------------------------------------------------------------------ */
  /* Static skeleton                                                     */
  /* ------------------------------------------------------------------ */

  document.body.innerHTML =
    '<div id="app">' +
      '<header class="topbar">' +
        '<div class="topbar-title"><span class="spark">✳</span><span id="session-title">OMP Code</span></div>' +
        '<div class="topbar-actions">' +
          '<button id="btn-new" class="icon-btn" title="New chat tab">＋</button>' +
          '<button id="btn-settings" class="icon-btn" title="Settings">⚙</button>' +
        '</div>' +
      '</header>' +
      '<main id="messages">' +
        '<div class="welcome"><div class="welcome-spark">✳</div>' +
          '<h1>What can I help you build?</h1>' +
          '<p class="welcome-sub">Ask questions, run commands, edit files. Type <code>/</code> for commands. Shift+Enter for a new line, Esc to interrupt.</p>' +
        '</div>' +
        '<div id="working" class="status-line hidden"><span class="spark spin">✳</span> <span id="working-text">Working…</span> <span class="dim">esc to interrupt</span></div>' +
      '</main>' +
      '<div id="modal-holder"></div>' +
      '<footer class="composer">' +
        '<div class="composer-box">' +
          '<div id="slash-popup" class="slash-popup hidden"></div>' +
          '<textarea id="input" rows="1" placeholder="Ask OMP Code…"></textarea>' +
          '<div class="composer-row">' +
            '<button id="model-chip" class="chip">model</button>' +
            '<button id="thinking-chip" class="chip">think: auto</button>' +
            '<span id="ctx-chip" class="chip ghost hidden"></span>' +
            '<span class="flex-spacer"></span>' +
            '<button id="btn-send" class="send-btn" title="Send">↑</button>' +
            '<button id="btn-stop" class="send-btn stop hidden" title="Stop">■</button>' +
          '</div>' +
        '</div>' +
        '<div id="proc-banner" class="proc-banner hidden"><span id="proc-text">Agent is not running.</span> <button id="btn-restart">Restart</button></div>' +
      '</footer>' +
      '<div id="menu-holder"></div>' +
      '<div id="toast-holder"></div>' +
    '</div>';

  var messagesEl = document.getElementById("messages");
  var welcomeEl = messagesEl.querySelector(".welcome");
  var workingEl = document.getElementById("working");
  var workingText = document.getElementById("working-text");
  var modalHolder = document.getElementById("modal-holder");
  var menuHolder = document.getElementById("menu-holder");
  var toastHolder = document.getElementById("toast-holder");
  var input = document.getElementById("input");
  var slashPopup = document.getElementById("slash-popup");
  var modelChip = document.getElementById("model-chip");
  var thinkingChip = document.getElementById("thinking-chip");
  var ctxChip = document.getElementById("ctx-chip");
  var btnSend = document.getElementById("btn-send");
  var btnStop = document.getElementById("btn-stop");
  var btnNew = document.getElementById("btn-new");
  var btnSettings = document.getElementById("btn-settings");
  var btnRestart = document.getElementById("btn-restart");
  var procBanner = document.getElementById("proc-banner");
  var procText = document.getElementById("proc-text");
  var sessionTitle = document.getElementById("session-title");

  /* ------------------------------------------------------------------ */
  /* State                                                               */
  /* ------------------------------------------------------------------ */

  var COLLAPSE_LINES = 5;
  var THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"];

  var byToolCallId = new Map();
  var anonToolSeq = 0;
  var currentAssistant = null;   // { root } for the streaming assistant message
  var models = [];
  var commands = [];
  var working = false;
  var stuck = true;              // autoscroll stick-to-bottom
  var pendingLocalUser = 0;      // user bubbles rendered locally, skip echoes
  var retryNotice = null;
  var compactNotice = null;

  var modalQueue = [];
  var activeModal = null;        // { frame, el }

  var openMenuEl = null;
  var openMenuAnchor = null;

  var slashItems = [];
  var slashSel = 0;

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
  /* Mini markdown renderer                                              */
  /* ------------------------------------------------------------------ */

  var TOK = String.fromCharCode(1); // sentinel for protected inline tokens
  var TOK_RE = new RegExp(TOK + "(\\d+)" + TOK, "g");

  function renderInline(raw) {
    var toks = [];
    var s = esc(raw);
    // protect inline code from further formatting
    s = s.replace(/`([^`\n]+)`/g, function (_, c) {
      toks.push("<code>" + c + "</code>");
      return TOK + (toks.length - 1) + TOK;
    });
    // links [text](url) — only http(s); clicks are delegated to openExternal
    s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, function (m, t, u) {
      if (!/^https?:\/\//i.test(u)) return m;
      toks.push('<a href="#" data-href="' + u + '">' + t + "</a>");
      return TOK + (toks.length - 1) + TOK;
    });
    s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[\s(])\*([^*\s][^*\n]*)\*/g, "$1<em>$2</em>");
    s = s.replace(TOK_RE, function (_, i) { return toks[+i]; });
    return s;
  }

  function renderBlocks(text) {
    var lines = String(text).split("\n");
    var html = [];
    var para = [];
    var quote = [];
    var list = null; // { type: "ul"|"ol", items: [] }

    function flushPara() {
      if (para.length) { html.push("<p>" + para.map(renderInline).join("<br>") + "</p>"); para = []; }
    }
    function flushList() {
      if (list) {
        html.push("<" + list.type + ">" + list.items.map(function (i) {
          return "<li>" + renderInline(i) + "</li>";
        }).join("") + "</" + list.type + ">");
        list = null;
      }
    }
    function flushQuote() {
      if (quote.length) { html.push("<blockquote>" + quote.map(renderInline).join("<br>") + "</blockquote>"); quote = []; }
    }
    function flushAll() { flushPara(); flushList(); flushQuote(); }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var m;
      if (!line.trim()) { flushAll(); continue; }
      if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) {
        flushAll();
        var lvl = m[1].length;
        html.push("<h" + lvl + ">" + renderInline(m[2]) + "</h" + lvl + ">");
        continue;
      }
      if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushAll(); html.push("<hr>"); continue; }
      if ((m = /^>\s?(.*)$/.exec(line))) { flushPara(); flushList(); quote.push(m[1]); continue; }
      if ((m = /^\s*[-*+]\s+(.*)$/.exec(line))) {
        flushPara(); flushQuote();
        if (!list || list.type !== "ul") { flushList(); list = { type: "ul", items: [] }; }
        list.items.push(m[1]);
        continue;
      }
      if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
        flushPara(); flushQuote();
        if (!list || list.type !== "ol") { flushList(); list = { type: "ol", items: [] }; }
        list.items.push(m[1]);
        continue;
      }
      flushList(); flushQuote();
      para.push(line);
    }
    flushAll();
    return html.join("");
  }

  function renderMarkdown(src) {
    src = String(src == null ? "" : src);
    var parts = src.split("```");
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        // fenced code block: first line may be a language tag
        var chunk = parts[i];
        var nl = chunk.indexOf("\n");
        var lang = "";
        var body = chunk;
        if (nl >= 0) {
          var head = chunk.slice(0, nl).trim();
          if (/^[\w+.#-]*$/.test(head)) { lang = head; body = chunk.slice(nl + 1); }
        } else if (/^[\w+.#-]*$/.test(chunk.trim())) {
          // unterminated fence with only a language token
          lang = chunk.trim(); body = "";
        }
        out.push('<pre class="code">' +
          (lang ? '<div class="code-lang">' + esc(lang) + "</div>" : "") +
          "<code>" + esc(body.replace(/\n$/, "")) + "</code></pre>");
      } else if (parts[i]) {
        out.push(renderBlocks(parts[i]));
      }
    }
    return out.join("");
  }

  /* ------------------------------------------------------------------ */
  /* Messages: user / assistant                                          */
  /* ------------------------------------------------------------------ */

  function addUserBubble(text) {
    if (!text) return;
    var msg = document.createElement("div");
    msg.className = "msg user";
    var bubble = document.createElement("div");
    bubble.className = "bubble";
    bubble.style.whiteSpace = "pre-wrap";
    bubble.textContent = String(text);
    msg.appendChild(bubble);
    appendToMessages(msg);
  }

  function newAssistantEntry() {
    var root = document.createElement("div");
    root.className = "msg assistant";
    appendToMessages(root);
    return { root: root };
  }

  function renderAssistant(entry, message) {
    var root = entry.root;
    // preserve which thinking blocks the user expanded across re-renders
    var expanded = {};
    var prev = root.querySelectorAll(".thinking");
    for (var i = 0; i < prev.length; i++) {
      if (!prev[i].classList.contains("collapsed")) expanded[i] = true;
    }
    root.innerHTML = "";

    var content = message && message.content;
    if (typeof content === "string") content = [{ type: "text", text: content }];
    if (!Array.isArray(content)) content = [];

    var ti = 0;
    for (var j = 0; j < content.length; j++) {
      var block = content[j];
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
        // tool-cards are #messages-level siblings; may precede tool_execution_start
        ensureToolCard(block.id, block.name, block.arguments);
      }
    }
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
        toast("Opening browser…", 3000);
        return; // host performs the actual open
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

  var keyStatus = { anthropic: false, moonshot: false };
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

    var anthropicInp = field("Anthropic API key (ANTHROPIC_API_KEY)", "sk-ant-…", keyStatus.anthropic);
    var kimiInp = field("Kimi / Moonshot API key (MOONSHOT_API_KEY)", "sk-…", keyStatus.moonshot);

    var buttons = document.createElement("div");
    buttons.className = "modal-buttons";
    buttons.appendChild(modalButton("Cancel", false, function () {
      closeSetupCard();
    }));
    buttons.appendChild(modalButton("Save & Restart", true, function () {
      var a = anthropicInp.value.trim();
      var k = kimiInp.value.trim();
      if (!a && !k) { toast("Enter at least one key", 3000); return; }
      post({ t: "setKeys", anthropic: a, moonshot: k });
      toast("Saving keys, restarting agent…", 4000);
      closeSetupCard();
    }));
    el.appendChild(buttons);

    modalHolder.appendChild(el);
    setupCard = el;
    setTimeout(function () { anthropicInp.focus(); }, 0);
  }

  function closeSetupCard() {
    if (setupCard) { setupCard.remove(); setupCard = null; }
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

  function buildModelMenu(menu) {
    if (!models.length) {
      addMenuLabel(menu, "models");
      addMenuItem(menu, "Loading models…", function () { closeMenu(); });
      return;
    }
    var byProv = {};
    var order = [];
    models.forEach(function (m) {
      if (!m) return;
      var p = m.provider != null ? String(m.provider) : "other";
      if (!byProv[p]) { byProv[p] = []; order.push(p); }
      byProv[p].push(m);
    });
    order.forEach(function (prov) {
      addMenuLabel(menu, prov);
      byProv[prov].forEach(function (m) {
        addMenuItem(menu, m.name != null ? m.name : (m.id != null ? m.id : "?"), function () {
          post({ t: "setModel", provider: m.provider, modelId: m.id });
          modelChip.textContent = m.name != null ? m.name : (m.id != null ? m.id : "model");
          closeMenu();
        });
      });
    });
  }

  modelChip.addEventListener("click", function () {
    if (!models.length) post({ t: "getModels" });
    openMenu(modelChip, buildModelMenu);
  });

  thinkingChip.addEventListener("click", function () {
    openMenu(thinkingChip, function (menu) {
      addMenuLabel(menu, "thinking");
      THINKING_LEVELS.forEach(function (level) {
        addMenuItem(menu, level, function () {
          post({ t: "setThinking", level: level });
          thinkingChip.textContent = "think: " + level;
          closeMenu();
        });
      });
    });
  });

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
      el.className = "menu-item slash-item" + (i === slashSel ? " active" : "");
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
  /* Composer                                                            */
  /* ------------------------------------------------------------------ */

  function autogrow() {
    input.style.height = "auto";
    var max = 168; // ~8 lines
    input.style.height = Math.min(input.scrollHeight, max) + "px";
  }

  function sendPrompt() {
    var text = input.value.trim();
    if (!text) return;
    post({ t: "prompt", text: text });
    pendingLocalUser++;
    addUserBubble(text);
    input.value = "";
    autogrow();
    hideSlash();
    setWorking(true);
    stuck = true;
    scrollBottom();
  }

  input.addEventListener("input", function () {
    autogrow();
    updateSlash();
  });

  input.addEventListener("keydown", function (e) {
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
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendPrompt();
    }
  });

  btnSend.addEventListener("click", sendPrompt);
  btnStop.addEventListener("click", function () { post({ t: "abort" }); });
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
    var head = t.closest(".tool-head");
    if (head) { toggleTool(head.closest(".tool-card")); return; }
    var more = t.closest(".tool-more");
    if (more) { toggleTool(more.closest(".tool-card")); return; }
  });

  /* ------------------------------------------------------------------ */
  /* State / models / commands rendering                                 */
  /* ------------------------------------------------------------------ */

  function applyState(state) {
    if (!state || typeof state !== "object") return;
    var model = state.model;
    if (model && typeof model === "object") {
      modelChip.textContent = model.name != null ? model.name : (model.id != null ? model.id : "model");
    } else if (typeof model === "string" && model) {
      modelChip.textContent = model;
    }
    if (state.thinkingLevel != null) {
      thinkingChip.textContent = "think: " + state.thinkingLevel;
    }
    if (state.sessionName) sessionTitle.textContent = String(state.sessionName);

    // context chip — defensive: shapes vary
    var pct = null;
    var cu = state.contextUsage;
    if (cu && typeof cu === "object") {
      if (typeof cu.percent === "number" && isFinite(cu.percent)) {
        pct = cu.percent <= 1 ? cu.percent * 100 : cu.percent;
      } else if (typeof cu.tokens === "number") {
        var win = (typeof cu.contextWindow === "number" && cu.contextWindow > 0) ? cu.contextWindow
          : (model && typeof model === "object" && typeof model.contextWindow === "number" && model.contextWindow > 0) ? model.contextWindow
          : null;
        if (win) pct = (cu.tokens / win) * 100;
      }
    } else if (typeof cu === "number" && isFinite(cu)) {
      pct = cu <= 1 ? cu * 100 : cu;
    }
    if (pct != null && isFinite(pct) && pct >= 0) {
      ctxChip.textContent = "ctx " + Math.round(Math.min(pct, 999)) + "%";
      ctxChip.classList.remove("hidden");
    } else {
      ctxChip.classList.add("hidden");
    }

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
    setWorking(false);
    hideSlash();
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
          keyStatus.anthropic = !!m.anthropic;
          keyStatus.moonshot = !!m.moonshot;
          break;
        case "boot": {
          var cfg = m.cfg || {};
          if (cfg.thinkingLevel) thinkingChip.textContent = "think: " + cfg.thinkingLevel;
          if (cfg.defaultModel) {
            var mm = String(cfg.defaultModel);
            var slash = mm.indexOf("/");
            modelChip.textContent = slash >= 0 ? mm.slice(slash + 1) : mm;
          }
          break;
        }
        case "reset":
          resetView();
          break;
        default:
          break;
      }
    } catch (err) {
      // never let one bad message break the UI
    }
  });

  /* ------------------------------------------------------------------ */
  /* Boot                                                                */
  /* ------------------------------------------------------------------ */

  autogrow();
  input.focus();
  post({ t: "ready" });
})();
