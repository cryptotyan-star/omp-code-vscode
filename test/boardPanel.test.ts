import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * boardPanel.mjs is the whole renderer of the ompcode.boardPanel webview; like
 * board.mjs in boardView.test.ts, it is booted here against a stub DOM that
 * captures posted messages and lets tests dispatch the host's
 * `{ t: "board", snapshot }` pushes. One difference: getElementById does NOT
 * create elements on demand — board.mjs is imported for its rowHtml and its
 * boot must stay inert, which it does only while the document has no #tree.
 */

const root = path.join(import.meta.dirname, "..");
const panelSrc = fs.readFileSync(path.join(root, "media", "boardPanel.mjs"), "utf8");
const panelHostSrc = fs.readFileSync(path.join(root, "src", "boardPanel.ts"), "utf8");
const boardCss = fs.readFileSync(path.join(root, "media", "board.css"), "utf8");
const typesSrc = fs.readFileSync(path.join(root, "src", "boardTypes.ts"), "utf8");
const extensionSrc = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
const ruBundle = JSON.parse(fs.readFileSync(path.join(root, "l10n", "ru.json"), "utf8")) as Record<
  string,
  string
>;

// ---------------------------------------------------------------------------
// Stub DOM. Panel elements are pre-created below; unknown ids come back
// undefined — the sidebar renderer's boot guard depends on that.
// ---------------------------------------------------------------------------

interface StubElement {
  id: string;
  innerHTML: string;
  textContent: string;
  hidden: boolean;
  className: string;
  dataset: Record<string, string>;
  style: { setProperty(key: string, value: string): void; removeProperty(key: string): void };
  classList: { contains(name: string): boolean };
  addEventListener(): void;
}

interface StubEvent {
  key?: string;
  target: { closest(selector: string): { dataset: Record<string, string> } | null } | null;
  preventDefault(): void;
  stopPropagation(): void;
}

type StubHandler = (event: StubEvent) => void;

const docListeners: Record<string, StubHandler[]> = {};
const elements: Record<string, StubElement> = {};

function el(id: string): StubElement {
  let found = elements[id];
  if (!found) {
    found = {
      id,
      innerHTML: "",
      textContent: "",
      hidden: false,
      className: "",
      dataset: {},
      style: { setProperty() {}, removeProperty() {} },
      classList: { contains: () => false },
      addEventListener() {},
    };
    elements[id] = found;
  }
  return found;
}

// The skeleton's own ids exist; anything else — "tree" in particular — does not.
for (const id of [
  "panel-orch",
  "panel-cnt-all",
  "panel-cnt-err",
  "panel-tree",
  "panel-editor",
  "panel-status",
]) {
  el(id);
}

/** The composer input the host would find; tests set its value per case. */
const composerInput = { value: "" };
let baseBranch = "steer-in-chat";

const posted: unknown[] = [];

Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: {
    getElementById: (id: string) => elements[id],
    addEventListener: (type: string, fn: StubHandler) => {
      docListeners[type] = [...(docListeners[type] ?? []), fn];
    },
    querySelector: (selector: string) =>
      selector.startsWith(".composer .in") ? composerInput : null,
    querySelectorAll: () => [],
    documentElement: {
      lang: "en",
      dataset: {},
      style: { setProperty() {}, removeProperty() {} },
    },
    body: {
      classList: { contains: () => false },
      getAttribute: (name: string) => (name === "data-base" ? baseBranch : null),
    },
  },
});
const windowTarget = new EventTarget();
Object.defineProperty(globalThis, "window", { configurable: true, value: windowTarget });
Object.defineProperty(globalThis, "acquireVsCodeApi", {
  configurable: true,
  value: () => ({ postMessage: (msg: unknown) => posted.push(msg) }),
});

// Dynamic on purpose: the module boots on import, so the stub DOM above must
// exist first — a static import would evaluate boardPanel.mjs before any of it.
await import("../media/boardPanel.mjs");

function pushSnapshot(snapshot: unknown): void {
  windowTarget.dispatchEvent(new MessageEvent("message", { data: { t: "board", snapshot } }));
}

function pushMessage(msg: unknown): void {
  windowTarget.dispatchEvent(new MessageEvent("message", { data: msg }));
}

function fire(type: string, event: StubEvent): void {
  for (const fn of docListeners[type] ?? []) {
    fn(event);
  }
}

/** A click/keydown target answering `closest` for exactly the given selectors. */
function target(match: Record<string, { dataset: Record<string, string> }>): StubEvent["target"] {
  return { closest: (selector: string) => match[selector] ?? null };
}

