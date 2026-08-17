import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTranscript, summarizeSession } from "../src/sessions.ts";

const meta = { path: "/tmp/sessions/-Desktop-Ohmypi/2026-01-01T00-00-00-000Z_abc.jsonl", updatedAt: 1_700_000_000_000 };

function jsonl(...entries: unknown[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
}

const userMsg = (text: string) => ({
  type: "message",
  message: { role: "user", content: [{ type: "text", text }] },
});
const assistantMsg = (provider: string, model: string) => ({
  type: "message",
  message: { role: "assistant", provider, model, content: [{ type: "text", text: "ok" }] },
});

test("summarizes a multi-model session", () => {
  const s = summarizeSession(
    jsonl(
      { type: "title", title: "Add theme settings" },
      { type: "session", id: "01a0", cwd: "/Users/x/proj", timestamp: "2026-08-17T12:10:33.847Z" },
      { type: "model_change", model: "anthropic/claude-opus-4-8" },
      userMsg("привет"),
      assistantMsg("kimi-code", "k3"),
      userMsg("ещё"),
      assistantMsg("anthropic", "claude-opus-5"),
      assistantMsg("anthropic", "claude-opus-5"),
      { type: "message", message: { role: "toolResult", content: [] } },
    ),
    meta,
  );
  assert.ok(s);
  assert.equal(s.title, "Add theme settings");
  assert.equal(s.id, "01a0");
  assert.equal(s.cwd, "/Users/x/proj");
  assert.equal(s.preview, "привет");
  assert.equal(s.userMessages, 2);
  // One badge per distinct model that actually produced a reply, in order of use.
  assert.deepEqual(s.models, ["kimi-code/k3", "anthropic/claude-opus-5"]);
  assert.equal(s.startedAt, Date.parse("2026-08-17T12:10:33.847Z"));
  assert.equal(s.updatedAt, meta.updatedAt);
});

test("drops sessions with no user message", () => {
  // omp writes a file the moment an agent starts; restarts would bury real ones.
  const s = summarizeSession(
    jsonl(
      { type: "session", id: "empty", cwd: "/tmp", timestamp: "2026-08-17T12:10:33.847Z" },
      { type: "model_change", model: "kimi-code/k3" },
      { type: "custom", customType: "session_exit", data: { reason: "sigterm" } },
    ),
    meta,
  );
  assert.equal(s, undefined);
});

test("falls back to the configured model when nothing answered yet", () => {
  const s = summarizeSession(
    jsonl({ type: "model_change", model: "kimi-code/k3" }, userMsg("привет")),
    meta,
  );
  assert.deepEqual(s?.models, ["kimi-code/k3"]);
});

test("survives malformed and empty lines", () => {
  const text = "not json\n\n" + jsonl(userMsg("hi"), assistantMsg("anthropic", "claude-opus-5")) + "{broken";
  const s = summarizeSession(text, meta);
  assert.equal(s?.userMessages, 1);
  assert.deepEqual(s?.models, ["anthropic/claude-opus-5"]);
});

test("falls back to the filename when the session entry is missing", () => {
  const s = summarizeSession(jsonl(userMsg("hi")), meta);
  assert.equal(s?.id, "2026-01-01T00-00-00-000Z_abc");
  assert.equal(s?.startedAt, meta.updatedAt, "no session timestamp → file mtime");
});

test("preview uses the first user message and is bounded", () => {
  const long = "x".repeat(500);
  const s = summarizeSession(jsonl(userMsg(long), userMsg("second")), meta);
  assert.equal(s?.preview.length, 160);
  assert.equal(s?.userMessages, 2);
});

const when = new Date("2026-08-17T12:00:00.000Z");

test("formatTranscript renders user, assistant, thinking, tools and results", () => {
  const md = formatTranscript(
    [
      { role: "user", content: [{ type: "text", text: "fix the bug" }] },
      { role: "user", content: "synthetic", synthetic: true },
      {
        role: "assistant",
        model: "k3",
        content: [
          { type: "thinking", thinking: "let me see" },
          { type: "text", text: "done" },
          { type: "toolCall", id: "1", name: "bash", arguments: { command: "ls" } },
        ],
      },
      { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "a.ts" }] },
    ],
    when,
  );
  assert.ok(md.includes("_Exported 2026-08-17T12:00:00.000Z · 4 messages_"));
  assert.ok(md.includes("## You\n\nfix the bug"));
  assert.ok(!md.includes("synthetic"));
  assert.ok(md.includes("## Assistant (k3)"));
  assert.ok(md.includes("> let me see"));
  assert.ok(md.includes("**⚙ bash**"));
  assert.ok(md.includes('````json\n{\n  "command": "ls"\n}\n````'));
  assert.ok(md.includes("### Result — bash\n\n````text\na.ts\n````"));
});

test("formatTranscript marks errored results and truncates huge ones", () => {
  const big = "x".repeat(5000);
  const md = formatTranscript(
    [{ role: "toolResult", toolName: "read", isError: true, content: big }],
    when,
  );
  assert.ok(md.includes("### Result — read (error)"));
  assert.ok(md.includes("(truncated)"));
  assert.ok(!md.includes(big));
});

test("formatTranscript keeps embedded triple backticks intact", () => {
  const md = formatTranscript(
    [{ role: "toolResult", toolName: "read", content: "before\n```\nafter" }],
    when,
  );
  assert.ok(md.includes("````text\nbefore\n```\nafter\n````"));
});

test("formatTranscript handles a user message with no text", () => {
  const md = formatTranscript([{ role: "user", content: [] }], when);
  assert.ok(md.includes("## You\n\n_(no text)_"));
});
