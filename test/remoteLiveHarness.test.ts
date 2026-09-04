import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCliArguments, RemoteE2EHost, runSyntheticGuest } from "../scripts/remote-e2e-host.mjs";
import { deriveEnrolmentCounter, derivePairRequestCounter } from "../src/remoteCrypto.ts";

test("live harness uses nonce-derived pair and peer-domain enrolment counters", () => {
  const nonce = Buffer.from("00112233445566778899aabbccddeeff", "hex");
  assert.equal(derivePairRequestCounter(nonce) >> 63n, 0n);
  assert.equal(deriveEnrolmentCounter(1) >> 63n, 1n);
  assert.notEqual(derivePairRequestCounter(nonce), 0n);
  assert.equal(deriveEnrolmentCounter(7), 0x8000_0000_0000_0007n);
});

test("live harness CLI command is closed and defaults to session.sync", () => {
  assert.equal(new RemoteE2EHost({ logger: () => {} }).expectedCommand, "session.sync");
  assert.equal(parseCliArguments(["--write-link", "/tmp/fresh-link", "--command", "prompt.send"]).expectedCommand, "prompt.send");
  assert.throws(
    () => parseCliArguments(["--write-link", "/tmp/fresh-link", "--command", "turn.abort"]),
    /--command must be session\.sync or prompt\.send/,
  );
  assert.throws(() => new RemoteE2EHost({ expectedCommand: "turn.abort", logger: () => {} }), /--command must be/);
});

for (const command of ["session.sync", "prompt.send"] as const) {
  test(`live harness completes pair, auth, phased sync, ${command} ACKs and post-command event ACK`, async (t) => {
    const records: Array<Record<string, unknown>> = [];
    const host = new RemoteE2EHost({
      timeoutMs: 10_000,
      expectedCommand: command,
      logger: (value: Record<string, unknown>) => records.push(value),
    });
    t.after(() => host.close());
    const started = await host.start();

    const [guest, result] = await Promise.all([
      runSyntheticGuest(started.pairingUri, { command, deviceId: `synthetic-android-${command.replace(".", "-")}` }),
      host.waitForResult(),
    ]);

    assert.equal(result.status, "success");
    assert.equal(result.command, command);
    assert.deepEqual(new Set(guest.statuses), new Set(["accepted", "completed"]));
    assert.equal(guest.sawBoard, true);
    assert.equal(guest.sawFullSyncComplete, true);
    assert.equal(guest.sawPostCommandEvent, true);
    assert.equal(guest.commandResults[0].sawFreshFullSyncComplete, command === "session.sync");
    assert.equal(records.some((entry) => entry.status === "ready"), true);
    assert.equal(records.some((entry) => entry.status === "success"), true);
    assert.equal(records.some((entry) => JSON.stringify(entry).includes(started.pairingUri)), false, "logs must never contain the pairing secret");
  });
}

test("prompt mode ACKs initial session.sync but succeeds only after prompt event ACK", async (t) => {
  const records: Array<Record<string, unknown>> = [];
  const host = new RemoteE2EHost({
    timeoutMs: 10_000,
    expectedCommand: "prompt.send",
    logger: (value: Record<string, unknown>) => records.push(value),
  });
  t.after(() => host.close());
  const started = await host.start();

  const [guest, result] = await Promise.all([
    runSyntheticGuest(started.pairingUri, {
      commands: ["session.sync", "prompt.send"],
      deviceId: "synthetic-android-prompt-after-sync",
    }),
    host.waitForResult(),
  ]);

  assert.equal(result.status, "success");
  assert.equal(result.command, "prompt.send");
  assert.deepEqual(guest.commandResults.map((entry: { command: string }) => entry.command), ["session.sync", "prompt.send"]);
  for (const entry of guest.commandResults) {
    assert.deepEqual(new Set(entry.statuses), new Set(["accepted", "completed"]));
    assert.equal(entry.sawPostCommandEvent, true);
  }
  assert.equal(guest.commandResults[0].sawFreshFullSyncComplete, true, "initial session.sync must re-send phased full sync");
  assert.equal(guest.commandResults[1].sawFreshFullSyncComplete, false);
  const successes = records.filter((entry) => entry.status === "success");
  assert.deepEqual(successes.map((entry) => entry.command), ["prompt.send"]);
});