function click(match: Record<string, { dataset: Record<string, string> }>): StubEvent {
  return { target: target(match), preventDefault() {}, stopPropagation() {} };
}

const FULL_SNAPSHOT = {
  rows: [
    {
      id: "orch",
      kind: "orchestrator",
      name: "Fable",
      model: "anthropic/claude-fable-5",
      bar: "running",
      stage: "working",
      progress: 25,
      costUsd: 26.4,
      overBudget: false,
      elapsedSec: 1472,
      lastText: "Жду батчем",
      needsHuman: false,
    },
    {
      id: "ws-1",
      kind: "workspace",
      parentId: "orch",
      name: "glm-orchestrator-audit",
      model: "zhipu-coding-plan/glm-5.2",
      branch: "ws/glm-orchestrator-audit",
      bar: "running",
      stage: "verified",
      progress: 83,
      costUsd: 0.31,
      costLimitUsd: 5,
      overBudget: false,
      elapsedSec: 1101,
      lastText: "иду в verify",
      needsHuman: false,
    },
    {
      id: "ws-2",
      kind: "workspace",
      name: "qwen-<script>race",
      model: "dashscope/qwen3.8-max",
      branch: "ws/qwen",
      bar: "error",
      stage: "working",
      progress: 100,
      costUsd: 0.02,
      overBudget: false,
      elapsedSec: 312,
      lastError: "400 Access denied",
      needsHuman: true,
    },
    {
      id: "ws-3",
      kind: "workspace",
      name: "kimi-chattab-restore",
      model: "dashscope/kimi-k2.7-code",
      branch: "ws/kimi",
      bar: "done",
      stage: "merged",
      progress: 100,
      costUsd: 0.44,
      overBudget: false,
      elapsedSec: 1388,
      needsHuman: false,
    },
    {
      id: "ws-4",
      kind: "workspace",
      name: "glm-review-subagents",
      model: "zhipu-coding-plan/glm-5.2",
      branch: "ws/glm-review",
      bar: "waiting",
      stage: "working",
      progress: 100,
      costUsd: 0.11,
      overBudget: false,
      elapsedSec: 940,
      lastText: "Чинить ли remoteControlService?",
      needsHuman: true,
    },
    {
      id: "ws-5",
      kind: "workspace",
      name: "quiet-worker",
      model: "openai/gpt-5.3",
      branch: "ws/quiet",
      bar: "idle",
      progress: 0,
      costUsd: 1.5,
      overBudget: false,
      needsHuman: false,
    },
    {
      id: "ws-6",
      kind: "workspace",
      name: "spendy",
      model: "openai/gpt-5.3",
      branch: "ws/spendy",
      bar: "budget",
      stage: "diffed",
      progress: 100,
      costUsd: 5.12,
      costLimitUsd: 5,
      overBudget: true,
      elapsedSec: 61,
      lastText: "stopped at the limit",
      needsHuman: true,
    },
  ],
  totalCostUsd: 33.9,
  sessionLimitUsd: 40,
  overSessionBudget: false,
  counts: { running: 2, done: 1, error: 1, waiting: 1 },
};

const EMPTY_SNAPSHOT = {
  rows: [],
  totalCostUsd: 0,
  overSessionBudget: false,
  counts: { running: 0, done: 0, error: 0, waiting: 0 },
};

