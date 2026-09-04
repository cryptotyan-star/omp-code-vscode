import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  formatUint64Decimal,
  isRoomId,
  parseCapabilityManifest,
  parseUint64Decimal,
  REMOTE_PROTOCOL_VERSION,
  RemoteProtocolError,
} from "./remoteProtocol.ts";
import type { CapabilityManifest, JsonValue, RemoteCommand } from "./remoteProtocol.ts";

export const REMOTE_KEY_BYTES = 32;
export const REMOTE_HANDSHAKE_NONCE_BYTES = 16;
export const REMOTE_GCM_NONCE_BYTES = 12;
export const REMOTE_GCM_TAG_BYTES = 16;
export const REMOTE_AAD_BYTES = 40;
export const REMOTE_RELAY_HEADER_BYTES = 4;

const AAD_MAGIC = Buffer.from("OMP1", "ascii");
const HKDF_DOMAIN = `omp-code-remote/v${REMOTE_PROTOCOL_VERSION}`;
const UINT64_MAX = 0xffff_ffff_ffff_ffffn;
const PAIR_COUNTER_MASK = 0x7fff_ffff_ffff_ffffn;
const ENROLMENT_COUNTER_DOMAIN = 0x8000_0000_0000_0000n;
const PAIR_COUNTER_DOMAIN = Buffer.from(`${HKDF_DOMAIN}\0pair-counter\0`, "utf8");

export type RemoteDirection = "device-to-host" | "host-to-device";
export type RemoteKeyPurpose = "pair" | "auth" | "traffic";

export const REMOTE_DIRECTION_IDS: Readonly<Record<RemoteDirection, number>> = {
  "device-to-host": 1,
  "host-to-device": 2,
};

export const REMOTE_NONCE_DIRECTION_CONSTANTS: Readonly<Record<RemoteDirection, number>> = {
  "device-to-host": 0x4432_4831, // ASCII D2H1
  "host-to-device": 0x4832_4431, // ASCII H2D1
};

/** Initial pair nonce derived from the random device handshake nonce. */
export function derivePairRequestCounter(deviceNonce: Uint8Array): bigint {
  const nonce = requireBytes(deviceNonce, REMOTE_HANDSHAKE_NONCE_BYTES, "device nonce");
  const digest = createHash("sha256").update(PAIR_COUNTER_DOMAIN).update(nonce).digest();
  return digest.readBigUInt64BE(0) & PAIR_COUNTER_MASK;
}

/** Peer-bound high-bit counter used by enrolled and enrolled-ack. */
export function deriveEnrolmentCounter(peerId: number): bigint {
  const peer = requireUint32(peerId, "assigned peerId");
  if (peer === 0) return cryptoFail("invalid-header", "assigned peerId must be positive");
  return ENROLMENT_COUNTER_DOMAIN | BigInt(peer);
}

export class RemoteCryptoError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RemoteCryptoError";
    this.code = code;
  }
}

function cryptoFail(code: string, message: string): never {
  throw new RemoteCryptoError(code, message);
}

function requireBytes(value: Uint8Array, length: number, label: string): Buffer {
  const bytes = Buffer.from(value);
  if (bytes.length !== length) return cryptoFail("invalid-key-material", `${label} must be ${length} bytes`);
  return bytes;
}

function requireUint32(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff_ffff) {
    return cryptoFail("invalid-header", `${label} must be a uint32`);
  }
  return value;
}

function requireEpoch(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 0xffff_ffff) {
    return cryptoFail("invalid-epoch", "keyEpoch must be a positive uint32");
  }
  return value;
}

function requireRoomId(value: string): string {
  if (!isRoomId(value)) return cryptoFail("invalid-room", "roomId must be 16-byte lowercase hex");
  return value;
}

