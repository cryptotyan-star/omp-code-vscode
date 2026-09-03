import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * The processes column lives inside the chat webview, which `node --test`
 * cannot boot — main.mjs binds several dozen real DOM nodes on load. So this
 * pins the column's contract from the outside, the way webviewWiring.test.ts
 * already pins the rest of that renderer.
 *
 * Three invariants are worth more than the rest, because each of them failed
 * silently the last time something like this shipped:
 *  - the column must never appear in the sidebar chat or the Android shell,
 *  - it must not drag board.mjs or board.css into the chat webview,
 *  - and it must not add ids the shared Android shell would then have to carry.
 */

const root = path.join(import.meta.dirname, "..");
const mediaDir = path.join(root, "media");
const mainSrc = fs.readFileSync(path.join(mediaDir, "main.mjs"), "utf8");
const mainCss = fs.readFileSync(path.join(mediaDir, "main.css"), "utf8");
const boardCss = fs.readFileSync(path.join(mediaDir, "board.css"), "utf8");
const androidHtml = fs.readFileSync(path.join(mediaDir, "android.html"), "utf8");
const sessionSrc = fs.readFileSync(path.join(root, "src", "ompSession.ts"), "utf8");
const extensionSrc = fs.readFileSync(path.join(root, "src", "extension.ts"), "utf8");
const ruBundle = JSON.parse(fs.readFileSync(path.join(root, "l10n", "ru.json"), "utf8")) as Record<
  string,
  string
>;

/** The column's own source, so an assertion cannot pass on unrelated code. */
function columnSource(): string {
  const start = mainSrc.indexOf("/* Processes column");
  assert.ok(start > -1, "main.mjs must carry the processes column block");
  const end = mainSrc.indexOf("/* Notices", start);
  assert.ok(end > start, "the column block must end before the notices block");
  return mainSrc.slice(start, end);
}

// ---------------------------------------------------------------- reach

test("only a chat tab can grow a column — the sidebar and Android cannot", () => {
  // Two gates, because neither is sufficient alone. getHtml emits the wrapper
  // for BOTH chat surfaces, so the wrapper alone would let the sidebar chat
  // grow a column right above the board view showing the same rows; the tab id
  // is what separates them. The wrapper is what rules out the Android shell.
  assert.match(sessionSrc, /<div class="chat-stack">/, "getHtml wraps the chat stack");
  assert.doesNotMatch(androidHtml, /chat-stack/, "the Android shell stays a bare stack");
  const column = columnSource();
  assert.match(column, /querySelector\("\.chat-stack"\)/);
  assert.match(
    column,
    /if \(!tabId \|\| !app \|\| !stack\) return null;/,
    "no tab id (the sidebar) and no wrapper (Android) each stop the column",
  );
});