test("the panel boots, posts ready once, and renders a full snapshot", () => {
  assert.deepEqual(posted, [{ t: "ready" }], "exactly one ready — board.mjs stayed inert");

  pushSnapshot(FULL_SNAPSHOT);

  const orch = el("panel-orch").innerHTML;
  assert.match(orch, /row is-running/, "the orchestrator row runs");
  assert.ok(orch.includes("Fable"), "the orchestrator name renders");

  const tree = el("panel-tree").innerHTML;
  for (const bar of ["running", "done", "error", "waiting", "idle", "budget"]) {
    assert.ok(tree.includes(`is-${bar}`), `the tree renders the ${bar} state`);
  }
  assert.equal(
    (tree.match(/class="row child /g) ?? []).length,
    6,
    "every workspace row is an indented child",
  );
  assert.equal(el("panel-cnt-all").textContent, "6", "the count badge counts workspace rows");
  assert.equal(el("panel-cnt-err").textContent, "2", "the err badge counts error + waiting");

  const editor = el("panel-editor").innerHTML;
  // Default selection is the first workspace row.
  assert.ok(editor.includes('data-tab="ws-1"'), "a tab per row");
  assert.equal((editor.match(/class="tab[ "]/g) ?? []).length, 7, "one tab per row, orchestrator included");
  assert.match(editor, /class="tab on is-running" data-tab="ws-1"/, "the selected tab is on");
  assert.equal((editor.match(/<span class="stripe"><\/span>|<span class="stripe">/g) ?? []).length, 7, "every tab has a stripe");
  assert.ok(editor.includes('class="x" data-del="ws-1"'), "workspace tabs carry a close button");
  assert.ok(!editor.includes('data-del="orch"'), "the orchestrator tab has no close button");

  // Crumbs: base › branch › model › state.
  assert.ok(editor.includes("⎇ steer-in-chat"), "the base branch crumb");
  assert.ok(editor.includes("ws/glm-orchestrator-audit"), "the workspace branch crumb");
  assert.ok(editor.includes('<span class="mono">zhipu-coding-plan/glm-5.2</span>'), "the model crumb");

  // The five-stage strip from the row's stage: verified = hit hit hit now plain.
  const stages = editor.match(/<div class="stages">[\s\S]*?<\/div>/)?.[0] ?? "";
  assert.equal((stages.match(/<span class="/g) ?? []).length, 5, "five stage spans");
  assert.ok(stages.includes('<span class="hit now">'), "the current stage is now");
  assert.ok(!stages.includes("bad"), "a running row has no bad stage");

  // The log is built from real row data only.
  assert.ok(editor.includes("иду в verify"), "lastText is the latest log entry");
  assert.ok(editor.includes("shiny"), "a running row thinks");
  assert.ok(!editor.includes("callout"), "nothing needs a human here");

  // The composer addresses the selected workspace.
  assert.ok(editor.includes('class="in" data-row="ws-1"'), "the composer input addresses the row");
  assert.ok(editor.includes('<span class="chip">glm-5.2</span>'), "the model chip");
  assert.ok(editor.includes('data-send="ws-1"'), "the send button");

  // The status strip: base, counts with the mock's pluralization, totals.
  const status = el("panel-status").innerHTML;
  assert.ok(status.includes("⎇ steer-in-chat"), "the base branch item");
  assert.ok(status.includes("2 tasks running"), "running count, English plural");
  assert.ok(status.includes("1 task done"), "done count, English singular");
  assert.ok(status.includes("1 task waiting"), "waiting count");
  assert.ok(status.includes("1 error"), "error count");
  assert.ok(status.includes("Total $33.90 (limit $40)"), "session cost with the limit");
  assert.match(status, /class="it run"/, "the running item pulses");
  assert.match(status, /class="it err"/, "the error item is painted");
});

test("tabs and rows select; the editor follows the selection", () => {
  pushSnapshot(FULL_SNAPSHOT);
  posted.length = 0;

  fire("click", click({ "[data-tab]": { dataset: { tab: "ws-2" } } }));
  assert.deepEqual(posted, [], "selecting a tab posts nothing");
  let editor = el("panel-editor").innerHTML;
  assert.match(editor, /class="tab on is-error" data-tab="ws-2"/, "the error tab is on");
  assert.ok(editor.includes('class="tool bad"'), "lastError renders as a bad tool block");
  assert.ok(editor.includes("400 Access denied"), "the error text itself");
  assert.ok(editor.includes("callout beam err"), "an error row gets the error callout");
  assert.ok(editor.includes('data-callout="ws-2"'), "the Show chat button targets the row");
  const stages = editor.match(/<div class="stages">[\s\S]*?<\/div>/)?.[0] ?? "";
  assert.ok(stages.includes('<span class="bad">'), "the error row marks the stage it fell on");

  fire("click", click({ ".row": { dataset: { id: "ws-4" } } }));
  editor = el("panel-editor").innerHTML;
  assert.match(editor, /class="tab on is-waiting" data-tab="ws-4"/, "a tree row selects too");
  assert.ok(editor.includes("callout beam"), "a waiting row gets the callout");
  assert.ok(!editor.includes("callout beam err"), "the waiting callout is accent, not error");
  assert.ok(editor.includes("Answer"), "the waiting callout offers Answer");

  fire("click", click({ "[data-tab]": { dataset: { tab: "ws-6" } } }));
  editor = el("panel-editor").innerHTML;
  assert.ok(
    editor.includes("ompcode.costLimitPerWorkspaceUsd"),
    "the budget callout names the setting",
  );

  fire("click", click({ ".row": { dataset: { id: "orch" } } }));
  editor = el("panel-editor").innerHTML;
  assert.ok(!editor.includes('class="composer"'), "the orchestrator row has no composer");
  assert.ok(!editor.includes('class="stages"'), "the orchestrator row has no stage strip");
  assert.ok(editor.includes("orchestrator"), "the orchestrator crumb");
  assert.ok(editor.includes("Жду батчем"), "the orchestrator's lastText");
});

test("an empty snapshot renders calm empty states instead of throwing", () => {
  pushSnapshot(EMPTY_SNAPSHOT);
  assert.equal(el("panel-orch").innerHTML, "", "no orchestrator, no row");
  assert.ok(el("panel-tree").innerHTML.includes("No processes yet"), "tree empty state");
  const editor = el("panel-editor").innerHTML;
  assert.ok(editor.includes("No processes yet"), "editor empty state");
  assert.ok(!editor.includes('class="tabs"'), "no tabs without rows");
  assert.ok(!editor.includes('class="composer"'), "no composer without rows");
  const status = el("panel-status").innerHTML;
  assert.ok(status.includes("0 tasks running"), "counts render at zero");
  assert.ok(status.includes("Total $0.00"), "totals render");
  assert.ok(!status.includes("limit"), "no limit clause without a session limit");
});

test("reveal, stop, delete and prompt follow the BoardToHost contract", () => {
  pushSnapshot(FULL_SNAPSHOT);
  posted.length = 0;

  // Keyboard reveal on a tree row, like the sidebar.
  fire("keydown", { key: "Enter", target: target({ ".row": { dataset: { id: "ws-2" } } }), preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(posted.pop(), { t: "reveal", id: "ws-2" });

  // Callout buttons reveal the workspace's real chat tab.
  fire("click", click({ "[data-callout]": { dataset: { callout: "ws-4" } } }));
  assert.deepEqual(posted.pop(), { t: "reveal", id: "ws-4" });

  // Hover actions forward stop/delete, exactly like the sidebar.
  fire("click", click({ ".row": { dataset: { id: "ws-1" } }, "[data-act]": { dataset: { act: "stop" } } }));
  assert.deepEqual(posted.pop(), { t: "stop", id: "ws-1" });
  fire("click", click({ ".row": { dataset: { id: "ws-3" } }, "[data-act]": { dataset: { act: "delete" } } }));
  assert.deepEqual(posted.pop(), { t: "delete", id: "ws-3" });

  // The tab close button deletes the workspace.
  fire("click", click({ "[data-del]": { dataset: { del: "ws-5" } } }));
  assert.deepEqual(posted.pop(), { t: "delete", id: "ws-5" });

  // The composer posts { t: "prompt", id, text } on Enter, trimmed, and clears.
  composerInput.value = "  привет, агент  ";
  fire("keydown", {
    key: "Enter",
    target: target({ ".composer .in": { dataset: { row: "ws-1" } } }),
    preventDefault() {},
    stopPropagation() {},
  });
  assert.deepEqual(posted.pop(), { t: "prompt", id: "ws-1", text: "привет, агент" });
  assert.equal(composerInput.value, "", "the input clears after a send");

  // The send button posts the same shape.
  composerInput.value = "ещё раз";
  fire("click", click({ "[data-send]": { dataset: { send: "ws-1" } } }));
  assert.deepEqual(posted.pop(), { t: "prompt", id: "ws-1", text: "ещё раз" });

  // An empty composer posts nothing.
  composerInput.value = "   ";
  fire("click", click({ "[data-send]": { dataset: { send: "ws-1" } } }));
  assert.deepEqual(posted, [], "whitespace-only input is not sent");
});

test("a prompt refusal renders as a bad tool line and clears when the row runs", () => {
  pushSnapshot(FULL_SNAPSHOT);
  fire("click", click({ "[data-tab]": { dataset: { tab: "ws-3" } } }));
  assert.ok(!el("panel-editor").innerHTML.includes("tool bad"), "no error yet");

  pushMessage({ t: "promptError", id: "ws-3", message: "ws-3 is blocked on an approval dialog" });
  let editor = el("panel-editor").innerHTML;
  assert.ok(editor.includes('class="tool bad"'), "the refusal is a bad tool block");
  assert.ok(editor.includes("blocked on an approval dialog"), "the refusal text itself");

  // Selecting elsewhere and coming back keeps the line.
  fire("click", click({ "[data-tab]": { dataset: { tab: "ws-1" } } }));
  fire("click", click({ "[data-tab]": { dataset: { tab: "ws-3" } } }));
  assert.ok(el("panel-editor").innerHTML.includes("blocked on an approval dialog"), "the line survives re-renders");

  // The row running again means the next prompt went through; the line goes.
  const running = {
    ...FULL_SNAPSHOT,
    rows: FULL_SNAPSHOT.rows.map((row) =>
      row.id === "ws-3" ? { ...row, bar: "running", stage: "working", progress: 40 } : row,
    ),
  };
  pushSnapshot(running);
  editor = el("panel-editor").innerHTML;
  assert.ok(!editor.includes("blocked on an approval dialog"), "a running row clears the refusal");
});

test("every BoardBar renders in the tree and every editor style class exists", () => {
  pushSnapshot(FULL_SNAPSHOT);
  const tree = el("panel-tree").innerHTML;
  for (const bar of ["running", "done", "error", "waiting", "idle", "budget"]) {
    assert.ok(tree.includes(`is-${bar}`), `the tree renders ${bar}`);
  }
  for (const cls of [
    ".tabs",
    ".tab",
    ".crumbs",
    ".stages",
    ".log",
    ".msg",
    ".tool",
    ".shiny",
    ".callout",
    ".composer",
    ".chip",
    ".status",
  ]) {
    assert.ok(boardCss.includes(cls), `board.css is missing ${cls}`);
  }
  assert.match(boardCss, /\.callout\.beam::before/, "the border-beam survives");
  assert.match(boardCss, /prefers-reduced-motion/, "reduced-motion handling stays");
  // The panel reuses the sidebar's row markup straight from board.mjs.
  assert.ok(panelSrc.includes('from "./board.mjs"'), "the panel imports the row renderer");
});

test("markup escapes row data in tabs, crumbs and the log", () => {
  pushSnapshot(FULL_SNAPSHOT);
  const editor = el("panel-editor").innerHTML;
  assert.ok(editor.includes("qwen-&lt;script&gt;race"), "tab names are escaped");
  assert.ok(!editor.includes("<script>race"), "no raw markup from a row field");
  const tree = el("panel-tree").innerHTML;
  assert.ok(tree.includes("qwen-&lt;script&gt;race"), "tree names are escaped");
});

test("every panel string has a Russian translation", () => {
  const call = /\bt\(\s*("(?:[^"\\]|\\.)*")/g;
  const keys = new Set<string>();
  for (const src of [panelSrc, panelHostSrc]) {
    for (const match of src.matchAll(call)) {
      keys.add(JSON.parse(match[1] ?? '""') as string);
    }
  }
  assert.ok(keys.has("Process Board"), "the host skeleton is scanned too");
  const missing = [...keys].filter((key) => !(key in ruBundle));
  assert.deepEqual(missing, [], `untranslated panel strings: ${missing.join(" | ")}`);
});

test("the host wires the command, the panel and the prompt route", () => {
  // The contract grew exactly one variant.
  assert.ok(
    typesSrc.includes('{ t: "prompt"; id: string; text: string }'),
    "BoardToHost has the prompt variant",
  );

  assert.ok(panelHostSrc.includes('"ompcode.boardPanel"'), "the panel declares its viewType");
  assert.match(panelHostSrc, /script-src 'nonce-\$\{nonce\}'/, "the CSP is nonce-locked");
  assert.ok(panelHostSrc.includes('id="l10n-bundle"'), "the translation bundle is baked in");
  assert.ok(
    panelHostSrc.includes('"media", "board.css"') && panelHostSrc.includes('"media", "boardPanel.mjs"'),
    "the skeleton loads the panel's assets",
  );
  assert.ok(panelHostSrc.includes("data-base"), "the base branch is baked onto <body>");

  assert.ok(
    extensionSrc.includes('registerCommand("ompcode.openBoard"'),
    "extension.ts registers the command",
  );
  assert.ok(
    extensionSrc.includes("registerWebviewPanelSerializer(BoardPanel.viewType"),
    "extension.ts registers the serializer",
  );
  assert.ok(
    extensionSrc.includes("orchestrator.prompt({ id, message: text })"),
    "the composer routes through the orchestrator facade",
  );

  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
    contributes: { commands: Array<{ command: string; title: string }> };
  };
  const command = pkg.contributes.commands.find((entry) => entry.command === "ompcode.openBoard");
  assert.ok(command, "package.json contributes ompcode.openBoard");
  assert.equal(command.title, "%command.openBoard.title%", "the title is an nls key");
  const nls = JSON.parse(fs.readFileSync(path.join(root, "package.nls.json"), "utf8")) as Record<string, string>;
  const nlsRu = JSON.parse(fs.readFileSync(path.join(root, "package.nls.ru.json"), "utf8")) as Record<string, string>;
  assert.equal(nls["command.openBoard.title"], "OMP Code: Open Process Board");
  assert.ok(nlsRu["command.openBoard.title"], "the Russian title exists");
});
