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