function asCounter(value: bigint | number | string): bigint {
  let counter: bigint;
  if (typeof value === "string") {
    try {
      counter = parseUint64Decimal(value);
    } catch (error) {
      if (error instanceof RemoteProtocolError) return cryptoFail("invalid-counter", error.message);
      throw error;
    }
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) return cryptoFail("invalid-counter", "numeric counter must be a safe integer");
    counter = BigInt(value);
  } else {
    counter = value;
  }
  if (counter < 0n || counter > UINT64_MAX) return cryptoFail("invalid-counter", "counter is outside uint64");
  return counter;
}

export interface DirectionalKeyContext {
  roomId: string;
  keyEpoch: number;
  purpose: RemoteKeyPurpose;
  direction: RemoteDirection;
}

/** Exact cross-language HKDF salt: UTF-8 `omp-code-remote/v1\0<roomId>\0<keyEpoch>`. */
export function buildDirectionalHkdfSalt(roomId: string, keyEpoch: number): Uint8Array {
  return Buffer.from(`${HKDF_DOMAIN}\0${requireRoomId(roomId)}\0${requireEpoch(keyEpoch)}`, "utf8");
}

/** Exact cross-language HKDF info: UTF-8 `omp-code-remote/v1\0<purpose>\0<direction>`. */
export function buildDirectionalHkdfInfo(purpose: RemoteKeyPurpose, direction: RemoteDirection): Uint8Array {
  if (!(direction in REMOTE_DIRECTION_IDS)) return cryptoFail("invalid-direction", "unknown remote direction");
  return Buffer.from(`${HKDF_DOMAIN}\0${purpose}\0${direction}`, "utf8");
}

export function deriveDirectionalKey(inputKey: Uint8Array, context: DirectionalKeyContext): Uint8Array {
  const key = requireBytes(inputKey, REMOTE_KEY_BYTES, "input key");
  const derived = hkdfSync(
    "sha256",
    key,
    buildDirectionalHkdfSalt(context.roomId, context.keyEpoch),
    buildDirectionalHkdfInfo(context.purpose, context.direction),
    REMOTE_KEY_BYTES,
  );
  return Buffer.from(derived);
}

export interface ConnectionKeyContext {
  roomId: string;
  keyEpoch: number;
  direction: RemoteDirection;
  hostNonce: Uint8Array;
  deviceNonce: Uint8Array;
}

/**
 * Derives a per-connection traffic key directly from the room master key. The
 * nonce order is always host then device, independent of traffic direction.
 */
export function deriveConnectionTrafficKey(roomMasterKey: Uint8Array, context: ConnectionKeyContext): Uint8Array {
  const key = requireBytes(roomMasterKey, REMOTE_KEY_BYTES, "room master key");
  const hostNonce = requireBytes(context.hostNonce, REMOTE_HANDSHAKE_NONCE_BYTES, "host nonce");
  const deviceNonce = requireBytes(context.deviceNonce, REMOTE_HANDSHAKE_NONCE_BYTES, "device nonce");
  const salt = Buffer.concat([
    Buffer.from(buildDirectionalHkdfSalt(context.roomId, context.keyEpoch)),
    Buffer.from("\0connection\0", "utf8"),
    hostNonce,
    deviceNonce,
  ]);
  const derived = hkdfSync(
    "sha256",
    key,
    salt,
    buildDirectionalHkdfInfo("traffic", context.direction),
    REMOTE_KEY_BYTES,
  );
  return Buffer.from(derived);
}

export interface AeadHeader {
  roomId: string;
  keyEpoch: number;
  direction: RemoteDirection;
  peerId: number;
  counter: bigint | number | string;
}

/**
 * Fixed 40-byte AAD layout: `OMP1 | v:u8 | direction:u8 | flags:u16=0 |
 * room:16 | epoch:u32be | logicalPeer:u32be | counter:u64be`.
 */
