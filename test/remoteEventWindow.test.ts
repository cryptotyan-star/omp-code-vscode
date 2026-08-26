import { test } from "node:test";
import assert from "node:assert/strict";
import { RemoteEventAckWindow } from "../src/remoteEventWindow.ts";

test("500 live events never exceed the four-frame cumulative ACK window", async () => {
  const window = new RemoteEventAckWindow(0n, 4, 5_000);
  let maximum = 0;
  const pendingAcks: Promise<void>[] = [];
  for (let index = 1; index <= 500; index += 1) {
    if (index > 4) window.acknowledge(BigInt(index - 4));
    pendingAcks.push((await window.reserve(BigInt(index))).ack);
    maximum = Math.max(maximum, window.outstandingCount);
  }
  window.acknowledge(500n);
  await Promise.all(pendingAcks);
  assert.equal(maximum, 4);
  assert.equal(window.outstandingCount, 0);
  assert.equal(window.acknowledgedThrough, 500n);
});

test("a fifth event waits until cumulative ACK frees capacity", async () => {
  const window = new RemoteEventAckWindow(0n, 4, 5_000);
  for (let index = 1; index <= 4; index += 1) await window.reserve(BigInt(index));
  let reserved = false;
  const fifth = window.reserve(5n).then((reservation) => {
    reserved = true;
    return reservation;
  });
  await Promise.resolve();
  assert.equal(reserved, false);
  window.acknowledge(1n);
  await fifth;
  assert.equal(reserved, true);
  window.close("test complete");
});

test("one unacked tail event triggers connection recovery callback", async () => {
  let timedOut: bigint | undefined;
  const window = new RemoteEventAckWindow(0n, 4, 5, (sequence) => { timedOut = sequence; });
  await window.reserve(1n);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(timedOut, 1n);
  assert.equal(window.outstandingCount, 0);
});
