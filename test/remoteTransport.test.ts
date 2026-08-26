import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRemoteRelayUrl,
  MAX_REMOTE_WIRE_FRAME_BYTES,
  parseDeviceControlFrame,
  parseRelayControlFrame,
} from "../src/remoteTransport.ts";
import {
  ATTACHMENT_CHUNK_HEADER_BYTES,
  MAX_ATTACHMENT_CHUNK_BYTES,
} from "../src/remoteProtocol.ts";

test("remote relay URL is host-scoped and never includes pairing material", () => {
  const value = buildRemoteRelayUrl(
    "https://relay.example.test",
    "00112233445566778899aabbccddeeff",
  );
  const url = new URL(value);
  assert.equal(url.protocol, "wss:");
  assert.equal(url.pathname, "/r/00112233445566778899aabbccddeeff");
  assert.equal(url.searchParams.get("role"), "host");
  assert.equal(url.searchParams.size, 1);
});

test("wire limit fits a maximum attachment chunk plus AEAD envelope", () => {
  assert.equal(
    MAX_REMOTE_WIRE_FRAME_BYTES,
    ATTACHMENT_CHUNK_HEADER_BYTES + MAX_ATTACHMENT_CHUNK_BYTES + 4 + 12 + 16,
  );
});

test("normal device frames use closed command/event-ack/presence schemas", () => {
  const ack = parseDeviceControlFrame({
    protocolVersion: 1,
    type: "event-ack",
    hostGeneration: "host-generation-1",
    sequence: "18446744073709551615",
  });
  assert.equal(ack.type, "event-ack");
  assert.throws(() => parseDeviceControlFrame({ ...ack, admin: true }), /invalid event-ack/);
  assert.deepEqual(parseDeviceControlFrame({ protocolVersion: 1, type: "ping", nonce: "ping-1" }), {
    protocolVersion: 1,
    type: "ping",
    nonce: "ping-1",
  });
  assert.throws(() => parseDeviceControlFrame({ protocolVersion: 1, type: "omp-rpc", payload: {} }), /unknown/);
});

test("relay controls accept only the native OMP compact shape", () => {
  assert.deepEqual(parseRelayControlFrame('{"t":"peer-joined","peer":7}'), {
    t: "peer-joined",
    peer: 7,
  });
  assert.deepEqual(parseRelayControlFrame('{"t":"peer-left","peer":7}'), {
    t: "peer-left",
    peer: 7,
  });
  assert.deepEqual(parseRelayControlFrame('{"t":"room-closed"}'), { t: "room-closed" });
  assert.throws(() => parseRelayControlFrame('{"type":"peer-joined","peerId":7}'), /unknown shape/);
  assert.throws(() => parseRelayControlFrame('{"t":"peer-joined","peer":0}'), /unknown shape/);
  assert.throws(() => parseRelayControlFrame('{"t":"peer-joined","peer":7,"admin":true}'), /unknown shape/);
});
