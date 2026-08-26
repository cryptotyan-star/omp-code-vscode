import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveConnectionTrafficKey,
  openEnvelope,
  RemoteCryptoError,
  sealEnvelope,
} from "../src/remoteCrypto.ts";
import {
  createBlindRelay,
  RELAY_CLOSE,
  WebSocket,
} from "../remote-relay/relay.mjs";

const ROOM = "00112233445566778899aabbccddeeff";
const ROOM_2 = "10112233445566778899aabbccddeeff";

async function runningRelay(options: Record<string, number> = {}) {
  const relay = createBlindRelay(options);
  const address = await relay.listen(0, "127.0.0.1");
  if (!address || typeof address === "string") throw new Error("relay did not return a TCP address");
  return { relay, baseUrl: `ws://127.0.0.1:${address.port}`, httpUrl: `http://127.0.0.1:${address.port}` };
}

function openWebSocket(url: string): Promise<InstanceType<typeof WebSocket>> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    const onError = (error: Error) => {
      socket.off("open", onOpen);
      reject(error);
    };
    const onOpen = () => {
      socket.off("error", onError);
      resolve(socket);
    };
    socket.once("error", onError);
    socket.once("open", onOpen);
  });
}

function nextMessage(socket: InstanceType<typeof WebSocket>): Promise<{ data: Buffer; isBinary: boolean }> {
  return new Promise((resolve, reject) => {
    const onClose = (code: number) => {
      socket.off("error", onError);
      reject(new Error(`socket closed before message: ${code}`));
    };
    const onError = (error: Error) => {
      socket.off("close", onClose);
      reject(error);
    };
    socket.once("close", onClose);
    socket.once("error", onError);
    socket.once("message", (data: Buffer, isBinary: boolean) => {
      socket.off("close", onClose);
      socket.off("error", onError);
      resolve({ data: Buffer.from(data), isBinary });
    });
  });
}

function nextClose(socket: InstanceType<typeof WebSocket>): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    socket.once("close", (code: number, reason: Buffer) => resolve({ code, reason: reason.toString("utf8") }));
  });
}

function closeClient(socket: InstanceType<typeof WebSocket> | undefined): void {
  if (socket && socket.readyState !== WebSocket.CLOSED) socket.terminate();
}

