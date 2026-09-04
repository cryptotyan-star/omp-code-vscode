import { test } from "node:test";
import assert from "node:assert/strict";
import { planRevert, revertStateHash } from "../src/revert.ts";

function input(
  before: string,
  current: string | null,
  options: { dirty?: boolean; existedBefore?: boolean; after?: string | null } = {},
) {
  return {
    before,
    current,
    dirty: options.dirty ?? false,
    existedBefore: options.existedBefore ?? true,
    afterHash: revertStateHash(options.after === undefined ? current : options.after),
  };
}

test("writes the snapshot back over an agent-changed file", () => {
  const plan = planRevert(input("a\nb\n", "a\nB\n"));
  assert.deepEqual(plan, { action: "write", content: "a\nb\n" });
});

test("an unmodified file is a no-op", () => {
  const plan = planRevert(input("same\n", "same\n"));
  assert.deepEqual(plan, { action: "noop" });
});

test("a file the agent created is deleted", () => {
  const plan = planRevert(input("", "new file\n", { existedBefore: false }));
  assert.deepEqual(plan, { action: "delete" });
});

test("a created file that is already gone is a no-op", () => {
  assert.deepEqual(planRevert(input("", null, { existedBefore: false })), { action: "noop" });
});

test("a file deleted by the tool is restored when the final hash still matches", () => {
  assert.deepEqual(planRevert(input("kept\n", null)), {
    action: "write",
    content: "kept\n",
  });
});

test("a dirty document blocks the revert", () => {
  const plan = planRevert(input("old\n", "new\n", { dirty: true }));
  assert.equal(plan.action, "blocked");
  assert.equal(plan.reason, "dirty");
});

test("dirty wins over the created-file branch too", () => {
  const plan = planRevert(input("", "draft\n", { dirty: true, existedBefore: false }));
  assert.equal(plan.action, "blocked");
});

test("a newly-created empty file is deleted", () => {
  assert.deepEqual(planRevert(input("", "", { existedBefore: false })), {
    action: "delete",
  });
});

test("an existing empty file is restored to empty, never deleted", () => {
  assert.deepEqual(planRevert(input("", "agent text\n", { existedBefore: true })), {
    action: "write",
    content: "",
  });
});

test("a saved edit after the tool finished blocks the revert", () => {
  const plan = planRevert(input("old\n", "user edit\n", { after: "agent edit\n" }));
  assert.deepEqual(plan, { action: "blocked", reason: "drift" });
});

test("a missing after snapshot cannot overwrite a changed file", () => {
  const plan = planRevert({
    before: "old\n",
    existedBefore: true,
    current: "agent edit\n",
    dirty: false,
  });
  assert.deepEqual(plan, { action: "blocked", reason: "unverified" });
});

test("an exact before-state is a no-op even if final-state capture failed", () => {
  assert.deepEqual(
    planRevert({
      before: "old\n",
      existedBefore: true,
      current: "old\n",
      dirty: false,
    }),
    { action: "noop" },
  );
});
