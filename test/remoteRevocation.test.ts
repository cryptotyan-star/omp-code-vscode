import { test } from "node:test";
import assert from "node:assert/strict";
import {
  commitRemoteRevocation,
  isRemoteEpochRevoked,
  RemoteRevocationAdmissionBarrier,
} from "../src/remoteRevocation.ts";
import { RemoteCommandScheduler } from "../src/remoteCommandScheduler.ts";

test("revocation durably tombstones an epoch before deleting its credential", async () => {
  const order: string[] = [];
  let tombstone = 0;
  await commitRemoteRevocation(
    7,
    async (epoch) => { order.push("tombstone"); tombstone = epoch; },
    async () => { order.push("delete-secret"); },
  );
  assert.deepEqual(order, ["tombstone", "delete-secret"]);
  assert.equal(isRemoteEpochRevoked(7, tombstone), true);
  assert.equal(isRemoteEpochRevoked(8, tombstone), false);
});

test("a crash after the tombstone but before secret deletion can never restore", async () => {
  let tombstone = 0;
  await assert.rejects(commitRemoteRevocation(
    9,
    async (epoch) => { tombstone = epoch; },
    async () => { throw new Error("simulated extension-host crash"); },
  ));
  assert.equal(isRemoteEpochRevoked(9, tombstone), true);
});

test("a stop admission blocks later prompt side effects while revocation storage is pending", async () => {
  const scheduler = new RemoteCommandScheduler();
  const barrier = new RemoteRevocationAdmissionBarrier();
  let releaseStorage!: () => void;
  const storage = new Promise<void>((resolve) => { releaseStorage = resolve; });
  let stopScheduled = false;
  let promptStarted = false;

  const stopAdmission = scheduler.admit(async () => {
    barrier.begin(); // synchronous authority boundary before the first await
    await storage;
    stopScheduled = true;
  });
  const promptAdmission = scheduler.admit(async () => {
    if (!barrier.allows(false)) return;
    promptStarted = true;
  });

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(stopScheduled, false);
  assert.equal(promptStarted, false);
  releaseStorage();
  await Promise.all([stopAdmission, promptAdmission]);
  assert.equal(stopScheduled, true);
  assert.equal(promptStarted, false);
  assert.equal(barrier.allows(true), true, "an exact duplicate may recover terminal status");
});

test("there is no crash window with accepted persisted before the revoke tombstone", async () => {
  const order: string[] = [];
  let revokedThrough = 0;
  await commitRemoteRevocation(
    11,
    async (epoch) => { revokedThrough = epoch; order.push("tombstone"); },
    async () => { order.push("delete-secret"); },
  );
  await assert.rejects((async () => {
    order.push("persist-accepted");
    throw new Error("crash while persisting accepted command");
  })());
  assert.deepEqual(order, ["tombstone", "delete-secret", "persist-accepted"]);
  assert.equal(isRemoteEpochRevoked(11, revokedThrough), true);
});
