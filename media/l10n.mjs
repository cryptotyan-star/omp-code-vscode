// Webview half of the translation layer. The host serialises the active
// bundle into a <script type="application/json"> tag when it builds the HTML,
// so the first render is already translated — nothing waits on a message.
//
// The English source text is the key here too; see src/l10n.ts for why the
// language comes from `ompcode.language` rather than vscode.l10n.

/** @type {Record<string, string>} */
let bundle = {};

try {
  const holder = document.getElementById("l10n-bundle");
  if (holder && holder.textContent) {
    const parsed = JSON.parse(holder.textContent);
    if (parsed && typeof parsed === "object") {
      bundle = parsed;
    }
  }
} catch {
  // An unreadable bundle means English, which is always correct enough.
}

/**
 * Translate `message`, substituting `{0}`, `{1}` … with the given arguments.
 * Unknown messages fall back to the English source text.
 *
 * @param {string} message
 * @param {...(string|number)} args
 * @returns {string}
 */
export function t(message, ...args) {
  const template = bundle[message] ?? message;
  if (args.length === 0) {
    return template;
  }
  return template.replace(/\{(\d+)\}/g, (whole, index) => {
    const value = args[Number(index)];
    return value === undefined ? whole : String(value);
  });
}

/** The active language tag, for `lang` attributes and date formatting. */
export const language = document.documentElement.lang || "en";

/**
 * Pick a plural form: the mock's `pl(n, one, few, many)` made language-aware.
 * Russian uses the one/few/many rule (2–4 vs 5+); every other language
 * collapses to one/few, so the `many` form is only ever read from a bundle.
 */
export function plural(count, one, few, many) {
  const n = Math.abs(Number(count) || 0);
  if (language === "ru") {
    const m = n % 10;
    const h = n % 100;
    return m === 1 && h !== 11 ? one : m >= 2 && m <= 4 && (h < 12 || h > 14) ? few : many;
  }
  return n === 1 ? one : few;
}