export function buildAeadAad(header: AeadHeader): Uint8Array {
  const roomId = requireRoomId(header.roomId);
  const keyEpoch = requireEpoch(header.keyEpoch);
  const peerId = requireUint32(header.peerId, "peerId");
  const counter = asCounter(header.counter);
  const directionId = REMOTE_DIRECTION_IDS[header.direction];
  if (directionId === undefined) return cryptoFail("invalid-direction", "unknown remote direction");
  const aad = Buffer.alloc(REMOTE_AAD_BYTES);
  AAD_MAGIC.copy(aad, 0);
  aad.writeUInt8(REMOTE_PROTOCOL_VERSION, 4);
  aad.writeUInt8(directionId, 5);
  aad.writeUInt16BE(0, 6);
  Buffer.from(roomId, "hex").copy(aad, 8);
  aad.writeUInt32BE(keyEpoch, 24);
  aad.writeUInt32BE(peerId, 28);
  aad.writeBigUInt64BE(counter, 32);
  return aad;
}

export interface ParsedAeadHeader {
  protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
  roomId: string;
  keyEpoch: number;
  direction: RemoteDirection;
  peerId: number;
  counter: bigint;
}

export function parseAeadAad(value: Uint8Array): ParsedAeadHeader {
  const aad = Buffer.from(value);
  if (aad.length !== REMOTE_AAD_BYTES || !aad.subarray(0, 4).equals(AAD_MAGIC)) {
    return cryptoFail("invalid-header", "AAD magic or length is invalid");
  }
  if (aad.readUInt8(4) !== REMOTE_PROTOCOL_VERSION || aad.readUInt16BE(6) !== 0) {
    return cryptoFail("invalid-header", "AAD version or flags are invalid");
  }
  const directionId = aad.readUInt8(5);
  const direction = directionId === REMOTE_DIRECTION_IDS["device-to-host"]
    ? "device-to-host"
    : directionId === REMOTE_DIRECTION_IDS["host-to-device"]
      ? "host-to-device"
      : cryptoFail("invalid-direction", "AAD direction is invalid");
  const keyEpoch = aad.readUInt32BE(24);
  if (keyEpoch === 0) return cryptoFail("invalid-epoch", "AAD key epoch must be positive");
  return {
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    roomId: aad.subarray(8, 24).toString("hex"),
    keyEpoch,
    direction,
    peerId: aad.readUInt32BE(28),
    counter: aad.readBigUInt64BE(32),
  };
}

/** Nonce layout: direction constant u32be followed by frame counter u64be. */
export function buildFrameNonce(direction: RemoteDirection, counterValue: bigint | number | string): Uint8Array {
  const directionConstant = REMOTE_NONCE_DIRECTION_CONSTANTS[direction];
  if (directionConstant === undefined) return cryptoFail("invalid-direction", "unknown remote direction");
  const nonce = Buffer.alloc(REMOTE_GCM_NONCE_BYTES);
  nonce.writeUInt32BE(directionConstant, 0);
  nonce.writeBigUInt64BE(asCounter(counterValue), 4);
  return nonce;
}

export function parseFrameNonce(value: Uint8Array, expectedDirection: RemoteDirection): bigint {
  const nonce = Buffer.from(value);
  if (nonce.length !== REMOTE_GCM_NONCE_BYTES) return cryptoFail("invalid-nonce", "frame nonce must be 12 bytes");
  if (nonce.readUInt32BE(0) !== REMOTE_NONCE_DIRECTION_CONSTANTS[expectedDirection]) {
    return cryptoFail("wrong-direction", "frame nonce direction does not match connection direction");
  }
  return nonce.readBigUInt64BE(4);
}

export class ReplayCounterGuard {
  #highestCounter: bigint | null;

  constructor(highestCounter?: bigint | number | string | null) {
    this.#highestCounter = highestCounter === undefined || highestCounter === null ? null : asCounter(highestCounter);
  }

  get highestCounter(): bigint | null {
    return this.#highestCounter;
  }

  snapshot(): string | null {
    return this.#highestCounter === null ? null : formatUint64Decimal(this.#highestCounter);
  }

  assertFresh(counterValue: bigint | number | string): void {
    const counter = asCounter(counterValue);
    if (this.#highestCounter !== null && counter <= this.#highestCounter) {
      return cryptoFail("replay", "frame counter is duplicate or lower than the accepted high-water mark");
    }
  }

