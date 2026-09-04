import { test } from "node:test";
import assert from "node:assert/strict";
import { ApprovalNotPendingError, claimPendingApproval } from "../src/remoteApproval.ts";

function race(first: "desktop" | "remote", second: "desktop" | "remote"): string[] {
  const ids = new Set(["approval-1"]);
  const frames = new Map([["approval-1", { method: "confirm" }]]);
  const sent: string[] = [];
  for (const source of [first, second]) {
    if (claimPendingApproval("approval-1", ids, frames)) sent.push(source);
  }
  return sent;
}

test("desktop-first approval atomically wins and phone cannot double-send", () => {
  assert.deepEqual(race("desktop", "remote"), ["desktop"]);
});

test("phone-first approval atomically wins and desktop cannot double-send", () => {
  assert.deepEqual(race("remote", "desktop"), ["remote"]);
});

test("a missing host approval has the closed terminal error code", () => {
  const error = new ApprovalNotPendingError();
  assert.equal(error.code, "host-not-pending");
  assert.match(error.message, /not pending/);
});
