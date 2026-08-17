/* OMP Code — markdown renderer (shared between webview and tests). ESM. */

const TOK = String.fromCharCode(1); // sentinel for protected inline tokens
const TOK_RE = new RegExp(TOK + "(\\d+)" + TOK, "g");

export function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderInline(raw) {
  const toks = [];
  let s = esc(raw);
  // protect inline code from further formatting
  s = s.replace(/`([^`\n]+)`/g, (_, c) => {
    toks.push("<code>" + c + "</code>");
    return TOK + (toks.length - 1) + TOK;
  });
  // links [text](url) — only http(s); clicks are delegated to openExternal.
  // URL is HTML-escaped by esc() above; also require no quotes/<> to block
  // attribute-breakout (defence-in-depth even though CSP blocks scripts).
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s<>"']+)\)/g, (m, t, u) => {
    if (!/^https?:\/\/\S+$/i.test(u)) return m;
    toks.push('<a href="#" data-href="' + u + '">' + t + "</a>");
    return TOK + (toks.length - 1) + TOK;
  });
  // strikethrough ~~text~~ (GFM)
  s = s.replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[\s(])\*([^*\s][^*\n]*)\*/g, "$1<em>$2</em>");
  s = s.replace(TOK_RE, (_, i) => toks[+i]);
  return s;
}

function tryTable(lines, start) {
  if (start + 1 >= lines.length) return null;
  const sep = lines[start + 1];
  if (!/^\s*\|.*\|\s*$/.test(sep)) return null;
  const sepCells = sep.split("|").slice(1, -1);
  if (!sepCells.length) return null;
  if (!sepCells.every((c) => /^\s*:?-{3,}:?\s*$/.test(c))) return null;
  const rows = [];
  let k = start + 2;
  while (k < lines.length && /^\s*\|.*\|\s*$/.test(lines[k])) {
    rows.push(lines[k]);
    k++;
  }
  if (!rows.length) return null;
  const headerCells = lines[start].split("|").slice(1, -1);
  let out = '<table class="gfm"><thead><tr>';
  headerCells.forEach((c) => { out += "<th>" + renderInline(c.trim()) + "</th>"; });
  out += "</tr></thead><tbody>";
  rows.forEach((r) => {
    const cols = r.split("|").slice(1, -1);
    out += "<tr>";
    cols.forEach((c) => { out += "<td>" + renderInline(c.trim()) + "</td>"; });
    out += "</tr>";
  });
  out += "</tbody></table>";
  return { html: out, consumed: k - start };
}

export function renderBlocks(text) {
  const lines = String(text).split("\n");
  const html = [];
  let para = [];
  let quote = [];
  let list = null; // { type: "ul"|"ol", items: [] }

  function flushPara() {
    if (para.length) { html.push("<p>" + para.map(renderInline).join("<br>") + "</p>"); para = []; }
  }
  function flushList() {
    if (list) {
      html.push("<" + list.type + ">" + list.items.map((i) => "<li>" + renderInline(i) + "</li>").join("") + "</" + list.type + ">");
      list = null;
    }
  }
  function flushQuote() {
    if (quote.length) { html.push("<blockquote>" + quote.map(renderInline).join("<br>") + "</blockquote>"); quote = []; }
  }
  function flushAll() { flushPara(); flushList(); flushQuote(); }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    if (!line.trim()) { flushAll(); continue; }

    // GFM table
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const t = tryTable(lines, i);
      if (t) { flushAll(); html.push(t.html); i += t.consumed - 1; continue; }
    }

    if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) {
      flushAll();
      const lvl = m[1].length;
      html.push("<h" + lvl + ">" + renderInline(m[2]) + "</h" + lvl + ">");
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { flushAll(); html.push("<hr>"); continue; }
    if ((m = /^>\s?(.*)$/.exec(line))) { flushPara(); flushList(); quote.push(m[1]); continue; }
    if ((m = /^\s*[-*+]\s+(.*)$/.exec(line))) {
      flushPara(); flushQuote();
      if (!list || list.type !== "ul") { flushList(); list = { type: "ul", items: [] }; }
      list.items.push(m[1]);
      continue;
    }
    if ((m = /^\s*\d+[.)]\s+(.*)$/.exec(line))) {
      flushPara(); flushQuote();
      if (!list || list.type !== "ol") { flushList(); list = { type: "ol", items: [] }; }
      list.items.push(m[1]);
      continue;
    }
    flushList(); flushQuote();
    para.push(line);
  }
  flushAll();
  return html.join("");
}
// Minimal syntax highlight: escape HTML, then wrap line comments and string
// literals in spans. Intentionally small — no tokenizer, no per-language rules.
function highlightCode(src) {
  const esc_ = esc(src);
  // Protect strings and comments with placeholders, then restore.
  const toks = [];
  let s = esc_;
  // full-line comments: // ... or # ... (only when # isn't a shebang on line 1)
  s = s.replace(/(^|\n)(\s*)(\/\/[^\n]*|#[^\n]*)/g, (m, pre, sp, c) => {
    toks.push('<span class="tok-comment">' + c + "</span>");
    return pre + sp + "\u0000" + (toks.length - 1) + "\u0000";
  });
  // block comments /* ... */ (single line only, multiline too greedy — keep simple)
  s = s.replace(/\/\*[\s\S]*?\*\//g, (m) => {
    toks.push('<span class="tok-comment">' + m + "</span>");
    return "\u0000" + (toks.length - 1) + "\u0000";
  });
  // strings: "..." '...' `...`
  s = s.replace(/("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g, (m) => {
    toks.push('<span class="tok-string">' + m + "</span>");
    return "\u0000" + (toks.length - 1) + "\u0000";
  });
  // numbers
  s = s.replace(/\b(\d[\d_.eE]*)\b/g, '<span class="tok-number">$1</span>');
  // restore placeholders
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => toks[+i]);
  return s;
}

// Memoize the (relatively expensive) markdown→HTML render keyed on the
// exact source string. During streaming, message_update resends the full
// text each tick; the cached entry for an unchanged prefix is a direct hit.
const MD_CACHE_MAX = 64;
const mdCache = new Map();
export function renderMarkdown(src) {
  const key = String(src == null ? "" : src);
  if (mdCache.has(key)) {
    const hit = mdCache.get(key);
    mdCache.delete(key);
    mdCache.set(key, hit);
    return hit;
  }
  const parts = key.split("```");
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      const chunk = parts[i];
      const nl = chunk.indexOf("\n");
      let lang = "";
      let body = chunk;
      if (nl >= 0) {
        const head = chunk.slice(0, nl).trim();
        if (/^[\w+.#-]*$/.test(head)) { lang = head; body = chunk.slice(nl + 1); }
      } else if (/^[\w+.#-]*$/.test(chunk.trim())) {
        lang = chunk.trim(); body = "";
      }
      out.push(
        '<div class="code-block">' +
          '<div class="code-head">' +
            (lang ? '<span class="code-lang">' + esc(lang) + "</span>" : "") +
            '<span class="code-actions">' +
              '<button class="code-copy code-insert" title="Insert at cursor">insert</button>' +
              '<button class="code-copy" title="Copy">copy</button>' +
            "</span>" +
          "</div>" +
          '<pre class="code"' + (lang ? ' data-lang="' + esc(lang) + '"' : "") + "><code>" +
          highlightCode(body.replace(/\n$/, "")) +
          "</code></pre>" +
        "</div>"
      );
    } else if (parts[i]) {
      out.push(renderBlocks(parts[i]));
    }
  }
  const html = out.join("");
  mdCache.set(key, html);
  if (mdCache.size > MD_CACHE_MAX) {
    mdCache.delete(mdCache.keys().next().value);
  }
  return html;
}
