import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown as render } from "../media/markdown.mjs";


test("renderMarkdown: bold + italic", () => {
  assert.match(render("**bold**"), /<strong>bold<\/strong>/);
  assert.match(render("*ital*"), /<em>ital<\/em>/);
});

test("renderMarkdown: strikethrough (GFM)", () => {
  assert.match(render("~~deleted~~"), /<del>deleted<\/del>/);
});

test("renderMarkdown: inline code protected from formatting", () => {
  // content inside backticks must not be boldified
  const out = render("`**not bold**`");
  assert.match(out, /<code>.*not bold.*<\/code>/);
  assert.doesNotMatch(out, /<strong>/);
});

test("renderMarkdown: fenced code block with language label", () => {
  const out = render("```js\nconst x = 1;\n```");
  assert.match(out, /<pre class="code" data-lang="js"><code>const x = <span class="tok-number">1<\/span>;<\/code><\/pre>/);
  assert.match(out, /code-lang">js</);
  assert.match(out, /code-copy/);
});

test("renderMarkdown: link only for http(s) URLs", () => {
  const out = render("[ex](https://example.com)");
  assert.match(out, /<a href="#" data-href="https:\/\/example\.com">ex<\/a>/);
  // non-http rejected (no <a> emitted; text is escaped but link markdown stays)
  assert.doesNotMatch(render("[x](javascript:alert(1))"), /<a /);
});

test("renderMarkdown: link URL cannot break the data-href attribute", () => {
  // URL containing a double-quote is rejected by the char class, so no injection.
  const out = render('[x](https://e.com" onmouseover="evil)');
  // URL with a quote is rejected by the char class → no <a> emitted,
  // and the raw text is HTML-escaped (quotes become &quot;).
  assert.doesNotMatch(out, /<a\s/);
});

test("renderMarkdown: headings h1-h3", () => {
  assert.equal(render("# T"), "<h1>T</h1>");
  assert.equal(render("## T"), "<h2>T</h2>");
  assert.equal(render("### T"), "<h3>T</h3>");
  assert.doesNotMatch(render("#### T"), /^<h/); // h4+ not special
});

test("renderMarkdown: unordered + ordered lists", () => {
  assert.match(render("- a\n- b"), /<ul><li>a<\/li><li>b<\/li><\/ul>/);
  assert.match(render("1. a\n2. b"), /<ol><li>a<\/li><li>b<\/li><\/ol>/);
});

test("renderMarkdown: blockquote", () => {
  assert.match(render("> quoted"), /<blockquote>quoted<\/blockquote>/);
});

test("renderMarkdown: hr", () => {
  assert.equal(render("---"), "<hr>");
});

test("renderMarkdown: GFM table", () => {
  const src = "| a | b |\n| --- | --- |\n| 1 | 2 |";
  const out = render(src);
  assert.match(out, /<table class="gfm">/);
  assert.match(out, /<th>a<\/th><th>b<\/th>/);
  assert.match(out, /<td>1<\/td><td>2<\/td>/);
});

test("renderMarkdown: table requires separator row", () => {
  // header + non-separator line → not a table
  const out = render("| a | b |\n| 1 | 2 |");
  assert.doesNotMatch(out, /<table/);
});

test("renderMarkdown: paragraph wrapping", () => {
  assert.match(render("hello world"), /<p>hello world<\/p>/);
});

test("renderMarkdown: memoization returns identical HTML for same input", () => {
  const a = render("# Same");
  const b = render("# Same");
  assert.equal(a, b);
});
