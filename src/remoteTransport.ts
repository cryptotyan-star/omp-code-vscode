import WebSocket, { type RawData } from "ws";
import {
  MAX_CONTROL_FRAME_BYTES,
  ATTACHMENT_CHUNK_HEADER_BYTES,
  MAX_ATTACHMENT_CHUNK_BYTES,
  normalizeRelayUrl,
  parseRemoteCommand,
  parseUint64Decimal,
  REMOTE_PROTOCOL_VERSION,
  type JsonValue,
  type RemoteCommand,
} from "./remoteProtocol.ts";

/** Encrypted control frames add a 32-byte relay/AEAD envelope. */
const REMOTE_ENVELOPE_BYTES = 4 + 12 + 16;
export const MAX_REMOTE_WIRE_FRAME_BYTES =
  Math.max(MAX_CONTROL_FRAME_BYTES, ATTACHMENT_CHUNK_HEADER_BYTES + MAX_ATTACHMENT_CHUNK_BYTES) +
  REMOTE_ENVELOPE_BYTES;
const MAX_RELAY_CONTROL_TEXT_BYTES = 4 * 1024;
const FATAL_RELAY_CLOSE_CODES = new Set([4400, 4401, 4409]);

export type RelayControlFrame =
  | { t: "peer-joined"; peer: number }
  | { t: "peer-left"; peer: number }
  | { t: "room-closed" };

export type RemoteTransportStatus = "stopped" | "connecting" | "connected" | "reconnecting";

export interface RemoteEventAckFrame {
  protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
  type: "event-ack";
  hostGeneration: string;
  sequence: string;
}

export interface RemotePresenceFrame {
  protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
  type: "ping" | "pong";
  nonce: string;
}

export type DeviceControlFrame = RemoteCommand | RemoteEventAckFrame | RemotePresenceFrame;

export interface RemoteCommandAckFrame {
  protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
  type: "command-ack";
  hostGeneration: string;
  commandId: string;
  status: "accepted" | "completed" | "rejected" | "indeterminate";
  result?: JsonValue;
  errorCode?: string;
  message?: string;
}

export interface RemoteHostEventFrame {
  protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
  type: "event";
  hostGeneration: string;
  sequence: string;
  eventId: string;
  sessionId?: string;
  event: "full-sync" | "session-message" | "session-board" | "remote-status" | "capability-update" | "command-result";
  payload: JsonValue;
}

const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Parse non-handshake Android JSON with a closed host-authoritative schema. */
export function parseDeviceControlFrame(value: Uint8Array | string | unknown): DeviceControlFrame {
  let decoded: unknown = value;
  if (typeof value === "string" || value instanceof Uint8Array) {
    const bytes = Buffer.from(value);
    if (bytes.byteLength > MAX_CONTROL_FRAME_BYTES) throw new Error("device control frame is too large");
    try {
      decoded = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("device control frame is malformed JSON");
    }
  }
  if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
    throw new Error("device control frame must be an object");
  }
  const frame = decoded as Record<string, unknown>;
  if (frame.type === "command") return parseRemoteCommand(frame);
  if (frame.protocolVersion !== REMOTE_PROTOCOL_VERSION) throw new Error("unsupported remote protocol version");
  if (frame.type === "event-ack") {
    const keys = Object.keys(frame).sort().join(",");
    if (
      keys !== "hostGeneration,protocolVersion,sequence,type" ||
      typeof frame.hostGeneration !== "string" || !IDENTIFIER_RE.test(frame.hostGeneration) ||
      typeof frame.sequence !== "string"
    ) {
      throw new Error("invalid event-ack frame");
    }
    parseUint64Decimal(frame.sequence);
    return {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      type: "event-ack",
      hostGeneration: frame.hostGeneration,
      sequence: frame.sequence,
    };
  }
  if (frame.type === "ping" || frame.type === "pong") {
    const keys = Object.keys(frame).sort().join(",");
    if (
      keys !== "nonce,protocolVersion,type" ||
      typeof frame.nonce !== "string" || !IDENTIFIER_RE.test(frame.nonce)
    ) {
      throw new Error("invalid presence frame");
    }
    return { protocolVersion: REMOTE_PROTOCOL_VERSION, type: frame.type, nonce: frame.nonce };
  }
  throw new Error("unknown device control frame type");
}

