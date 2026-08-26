import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildAeadAad,
  buildDirectionalHkdfInfo,
  buildDirectionalHkdfSalt,
  buildFrameNonce,
  canonicalJsonBytes,
  deriveConnectionTrafficKey,
  deriveDirectionalKey,
  deriveEnrolmentCounter,
  derivePairRequestCounter,
  digestRemoteCommand,
  handshakeProof,
  openEnvelope,
  parseAeadAad,
  parseFrameNonce,
  REMOTE_AAD_BYTES,
  REMOTE_GCM_NONCE_BYTES,
  ReplayCounterGuard,
  RemoteCryptoError,
  rotateRemoteSecrets,
  sealEnvelope,
  signCapabilityManifest,
  verifyCapabilityManifestSignature,
  verifyHandshakeProof,
} from "../src/remoteCrypto.ts";
import { parseCapabilityManifest, parseRemoteCommand } from "../src/remoteProtocol.ts";

const MASTER_KEY = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
const ROOM_ID = "00112233445566778899aabbccddeeff";
const HOST_NONCE = Buffer.from("000102030405060708090a0b0c0d0e0f", "hex");
const DEVICE_NONCE = Buffer.from("f0e0d0c0b0a090807060504030201000", "hex");
const PLAINTEXT = Buffer.from('{"protocolVersion":1,"type":"hello"}', "utf8");

function expectCryptoError(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => error instanceof RemoteCryptoError && error.code === code);
}

test("cross-language HKDF/AAD/nonce/AES-GCM known-answer vector is stable", () => {
  const pairKey = deriveDirectionalKey(MASTER_KEY, {
    roomId: ROOM_ID, keyEpoch: 7, purpose: "pair", direction: "device-to-host",
  });
  const authKey = deriveDirectionalKey(MASTER_KEY, {
    roomId: ROOM_ID, keyEpoch: 7, purpose: "auth", direction: "device-to-host",
  });
  const trafficKey = deriveConnectionTrafficKey(MASTER_KEY, {
    roomId: ROOM_ID,
    keyEpoch: 7,
    direction: "device-to-host",
    hostNonce: HOST_NONCE,
    deviceNonce: DEVICE_NONCE,
  });
  const aad = buildAeadAad({
    roomId: ROOM_ID, keyEpoch: 7, direction: "device-to-host", peerId: 0x1020_3040, counter: 42n,
  });
  const nonce = buildFrameNonce("device-to-host", 42n);
  const frame = sealEnvelope({
    key: trafficKey,
    plaintext: PLAINTEXT,
    roomId: ROOM_ID,
    keyEpoch: 7,
    direction: "device-to-host",
    peerId: 0x1020_3040,
    counter: 42n,
  });

  assert.equal(Buffer.from(pairKey).toString("hex"), "55bdc126ce3788a6cffa467a07bfc5388df77d21216770b56a3226bc59de6a2b");
  assert.equal(Buffer.from(authKey).toString("hex"), "c6f9e238f1b0093c14225407a833bb680a0e79806518ac29cdfe02540adb576f");
  assert.equal(Buffer.from(trafficKey).toString("hex"), "379bc9cfccbf5200fcd04fb918ce9a7649be98905fa8912eb95d8d21ef991d17");
  assert.equal(Buffer.from(aad).toString("hex"), "4f4d50310101000000112233445566778899aabbccddeeff0000000710203040000000000000002a");
  assert.equal(Buffer.from(nonce).toString("hex"), "44324831000000000000002a");
  assert.equal(
    Buffer.from(frame).toString("hex"),
    "1020304044324831000000000000002ab451ae94cb8dd55060c878af3ca0abbb495de31a389ef77605fef692ea556fe6347d5ebb49323fd2548f0d4a867f1961bd1f8376",
  );
});

test("HKDF domain strings and fixed binary headers are explicit", () => {
  assert.equal(Buffer.from(buildDirectionalHkdfSalt(ROOM_ID, 7)).toString("utf8"), `omp-code-remote/v1\0${ROOM_ID}\0${7}`);
  assert.equal(Buffer.from(buildDirectionalHkdfInfo("traffic", "host-to-device")).toString("utf8"), "omp-code-remote/v1\0traffic\0host-to-device");
  assert.equal(buildAeadAad({ roomId: ROOM_ID, keyEpoch: 7, direction: "host-to-device", peerId: 2, counter: 0 }).byteLength, REMOTE_AAD_BYTES);
  assert.equal(buildFrameNonce("host-to-device", 0).byteLength, REMOTE_GCM_NONCE_BYTES);
});

