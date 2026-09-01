// Process board renderer. The host owns the data: one { t: "board", snapshot }
// message replaces the whole view, and the board only ever answers with
// { t: "ready" } on load, { t: "reveal", id } on a row click and
// { t: "stop", id } / { t: "delete", id } from the per-row hover actions.
// Layout and state visuals follow docs/design/process-board.mock.html.

import { t } from "./l10n.mjs";

// Pipeline order, left to right, of the five ticks on a workspace row:
// создание → работа → diff → verify → merge.
const STAGES = ["created", "working", "diffed", "verified", "merged"];

const ICON = {
  running: '<svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 1-6.4 2.6"/></svg>',
  done: '<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  error: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/></svg>',
  waiting: '<svg viewBox="0 0 24 24"><path d="M9.5 9.5a2.5 2.5 0 1 1 3.6 2.2c-.8.4-1.1 1-1.1 1.8"/><path d="M12 17h.01"/></svg>',
  idle: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/></svg>',
  budget: '<svg viewBox="0 0 24 24"><path d="M12 4v16M15.5 7c0-1.7-1.6-2.6-3.5-2.6S8.5 5.3 8.5 7c0 3.5 7 1.9 7 5.5 0 1.7-1.6 2.6-3.5 2.6S8.5 14.2 8.5 12.5"/></svg>',
};

const vscodeApi = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : undefined;

function post(msg) {
  if (vscodeApi) {
    vscodeApi.postMessage(msg);
  }
}

