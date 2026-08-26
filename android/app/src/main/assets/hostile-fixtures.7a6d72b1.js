export const hostileFixtures = Object.freeze([
  '<script>globalThis.__ompXss = true</script>',
  '<img src=x onerror="globalThis.__ompXss=true">',
  '<svg><script>globalThis.__ompXss=true</script></svg>',
  '[click](javascript:globalThis.__ompXss=true)',
  '[data](data:text/html,<script>globalThis.__ompXss=true</script>)',
  '<a href="https://example.invalid" onclick="globalThis.__ompXss=true">x</a>',
  '```html\n</code><script>globalThis.__ompXss=true</script>\n```',
  'tool output: &lt;/pre&gt;<iframe srcdoc="<script>globalThis.__ompXss=true</script>">',
]);
