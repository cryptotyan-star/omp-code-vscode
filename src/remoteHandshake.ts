import { createHash } from "node:crypto";
import {
  MAX_CONTROL_FRAME_BYTES,
  parseCapabilityManifest,
  parseUint64Decimal,
  REMOTE_PROTOCOL_VERSION,
  RemoteProtocolError,
  type CapabilityManifest,
} from "./remoteProtocol.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const B64URL_16_RE = /^[A-Za-z0-9_-]{22}$/;
const B64URL_32_RE = /^[A-Za-z0-9_-]{43}$/;
const SHA256_RE = /^[0-9a-f]{64}$/;

function fail(code: string, message: string): never {
  throw new RemoteProtocolError(code, message);
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return fail("invalid-handshake", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail("invalid-handshake", `missing handshake field: ${key}`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail("invalid-handshake", `unknown handshake field: ${key}`);
  }
}

function text(value: Record<string, unknown>, key: string, maximum: number, pattern?: RegExp): string {
  const found = value[key];
  if (typeof found !== "string" || found.length === 0 || found.length > maximum || (pattern && !pattern.test(found))) {
    return fail("invalid-handshake", `${key} has an invalid format`);
  }
  return found;
}

function optionalText(value: Record<string, unknown>, key: string, maximum: number, pattern?: RegExp): string | undefined {
  if (value[key] === undefined) return undefined;
  return text(value, key, maximum, pattern);
}

function uint32(value: Record<string, unknown>, key: string, positive = false): number {
  const found = value[key];
  if (!Number.isInteger(found) || (found as number) < (positive ? 1 : 0) || (found as number) > 0xffff_ffff) {
    return fail("invalid-handshake", `${key} must be a ${positive ? "positive " : ""}uint32`);
  }
  return found as number;
}

function boolean(value: Record<string, unknown>, key: string): boolean {
  if (typeof value[key] !== "boolean") return fail("invalid-handshake", `${key} must be boolean`);
  return value[key] as boolean;
}

function base64Url(value: Record<string, unknown>, key: string, byteLength: 16 | 32): string {
  const pattern = byteLength === 16 ? B64URL_16_RE : B64URL_32_RE;
  const encoded = text(value, key, byteLength === 16 ? 22 : 43, pattern);
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.length !== byteLength || decoded.toString("base64url") !== encoded) {
    return fail("invalid-handshake", `${key} must be canonical unpadded base64url`);
  }
  return encoded;
}

function decode(input: string | Uint8Array | unknown): Record<string, unknown> {
  let value = input;
  if (typeof input === "string" || input instanceof Uint8Array) {
    const bytes = Buffer.from(input);
    if (bytes.length > MAX_CONTROL_FRAME_BYTES) fail("frame-too-large", "handshake frame exceeds the control limit");
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      return fail("invalid-json", "handshake frame is malformed JSON");
    }
  } else {
    let encoded: string;
    try {
      encoded = JSON.stringify(input);
    } catch {
      return fail("invalid-json", "handshake frame is not serializable");
    }
    if (Buffer.byteLength(encoded) > MAX_CONTROL_FRAME_BYTES) fail("frame-too-large", "handshake frame exceeds the control limit");
  }
  return record(value, "handshake frame");
}

function base(value: Record<string, unknown>, type: string): void {
  if (value.protocolVersion !== REMOTE_PROTOCOL_VERSION || value.type !== type) {
    fail("invalid-handshake", `expected remote v1 ${type} frame`);
  }
}

export interface PairFrame {
  protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
  type: "pair";
  deviceId: string;
  deviceName: string;
  deviceNonce: string;
}

export interface EnrolledFrame {
  protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
  type: "enrolled";
  enrolmentId: string;
  deviceId: string;
  assignedPeerId: number;
  roomMasterKey: string;
  deviceToken: string;
  keyEpoch: number;
  hostGeneration: string;
  capability: CapabilityManifest;
  capabilitySignature: string;
}

