import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import {
  composePrompt,
  dedupe,
  formatSize,
  MAX_SNIPPET_CHARS,
  parseUriList,
  safeFileName,
} from "../src/attachments.ts";

/**
 * Attachments are handed to the agent as paths, not content. Every bug here is
 * silent: a mangled path means the agent "ignores" a file the user attached.
 */

test("parseUriList turns a VS Code drag payload into filesystem paths", () => {
  const raw = ["file:///Users/x/a%20b.ts", "file:///Users/x/b.ts"].join("\r\n");
  assert.deepEqual(parseUriList(raw), ["/Users/x/a b.ts", "/Users/x/b.ts"]);
});

test("parseUriList keeps plain absolute paths and drops relative ones", () => {
  assert.deepEqual(parseUriList("/tmp/a.txt\nrelative/b.txt\n"), ["/tmp/a.txt"]);
});

test("parseUriList drops comments, blanks and non-file schemes", () => {
  const raw = "# comment\n\nhttps://example.com/x\nuntitled:Untitled-1\nfile:///tmp/ok.txt";
  assert.deepEqual(parseUriList(raw), ["/tmp/ok.txt"]);
});

test("parseUriList de-duplicates repeated drops", () => {
  assert.deepEqual(parseUriList("/tmp/a\n/tmp/a\nfile:///tmp/a"), ["/tmp/a"]);
});

test("dedupe preserves first-seen order", () => {
  assert.deepEqual(dedupe(["b", "a", "b", "c", ""]), ["b", "a", "c"]);
});

test("safeFileName strips traversal, separators and control characters", () => {
  assert.equal(safeFileName("../../etc/passwd"), "passwd");
  assert.equal(safeFileName("a/b\\c:d.png"), "c-d.png");
  assert.equal(safeFileName("..."), "pasted-file");
  assert.equal(safeFileName(""), "pasted-file");
  assert.equal(path.basename(safeFileName("x".repeat(300))).length, 120);
});

test("formatSize reports bytes, KB and MB", () => {
  assert.equal(formatSize(512), "512 B");
  assert.equal(formatSize(2048), "2.0 KB");
  assert.equal(formatSize(20 * 1024 * 1024), "20 MB");
  assert.equal(formatSize(undefined), "");
});

test("composePrompt appends an explicit path list", () => {
  const out = composePrompt("explain this", [
    { path: "/tmp/a.ts", name: "a.ts" },
    { path: "/tmp/b.png", name: "b.png" },
  ]);
  assert.equal(out, "explain this\n\nAttached files:\n- /tmp/a.ts\n- /tmp/b.png");
});

test("composePrompt works with attachments and no text", () => {
  assert.equal(composePrompt("   ", [{ path: "/tmp/a.ts", name: "a.ts" }]), "Attached files:\n- /tmp/a.ts");
});

test("composePrompt leaves a plain prompt untouched", () => {
  assert.equal(composePrompt("hello", []), "hello");
});

test("composePrompt de-duplicates the same file attached twice", () => {
  const out = composePrompt("x", [
    { path: "/tmp/a.ts", name: "a.ts" },
    { path: "/tmp/a.ts", name: "a.ts" },
  ]);
  assert.equal(out, "x\n\nAttached files:\n- /tmp/a.ts");
});

test("composePrompt inlines an editor selection with range and language fence", () => {
  const out = composePrompt("what does this do", [
    {
      path: "/tmp/a.ts",
      name: "a.ts",
      selection: { startLine: 10, endLine: 12 },
      snippet: "const x = 1;",
      language: "typescript",
    },
  ]);
  assert.equal(
    out,
    "what does this do\n\nAttached files:\n- /tmp/a.ts (lines 10–12)\n\n" +
      "Selected code from /tmp/a.ts (lines 10–12):\n```typescript\nconst x = 1;\n```",
  );
});

test("composePrompt keeps a file and a selection from it as separate entries", () => {
  const out = composePrompt("", [
    { path: "/tmp/a.ts", name: "a.ts" },
    { path: "/tmp/a.ts", name: "a.ts", selection: { startLine: 1, endLine: 2 }, snippet: "ab" },
  ]);
  assert.equal(
    out,
    "Attached files:\n- /tmp/a.ts\n- /tmp/a.ts (lines 1–2)\n\n" +
      "Selected code from /tmp/a.ts (lines 1–2):\n```\nab\n```",
  );
});

test("composePrompt de-duplicates the identical selection sent twice", () => {
  const sel = { startLine: 3, endLine: 4 };
  const out = composePrompt("", [
    { path: "/tmp/a.ts", name: "a.ts", selection: sel, snippet: "ab" },
    { path: "/tmp/a.ts", name: "a.ts", selection: { ...sel }, snippet: "ab" },
  ]);
  assert.equal(
    out,
    "Attached files:\n- /tmp/a.ts (lines 3–4)\n\n" +
      "Selected code from /tmp/a.ts (lines 3–4):\n```\nab\n```",
  );
});

test("composePrompt drops a fence-breaking language id", () => {
  const out = composePrompt("", [
    {
      path: "/tmp/a.ts",
      name: "a.ts",
      selection: { startLine: 1, endLine: 1 },
      snippet: "x",
      language: "ts\n```\nINJECTED",
    },
  ]);
  assert.ok(!out.includes("INJECTED"));
  assert.ok(out.includes("```\nx\n```"));
});

test("composePrompt truncates an oversized snippet with a pointer to the file", () => {
  const big = "y".repeat(MAX_SNIPPET_CHARS + 500);
  const out = composePrompt("", [
    { path: "/tmp/a.ts", name: "a.ts", selection: { startLine: 1, endLine: 99 }, snippet: big },
  ]);
  assert.ok(out.includes("truncated"));
  assert.ok(out.includes("/tmp/a.ts"));
  assert.ok(!out.includes(big));
});