test("the host only feeds a session that owns a tab id", () => {
  // Both directions: it does not subscribe without a tab id, and it refuses
  // the row actions without one either — a stray message cannot reach through.
  assert.match(
    sessionSrc,
    /if \(!this\.overrides\.tabId \|\| !OmpSession\.boardFeed\) \{\s*\n\s*return;/,
    "subscribeBoard bails without a tab id",
  );
  assert.match(
    sessionSrc,
    /if \(!feed \|\| !id \|\| !this\.overrides\.tabId\) \{/,
    "the row actions bail without a tab id",
  );
  assert.match(sessionSrc, /if \(!feed \|\| !this\.overrides\.tabId\) \{/, "so does the push");
});

test("a tab that leaves the screen stops listening", () => {
  // One listener per tab, released on detach: without this every closed tab
  // leaves a subscription firing into a disposed webview forever.
  assert.match(sessionSrc, /detach\(\): void \{[\s\S]{0,200}?this\.unsubscribeBoard\(\);/);
  assert.match(sessionSrc, /this\.boardSub\?\.dispose\(\);\s*\n\s*this\.boardSub = undefined;/);
  assert.match(sessionSrc, /clearTimeout\(this\.boardFlush\)/, "the throttle timer goes too");
});

// ---------------------------------------------------------------- isolation

test("the chat webview never loads the board renderer or its stylesheet", () => {
  // board.mjs holds the board webviews' single acquireVsCodeApi(); importing it
  // here would acquire a second time and kill main.mjs at module scope, exactly
  // as it killed boardPanel.mjs. board.css would repaint the composer.
  assert.doesNotMatch(mainSrc, /from\s*["']\.\/board\.mjs["']/, "no board.mjs import");
  assert.doesNotMatch(mainSrc, /acquireVsCodeApi\s*\(/, "host-port.mjs owns the acquisition");
  assert.doesNotMatch(sessionSrc, /"board\.css"/, "getHtml links main.css only");
});

test("the column's classes cannot collide with the chat's own", () => {
  // board.css and main.css genuinely share .chip, .composer and .msg — the
  // reason the column is prefixed rather than reusing the board stylesheet.
  const names = (css: string): Set<string> =>
    new Set([...css.matchAll(/\.([A-Za-z][\w-]*)/g)].map((m) => m[1]));
  const shared = [...names(mainCss)].filter((n) => names(boardCss).has(n));
  for (const name of ["chip", "composer", "msg"]) {
    assert.ok(shared.includes(name), `.${name} is a real collision, keep the pc- prefix`);
  }
  const column = columnSource();
  // The markup is built by concatenation, so a class attribute can close on a
  // quote that belongs to the expression rather than the value. Only attributes
  // that are a clean class list are read; the rest are checked by hand below.
  const emitted = [...column.matchAll(/class="([a-z0-9 -]+)"/g)]
    .flatMap((m) => m[1].split(/\s+/))
    .filter(Boolean);
  assert.ok(emitted.length > 5, "the extraction found real class names");
  for (const cls of emitted) {
    assert.ok(
      cls.startsWith("pc") || cls.startsWith("is-"),
      `column class ${cls} must be pc- prefixed or a state class`,
    );
  }
  // The one class list built by concatenation, spelled out so it is covered too.
  assert.match(column, /'<div class="pc-row is-' \+ bar \+ \(child \? " pc-child" : ""\)/);
});

test("the column adds no id the Android shell would have to carry", () => {
  // webviewWiring.test.ts requires android.html to render every id main.mjs
  // looks up. The column is built at runtime and reached through its own
  // element, so it must never introduce one.
  const column = columnSource();
  const looked = [...column.matchAll(/getElementById\(["']([^"']+)["']\)/g)].map((m) => m[1]);
  for (const id of looked) {
    assert.match(androidHtml, new RegExp(`\\bid=["']${id}["']`), `android.html must render #${id}`);
  }
  assert.deepEqual(
    [...new Set(looked)],
    ["app"],
    "only #app, which the shared shell already has",
  );
});

// ---------------------------------------------------------------- behaviour

test("every column class the renderer emits is styled", () => {
  const column = columnSource();
  const emitted = new Set(
    [...column.matchAll(/class="([^"]*)"/g)]
      .flatMap((m) => m[1].split(/\s+/))
      .filter((c) => /^pc[a-z0-9-]*$/.test(c) && !c.endsWith("-")),
  );
  for (const cls of ["pc", "pc-head", "pc-toggle", "pc-list", "pc-row", "pc-stripe", "pc-foot"]) {
    emitted.add(cls);
  }
  for (const cls of emitted) {
    assert.ok(mainCss.includes(`.${cls}`), `main.css is missing .${cls}`);
  }
  // Every bar the model can produce needs a colour, or a state renders blank.
  for (const bar of ["running", "done", "error", "waiting", "budget", "idle"]) {
    assert.match(mainCss, new RegExp(`\\.pc-row\\.is-${bar}\\b`), `no styling for is-${bar}`);
  }
});

test("stripe widths go through the CSSOM, never an inline style attribute", () => {
  // The chat webview's CSP has no 'unsafe-inline' in style-src, so a style=""
  // attribute is dropped and every stripe would read as 0%.
  const column = columnSource();
  assert.doesNotMatch(column, /style="/, "no inline style attributes in the row markup");
  assert.match(column, /style\.setProperty\("--pc-p"/);
});

test("the tab's own workspace is marked, not offered as a destination", () => {
  const column = columnSource();
  assert.match(column, /procsSelfId && row\.id === procsSelfId/);
  assert.match(column, /pc-self/);
  assert.match(column, /child && !self/, "no stop or delete button on your own tab");
  assert.match(sessionSrc, /selfId: this\.overrides\.workspaceId/);
  assert.match(mainCss, /\.pc-row\.pc-self \{[^}]*cursor: default/);
});

test("the collapsed preference survives a reload without eating the tab id", () => {
  const column = columnSource();
  assert.match(column, /Object\.assign\(\{\}, state \|\| \{\}, \{ procsCollapsed: procsCollapsed \}\)/);
  assert.match(mainSrc, /procsCollapsed = !!\(storedState && storedState\.procsCollapsed\)/);
});

test("a phone cannot stop or delete a workspace through the column's verbs", () => {
  // An unmapped verb is allowed by default in REMOTE_UI_CAPABILITY, so the
  // three row actions have to be mapped explicitly.
  assert.match(mainSrc, /boardReveal: "view"/);
  assert.match(mainSrc, /boardStop: "prompt"/);
  assert.match(mainSrc, /boardDelete: "session\.manage"/);
});

test("the column shares one cache with the two board surfaces", () => {
  // A second orchestrator.list() loop would drift from the one the board reads.
  assert.match(
    extensionSrc,
    /OmpSession\.useBoardFeed\(\{\s*\n\s*snapshot: boardSnapshot,\s*\n\s*onChange: boardOnChange,/,
  );
  assert.match(
    extensionSrc,
    /boardPanel\.active \|\| boardEditor\.active \|\| OmpSession\.boardColumnLive/,
    "the cost poll keeps running while only a column is open",
  );
  assert.match(sessionSrc, /const BOARD_COLUMN_FLUSH_MS = 250;/, "same window as the board views");
});

test("the first snapshot arrives with the boot reply, not on the next poll", () => {
  // Without this the column sits empty for up to two seconds on every open.
  const ready = sessionSrc.slice(sessionSrc.indexOf('case "ready": {'));
  const push = ready.indexOf("this.postBoard();");
  const probe = ready.indexOf('t: "probe"');
  assert.ok(push > -1 && push < probe, "postBoard runs inside the ready handler");
});

test("every string the column shows has a Russian translation", () => {
  const column = columnSource();
  const keys = [...column.matchAll(/\bt\(\s*("(?:[^"\\]|\\.)*")/g)].map(
    (m) => JSON.parse(m[1]) as string,
  );
  assert.ok(keys.length > 10, "the column is translated, not hardcoded");
  for (const key of keys) {
    assert.ok(ruBundle[key], `l10n/ru.json is missing ${JSON.stringify(key)}`);
  }
});

// ------------------------------------------------- lifetime and side effects

test("a force-disposed tab drops its listener too", () => {
  // forceDispose() → disposeNow() never goes through detach(), and that is the
  // path a closed workspace chat takes. Without this the host's listener set
  // grows by one entry per closed tab for the life of the window, invisibly:
  // pushBoard() early-returns on the dead session, so nothing ever misdraws.
  const body = sessionSrc.slice(sessionSrc.indexOf("private disposeNow(): void {"));
  const stop = body.indexOf("\n  }");
  assert.ok(
    body.slice(0, stop).includes("this.unsubscribeBoard();"),
    "disposeNow must release the board subscription",
  );
});

test("deactivate lets go of the feed's closures", () => {
  // The static outlives the activation. Held past deactivate it keeps the dead
  // orchestrator and workspace manager alive with it.
  assert.match(sessionSrc, /static useBoardFeed\(feed: BoardFeed \| undefined\): void/);
  const tail = extensionSrc.slice(extensionSrc.indexOf("export async function deactivate"));
  const clear = tail.indexOf("OmpSession.useBoardFeed(undefined);");
  const dispose = tail.indexOf("OmpSession.forEachActive((session) => session.forceDispose());");
  assert.ok(clear > -1, "deactivate clears the feed");
  assert.ok(clear < dispose, "cleared before the disposals that fire notifyBoard");
});

test("a hidden tab stops the cost poll and repaints when it returns", () => {
  // Chat tabs are created with retainContextWhenHidden, so detach() never runs
  // for a backgrounded tab — an open tab is not the same thing as a visible one.
  assert.match(extensionSrc, /retainContextWhenHidden: true/);
  assert.match(sessionSrc, /session\.boardSub !== undefined && \(session\.callbacks\.isVisible\?\.\(\) \?\? true\)/);
  assert.match(extensionSrc, /isVisible: \(\) => panel\.visible,/);
  assert.match(extensionSrc, /panel\.onDidChangeViewState\(\(\) => \{\s*\n\s*if \(panel\.visible\) \{\s*\n\s*session\.refreshBoard\(\);/);
  // Through the throttle, not around it: dragging a tab between editor groups
  // fires several view-state events in a row.
  assert.match(sessionSrc, /refreshBoard\(\): void \{\s*\n\s*this\.pushBoard\(\);/);
});

test("a webview that has not booted yet does not burn the throttle window", () => {
  assert.match(sessionSrc, /if \(!this\.boardSub \|\| !this\.webview \|\| !this\.webviewReady\) \{/);
});

// ------------------------------------------------------------- row behaviour

test("the tab's own row is inert on click and on Enter", () => {
  const column = columnSource();
  const reveals = [...column.matchAll(/post\(\{ t: "boardReveal", id: id \}\)/g)];
  assert.equal(reveals.length, 2, "one reveal on click, one on Enter");
  assert.equal(
    [...column.matchAll(/procsSelfId && id === procsSelfId\) return;/g)].length,
    2,
    "both paths refuse the row the reader is already inside",
  );
});

test("Enter on a focused stop button does not also reveal the row behind it", () => {
  const column = columnSource();
  assert.match(column, /closest\("\[data-pc-act\]"\)\) return;/);
});

test("the empty state is about workspaces, not about having no rows at all", () => {
  // An orchestrator with no workspaces yet is the single most common first
  // sight of the column; keying the empty state on `rows.length` showed a bare
  // list with no explanation in exactly that case.
  const column = columnSource();
  assert.match(column, /var lead = rows\.filter\(function \(r\) \{ return r\.kind === "orchestrator"; \}\)/);
  assert.match(column, /lead\.map\(pcRowHtml\)\.join\(""\)\s*\n\s*\+ \(kids\.length/);
});

test("one merged count, computed by the host, read by every surface", () => {
  // The column used to recount `stage === "merged"` locally while board.mjs
  // read `counts.done` — two answers to "N of M merged" from one snapshot.
  const boardTypes = fs.readFileSync(path.join(root, "src", "boardTypes.ts"), "utf8");
  const boardModel = fs.readFileSync(path.join(root, "src", "boardModel.ts"), "utf8");
  const boardMjs = fs.readFileSync(path.join(mediaDir, "board.mjs"), "utf8");
  assert.match(boardTypes, /merged: number/);
  assert.match(boardModel, /merged: workspaces\.filter\(\(ws\) => ws\.stage === "merged"\)\.length,/);
  assert.match(boardMjs, /snap\.counts\.merged \|\| 0/);
  assert.match(columnSource(), /counts\.merged \|\| 0/);
});

test("an overspent workspace says so on its own row", () => {
  const column = columnSource();
  assert.match(column, /row\.overBudget \? " pc-spent" : ""/);
  assert.match(mainCss, /\.pc-sub \.pc-cost\.pc-spent \{[^}]*color: var\(--pc-err\)/);
  // The session footer keeps its own class; scoping stops the two fighting.
  assert.match(mainCss, /\.pc-foot\.pc-over \{/);
});

test("a row names the model running it", () => {
  assert.match(columnSource(), /row\.model \? ' title="' \+ esc\(row\.model\) \+ '"' : ""/);
});

// ------------------------------------------------------------ resize

test("the column is draggable, clamped, and remembers its width", () => {
  const column = columnSource();
  assert.match(column, /class="pc-grip"/);
  assert.match(column, /role="separator"/, "a separator, not a button");
  assert.match(column, /addEventListener\("pointerdown", onGripDown\)/);
  assert.match(mainCss, /\.pc \{[^}]*width: var\(--pc-w, 232px\)/, "CSS reads the dragged width");
  assert.match(column, /style\.setProperty\("--pc-w"/, "and the CSSOM writes it, not a style attr");
  // A stored width outlives the window size it was chosen at, so the clamp is
  // re-applied on every read rather than trusted once.
  assert.match(column, /Math\.round\(window\.innerWidth \/ 2\)/, "never wider than half the tab");
  assert.match(column, /PC_WIDTH_MIN = 168/);
  assert.match(column, /addEventListener\("resize", function \(\) \{ applyProcsWidth\(\); \}\)/);
});

test("a drag writes the width once, on release", () => {
  // Persisting per pointermove would hammer the state slot sixty times a second.
  const column = columnSource();
  assert.match(column, /setProcsWidth\(startWidth \+ \(moveEvent\.clientX - startX\), false\)/);
  assert.match(column, /if \(persist === false\) return;/);
  assert.match(
    column,
    /Object\.assign\(\{\}, state \|\| \{\}, \{ procsWidth: procsWidth \}\)/,
    "and it merges, so the tab id and the collapsed flag survive",
  );
  assert.match(column, /procsWidth = clampProcsWidth\(storedState && storedState\.procsWidth\)/);
});

test("a drag releases even when the pointer leaves the handle", () => {
  // pointerup on the window, not the grip: a fast drag ends outside it, and a
  // listener left behind would keep resizing on the next mouse move.
  const column = columnSource();
  for (const evt of ["pointermove", "pointerup", "pointercancel"]) {
    assert.match(column, new RegExp(`window\\.addEventListener\\("${evt}", `), `binds ${evt}`);
    assert.match(column, new RegExp(`window\\.removeEventListener\\("${evt}", `), `releases ${evt}`);
  }
  assert.match(mainCss, /#app\.pc-resizing \{ cursor: col-resize; user-select: none; \}/);
});

test("the width is reachable without a mouse, and gone when there is none to set", () => {
  const column = columnSource();
  assert.match(column, /event\.key === "ArrowLeft"/);
  assert.match(column, /event\.key === "ArrowRight"/);
  assert.match(column, /event\.key === "Home"/, "Home resets to the default width");
  assert.match(column, /tabindex="0"/);
  assert.match(column, /if \(procsCollapsed \|\| !procsEl\) return;/, "a rail has no width to drag");
  assert.match(mainCss, /\.pc\.pc-collapsed \.pc-grip \{ display: none; \}/);
  assert.match(mainCss, /\.pc \.pc-grip \{ display: none; \}/, "nor does the narrow-tab rail");
});

// ------------------------------------------------- processes-mode prompt

test("a run offers the processes view once, and never blocks on the answer", () => {
  const orchestratorSrc = fs.readFileSync(path.join(root, "src", "orchestrator.ts"), "utf8");
  // Fired, not awaited: a tool call parked on a dialog is a dead turn when the
  // human has walked away, and the question is about a window, not permission.
  assert.match(orchestratorSrc, /onOrchestrationStart\?\(existing: number\): void;/);
  assert.match(orchestratorSrc, /this\.deps\.onOrchestrationStart\?\.\(mine\.length\)/);
  assert.doesNotMatch(orchestratorSrc, /await this\.deps\.onOrchestrationStart/);
  // Once per orchestrator, not once per workspace it cuts.
  assert.match(orchestratorSrc, /private announcedStart = false;/);
  assert.match(orchestratorSrc, /if \(!this\.announcedStart\) \{\s*\n\s*this\.announcedStart = true;/);
  // A host that throws while asking must not cost the model its create.
  assert.match(orchestratorSrc, /catch \(error: unknown\) \{[\s\S]{0,160}?orchestration notice failed/);
});

test("the prompt is skippable, and stays skipped across reloads", () => {
  assert.match(extensionSrc, /cfg\.get<boolean>\("askProcessesMode", true\)/);
  assert.match(
    extensionSrc,
    /cfg\.update\("askProcessesMode", false, vscode\.ConfigurationTarget\.Global\)/,
    "«Don't ask again» writes the setting, not a variable a reload drops",
  );
  // Nothing to offer when a board is already on screen.
  assert.match(extensionSrc, /if \(boardPanel\.active \|\| boardEditor\.active\) \{\s*\n\s*return;/);
  assert.match(extensionSrc, /executeCommand\("ompcode\.openBoard"\)/);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
    contributes: { configuration: { properties: Record<string, { type: string; default: unknown }> } };
  };
  const setting = pkg.contributes.configuration.properties["ompcode.askProcessesMode"];
  assert.ok(setting, "package.json contributes ompcode.askProcessesMode");
  assert.equal(setting.type, "boolean");
  assert.equal(setting.default, true);
});

test("the notice is defined after the surfaces it reads", () => {
  // It reads boardPanel and boardEditor. Defined above them it would compile
  // and then throw on the first orchestration, in a temporal dead zone.
  const panel = extensionSrc.indexOf("const boardEditor = new BoardPanel(");
  const notice = extensionSrc.indexOf("const askProcessesMode = (existing: number): void =>");
  assert.ok(panel > -1 && notice > panel, "askProcessesMode comes after boardEditor");
});