export interface EnrolledAckFrame {
  protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
  type: "enrolled-ack";
  enrolmentId: string;
  deviceId: string;
  credentialDigest: string;
}

export interface HelloFrame {
  protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
  type: "hello";
  deviceId: string;
  deviceToken: string;
  deviceNonce: string;
  hostGeneration?: string;
  lastSequence: string;
  clientVersion: string;
}

export interface ChallengeFrame {
  protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
  type: "challenge";
  connectionId: string;
  deviceId: string;
  assignedPeerId: number;
  deviceNonce: string;
  hostNonce: string;
  hostGeneration: string;
  keyEpoch: number;
}

export interface ProofFrame {
  protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
  type: "proof";
  connectionId: string;
  proof: string;
}

export interface WelcomeFrame {
  protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
  type: "welcome";
  connectionId: string;
  hostGeneration: string;
  sequence: string;
  capability: CapabilityManifest;
  capabilitySignature: string;
}

export interface RemoteErrorFrame {
  protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
  type: "error";
  code: string;
  message: string;
  retryable: boolean;
}

export type RemoteHandshakeFrame =
  | PairFrame
  | EnrolledFrame
  | EnrolledAckFrame
  | HelloFrame
  | ChallengeFrame
  | ProofFrame
  | WelcomeFrame
  | RemoteErrorFrame;

export function parseRemoteHandshakeFrame(input: string | Uint8Array | unknown): RemoteHandshakeFrame {
  const value = decode(input);
  const type = text(value, "type", 32);
  switch (type) {
    case "pair":
      base(value, type);
      exactKeys(value, ["protocolVersion", "type", "deviceId", "deviceName", "deviceNonce"]);
      return {
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        type,
        deviceId: text(value, "deviceId", 128, IDENTIFIER_RE),
        deviceName: text(value, "deviceName", 128, /^[^\0-\x1f\x7f]+$/),
        deviceNonce: base64Url(value, "deviceNonce", 16),
      };
    case "enrolled": {
      base(value, type);
      exactKeys(value, [
        "protocolVersion", "type", "enrolmentId", "deviceId", "assignedPeerId", "roomMasterKey",
        "deviceToken", "keyEpoch", "hostGeneration", "capability", "capabilitySignature",
      ]);
      return {
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        type,
        enrolmentId: text(value, "enrolmentId", 36, UUID_RE).toLowerCase(),
        deviceId: text(value, "deviceId", 128, IDENTIFIER_RE),
        assignedPeerId: uint32(value, "assignedPeerId", true),
        roomMasterKey: base64Url(value, "roomMasterKey", 32),
        deviceToken: base64Url(value, "deviceToken", 32),
        keyEpoch: uint32(value, "keyEpoch", true),
        hostGeneration: text(value, "hostGeneration", 128, IDENTIFIER_RE),
        capability: parseCapabilityManifest(value.capability),
        capabilitySignature: base64Url(value, "capabilitySignature", 32),
      };
    }
    case "enrolled-ack":
      base(value, type);
      exactKeys(value, ["protocolVersion", "type", "enrolmentId", "deviceId", "credentialDigest"]);
      return {
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        type,
        enrolmentId: text(value, "enrolmentId", 36, UUID_RE).toLowerCase(),
        deviceId: text(value, "deviceId", 128, IDENTIFIER_RE),
        credentialDigest: text(value, "credentialDigest", 64, SHA256_RE),
      };
    case "hello":
      base(value, type);
      exactKeys(
        value,
        ["protocolVersion", "type", "deviceId", "deviceToken", "deviceNonce", "lastSequence", "clientVersion"],
        ["hostGeneration"],
      );
      parseUint64Decimal(text(value, "lastSequence", 20));
      {
        const hostGeneration = optionalText(value, "hostGeneration", 128, IDENTIFIER_RE);
        return {
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        type,
        deviceId: text(value, "deviceId", 128, IDENTIFIER_RE),
        deviceToken: base64Url(value, "deviceToken", 32),
        deviceNonce: base64Url(value, "deviceNonce", 16),
        ...(hostGeneration === undefined ? {} : { hostGeneration }),
        lastSequence: value.lastSequence as string,
        clientVersion: text(value, "clientVersion", 64, /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/),
        };
      }
    case "challenge":
      base(value, type);
      exactKeys(value, [
        "protocolVersion", "type", "connectionId", "deviceId", "assignedPeerId", "deviceNonce",
        "hostNonce", "hostGeneration", "keyEpoch",
      ]);
      return {
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        type,
        connectionId: text(value, "connectionId", 36, UUID_RE).toLowerCase(),
        deviceId: text(value, "deviceId", 128, IDENTIFIER_RE),
        assignedPeerId: uint32(value, "assignedPeerId", true),
        deviceNonce: base64Url(value, "deviceNonce", 16),
        hostNonce: base64Url(value, "hostNonce", 16),
        hostGeneration: text(value, "hostGeneration", 128, IDENTIFIER_RE),
        keyEpoch: uint32(value, "keyEpoch", true),
      };
    case "proof":
      base(value, type);
      exactKeys(value, ["protocolVersion", "type", "connectionId", "proof"]);
      return {
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        type,
        connectionId: text(value, "connectionId", 36, UUID_RE).toLowerCase(),
        proof: base64Url(value, "proof", 32),
      };
    case "welcome": {
      base(value, type);
      exactKeys(value, [
        "protocolVersion", "type", "connectionId", "hostGeneration", "sequence", "capability", "capabilitySignature",
      ]);
      parseUint64Decimal(text(value, "sequence", 20));
      return {
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        type,
        connectionId: text(value, "connectionId", 36, UUID_RE).toLowerCase(),
        hostGeneration: text(value, "hostGeneration", 128, IDENTIFIER_RE),
        sequence: value.sequence as string,
        capability: parseCapabilityManifest(value.capability),
        capabilitySignature: base64Url(value, "capabilitySignature", 32),
      };
    }
    case "error":
      base(value, type);
      exactKeys(value, ["protocolVersion", "type", "code", "message", "retryable"]);
      return {
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        type,
        code: text(value, "code", 64, /^[a-z][a-z0-9-]{0,63}$/),
        message: text(value, "message", 1024),
        retryable: boolean(value, "retryable"),
      };
    default:
      return fail("invalid-handshake", `unknown handshake type: ${type}`);
  }
}

