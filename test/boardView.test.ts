import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * board.mjs is the whole renderer of the ompcode.board webview; it cannot be
 * exercised in a real webview from `node --test`, so it is booted here against
 * a stub DOM that captures posted messages and lets tests dispatch the
 * host's `{ t: "board", snapshot }` pushes — the same way webviewWiring.test.ts
 * pins the chat webview's contract from the outside.
 */

const root = path.join(import.meta.dirname, "..");
const boardSrc = fs.readFileSync(path.join(root, "media", "board.mjs"), "utf8");
const boardCss = fs.readFileSync(path.join(root, "media", "board.css"), "utf8");
const providerSrc = fs.readFileSync(path.join(root, "src", "boardViewProvider.ts"), "utf8");
const extensionSrc = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
const ruBundle = JSON.parse(fs.readFileSync(path.join(root, "l10n", "ru.json"), "utf8")) as Record<
  string,
  string
>;

// ---------------------------------------------------------------------------
// Stub DOM. Elements are plain bags created on demand; innerHTML is stored,
// never parsed — assertions read the markup string the renderer produced.
// ---------------------------------------------------------------------------

interface StubElement {
  id: string;
  innerHTML: string;
  textContent: string;
  hidden: boolean;
  dataset: Record<string, string>;
  style: { setProperty(key: string, value: string): void; removeProperty(key: string): void };
  classList: { contains(name: string): boolean };
  addEventListener(): void;
  querySelectorAll(): StubElement[];
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
      dataset: {},
      style: { setProperty() {}, removeProperty() {} },
      classList: { contains: () => false },
      addEventListener() {},
      querySelectorAll: () => [],
    };
    elements[id] = found;
  }
  return found;
}

const posted: unknown[] = [];

// The webview globals board.mjs reads at boot; defineProperty because the
// compiler already declares `document`/`window` with DOM types this stub
// deliberately does not satisfy.
Object.defineProperty(globalThis, "document", {
  configurable: true,
  value: {
    getElementById: (id: string) => el(id),
    addEventListener: (type: string, fn: StubHandler) => {
      docListeners[type] = [...(docListeners[type] ?? []), fn];
    },
    querySelectorAll: () => [],
    documentElement: {
      lang: "en",
      dataset: {},
      style: { setProperty() {}, removeProperty() {} },
    },
    body: { classList: { contains: () => false }, getAttribute: () => null },
  },
});
const windowTarget = new EventTarget();
Object.defineProperty(globalThis, "window", { configurable: true, value: windowTarget });
// One acquisition per webview, exactly like VS Code's preamble: a permissive
// stub let a second `acquireVsCodeApi()` at module scope pass here while the
// real webview died on it, so the suite stayed green over a dead renderer.
let apiAcquired = false;
Object.defineProperty(globalThis, "acquireVsCodeApi", {
  configurable: true,
  value: () => {
    if (apiAcquired) {
      throw new Error("An instance of the VS Code API has already been acquired");
    }
    apiAcquired = true;
    return { postMessage: (msg: unknown) => posted.push(msg) };
  },
});

// Dynamic on purpose: the module boots on import, so the stub DOM above must
// exist first — a static import would evaluate board.mjs before any of it.
await import("../media/board.mjs");

function pushSnapshot(snapshot: unknown): void {
  windowTarget.dispatchEvent(new MessageEvent("message", { data: { t: "board", snapshot } }));
}

function fire(type: string, event: StubEvent): void {
  for (const fn of docListeners[type] ?? []) {
    fn(event);
  }
}

/** A click/keydown target living inside `.row` — and optionally on a hover action. */
function rowTarget(id: string, act?: string): StubEvent["target"] {
  return {
    closest: (selector: string) => {
      if (selector === ".row") {
        return { dataset: { id } };
      }
      if (selector === "[data-act]" && act) {
        return { dataset: { act } };
      }
      return null;
    },
  };
}

