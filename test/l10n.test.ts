import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBundle, resolveLanguage, setBundle, t } from "../src/l10n.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Every translatable string is a `t("…")` call, so the source itself is the
 * key list. Scanning for them keeps the bundles honest: a string added
 * without a translation, or a translation left behind after its string was
 * deleted, both fail here rather than showing up in the UI.
 */
function sourceKeys(): string[] {
  const files = [
    ...fs.readdirSync(path.join(root, "src")).map((f) => path.join("src", f)),
    ...fs.readdirSync(path.join(root, "media")).map((f) => path.join("media", f)),
  ].filter(
    (f) => (f.endsWith(".ts") || f.endsWith(".mjs")) && !path.basename(f).startsWith("l10n."),
  );
  const call = /\bt\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/g;
  const keys: string[] = [];
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    for (const match of text.matchAll(call)) {
      const literal = match[1] ?? "";
      // Normalise a single-quoted literal into JSON so one parser handles both.
      const json = literal.startsWith("'")
        ? `"${literal.slice(1, -1).replace(/\\'/g, "'").replace(/"/g, '\\"')}"`
        : literal;
      const key = JSON.parse(json) as string;
      if (!keys.includes(key)) {
        keys.push(key);
      }
    }
  }
  return keys;
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\d+)\}/g)].map((m) => m[1] ?? "").sort();
}

const RU = JSON.parse(fs.readFileSync(path.join(root, "l10n", "ru.json"), "utf8")) as Record<
  string,
  string
>;

test("the scan finds the strings it is supposed to find", () => {
  const keys = sourceKeys();
  // A guard on the guard: a broken regex would silently pass every other
  // test in this file by finding nothing.
  assert.ok(keys.length > 150, `only ${keys.length} keys found — the scan is broken`);
  assert.ok(keys.includes("Working…"));
  assert.ok(keys.includes("What can I help you build?"), "webview skeleton strings missing");
  assert.ok(keys.includes("Restart Agent"), "host dialog strings missing");
  assert.ok(
    keys.includes('No custom providers configured. Add one under "ompcode.customProviders" first.'),
    "single-quoted literals missing",
  );
});

test("every string in the source has a Russian translation", () => {
  const missing = sourceKeys().filter((key) => !(key in RU));
  assert.deepEqual(missing, [], `untranslated: ${missing.join(" | ")}`);
});

test("the Russian bundle has no entries the source stopped using", () => {
  const keys = new Set(sourceKeys());
  const stale = Object.keys(RU).filter((key) => !keys.has(key));
  assert.deepEqual(stale, [], `stale: ${stale.join(" | ")}`);
});

test("translations keep the placeholders of their source string", () => {
  for (const [key, value] of Object.entries(RU)) {
    assert.deepEqual(
      placeholders(value),
      placeholders(key),
      `placeholder mismatch for ${JSON.stringify(key)}`,
    );
    assert.notEqual(value.trim(), "", `empty translation for ${JSON.stringify(key)}`);
  }
});

test("resolveLanguage prefers an explicit setting over the editor", () => {
  assert.equal(resolveLanguage("ru", "en-US"), "ru");
  assert.equal(resolveLanguage("en", "ru-RU"), "en");
});

test("auto follows the editor, matching on the primary subtag", () => {
  assert.equal(resolveLanguage("auto", "ru"), "ru");
  assert.equal(resolveLanguage("auto", "ru-RU"), "ru");
  assert.equal(resolveLanguage("auto", "en-GB"), "en");
  // A language with no bundle falls back rather than loading nothing.
  assert.equal(resolveLanguage("auto", "de"), "en");
  assert.equal(resolveLanguage("auto", ""), "en");
  assert.equal(resolveLanguage(undefined, "ru-RU"), "ru");
});

test("loadBundle reads the shipped Russian file and skips English", () => {
  assert.deepEqual(loadBundle(root, "en"), {});
  const ru = loadBundle(root, "ru");
  assert.equal(ru["Working…"], "Работаю…");
  assert.equal(Object.keys(ru).length, Object.keys(RU).length);
});

test("a missing bundle degrades to English instead of throwing", () => {
  assert.deepEqual(loadBundle(path.join(root, "no", "such", "dir"), "ru"), {});
});