  commit(counterValue: bigint | number | string): void {
    const counter = asCounter(counterValue);
    this.assertFresh(counter);
    this.#highestCounter = counter;
  }
}

export interface SealEnvelopeOptions extends AeadHeader {
  key: Uint8Array;
  plaintext: Uint8Array;
  /** Outer relay routing header. Defaults to the authenticated logical peer. */
  envelopePeerId?: number;
}

export interface OpenEnvelopeOptions {
  key: Uint8Array;
  roomId: string;
  keyEpoch: number;
  direction: RemoteDirection;
  /** Override only for the initial guest pair frame, whose relay header is rewritten before the guest learns its peer id. */
  aadPeerId?: number;
  expectedEnvelopePeerId?: number;
  replayGuard?: ReplayCounterGuard;
}

export interface OpenedEnvelope {
  envelopePeerId: number;
  authenticatedPeerId: number;
  counter: bigint;
  plaintext: Uint8Array;
}

/** Frame layout: relay peer u32be | nonce 12 | ciphertext | GCM tag 16. */
export function sealEnvelope(options: SealEnvelopeOptions): Uint8Array {
  const key = requireBytes(options.key, REMOTE_KEY_BYTES, "traffic key");
  const authenticatedPeerId = requireUint32(options.peerId, "peerId");
  const envelopePeerId = requireUint32(options.envelopePeerId ?? authenticatedPeerId, "envelopePeerId");
  const counter = asCounter(options.counter);
  const nonce = Buffer.from(buildFrameNonce(options.direction, counter));
  const aad = Buffer.from(buildAeadAad({
    roomId: options.roomId,
    keyEpoch: options.keyEpoch,
    direction: options.direction,
    peerId: authenticatedPeerId,
    counter,
  }));
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: REMOTE_GCM_TAG_BYTES });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(options.plaintext), cipher.final()]);
  const frame = Buffer.allocUnsafe(REMOTE_RELAY_HEADER_BYTES + nonce.length + ciphertext.length + REMOTE_GCM_TAG_BYTES);
  frame.writeUInt32BE(envelopePeerId, 0);
  nonce.copy(frame, REMOTE_RELAY_HEADER_BYTES);
  ciphertext.copy(frame, REMOTE_RELAY_HEADER_BYTES + nonce.length);
  cipher.getAuthTag().copy(frame, REMOTE_RELAY_HEADER_BYTES + nonce.length + ciphertext.length);
  return frame;
}

export function openEnvelope(frameValue: Uint8Array, options: OpenEnvelopeOptions): OpenedEnvelope {
  const frame = Buffer.from(frameValue);
  const minimum = REMOTE_RELAY_HEADER_BYTES + REMOTE_GCM_NONCE_BYTES + REMOTE_GCM_TAG_BYTES;
  if (frame.length < minimum) return cryptoFail("invalid-envelope", "encrypted envelope is truncated");
  const key = requireBytes(options.key, REMOTE_KEY_BYTES, "traffic key");
  const envelopePeerId = frame.readUInt32BE(0);
  if (options.expectedEnvelopePeerId !== undefined && envelopePeerId !== options.expectedEnvelopePeerId) {
    return cryptoFail("wrong-peer", "relay envelope peer does not match expected peer");
  }
  const authenticatedPeerId = requireUint32(options.aadPeerId ?? envelopePeerId, "aadPeerId");
  const nonceStart = REMOTE_RELAY_HEADER_BYTES;
  const nonceEnd = nonceStart + REMOTE_GCM_NONCE_BYTES;
  const nonce = frame.subarray(nonceStart, nonceEnd);
  const counter = parseFrameNonce(nonce, options.direction);
  options.replayGuard?.assertFresh(counter);
  const tagStart = frame.length - REMOTE_GCM_TAG_BYTES;
  const ciphertext = frame.subarray(nonceEnd, tagStart);
  const tag = frame.subarray(tagStart);
  const aad = buildAeadAad({
    roomId: options.roomId,
    keyEpoch: options.keyEpoch,
    direction: options.direction,
    peerId: authenticatedPeerId,
    counter,
  });
  let plaintext: Buffer;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: REMOTE_GCM_TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(tag);
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    return cryptoFail("authentication-failed", "encrypted envelope failed authentication");
  }
  // A forged high counter must never advance replay state, so commit only after GCM succeeds.
  options.replayGuard?.commit(counter);
  return { envelopePeerId, authenticatedPeerId, counter, plaintext };
}

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return cryptoFail("invalid-json", "canonical JSON cannot contain a non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalize(entry)).join(",")}]`;
  if (typeof value !== "object") return cryptoFail("invalid-json", "canonical JSON contains an unsupported value");
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);
  return `{${entries.join(",")}}`;
}

