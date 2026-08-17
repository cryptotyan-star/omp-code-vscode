import { test } from "node:test";
import assert from "node:assert/strict";
import { isNoisyNotice } from "../src/notices.ts";

test("suppresses xd:// mount/unmount notices", () => {
  assert.equal(
    isNoisyNotice({
      type: "notice",
      level: "info",
      message: "xd://: mounted mcp__claude_mem_mcp_search_search",
      source: "xdev",
    }),
    true,
  );
  assert.equal(
    isNoisyNotice({ type: "notice", level: "info", message: "xd://: unmounted inspect_image" }),
    true,
    "matched by message shape when the build sends no source tag",
  );
});

test("suppresses inspect_image visibility notices", () => {
  assert.equal(
    isNoisyNotice({
      type: "notice",
      level: "info",
      message: "inspect_image is now hidden: dashscope/kimi-k2.7-code supports image input natively. Override with /vision on.",
      source: "vision",
    }),
    true,
  );
  assert.equal(
    isNoisyNotice({
      type: "notice",
      level: "info",
      message: "inspect_image is now available: the current model has no native image input.",
    }),
    true,
  );
});

test("keeps warnings and errors even from noisy sources", () => {
  assert.equal(
    isNoisyNotice({ type: "notice", level: "warning", message: "xd://: mounted x", source: "xdev" }),
    false,
  );
  assert.equal(
    isNoisyNotice({ type: "notice", level: "error", message: "boom", source: "vision" }),
    false,
  );
});

test("keeps ordinary info notices", () => {
  assert.equal(isNoisyNotice({ type: "notice", level: "info", message: "Context compacted." }), false);
  assert.equal(
    isNoisyNotice({ type: "notice", level: "info", message: "alice left the collab session", source: "collab" }),
    false,
  );
  // A notice mentioning xd:// mid-sentence is content, not a mount report.
  assert.equal(
    isNoisyNotice({ type: "notice", level: "info", message: "Tool call failed on xd://: retry?" }),
    false,
  );
});

test("ignores non-notice frames", () => {
  assert.equal(isNoisyNotice({ type: "agent_start" }), false);
  assert.equal(isNoisyNotice({ type: "message_end", message: { role: "assistant" } }), false);
});

test("treats a missing level as info", () => {
  assert.equal(isNoisyNotice({ type: "notice", message: "xd://: mounted a" }), true);
});