test("relay health exposes only aggregate counts", async (t) => {
  const { relay, httpUrl } = await runningRelay();
  t.after(() => relay.close());
  const response = await fetch(`${httpUrl}/healthz`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, rooms: 0, connections: 0 });
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("relay assigns a guest peer, rewrites guest sender and preserves host target", async (t) => {
  const { relay, baseUrl } = await runningRelay();
  let host: InstanceType<typeof WebSocket> | undefined;
  let guest: InstanceType<typeof WebSocket> | undefined;
  t.after(async () => {
    closeClient(host);
    closeClient(guest);
    await relay.close();
  });
  host = await openWebSocket(`${baseUrl}/r/${ROOM}?role=host`);
  const joinedPromise = nextMessage(host);
  guest = await openWebSocket(`${baseUrl}/r/${ROOM}?role=guest`);
  const joined = await joinedPromise;
  assert.equal(joined.isBinary, false);
  const joinedControl = JSON.parse(joined.data.toString("utf8"));
  assert.equal(joinedControl.t, "peer-joined");
  assert.equal(joinedControl.peer, 1);

  const guestPayload = Buffer.from("opaque-guest-payload");
  const guestFrame = Buffer.alloc(4 + guestPayload.length);
  guestPayload.copy(guestFrame, 4);
  const fromGuestPromise = nextMessage(host);
  guest.send(guestFrame);
  const fromGuest = await fromGuestPromise;
  assert.equal(fromGuest.isBinary, true);
  assert.equal(fromGuest.data.readUInt32BE(0), joinedControl.peer);
  assert.deepEqual(fromGuest.data.subarray(4), guestPayload);

  const hostPayload = Buffer.from("opaque-host-payload");
  const hostFrame = Buffer.alloc(4 + hostPayload.length);
  hostFrame.writeUInt32BE(joinedControl.peer, 0);
  hostPayload.copy(hostFrame, 4);
  const fromHostPromise = nextMessage(guest);
  host.send(hostFrame);
  const fromHost = await fromHostPromise;
  assert.equal(fromHost.isBinary, true);
  assert.deepEqual(fromHost.data, hostFrame);
  assert.deepEqual(relay.stats(), { rooms: 1, hosts: 1, guests: 1 });

  const leftPromise = nextMessage(host);
  guest.close();
  const left = await leftPromise;
  assert.deepEqual(JSON.parse(left.data.toString("utf8")), { t: "peer-left", peer: joinedControl.peer });
});

test("host peer zero broadcasts while a non-zero peer targets one guest", async (t) => {
  const { relay, baseUrl } = await runningRelay();
  const sockets: InstanceType<typeof WebSocket>[] = [];
  t.after(async () => {
    for (const socket of sockets) closeClient(socket);
    await relay.close();
  });
  const host = await openWebSocket(`${baseUrl}/r/${ROOM}?role=host`);
  sockets.push(host);
  const joined1 = nextMessage(host);
  const guest1 = await openWebSocket(`${baseUrl}/r/${ROOM}?role=guest`);
  sockets.push(guest1);
  const peer1 = JSON.parse((await joined1).data.toString()).peer as number;
  const joined2 = nextMessage(host);
  const guest2 = await openWebSocket(`${baseUrl}/r/${ROOM}?role=guest`);
  sockets.push(guest2);
  const peer2 = JSON.parse((await joined2).data.toString()).peer as number;
  assert.notEqual(peer1, peer2);

  const broadcast = Buffer.alloc(8, 7);
  broadcast.writeUInt32BE(0, 0);
  const receive1 = nextMessage(guest1);
  const receive2 = nextMessage(guest2);
  host.send(broadcast);
  assert.deepEqual((await receive1).data, broadcast);
  assert.deepEqual((await receive2).data, broadcast);

  const targeted = Buffer.alloc(8, 9);
  targeted.writeUInt32BE(peer2, 0);
  const receiveTarget = nextMessage(guest2);
  host.send(targeted);
  assert.deepEqual((await receiveTarget).data, targeted);
});

test("relay enforces one host and bounded guests per room", async (t) => {
  const { relay, baseUrl } = await runningRelay({ maxGuestsPerRoom: 1 });
  const sockets: InstanceType<typeof WebSocket>[] = [];
  t.after(async () => {
    for (const socket of sockets) closeClient(socket);
    await relay.close();
  });
  const host = await openWebSocket(`${baseUrl}/r/${ROOM}?role=host`);
  sockets.push(host);

  const duplicateHost = new WebSocket(`${baseUrl}/r/${ROOM}?role=host`);
  sockets.push(duplicateHost);
  const duplicateClosed = nextClose(duplicateHost);
  const duplicateResult = await duplicateClosed;
  assert.equal(duplicateResult.code, RELAY_CLOSE.CONFLICT);

  const joined = nextMessage(host);
  const guest = await openWebSocket(`${baseUrl}/r/${ROOM}?role=guest`);
  sockets.push(guest);
  await joined;
  const extraGuest = new WebSocket(`${baseUrl}/r/${ROOM}?role=guest`);
  sockets.push(extraGuest);
  const extraResult = await nextClose(extraGuest);
  assert.equal(extraResult.code, RELAY_CLOSE.LIMIT);
});

test("guest without host is rejected and host close closes the whole room", async (t) => {
  const { relay, baseUrl } = await runningRelay();
  const sockets: InstanceType<typeof WebSocket>[] = [];
  t.after(async () => {
    for (const socket of sockets) closeClient(socket);
    await relay.close();
  });
  const orphan = new WebSocket(`${baseUrl}/r/${ROOM_2}?role=guest`);
  sockets.push(orphan);
  assert.equal((await nextClose(orphan)).code, RELAY_CLOSE.NOT_FOUND);

  const host = await openWebSocket(`${baseUrl}/r/${ROOM}?role=host`);
  sockets.push(host);
  const joined = nextMessage(host);
  const guest = await openWebSocket(`${baseUrl}/r/${ROOM}?role=guest`);
  sockets.push(guest);
  await joined;
  const roomControl = nextMessage(guest);
  const guestClosed = nextClose(guest);
  host.close();
  assert.deepEqual(JSON.parse((await roomControl).data.toString()), { t: "room-closed" });
  assert.equal((await guestClosed).code, RELAY_CLOSE.ROOM_CLOSED);
});

test("relay rejects text application frames and a non-zero guest target", async (t) => {
  const { relay, baseUrl } = await runningRelay();
  const sockets: InstanceType<typeof WebSocket>[] = [];
  t.after(async () => {
    for (const socket of sockets) closeClient(socket);
    await relay.close();
  });
  const host = await openWebSocket(`${baseUrl}/r/${ROOM}?role=host`);
  sockets.push(host);
  const textClosed = nextClose(host);
  host.send("plaintext is forbidden");
  assert.equal((await textClosed).code, RELAY_CLOSE.PROTOCOL);

  const host2 = await openWebSocket(`${baseUrl}/r/${ROOM_2}?role=host`);
  sockets.push(host2);
  const joined = nextMessage(host2);
  const guest = await openWebSocket(`${baseUrl}/r/${ROOM_2}?role=guest`);
  sockets.push(guest);
  await joined;
  const badFrame = Buffer.alloc(4);
  badFrame.writeUInt32BE(5, 0);
  const badClosed = nextClose(guest);
  guest.send(badFrame);
  assert.equal((await badClosed).code, RELAY_CLOSE.PROTOCOL);
});

test("relay rate and frame limits close abusive connections", async (t) => {
  const { relay, baseUrl } = await runningRelay({ maxFramesPerSecond: 1, maxFrameBytes: 32 });
  const sockets: InstanceType<typeof WebSocket>[] = [];
  t.after(async () => {
    for (const socket of sockets) closeClient(socket);
    await relay.close();
  });
  const host = await openWebSocket(`${baseUrl}/r/${ROOM}?role=host`);
  sockets.push(host);
  const joined = nextMessage(host);
  const guest = await openWebSocket(`${baseUrl}/r/${ROOM}?role=guest`);
  sockets.push(guest);
  await joined;
  const frame = Buffer.alloc(4);
  const abusiveClosed = nextClose(guest);
  guest.send(frame);
  guest.send(frame);
  assert.equal((await abusiveClosed).code, RELAY_CLOSE.LIMIT);

  const joined2 = nextMessage(host);
  const oversized = await openWebSocket(`${baseUrl}/r/${ROOM}?role=guest`);
  sockets.push(oversized);
  await joined2;
  const oversizedClosed = nextClose(oversized);
  oversized.send(Buffer.alloc(33));
  assert.equal((await oversizedClosed).code, 1009);
});

test("encrypted frames cross the relay byte-for-byte and captured payload contains no plaintext", async (t) => {
  const { relay, baseUrl } = await runningRelay();
  const sockets: InstanceType<typeof WebSocket>[] = [];
  t.after(async () => {
    for (const socket of sockets) closeClient(socket);
    await relay.close();
  });
  const host = await openWebSocket(`${baseUrl}/r/${ROOM}?role=host`);
  sockets.push(host);
  const joined = nextMessage(host);
  const guest = await openWebSocket(`${baseUrl}/r/${ROOM}?role=guest`);
  sockets.push(guest);
  const peerId = JSON.parse((await joined).data.toString()).peer as number;
  const master = Buffer.from(Array.from({ length: 32 }, (_, index) => index));
  const hostNonce = Buffer.alloc(16, 1);
  const deviceNonce = Buffer.alloc(16, 2);
  const key = deriveConnectionTrafficKey(master, {
    roomId: ROOM,
    keyEpoch: 1,
    direction: "device-to-host",
    hostNonce,
    deviceNonce,
  });
  const plaintext = Buffer.from("relay must never see this application plaintext");
  const sent = Buffer.from(sealEnvelope({
    key,
    plaintext,
    roomId: ROOM,
    keyEpoch: 1,
    direction: "device-to-host",
    peerId,
    envelopePeerId: 0,
    counter: 0,
  }));
  const receivedPromise = nextMessage(host);
  guest.send(sent);
  const received = (await receivedPromise).data;
  assert.equal(received.readUInt32BE(0), peerId);
  assert.deepEqual(received.subarray(4), sent.subarray(4), "relay may rewrite only the peer routing header");
  assert.equal(received.includes(plaintext), false);
  const opened = openEnvelope(received, {
    key, roomId: ROOM, keyEpoch: 1, direction: "device-to-host", expectedEnvelopePeerId: peerId,
  });
  assert.deepEqual(Buffer.from(opened.plaintext), plaintext);
  assert.throws(() => openEnvelope(received, {
    key: Buffer.alloc(32, 99), roomId: ROOM, keyEpoch: 1, direction: "device-to-host",
  }), (error: unknown) => error instanceof RemoteCryptoError && error.code === "authentication-failed");
});
