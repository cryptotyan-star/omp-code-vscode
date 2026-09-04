import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";

export { WebSocket };

export const RELAY_CLOSE = Object.freeze({
  PROTOCOL: 4400,
  ROOM_CLOSED: 4401,
  NOT_FOUND: 4404,
  IDLE: 4408,
  CONFLICT: 4409,
  LIMIT: 4429,
});

export const DEFAULT_RELAY_LIMITS = Object.freeze({
  maxGuestsPerRoom: 4,
  maxFrameBytes: 384 * 1024,
  maxFramesPerSecond: 120,
  maxBytesPerMinute: 64 * 1024 * 1024,
  maxBufferedBytes: 2 * 1024 * 1024,
  idleTimeoutMs: 5 * 60 * 1000,
  pingIntervalMs: 30 * 1000,
});

const ROOM_RE = /^[0-9a-f]{32}$/;
const MIN_BINARY_FRAME_BYTES = 4;

function positiveInteger(value, fallback, name) {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate <= 0) throw new TypeError(`${name} must be a positive integer`);
  return candidate;
}

function closeSocket(socket, code, reason) {
  if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
    socket.close(code, reason.slice(0, 123));
  }
}

function rejectUpgrade(socket, status, message) {
  if (!socket.writable) return;
  const body = `${message}\n`;
  socket.end(
    `HTTP/1.1 ${status} ${message}\r\n` +
    "Connection: close\r\n" +
    "Content-Type: text/plain; charset=utf-8\r\n" +
    `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}

function relayUrl(request) {
  try {
    return new URL(request.url ?? "", "http://relay.invalid");
  } catch {
    return null;
  }
}

function parseRoute(request) {
  const url = relayUrl(request);
  if (!url) return null;
  const match = /^\/r\/([0-9a-f]{32})$/.exec(url.pathname);
  if (!match || !ROOM_RE.test(match[1])) return null;
  const keys = [...url.searchParams.keys()];
  if (keys.length !== 1 || keys[0] !== "role" || url.searchParams.getAll("role").length !== 1) return null;
  const role = url.searchParams.get("role");
  if (role !== "host" && role !== "guest") return null;
  return { roomId: match[1], role };
}

function control(type, peerId) {
  return JSON.stringify(peerId === undefined ? { t: type } : { t: type, peer: peerId });
}

function canForward(socket, size, maxBufferedBytes) {
  if (socket.readyState !== WebSocket.OPEN) return false;
  if (socket.bufferedAmount + size <= maxBufferedBytes) return true;
  closeSocket(socket, RELAY_CLOSE.LIMIT, "relay backpressure limit");
  return false;
}

function nextPeerId(room) {
  for (let attempts = 0; attempts < 0xffff_ffff; attempts += 1) {
    const id = room.nextPeerId;
    room.nextPeerId = id === 0xffff_ffff ? 1 : id + 1;
    if (id !== 0 && !room.guests.has(id)) return id;
  }
  throw new Error("relay peer id space exhausted");
}

function consumeRate(metadata, size, limits, now) {
  if (now - metadata.frameWindowStartedAt >= 1_000) {
    metadata.frameWindowStartedAt = now;
    metadata.framesInWindow = 0;
  }
  if (now - metadata.byteWindowStartedAt >= 60_000) {
    metadata.byteWindowStartedAt = now;
    metadata.bytesInWindow = 0;
  }
  metadata.framesInWindow += 1;
  metadata.bytesInWindow += size;
  return metadata.framesInWindow <= limits.maxFramesPerSecond && metadata.bytesInWindow <= limits.maxBytesPerMinute;
}

/**
 * Creates an in-memory, non-persistent relay. The relay routes only on the
 * outer four-byte peer header and never parses or stores encrypted payloads.
 */
export function createBlindRelay(options = {}) {
  const limits = Object.freeze({
    maxGuestsPerRoom: positiveInteger(options.maxGuestsPerRoom, DEFAULT_RELAY_LIMITS.maxGuestsPerRoom, "maxGuestsPerRoom"),
    maxFrameBytes: positiveInteger(options.maxFrameBytes, DEFAULT_RELAY_LIMITS.maxFrameBytes, "maxFrameBytes"),
    maxFramesPerSecond: positiveInteger(options.maxFramesPerSecond, DEFAULT_RELAY_LIMITS.maxFramesPerSecond, "maxFramesPerSecond"),
    maxBytesPerMinute: positiveInteger(options.maxBytesPerMinute, DEFAULT_RELAY_LIMITS.maxBytesPerMinute, "maxBytesPerMinute"),
    maxBufferedBytes: positiveInteger(options.maxBufferedBytes, DEFAULT_RELAY_LIMITS.maxBufferedBytes, "maxBufferedBytes"),
    idleTimeoutMs: positiveInteger(options.idleTimeoutMs, DEFAULT_RELAY_LIMITS.idleTimeoutMs, "idleTimeoutMs"),
    pingIntervalMs: positiveInteger(options.pingIntervalMs, DEFAULT_RELAY_LIMITS.pingIntervalMs, "pingIntervalMs"),
  });
  if (limits.maxFrameBytes < MIN_BINARY_FRAME_BYTES) throw new TypeError("maxFrameBytes must allow the four-byte peer header");

  const rooms = new Map();
  const metadataBySocket = new WeakMap();
  const server = options.server ?? createServer((request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      const connections = [...rooms.values()].reduce((sum, room) => sum + (room.host ? 1 : 0) + room.guests.size, 0);
      const body = JSON.stringify({ ok: true, rooms: rooms.size, connections });
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
        "cache-control": "no-store",
      });
      response.end(body);
      return;
    }
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not Found\n");
  });
  const ownsServer = options.server === undefined;
  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.maxFrameBytes, perMessageDeflate: false });

  const upgradeHandler = (request, socket, head) => {
    const route = parseRoute(request);
    if (!route) {
      rejectUpgrade(socket, 400, "Invalid relay route");
      return;
    }
    wss.handleUpgrade(request, socket, head, (webSocket) => {
      wss.emit("connection", webSocket, request, route);
    });
  };
  server.on("upgrade", upgradeHandler);

  function detach(socket) {
    const metadata = metadataBySocket.get(socket);
    if (!metadata || metadata.detached) return;
    metadata.detached = true;
    const room = rooms.get(metadata.roomId);
    if (!room) return;
    if (metadata.role === "host") {
      if (room.host !== socket) return;
      room.host = null;
      for (const guest of room.guests.values()) {
        if (guest.readyState === WebSocket.OPEN) guest.send(control("room-closed"));
        closeSocket(guest, RELAY_CLOSE.ROOM_CLOSED, "host left room");
      }
      room.guests.clear();
      rooms.delete(metadata.roomId);
      return;
    }
    if (room.guests.get(metadata.peerId) === socket) {
      room.guests.delete(metadata.peerId);
      if (room.host?.readyState === WebSocket.OPEN) room.host.send(control("peer-left", metadata.peerId));
    }
    if (!room.host && room.guests.size === 0) rooms.delete(metadata.roomId);
  }

  wss.on("connection", (socket, _request, route) => {
    const now = Date.now();
    let room = rooms.get(route.roomId);
    if (route.role === "host") {
      if (room?.host && room.host.readyState === WebSocket.OPEN) {
        closeSocket(socket, RELAY_CLOSE.CONFLICT, "room already has a host");
        return;
      }
      if (!room) {
        room = { host: null, guests: new Map(), nextPeerId: 1 };
        rooms.set(route.roomId, room);
      }
      room.host = socket;
    } else {
      if (!room?.host || room.host.readyState !== WebSocket.OPEN) {
        closeSocket(socket, RELAY_CLOSE.NOT_FOUND, "room host is not connected");
        return;
      }
      if (room.guests.size >= limits.maxGuestsPerRoom) {
        closeSocket(socket, RELAY_CLOSE.LIMIT, "room guest limit reached");
        return;
      }
    }

    const peerId = route.role === "guest" ? nextPeerId(room) : 0;
    const metadata = {
      roomId: route.roomId,
      role: route.role,
      peerId,
      lastActivityAt: now,
      frameWindowStartedAt: now,
      framesInWindow: 0,
      byteWindowStartedAt: now,
      bytesInWindow: 0,
      detached: false,
    };
    metadataBySocket.set(socket, metadata);
    if (route.role === "guest") {
      room.guests.set(peerId, socket);
      room.host.send(control("peer-joined", peerId));
    }

    socket.on("pong", () => {
      metadata.lastActivityAt = Date.now();
    });
    socket.on("error", () => {
      // Close handling performs all cleanup; payload/error details are intentionally not logged.
    });
    socket.on("close", () => detach(socket));
    socket.on("message", (data, isBinary) => {
      metadata.lastActivityAt = Date.now();
      if (!isBinary) {
        closeSocket(socket, RELAY_CLOSE.PROTOCOL, "application frames must be binary");
        return;
      }
      const frame = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (frame.length < MIN_BINARY_FRAME_BYTES || frame.length > limits.maxFrameBytes) {
        closeSocket(socket, RELAY_CLOSE.PROTOCOL, "invalid binary frame size");
        return;
      }
      if (!consumeRate(metadata, frame.length, limits, metadata.lastActivityAt)) {
        closeSocket(socket, RELAY_CLOSE.LIMIT, "relay rate limit reached");
        return;
      }
      const currentRoom = rooms.get(metadata.roomId);
      if (!currentRoom?.host) {
        closeSocket(socket, RELAY_CLOSE.ROOM_CLOSED, "room is closed");
        return;
      }
      if (metadata.role === "guest") {
        if (frame.readUInt32BE(0) !== 0) {
          closeSocket(socket, RELAY_CLOSE.PROTOCOL, "guest relay header must target host peer zero");
          return;
        }
        const forwarded = Buffer.from(frame);
        forwarded.writeUInt32BE(metadata.peerId, 0);
        if (canForward(currentRoom.host, forwarded.length, limits.maxBufferedBytes)) currentRoom.host.send(forwarded);
        return;
      }
      const targetPeerId = frame.readUInt32BE(0);
      if (targetPeerId === 0) {
        for (const guest of currentRoom.guests.values()) {
          if (canForward(guest, frame.length, limits.maxBufferedBytes)) guest.send(frame);
        }
        return;
      }
      const guest = currentRoom.guests.get(targetPeerId);
      if (guest && canForward(guest, frame.length, limits.maxBufferedBytes)) guest.send(frame);
    });
  });

  const sweepIntervalMs = Math.max(1_000, Math.min(limits.pingIntervalMs, Math.floor(limits.idleTimeoutMs / 2)));
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const socket of wss.clients) {
      const metadata = metadataBySocket.get(socket);
      if (!metadata) continue;
      if (now - metadata.lastActivityAt >= limits.idleTimeoutMs) {
        closeSocket(socket, RELAY_CLOSE.IDLE, "relay idle timeout");
      } else if (socket.readyState === WebSocket.OPEN) {
        socket.ping();
      }
    }
  }, sweepIntervalMs);
  sweep.unref();

  return {
    server,
    wss,
    limits,
    rooms,
    listen(port = 0, host = "127.0.0.1") {
      return new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve(server.address());
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
    },
    stats() {
      return {
        rooms: rooms.size,
        hosts: [...rooms.values()].filter((room) => room.host?.readyState === WebSocket.OPEN).length,
        guests: [...rooms.values()].reduce((sum, room) => sum + room.guests.size, 0),
      };
    },
    async close() {
      clearInterval(sweep);
      server.off("upgrade", upgradeHandler);
      for (const socket of wss.clients) socket.terminate();
      await new Promise((resolve) => wss.close(() => resolve()));
      if (ownsServer && server.listening) {
        await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      }
    },
  };
}
