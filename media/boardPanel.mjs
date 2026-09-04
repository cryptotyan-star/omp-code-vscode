// Process board editor panel (ompcode.boardPanel) renderer: the full mock
// window from docs/design/process-board.mock.html on live snapshots — tree on
// the left, tabs + crumbs + stage strip + log + composer on the right, status
// bar at the bottom. Data flow mirrors the sidebar board: one
// { t: "board", snapshot } message replaces the whole view; the panel answers
// with { t: "ready" } on load, { t: "reveal"/"stop"/"delete", id } like the
// sidebar, and { t: "prompt", id, text } from the composer. Selection lives
// here: clicking a tree row or a tab selects it without touching the host.
//
// The row markup — and the webview API sender — are imported from board.mjs.
// That module boots on import but returns early when the document has no
// #tree element: this panel's skeleton deliberately prefixes its ids
// (panel-tree, …), so the sidebar renderer stays inert here. It also holds
// the webview's one and only handle on the VS Code API — a second
// acquisition throws at module scope — which is why `post` travels across
// the import rather than being taken again here.

import { post, rowHtml } from "./board.mjs";
import { plural, t } from "./l10n.mjs";

// Pipeline order, left to right: создание → работа → diff → verify → merge.
const STAGES = ["created", "working", "diffed", "verified", "merged"];

// Same glyphs as board.mjs; the tab strip needs them too.
const ICON = {
  running: '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 1-6.4 2.6"/></svg>',
  done: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  error: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/></svg>',
  waiting: '<svg viewBox="0 0 24 24"><path d="M9.5 9.5a2.5 2.5 0 1 1 3.6 2.2c-.8.4-1.1 1-1.1 1.8"/><path d="M12 17h.01"/></svg>',
  idle: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></svg>',
  budget: '<svg viewBox="0 0 24 24"><path d="M12 4v16M15.5 7c0-1.7-1.6-2.6-3.5-2.6S8.5 5.3 8.5 7c0 3.5 7 1.9 7 5.5 0 1.7-1.6 2.6-3.5 2.6S8.5 14.2 8.5 12.5"/></svg>',
};