function clickEvent(id: string, act?: string): StubEvent {
  return { target: rowTarget(id, act), preventDefault() {}, stopPropagation() {} };
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

test("the board boots, posts ready, and renders a full snapshot", () => {
  assert.deepEqual(posted, [{ t: "ready" }], "boot must post exactly one ready message");

  pushSnapshot(FULL_SNAPSHOT);

  const orch = el("orch").innerHTML;
  assert.match(orch, /row is-running/, "orchestrator row runs");
  assert.ok(orch.includes("Fable") && orch.includes("orchestrator"), "orchestrator name and role");
  assert.ok(orch.includes("24м 32с"), "orchestrator clock, 1472s");
  assert.ok(!orch.includes('class="ticks"'), "the orchestrator has no pipeline ticks");

  const tree = el("tree").innerHTML;
  for (const bar of ["running", "done", "error", "waiting", "idle", "budget"]) {
    assert.ok(tree.includes(`is-${bar}`), `tree renders the ${bar} state`);
  }
  assert.equal(
    (tree.match(/class="row child /g) ?? []).length,
    6,
    "every workspace row is an indented child",
  );

  // Five pipeline ticks per workspace row: создание → работа → diff → verify → merge.
  assert.equal((tree.match(/<span class="ticks">/g) ?? []).length, 6, "one tick strip per row");
  assert.equal(
    (tree.match(/<span class="(?:hit|bad|)"><\/span>/g) ?? []).length,
    30,
    "five tick spans per row",
  );
  assert.ok(tree.includes('class="bad"'), "the error row marks the stage it fell on");

  // Cost on every row; limits render "$X.XX / $Y".
  assert.ok(tree.includes("$0.31 / $5"), "limited row shows spend against its limit");
  assert.ok(tree.includes("$5.12 / $5"), "over-budget row shows spend against its limit");
  assert.ok(tree.includes("cost tnum over"), "overBudget rows are flagged");
  assert.ok(tree.includes("$1.50"), "unlimited rows show plain cost");
  assert.ok(orch.includes("$26.40"), "the orchestrator row shows its cost too");
});

test("row markup escapes model text and carries the mock's labels and fields", () => {
  pushSnapshot(FULL_SNAPSHOT);
  const tree = el("tree").innerHTML;
  assert.ok(tree.includes("qwen-&lt;script&gt;race"), "names are escaped");
  assert.ok(!tree.includes("<script>race"), "no raw markup from a row field");
  assert.ok(tree.includes('title="400 Access denied"'), "lastError becomes the row tooltip");
  assert.equal((tree.match(/needs-human/g) ?? []).length, 3, "rows needing a human are marked");
  assert.ok(tree.includes('data-p="83"'), "progress travels as data-p (CSP forbids inline style)");
  assert.ok(tree.includes('data-ind="46"'), "parentId rows indent one step deeper");
  assert.ok(tree.includes("18м 21с"), "elapsed seconds render as the mock's clock");
  assert.ok(tree.includes("⎇ ws/quiet"), "idle rows fall back to the branch");
  // Hover actions: stop only where something lives, delete on every workspace row.
  assert.equal((tree.match(/data-act="stop"/g) ?? []).length, 2, "stop on running + waiting");
  assert.equal((tree.match(/data-act="delete"/g) ?? []).length, 6, "delete on every workspace row");
});

test("counts badges and the totals footer follow the snapshot", () => {
  pushSnapshot(FULL_SNAPSHOT);
  assert.equal(el("cnt-all").textContent, "6", "total badge counts workspace rows");
  assert.equal(el("cnt-err").hidden, false, "err badge shows when errors or waiting exist");
  assert.equal(el("cnt-err").textContent, "2", "err badge counts error + waiting");
  const foot = el("foot").innerHTML;
  assert.ok(foot.includes("Total $33.90 (limit $40)"), "footer totals with the session limit");
  assert.ok(!foot.includes("total tnum over"), "no over-budget styling under the limit");

  pushSnapshot({ ...EMPTY_SNAPSHOT, totalCostUsd: 12.5, sessionLimitUsd: 10, overSessionBudget: true });
  const over = el("foot").innerHTML;
  assert.ok(over.includes("Total $12.50 (limit $10)"), "footer totals over the limit");
  assert.ok(over.includes("total tnum over"), "overSessionBudget paints the footer");
});

test("an empty snapshot renders a calm empty state instead of crashing", () => {
  pushSnapshot(EMPTY_SNAPSHOT);
  assert.equal(el("orch").innerHTML, "", "no orchestrator, no orchestrator row");
  const tree = el("tree").innerHTML;
  assert.ok(tree.includes("empty") && tree.includes("No processes yet"), "empty state text");
  assert.equal(el("cnt-all").textContent, "0");
  assert.equal(el("cnt-err").hidden, true, "err badge hides at zero");
  const foot = el("foot").innerHTML;
  assert.ok(foot.includes("Total $0.00"), "footer without a session limit");
  assert.ok(!foot.includes("limit"), "no limit clause when sessionLimitUsd is undefined");
});

test("row clicks and hover actions post the BoardToHost contract", () => {
  posted.length = 0;
  fire("click", clickEvent("ws-1"));
  assert.deepEqual(posted.pop(), { t: "reveal", id: "ws-1" });

  fire("click", clickEvent("ws-1", "stop"));
  assert.deepEqual(posted.pop(), { t: "stop", id: "ws-1" });

  fire("click", clickEvent("ws-3", "delete"));
  assert.deepEqual(posted.pop(), { t: "delete", id: "ws-3" });

  fire("keydown", { key: "Enter", target: rowTarget("ws-2"), preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(posted.pop(), { t: "reveal", id: "ws-2" }, "keyboard reveals like a click");

  posted.length = 0;
  fire("click", { target: { closest: () => null }, preventDefault() {}, stopPropagation() {} });
  assert.deepEqual(posted, [], "a click outside any row posts nothing");
});

test("board.mjs speaks of every BoardRow field and every BoardBar value", () => {
  // The renderer must not silently drop a contract field.
  for (const field of [
    "id",
    "kind",
    "parentId",
    "name",
    "model",
    "branch",
    "bar",
    "stage",
    "progress",
    "costUsd",
    "costLimitUsd",
    "overBudget",
    "elapsedSec",
    "lastText",
    "lastError",
    "needsHuman",
  ]) {
    assert.ok(
      new RegExp(String.raw`\brow\.${field}\b`).test(boardSrc),
      `board.mjs never reads row.${field}`,
    );
  }
  for (const bar of ["running", "done", "error", "waiting", "idle", "budget"]) {
    assert.ok(boardSrc.includes(`case "${bar}"`), `barLabel has no ${bar} case`);
    assert.ok(boardCss.includes(`.is-${bar}`), `board.css has no .is-${bar} styling`);
  }
  // The budget bar reuses the dark-red error color for its full stripe.
  assert.match(boardCss, /\.is-error, \.is-budget \{ --c: var\(--omp-err\); \}/);
  assert.match(boardCss, /\.is-budget \.stripe > i \{ width: 100%/);
  assert.match(boardCss, /prefers-reduced-motion/, "reduced-motion handling stays");
});

test("every board string has a Russian translation", () => {
  const call = /\bt\(\s*("(?:[^"\\]|\\.)*")/g;
  const keys = new Set<string>();
  for (const src of [boardSrc, providerSrc]) {
    for (const match of src.matchAll(call)) {
      keys.add(JSON.parse(match[1] ?? '""') as string);
    }
  }
  assert.ok(keys.has("Processes"), "the provider skeleton is scanned too");
  const missing = [...keys].filter((key) => !(key in ruBundle));
  assert.deepEqual(missing, [], `untranslated board strings: ${missing.join(" | ")}`);
});

test("the host registers ompcode.board and the provider follows the webview pattern", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
    contributes: { views: Record<string, Array<{ type?: string; id: string }>> };
  };
  const view = (pkg.contributes.views["ompcode"] ?? []).find((entry) => entry.id === "ompcode.board");
  assert.ok(view, "package.json contributes ompcode.board");
  assert.equal(view.type, "webview", "the board is a webview view");

  assert.ok(
    extensionSrc.includes("registerWebviewViewProvider(BoardViewProvider.viewType, boardPanel"),
    "extension.ts registers the provider",
  );
  assert.ok(extensionSrc.includes('executeCommand("ompcode.workspace.reveal"'), "reveal reuses the workspace command");
  assert.ok(extensionSrc.includes('executeCommand("ompcode.sessionAbort"'), "stop reuses the session command");
  assert.ok(extensionSrc.includes('executeCommand("ompcode.workspace.delete"'), "delete reuses the workspace command");

  assert.ok(providerSrc.includes('"ompcode.board"'), "the provider declares its viewType");
  assert.match(providerSrc, /script-src 'nonce-\$\{nonce\}'/, "the CSP is nonce-locked");
  assert.ok(providerSrc.includes('id="l10n-bundle"'), "the translation bundle is baked in");
  assert.ok(
    providerSrc.includes('"media", "board.css"') && providerSrc.includes('"media", "board.mjs"'),
    "the skeleton loads the board's own assets",
  );
  assert.ok(providerSrc.includes("data-theme"), "the skeleton stamps the theme");
});