test("t translates, substitutes, and falls back to the source text", () => {
  setBundle("ru", { "Working…": "Работаю…", "Retrying ({0}/{1})": "Повтор ({0}/{1})" });
  assert.equal(t("Working…"), "Работаю…");
  assert.equal(t("Retrying ({0}/{1})", 2, 5), "Повтор (2/5)");
  assert.equal(t("Not in the bundle {0}", "x"), "Not in the bundle x");
  // An index with no argument stays visible rather than blanking the text.
  assert.equal(t("Retrying ({0}/{1})", 2), "Повтор (2/{1})");
  setBundle("en", {});
  assert.equal(t("Working…"), "Working…");
});

const MANIFEST = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as unknown;
const NLS_EN = JSON.parse(fs.readFileSync(path.join(root, "package.nls.json"), "utf8")) as Record<
  string,
  string
>;
const NLS_RU = JSON.parse(
  fs.readFileSync(path.join(root, "package.nls.ru.json"), "utf8"),
) as Record<string, string>;

/** Every `%key%` VS Code will try to resolve in the manifest. */
function manifestPlaceholders(): string[] {
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      const match = /^%(.+)%$/.exec(value);
      if (match?.[1]) {
        found.add(match[1]);
      }
    } else if (Array.isArray(value)) {
      value.forEach(walk);
    } else if (value && typeof value === "object") {
      Object.values(value).forEach(walk);
    }
  };
  walk(MANIFEST);
  return [...found];
}

test("every manifest placeholder resolves in both nls bundles", () => {
  const placeholderKeys = manifestPlaceholders();
  assert.ok(placeholderKeys.length > 30, `only ${placeholderKeys.length} %keys% found`);
  // An unresolved %key% renders literally in the command palette.
  assert.deepEqual(
    placeholderKeys.filter((key) => !(key in NLS_EN)),
    [],
  );
  assert.deepEqual(
    placeholderKeys.filter((key) => !(key in NLS_RU)),
    [],
  );
});

test("the nls bundles carry no keys the manifest stopped using", () => {
  const used = new Set(manifestPlaceholders());
  assert.deepEqual(Object.keys(NLS_EN).filter((key) => !used.has(key)), []);
  assert.deepEqual(Object.keys(NLS_RU).filter((key) => !used.has(key)), []);
});

test("the webview gets the bundle and the module that reads it", () => {
  const host = fs.readFileSync(path.join(root, "src", "ompSession.ts"), "utf8");
  const webview = fs.readFileSync(path.join(root, "media", "main.mjs"), "utf8");
  assert.match(host, /id="l10n-bundle"/, "getHtml must embed the bundle");
  assert.match(host, /currentBundle\(\)/, "the embedded bundle must be the active one");
  // A translation containing "</script>" would otherwise end the tag early.
  assert.match(host, /replace\(\/<\/g, "\\\\u003c"\)/, "the bundle must escape <");
  assert.match(webview, /from "\.\/l10n\.mjs"/, "main.mjs must import t()");
});

test("the translation function is never shadowed or read as an object", () => {
  // `t` is a one-letter import, which makes it easy to shadow by accident.
  // One such rename left `t.requiresEffort` pointing at the translation
  // function instead of the model's thinking descriptor, so `off` stayed on
  // offer for models where reasoning is mandatory — silently, because reading
  // a missing property is not an error.
  const property = /(?<![\w.$])t\.[A-Za-z_]/;
  const declaration = /\b(?:var|let|const)\s+t\b|function\s+t\s*\(/;
  const files = [
    ...fs.readdirSync(path.join(root, "src")).map((f) => path.join("src", f)),
    ...fs.readdirSync(path.join(root, "media")).map((f) => path.join("media", f)),
  ].filter((f) => f.endsWith(".ts") || f.endsWith(".mjs"));

  let scanned = 0;
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    if (!text.includes('from "./l10n')) {
      continue; // does not import t; a local `t` there is nobody's business
    }
    scanned++;
    text.split("\n").forEach((line, i) => {
      assert.ok(!property.test(line), `${file}:${i + 1} reads a property off t(): ${line.trim()}`);
      assert.ok(!declaration.test(line), `${file}:${i + 1} shadows t(): ${line.trim()}`);
    });
  }
  assert.ok(scanned >= 3, `only ${scanned} files import t() — the scan is looking in the wrong place`);
});