export function canonicalJsonBytes(value: JsonValue | RemoteCommand | CapabilityManifest): Uint8Array {
  return Buffer.from(canonicalize(value), "utf8");
}

export function digestRemoteCommand(command: RemoteCommand): string {
  return createHash("sha256").update(canonicalJsonBytes(command)).digest("hex");
}

function canonicalCapability(manifestValue: CapabilityManifest): CapabilityManifest {
  const manifest = parseCapabilityManifest(manifestValue);
  return {
    ...manifest,
    verbs: [...manifest.verbs].sort(),
    sessionIds: [...manifest.sessionIds].sort(),
    workspaceRoots: [...manifest.workspaceRoots].sort(),
  };
}

export function signCapabilityManifest(signingKey: Uint8Array, manifest: CapabilityManifest): string {
  const key = requireBytes(signingKey, REMOTE_KEY_BYTES, "capability signing key");
  return createHmac("sha256", key).update(canonicalJsonBytes(canonicalCapability(manifest))).digest("base64url");
}

export function verifyCapabilityManifestSignature(
  signingKey: Uint8Array,
  manifest: CapabilityManifest,
  signature: string,
): boolean {
  if (!/^[A-Za-z0-9_-]{43}$/.test(signature)) return false;
  const expected = Buffer.from(signCapabilityManifest(signingKey, manifest), "base64url");
  const supplied = Buffer.from(signature, "base64url");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export interface RotatedRemoteSecrets {
  roomId: string;
  keyEpoch: number;
  roomMasterKey: Uint8Array;
  deviceToken: Uint8Array;
  hostGeneration: string;
}

export function rotateRemoteSecrets(previousKeyEpoch = 0): RotatedRemoteSecrets {
  if (!Number.isInteger(previousKeyEpoch) || previousKeyEpoch < 0 || previousKeyEpoch >= 0xffff_ffff) {
    return cryptoFail("invalid-epoch", "previous key epoch cannot be rotated");
  }
  return {
    roomId: randomBytes(16).toString("hex"),
    keyEpoch: previousKeyEpoch + 1,
    roomMasterKey: randomBytes(REMOTE_KEY_BYTES),
    deviceToken: randomBytes(REMOTE_KEY_BYTES),
    hostGeneration: randomUUID(),
  };
}

export function randomPairingKey(): Uint8Array {
  return randomBytes(REMOTE_KEY_BYTES);
}

export function randomHandshakeNonce(): Uint8Array {
  return randomBytes(REMOTE_HANDSHAKE_NONCE_BYTES);
}

export function handshakeProof(authKey: Uint8Array, transcript: Uint8Array): Uint8Array {
  const key = requireBytes(authKey, REMOTE_KEY_BYTES, "auth key");
  return createHmac("sha256", key).update(Buffer.from(`${HKDF_DOMAIN}\0handshake\0`, "utf8")).update(transcript).digest();
}

export function verifyHandshakeProof(authKey: Uint8Array, transcript: Uint8Array, proof: Uint8Array): boolean {
  const expected = Buffer.from(handshakeProof(authKey, transcript));
  const supplied = Buffer.from(proof);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}
