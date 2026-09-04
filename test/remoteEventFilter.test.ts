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

test("the processes column's board snapshot never reaches a paired device", () => {
  // The filter is default-allow — an unrecognised `t` is deep-copied through.
  // A chat tab pushes this snapshot every couple of seconds, and it carries
  // every *other* workspace's name, branch, model, cost and error text, so a
  // phone scoped to one session would read the whole board through it.
  const snapshot = {
    t: "board",
    selfId: "ws-1",
    snapshot: {
      rows: [
        { id: "ws-2", kind: "workspace", name: "secret-branch-work", branch: "omp/secret", model: "kimi-code/k3", bar: "error", progress: 100, costUsd: 4.2, overBudget: false, needsHuman: true, lastError: "credential rejected" },
      ],
      totalCostUsd: 4.2,
      overSessionBudget: false,
      counts: { running: 0, done: 0, error: 1, waiting: 0, merged: 0 },
    },
  };
  for (const verbs of [["view"], ["view", "prompt"], ["view", "approve", "session.manage"]]) {
    assert.equal(
      filterRemoteSessionMessage(snapshot, verbs as never),
      undefined,
      `board must be refused for ${verbs.join("+")}`,
    );
  }
});
