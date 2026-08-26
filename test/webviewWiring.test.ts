import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * main.mjs and markdown.mjs are separate ES modules: exports are module-scoped,
 * never globals. main.mjs once called `renderMarkdown()` without importing it,
 * so every assistant reply died on a ReferenceError that the host-message
 * try/catch swallowed — a silent, total rendering failure. This guards the
 * wiring statically, since the webview cannot be exercised from `node --test`.
 */

const mediaDir = path.join(import.meta.dirname, "..", "media");
const mainSrc = fs.readFileSync(path.join(mediaDir, "main.mjs"), "utf8");
const markdownSrc = fs.readFileSync(path.join(mediaDir, "markdown.mjs"), "utf8");
const hostPortSrc = fs.readFileSync(path.join(mediaDir, "host-port.mjs"), "utf8");
const androidHtml = fs.readFileSync(path.join(mediaDir, "android.html"), "utf8");

function exportedNames(src: string): string[] {
  return [...src.matchAll(/^export\s+function\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
}

function importedNames(src: string, from: string): string[] {
  const re = new RegExp(String.raw`import\s*\{([^}]*)\}\s*from\s*["']${from}["']`, "g");
  return [...src.matchAll(re)].flatMap((m) =>
    m[1]
      .split(",")
      .map((part) => part.trim().split(/\s+as\s+/)[0].trim())
      .filter(Boolean),
  );
}

/** main.mjs minus its import statements — where a name must be *bound* to be used. */
const mainBody = mainSrc.replace(/^\s*import\s[^;]+;/gm, "");

/** Names main.mjs declares itself; those shadow the module's exports legally. */
function declaredLocally(src: string, name: string): boolean {
  return new RegExp(String.raw`(?:function|var|let|const)\s+${name}\b`).test(src);
}

/** Evaluate one actual, dependency-free function declaration from main.mjs. */
function loadFunction<T extends (...args: never[]) => unknown>(src: string, name: string): T {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist in main.mjs`);
  const bodyStart = src.indexOf("{", start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === "{") depth++;
    if (src[i] === "}") depth--;
    if (depth === 0) {
      const declaration = src.slice(start, i + 1);
      return Function(`"use strict"; return (${declaration});`)() as T;
    }
  }
  throw new Error(`unterminated ${name} declaration`);
}

test("markdown.mjs exports something to import", () => {
  const exports = exportedNames(markdownSrc);
  assert.ok(exports.includes("renderMarkdown"), `expected renderMarkdown, got ${exports.join(", ")}`);
});

test("every markdown.mjs export main.mjs calls is imported", () => {
  const imported = new Set(importedNames(mainSrc, "./markdown.mjs"));
  const missing: string[] = [];
  for (const name of exportedNames(markdownSrc)) {
    const used = new RegExp(String.raw`\b${name}\s*\(`).test(mainBody);
    if (used && !imported.has(name) && !declaredLocally(mainBody, name)) {
      missing.push(name);
    }
  }
  assert.deepEqual(missing, [], `main.mjs calls these without importing them: ${missing.join(", ")}`);
});

test("main.mjs reports swallowed render errors instead of hiding them", () => {
  // The catch that hid the ReferenceError must hand the failure to the host.
  assert.match(mainSrc, /catch\s*\(err\)\s*\{[^}]*reportUiError/, "host-message catch must call reportUiError");
  assert.match(mainSrc, /post\(\{\s*t:\s*["']uiError["']/, "reportUiError must post t:\"uiError\" to the host");
});

test("the host HTML still loads both webview modules", () => {
  const hostSrc = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "ompSession.ts"), "utf8");
  assert.match(hostSrc, /markdown\.mjs/, "getHtml must reference markdown.mjs");
  assert.match(hostSrc, /main\.mjs/, "getHtml must reference main.mjs");
  assert.match(hostSrc, /case "uiError"/, "host must handle the uiError message");
});

test("renderer uses the platform-neutral HostPort instead of a direct VS Code global", () => {
  assert.match(mainSrc, /import\s*\{\s*createHostPort\s*\}\s*from\s*["']\.\/host-port\.mjs["']/);
  assert.match(mainSrc, /hostPort\.post\(msg\)/);
  assert.match(mainSrc, /hostPort\.subscribe\(/);
  assert.doesNotMatch(mainSrc, /acquireVsCodeApi\s*\(/, "only host-port.mjs may acquire the VS Code API");
  assert.match(hostPortSrc, /acquireVsCodeApi/);
  assert.match(hostPortSrc, /ompHost/);
});

test("Android shared-renderer shell is CSP-locked and contains every bound element", () => {
  const ids = [...mainSrc.matchAll(/getElementById\(["']([^"']+)["']\)/g)].map((match) => match[1]);
  for (const id of ids) {
    assert.match(androidHtml, new RegExp(`\\bid=["']${id}["']`), `android.html must render #${id}`);
  }
  assert.match(androidHtml, /Content-Security-Policy/);
  assert.doesNotMatch(androidHtml, /unsafe-inline|unsafe-eval|javascript:/i);
  assert.doesNotMatch(androidHtml, /\son[a-z]+\s*=/i, "shared shell must not contain inline event handlers");
  assert.match(androidHtml, /<script type="module" src="main\.mjs"><\/script>/);
});

test("Android shell opts into a scoped mobile theme with one web topbar", () => {
  const cssSrc = fs.readFileSync(path.join(mediaDir, "main.css"), "utf8");
  const activitySrc = fs.readFileSync(
    path.join(import.meta.dirname, "..", "android", "app", "src", "main", "java", "sh", "omp", "remote", "MainActivity.kt"),
    "utf8",
  );
  const webBridgeSrc = fs.readFileSync(
    path.join(import.meta.dirname, "..", "android", "app", "src", "main", "java", "sh", "omp", "remote", "web", "OmpWebBridge.kt"),
    "utf8",
  );
  assert.match(
    androidHtml,
    /<body\b[^>]*\bdata-platform=["']android["'][^>]*>/,
    "the packaged Android shell must carry an explicit platform marker",
  );

  const androidBodyRules = [...cssSrc.matchAll(/body\[data-platform=["']android["']\]\s*\{([^}]*)\}/g)]
    .map((match) => match[1])
    .join("\n");
  assert.ok(androidBodyRules, "main.css must define an Android-scoped body theme");
  for (const token of ["bg", "fg", "muted", "border", "input-bg", "widget-bg", "code-bg", "err"]) {
    assert.match(
      androidBodyRules,
      new RegExp(`--${token}\\s*:`),
      `the Android body theme must provide --${token} without relying on VS Code variables`,
    );
  }

  assert.equal((androidHtml.match(/<header\b[^>]*class=["'][^"']*\btopbar\b[^"']*["']/g) ?? []).length, 1);
  const androidTopbarRule = cssSrc.match(
    /body\[data-platform=["']android["']\]\s+\.topbar\s*\{([^}]*)\}/s,
  )?.[1] ?? "";
  assert.ok(androidTopbarRule, "main.css must define the single Android web topbar");
  assert.match(androidTopbarRule, /min-height\s*:\s*64px\b/, "portrait Android topbar must reserve 64px");
  assert.doesNotMatch(androidTopbarRule, /display\s*:\s*none\b/, "the single Android web topbar must remain visible");

  const assistantRule = cssSrc.match(
    /body\[data-platform=["']android["']\]\s+\.msg\.assistant\s*\{([^}]*)\}/s,
  )?.[1] ?? "";
  assert.match(
    assistantRule,
    /flex-direction\s*:\s*column\b/,
    "multi-block assistant responses must stack vertically on Android",
  );

  const navSlotRule = cssSrc.match(
    /body\[data-platform=["']android["']\]\s+\.mobile-nav-slot\s*\{([^}]*)\}/s,
  )?.[1] ?? "";
  assert.match(navSlotRule, /width\s*:\s*48px\b/, "web chrome must reserve the native drawer button width");
  assert.match(navSlotRule, /height\s*:\s*48px\b/, "web chrome must reserve the native drawer button height");
  const androidAppRule = cssSrc.match(
    /body\[data-platform=["']android["']\]\s+#app\s*\{([^}]*)\}/s,
  )?.[1] ?? "";
  assert.ok(androidAppRule, "main.css must define an Android-scoped #app layout");
  assert.match(androidAppRule, /position\s*:\s*fixed\b/, "the Android #app surface must be fixed");
  assert.match(androidAppRule, /inset\s*:\s*0\b/, "the Android #app surface must fill the WebView viewport");
  const remoteWorkspaceStart = activitySrc.indexOf("private fun RemoteWorkspace(");
  const nextComposable = activitySrc.indexOf("\n@Composable\nprivate fun ", remoteWorkspaceStart + 1);
  const remoteWorkspaceEnd = nextComposable >= 0 ? nextComposable : activitySrc.length;
  assert.ok(remoteWorkspaceStart >= 0 && remoteWorkspaceEnd > remoteWorkspaceStart, "RemoteWorkspace must remain inspectable");
  const remoteWorkspaceSrc = activitySrc.slice(remoteWorkspaceStart, remoteWorkspaceEnd);
  assert.doesNotMatch(remoteWorkspaceSrc, /\btopBar\s*=/, "Compose must not add a second Android topbar");
  assert.doesNotMatch(remoteWorkspaceSrc, /\bbottomBar\s*=/, "Compose must not add a second composer/status bar");
  assert.match(
    remoteWorkspaceSrc,
    /Modifier\.align\(Alignment\.TopStart\)/,
    "the native drawer button must overlay the slot reserved by the web topbar",
  );
  assert.match(remoteWorkspaceSrc, /BackHandler\(enabled = webModalOpen\)/, "Android Back must be routed to an open web modal");
  assert.match(remoteWorkspaceSrc, /if \(!webModalOpen\)\s*\{\s*IconButton/s, "the native drawer button must be unavailable while a modal is open");
  // Stronger than the old `!webModalOpen`: the drag gesture kept capturing vertical
  // scrolls in the transcript and pulling the drawer open mid-read, so the drawer is
  // now button-only and can never be swiped open — modal or not.
  assert.match(remoteWorkspaceSrc, /gesturesEnabled\s*=\s*false/, "the drawer must open from its button only, never from a swipe");
  assert.match(webBridgeSrc, /parseAndroidModalState\(raw\)/, "the origin-scoped bridge must accept the local modal-state signal");
  assert.match(mainSrc, /hostPort\.post\(\{ t: "androidModalState", open: !!open \}\)/, "the renderer must report modal state to Android");
  assert.match(
    mainSrc,
    /case "androidBack":\s*if \(settingsScreen\) closeSettings\(\);\s*else if \(activeModal\) cancelActiveModal\(\)/,
    "Android Back must close the settings window, then cancel the active renderer modal",
  );

  const modalHolderRule = cssSrc.match(
    /body\[data-platform=["']android["']\]\s+#modal-holder\s*\{([^}]*)\}/s,
  )?.[1] ?? "";
  assert.match(modalHolderRule, /inset\s*:\s*0\b/, "the modal scrim must cover and block the full web shell");
  assert.equal(
    (cssSrc.match(/body\[data-platform=["']android["']\]\s+#modal-holder\s*\{/g) ?? []).length,
    1,
    "responsive rules must not uncover the topbar while an Android modal is active",
  );
});

test("an open drawer can always be closed, and a booted renderer always learns the shell state", () => {
  const activitySrc = fs.readFileSync(
    path.join(import.meta.dirname, "..", "android", "app", "src", "main", "java", "sh", "omp", "remote", "MainActivity.kt"),
    "utf8",
  );
  const webBridgeSrc = fs.readFileSync(
    path.join(import.meta.dirname, "..", "android", "app", "src", "main", "java", "sh", "omp", "remote", "web", "OmpWebBridge.kt"),
    "utf8",
  );
  const strings = fs.readFileSync(
    path.join(import.meta.dirname, "..", "android", "app", "src", "main", "res", "values", "strings.xml"),
    "utf8",
  );
  const russian = fs.readFileSync(
    path.join(import.meta.dirname, "..", "android", "app", "src", "main", "res", "values-ru", "strings.xml"),
    "utf8",
  );

  // gesturesEnabled = false also disables Material's tap-the-scrim close, so the
  // drawer needs two deliberate ways out or it is a one-way door.
  assert.match(
    activitySrc,
    /IconButton\(onClick = \{ scope\.launch \{ drawer\.close\(\) \} \}\) \{\s*Icon\(Icons\.Default\.Close, stringResource\(R\.string\.close_sessions_menu\)\)/s,
    "the drawer header must carry a close button",
  );
  assert.match(
    activitySrc,
    /BackHandler\(enabled = drawer\.isOpen\) \{\s*scope\.launch \{ drawer\.close\(\) \}/s,
    "Android Back must close an open drawer",
  );

  // The shell state is posted per change, so a renderer that boots after the last
  // change would keep the placeholder header android.html ships with.
  assert.match(
    activitySrc,
    /LaunchedEffect\(webBridge, rendererEpoch, selectedTitle, connectionLabel, connectionState\)/,
    "the shell state must be re-posted for every renderer generation",
  );
  assert.match(
    activitySrc,
    /message\.type == "ui\.ready" -> \{\s*rendererEpoch\+\+/s,
    "a renderer announcing itself must bump the shell-state epoch",
  );
  assert.match(
    activitySrc.slice(activitySrc.indexOf('message.type == "ui.ready"')),
    /RemoteSessionService\.postRendererMessage\(message\.body\.toString\(\)\)/,
    "ui.ready must still reach the desktop so it resyncs",
  );

  // Dropping the whole queue and then refusing every later message is what stranded
  // the header: one busy sync could silence the bridge for the rest of the session.
  assert.match(
    webBridgeSrc,
    /while \(pendingMessages\.size >= MAX_PENDING_MESSAGES\) \{\s*pendingMessages\.removeFirst\(\)/s,
    "the bootstrap queue must drop its oldest entry, not all of them",
  );
  assert.doesNotMatch(
    webBridgeSrc,
    /if \(!pendingOverflowed\) pendingMessages\.addLast\(message\)/,
    "an overflow must never stop the queue from accepting newer messages",
  );

  // A single-chat grant cannot grow new rows; saying so beats looking broken.
  assert.match(activitySrc, /serviceState\.allSessionsGranted/);
  assert.match(activitySrc, /R\.string\.single_session_grant_hint/);
  for (const key of ["close_sessions_menu", "single_session_grant_hint"]) {
    assert.match(strings, new RegExp(`name="${key}"`), `${key} must exist in the default bundle`);
    assert.match(russian, new RegExp(`name="${key}"`), `${key} must be translated`);
  }
});

test("composer attachment contract holds across host, script and stylesheet", () => {
  const hostSrc = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "ompSession.ts"), "utf8");
  const cssSrc = fs.readFileSync(path.join(mediaDir, "main.css"), "utf8");

  // Every element main.mjs looks up must exist in the host-rendered HTML,
  // otherwise the handlers attach to null and the composer dies on load.
  for (const id of ["btn-attach", "attachments", "drop-overlay"]) {
    assert.ok(hostSrc.includes(`id="${id}"`), `getHtml must render #${id}`);
    assert.ok(mainSrc.includes(`getElementById("${id}")`), `main.mjs must bind #${id}`);
  }

  // The three ways in: button, clipboard, drag & drop.
  assert.match(mainSrc, /post\(\{\s*t:\s*["']pickFiles["']/, "attach button must ask the host for a file picker");
  assert.match(mainSrc, /addEventListener\("paste"/, "Ctrl/Cmd+V must be handled");
  assert.match(mainSrc, /addEventListener\("drop"/, "drops must be handled");
  assert.match(mainSrc, /application\/vnd\.code\.uri-list/, "VS Code drags arrive as a uri-list");

  // Host halves of the same contract.
  for (const bridgeCase of ["pickFiles", "attachPaths", "attachData"]) {
    assert.ok(hostSrc.includes(`case "${bridgeCase}"`), `host must handle the ${bridgeCase} message`);
  }
  assert.match(mainSrc, /case "attached"/, "main.mjs must consume the host's attached reply");
  assert.match(hostSrc, /composePrompt\(text, attachments\)/, "prompts must carry their attachments");

  assert.match(cssSrc, /\.att-chip\b/, "attachment chips need styling");
  assert.match(cssSrc, /#drop-overlay\b/, "the drop overlay needs styling");
});

test("removing a remote attachment asks the host to erase its staged plaintext", () => {
  assert.match(mainSrc, /post\(\{ t: "cancelAttachment", attachmentId: remoteAttachmentId \}\)/);
  assert.match(mainSrc, /attachmentId: f\.attachmentId/);
  assert.match(mainSrc, /att\.path\.indexOf\("remote:"\) === 0/);
});

test("Android result messages are rendered or handed to a native share action", () => {
  for (const message of ["remoteCapabilities", "diffContent", "exportReady", "diagnosticsResult"]) {
    assert.match(mainSrc, new RegExp(`case ["']${message}["']`), `${message} must have a renderer handler`);
  }
  assert.match(mainSrc, /type: "local\.share"/);
  assert.match(mainSrc, /showRemoteTextResult/);
  assert.match(mainSrc, /remoteCapabilityVerbs\.has\(required\)/);
  assert.match(mainSrc, /addCapabilityMenuItem/);
  for (const message of ["commandResultBegin", "commandResultChunk", "commandResultCommit"]) {
    assert.match(mainSrc, new RegExp(`case ["']${message}["']`), `${message} must have a bounded renderer handler`);
  }
  assert.match(mainSrc, /MAX_SYNC_FRAGMENT_BYTES = 2 \* 1024 \* 1024/);
  assert.match(mainSrc, /MAX_SYNC_FRAGMENT_COUNT = 32/);
  assert.match(mainSrc, /MAX_ACTIVE_FRAGMENT_STREAMS = 4/);
  assert.match(mainSrc, /window\.crypto\.subtle\.digest\("SHA-256", bytes\)/);
  assert.match(mainSrc, /applyRemoteCommandResult\(state\.uiKind, state\.uiToken, value\)/);
  assert.match(
    mainSrc,
    /if \(post\(\{ t: "prompt", text: text, attachments: files,[^\n]+\) === false\) return;/,
    "a denied remote prompt must preserve the draft and attachments before optimistic UI mutation",
  );
});

test("palette is settings-driven and every preset is defined", () => {
  const hostSrc = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "ompSession.ts"), "utf8");
  const cssSrc = fs.readFileSync(path.join(mediaDir, "main.css"), "utf8");
  const pkg = JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8"),
  ) as { contributes: { configuration: { properties: Record<string, { enum?: string[]; default?: unknown }> } } };

  const themes = pkg.contributes.configuration.properties["ompcode.theme"];
  assert.ok(themes?.enum?.length, "ompcode.theme must enumerate its palettes");
  assert.equal(themes.default, "violet");

  for (const theme of themes.enum!) {
    // The default palette lives in :root; the rest are body[data-theme=…].
    const defined = theme === themes.default || cssSrc.includes(`body[data-theme="${theme}"]`);
    assert.ok(defined, `main.css must define the ${theme} palette`);
    assert.ok(mainSrc.includes(`"${theme}"`), `main.mjs must accept the ${theme} palette`);
  }

  assert.match(hostSrc, /<body data-theme="\$\{theme\}">/, "getHtml must stamp the palette onto <body>");
  assert.match(mainSrc, /setProperty\("--accent"/, "a custom accentColor must be applied through the CSSOM");
  assert.match(hostSrc, /case "theme"|pushTheme/, "the host must be able to push a live palette change");
});

test("revert button posts rejectEdit and the host answers editRejected", () => {
  const hostSrc = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "ompSession.ts"), "utf8");
  const cssSrc = fs.readFileSync(path.join(mediaDir, "main.css"), "utf8");
  assert.match(mainSrc, /return \{\s*t:\s*["']rejectEdit["']/, "the revert button must classify as rejectEdit");
  assert.ok(hostSrc.includes(`case "rejectEdit"`), "host must handle rejectEdit");
  assert.match(hostSrc, /t:\s*["']editRejected["']/, "host must confirm with editRejected");
  assert.match(mainSrc, /case ["']editRejected["']/, "main.mjs must consume editRejected");
  assert.match(cssSrc, /\.tool-revert\b/, "the revert button needs styling");
});

test("a revert click executes rejectEdit, not the shared diff action", () => {
  type Button = { getAttribute(name: string): string | null };
  type Target = { closest(selector: string): Button | null };
  const classify = loadFunction<(target: Target) => Record<string, unknown> | null>(
    mainSrc,
    "toolButtonMessage",
  );
  const button: Button = { getAttribute: (name) => name === "data-id" ? "tool-7" : null };
  const selectors: string[] = [];
  const bothClasses: Target = {
    closest(selector) {
      selectors.push(selector);
      return selector === ".tool-revert" || selector === ".tool-diff" ? button : null;
    },
  };

  assert.deepEqual(classify(bothClasses), { t: "rejectEdit", toolCallId: "tool-7" });
  assert.deepEqual(selectors, [".tool-revert"], "the diff selector must not capture revert");
  assert.deepEqual(
    classify({ closest: (selector) => selector === ".tool-diff" ? button : null }),
    { t: "openDiff", toolCallId: "tool-7" },
  );
});

test("one-shot routing survives the host/webview split", () => {
  const hostSrc = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "ompSession.ts"), "utf8");
  assert.ok(hostSrc.includes(`id="route-chip"`), "getHtml must render the route chip");
  assert.match(mainSrc, /getElementById\("route-chip"\)/, "main.mjs must bind the route chip");
  assert.match(mainSrc, /forModel/, "sendPrompt must carry the routed model");
  assert.match(hostSrc, /forModel/, "host must read the routed model off the prompt");
  assert.match(hostSrc, /await routed\.done/, "the routed operation must stay queued through agent_end");
  assert.match(hostSrc, /queueModelOperation/, "prompts and model mutations need a per-session queue");
  assert.match(
    hostSrc,
    /case "setModel":[\s\S]*?queueModelOperation[\s\S]*?type: "set_model"/,
    "manual model changes must queue behind routed restoration",
  );
  assert.match(
    hostSrc,
    /!forModel\.provider\.trim\(\)\s*\|\|\s*!forModel\.modelId\.trim\(\)/,
    "both routed model fields must be validated",
  );
});

test("initialize restores baseline lifecycle state before releasing prompts", () => {
  const hostSrc = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "ompSession.ts"), "utf8");
  const start = hostSrc.indexOf("private async initialize(");
  const end = hostSrc.indexOf("// ---------------------------------------------------------- webview bridge", start);
  const initializeSrc = hostSrc.slice(start, end);
  for (const required of [
    "this.callbacks.onState?.(state)",
    "this.initialized = true",
    "this.autoRestartAttempts = 0",
  ]) {
    assert.ok(initializeSrc.includes(required), `initialize must contain ${required}`);
    assert.ok(
      initializeSrc.indexOf(required) < initializeSrc.indexOf("this.initResolve?.()"),
      `${required} must happen before initDone resolves`,
    );
  }
});

test("process exit and spawn errors clear board-visible live state", () => {
  const hostSrc = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "ompSession.ts"), "utf8");
  const exitStart = hostSrc.indexOf("proc.onExit(");
  const errorStart = hostSrc.indexOf("proc.onError(", exitStart);
  const exitSrc = hostSrc.slice(exitStart, errorStart);
  const errorSrc = hostSrc.slice(errorStart, hostSrc.indexOf("// Spawn-tier profile settings", errorStart));
  for (const [label, block] of [["exit", exitSrc], ["error", errorSrc]] as const) {
    assert.ok(block.includes("this.streaming = false"), `${label} must clear streaming`);
    assert.ok(block.includes("this.uiPendingIds.clear()"), `${label} must clear pending approvals`);
    assert.ok(block.includes("this.abandonRoutedTurn()"), `${label} must release routed state`);
    assert.ok(block.includes("OmpSession.notifyBoard()"), `${label} must refresh the board`);
  }
});

test("edit snapshots distinguish ENOENT and survive blocked/error reverts", () => {
  const hostSrc = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "ompSession.ts"), "utf8");
  const snapshotStart = hostSrc.indexOf("private async snapshotTool(");
  const finishStart = hostSrc.indexOf("private async finishToolSnapshot(", snapshotStart);
  const diagnosticsStart = hostSrc.indexOf("/** Report diagnostics", finishStart);
  const revertStart = hostSrc.indexOf("private async revertEdit(", diagnosticsStart);
  const routeStart = hostSrc.indexOf("private queueModelOperation", revertStart);
  const snapshotSrc = hostSrc.slice(snapshotStart, finishStart);
  const finishSrc = hostSrc.slice(finishStart, diagnosticsStart);
  const revertSrc = hostSrc.slice(revertStart, routeStart);

  assert.match(snapshotSrc, /if \(!isEnoent\(err\)\)[\s\S]*?return;/, "non-ENOENT reads must not mean missing");
  assert.match(snapshotSrc, /existedBefore = false/, "ENOENT must mark a newly-created path");
  assert.match(finishSrc, /snap\.afterHash = revertStateHash\(current\)/, "tool end must hash final state");
  assert.doesNotMatch(finishSrc, /diffSnaps\.delete/, "tool errors must retain their snapshot");
  assert.match(revertSrc, /if \(plan\.action === "blocked"\)[\s\S]*?return false;/, "blocked revert must return early");
  assert.ok(
    revertSrc.indexOf("this.diffSnaps.delete(toolCallId)") > revertSrc.indexOf("if (plan.action === \"blocked\")"),
    "only successful/no-op reverts may consume the snapshot",
  );
});

test("the session board view is contributed and its commands resolve", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8"),
  ) as {
    contributes: {
      views: Record<string, Array<{ id: string }>>;
      commands: Array<{ command: string }>;
      menus: { "view/item/context"?: Array<{ command: string }> };
    };
  };
  const views = pkg.contributes.views["ompcode"] ?? [];
  assert.ok(views.some((v) => v.id === "ompcode.sessions"), "the board view must be contributed");
  const commands = new Set(pkg.contributes.commands.map((c) => c.command));
  for (const cmd of ["ompcode.sessionReveal", "ompcode.sessionAbort", "ompcode.sessionClose"]) {
    assert.ok(commands.has(cmd), `${cmd} must be a contributed command`);
  }
  const itemMenus = pkg.contributes.menus["view/item/context"] ?? [];
  assert.ok(
    itemMenus.some((m) => m.command === "ompcode.sessionClose"),
    "closable rows need the inline close action",
  );
  const extensionSrc = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "extension.ts"), "utf8");
  assert.match(
    extensionSrc,
    /sessionCommandId\(arg\?: SessionInfo \| string\)/,
    "tree actions must accept both native row objects and explicit ids",
  );
});

test("Android transcript hydration stays below the WebMessage limit", () => {
  const mainSrc = fs.readFileSync(path.join(import.meta.dirname, "..", "media", "main.mjs"), "utf8");
  for (const messageType of [
    "transcriptReset",
    "transcriptAppend",
    "transcriptMessageBegin",
    "transcriptMessageChunk",
    "transcriptMessageCommit",
    "syncSection",
    "syncSectionBegin",
    "syncSectionChunk",
    "syncSectionCommit",
  ]) {
    assert.ok(mainSrc.includes(`case "${messageType}"`), `renderer must handle ${messageType}`);
  }
  assert.match(mainSrc, /MAX_SYNC_FRAGMENT_BYTES = 2 \* 1024 \* 1024/, "reassembly must be bounded");
  assert.match(mainSrc, /m\.fragmentIndex !== state\.next/, "fragments must be strictly ordered");
  assert.match(mainSrc, /subtle\.digest\("SHA-256", bytes\)/, "fragment content must be authenticated");
  assert.match(mainSrc, /TextDecoder\("utf-8", \{ fatal: true \}\)/, "fragment JSON must be strict UTF-8");
  assert.match(mainSrc, /syncApplyQueue = syncApplyQueue\.then\(action\)/, "async fragment verification must preserve render order");
});

test("a mirrored approval winner removes queued and active modals", () => {
  assert.match(mainSrc, /function dropApprovalModal\(requestId\)/);
  assert.match(mainSrc, /modalQueue = modalQueue\.filter\(function \(q\) \{ return String\(q\.id\) !== requestId; \}\)/);
  assert.match(mainSrc, /case "approvalResolved":\s*dropApprovalModal\(m\.requestId\)/);
});

/**
 * `/remote` is answered by the panel, not by the agent. Two halves have to agree:
 * the renderer names a VS Code command, and the host will only execute names on
 * its allowlist. A command in one list and not the other fails silently — the
 * popup offers it, Enter does nothing — so the contract is asserted here.
 */
test("every panel slash command is on the host allowlist", () => {
  const sessionSrc = fs.readFileSync(
    path.join(import.meta.dirname, "..", "src", "ompSession.ts"),
    "utf8",
  );
  const allowlist = sessionSrc.slice(
    sessionSrc.indexOf("PANEL_SLASH_COMMANDS"),
    sessionSrc.indexOf("]);", sessionSrc.indexOf("PANEL_SLASH_COMMANDS")),
  );
  const registry = mainSrc.slice(
    mainSrc.indexOf("var localCommands ="),
    mainSrc.indexOf("function localCommandNamed"),
  );
  const declared = [...registry.matchAll(/run:\s*"([^"]+)"/g)].map((m) => m[1]);

  assert.ok(declared.includes("ompcode.remoteStart"), "/remote must reach remoteStart");
  for (const command of declared) {
    assert.ok(
      allowlist.includes(`"${command}"`),
      `${command} is offered by the composer but the host would drop it`,
    );
  }
});

test("panel slash commands never reach the agent as a prompt", () => {
  // The popup is one route; typing the whole command and hitting Enter is the
  // other. Both have to end in runLocalCommand, or /remote is sent to the model
  // as text it cannot act on.
  assert.match(mainSrc, /if \(c\.run\) \{ runLocalCommand\(c\); return; \}/);
  assert.match(mainSrc, /if \(typedLocal && files\.length === 0\) \{ runLocalCommand\(typedLocal\); return; \}/);
  const send = mainSrc.slice(mainSrc.indexOf("function sendPrompt()"));
  assert.ok(
    send.indexOf("runLocalCommand(typedLocal)") < send.indexOf('post({ t: "prompt"'),
    "the local-command check must run before the prompt is posted",
  );
});

test("a phone is never offered the command that mints a pairing", () => {
  // remoteStart rotates the room key and issues a fresh one-time pairing secret.
  // Offering it inside the Android renderer would let a paired phone ask the
  // desktop for another pairing, which is an escalation, not a convenience.
  assert.match(mainSrc, /var localCommands = hostPort\.kind === "android" \? \[\] :/);
});

/**
 * The settings screen and the `/remote` popup are two doors onto the same
 * commands. They read one registry so a command cannot appear behind one door
 * and not the other, and the screen must not clear a half-typed prompt on its way.
 */
test("the settings screen offers the panel commands from the same registry", () => {
  const screen = mainSrc.slice(
    mainSrc.indexOf("function buildSettingsBody("),
    mainSrc.indexOf("function refreshSettingsBody("),
  );
  assert.match(screen, /if \(localCommands\.length\) \{/, "the screen must read the shared registry");
  assert.match(screen, /settingsGroup\(body, t\("Remote Control"\)\)/);
  assert.match(screen, /postLocalCommand\(command\)/, "the screen route must not touch the composer");
  assert.ok(
    !/runLocalCommand\(command\)/.test(screen),
    "runLocalCommand clears the prompt draft and belongs to the composer route only",
  );

  const registry = mainSrc.slice(
    mainSrc.indexOf("var localCommands ="),
    mainSrc.indexOf("function postLocalCommand"),
  );
  const labels = [...registry.matchAll(/menuLabel:\s*t\("([^"]+)"\)/g)].map((m) => m[1]);
  const runs = [...registry.matchAll(/run:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.equal(labels.length, runs.length, "every panel command needs a menu label");
  assert.ok(labels.length >= 4, `expected start, refresh, status and stop, saw ${labels.length}`);
  assert.ok(runs.includes("ompcode.remoteRefreshPairing"), "a stale QR must be refreshable from the same registry");
});

test("the registry is declared before the screen that reads it", () => {
  assert.ok(
    mainSrc.indexOf("var localCommands =") < mainSrc.indexOf("function buildSettingsBody("),
    "hoisting makes this work either way, but reading it should not require knowing that",
  );
});

/**
 * The gear used to hold accounts, keys, models, Remote Control, five session
 * actions and diagnostics in one dropdown. It opens a window now, and the window
 * has to behave like one: it owns the screen, it can always be left, and it must
 * never sit on top of an approval the agent is waiting for.
 */
test("the gear opens a settings window that cannot trap the user or bury a modal", () => {
  const cssSrc = fs.readFileSync(path.join(mediaDir, "main.css"), "utf8");

  assert.match(mainSrc, /btnSettings\.addEventListener\("click", openSettings\)/, "the gear must open the window, not a menu");
  assert.ok(!/openMenu\(btnSettings/.test(mainSrc), "the old gear dropdown must be gone, not merely unused");

  // Three ways out, because the phone has no Escape key and the desktop has no Back.
  assert.match(mainSrc, /close\.addEventListener\("click", closeSettings\)/, "the header needs a close button");
  assert.match(mainSrc, /if \(event\.key === "Escape"\)[\s\S]{0,80}closeSettings\(\)/, "Escape must close the window");
  assert.match(
    mainSrc,
    /case "androidBack":\s*if \(settingsScreen\) closeSettings\(\)/,
    "Android Back must close the window before anything else",
  );

  // The window sits above the modal layer, so an approval arriving underneath it
  // would be invisible while still blocking the agent.
  assert.match(
    mainSrc,
    /function pumpModals\(\) \{[\s\S]{0,320}closeSettings\(\);\s*showModal\(/,
    "a queued modal must reclaim the screen",
  );
  assert.match(mainSrc, /notifyAndroidModalState\(Boolean\(activeModal\)\)/, "closing must not free a screen a modal still owns");

  // Capability gating survived the move out of the menu.
  assert.match(mainSrc, /if \(capability && !hasRemoteCapability\(capability\)\) return null;/);
  for (const verb of ["credentials.manage", "session.manage", "view", "prompt"]) {
    assert.ok(mainSrc.includes(`settingsRow(`), "rows must be built through the gated helper");
    assert.ok(mainSrc.includes(`"${verb}"`), `the ${verb} gate must still be applied`);
  }

  const screenRule = cssSrc.match(/\.settings-screen \{([^}]*)\}/)?.[1] ?? "";
  assert.match(screenRule, /position\s*:\s*fixed\b/, "the settings window must cover its host surface");
  assert.match(screenRule, /inset\s*:\s*0\b/);
  const androidAction = cssSrc.match(/body\[data-platform="android"\] \.settings-action \{([^}]*)\}/s)?.[1] ?? "";
  assert.match(androidAction, /min-height\s*:\s*48px\b/, "phone targets stay at the 48dp floor");
  const androidClose = cssSrc.match(/body\[data-platform="android"\] \.settings-close \{([^}]*)\}/s)?.[1] ?? "";
  assert.match(androidClose, /height\s*:\s*48px\b/);
});

/**
 * "Adding a provider = one row in providers.ts plus one contributes.commands
 * entry" is the rule the file states. An uncontributed command still registers
 * without error — it simply never appears in the palette, which is the kind of
 * miss nobody notices until someone goes looking for it.
 */
test("every keyed provider has a palette command and a title in both bundles", () => {
  const providersSrc = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "providers.ts"), "utf8");
  const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8")) as {
    contributes: { commands: { command: string; title: string }[] };
  };
  const english = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "package.nls.json"), "utf8")) as Record<string, string>;
  const russian = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "package.nls.ru.json"), "utf8")) as Record<string, string>;

  // Scoped to the keyed table: LOGIN_PROVIDERS lives in the same file and shares
  // ids with it on purpose — "anthropic" is both a key and a sign-in.
  const keyedTable = providersSrc.slice(
    providersSrc.indexOf("export const KEYED_PROVIDERS"),
    providersSrc.indexOf("export interface LoginProvider"),
  );
  assert.ok(keyedTable, "the keyed-provider table must remain inspectable");
  const keyed = [...keyedTable.matchAll(/commandId:\s*"([^"]+)"/g)].map((match) => match[1]);
  assert.ok(keyed.length >= 5, `expected the keyed-provider table, saw ${keyed.length}`);
  assert.ok(keyed.includes("ompcode.setOpenAiKey"), "the OpenAI key must be settable");

  for (const commandId of keyed) {
    const contributed = pkg.contributes.commands.find((entry) => entry.command === commandId);
    assert.ok(contributed, `${commandId} must be contributed, or it never reaches the palette`);
    const key = contributed.title.replace(/^%|%$/g, "");
    assert.ok(english[key], `${commandId} needs an English title`);
    assert.ok(russian[key], `${commandId} needs a Russian title`);
  }

  // Env var and secret are what the agent process actually receives; a duplicate
  // in either column would have one provider quietly overwriting another.
  for (const field of ["envVar", "secret", "id"]) {
    const values = [...keyedTable.matchAll(new RegExp(`${field}:\\s*"([^"]+)"`, "g"))].map((match) => match[1]);
    assert.equal(new Set(values).size, values.length, `keyed providers must not share a ${field}`);
  }
});

/**
 * Four sign-ins are offered; omp knows dozens. The registry decides which four,
 * which of them a phone may start, and the host refuses everything else.
 */
test("every sign-in the settings window offers is one the host will actually start", () => {
  const providersSrc = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "providers.ts"), "utf8");
  const hostSrc = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "ompSession.ts"), "utf8");
  const protocolSrc = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "remoteProtocol.ts"), "utf8");

  const entries = [...providersSrc.matchAll(
    /\{\s*id:\s*"([^"]+)",\s*label:\s*"([^"]+)",\s*hint:\s*"([^"]+)",\s*remote:\s*(true|false),\s*\}/g,
  )].map((match) => ({ id: match[1], label: match[2], hint: match[3], remote: match[4] === "true" }));
  assert.ok(entries.length >= 4, `expected the login registry, saw ${entries.length} entries`);
  assert.ok(entries.some((entry) => entry.id === "zai-coding-plan"), "GLM must be offered");
  assert.ok(entries.some((entry) => entry.id === "qwen-portal"), "Qwen must be offered");

  const screen = mainSrc.slice(
    mainSrc.indexOf("function buildSettingsBody("),
    mainSrc.indexOf("function refreshSettingsBody("),
  );
  // Desktop-only rows live inside the one platform gate in this function.
  const gateStart = screen.indexOf('if (hostPort.kind !== "android") {');
  assert.ok(gateStart > 0, "the desktop-only sign-ins need a platform gate");
  const gated = screen.slice(gateStart);

  for (const entry of entries) {
    assert.ok(screen.includes(`providerId: "${entry.id}"`), `${entry.id} must have a settings row`);
    assert.ok(screen.includes(`t("${entry.label}")`), `${entry.id} must use its registry label`);
    assert.ok(screen.includes(`t("${entry.hint}")`), `${entry.id} must say what signing in gets you`);
    // A row a phone cannot finish is worse than no row: the flow needs a browser
    // on the machine running the agent, and the host refuses it remotely anyway.
    assert.equal(
      gated.includes(`providerId: "${entry.id}"`),
      !entry.remote,
      `${entry.id} must be ${entry.remote ? "offered on both" : "desktop-only"}`,
    );
  }

  assert.match(
    hostSrc,
    /LOGIN_PROVIDERS\.some\(\(entry\) => entry\.id === providerId\)/,
    "the host must refuse a provider the UI never offered",
  );
  assert.match(
    protocolSrc,
    /entry\.id === providerId && entry\.remote/,
    "the phone may only start the flows marked remote",
  );
});

/**
 * The grant picker exists so the scope is an explicit choice. A button whose own
 * label names the scope is that same choice, one step shorter — but it must be
 * the scope it claims, and never the one that hands over credential access.
 */
test("a phone can be paired to every open project in one press", () => {
  const extensionSrc = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "extension.ts"), "utf8");
  const hostSrc = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "ompSession.ts"), "utf8");
  const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8")) as {
    contributes: { commands: { command: string }[] };
  };

  const command = extensionSrc.slice(
    extensionSrc.indexOf('registerCommand("ompcode.remoteStartAllSessions"'),
    extensionSrc.indexOf('registerCommand("ompcode.remoteOpen"'),
  );
  assert.ok(command, "the all-sessions command must exist");
  assert.match(command, /remoteControl\.start\(origin, "all"\)/, "it must grant exactly the all-sessions scope");
  assert.ok(!command.includes("all-with-credentials"), "a one-press pairing must never hand over API keys");
  assert.ok(!command.includes("showQuickPick"), "the label is the choice; a second picker would be noise");

  const registry = mainSrc.slice(
    mainSrc.indexOf("var localCommands ="),
    mainSrc.indexOf("function postLocalCommand"),
  );
  assert.ok(registry.includes('run: "ompcode.remoteStartAllSessions"'), "the settings window must offer it");
  assert.match(registry, /menuLabel: t\("Connect a phone — all sessions"\)/, "the button must name the scope it grants");
  assert.match(hostSrc, /"ompcode\.remoteStartAllSessions"/, "the panel allowlist must admit it");
  assert.ok(
    pkg.contributes.commands.some((entry) => entry.command === "ompcode.remoteStartAllSessions"),
    "the command palette must reach it too",
  );
});

/**
 * A pairing QR lives ten minutes. Losing that window used to mean walking back
 * through the grant prompt; refreshing re-mints inside the room that already has
 * the consent, and must never quietly widen it.
 */
test("a stale pairing QR can be refreshed without re-deciding the grant", () => {
  const serviceSrc = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "remoteControlService.ts"), "utf8");
  const extensionSrc = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "extension.ts"), "utf8");
  const hostSrc = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "ompSession.ts"), "utf8");
  const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "package.json"), "utf8")) as {
    contributes: { commands: { command: string }[] };
  };

  const refresh = serviceSrc.slice(
    serviceSrc.indexOf("async refreshPairing("),
    serviceSrc.indexOf("hasPairedDevice()"),
  );
  assert.ok(refresh, "refreshPairing must exist");
  assert.match(refresh, /randomPairingKey\(\)/, "a refresh mints a new one-time secret");
  assert.match(refresh, /delete secrets\.pending;/, "an enrolment sealed under the old key can never complete");
  assert.match(refresh, /roomId: secrets\.roomId/, "the room stays the room the grant was given for");
  assert.match(refresh, /keyEpoch: secrets\.keyEpoch/, "a refresh is not a key rotation");
  for (const widened of ["scope", "verbs", "workspaceRoots", "rotateRemoteSecrets"]) {
    assert.ok(!refresh.includes(widened), `a refresh must not touch ${widened}`);
  }

  // Re-minting while a phone is enrolled hands the room to whoever scans next.
  assert.match(extensionSrc, /hasPairedDevice\(\)[\s\S]{0,400}showWarningMessage/, "replacing a paired phone must be confirmed");
  assert.match(extensionSrc, /\{ modal: true \}/);

  assert.ok(
    pkg.contributes.commands.some((entry) => entry.command === "ompcode.remoteRefreshPairing"),
    "the refresh must be reachable from the command palette too",
  );
  assert.match(hostSrc, /"ompcode\.remoteRefreshPairing"/, "the panel allowlist must admit the refresh");

  // A code that has quietly gone stale looks exactly like one that still works.
  assert.match(serviceSrc, /This code stops working at \{0\}\./);
  assert.match(serviceSrc, /command:ompcode\.remoteRefreshPairing/);
  assert.match(serviceSrc, /The pairing code has expired\./);
});

test("setWorking switches the send button into steer mode instead of hiding it", () => {
  assert.match(
    mainSrc,
    /btnSend\.classList\.toggle\("steer", working\)/,
    "send must gain the steer class while a turn runs",
  );
  assert.doesNotMatch(
    mainSrc,
    /btnSend\.classList\.toggle\("hidden", working\)/,
    "hiding send makes steer unreachable on Android, where Enter is a newline",
  );
});

test("a failed steer leaves the running turn on screen", () => {
  assert.match(
    mainSrc,
    /case "promptFailed":[\s\S]{0,200}if \(!m\.steer\) setWorking\(false\)/,
    "only a failed first prompt may clear the working line",
  );
  assert.match(
    mainSrc,
    /case "promptFailed":[\s\S]{0,400}pendingLocalUser--/,
    "a rejected prompt must release the echo it reserved",
  );
  assert.match(
    mainSrc,
    /case "promptFailed":[\s\S]{0,600}input\.value = lastSentText/,
    "a rejected prompt must give the typing back",
  );
});

test("a prompt sent mid-turn is rendered as a steer and still reserves its echo", () => {
  assert.match(
    mainSrc,
    /pendingLocalUser\+\+;\n\s*addUserBubble\(text, files, \{ steer: working \}\);/,
    "omp replays a steer as a normal user message, so the echo guard must stay",
  );
});

test("the steer queue is read from omp, not counted locally", () => {
  assert.match(mainSrc, /queueEl\.textContent = t\("queued: \{0\}", queued\)/);
  assert.match(
    mainSrc,
    /workingEl\.appendChild\(queueEl\)/,
    "the indicator must live inside #working — resetView() removes every other child of #messages",
  );
});
