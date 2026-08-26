import { test } from "node:test";
import assert from "node:assert/strict";
import { RemoteSerialQueue } from "../src/remoteSerialQueue.ts";

test("a second private stream cannot begin before the first terminal marker is sent", async () => {
  const queue = new RemoteSerialQueue();
  const order: string[] = [];
  let acknowledgeFirst!: () => void;
  const firstCommitAck = new Promise<void>((resolve) => { acknowledgeFirst = resolve; });

  const first = queue.enqueue(async () => {
    order.push("first-begin", "first-chunk", "first-commit");
    await firstCommitAck;
    order.push("first-terminal");
  });
  const second = queue.enqueue(async () => {
    order.push("second-begin", "second-commit", "second-terminal");
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["first-begin", "first-chunk", "first-commit"]);
  acknowledgeFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, [
    "first-begin", "first-chunk", "first-commit", "first-terminal",
    "second-begin", "second-commit", "second-terminal",
  ]);
});

test("a failed event transaction does not poison the following one", async () => {
  const queue = new RemoteSerialQueue();
  const errors: string[] = [];
  await assert.rejects(queue.enqueue(async () => { throw new Error("disconnect"); }, (error) => {
    errors.push(String(error));
  }));
  const result = await queue.enqueue(async () => "resynced");
  assert.equal(result, "resynced");
  assert.match(errors[0] ?? "", /disconnect/);
});