export function encodeRemoteHandshakeFrame(frame: RemoteHandshakeFrame): Uint8Array {
  // Parsing before encoding keeps locally generated frames on the same closed schema as network input.
  const parsed = parseRemoteHandshakeFrame(frame);
  return Buffer.from(JSON.stringify(parsed), "utf8");
}

export function credentialDigest(
  roomId: string,
  keyEpoch: number,
  deviceId: string,
  roomMasterKeyBase64Url: string,
  deviceTokenBase64Url: string,
): string {
  if (!/^[0-9a-f]{32}$/.test(roomId) || !Number.isInteger(keyEpoch) || keyEpoch < 1 || keyEpoch > 0xffff_ffff) {
    return fail("invalid-credential", "credential context is invalid");
  }
  const roomKey = Buffer.from(roomMasterKeyBase64Url, "base64url");
  const token = Buffer.from(deviceTokenBase64Url, "base64url");
  if (
    !IDENTIFIER_RE.test(deviceId) ||
    !B64URL_32_RE.test(roomMasterKeyBase64Url) || roomKey.length !== 32 || roomKey.toString("base64url") !== roomMasterKeyBase64Url ||
    !B64URL_32_RE.test(deviceTokenBase64Url) || token.length !== 32 || token.toString("base64url") !== deviceTokenBase64Url
  ) {
    return fail("invalid-credential", "credential material is invalid");
  }
  return createHash("sha256")
    .update(`omp-code-remote/v1\0credential\0${roomId}\0${keyEpoch}\0${deviceId}\0`, "utf8")
    .update(roomKey)
    .update(token)
    .digest("hex");
}