function esc(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fmtUsd(usd) {
  return `$${(Number(usd) || 0).toFixed(2)}`;
}

/** Limits read "$5", not "$5.00"; cents survive when they exist. */
function fmtLimit(usd) {
  const n = Number(usd) || 0;
  return `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
}

// Literal t() calls: the l10n test scans sources for keys, so no lookup table.
function barLabel(bar) {
  switch (bar) {
    case "running": return t("running");
    case "done": return t("done");
    case "error": return t("error");
    case "waiting": return t("waiting");
    case "budget": return t("budget");
    case "idle": return t("idle");
    default: return t("idle");
  }
}

function stageName(stage) {
  switch (stage) {
    case "created": return t("stage created");
    case "working": return t("stage working");
    case "diffed": return t("stage diffed");
    case "verified": return t("stage verified");
    case "merged": return t("stage merged");
    default: return "—";
  }
}

/** An unknown bar degrades to the quiet idle visuals rather than breaking. */
function safeBar(bar) {
  return Object.prototype.hasOwnProperty.call(ICON, bar) ? bar : "idle";
}

// ---------------------------------------------------------------------------
// Panel state. The snapshot is host-owned; the selection and the composer
// errors are panel-local.
// ---------------------------------------------------------------------------

let snapshot;
let selectedId;
/** Set by the host's board message; undefined until the first one arrives. */
let pushedBase;
/** True between compositionstart and compositionend on the composer input. */
let composing = false;
/** Text a refused prompt hands back, so the user can edit and retry it. */
let returnedDraft;
/** Prompt refusals (over budget, needs_input) shown as .tool.bad log lines. */
const promptErrors = new Map();

function rows() {
  return snapshot && Array.isArray(snapshot.rows) ? snapshot.rows : [];
}

/**
 * The base branch. Every `{ t: "board" }` carries the live value; the
 * `data-base` attribute is only the first paint, from before the host had a
 * workspace to name — the panel is normally opened before any exists.
 */
function baseBranch() {
  if (pushedBase !== undefined) {
    return pushedBase;
  }
  return document.body && typeof document.body.getAttribute === "function"
    ? String(document.body.getAttribute("data-base") || "").trim()
    : "";
}

function rowById(id) {
  return rows().find((row) => row.id === id);
}

/** Keep the selection alive across snapshots; fall back to the first worker. */
function currentSelection() {
  const all = rows();
  if (selectedId && all.some((row) => row.id === selectedId)) {
    return selectedId;
  }
  const first = all.find((row) => row.kind === "workspace") ?? all[0];
  selectedId = first ? first.id : undefined;
  return selectedId;
}

// ---------------------------------------------------------------------------
// Sidebar column — the same tree the sidebar board draws.
// ---------------------------------------------------------------------------

function renderTree() {
  const all = rows();
  const orch = all.find((row) => row.kind === "orchestrator");
  const kids = all.filter((row) => row.kind === "workspace");
  setHtml("panel-orch", orch ? rowHtml(orch, snapshot) : "");
  const counts = (snapshot && snapshot.counts) || {};
  const needs = (counts.error || 0) + (counts.waiting || 0);
  const cntAll = document.getElementById("panel-cnt-all");
  if (cntAll) {
    cntAll.textContent = String(kids.length);
  }
  const cntErr = document.getElementById("panel-cnt-err");
  if (cntErr) {
    cntErr.hidden = needs === 0;
    cntErr.textContent = String(needs);
  }
  setHtml(
    "panel-tree",
    kids.length
      ? kids.map((row) => rowHtml(row, snapshot)).join("")
      : `<div class="empty"><div class="empty-title">${esc(t("No processes yet"))}</div><div class="empty-sub">${esc(t("Workspaces the orchestrator starts will appear here."))}</div></div>`,
  );
}

// ---------------------------------------------------------------------------
// Editor pane — tabs, crumbs, stages, log, callout, composer.
// ---------------------------------------------------------------------------

function tabsHtml(selected) {
  return rows()
    .map((row) => {
      const bar = safeBar(row.bar);
      const on = selected && row.id === selected.id ? " on" : "";
      const progress = Math.max(0, Math.min(100, Math.round(Number(row.progress) || 0)));
      const close =
        row.kind === "workspace"
          ? `<span class="x" data-del="${esc(row.id)}" title="${esc(t("Delete"))}" aria-label="${esc(t("Delete"))}"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg></span>`
          : "";
      return `<button class="tab${on} is-${bar}" data-tab="${esc(row.id)}" data-p="${progress}" type="button">
        <span class="stripe"><i></i></span>
        <span class="tico">${ICON[bar]}</span><span>${esc(row.name)}</span>
        ${close}
      </button>`;
    })
    .join("");
}

function crumbsHtml(row) {
  const base = baseBranch();
  const parts = [];
  if (base) {
    parts.push(`<span>⎇ ${esc(base)}</span>`);
  }
  parts.push(
    row.kind === "orchestrator"
      ? `<span>${esc(t("orchestrator"))}</span>`
      : `<span>${esc(row.branch || `ws/${row.name}`)}</span>`,
  );
  if (row.model) {
    parts.push(`<span class="mono">${esc(row.model)}</span>`);
  }
  parts.push(`<span class="state">${esc(barLabel(safeBar(row.bar)))}</span>`);
  return parts.join('<span class="sep">›</span>');
}

/** The five-stage strip; a workspace only — the orchestrator has no pipeline. */
function stagesHtml(row) {
  if (row.kind !== "workspace") {
    return "";
  }
  let idx = row.stage ? STAGES.indexOf(row.stage) : -1;
  if (idx < 0 && row.bar === "done") {
    idx = STAGES.length - 1;
  }
  const spans = STAGES.map((stage, i) => {
    const bad = (row.bar === "error" || row.bar === "budget") && i === idx && idx >= 0;
    const cls = bad ? "bad" : i < idx ? "hit" : i === idx ? "hit now" : "";
    return `<span class="${cls}">${esc(stageName(stage))}</span>`;
  }).join("");
  return `<div class="stages">${spans}</div>`;
}

/** The log carries only what the host reported: last word, last failure. */
function logHtml(row) {
  const out = [];
  if (row.lastText) {
    const who = row.kind === "orchestrator" ? t("orchestrator") : t("agent");
    out.push(`<div class="msg"><span class="k">${esc(who)}</span><div><p>${esc(row.lastText)}</p></div></div>`);
  }
  if (row.lastError) {
    out.push(
      `<div class="msg"><span class="k">${esc(t("tool"))}</span><div class="tool bad">${esc(row.lastError)}</div></div>`,
    );
  }
  const refused = promptErrors.get(row.id);
  if (refused) {
    out.push(
      `<div class="msg"><span class="k">${esc(t("tool"))}</span><div class="tool bad">${esc(refused)}</div></div>`,
    );
  }
  if (row.bar === "running") {
    out.push(
      `<div class="msg"><span class="k"></span><span class="shiny">${esc(t("Thinking · {0}…", stageName(row.stage)))}</span></div>`,
    );
  }
  return out.join("");
}

/** The thing that needs a human; every button reveals the row's real chat. */
function calloutHtml(row) {
  if (!row.needsHuman) {
    return "";
  }
  if (row.bar === "waiting") {
    return `<div class="callout beam"><p>${esc(t("The agent stopped and is waiting for your answer — the workspace is on hold until you reply."))}</p><button class="vbtn primary" type="button" data-callout="${esc(row.id)}">${esc(t("Answer"))}</button></div>`;
  }
  if (row.bar === "budget") {
    return `<div class="callout beam err"><p>${esc(t("This workspace spent its per-workspace cost limit. Raise {0} to let it continue.", "ompcode.costLimitPerWorkspaceUsd"))}</p><button class="vbtn" type="button" data-callout="${esc(row.id)}">${esc(t("Show chat"))}</button></div>`;
  }
  return `<div class="callout beam err"><p>${esc(t("The run failed. Open this workspace's chat to see what happened and retry from there."))}</p><button class="vbtn" type="button" data-callout="${esc(row.id)}">${esc(t("Show chat"))}</button></div>`;
}

/** Composer only for workspace rows — the orchestrator answers in the sidebar chat. */
function composerHtml(row) {
  if (row.kind !== "workspace") {
    return "";
  }
  const model = row.model.includes("/") ? row.model.split("/")[1] : row.model;
  return `<div class="composer">
    <input class="in" data-row="${esc(row.id)}" type="text" placeholder="${esc(t("Message the agent…"))}" aria-label="${esc(t("Message the agent…"))}">
    <div class="bar">
      <span class="chip">${esc(model)}</span>
      <button class="send" type="button" data-send="${esc(row.id)}" title="${esc(t("Send"))}" aria-label="${esc(t("Send"))}"><svg viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7"/></svg></button>
    </div>
  </div>`;
}

function renderEditor() {
  const editor = document.getElementById("panel-editor");
  if (!editor) {
    return;
  }
  // The poll repaints on a timer; a half-typed prompt must survive it. An
  // in-flight IME composition cannot: re-templating the <input> under it drops
  // the composed text, so the pane holds still until the composition ends.
  if (composing) {
    return;
  }
  const live =
    typeof document.querySelector === "function"
      ? document.querySelector(".composer .in")
      : null;
  const draft = live && typeof live.value === "string" ? live.value : "";
  // Assigning .value drops the caret to the end; these put it back where the
  // typist left it, so a fix mid-word is not yanked away every two seconds.
  const caretStart =
    live && typeof live.selectionStart === "number" ? live.selectionStart : undefined;
  const caretEnd = live && typeof live.selectionEnd === "number" ? live.selectionEnd : undefined;
  const draftRow = live && live.dataset ? live.dataset.row : undefined;
  const focused =
    live !== null &&
    typeof document.activeElement !== "undefined" &&
    document.activeElement === live;
  const id = currentSelection();
  const row = id ? rowById(id) : undefined;
  if (!row) {
    editor.className = "editor";
    editor.innerHTML = `<div class="log"><div class="empty"><div class="empty-title">${esc(t("No processes yet"))}</div><div class="empty-sub">${esc(t("Workspaces the orchestrator starts will appear here."))}</div></div></div>`;
    return;
  }
  editor.className = `editor is-${safeBar(row.bar)}`;
  editor.innerHTML = `
    <div class="tabs">${tabsHtml(row)}</div>
    <div class="crumbs">${crumbsHtml(row)}</div>
    ${stagesHtml(row)}
    <div class="log">${logHtml(row)}${calloutHtml(row)}</div>
    ${composerHtml(row)}`;
  // A refusal comes back carrying the text it refused: the composer had
  // already cleared optimistically, and losing the prompt to a budget message
  // left the user nothing to retry from.
  const handback = returnedDraft && returnedDraft.id === row.id ? returnedDraft.text : undefined;
  returnedDraft = undefined;
  const mine = draftRow === row.id;
  if ((handback !== undefined || ((draft || focused) && mine)) && row.kind === "workspace") {
    const input = document.querySelector(`.composer .in[data-row="${row.id}"]`);
    if (input) {
      if (handback !== undefined) {
        input.value = handback;
      } else if (draft) {
        input.value = draft;
      }
      if (handback !== undefined || focused) {
        if (typeof input.focus === "function") {
          input.focus();
        }
        if (
          handback === undefined &&
          caretStart !== undefined &&
          typeof input.setSelectionRange === "function"
        ) {
          input.setSelectionRange(caretStart, caretEnd ?? caretStart);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Status strip — base branch, live counts with the mock's pluralization,
// session cost.
// ---------------------------------------------------------------------------

function statusHtml() {
  const counts = (snapshot && snapshot.counts) || {};
  const run = counts.running || 0;
  const done = counts.done || 0;
  const waiting = counts.waiting || 0;
  const err = counts.error || 0;
  const base = baseBranch();
  const total = fmtUsd(snapshot ? snapshot.totalCostUsd : 0);
  const cost =
    snapshot && snapshot.sessionLimitUsd !== undefined
      ? t("Total {0} (limit {1})", total, fmtLimit(snapshot.sessionLimitUsd))
      : t("Total {0}", total);
  return `
    ${base ? `<span class="it">⎇ ${esc(base)}</span>` : ""}
    <span class="it run"><span class="d"></span>${esc(plural(run, t("{0} task running", run), t("{0} tasks running", run), t("{0} tasks running", run)))}</span>
    <span class="it ok"><span class="d"></span>${esc(plural(done, t("{0} task done", done), t("{0} tasks done", done), t("{0} tasks done", done)))}</span>
    ${waiting ? `<span class="it wait"><span class="d"></span>${esc(plural(waiting, t("{0} task waiting", waiting), t("{0} tasks waiting", waiting), t("{0} tasks waiting", waiting)))}</span>` : ""}
    ${err ? `<span class="it err"><span class="d"></span>${esc(plural(err, t("{0} error", err), t("{0} errors", err), t("{0} errors (many)", err)))}</span>` : ""}
    <span class="grow"></span>
    <span class="it tnum${snapshot && snapshot.overSessionBudget ? " over" : ""}">${esc(cost)}</span>`;
}

// ---------------------------------------------------------------------------
// Render + events
// ---------------------------------------------------------------------------

function setHtml(id, html) {
  const el = document.getElementById(id);
  if (el) {
    el.innerHTML = html;
  }
}

/** CSP forbids style attributes, so --p/--indent travel as data-* and land via CSSOM. */
function applyVars() {
  if (typeof document.querySelectorAll !== "function") {
    return;
  }
  for (const el of document.querySelectorAll(".row, .tab")) {
    if (el.dataset && el.dataset.p !== undefined) {
      el.style.setProperty("--p", `${el.dataset.p}%`);
    }
    if (el.dataset && el.dataset.ind) {
      el.style.setProperty("--indent", `${el.dataset.ind}px`);
    }
  }
}

function render() {
  renderTree();
  renderEditor();
  setHtml("panel-status", statusHtml());
  applyVars();
}

function closest(event, selector) {
  const target = event.target;
  if (!target || typeof target.closest !== "function") {
    return null;
  }
  return target.closest(selector);
}

/** Send the composer's text, if any, to the row it addresses. */
/** The last prompt sent per row, held only until the host accepts or refuses. */
const lastSent = new Map();

function sendPrompt(id) {
  const input =
    typeof document.querySelector === "function"
      ? document.querySelector(`.composer .in[data-row="${id}"]`)
      : null;
  const text = input && typeof input.value === "string" ? input.value.trim() : "";
  if (!text) {
    return;
  }
  input.value = "";
  lastSent.set(id, text);
  post({ t: "prompt", id, text });
}

function onClick(event) {
  const del = closest(event, "[data-del]");
  if (del && del.dataset) {
    event.preventDefault();
    event.stopPropagation();
    post({ t: "delete", id: del.dataset.del });
    return;
  }
  const send = closest(event, "[data-send]");
  if (send && send.dataset) {
    event.preventDefault();
    sendPrompt(send.dataset.send);
    return;
  }
  const callout = closest(event, "[data-callout]");
  if (callout && callout.dataset) {
    post({ t: "reveal", id: callout.dataset.callout });
    return;
  }
  const tab = closest(event, "[data-tab]");
  if (tab && tab.dataset) {
    selectedId = tab.dataset.tab;
    render();
    return;
  }
  const row = closest(event, ".row");
  if (!row || !row.dataset || !row.dataset.id) {
    return;
  }
  const act = closest(event, "[data-act]");
  const action = act && act.dataset ? act.dataset.act : "";
  if (action === "stop" || action === "delete") {
    event.preventDefault();
    event.stopPropagation();
    post({ t: action, id: row.dataset.id });
    return;
  }
  selectedId = row.dataset.id;
  render();
}

function onKeydown(event) {
  const input = closest(event, ".composer .in");
  if (input) {
    if (event.key === "Enter" && input.dataset && input.dataset.row) {
      event.preventDefault();
      sendPrompt(input.dataset.row);
    }
    return;
  }
  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }
  const row = closest(event, ".row");
  if (!row || !row.dataset || !row.dataset.id || closest(event, "[data-act]")) {
    return; // a focused hover action handles its own keys
  }
  event.preventDefault();
  post({ t: "reveal", id: row.dataset.id });
}

/** VS Code flips body.vscode-dark live; <html data-theme> follows it. */
function syncTheme() {
  const body = document.body;
  if (!body || !body.classList) {
    return;
  }
  const dark = body.classList.contains("vscode-dark") || body.classList.contains("vscode-high-contrast");
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

/** Custom accent from the host, validated before it touches the CSSOM. */
function applyAccent() {
  const accent = document.body && typeof document.body.getAttribute === "function"
    ? String(document.body.getAttribute("data-accent") || "").trim()
    : "";
  if (!accent || !window.CSS || !CSS.supports || !CSS.supports("color", accent)) {
    return;
  }
  const root = document.documentElement;
  root.style.setProperty("--omp-accent", accent);
  root.style.setProperty("--omp-run", accent);
  root.style.setProperty("--omp-glow", `color-mix(in srgb, ${accent} 35%, transparent)`);
}

function boot() {
  if (typeof document === "undefined" || typeof document.getElementById !== "function") {
    return;
  }
  if (!document.getElementById("panel-tree")) {
    return;
  }
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg) {
      return;
    }
    try {
      if (msg.t === "board" && msg.snapshot) {
        snapshot = msg.snapshot;
        // Absent means "the host has no branch to name", which is a value —
        // it clears a branch the last push had.
        pushedBase = String(msg.baseBranch || "").trim();
        // A row that is running again took the prompt; its refusal is stale,
        // and so is the copy held back for a retry.
        for (const row of rows()) {
          if (row.bar === "running") {
            promptErrors.delete(row.id);
            lastSent.delete(row.id);
          }
        }
        render();
      } else if (msg.t === "promptError" && typeof msg.id === "string") {
        promptErrors.set(msg.id, String(msg.message || ""));
        const refused = lastSent.get(msg.id);
        lastSent.delete(msg.id);
        if (refused) {
          returnedDraft = { id: msg.id, text: refused };
        }
        render();
      }
    } catch (err) {
      // A bad message must not take the panel down; the next push repaints.
      console.error("[board-panel] render failed", err);
    }
  });
  document.addEventListener("click", onClick);
  document.addEventListener("keydown", onKeydown);
  // The repaint holds off while an IME is composing; the next snapshot, at
  // most one poll away, draws the pane again.
  document.addEventListener("compositionstart", () => {
    composing = true;
  });
  document.addEventListener("compositionend", () => {
    composing = false;
  });
  syncTheme();
  applyAccent();
  if (typeof MutationObserver === "function" && document.body) {
    new MutationObserver(syncTheme).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  }
  post({ t: "ready" });
}

boot();
