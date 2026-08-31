/* OMP Code — webview UI. ESM module; runs under a nonce'd script tag. */

  // markdown.mjs is a module: its exports are NOT globals. Without this import
  // every renderAssistant() call threw ReferenceError, which the host-message
  // try/catch swallowed — assistant replies silently never rendered.
  import { renderMarkdown } from "./markdown.mjs";
  import { createHostPort } from "./host-port.mjs";
  // Interface language; see src/l10n.ts. The English source text is the key,
  // so an untranslated string renders as written instead of a placeholder.
  import { t } from "./l10n.mjs";

  var hostPort = createHostPort(window);
  if (hostPort.kind === "android") document.body.setAttribute("data-platform", "android");
  // A window reload throws this webview away; VS Code offers the panel back to
  // the extension with nothing but the state stored here. The id names which
  // chat this tab was (see src/chatTabs.ts) and is baked into the markup by
  // getHtml, so it is stored now rather than waiting for a host message that a
  // reload could beat. The sidebar view carries no id and is never restored.
  var tabId = document.getElementById("app")?.getAttribute("data-tab-id");
  if (tabId) hostPort.setState({ tabId: tabId });
  var remoteCapabilityVerbs = null;

  var REMOTE_UI_CAPABILITY = {
    ready: "view", getState: "view", getModels: "view", exportTranscript: "view",
    diagnostics: "view",
    prompt: "prompt", abort: "prompt", setModel: "prompt", setThinking: "prompt",
    recheckModels: "prompt",
    uiResponse: "approve",
    pickFiles: "files", attachPaths: "files", attachData: "files",
    cancelAttachment: "files", findFiles: "files", insertAtCursor: "files",
    openDiff: "files", rejectEdit: "files",
    compact: "session.manage", restart: "session.manage", newSession: "session.manage",
    openNewTab: "session.manage", getHistory: "session.manage", openSession: "session.manage",
    setApproval: "settings.manage", setProfileField: "settings.manage",
    login: "credentials.manage", setKeys: "credentials.manage", clearKey: "credentials.manage",
  };

  function hasRemoteCapability(verb) {
    return remoteCapabilityVerbs === null || remoteCapabilityVerbs.has(verb);
  }

  function post(msg) {
    if (remoteCapabilityVerbs !== null && msg && typeof msg.t === "string") {
      if (msg.t === "attachPaths") {
        toast(t("Desktop file paths cannot be attached from Android; use the attachment button."), 5000);
        return false;
      }
      if (msg.t === "openProfileSettings") {
        toast(t("Raw VS Code settings are available on the computer only."), 5000);
        return false;
      }
      var required = REMOTE_UI_CAPABILITY[msg.t];
      if (required && !remoteCapabilityVerbs.has(required)) {
        toast(t("This action is not allowed by the Remote Control permissions selected on the computer."), 5000);
        return false;
      }
    }
    try { hostPort.post(msg); return true; } catch (e) { return false; }
  }

  /* Static skeleton lives in the host-provided HTML (ompSession.getHtml). */

  var messagesEl = document.getElementById("messages");
  var welcomeEl = messagesEl.querySelector(".welcome");
  var workingEl = document.getElementById("working");
  var workingText = document.getElementById("working-text");
  // Inside the working line on purpose: resetView() removes every child of
  // #messages except this one, and omp's setStatus only rewrites #working-text.
  var queueEl = document.createElement("span");
  queueEl.className = "queue-count hidden";
  workingEl.appendChild(queueEl);
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
  var routeChip = document.getElementById("route-chip");
  var connectionStateEl = document.getElementById("connection-state");

  /* ------------------------------------------------------------------ */
  /* State                                                               */
  /* ------------------------------------------------------------------ */

  var COLLAPSE_LINES = 5;
  var THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"];

  // Shown under each thinking level. The ladder itself is per-model — omp
  // reports it as `model.thinking.efforts` — so these are descriptions only,
  // never the source of which levels exist.
  var THINKING_HINTS = {
    off: t("No reasoning — fastest and cheapest answer"),
    minimal: t("Brief consideration — for simple, mechanical edits"),
    low: t("Light reasoning — small changes in familiar code"),
    medium: t("Balanced — the usual choice for everyday work"),
    high: t("Deep analysis — tricky bugs, unfamiliar code"),
    xhigh: t("Very deep — slower and more expensive"),
    max: t("Maximum — hardest problems, slowest, priciest"),
    auto: t("omp classifies each request and picks a level for it"),
  };

  // omp has exactly three approval tiers (`--approval-mode`). Native harnesses
  // have four to six, so these are the honest mapping, not an equivalence.
  // Approving a `task` call hands its subagent the same tier, so "asks before
  // commands" holds for the main agent but not for work it delegates — the
  // hints say so rather than promising a guarantee the tier does not give.
  var APPROVAL_MODES = [
    { id: "always-ask", short: t("ask"), label: t("Ask before changes"),
      hint: t("Reads files freely; asks before writing a file or running a command") },
    { id: "write", short: t("write"), label: t("Write freely, ask to run"),
      hint: t("Reads and edits files on its own; asks before running a command") },
    { id: "yolo", short: t("full"), label: t("Full access"),
      hint: t("Reads, edits and runs shell commands with no confirmation") },
  ];

  // Resolver layer → words. `base`/`builtin`/`user` are the profile resolver's
  // internal names; the inspector has to say where a value came from in terms
  // the reader can act on.
  var PROVENANCE_LABELS = {
    base: t("default"),
    builtin: t("built-in"),
    user: t("your settings"),
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
  // One-shot routing: { provider, modelId, label } the next prompt goes
  // through instead of the session model; cleared by the send that used it.
  var routeChoice = null;
  var remoteShellTitle = null;
  var pendingLocalUser = 0;      // user bubbles rendered locally, skip echoes
  // Last send, kept only until the host confirms it: a rejected prompt must
  // give the typing back instead of swallowing it.
  var lastSentText = "";
  var lastSentFiles = null;
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

  // Android full-sync packets stay below the origin-scoped WebMessage limit.
  // A single transcript entry or state section can still be larger, so the
  // native host forwards it as an ordered, hashed fragment stream. Keep the
  // browser-side accumulator bounded as a second line of defence.
  var MAX_SYNC_FRAGMENT_BYTES = 2 * 1024 * 1024;
  var MAX_SYNC_FRAGMENT_COUNT = 32;
  var MAX_ACTIVE_FRAGMENT_STREAMS = 4;
  var syncFragments = new Map();
  var syncApplyQueue = Promise.resolve();

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

  var remoteResultCard = null;

  function closeRemoteResult() {
    if (remoteResultCard) { remoteResultCard.remove(); remoteResultCard = null; }
  }

  function showRemoteTextResult(titleText, bodyText) {
    closeRemoteResult();
    var card = document.createElement("div");
    card.className = "ui-modal remote-result-card";
    var title = document.createElement("div");
    title.className = "modal-title";
    title.textContent = String(titleText || "OMP Code");
    card.appendChild(title);
    var body = document.createElement("pre");
    body.className = "remote-result-body";
    body.textContent = String(bodyText == null ? "" : bodyText);
    card.appendChild(body);
    var buttons = document.createElement("div");
    buttons.className = "modal-buttons";
    buttons.appendChild(modalButton(t("Close"), true, closeRemoteResult));
    card.appendChild(buttons);
    modalHolder.appendChild(card);
    remoteResultCard = card;
  }

  function applyRemoteCapabilities(message) {
    var verbs = Array.isArray(message.verbs)
      ? message.verbs.filter(function (verb) { return typeof verb === "string"; })
      : [];
    remoteCapabilityVerbs = new Set(verbs);
    document.body.setAttribute("data-remote-mode", "true");
    [
      [btnHistory, "session.manage"],
      [btnNew, "session.manage"],
      [btnRestart, "session.manage"],
      [approvalChip, "settings.manage"],
      [btnAttach, "files"],
    ].forEach(function (entry) {
      if (!entry[0]) return;
      entry[0].classList.toggle("remote-capability-hidden", !hasRemoteCapability(entry[1]));
    });
    if (openMenuEl) closeMenu();
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
  function addUserBubble(text, files, opts) {
    var steer = !!(opts && opts.steer);
    var list = Array.isArray(files) ? files : [];
    if (!text && list.length === 0) return;
    var msg = document.createElement("div");
    msg.className = steer ? "msg user steer" : "msg user";
    var bubble = document.createElement("div");
    bubble.className = steer ? "bubble steer" : "bubble";
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
    if (steer) {
      var badge = document.createElement("span");
      badge.className = "steer-badge";
      badge.textContent = t("\u21b3 steer");
      bubble.appendChild(badge);
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
        var tblock = document.createElement("div");
        tblock.className = "thinking" + (expanded[ti] ? "" : " collapsed");
        tblock.innerHTML = '<div class="thinking-head">✳ ' + esc(t("Thinking…")) +
          '</div><div class="thinking-body"></div>';
        var thinkingHead = tblock.querySelector(".thinking-head");
        thinkingHead.setAttribute("role", "button");
        thinkingHead.setAttribute("tabindex", "0");
        thinkingHead.setAttribute("aria-expanded", expanded[ti] ? "true" : "false");
        tblock.querySelector(".thinking-body").innerHTML = renderMarkdown(ttext);
        root.appendChild(tblock);
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
    // The agent is producing messages, so the last send was accepted: drop the
    // draft copy before a later failure can restore something stale.
    lastSentText = "";
    lastSentFiles = null;
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
        '<div class="tool-head" role="button" tabindex="0" aria-expanded="false">' +
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
      more.textContent = "… " + t("+{0} lines", hiddenLines);
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
    var head = card.querySelector(".tool-head");
    if (head) head.setAttribute("aria-expanded", nowCollapsed ? "false" : "true");
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
  /* Subagents                                                           */
  /* ------------------------------------------------------------------ */

  /* omp spawns subagents through a parent tool-call and then reports them on
     two channels: rare `subagent_lifecycle` frames, forwarded as they happen,
     and a `t:"subagents"` snapshot the host coalesces to at most 4 Hz because
     a single subagent emits dozens of progress frames a second. Both land in
     the same rows, so a start is visible immediately and the numbers catch up
     on the next snapshot. */

  var subagentRows = new Map();   // subagent id → row element
  var subagentOrphansEl = null;   // holds rows whose parent tool-call is unknown

  var SUBAGENT_STATUSES = { started: 1, completed: 1, failed: 1, aborted: 1 };

  /** Present-and-usable test: an absent field must leave the rendered value alone. */
  function subagentHas(v) {
    return v !== undefined && v !== null && v !== "";
  }

  /** Rows live at the end of the transcript only while no parent card exists. */
  function subagentOrphans() {
    if (!subagentOrphansEl || !subagentOrphansEl.isConnected) {
      subagentOrphansEl = document.createElement("div");
      subagentOrphansEl.className = "subagent-list subagent-orphans";
      appendToMessages(subagentOrphansEl);
    }
    return subagentOrphansEl;
  }

  /**
   * Move `row` under its parent tool-call card, creating that card's list on
   * first use. A row already placed is never demoted back to the orphan bin:
   * a lifecycle frame can arrive before the tool-call card exists, and a later
   * frame that simply omits parentToolCallId must not undo the reunion.
   */
  function placeSubagentRow(row, parentToolCallId) {
    var card = subagentHas(parentToolCallId) ? byToolCallId.get(String(parentToolCallId)) : null;
    if (card) {
      var list = card.querySelector(".subagent-list");
      if (!list) {
        list = document.createElement("div");
        list.className = "subagent-list";
        card.appendChild(list);
      }
      if (row.parentNode !== list) list.appendChild(row);
      return;
    }
    if (!row.parentNode) subagentOrphans().appendChild(row);
  }

  function ensureSubagentRow(id) {
    var row = subagentRows.get(id);
    if (row && row.isConnected) return row;
    row = document.createElement("div");
    row.className = "subagent-row";
    row.setAttribute("data-sub-id", id);
    row.setAttribute("data-status", "started");
    // Static skeleton only. Every agent-controlled value below is written with
    // textContent or via esc(), so nothing untrusted reaches innerHTML.
    row.innerHTML =
      '<span class="subagent-dot"></span>' +
      '<span class="subagent-name"></span>' +
      '<span class="subagent-badge subagent-model hidden"></span>' +
      '<span class="subagent-badge subagent-auto" title="' +
        esc(t("omp always runs subagents without approval prompts, whatever the session approval mode is.")) +
        '">' + esc(t("auto-approved")) + '</span>' +
      '<span class="subagent-tool"></span>' +
      '<span class="subagent-cost"></span>' +
      '<span class="subagent-tokens"></span>';
    subagentRows.set(id, row);
    return row;
  }

  /** Write one field, hiding its element while there is nothing to say. */
  function setSubagentField(row, selector, text) {
    var el = row.querySelector(selector);
    if (!el) return;
    text = String(text == null ? "" : text);
    el.textContent = text;
    if (text) el.classList.remove("hidden");
    else el.classList.add("hidden");
  }

  /**
   * Patch one row in place from a full or partial SubagentInfo. Rebuilding the
   * row instead would restart the running dot's pulse animation several times
   * a second, which reads as flicker rather than as progress.
   */
  function updateSubagentRow(info) {
    if (!info || typeof info !== "object") return;
    var id = subagentHas(info.id) ? String(info.id) : "";
    if (!id) return;

    var row = ensureSubagentRow(id);
    placeSubagentRow(row, info.parentToolCallId);

    var status = String(info.status);
    if (Object.prototype.hasOwnProperty.call(SUBAGENT_STATUSES, status)) {
      row.setAttribute("data-status", status);
    }

    if (subagentHas(info.description) || subagentHas(info.agent)) {
      setSubagentField(row, ".subagent-name",
        String(subagentHas(info.description) ? info.description : info.agent));
    }
    // The spawn task is long enough to swamp the row, so it lives in the
    // tooltip where it stays one hover away.
    if (subagentHas(info.task)) {
      var nameEl = row.querySelector(".subagent-name");
      if (nameEl) nameEl.title = String(info.task);
    }
    // A subagent can resolve to a different provider than the session, so the
    // model is not decoration — it is the only place that difference shows.
    if (subagentHas(info.resolvedModel)) setSubagentField(row, ".subagent-model", info.resolvedModel);
    if (info.currentTool !== undefined) setSubagentField(row, ".subagent-tool", info.currentTool);
    if (typeof info.cost === "number" && isFinite(info.cost)) {
      setSubagentField(row, ".subagent-cost",
        info.cost > 0 ? "$" + (info.cost < 0.01 ? info.cost.toFixed(4) : info.cost.toFixed(2)) : "");
    }
    if (typeof info.tokens === "number" && isFinite(info.tokens)) {
      setSubagentField(row, ".subagent-tokens", info.tokens > 0 ? compactNum(info.tokens) : "");
    }
  }

  /** Coalesced host snapshot — the only source of cost, tokens and currentTool. */
  function renderSubagents(snapshot) {
    var list = snapshot && Array.isArray(snapshot.subagents) ? snapshot.subagents : [];
    for (var i = 0; i < list.length; i++) updateSubagentRow(list[i]);
    if (list.length) scrollBottom();
  }

  /** Lifecycle frame — shown at once so a spawn is not up to 250 ms late. */
  function onSubagentLifecycle(payload) {
    if (!payload || typeof payload !== "object") return;
    updateSubagentRow({
      id: payload.id,
      agent: payload.agent,
      description: payload.description,
      status: payload.status,
      task: payload.task,
      parentToolCallId: payload.parentToolCallId,
    });
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
    addNotice("error", t('UI error while rendering — see the "OMP Code" output channel: {0}',
      detail.split("\n")[0]));
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
    CONTEXT_STEPS.forEach(function (s) { if (pct >= s) contextStepsFired[s] = true; });

    if (contextNotice && contextNotice.isConnected) contextNotice.remove();

    var text = step >= 90
      ? t("Context is {0}% full — close to the limit.", Math.round(pct))
      : step >= 75
        ? t("Context is {0}% full — a good moment to compact.", Math.round(pct))
        : t("Context is about half full.");
    var hint = autoCompacts
      ? t("omp compacts automatically before it runs out; compacting now just picks the moment.")
      : t("Auto-compaction is off. Compacting summarizes the history so the chat can continue.");

    contextNotice = addNoticeWithAction(
      step >= 75 ? "warning" : "info",
      text + " " + hint,
      t("Compact now"),
      function () {
        // Compaction aborts whatever the agent is doing, so it is offered
        // only between turns rather than silently killing a running tool.
        if (working) {
          toast(t("Finish or stop the current turn first"), 3000);
          return;
        }
        // Un-fire the step: a compact can be refused ("already in progress",
        // "session too small"), and the fill will not drop, so without this
        // the warning and its button would be gone for good.
        contextStepsFired[step] = false;
        if (post({ t: "compact" }) === false) return;
        toast(t("Compacting context…"), 3000);
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
    // Send stays reachable during a turn — it switches to steer instead of
    // hiding, which is the only way to steer on Android (Enter is a newline).
    btnSend.classList.toggle("steer", working);
    btnSend.textContent = working ? "\u21ea" : "\u2191";
    btnSend.title = working ? t("Steer (send while running)") : t("Send");
    btnSend.setAttribute("aria-label", working ? t("Steer (send while running)") : t("Send"));
    btnStop.classList.toggle("hidden", !working);
    if (!working) workingText.textContent = t("Working…");
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
        workingText.textContent = s ? String(s) : t("Working…");
        return;
      }
      case "setTitle": {
        var title = f.title != null ? f.title : f.text;
        sessionTitle.textContent = title ? String(title) : "OMP Code";
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
        dropApprovalModal(target);
        return; // no response for cancel
      }
      case "setWidget":
        return; // intentionally ignored
      default:
        return; // unknown methods: ignore silently
    }
  }

  function dropApprovalModal(requestId) {
    requestId = String(requestId == null ? "" : requestId);
    if (!requestId) return;
    modalQueue = modalQueue.filter(function (q) { return String(q.id) !== requestId; });
    if (activeModal && activeModal.frame && String(activeModal.frame.id) === requestId) {
      var previousFocus = activeModal.previousFocus;
      activeModal.el.remove();
      activeModal = null;
      settleModalClose(previousFocus);
    }
  }

  function pumpModals() {
    if (activeModal || !modalQueue.length) return;
    // The settings screen sits above the modal layer. An approval that arrives
    // behind it would be invisible and would block the agent until it was found.
    closeSettings();
    showModal(modalQueue.shift());
  }

  function notifyAndroidModalState(open) {
    if (hostPort.kind !== "android") return;
    try { hostPort.post({ t: "androidModalState", open: !!open }); } catch (e) { /* native shell may be detaching */ }
  }

  function settleModalClose(previousFocus) {
    pumpModals();
    if (activeModal) return;
    modalHolder.classList.remove("active");
    notifyAndroidModalState(false);
    if (previousFocus && previousFocus.isConnected && typeof previousFocus.focus === "function") {
      setTimeout(function () { previousFocus.focus(); }, 0);
    }
  }

  function closeActiveModal() {
    if (!activeModal) return;
    var previousFocus = activeModal.previousFocus;
    activeModal.el.remove();
    activeModal = null;
    settleModalClose(previousFocus);
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
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("tabindex", "-1");
    var method = frame.method;
    var id = frame.id;

    var titleText = frame.title != null ? String(frame.title)
      : method === "confirm" ? t("Confirm")
      : method === "select" ? t("Select")
      : method === "editor" ? t("Edit")
      : t("Input");
    var title = document.createElement("div");
    title.className = "modal-title";
    title.id = "active-modal-title";
    title.textContent = titleText;
    el.appendChild(title);
    el.setAttribute("aria-labelledby", title.id);

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
      buttons.appendChild(modalButton(t("Deny"), false, function () {
        closeActiveModal();
        respondUi(id, { confirmed: false });
      }));
      buttons.appendChild(modalButton(t("Allow"), true, function () {
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
      buttons.appendChild(modalButton(t("Cancel"), false, function () {
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
      buttons.appendChild(modalButton(t("Cancel"), false, function () {
        closeActiveModal();
        respondUi(id, { cancelled: true });
      }));
      buttons.appendChild(modalButton("OK", true, submit));
      el.appendChild(buttons);
      setTimeout(function () { ta.focus(); }, 0);
    }

    modalHolder.appendChild(el);
    activeModal = { frame: frame, el: el, previousFocus: document.activeElement };
    modalHolder.classList.add("active");
    notifyAndroidModalState(true);
    if (method === "confirm" || method === "select") {
      setTimeout(function () {
        var focusTarget = el.querySelector("button, textarea, input, [tabindex]:not([tabindex='-1'])");
        (focusTarget || el).focus();
      }, 0);
    }
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
    return configured ? t("configured ✓ (paste to replace)") : hint;
  }

  function showSetupCard() {
    if (setupCard) return;
    var el = document.createElement("div");
    el.className = "ui-modal setup-card";

    var title = document.createElement("div");
    title.className = "modal-title";
    title.textContent = t("Connect API keys");
    el.appendChild(title);

    var msg = document.createElement("div");
    msg.className = "modal-msg";
    msg.textContent = "Sign in with your Claude subscription (no API key needed), or paste API keys below. Everything is stored in VS Code Secret Storage; the agent restarts after saving.";
    el.appendChild(msg);

    function signinRow(label, providerId) {
      var row = document.createElement("div");
      row.className = "modal-buttons setup-signin";
      row.appendChild(modalButton(label, true, function () {
        if (post({ t: "login", providerId: providerId }) === false) return;
        toast(t("Opening browser for sign-in…"), 5000);
        closeSetupCard();
      }));
      el.appendChild(row);
    }
    signinRow(t("Sign in with Claude (Pro/Max)"), "anthropic");
    signinRow(t("Sign in with Kimi Code (subscription)"), "kimi-code");

    var divider = document.createElement("div");
    divider.className = "setup-divider";
    divider.textContent = t("— or use API keys —");
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
      // No env var means the key is written into models.yml instead; naming a
      // variable that nothing reads would send people editing their shell.
      var labelText = p.envVar
        ? t("{0} API key ({1})", p.label, p.envVar)
        : t("{0} API key", p.label);
      var inp = field(labelText, p.placeholder, keyStatus[p.id]);
      inputs.push({ id: p.id, inp: inp });
    });

    var buttons = document.createElement("div");
    buttons.className = "modal-buttons";
    buttons.appendChild(modalButton(t("Cancel"), false, function () {
      closeSetupCard();
    }));
    buttons.appendChild(modalButton(t("Save & Restart"), true, function () {
      var keys = {};
      var any = false;
      inputs.forEach(function (entry) {
        var v = entry.inp.value.trim();
        if (v) { keys[entry.id] = v; any = true; }
      });
      if (!any) { toast(t("Enter at least one key"), 3000); return; }
      post({ t: "setKeys", keys: keys });
      toast(t("Saving keys, restarting agent…"), 4000);
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
    if (min < 1) return t("just now");
    if (min < 60) return t("{0}m ago", min);
    var hours = Math.round(min / 60);
    if (hours < 24) return t("{0}h ago", hours);
    var days = Math.round(hours / 24);
    if (days < 30) return t("{0}d ago", days);
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
    title.textContent = t("Session history");
    el.appendChild(title);

    var filter = document.createElement("input");
    filter.className = "history-filter";
    filter.type = "text";
    filter.placeholder = t("Filter sessions…");
    filter.setAttribute("aria-label", t("Filter sessions"));
    filter.addEventListener("input", function () {
      renderHistoryRows(filter.value.trim().toLowerCase());
    });
    el.appendChild(filter);

    historyList = document.createElement("div");
    historyList.className = "history-list";
    historyList.textContent = t("Loading…");
    el.appendChild(historyList);

    var buttons = document.createElement("div");
    buttons.className = "modal-buttons";
    buttons.appendChild(modalButton(t("Close"), false, function () { closeHistoryCard(); }));
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
      historyList.textContent = query ? t("No sessions match.") : t("No sessions yet.");
      return;
    }
    sessions.forEach(function (s) {
      var row = document.createElement("div");
      row.className = "history-row";

      var main = document.createElement("div");
      main.className = "history-main";
      main.textContent = s.title || s.preview || t("(untitled session)");
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
      when.textContent = relativeTime(s.updatedAt) + " · " +
        (s.userMessages === 1 ? t("1 message") : t("{0} messages", s.userMessages));
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

  function syncFragmentKey(kind, m) {
    if (kind === "result") {
      var streamId = typeof m.streamId === "string" ? m.streamId : "";
      var commandId = typeof m.commandId === "string" ? m.commandId : "";
      if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(streamId) ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(commandId)) {
        throw new Error("fragmented command result identity is invalid");
      }
      return kind + ":" + streamId + ":" + commandId.toLowerCase();
    }
    var syncId = typeof m.syncId === "string" ? m.syncId : "";
    var sessionId = typeof m.sessionId === "string" ? m.sessionId : "";
    if (!syncId || !sessionId) throw new Error("fragmented sync identity is missing");
    if (kind === "transcript") {
      if (!Number.isSafeInteger(m.messageIndex) || m.messageIndex < 0) {
        throw new Error("transcript fragment message index is invalid");
      }
      return kind + ":" + syncId + ":" + sessionId + ":" + m.messageIndex;
    }
    var section = typeof m.section === "string" ? m.section : "";
    if (!section) throw new Error("sync section name is missing");
    return kind + ":" + syncId + ":" + sessionId + ":" + section;
  }

  function beginSyncFragment(kind, m) {
    var key = syncFragmentKey(kind, m);
    var count = m.fragmentCount;
    var total = m.totalBytes;
    var digest = typeof m.sha256 === "string" ? m.sha256.toLowerCase() : "";
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_SYNC_FRAGMENT_COUNT) {
      throw new Error("fragmented sync count is invalid");
    }
    if (!Number.isSafeInteger(total) || total < 1 || total > MAX_SYNC_FRAGMENT_BYTES) {
      throw new Error("fragmented sync size is invalid");
    }
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error("fragmented sync digest is invalid");
    if (syncFragments.has(key)) throw new Error("fragmented sync already exists");
    if (syncFragments.size >= MAX_ACTIVE_FRAGMENT_STREAMS) throw new Error("too many fragmented streams");
    var uiKind = null;
    var uiToken = null;
    if (kind === "result") {
      uiKind = typeof m.uiKind === "string" ? m.uiKind : "";
      if (["history", "files", "diagnostics", "models-probe", "diff"].indexOf(uiKind) < 0) {
        throw new Error("fragmented command result kind is invalid");
      }
      if (m.uiToken != null) {
        if (typeof m.uiToken !== "string" || !m.uiToken.length || m.uiToken.length > 128) {
          throw new Error("fragmented command result token is invalid");
        }
        uiToken = m.uiToken;
      }
      if ((uiKind === "files") !== !!uiToken) {
        throw new Error("fragmented file result token is missing or unexpected");
      }
    }
    syncFragments.set(key, {
      kind: kind,
      section: m.section,
      uiKind: uiKind,
      uiToken: uiToken,
      count: count,
      total: total,
      digest: digest,
      next: 0,
      received: 0,
      chunks: [],
    });
  }

  function decodeSyncChunk(data) {
    if (typeof data !== "string" || !data.length || data.length > 256 * 1024 ||
        data.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
      throw new Error("fragmented sync chunk is not canonical base64");
    }
    var binary = atob(data);
    var bytes = new Uint8Array(binary.length);
    for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  function appendSyncFragment(kind, m) {
    var key = syncFragmentKey(kind, m);
    var state = syncFragments.get(key);
    if (!state) throw new Error("fragmented sync was not started");
    if (!Number.isSafeInteger(m.fragmentIndex) || m.fragmentIndex !== state.next) {
      syncFragments.delete(key);
      throw new Error("fragmented sync arrived out of order");
    }
    var bytes = decodeSyncChunk(m.data);
    if (state.received + bytes.byteLength > state.total) {
      syncFragments.delete(key);
      throw new Error("fragmented sync exceeds its declared size");
    }
    state.chunks.push(bytes);
    state.received += bytes.byteLength;
    state.next++;
  }

  function bytesToHex(bytes) {
    var out = "";
    for (var i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
    return out;
  }

  async function commitSyncFragment(kind, m) {
    var key = syncFragmentKey(kind, m);
    var state = syncFragments.get(key);
    syncFragments.delete(key);
    if (!state || state.next !== state.count || state.received !== state.total) {
      throw new Error("fragmented sync is incomplete");
    }
    if (!window.crypto || !window.crypto.subtle) throw new Error("secure digest API is unavailable");
    var bytes = new Uint8Array(state.total);
    var offset = 0;
    state.chunks.forEach(function (chunk) { bytes.set(chunk, offset); offset += chunk.byteLength; });
    var digest = new Uint8Array(await window.crypto.subtle.digest("SHA-256", bytes));
    if (bytesToHex(digest) !== state.digest) throw new Error("fragmented sync digest mismatch");
    var value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (kind === "transcript") renderTranscript([value]);
    else if (kind === "section") applyRemoteSyncSection(state.section, value);
    else applyRemoteCommandResult(state.uiKind, state.uiToken, value);
  }

  function applyRemoteSyncSection(section, value) {
    switch (section) {
      case "state": applyState(value); break;
      case "models": models = Array.isArray(value) ? value : []; break;
      case "commands": commands = Array.isArray(value) ? value : []; break;
      case "stats": handleHostMessage({ t: "sessionStats", stats: value }); break;
      case "approvalMode": if (value) setApprovalChip(String(value)); break;
      case "profile": setProfileChip(value); break;
      case "configuration": handleHostMessage({ t: "boot", cfg: value }); break;
      case "approvals":
        if (Array.isArray(value)) value.forEach(function (frame) { handleFrame(frame); });
        break;
      default: throw new Error("unsupported fragmented sync section");
    }
  }

  function applyRemoteCommandResult(uiKind, uiToken, value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("fragmented command result is not an object");
    }
    switch (uiKind) {
      case "history":
        handleHostMessage({ t: "history", sessions: Array.isArray(value.sessions) ? value.sessions : [] });
        break;
      case "files":
        handleHostMessage({ t: "fileCandidates", token: uiToken, files: Array.isArray(value.files) ? value.files : [] });
        break;
      case "diagnostics":
        if (typeof value.markdown !== "string") throw new Error("fragmented diagnostics result is invalid");
        handleHostMessage({ t: "diagnosticsResult", markdown: value.markdown });
        break;
      case "models-probe":
        if (!value.results || typeof value.results !== "object" || Array.isArray(value.results)) {
          throw new Error("fragmented model probe result is invalid");
        }
        handleHostMessage({ t: "probe", results: value.results, running: false, enabled: true });
        break;
      case "diff":
        if (typeof value.changeId !== "string" || typeof value.afterSha256 !== "string") {
          throw new Error("fragmented diff result is invalid");
        }
        handleHostMessage({
          t: "diffContent",
          toolCallId: value.changeId,
          path: value.path,
          before: value.before,
          current: value.current,
          afterSha256: value.afterSha256,
        });
        break;
      default:
        throw new Error("unsupported fragmented command result");
    }
  }

  function enqueueSyncApply(context, action) {
    syncApplyQueue = syncApplyQueue.then(action).catch(function (err) {
      reportUiError(err, context);
    });
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
    return PROVIDER_LABELS[id] || String(id || t("provider"));
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
    title.textContent = t("Sign in to {0}", providerLabel(authProvider));
    el.appendChild(title);

    var code = extractUserCode(instructions);

    var msg = document.createElement("div");
    msg.className = "modal-msg";
    msg.textContent = code
      ? t("A browser tab was opened. Confirm this code on the page, then come back — the agent restarts by itself once authorization goes through.")
      : t("A browser tab was opened. Finish the sign-in there; if a code is requested back here, an input box appears.");
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
    status.textContent = t("Waiting for authorization…");
    el.appendChild(status);

    var buttons = document.createElement("div");
    buttons.className = "modal-buttons";
    if (code) {
      buttons.appendChild(modalButton(t("Copy code"), false, function () {
        post({ t: "copy", text: code });
        toast(t("Code copied"), 2000);
      }));
    }
    if (url) {
      buttons.appendChild(modalButton(t("Open page again"), false, function () {
        post({ t: "openExternal", url: String(url) });
      }));
    }
    buttons.appendChild(modalButton(t("Hide"), true, function () {
      closeAuthCard();
      toast(t("Sign-in still running in the background"), 4000);
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
    title.textContent = t("Stored {0} API key is rejected", label);
    el.appendChild(title);

    var msg = document.createElement("div");
    msg.className = "modal-msg";
    msg.textContent = "The provider answers 401 for every model behind this key, so they are hidden from the picker. Removing the key does not touch your subscription sign-ins.";
    el.appendChild(msg);

    var buttons = document.createElement("div");
    buttons.className = "modal-buttons";
    buttons.appendChild(modalButton(t("Keep it"), false, function () {
      closeDeadKeyCard();
    }));
    buttons.appendChild(modalButton(t("Remove key"), true, function () {
      post({ t: "clearKey", which: which });
      toast(t("{0} key removed — restarting agent", label), 4000);
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
    el.setAttribute("role", "menuitem");
    el.setAttribute("tabindex", "0");
    el.textContent = String(text);
    el.addEventListener("click", onClick);
    el.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onClick();
      }
    });
    menu.appendChild(el);
    return el;
  }

  function addCapabilityMenuItem(menu, capability, text, onClick) {
    if (!hasRemoteCapability(capability)) return null;
    return addMenuItem(menu, text, onClick);
  }

  /**
   * Two-line menu row: the value on top, what it actually does underneath.
   * `current` draws the ✓ so a menu answers "what is set now" without a
   * second glance at the chip.
   */
  function addMenuChoice(menu, text, hint, current, onClick) {
    var el = document.createElement("div");
    el.className = "menu-item menu-choice" + (current ? " menu-choice-on" : "");
    el.setAttribute("role", "menuitemradio");
    el.setAttribute("aria-checked", current ? "true" : "false");
    el.setAttribute("tabindex", "0");
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
    el.addEventListener("keydown", function (event) {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        onClick();
      }
    });
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
    approvalChip.textContent = t("access: {0}", m.short);
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
      ? t("{0} profile — {1}", family, String(currentProfile.note))
      : t("{0} profile — click to see what it sets", family);
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
  function addProfileRow(menu, label, value, source, onClick) {
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
    if (onClick) {
      // Editable rows are the ones whose value is a closed set; the caret
      // says so without needing a legend.
      row.className += " profile-row-edit";
      row.setAttribute("role", "button");
      row.setAttribute("tabindex", "0");
      var caret = document.createElement("span");
      caret.className = "profile-row-caret";
      caret.textContent = "›";
      head.appendChild(caret);
      row.addEventListener("click", onClick);
      row.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); }
      });
    }
    menu.appendChild(row);
    return row;
  }

  /**
   * Write one profile field to `ompcode.modelProfiles`, or clear it with a
   * null value. This is deliberately not the same as the `think:`/`access:`
   * chips: those steer the current session, while this is a standing rule for
   * every model of the family, so the agent restarts to pick it up.
   */
  function setProfileField(field, value) {
    if (!currentProfile || currentProfile.family == null) return;
    if (post({ t: "setProfileField", family: String(currentProfile.family), field: field, value: value }) === false) return;
    closeMenu();
    toast(value === null
      ? t("Cleared — back to the built-in value. Restarting agent…")
      : t("Saved to your settings. Restarting agent…"), 4000);
  }

  function buildProfileThinkingMenu(menu) {
    var p = currentProfile;
    if (!p) return;
    if (!hasRemoteCapability("settings.manage")) {
      addMenuLabel(menu, t("This action is not allowed by the Remote Control permissions selected on the computer."));
      return;
    }
    var current = p.runtime && p.runtime.thinking != null ? String(p.runtime.thinking) : null;
    addMenuLabel(menu, t("thinking — {0}", p.family != null ? String(p.family) : t("generic")));
    var choice = thinkingChoicesFor(currentModel);
    // `inherit` is the honest option for a family whose members disagree on
    // the ladder: it defers to whatever omp resolved for this exact model.
    addMenuChoice(menu, "inherit", t("Use whatever level this model defaults to"),
      current === "inherit", function () { setProfileField("runtime.thinking", "inherit"); });
    choice.levels.forEach(function (level) {
      addMenuChoice(menu, level, THINKING_HINTS[level], level === current, function () {
        setProfileField("runtime.thinking", level);
      });
    });
    addProfileMenuFooter(menu, "runtime.thinking");
  }

  function buildProfileAccessMenu(menu) {
    var p = currentProfile;
    if (!p) return;
    if (!hasRemoteCapability("settings.manage")) {
      addMenuLabel(menu, t("This action is not allowed by the Remote Control permissions selected on the computer."));
      return;
    }
    var current = p.spawn && p.spawn.approvalMode != null ? String(p.spawn.approvalMode) : null;
    addMenuLabel(menu, t("tool access — {0}", p.family != null ? String(p.family) : t("generic")));
    APPROVAL_MODES.forEach(function (m) {
      addMenuChoice(menu, m.id, m.label + " — " + m.hint, m.id === current, function () {
        setProfileField("spawn.approvalMode", m.id);
      });
    });
    addProfileMenuFooter(menu, "spawn.approvalMode");
  }

  /** Shared tail: reset (only when there is an override) and a way back. */
  function addProfileMenuFooter(menu, field) {
    if (provenanceOf(currentProfile, field) === "user") {
      addMenuItem(menu, t("Reset to the built-in value"), function () {
        setProfileField(field, null);
      });
    }
    addMenuItem(menu, t("‹ Back to the profile"), function () {
      closeMenu();
      openMenu(profileChip, buildProfileMenu);
    });
  }

  function buildProfileMenu(menu) {
    var p = currentProfile;
    if (!p) {
      addMenuLabel(menu, t("profile"));
      addMenuItem(menu, t("No profile resolved yet"), function () { closeMenu(); });
      return;
    }
    addMenuLabel(menu, t("profile — {0}", p.family != null ? String(p.family) : t("generic")));

    if (p.note) {
      var note = document.createElement("div");
      note.className = "profile-note";
      note.textContent = String(p.note);
      menu.appendChild(note);
    }

    var runtime = p.runtime && typeof p.runtime === "object" ? p.runtime : {};
    var spawn = p.spawn && typeof p.spawn === "object" ? p.spawn : {};

    if (p.contextFile != null && p.contextFile !== "") {
      addProfileRow(menu, t("instructions file"), p.contextFile, provenanceOf(p, "contextFile"));
    }

    // Thinking and tool access always resolve to something — the base profile
    // sets both — so these two rows are always here to be clicked.
    addProfileRow(menu, "thinking", runtime.thinking, provenanceOf(p, "runtime.thinking"),
      hasRemoteCapability("settings.manage") ? function () {
        closeMenu();
        openMenu(profileChip, buildProfileThinkingMenu);
      } : null);

    var accessRow = addProfileRow(menu, t("tool access"), spawn.approvalMode,
      provenanceOf(p, "spawn.approvalMode"), hasRemoteCapability("settings.manage") ? function () {
        closeMenu();
        openMenu(profileChip, buildProfileAccessMenu);
      } : null);
    // The raw id is what a settings row would carry, so that is what the
    // value shows; the plain-English reading goes on the tooltip.
    for (var i = 0; i < APPROVAL_MODES.length; i++) {
      if (APPROVAL_MODES[i].id === spawn.approvalMode) {
        accessRow.title = APPROVAL_MODES[i].label + " — " + APPROVAL_MODES[i].hint;
        break;
      }
    }

    var overlay = spawn.overlay && typeof spawn.overlay === "object" ? spawn.overlay : null;
    var keys = overlay ? Object.keys(overlay) : [];
    if (keys.length) {
      addMenuLabel(menu, t("settings overlay"));
      keys.forEach(function (k) {
        // The resolver records provenance for `spawn.overlay` as a single
        // field. A per-key entry wins if a later layer ever records one.
        var src = provenanceOf(p, "spawn.overlay." + k) || provenanceOf(p, "spawn.overlay");
        addProfileRow(menu, k, overlay[k], src);
      });
    }

    if (remoteCapabilityVerbs === null) {
      addMenuItem(menu, t("Edit ompcode.modelProfiles…"), function () {
        closeMenu();
        post({ t: "openProfileSettings" });
      });
      addMenuLabel(menu, t("the rest is edited in settings.json"));
    }
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
    var think = model && typeof model === "object" ? model.thinking : null;
    var efforts = think && Array.isArray(think.efforts) ? think.efforts.slice() : null;
    if (!efforts || !efforts.length) {
      // No reasoning support, or a model omp could not classify (custom
      // provider). Fall back to the full list rather than an empty menu.
      var reasons = model && typeof model === "object" && model.reasoning === false;
      return { levels: reasons ? [] : THINKING_LEVELS.slice(), unknown: !reasons, none: !!reasons };
    }
    var out = [];
    // `off` only when thinking is not mandatory server-side.
    if (!think.requiresEffort) out.push("off");
    efforts.forEach(function (e) { if (THINKING_HINTS[e] != null) out.push(e); });
    out.push("auto");
    return { levels: out, unknown: false, none: false };
  }

  function openMenu(anchor, build) {
    if (openMenuEl && openMenuAnchor === anchor) { closeMenu(); return; }
    closeMenu();
    var menu = document.createElement("div");
    menu.className = "menu";
    menu.setAttribute("role", "menu");
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
      addMenuLabel(menu, t("models"));
      addMenuItem(menu, t("Loading models…"), function () { closeMenu(); });
      return;
    }
    var list = usableModels();
    var hidden = models.length - list.length;

    if (probe.enabled && probe.running) {
      addMenuLabel(menu, t("checking subscriptions…"));
    }
    if (!list.length) {
      addMenuLabel(menu, t("models"));
      addMenuItem(menu, t("No model answered — check your sign-ins"), function () { closeMenu(); });
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
          if (post({ t: "setModel", provider: m.provider, modelId: m.id }) === false) return;
          modelChip.textContent = m.name != null ? m.name : (m.id != null ? m.id : "model");
          closeMenu();
        });
        if (v && !v.ok) item.classList.add("menu-item-dead");
      });
    });

    addMenuLabel(menu, t("routing"));
    addMenuItem(menu, t("Route the next prompt through a different model…"), function () {
      armRouteChip();
      closeMenu();
      openMenu(routeChip, buildRouteMenu);
    });

    if (!probe.enabled) return;
    addMenuLabel(menu, t("verification"));
    if (hidden > 0 || showAllModels) {
      addMenuItem(menu, showAllModels ? t("Hide models that failed") : t("Show all models ({0} hidden)", hidden), function () {
        showAllModels = !showAllModels;
        closeMenu();
        openMenu(modelChip, buildModelMenu);
      });
    }
    addCapabilityMenuItem(menu, "prompt", probe.running ? t("Checking…") : t("Re-check subscriptions"), function () {
      if (probe.running) return;
      if (post({ t: "recheckModels" }) === false) return;
      toast(t("Checking which models answer…"), 4000);
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
      addMenuLabel(menu, name ? t("thinking — {0}", name) : t("thinking"));

      if (choice.none) {
        addMenuChoice(menu, t("Not supported"), t("This model does not reason — nothing to set"), false, function () {
          closeMenu();
        });
        return;
      }
      if (choice.unknown) {
        addMenuLabel(menu, t("levels unverified for this model"));
      }
      choice.levels.forEach(function (level) {
        addMenuChoice(menu, level, THINKING_HINTS[level], level === thinkingChoice, function () {
          if (post({ t: "setThinking", level: level }) === false) return;
          thinkingChoice = level;
          currentThinking = level;
          thinkingChip.textContent = t("think: {0}", level);
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
        addMenuLabel(menu, t("tool access"));
        APPROVAL_MODES.forEach(function (m) {
          addMenuChoice(menu, m.label, m.hint, m.id === currentApproval, function () {
            closeMenu();
            if (m.id === currentApproval) return;
            if (post({ t: "setApproval", mode: m.id }) === false) return;
            setApprovalChip(m.id);
            toast(t("Tool access: {0} — restarting agent", m.label), 4000);
          });
        });
        addMenuLabel(menu, t("changing this restarts the agent"));
      });
    });
  }

  // One-shot routing chip: pick a model for the next prompt only. Hidden
  // until armed from the model menu; sending consumes and hides it again.
  function setRoute(choice) {
    routeChoice = choice;
    if (!routeChip) return;
    if (choice) {
      routeChip.textContent = t("route: {0}", choice.label);
    } else {
      routeChip.textContent = t("route: …");
    }
  }

  function armRouteChip() {
    if (!routeChip) return;
    routeChip.classList.remove("hidden");
    if (!routeChoice) routeChip.textContent = t("route: …");
  }

  function buildRouteMenu(menu) {
    addMenuLabel(menu, t("Route the next prompt"));
    if (routeChoice) {
      addMenuItem(menu, t("Clear route ({0})", routeChoice.label), function () {
        setRoute(null);
        if (routeChip) routeChip.classList.add("hidden");
        closeMenu();
      });
    }
    if (!models.length) {
      addMenuItem(menu, t("Loading models…"), function () { closeMenu(); });
      return;
    }
    var list = usableModels();
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
        var active = routeChoice && routeChoice.provider === m.provider && routeChoice.modelId === m.id;
        addMenuItem(menu, (active ? "✓ " : "") + label, function () {
          setRoute({ provider: m.provider, modelId: m.id, label: label });
          armRouteChip();
          closeMenu();
        });
      });
    });
    addMenuLabel(menu, t("applies to the next prompt only"));
  }

  if (routeChip) {
    routeChip.addEventListener("click", function () {
      if (!models.length) post({ t: "getModels" });
      openMenu(routeChip, buildRouteMenu);
    });
  }

  // Guarded like btnHistory and the access chip: the badge is optional, so an
  // older skeleton must degrade to "no badge", never to a module-level throw.
  if (profileChip) {
    profileChip.addEventListener("click", function () {
      openMenu(profileChip, buildProfileMenu);
    });
  }

  // Slash commands the panel answers by itself. They never reach the agent: the
  // host runs a VS Code command instead, from a fixed allowlist. Hidden on
  // Android, where the phone is already the far end of Remote Control and the
  // desktop is the only place that may mint a pairing.
  var localCommands = hostPort.kind === "android" ? [] : [
    {
      name: "remote",
      description: t("Connect a phone — pick the scope, then scan the QR"),
      menuLabel: t("Connect a phone…"),
      run: "ompcode.remoteStart",
    },
    {
      name: "remote-all",
      description: t("Pair a phone with every chat in the project folders open right now"),
      menuLabel: t("Connect a phone — all sessions"),
      run: "ompcode.remoteStartAllSessions",
    },
    {
      name: "remote-qr",
      description: t("Mint a fresh pairing QR for the phone — same permissions, new code"),
      menuLabel: t("Refresh the QR code…"),
      run: "ompcode.remoteRefreshPairing",
    },
    {
      name: "remote-status",
      description: t("Show what the paired phone may do right now"),
      menuLabel: t("Remote Control status"),
      run: "ompcode.remoteStatus",
    },
    {
      name: "remote-stop",
      description: t("Stop Remote Control and revoke the phone"),
      menuLabel: t("Stop Remote Control"),
      run: "ompcode.remoteStop",
    },
  ];

  function localCommandNamed(name) {
    var wanted = String(name).replace(/^\//, "").toLowerCase();
    for (var i = 0; i < localCommands.length; i++) {
      if (localCommands[i].name.toLowerCase() === wanted) return localCommands[i];
    }
    return null;
  }

  function postLocalCommand(c) {
    if (!c || !c.run) return;
    post({ t: "runCommand", command: c.run });
  }

  /** Composer route: the typed command is consumed, so the draft goes with it. */
  function runLocalCommand(c) {
    if (!c || !c.run) return;
    postLocalCommand(c);
    input.value = "";
    hideSlash();
    autogrow();
    input.focus();
  }


  /* ------------------------------------------------------------------ */
  /* Settings screen                                                     */
  /* ------------------------------------------------------------------ */

  // The gear used to open a dropdown holding accounts, keys, models, Remote
  // Control, five session actions and diagnostics. That is a settings window
  // wearing a menu's clothes, so it is a window now: one full-screen surface,
  // identical in VS Code and on the phone, built from the same registries.
  var settingsScreen = null;

  function settingsGroup(body, title) {
    var section = document.createElement("section");
    section.className = "settings-group";
    var head = document.createElement("h2");
    head.textContent = String(title);
    section.appendChild(head);
    body.appendChild(section);
    return section;
  }

  /**
   * One row: what it is on the left, the single thing it does on the right.
   *
   * Capability-gated exactly as the old menu was — a phone must never be shown a
   * button the desktop grant would refuse, because a refusal after the tap reads
   * as a bug rather than as a boundary.
   */
  function settingsRow(section, capability, label, hint, actionLabel, onClick) {
    if (capability && !hasRemoteCapability(capability)) return null;
    var row = document.createElement("div");
    row.className = "settings-row";
    var text = document.createElement("div");
    text.className = "settings-row-text";
    var name = document.createElement("div");
    name.className = "settings-row-label";
    name.textContent = String(label);
    text.appendChild(name);
    if (hint) {
      var sub = document.createElement("div");
      sub.className = "settings-row-hint";
      sub.textContent = String(hint);
      text.appendChild(sub);
    }
    row.appendChild(text);
    var action = document.createElement("button");
    action.type = "button";
    action.className = "settings-action";
    action.textContent = String(actionLabel);
    action.addEventListener("click", onClick);
    row.appendChild(action);
    section.appendChild(row);
    return row;
  }

  function buildSettingsBody(body) {
    var accounts = settingsGroup(body, t("Accounts and keys"));
    settingsRow(accounts, "credentials.manage", t("Claude Pro/Max"), t("Sign in with a subscription — no API key needed"), t("Sign in"), function () {
      if (post({ t: "login", providerId: "anthropic" }) === false) return;
      toast(t("Opening browser for sign-in…"), 5000);
    });
    settingsRow(accounts, "credentials.manage", t("Kimi Code"), t("Sign in with a Kimi Code subscription"), t("Sign in"), function () {
      if (post({ t: "login", providerId: "kimi-code" }) === false) return;
      toast(t("Opening browser for sign-in…"), 5000);
    });
    // Desktop only, and not an oversight. Z.AI answers on a loopback callback
    // port and Qwen hands back a token to paste, so both need the browser on the
    // machine running the agent; from a phone they are a dead end. The host
    // refuses them over the remote link for the same reason.
    if (hostPort.kind !== "android") {
      settingsRow(accounts, "credentials.manage", t("GLM Coding Plan"), t("Sign in with Z.AI — the browser opens on this computer"), t("Sign in"), function () {
        if (post({ t: "login", providerId: "zai-coding-plan" }) === false) return;
        toast(t("Opening browser for sign-in…"), 5000);
      });
      settingsRow(accounts, "credentials.manage", t("Qwen Portal"), t("Sign in with Qwen — the browser opens on this computer"), t("Sign in"), function () {
        if (post({ t: "login", providerId: "qwen-portal" }) === false) return;
        toast(t("Opening browser for sign-in…"), 5000);
      });
      settingsRow(accounts, "credentials.manage", t("ChatGPT Plus/Pro"), t("Sign in with a Codex subscription — the browser opens on this computer"), t("Sign in"), function () {
        if (post({ t: "login", providerId: "openai-codex" }) === false) return;
        toast(t("Opening browser for sign-in…"), 5000);
      });
    }
    settingsRow(accounts, "credentials.manage", t("API keys"), t("Stored in VS Code Secret Storage; the agent restarts after saving"), t("Edit"), function () {
      // The key form is a modal card and modals render under this screen, so the
      // screen steps aside rather than hiding the thing it just opened.
      closeSettings();
      showSetupCard();
    });
    keyedProviders.forEach(function (p) {
      if (!keyStatus[p.id]) return;
      settingsRow(accounts, "credentials.manage", t("Stored {0} API key", p.label), t("Removing it restarts the agent"), t("Remove"), function () {
        post({ t: "clearKey", which: p.id });
        toast(t("{0} key removed — restarting agent", p.label), 4000);
        refreshSettingsBody();
      });
    });

    var modelsGroup = settingsGroup(body, t("Models"));
    settingsRow(modelsGroup, "prompt", t("Which models answer"), t("Ask every configured provider what it will actually serve"), t("Re-check"), function () {
      if (post({ t: "recheckModels" }) === false) return;
      toast(t("Checking which models answer…"), 4000);
    });

    // Same registry as the /remote slash commands, so a command cannot appear
    // behind one door and not the other. Empty on Android, where the phone is
    // already the far end and only the desktop may mint a pairing.
    if (localCommands.length) {
      var remoteGroup = settingsGroup(body, t("Remote Control"));
      localCommands.forEach(function (command) {
        settingsRow(remoteGroup, null, command.menuLabel, command.description, t("Open"), function () {
          postLocalCommand(command);
          closeSettings();
        });
      });
    }

    var chat = settingsGroup(body, t("This chat"));
    settingsRow(chat, "session.manage", t("New chat tab"), t("A second agent, in its own tab"), t("Open"), function () {
      post({ t: "openNewTab" });
      closeSettings();
    });
    settingsRow(chat, "session.manage", t("Clear this session"), t("Forget the transcript and start the same agent over"), t("Clear"), function () {
      post({ t: "newSession" });
      closeSettings();
    });
    settingsRow(chat, "view", t("Export transcript"), t("Save the whole conversation as Markdown"), t("Export"), function () {
      post({ t: "exportTranscript" });
      closeSettings();
    });
    settingsRow(chat, "session.manage", t("Compact context"), t("Summarise the history so the agent keeps room to think"), t("Compact"), function () {
      if (post({ t: "compact" }) === false) return;
      toast(t("Compacting context…"), 3000);
      closeSettings();
    });
    settingsRow(chat, "session.manage", t("Restart agent"), t("Restart the process; the transcript stays"), t("Restart"), function () {
      if (post({ t: "restart" }) === false) return;
      toast(t("Restarting agent…"), 3000);
      closeSettings();
    });

    var diagnostics = settingsGroup(body, t("Diagnostics"));
    settingsRow(diagnostics, "view", t("Run diagnostics"), t("Versions, paths and what the agent can reach"), t("Run"), function () {
      post({ t: "diagnostics" });
      toast(t("Running diagnostics…"), 4000);
      closeSettings();
    });

    // A gate that removed every row would leave a heading over nothing.
    Array.prototype.slice.call(body.querySelectorAll(".settings-group")).forEach(function (section) {
      if (!section.querySelector(".settings-row")) section.remove();
    });

    if (hostPort.kind !== "android") {
      var note = document.createElement("p");
      note.className = "settings-note";
      note.textContent = t("Everything else — palette, fonts, agent binary — lives in settings.json.");
      body.appendChild(note);
      var open = document.createElement("button");
      open.type = "button";
      open.className = "settings-action settings-note-action";
      open.textContent = t("Open settings.json");
      open.addEventListener("click", function () {
        post({ t: "openProfileSettings" });
        closeSettings();
      });
      body.appendChild(open);
    }
  }

  /** Rebuild in place: removing a key changes which rows belong here. */
  function refreshSettingsBody() {
    if (!settingsScreen) return;
    var body = settingsScreen.el.querySelector(".settings-body");
    if (!body) return;
    body.textContent = "";
    buildSettingsBody(body);
  }

  function openSettings() {
    if (settingsScreen) return;
    closeMenu();
    var el = document.createElement("div");
    el.className = "settings-screen";
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.setAttribute("aria-label", t("Settings"));

    var head = document.createElement("header");
    head.className = "settings-head";
    var title = document.createElement("h1");
    title.textContent = t("Settings");
    head.appendChild(title);
    var close = document.createElement("button");
    close.type = "button";
    close.className = "settings-close";
    close.setAttribute("aria-label", t("Close settings"));
    close.textContent = "✕";
    close.addEventListener("click", closeSettings);
    head.appendChild(close);
    el.appendChild(head);

    var body = document.createElement("div");
    body.className = "settings-body";
    el.appendChild(body);
    buildSettingsBody(body);

    el.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        event.stopPropagation();
        closeSettings();
      }
    });

    document.body.appendChild(el);
    settingsScreen = { el: el, previousFocus: document.activeElement };
    // The native shell hides its drawer button and routes Back here while a modal
    // owns the screen. A full-screen settings surface is exactly that.
    notifyAndroidModalState(true);
    setTimeout(function () { close.focus(); }, 0);
  }

  function closeSettings() {
    if (!settingsScreen) return;
    var previousFocus = settingsScreen.previousFocus;
    settingsScreen.el.remove();
    settingsScreen = null;
    // An approval modal may already be waiting underneath; do not tell the shell
    // the screen is free while something still owns it.
    notifyAndroidModalState(Boolean(activeModal));
    if (previousFocus && previousFocus.isConnected && typeof previousFocus.focus === "function") {
      setTimeout(function () { previousFocus.focus(); }, 0);
    }
  }

  btnSettings.addEventListener("click", openSettings);

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
    var pool = localCommands.concat(commands);
    if (!m || !pool.length) { hideSlash(); return; }
    var q = m[1].toLowerCase();
    slashItems = pool.filter(function (c) {
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
      if (c.run) {
        // A panel command opens VS Code UI instead of prompting the agent, so
        // say so rather than letting it look like one more agent command.
        var tag = document.createElement("span");
        tag.className = "slash-tag";
        tag.textContent = t("panel");
        el.appendChild(tag);
      }
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
    if (c.run) { runLocalCommand(c); return; }
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
    if (hostPort.kind === "android") { hideAt(); return; }
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
      if (custom) toast(t("Ignoring ompcode.accentColor: {0} is not a CSS color", custom), 6000);
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
      chip.title = att.pending
        ? t("Copying…")
        : att.path +
          (att.selection
            ? " " + t("(lines {0}–{1})", att.selection.startLine, att.selection.endLine)
            : "");

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
      rm.title = t("Remove");
      rm.setAttribute("aria-label", t("Remove {0}", att.name));
      rm.textContent = "✕";
      rm.addEventListener("click", function () {
        var remoteAttachmentId = att.attachmentId ||
          (typeof att.path === "string" && att.path.indexOf("remote:") === 0
            ? att.path.slice("remote:".length)
            : "");
        if (remoteAttachmentId) {
          post({ t: "cancelAttachment", attachmentId: remoteAttachmentId });
        }
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
      toast(t("Could not read {0}", file.name || t("the pasted file")), 5000);
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
      toast(t("Nothing attachable on the clipboard"), 4000);
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
      toast(t("Nothing attachable in that drop"), 4000);
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
    // Typed and sent without touching the popup, "/remote" still has to run the
    // panel command rather than travel to the agent as a prompt it cannot serve.
    var typedLocal = /^\/\S+$/.test(text) ? localCommandNamed(text) : null;
    if (typedLocal && files.length === 0) { runLocalCommand(typedLocal); return; }
    if (attachments.length !== files.length) {
      toast(t("Still copying an attachment…"), 3000);
      return;
    }
    if (post({ t: "prompt", text: text, attachments: files, forModel: routeChoice ? { provider: routeChoice.provider, modelId: routeChoice.modelId } : undefined }) === false) return;
    if (routeChoice) {
      // One-shot: consumed by this send; the host restores the session model
      // after the turn. The chip hides until armed again.
      setRoute(null);
      if (routeChip) routeChip.classList.add("hidden");
    }
    if (text && promptHistory[promptHistory.length - 1] !== text) {
      promptHistory.push(text);
      if (promptHistory.length > 100) promptHistory.shift();
    }
    historyIdx = -1;
    historyDraft = "";
    lastSentText = text;
    lastSentFiles = files.length ? files : null;
    // Sent while a turn was already running — omp queues it as a steer.
    pendingLocalUser++;
    addUserBubble(text, files, { steer: working });
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
    if (hostPort.kind !== "android" && e.key === "Enter" && !e.shiftKey && !e.isComposing) {
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
    if (post({ t: "restart" }) === false) return;
    procBanner.classList.add("hidden");
    toast(t("Restarting agent…"), 3000);
  });

  // `.tool-revert` also carries `.tool-diff` styling. Classify the specific
  // action first so the shared style class can never turn a revert into a diff.
  function toolButtonMessage(target) {
    var revertBtn = target.closest(".tool-revert");
    if (revertBtn) {
      return { t: "rejectEdit", toolCallId: revertBtn.getAttribute("data-id") };
    }
    var diffBtn = target.closest(".tool-diff");
    if (diffBtn) {
      return { t: "openDiff", toolCallId: diffBtn.getAttribute("data-id") };
    }
    return null;
  }

  // Global Escape: modal > menu > slash popup > abort
  document.addEventListener("keydown", function (e) {
    if (activeModal && e.key === "Tab") {
      var focusable = Array.prototype.slice.call(activeModal.el.querySelectorAll(
        "button:not([disabled]), textarea:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex='-1'])",
      ));
      if (focusable.length) {
        var first = focusable[0];
        var last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
      return;
    }
    if (e.key !== "Escape") return;
    if (activeModal) { cancelActiveModal(); return; }
    if (openMenuEl) { closeMenu(); return; }
    if (slashVisible()) { hideSlash(); return; }
    if (atVisible()) { hideAt(); return; }
    if (working) post({ t: "abort" });
  });

  // Delegated clicks: markdown links, thinking + tool card toggles
  document.addEventListener("click", function (e) {
    var target = e.target;
    if (!target || !target.closest) return;
    var a = target.closest("a[data-href]");
    if (a) {
      e.preventDefault();
      post({ t: "openExternal", url: a.getAttribute("data-href") });
      return;
    }
    var th = target.closest(".thinking-head");
    if (th && th.parentElement) {
      th.parentElement.classList.toggle("collapsed");
      th.setAttribute("aria-expanded", th.parentElement.classList.contains("collapsed") ? "false" : "true");
      return;
    }
    var toolButtonMsg = toolButtonMessage(target);
    if (toolButtonMsg) {
      post(toolButtonMsg);
      return;
    }
    var head = target.closest(".tool-head");
    if (head) { toggleTool(head.closest(".tool-card")); return; }
    var more = target.closest(".tool-more");
    if (more) { toggleTool(more.closest(".tool-card")); return; }
    var insertBtn = target.closest(".code-insert");
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
    var copyBtn = target.closest(".code-copy");
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

  document.addEventListener("keydown", function (e) {
    if (e.key !== "Enter" && e.key !== " ") return;
    var target = e.target;
    if (!target || !target.closest) return;
    var thinking = target.closest(".thinking-head");
    if (thinking) {
      e.preventDefault();
      thinking.click();
      return;
    }
    var tool = target.closest(".tool-head");
    if (tool) {
      e.preventDefault();
      toggleTool(tool.closest(".tool-card"));
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
        thinkingChip.textContent = t("think: auto → {0}", currentThinking);
      } else {
        thinkingChoice = currentThinking;
        thinkingChip.textContent = t("think: {0}", currentThinking);
      }
    }
    if (state.sessionName) sessionTitle.textContent = String(state.sessionName);

    // Context fill is not shown as a chip: a number that reads 2% for most of
    // a session is noise. It surfaces only once it starts to matter.
    autoCompaction = state.autoCompactionEnabled !== false;
    noteContextFill(contextPercent(state.contextUsage, model), autoCompaction);

    if (typeof state.isStreaming === "boolean") setWorking(state.isStreaming);
    // omp counts the steer queue itself — no local bookkeeping to drift.
    var queued = state.queuedMessageCount;
    if (typeof queued === "number" && queued > 0) {
      queueEl.textContent = t("queued: {0}", queued);
      queueEl.classList.remove("hidden");
    } else {
      queueEl.textContent = "";
      queueEl.classList.add("hidden");
    }
  }

  function applyRemoteShellState(message) {
    if (hostPort.kind !== "android" || !message || typeof message !== "object") return;
    if (typeof message.title === "string" && message.title.trim()) {
      remoteShellTitle = message.title.trim().slice(0, 256);
      sessionTitle.textContent = remoteShellTitle;
    }
    if (!connectionStateEl) return;
    var allowed = ["connected", "connecting", "reconnecting", "offline"];
    var next = allowed.indexOf(message.connectionState) >= 0
      ? message.connectionState
      : "connecting";
    connectionStateEl.setAttribute("data-state", next);
    connectionStateEl.textContent = typeof message.connectionLabel === "string" && message.connectionLabel.trim()
      ? message.connectionLabel.trim().slice(0, 160)
      : (connectionStateEl.textContent || "Connecting securely…");
    document.body.setAttribute("data-connection-state", next);
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
    // The orphan container is one of the children just removed above; drop the
    // reference too, or the next spawn appends into a detached node.
    subagentRows.clear();
    subagentOrphansEl = null;
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
    modalHolder.classList.remove("active");
    notifyAndroidModalState(false);
    stuck = true;
    sessionTitle.textContent = remoteShellTitle || "OMP Code";
    setRoute(null);
    if (routeChip) routeChip.classList.add("hidden");
    syncFragments.clear();
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
      case "subagent_lifecycle":
        onSubagentLifecycle(f.payload);
        break;
      // Progress and events are rendered from the host's coalesced
      // `t:"subagents"` snapshot instead — a single subagent emits dozens of
      // these per second. The cases exist so they are recognised rather than
      // falling through to the unknown-frame default.
      case "subagent_progress":
      case "subagent_event":
        break;
      case "notice":
        addNotice(f.level, f.message);
        break;
      case "auto_retry_start": {
        var att = f.attempt != null ? f.attempt : "?";
        var max = f.maxAttempts != null ? f.maxAttempts : "?";
        var txt = t("Retrying ({0}/{1})", att, max) +
          (typeof f.delayMs === "number" ? " " + t("in {0}s", Math.round(f.delayMs / 100) / 10) : "") +
          (f.errorMessage ? " — " + f.errorMessage : "");
        if (retryNotice && retryNotice.isConnected) retryNotice.textContent = txt;
        else retryNotice = addNotice("info", txt);
        break;
      }
      case "auto_retry_end":
        if (retryNotice) { retryNotice.remove(); retryNotice = null; }
        break;
      case "auto_compaction_start":
        compactNotice = addNotice("info", t("Compacting context…"));
        break;
      case "auto_compaction_end":
        if (compactNotice) { compactNotice.remove(); compactNotice = null; }
        else addNotice("info", t("Context compacted."));
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

  function handleHostMessage(m) {
    if (!m || typeof m !== "object") return;
    try {
      switch (m.t) {
        case "frame":
          handleFrame(m.frame);
          break;
        case "approvalResolved":
          dropApprovalModal(m.requestId);
          break;
        case "subagents":
          renderSubagents(m.snapshot);
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
          // A steer that failed leaves the running turn untouched — killing
          // the working line here would hide a live agent.
          if (!m.steer) setWorking(false);
          if (pendingLocalUser > 0) pendingLocalUser--;
          if (input.value === "" && lastSentText) {
            input.value = lastSentText;
            attachments = lastSentFiles ? lastSentFiles : [];
            renderAttachments();
            autogrow();
          }
          lastSentText = "";
          lastSentFiles = null;
          break;
        case "state":
          applyState(m.state);
          break;
        case "remoteShellState":
          applyRemoteShellState(m);
          break;
        case "androidBack":
          if (settingsScreen) closeSettings();
          else if (activeModal) cancelActiveModal();
          else notifyAndroidModalState(false);
          break;
        case "commands":
          commands = Array.isArray(m.commands) ? m.commands : [];
          break;
        case "proc": {
          var status = m.status;
          if (status === "exited" || status === "error") {
            if (m.needsSetup) {
              procText.textContent = t("No API keys configured — the agent has no models to use.");
              showSetupCard();
            } else {
              procText.textContent = m.detail
                ? t("Agent is not running ({0}).", m.detail)
                : t("Agent is not running.");
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
        case "transcriptReset":
          enqueueSyncApply("transcriptReset", function () { resetView(); });
          break;
        case "transcriptAppend":
          enqueueSyncApply("transcriptAppend", function () {
            renderTranscript(Array.isArray(m.messages) ? m.messages : []);
          });
          break;
        case "syncSection":
          enqueueSyncApply("syncSection", function () {
            applyRemoteSyncSection(m.section, m.value);
          });
          break;
        case "transcriptMessageBegin":
          beginSyncFragment("transcript", m);
          break;
        case "transcriptMessageChunk":
          appendSyncFragment("transcript", m);
          break;
        case "transcriptMessageCommit":
          enqueueSyncApply("transcriptMessageCommit", function () {
            return commitSyncFragment("transcript", m);
          });
          break;
        case "syncSectionBegin":
          beginSyncFragment("section", m);
          break;
        case "syncSectionChunk":
          appendSyncFragment("section", m);
          break;
        case "syncSectionCommit":
          enqueueSyncApply("syncSectionCommit", function () {
            return commitSyncFragment("section", m);
          });
          break;
        case "commandResultBegin":
          beginSyncFragment("result", m);
          break;
        case "commandResultChunk":
          appendSyncFragment("result", m);
          break;
        case "commandResultCommit":
          enqueueSyncApply("commandResultCommit", function () {
            return commitSyncFragment("result", m);
          });
          break;
        case "remoteCapabilities":
          applyRemoteCapabilities(m);
          break;
        case "diffContent": {
          var diffPath = typeof m.path === "string" ? m.path : t("Open diff (before ↔ current)");
          var beforeText = typeof m.before === "string" ? m.before : "";
          var currentText = typeof m.current === "string" ? m.current : "";
          showRemoteTextResult(
            diffPath,
            t("Before") + "\n\n" + beforeText + "\n\n" + t("Current") + "\n\n" + currentText,
          );
          break;
        }
        case "exportReady":
          if (typeof m.content === "string") {
            post({
              type: "local.share",
              protocolVersion: 1,
              text: m.content,
              mime: "text/markdown",
            });
          }
          break;
        case "diagnosticsResult":
          showRemoteTextResult(t("Run diagnostics"), typeof m.markdown === "string" ? m.markdown : "");
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
            if (f && f.path) addAttachment({
              path: f.path,
              attachmentId: f.attachmentId,
              name: f.name || f.path,
              size: f.size,
            });
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
            var tip = t("Session usage");
            if (tok.reasoning > 0) tip += " · " + t("reasoning {0}", compactNum(tok.reasoning));
            if (tok.cacheRead > 0) tip += " · " + t("cache read {0}", compactNum(tok.cacheRead));
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
            diffBtn.title = t("Open diff (before ↔ current)");
            diffBtn.setAttribute("data-id", String(m.toolCallId));
            var revertBtn = document.createElement("button");
            revertBtn.className = "tool-diff tool-revert";
            revertBtn.type = "button";
            revertBtn.textContent = "revert";
            revertBtn.title = t("Undo this edit (restore the file as it was before)");
            revertBtn.setAttribute("data-id", String(m.toolCallId));
            var toggle = diffHead.querySelector(".tool-toggle");
            diffHead.insertBefore(diffBtn, toggle || null);
            diffHead.insertBefore(revertBtn, toggle || null);
          }
          break;
        }
        case "editRejected": {
          var rejectedCard = byToolCallId.get(String(m.toolCallId));
          var rejectedBtn = rejectedCard && rejectedCard.querySelector(".tool-revert");
          if (rejectedBtn) {
            rejectedBtn.textContent = t("reverted");
            rejectedBtn.disabled = true;
          }
          break;
        }
        case "routedDone":
          // The host restored the session model after a routed turn — the
          // chip was already cleared on send; nothing to render.
          break;
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
  }

  hostPort.subscribe(handleHostMessage);

  /* ------------------------------------------------------------------ */
  /* Boot                                                                */
  /* ------------------------------------------------------------------ */

  // The visual viewport is only worth pinning the layout to while the on-screen
  // keyboard is eating the bottom of the screen. Every other reading it produces
  // is either the layout viewport itself or, on a foldable mid-hinge, a stale
  // fraction of it -- and pinning the app to that fraction squeezed the entire
  // UI into a strip under the header. When the reading is not a believable
  // keyboard inset, drop the property and let CSS use 100dvh.
  var MIN_PLAUSIBLE_VIEWPORT_FRACTION = 0.4;

  function syncAndroidViewport() {
    if (hostPort.kind !== "android") return;
    var root = document.documentElement;
    var layout = window.innerHeight;
    var viewport = window.visualViewport;
    var height = viewport && Number.isFinite(viewport.height) ? viewport.height : layout;
    // Android WebView resolves every viewport-height unit -- vh, dvh, svh, lvh --
    // to zero while its layout height is unconstrained: measured 0px against a
    // real 866px viewport on WebView 150, which collapsed #app to nothing and
    // left the app a blank panel. Publish the layout viewport in pixels so the
    // shell never has to trust those units; dvh stays only as a CSS fallback for
    // hosts that report it honestly.
    if (layout > 0) root.style.setProperty("--app-vh", Math.round(layout) + "px");
    else root.style.removeProperty("--app-vh");
    var believable = height > 0 && layout > 0 &&
      height <= layout &&
      height >= layout * MIN_PLAUSIBLE_VIEWPORT_FRACTION;
    if (believable) root.style.setProperty("--app-viewport-height", Math.round(height) + "px");
    else root.style.removeProperty("--app-viewport-height");
  }

  if (hostPort.kind === "android") {
    syncAndroidViewport();
    window.addEventListener("resize", syncAndroidViewport, { passive: true });
    // A fold or unfold arrives as an orientation change on some devices and as a
    // plain resize on others, and the first frame after it still carries the old
    // metrics. Re-measure once the new layout has settled.
    window.addEventListener("orientationchange", function () {
      syncAndroidViewport();
      setTimeout(syncAndroidViewport, 250);
    }, { passive: true });
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", syncAndroidViewport, { passive: true });
      window.visualViewport.addEventListener("scroll", syncAndroidViewport, { passive: true });
    }
  }
  autogrow();
  if (hostPort.kind !== "android") input.focus();
  post({ t: "ready" });
