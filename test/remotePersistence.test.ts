import { test } from "node:test";
import assert from "node:assert/strict";
import { OrderedSnapshotWriter } from "../src/remotePersistence.ts";

test("durable snapshots cannot complete out of order under concurrent command/event writes", async () => {
  const writer = new OrderedSnapshotWriter<{ value: number }>();
  const completed: Array<{ value: number; revision: number }> = [];
  const first = writer.enqueue({ value: 1 }, async (snapshot, revision) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    completed.push({ ...snapshot, revision });
  });
  const second = writer.enqueue({ value: 2 }, async (snapshot, revision) => {
    completed.push({ ...snapshot, revision });
  });
  await Promise.all([first, second]);
  assert.deepEqual(completed, [{ value: 1, revision: 1 }, { value: 2, revision: 2 }]);
});

test("a failed snapshot does not poison later durable writes", async () => {
  const writer = new OrderedSnapshotWriter<number>();
  await assert.rejects(writer.enqueue(1, async () => { throw new Error("disk failed"); }));
  let saved = 0;
  await writer.enqueue(2, async (snapshot) => { saved = snapshot; });
  assert.equal(saved, 2);
});