test("pair/enrolment counters have stable disjoint cross-language domains", () => {
  assert.equal(derivePairRequestCounter(HOST_NONCE), 0x1a31_7d69_08e6_8dc2n);
  assert.equal(derivePairRequestCounter(HOST_NONCE) >> 63n, 0n);
  assert.equal(deriveEnrolmentCounter(7), 0x8000_0000_0000_0007n);
  assert.equal(deriveEnrolmentCounter(7) >> 63n, 1n);
  assert.notEqual(derivePairRequestCounter(HOST_NONCE), derivePairRequestCounter(DEVICE_NONCE));
  assert.throws(() => deriveEnrolmentCounter(0), /positive/);
});

test("AAD and nonce parse exactly and reject a wrong direction", () => {
  const aad = buildAeadAad({ roomId: ROOM_ID, keyEpoch: 9, direction: "host-to-device", peerId: 17, counter: 99n });
  assert.deepEqual(parseAeadAad(aad), {
    protocolVersion: 1,
    roomId: ROOM_ID,
    keyEpoch: 9,
    direction: "host-to-device",
    peerId: 17,
    counter: 99n,
  });
  const nonce = buildFrameNonce("device-to-host", 123n);
  assert.equal(parseFrameNonce(nonce, "device-to-host"), 123n);
  expectCryptoError(() => parseFrameNonce(nonce, "host-to-device"), "wrong-direction");
  const zeroEpoch = Buffer.from(aad);
  zeroEpoch.writeUInt32BE(0, 24);
  expectCryptoError(() => parseAeadAad(zeroEpoch), "invalid-epoch");
});

test("AES-GCM envelope authenticates ciphertext, tag, room, epoch, direction and peer", () => {
  const key = deriveConnectionTrafficKey(MASTER_KEY, {
    roomId: ROOM_ID, keyEpoch: 7, direction: "host-to-device", hostNonce: HOST_NONCE, deviceNonce: DEVICE_NONCE,
  });
  const frame = sealEnvelope({
    key, plaintext: PLAINTEXT, roomId: ROOM_ID, keyEpoch: 7, direction: "host-to-device", peerId: 9, counter: 0,
  });
  const opened = openEnvelope(frame, {
    key, roomId: ROOM_ID, keyEpoch: 7, direction: "host-to-device", expectedEnvelopePeerId: 9,
  });
  assert.equal(opened.counter, 0n);
  assert.equal(Buffer.from(opened.plaintext).toString("utf8"), PLAINTEXT.toString("utf8"));

  for (const index of [0, 20, frame.length - 1]) {
    const tampered = Buffer.from(frame);
    tampered[index] ^= 1;
    const expectedCode = index === 0 ? "authentication-failed" : "authentication-failed";
    expectCryptoError(() => openEnvelope(tampered, {
      key, roomId: ROOM_ID, keyEpoch: 7, direction: "host-to-device",
    }), expectedCode);
  }
  expectCryptoError(() => openEnvelope(frame, {
    key, roomId: "10112233445566778899aabbccddeeff", keyEpoch: 7, direction: "host-to-device",
  }), "authentication-failed");
  expectCryptoError(() => openEnvelope(frame, {
    key, roomId: ROOM_ID, keyEpoch: 8, direction: "host-to-device",
  }), "authentication-failed");
  expectCryptoError(() => openEnvelope(frame, {
    key, roomId: ROOM_ID, keyEpoch: 7, direction: "device-to-host",
  }), "wrong-direction");
});

