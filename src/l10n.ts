import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Translation for everything this extension renders itself: host dialogs, the
 * webview skeleton, and the chat UI in `media/main.mjs`.
 *
 * The English source text is the key. A missing entry falls back to it, so an
 * untranslated string shows in English instead of a placeholder, and adding a
 * new one costs nothing until someone translates it.
 *
 * The language comes from `ompcode.language` rather than VS Code's display
 * language. `vscode.l10n` can only follow the editor's own UI language, which
 * requires the matching Language Pack and switches the whole editor — several
 * of this extension's users run an English VS Code and want a Russian chat.
 * `auto` still defers to the editor. Manifest strings (command titles,
 * setting descriptions) are the one exception: VS Code reads those from
 * `package.nls*.json` before the extension is loaded, so they follow the
 * display language and cannot honour this setting.
 */

export const LANGUAGE_SETTINGS = ["auto", "en", "ru"] as const;
export type LanguageSetting = (typeof LANGUAGE_SETTINGS)[number];

/** Languages an actual bundle exists for. */
export const LANGUAGES = ["en", "ru"] as const;
export type Language = (typeof LANGUAGES)[number];

export type Bundle = Record<string, string>;

let active: Bundle = {};
let activeLanguage: Language = "en";

/**
 * Turn the setting plus VS Code's display language into a bundle to load.
 * `auto` matches on the primary subtag, so `ru-RU` counts as Russian.
 */
export function resolveLanguage(setting: string | undefined, displayLanguage: string): Language {
  if (setting === "en" || setting === "ru") {
    return setting;
  }
  const primary = (displayLanguage || "en").toLowerCase().split(/[-_]/)[0];
  return (LANGUAGES as readonly string[]).includes(primary ?? "") ? (primary as Language) : "en";
}

/**
 * Read `l10n/<language>.json` from the extension directory. English is the
 * source text, so it needs no file. A missing or broken bundle degrades to
 * English rather than failing activation.
 */
export function loadBundle(extensionPath: string, language: Language): Bundle {
  if (language === "en") {
    return {};
  }
  try {
    const raw = fs.readFileSync(path.join(extensionPath, "l10n", `${language}.json`), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return {};
    }
    const out: Bundle = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") {
        out[key] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
}

/** Install the bundle that `t` and the webview will use. */
export function setBundle(language: Language, bundle: Bundle): void {
  activeLanguage = language;
  active = bundle;
}

/** The bundle currently installed — handed to the webview verbatim. */
export function currentBundle(): Bundle {
  return active;
}

export function currentLanguage(): Language {
  return activeLanguage;
}

/**
 * Translate `message`, substituting `{0}`, `{1}` … with the given arguments.
 * An index with no argument is left as written rather than blanked, so a
 * mistranslated placeholder is visible instead of silently eating text.
 */
export function t(message: string, ...args: Array<string | number>): string {
  const template = active[message] ?? message;
  if (args.length === 0) {
    return template;
  }
  return template.replace(/\{(\d+)\}/g, (whole, index: string) => {
    const value = args[Number(index)];
    return value === undefined ? whole : String(value);
  });
}