function esc(text) {
  return String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The mock's clock: minutes and seconds. */
function fmtTime(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `${Math.floor(s / 60)}м ${String(s % 60).padStart(2, "0")}с`;
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
    default: return t("idle"); // an unknown bar degrades to a quiet label
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

function subText(row, snap) {
  if (row.kind === "orchestrator") {
    const total = snap && Array.isArray(snap.rows)
      ? snap.rows.filter((r) => r.kind === "workspace").length
      : 0;
    const done = snap && snap.counts ? snap.counts.done || 0 : 0;
    return t("{0} of {1} merged", done, total);
  }
  switch (row.bar) {
    case "done": return t("merged into base");
    case "error": return t("failed at {0}", stageName(row.stage));
    case "waiting": return t("question for the human");
    case "running": return t("stage: {0}", stageName(row.stage));
    case "budget": return t("over the cost limit");
    default: return row.branch ? `⎇ ${row.branch}` : row.lastText || row.model || "";
  }
}

/** Five tick spans, one per pipeline stage; the error row marks where it fell. */
function ticksHtml(row) {
  if (row.kind !== "workspace") {
    return "";
  }
  let idx = row.stage ? STAGES.indexOf(row.stage) : -1;
  if (idx < 0 && row.bar === "done") {
    idx = STAGES.length - 1;
  }
  const spans = STAGES.map((_, i) => {
    const cls = row.bar === "error" && i === idx && idx >= 0 ? "bad" : i <= idx ? "hit" : "";
    return `<span class="${cls}"></span>`;
  }).join("");
  return `<span class="ticks">${spans}</span>`;
}

/** Every row carries its cost; a limited row shows "$0.31 / $5". */
function costHtml(row) {
  const text = row.costLimitUsd !== undefined
    ? `${fmtUsd(row.costUsd)} / ${fmtLimit(row.costLimitUsd)}`
    : fmtUsd(row.costUsd);
  return `<span class="cost tnum${row.overBudget ? " over" : ""}">${esc(text)}</span>`;
}

/** Hover actions: stop only while there is something live to stop. */
function actsHtml(row) {
  if (row.kind !== "workspace") {
    return "";
  }
  const stop = row.bar === "running" || row.bar === "waiting"
    ? `<button type="button" class="act" data-act="stop" title="${esc(t("Stop"))}" aria-label="${esc(t("Stop"))}">■</button>`
    : "";
  return `<span class="acts">${stop}<button type="button" class="act" data-act="delete" title="${esc(t("Delete"))}" aria-label="${esc(t("Delete"))}">✕</button></span>`;
}

export function rowHtml(row, snap) {
  // An unknown bar degrades to a quiet row rather than breaking the board.
  const bar = Object.prototype.hasOwnProperty.call(ICON, row.bar) ? row.bar : "idle";
  const label = barLabel(bar);
  const child = row.kind === "workspace";
  // parentId rows nest one step deeper than a plain workspace row.
  const indent = child ? (row.parentId ? 46 : 30) : 12;
  const progress = Math.max(0, Math.min(100, Math.round(Number(row.progress) || 0)));
  const who = row.kind === "orchestrator" ? ` <span class="who">· ${esc(t("orchestrator"))}</span>` : "";
  const time = row.elapsedSec !== undefined ? fmtTime(row.elapsedSec) : "";
  const title = row.lastError || row.lastText || "";
  return `<div class="row${child ? " child" : ""} is-${bar}${row.needsHuman ? " needs-human" : ""}" data-id="${esc(row.id)}" data-p="${progress}" data-ind="${indent}" role="option" tabindex="0"${title ? ` title="${esc(title)}"` : ""} aria-label="${esc(`${row.name}, ${label}`)}">
  <span class="stripe"><i></i></span>
  <span class="ico">${ICON[bar]}</span>
  <span class="name">${esc(row.name)}${who}</span>
  <span class="sub" title="${esc(row.model)}"><b>${esc(label)}</b>·<span>${esc(subText(row, snap))}</span>·${costHtml(row)}</span>
  <span class="time tnum mono">${esc(time)}</span>
  ${ticksHtml(row)}
  ${actsHtml(row)}
</div>`;
}

function emptyHtml() {
  return `<div class="empty"><div class="empty-title">${esc(t("No processes yet"))}</div><div class="empty-sub">${esc(t("Workspaces the orchestrator starts will appear here."))}</div></div>`;
}

/** Footer: `Итого $X.XX (лимит $Y)`, or without the limit when none is set. */
function footerHtml(snap) {
  const total = fmtUsd(snap.totalCostUsd);
  const text = snap.sessionLimitUsd !== undefined
    ? t("Total {0} (limit {1})", total, fmtLimit(snap.sessionLimitUsd))
    : t("Total {0}", total);
  return `<span class="total tnum${snap.overSessionBudget ? " over" : ""}">${esc(text)}</span>`;
}

/** CSP forbids style attributes, so --p/--indent travel as data-* and land via CSSOM. */
function applyRowVars() {
  if (typeof document.querySelectorAll !== "function") {
    return;
  }
  for (const el of document.querySelectorAll(".row")) {
    if (el.dataset && el.dataset.p !== undefined) {
      el.style.setProperty("--p", `${el.dataset.p}%`);
    }
    if (el.dataset && el.dataset.ind) {
      el.style.setProperty("--indent", `${el.dataset.ind}px`);
    }
  }
}

function setHtml(id, html) {
  const el = document.getElementById(id);
  if (el) {
    el.innerHTML = html;
  }
}

export function render(snap) {
  const rows = snap && Array.isArray(snap.rows) ? snap.rows : [];
  const orch = rows.find((r) => r.kind === "orchestrator");
  const kids = rows.filter((r) => r.kind === "workspace");
  setHtml("orch", orch ? rowHtml(orch, snap) : "");
  const counts = snap.counts || {};
  // The mock's #cnt-err counts everything that needs eyes: errors + waiting.
  const needs = (counts.error || 0) + (counts.waiting || 0);
  const cntAll = document.getElementById("cnt-all");
  if (cntAll) {
    cntAll.textContent = String(kids.length);
  }
  const cntErr = document.getElementById("cnt-err");
  if (cntErr) {
    cntErr.hidden = needs === 0;
    cntErr.textContent = String(needs);
  }
  setHtml("tree", kids.length ? kids.map((row) => rowHtml(row, snap)).join("") : emptyHtml());
  setHtml("foot", footerHtml(snap));
  applyRowVars();
}

function rowOf(event) {
  const target = event.target;
  if (!target || typeof target.closest !== "function") {
    return null;
  }
  const row = target.closest(".row");
  return row && row.dataset && row.dataset.id ? row : null;
}

function onClick(event) {
  const row = rowOf(event);
  if (!row) {
    return;
  }
  const actEl = event.target.closest("[data-act]");
  const act = actEl && actEl.dataset ? actEl.dataset.act : "";
  if (act === "stop" || act === "delete") {
    event.preventDefault();
    event.stopPropagation();
    post({ t: act, id: row.dataset.id });
    return;
  }
  post({ t: "reveal", id: row.dataset.id });
}

function onKeydown(event) {
  if (event.key !== "Enter" && event.key !== " ") {
    return;
  }
  const row = rowOf(event);
  if (!row || event.target.closest("[data-act]")) {
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
  if (!document.getElementById("tree")) {
    return;
  }
  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || msg.t !== "board" || !msg.snapshot) {
      return;
    }
    try {
      render(msg.snapshot);
    } catch (err) {
      // A bad snapshot must not take the board down; the next push repaints.
      console.error("[board] render failed", err);
    }
  });
  document.addEventListener("click", onClick);
  document.addEventListener("keydown", onKeydown);
  syncTheme();
  applyAccent();
  if (typeof MutationObserver === "function" && document.body) {
    new MutationObserver(syncTheme).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  }
  post({ t: "ready" });
}

boot();