/** Build the exact OMP relay endpoint without ever putting secrets in it. */
export function buildRemoteRelayUrl(
  relayOrigin: string,
  roomId: string,
  role: "host" | "guest" = "host",
): string {
  const origin = normalizeRelayUrl(relayOrigin);
  if (!/^[0-9a-f]{32}$/.test(roomId)) {
    throw new Error("roomId must be 16-byte lowercase hex");
  }
  const url = new URL(origin);
  url.pathname = `/r/${roomId}`;
  url.searchParams.set("role", role);
  return url.toString();
}

/**
 * The public/native OMP relay uses compact `{t,peer}` controls. Keep this a
 * closed schema: relay text is never forwarded to the agent or Android UI.
 */
export function parseRelayControlFrame(text: string): RelayControlFrame {
  if (Buffer.byteLength(text, "utf8") > MAX_RELAY_CONTROL_TEXT_BYTES) {
    throw new Error("relay control frame is too large");
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("relay control frame is malformed JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("relay control frame must be an object");
  }
  const frame = value as Record<string, unknown>;
  const keys = Object.keys(frame).sort();
  if (frame.t === "room-closed" && keys.length === 1) {
    return { t: "room-closed" };
  }
  if (
    (frame.t === "peer-joined" || frame.t === "peer-left") &&
    keys.length === 2 &&
    keys[0] === "peer" &&
    keys[1] === "t" &&
    Number.isInteger(frame.peer) &&
    (frame.peer as number) > 0 &&
    (frame.peer as number) <= 0xffff_ffff
  ) {
    return { t: frame.t, peer: frame.peer as number };
  }
  throw new Error("relay control frame has an unknown shape");
}

export interface RemoteRelayTransportCallbacks {
  onBinary(frame: Uint8Array): void;
  onControl(frame: RelayControlFrame): void;
  onStatus(status: RemoteTransportStatus, detail?: string): void;
}

/**
 * Outbound-only reconnecting relay transport. TLS verification is explicitly
 * enabled for WSS so an inherited NODE_TLS_REJECT_UNAUTHORIZED=0 cannot turn a
 * remote-control connection into a silent MITM channel.
 */
export class RemoteRelayTransport {
  private readonly relayOrigin: string;
  private readonly roomId: string;
  private readonly callbacks: RemoteRelayTransportCallbacks;
  private readonly random: () => number;
  private socket: WebSocket | undefined;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private attempt = 0;
  private stopped = true;
  private status: RemoteTransportStatus = "stopped";
  private lastPacedSendAt = 0;

  constructor(
    relayOrigin: string,
    roomId: string,
    callbacks: RemoteRelayTransportCallbacks,
    random: () => number = Math.random,
  ) {
    this.relayOrigin = relayOrigin;
    this.roomId = roomId;
    this.callbacks = callbacks;
    this.random = random;
  }

  get currentStatus(): RemoteTransportStatus {
    return this.status;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.attempt = 0;
    this.connect();
  }

  stop(): void {
    if (this.stopped && !this.socket && !this.reconnectTimer) return;
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const socket = this.socket;
    this.socket = undefined;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      socket.close(1000, "host stopped");
    }
    this.setStatus("stopped");
  }

  /** Force a clean reconnect/resync when the peer stops acknowledging events. */
  forceReconnect(detail: string): void {
    if (this.stopped) return;
    this.callbacks.onStatus(this.status, detail);
    const socket = this.socket;
    if (socket) {
      socket.terminate();
    } else {
      this.scheduleReconnect(detail);
    }
  }

  send(frame: Uint8Array): boolean {
    if (frame.byteLength > MAX_REMOTE_WIRE_FRAME_BYTES) {
      throw new Error("remote wire frame exceeds the encrypted control limit");
    }
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(frame, { binary: true });
    return true;
  }

  /** Paced write for multi-frame sync, with local-buffer backpressure. */
  async sendAndWait(frame: Uint8Array): Promise<boolean> {
    if (frame.byteLength > MAX_REMOTE_WIRE_FRAME_BYTES) {
      throw new Error("remote wire frame exceeds the encrypted control limit");
    }
    let socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    const deadline = Date.now() + 10_000;
    while (socket.bufferedAmount > 512 * 1024) {
      if (Date.now() >= deadline) throw new Error("remote relay send backpressure timeout");
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      socket = this.socket;
      if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    }
    // Reference relay permits 120 frames/s; paced sync stays at or below 100.
    const delay = Math.max(0, 10 - (Date.now() - this.lastPacedSendAt));
    if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
    socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    await new Promise<void>((resolve, reject) => {
      socket?.send(frame, { binary: true }, (error) => error ? reject(error) : resolve());
    });
    this.lastPacedSendAt = Date.now();
    return true;
  }

  private connect(): void {
    if (this.stopped) return;
    const state = this.attempt === 0 ? "connecting" : "reconnecting";
    this.setStatus(state);
    let socket: WebSocket;
    try {
      socket = new WebSocket(buildRemoteRelayUrl(this.relayOrigin, this.roomId, "host"), {
        handshakeTimeout: 10_000,
        maxPayload: MAX_REMOTE_WIRE_FRAME_BYTES,
        perMessageDeflate: false,
        rejectUnauthorized: true,
      });
    } catch (error) {
      this.scheduleReconnect(error instanceof Error ? error.message : String(error));
      return;
    }
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    socket.on("open", () => {
      if (this.socket !== socket || this.stopped) {
        socket.close();
        return;
      }
      this.attempt = 0;
      this.setStatus("connected");
    });
    socket.on("message", (data: RawData, isBinary: boolean) => {
      if (this.socket !== socket || this.stopped) return;
      try {
        if (isBinary) {
          const bytes = Buffer.isBuffer(data)
            ? data
            : Array.isArray(data)
              ? Buffer.concat(data)
              : Buffer.from(data as ArrayBuffer);
          if (bytes.byteLength > MAX_REMOTE_WIRE_FRAME_BYTES) {
            throw new Error("relay binary frame is too large");
          }
          this.callbacks.onBinary(Buffer.from(bytes));
        } else {
          this.callbacks.onControl(parseRelayControlFrame(Buffer.from(data as ArrayBuffer).toString("utf8")));
        }
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        this.callbacks.onStatus(this.status, `ignored invalid relay frame: ${detail}`);
      }
    });
    socket.on("error", (error) => {
      if (this.socket === socket && !this.stopped) {
        this.callbacks.onStatus(this.status, error.message);
      }
    });
    socket.on("close", (code, reason) => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      if (!this.stopped) {
        const suffix = reason.byteLength ? `: ${reason.toString("utf8").slice(0, 256)}` : "";
        if (FATAL_RELAY_CLOSE_CODES.has(code)) {
          this.stopped = true;
          this.setStatus("stopped", `fatal relay close (${code})${suffix}`);
        } else {
          this.scheduleReconnect(`relay closed (${code})${suffix}`);
        }
      }
    });
  }

  private scheduleReconnect(detail?: string): void {
    if (this.stopped || this.reconnectTimer) return;
    this.attempt += 1;
    this.setStatus("reconnecting", detail);
    const baseDelay = Math.min(30_000, 500 * (2 ** Math.min(this.attempt - 1, 6)));
    // ±20% jitter avoids synchronized reconnect storms after a relay outage.
    const jitter = 0.8 + Math.min(1, Math.max(0, this.random())) * 0.4;
    const delay = Math.round(baseDelay * jitter);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }

  private setStatus(status: RemoteTransportStatus, detail?: string): void {
    if (this.status === status && detail === undefined) return;
    this.status = status;
    this.callbacks.onStatus(status, detail);
  }
}
