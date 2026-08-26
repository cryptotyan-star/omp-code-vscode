import { test } from "node:test";
import assert from "node:assert/strict";
import { filterRemoteSessionMessage } from "../src/remoteEventFilter.ts";

test("remote session mirror blocks key status and OAuth one-time-code frames", () => {
  assert.equal(filterRemoteSessionMessage({ t: "keyStatus", keys: { anthropic: true } }, ["view"]), undefined);
  assert.ok(filterRemoteSessionMessage(
    { t: "keyStatus", keys: { anthropic: true } },
    ["view", "credentials.manage"],
  ));
  assert.equal(filterRemoteSessionMessage({
    t: "frame",
    frame: { type: "extension_ui_request", method: "open_url", url: "https://login", instructions: "CODE-123" },
  }, ["view", "approve"]), undefined);
  assert.deepEqual(filterRemoteSessionMessage({
    t: "frame",
    frame: {
      type: "extension_ui_request",
      method: "open_url",
      url: "https://login.example/device?state=abc",
      instructions: "CODE-123",
      rawToken: "must-not-cross",
    },
  }, ["view", "credentials.manage"]), {
    t: "frame",
    frame: {
      type: "extension_ui_request",
      method: "open_url",
      url: "https://login.example/device?state=abc",
      instructions: "CODE-123",
    },
  });
  assert.equal(filterRemoteSessionMessage({
    t: "frame", frame: { type: "extension_ui_request", method: "open_url", url: "file:///tmp/token" },
  }, ["view", "credentials.manage"]), undefined);
  assert.equal(filterRemoteSessionMessage({
    t: "frame", frame: { type: "extension_ui_request", method: "open_url", url: "https://user:secret@login.example/" },
  }, ["view", "credentials.manage"]), undefined);
  assert.deepEqual(filterRemoteSessionMessage(
    { t: "authDone", providerId: "anthropic", ok: false, detail: "secret detail" },
    ["view", "credentials.manage"],
  ), { t: "authDone", providerId: "anthropic", ok: false });
});

test("remote session mirror preserves correlation/tool fields and gates approvals", () => {
  assert.deepEqual(filterRemoteSessionMessage({
    t: "fileCandidates",
    token: "mention-query-7",
    files: [{ path: "/work/token.ts", tool: { token: "semantic-field" } }],
  }, ["view"]), {
    t: "fileCandidates",
    token: "mention-query-7",
    files: [{ path: "/work/token.ts", tool: { token: "semantic-field" } }],
  });
  const approval = { t: "frame", frame: { type: "extension_ui_request", method: "confirm", id: "req-1" } };
  assert.equal(filterRemoteSessionMessage(approval, ["view"]), undefined);
  assert.ok(filterRemoteSessionMessage(approval, ["view", "approve"]));
  const resolved = { t: "approvalResolved", requestId: "req-1", outcome: "answered", winner: "desktop" };
  assert.equal(filterRemoteSessionMessage(resolved, ["view"]), undefined);
  assert.deepEqual(filterRemoteSessionMessage(resolved, ["view", "approve"]), resolved);
});
