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
