import { test } from "node:test";
import assert from "node:assert/strict";
import {
  credentialDigest,
  encodeRemoteHandshakeFrame,
  parseRemoteHandshakeFrame,
  type ChallengeFrame,
  type HelloFrame,
} from "../src/remoteHandshake.ts";

const capability = {
  protocolVersion: 1 as const,
  manifestId: "00000000-0000-4000-8000-000000000001",
  deviceId: "device-1",
  keyEpoch: 1,
  issuedAt: 1,
  expiresAt: 2,
  verbs: ["view" as const],
  sessionIds: ["session-1"],
  workspaceRoots: ["/workspace"],
  allSessions: false,
};

test("pair/enrolled/welcome schemas round-trip without authority extras", () => {
  const frames = [
    { protocolVersion: 1 as const, type: "pair" as const, deviceId: "device-1", deviceName: "Pixel", deviceNonce: "AAAAAAAAAAAAAAAAAAAAAA" },
    {
      protocolVersion: 1 as const,
      type: "enrolled" as const,
      enrolmentId: "00000000-0000-4000-8000-000000000002",
      deviceId: "device-1",
      assignedPeerId: 7,
      roomMasterKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      deviceToken: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
      keyEpoch: 1,
      hostGeneration: "00000000-0000-4000-8000-000000000003",
      capability,
      capabilitySignature: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI",
    },
    {
      protocolVersion: 1 as const,
      type: "welcome" as const,
      connectionId: "00000000-0000-4000-8000-000000000004",
      hostGeneration: "00000000-0000-4000-8000-000000000003",
      sequence: "18446744073709551615",
      capability,
      capabilitySignature: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI",
    },
  ];
  for (const frame of frames) {
    assert.deepEqual(parseRemoteHandshakeFrame(encodeRemoteHandshakeFrame(frame)), frame);
  }
});

test("hello keeps sequence as uint64 decimal string", () => {
  const hello: HelloFrame = {
    protocolVersion: 1,
    type: "hello",
    deviceId: "device-1",
    deviceToken: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
    deviceNonce: "AAAAAAAAAAAAAAAAAAAAAA",
    lastSequence: "18446744073709551615",
    clientVersion: "0.1.0",
  };
  assert.deepEqual(parseRemoteHandshakeFrame(hello), hello);
  assert.throws(() => parseRemoteHandshakeFrame({ ...hello, lastSequence: "01" }), /canonical uint64/);
});

test("challenge rejects unknown fields and peer zero", () => {
  const challenge: ChallengeFrame = {
    protocolVersion: 1,
    type: "challenge",
    connectionId: "00000000-0000-4000-8000-000000000004",
    deviceId: "device-1",
    assignedPeerId: 7,
    deviceNonce: "AAAAAAAAAAAAAAAAAAAAAA",
    hostNonce: "AQEBAQEBAQEBAQEBAQEBAQ",
    hostGeneration: "00000000-0000-4000-8000-000000000003",
    keyEpoch: 1,
  };
  assert.deepEqual(parseRemoteHandshakeFrame(challenge), challenge);
  assert.throws(() => parseRemoteHandshakeFrame({ ...challenge, assignedPeerId: 0 }), /positive uint32/);
  assert.throws(() => parseRemoteHandshakeFrame({ ...challenge, admin: true }), /unknown handshake field/);
});

test("credential digest is deterministic and binds epoch/device/key/token", () => {
  const args = [
    "00112233445566778899aabbccddeeff",
    1,
    "device-1",
    "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
  ] as const;
  const first = credentialDigest(...args);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(credentialDigest(...args), first);
  assert.notEqual(credentialDigest(args[0], 2, args[2], args[3], args[4]), first);
});