test("relay peer rewrite supports initial pair exception and then binds normal traffic to assigned peer", () => {
  const pairKey = deriveDirectionalKey(MASTER_KEY, {
    roomId: ROOM_ID, keyEpoch: 1, purpose: "pair", direction: "device-to-host",
  });
  const initial = Buffer.from(sealEnvelope({
    key: pairKey,
    plaintext: Buffer.from("pair"),
    roomId: ROOM_ID,
    keyEpoch: 1,
    direction: "device-to-host",
    peerId: 0,
    envelopePeerId: 0,
    counter: 0,
  }));
  initial.writeUInt32BE(9, 0); // relay replaces guest's outer zero with assigned sender id
  expectCryptoError(() => openEnvelope(initial, {
    key: pairKey, roomId: ROOM_ID, keyEpoch: 1, direction: "device-to-host",
  }), "authentication-failed");
  const openedInitial = openEnvelope(initial, {
    key: pairKey,
    roomId: ROOM_ID,
    keyEpoch: 1,
    direction: "device-to-host",
    aadPeerId: 0,
    expectedEnvelopePeerId: 9,
  });
  assert.equal(Buffer.from(openedInitial.plaintext).toString(), "pair");
  assert.equal(openedInitial.authenticatedPeerId, 0);

  const trafficKey = deriveConnectionTrafficKey(MASTER_KEY, {
    roomId: ROOM_ID, keyEpoch: 1, direction: "device-to-host", hostNonce: HOST_NONCE, deviceNonce: DEVICE_NONCE,
  });
  const normal = Buffer.from(sealEnvelope({
    key: trafficKey,
    plaintext: Buffer.from("data"),
    roomId: ROOM_ID,
    keyEpoch: 1,
    direction: "device-to-host",
    peerId: 9,
    envelopePeerId: 0,
    counter: 1,
  }));
  normal.writeUInt32BE(9, 0);
  const openedNormal = openEnvelope(normal, {
    key: trafficKey, roomId: ROOM_ID, keyEpoch: 1, direction: "device-to-host", expectedEnvelopePeerId: 9,
  });
  assert.equal(openedNormal.authenticatedPeerId, 9);
  assert.equal(Buffer.from(openedNormal.plaintext).toString(), "data");
});

test("replay guard rejects duplicate/lower counters and forged high counters do not advance it", () => {
  const key = deriveDirectionalKey(MASTER_KEY, {
    roomId: ROOM_ID, keyEpoch: 1, purpose: "traffic", direction: "host-to-device",
  });
  const guard = new ReplayCounterGuard();
  const frame = sealEnvelope({
    key, plaintext: Buffer.from("one"), roomId: ROOM_ID, keyEpoch: 1,
    direction: "host-to-device", peerId: 4, counter: 1,
  });
  openEnvelope(frame, { key, roomId: ROOM_ID, keyEpoch: 1, direction: "host-to-device", replayGuard: guard });
  assert.equal(guard.snapshot(), "1");
  expectCryptoError(() => openEnvelope(frame, {
    key, roomId: ROOM_ID, keyEpoch: 1, direction: "host-to-device", replayGuard: guard,
  }), "replay");

  const forgedHigh = Buffer.from(sealEnvelope({
    key, plaintext: Buffer.from("forged"), roomId: ROOM_ID, keyEpoch: 1,
    direction: "host-to-device", peerId: 4, counter: 100,
  }));
  forgedHigh[forgedHigh.length - 1] ^= 1;
  expectCryptoError(() => openEnvelope(forgedHigh, {
    key, roomId: ROOM_ID, keyEpoch: 1, direction: "host-to-device", replayGuard: guard,
  }), "authentication-failed");
  assert.equal(guard.snapshot(), "1");

  const legitimate = sealEnvelope({
    key, plaintext: Buffer.from("two"), roomId: ROOM_ID, keyEpoch: 1,
    direction: "host-to-device", peerId: 4, counter: 2,
  });
  openEnvelope(legitimate, { key, roomId: ROOM_ID, keyEpoch: 1, direction: "host-to-device", replayGuard: guard });
  assert.equal(guard.snapshot(), "2");
});

test("connection keys rotate across direction, nonces, room and epoch", () => {
  const base = deriveConnectionTrafficKey(MASTER_KEY, {
    roomId: ROOM_ID, keyEpoch: 1, direction: "device-to-host", hostNonce: HOST_NONCE, deviceNonce: DEVICE_NONCE,
  });
  const variants = [
    deriveConnectionTrafficKey(MASTER_KEY, {
      roomId: ROOM_ID, keyEpoch: 1, direction: "host-to-device", hostNonce: HOST_NONCE, deviceNonce: DEVICE_NONCE,
    }),
    deriveConnectionTrafficKey(MASTER_KEY, {
      roomId: ROOM_ID, keyEpoch: 2, direction: "device-to-host", hostNonce: HOST_NONCE, deviceNonce: DEVICE_NONCE,
    }),
    deriveConnectionTrafficKey(MASTER_KEY, {
      roomId: "10112233445566778899aabbccddeeff", keyEpoch: 1, direction: "device-to-host", hostNonce: HOST_NONCE, deviceNonce: DEVICE_NONCE,
    }),
    deriveConnectionTrafficKey(MASTER_KEY, {
      roomId: ROOM_ID, keyEpoch: 1, direction: "device-to-host", hostNonce: Buffer.alloc(16, 9), deviceNonce: DEVICE_NONCE,
    }),
  ];
  for (const variant of variants) assert.notDeepEqual(variant, base);
});

test("capability manifest signature is canonical and rejects tampering", () => {
  const manifest = parseCapabilityManifest({
    protocolVersion: 1,
    manifestId: "423e4567-e89b-42d3-a456-426614174003",
    deviceId: "phone-1",
    keyEpoch: 1,
    issuedAt: 100,
    expiresAt: 200,
    verbs: ["prompt", "view"],
    sessionIds: ["session-b", "session-a"],
    workspaceRoots: ["/z", "/a"],
    allSessions: false,
  });
  const signature = signCapabilityManifest(MASTER_KEY, manifest);
  assert.equal(verifyCapabilityManifestSignature(MASTER_KEY, manifest, signature), true);
  assert.equal(signCapabilityManifest(MASTER_KEY, {
    ...manifest,
    verbs: ["view", "prompt"],
    sessionIds: ["session-a", "session-b"],
    workspaceRoots: ["/a", "/z"],
  }), signature, "set-like manifest fields use canonical ordering");
  assert.equal(verifyCapabilityManifestSignature(MASTER_KEY, { ...manifest, allSessions: true }, signature), false);
  assert.equal(verifyCapabilityManifestSignature(Buffer.alloc(32, 9), manifest, signature), false);
});

test("command digest is deterministic after schema normalization", () => {
  const base = {
    protocolVersion: 1,
    type: "command",
    command: "prompt.send",
    commandId: "123e4567-e89b-42d3-a456-426614174000",
    commandCounter: "1",
    hostGeneration: "generation-1",
    sessionId: "session-1",
    payload: { text: "hello", attachmentIds: [] },
  };
  const first = parseRemoteCommand({ ...base, ignored: true });
  const second = parseRemoteCommand({ ...base, payload: { ignored: 1, attachmentIds: [], text: "hello" } });
  assert.equal(digestRemoteCommand(first), digestRemoteCommand(second));
  assert.equal(Buffer.from(canonicalJsonBytes({ a: 1, b: [true, null] })).toString(), '{"a":1,"b":[true,null]}');
});

test("rotation returns fresh complete secret epochs", () => {
  const first = rotateRemoteSecrets();
  const second = rotateRemoteSecrets(first.keyEpoch);
  assert.equal(first.keyEpoch, 1);
  assert.equal(second.keyEpoch, 2);
  assert.match(first.roomId, /^[0-9a-f]{32}$/);
  assert.notEqual(first.roomId, second.roomId);
  assert.equal(first.roomMasterKey.byteLength, 32);
  assert.equal(first.deviceToken.byteLength, 32);
  assert.notDeepEqual(first.roomMasterKey, second.roomMasterKey);
  assert.notEqual(first.hostGeneration, second.hostGeneration);
});

test("handshake proof authenticates transcript bytes", () => {
  const authKey = deriveDirectionalKey(MASTER_KEY, {
    roomId: ROOM_ID, keyEpoch: 1, purpose: "auth", direction: "device-to-host",
  });
  const transcript = Buffer.from("hostNonce|deviceNonce|phone-1");
  const proof = handshakeProof(authKey, transcript);
  assert.equal(verifyHandshakeProof(authKey, transcript, proof), true);
  assert.equal(verifyHandshakeProof(authKey, Buffer.from("changed"), proof), false);
});
