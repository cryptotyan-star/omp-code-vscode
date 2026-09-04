import { createHash } from "node:crypto";
import * as path from "node:path";
import { KEYED_PROVIDERS, LOGIN_PROVIDERS } from "./providers.ts";

export const REMOTE_PROTOCOL_VERSION = 1 as const;
export const MAX_PAIRING_TTL_MS = 10 * 60 * 1000;
export const MAX_CONTROL_FRAME_BYTES = 256 * 1024;
export const MAX_PROMPT_BYTES = 256 * 1024;
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
export const MAX_ATTACHMENT_CHUNK_BYTES = 256 * 1024;
export const DEFAULT_ATTACHMENT_DEVICE_QUOTA_BYTES = 64 * 1024 * 1024;
export const DEFAULT_ATTACHMENT_CLEANUP_MS = 15 * 60 * 1000;

const ROOM_ID_RE = /^[0-9a-f]{32}$/;
const BASE64URL_32_RE = /^[A-Za-z0-9_-]{43}$/;
const IDENTIFIER_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const DECIMAL_COUNTER_RE = /^(0|[1-9][0-9]{0,19})$/;
const UINT64_MAX = 0xffff_ffff_ffff_ffffn;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export class RemoteProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RemoteProtocolError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new RemoteProtocolError(code, message);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return fail("invalid-schema", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(
  record: Record<string, unknown>,
  key: string,
  maxLength: number,
  pattern?: RegExp,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    return fail("invalid-schema", `${key} must be a non-empty string of at most ${maxLength} characters`);
  }
  if (pattern && !pattern.test(value)) {
    return fail("invalid-schema", `${key} has an invalid format`);
  }
  return value;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  maxLength: number,
  pattern?: RegExp,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > maxLength || (pattern && !pattern.test(value))) {
    return fail("invalid-schema", `${key} has an invalid format`);
  }
  return value;
}

function requiredInteger(
  record: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    return fail("invalid-schema", `${key} must be an integer between ${minimum} and ${maximum}`);
  }
  return value as number;
}

function optionalInteger(
  record: Record<string, unknown>,
  key: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (record[key] === undefined) return undefined;
  return requiredInteger(record, key, minimum, maximum);
}

function requiredBoolean(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "boolean") return fail("invalid-schema", `${key} must be a boolean`);
  return value;
}

function emptyPayload(value: unknown): Record<string, never> {
  asRecord(value, "payload");
  return {};
}

function parseStringArray(
  value: unknown,
  label: string,
  maximumItems: number,
  maximumItemLength: number,
  pattern?: RegExp,
): string[] {
  if (!Array.isArray(value) || value.length > maximumItems) {
    return fail("invalid-schema", `${label} must be an array with at most ${maximumItems} items`);
  }
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || item.length > maximumItemLength || (pattern && !pattern.test(item))) {
      return fail("invalid-schema", `${label} contains an invalid item`);
    }
    if (!seen.has(item)) {
      seen.add(item);
      result.push(item);
    }
  }
  return result;
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 12) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 256 && value.every((entry) => isJsonValue(entry, depth + 1));
  if (typeof value !== "object") return false;
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.length <= 256 && entries.every(([key, entry]) => key.length <= 128 && isJsonValue(entry, depth + 1));
}

export function parseUint64Decimal(value: string, label = "counter"): bigint {
  if (!DECIMAL_COUNTER_RE.test(value)) return fail("invalid-counter", `${label} must be a canonical uint64 decimal string`);
  const parsed = BigInt(value);
  if (parsed > UINT64_MAX) return fail("invalid-counter", `${label} exceeds uint64`);
  return parsed;
}

export function formatUint64Decimal(value: bigint | number): string {
  const parsed = typeof value === "bigint" ? value : BigInt(value);
  if (parsed < 0n || parsed > UINT64_MAX) return fail("invalid-counter", "counter is outside uint64");
  return parsed.toString(10);
}

export function isRoomId(value: string): boolean {
  return ROOM_ID_RE.test(value);
}

export function normalizeRelayUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail("invalid-relay", "relay must be an absolute URL");
  }
  if (url.username || url.password || url.search || url.hash) {
    return fail("invalid-relay", "relay credentials, query and fragment are not allowed");
  }
  const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol !== "wss:" && !(url.protocol === "ws:" && isLocal)) {
    return fail("invalid-relay", "relay must use wss://; ws:// is allowed only for localhost");
  }
  if (url.pathname !== "/" && url.pathname !== "") {
    return fail("invalid-relay", "relay URL must be an origin without a path");
  }
  return url.origin;
}

export interface PairingUri {
  protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
  relayUrl: string;
  roomId: string;
  pairingKey: Uint8Array;
  pairingKeyBase64Url: string;
  expiresAt: number;
  keyEpoch: number;
}

export interface ParsePairingUriOptions {
  nowMs?: number;
  maxFutureMs?: number;
}

function decodePairingKey(value: string): Uint8Array {
  if (!BASE64URL_32_RE.test(value)) return fail("invalid-pairing-key", "pairing key must be 32-byte unpadded base64url");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== 32 || decoded.toString("base64url") !== value) {
    return fail("invalid-pairing-key", "pairing key is not canonical base64url");
  }
  return decoded;
}

export function parsePairingUri(input: string, options: ParsePairingUriOptions = {}): PairingUri {
  if (input.length > 2048) return fail("invalid-pairing-uri", "pairing URI is too long");
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return fail("invalid-pairing-uri", "pairing URI is malformed");
  }
  if (url.protocol !== "omp-code:" || url.hostname !== "pair" || (url.pathname !== "" && url.pathname !== "/")) {
    return fail("invalid-pairing-uri", "pairing URI must use omp-code://pair");
  }
  if (url.username || url.password || url.hash) return fail("invalid-pairing-uri", "pairing URI contains forbidden components");
  const allowed = new Set(["v", "relay", "room", "key", "expires", "epoch"]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) {
      return fail("invalid-pairing-uri", `unexpected or duplicate pairing parameter: ${key}`);
    }
  }
  if ([...allowed].some((key) => !url.searchParams.has(key))) {
    return fail("invalid-pairing-uri", "pairing URI is missing required parameters");
  }
  if (url.searchParams.get("v") !== String(REMOTE_PROTOCOL_VERSION)) {
    return fail("unsupported-version", "unsupported remote protocol version");
  }
  const relayUrl = normalizeRelayUrl(url.searchParams.get("relay") ?? "");
  const roomId = url.searchParams.get("room") ?? "";
  if (!ROOM_ID_RE.test(roomId)) return fail("invalid-room", "room must be 16-byte lowercase hex");
  const pairingKeyBase64Url = url.searchParams.get("key") ?? "";
  const pairingKey = decodePairingKey(pairingKeyBase64Url);
  const expiresText = url.searchParams.get("expires") ?? "";
  if (!/^[1-9][0-9]{9,15}$/.test(expiresText)) return fail("invalid-expiry", "expires must be Unix time in milliseconds");
  const expiresAt = Number(expiresText);
  if (!Number.isSafeInteger(expiresAt)) return fail("invalid-expiry", "expires is outside the safe integer range");
  const epochText = url.searchParams.get("epoch") ?? "";
  if (!/^[1-9][0-9]{0,9}$/.test(epochText)) return fail("invalid-epoch", "epoch must be a positive uint32");
  const keyEpoch = Number(epochText);
  if (!Number.isInteger(keyEpoch) || keyEpoch > 0xffff_ffff) return fail("invalid-epoch", "epoch exceeds uint32");
  const nowMs = options.nowMs ?? Date.now();
  const maxFutureMs = options.maxFutureMs ?? MAX_PAIRING_TTL_MS;
  if (expiresAt <= nowMs) return fail("pairing-expired", "pairing URI has expired");
  if (expiresAt - nowMs > maxFutureMs) return fail("invalid-expiry", "pairing URI expiry exceeds the allowed TTL");
  return { protocolVersion: REMOTE_PROTOCOL_VERSION, relayUrl, roomId, pairingKey, pairingKeyBase64Url, expiresAt, keyEpoch };
}

export function formatPairingUri(value: Omit<PairingUri, "protocolVersion" | "pairingKeyBase64Url">): string {
  if (!ROOM_ID_RE.test(value.roomId)) return fail("invalid-room", "room must be 16-byte lowercase hex");
  if (value.pairingKey.byteLength !== 32) return fail("invalid-pairing-key", "pairing key must be 32 bytes");
  if (!Number.isSafeInteger(value.expiresAt) || value.expiresAt <= 0) return fail("invalid-expiry", "expiresAt is invalid");
  if (!Number.isInteger(value.keyEpoch) || value.keyEpoch < 1 || value.keyEpoch > 0xffff_ffff) {
    return fail("invalid-epoch", "keyEpoch must be a positive uint32");
  }
  const params = new URLSearchParams();
  params.set("v", String(REMOTE_PROTOCOL_VERSION));
  params.set("relay", normalizeRelayUrl(value.relayUrl));
  params.set("room", value.roomId);
  params.set("key", Buffer.from(value.pairingKey).toString("base64url"));
  params.set("expires", String(value.expiresAt));
  params.set("epoch", String(value.keyEpoch));
  return `omp-code://pair?${params.toString()}`;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "auto";
export type ApprovalMode = "always-ask" | "write" | "yolo";
export type ApprovalResponse =
  | { kind: "confirm"; value: boolean }
  | { kind: "select"; index: number }
  | { kind: "input"; value: string }
  | { kind: "editor"; value: string }
  | { kind: "cancel" };

export interface AttachmentStartPayload {
  attachmentId: string;
  fileName: string;
  mediaType?: string;
  totalBytes: number;
  sha256: string;
}

export interface RemoteCommandPayloadMap {
  "session.sync": Record<string, never>;
  "transcript.get": Record<string, never>;
  "prompt.send": { text: string; attachmentIds: string[]; forModel?: { provider: string; modelId: string } };
  "turn.abort": Record<string, never>;
  "approval.respond": { requestId: string; response: ApprovalResponse };
  "model.set": { provider: string; modelId: string };
  "models.probe": Record<string, never>;
  "thinking.set": { level: ThinkingLevel };
  "approval-mode.set": { mode: ApprovalMode };
  "attachment.start": AttachmentStartPayload;
  "attachment.commit": { attachmentId: string };
  "attachment.cancel": { attachmentId: string };
  "files.search": { query: string; maxResults: number };
  "diff.get": { changeId: string };
  "revert.apply": { changeId: string; expectedAfterSha256: string };
  "editor.insert": { text: string };
  "transcript.export": { format: "markdown" };
  "sessions.list": Record<string, never>;
  "session.create": { workspaceRoot?: string };
  "session.switch": { targetSessionId: string };
  "session.rename": { title: string };
  "session.reset": Record<string, never>;
  "session.compact": Record<string, never>;
  "session.restart": Record<string, never>;
  "session.close": Record<string, never>;
  "history.list": { query?: string; limit: number };
  "history.open": { sessionPath: string };
  "settings.update": { key: "defaultModel" | "thinkingLevel" | "approvalMode"; value: string };
  "profile.update": {
    family: string;
    field: "runtime.thinking" | "spawn.approvalMode";
    value: string | null;
  };
  "auth.login": { providerId: string };
  "credentials.set": { provider: string; value: string };
  "credentials.clear": { provider: string };
  "diagnostics.get": Record<string, never>;
  "remote.stop": Record<string, never>;
}

export type RemoteCommandName = keyof RemoteCommandPayloadMap;

interface RemoteCommandBase {
  protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
  type: "command";
  commandId: string;
  commandCounter: string;
  hostGeneration: string;
  sessionId?: string;
}

export type RemoteCommand = {
  [Name in RemoteCommandName]: RemoteCommandBase & {
    command: Name;
    payload: RemoteCommandPayloadMap[Name];
  };
}[RemoteCommandName];

export const REMOTE_COMMAND_ALLOWLIST: ReadonlySet<RemoteCommandName> = new Set<RemoteCommandName>([
  "session.sync", "transcript.get", "prompt.send", "turn.abort", "approval.respond", "model.set", "models.probe",
  "thinking.set", "approval-mode.set", "attachment.start", "attachment.commit", "attachment.cancel",
  "files.search", "diff.get", "revert.apply", "editor.insert", "transcript.export", "sessions.list",
  "session.create", "session.switch", "session.rename", "session.reset", "session.compact", "session.restart",
  "session.close", "history.list", "settings.update", "profile.update", "auth.login", "credentials.set", "credentials.clear", "diagnostics.get",
  "history.open", "remote.stop",
]);

function parseApprovalResponse(value: unknown): ApprovalResponse {
  const record = asRecord(value, "response");
  const kind = requiredString(record, "kind", 16);
  switch (kind) {
    case "confirm": return { kind, value: requiredBoolean(record, "value") };
    case "select": return { kind, index: requiredInteger(record, "index", 0, 1023) };
    case "input": return { kind, value: requiredString(record, "value", 64 * 1024) };
    case "editor": return { kind, value: requiredString(record, "value", 1024 * 1024) };
    case "cancel": return { kind };
    default: return fail("invalid-schema", "unsupported approval response kind");
  }
}

function parseAttachmentStart(value: unknown): AttachmentStartPayload {
  const record = asRecord(value, "payload");
  const fileName = requiredString(record, "fileName", 255);
  const windowsStem = fileName.split(".", 1)[0].toUpperCase();
  if (
    fileName !== fileName.normalize("NFC") ||
    Buffer.byteLength(fileName, "utf8") > 255 ||
    fileName === "." || fileName === ".." || fileName.endsWith(".") || fileName.endsWith(" ") ||
    /[<>:"/\\|?*\0-\x1f\x7f]/.test(fileName) ||
    /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(windowsStem)
  ) {
    return fail("invalid-attachment", "fileName must be a safe basename");
  }
  return {
    attachmentId: requiredString(record, "attachmentId", 36, UUID_RE).toLowerCase(),
    fileName,
    mediaType: optionalString(record, "mediaType", 127, /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/),
    totalBytes: requiredInteger(record, "totalBytes", 0, MAX_ATTACHMENT_BYTES),
    sha256: requiredString(record, "sha256", 64, SHA256_RE),
  };
}

function parseCommandPayload(command: RemoteCommandName, value: unknown): RemoteCommandPayloadMap[RemoteCommandName] {
  const record = asRecord(value, "payload");
  switch (command) {
    case "session.sync": case "transcript.get": case "turn.abort": case "sessions.list": case "models.probe":
    case "session.reset": case "session.compact": case "session.restart": case "session.close":
    case "diagnostics.get": case "remote.stop":
      return emptyPayload(record);
    case "prompt.send": {
      const text = record.text;
      if (typeof text !== "string" || text.length > MAX_PROMPT_BYTES) {
        return fail("invalid-schema", "text must be a string within the prompt limit");
      }
      if (Buffer.byteLength(text, "utf8") > MAX_PROMPT_BYTES) return fail("frame-too-large", "prompt exceeds byte limit");
      const attachmentIds = record.attachmentIds === undefined
        ? []
        : parseStringArray(record.attachmentIds, "attachmentIds", 32, 36, UUID_RE).map((item) => item.toLowerCase());
      if (text.length === 0 && attachmentIds.length === 0) return fail("invalid-schema", "prompt must contain text or an attachment");
      let forModel: { provider: string; modelId: string } | undefined;
      if (record.forModel !== undefined) {
        const route = asRecord(record.forModel, "forModel");
        forModel = {
          provider: requiredString(route, "provider", 128, IDENTIFIER_RE),
          modelId: requiredString(route, "modelId", 256, /^[^\0-\x1f\x7f]+$/),
        };
      }
      return { text, attachmentIds, ...(forModel === undefined ? {} : { forModel }) };
    }
    case "approval.respond": return {
      requestId: requiredString(record, "requestId", 128, IDENTIFIER_RE),
      response: parseApprovalResponse(record.response),
    };
    case "model.set": return {
      provider: requiredString(record, "provider", 128, IDENTIFIER_RE),
      modelId: requiredString(record, "modelId", 256, /^[^\0-\x1f\x7f]+$/),
    };
    case "thinking.set": {
      const level = requiredString(record, "level", 8) as ThinkingLevel;
      if (!new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]).has(level)) {
        return fail("invalid-schema", "unsupported thinking level");
      }
      return { level };
    }
    case "approval-mode.set": {
      const mode = requiredString(record, "mode", 16) as ApprovalMode;
      if (!new Set<ApprovalMode>(["always-ask", "write", "yolo"]).has(mode)) return fail("invalid-schema", "unsupported approval mode");
      return { mode };
    }
    case "attachment.start": return parseAttachmentStart(record);
    case "attachment.commit": case "attachment.cancel":
      return { attachmentId: requiredString(record, "attachmentId", 36, UUID_RE).toLowerCase() };
    case "files.search": return {
      query: requiredString(record, "query", 1024),
      maxResults: optionalInteger(record, "maxResults", 1, 200) ?? 50,
    };
    case "diff.get": return { changeId: requiredString(record, "changeId", 128, IDENTIFIER_RE) };
    case "revert.apply": return {
      changeId: requiredString(record, "changeId", 128, IDENTIFIER_RE),
      expectedAfterSha256: requiredString(record, "expectedAfterSha256", 64, SHA256_RE),
    };
    case "editor.insert": {
      const text = requiredString(record, "text", 1024 * 1024);
      if (Buffer.byteLength(text, "utf8") > 1024 * 1024) return fail("frame-too-large", "insert text exceeds byte limit");
      return { text };
    }
    case "transcript.export": {
      if (record.format !== "markdown") return fail("invalid-schema", "only markdown transcript export is supported");
      return { format: "markdown" };
    }
    case "session.create": {
      const workspaceRoot = optionalString(record, "workspaceRoot", 4096);
      return workspaceRoot === undefined ? {} : { workspaceRoot };
    }
    case "session.switch": return { targetSessionId: requiredString(record, "targetSessionId", 128, IDENTIFIER_RE) };
    case "session.rename": return { title: requiredString(record, "title", 256) };
    case "history.list": return {
      query: optionalString(record, "query", 1024),
      limit: optionalInteger(record, "limit", 1, 500) ?? 100,
    };
    case "history.open": return { sessionPath: requiredString(record, "sessionPath", 4096) };
    case "settings.update": {
      const key = requiredString(record, "key", 32);
      if (key !== "defaultModel" && key !== "thinkingLevel" && key !== "approvalMode") {
        return fail("command-not-allowed", "setting is not remotely editable");
      }
      const rawValue = record.value;
      if (typeof rawValue !== "string" || rawValue.length > 256 || /[\0-\x1f\x7f]/.test(rawValue)) {
        return fail("invalid-schema", "setting value is invalid");
      }
      if (key === "thinkingLevel" && !new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]).has(rawValue as ThinkingLevel)) {
        return fail("invalid-schema", "unsupported thinking level");
      }
      if (key === "approvalMode" && !new Set<ApprovalMode>(["always-ask", "write", "yolo"]).has(rawValue as ApprovalMode)) {
        return fail("invalid-schema", "unsupported approval mode");
      }
      return { key, value: rawValue };
    }
    case "profile.update": {
      const family = requiredString(record, "family", 128, IDENTIFIER_RE);
      const field = requiredString(record, "field", 32);
      if (field !== "runtime.thinking" && field !== "spawn.approvalMode") {
        return fail("command-not-allowed", "profile field is not remotely editable");
      }
      const value = record.value;
      if (value !== null && typeof value !== "string") {
        return fail("invalid-schema", "profile value must be a string or null");
      }
      if (field === "runtime.thinking" && value !== null &&
        !new Set(["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max", "auto"]).has(value)) {
        return fail("invalid-schema", "unsupported profile thinking value");
      }
      if (field === "spawn.approvalMode" && value !== null &&
        !new Set(["always-ask", "write", "yolo"]).has(value)) {
        return fail("invalid-schema", "unsupported profile approval mode");
      }
      return { family, field, value };
    }
    case "auth.login": {
      const providerId = requiredString(record, "providerId", 32);
      if (!LOGIN_PROVIDERS.some((entry) => entry.id === providerId && entry.remote)) {
        return fail("command-not-allowed", "provider does not support remote OAuth login");
      }
      return { providerId };
    }
    case "credentials.set": {
      const provider = requiredString(record, "provider", 128, IDENTIFIER_RE);
      if (!KEYED_PROVIDERS.some((entry) => entry.id === provider || entry.provider === provider)) {
        return fail("command-not-allowed", "provider is not in the desktop credential allowlist");
      }
      return { provider, value: requiredString(record, "value", 16 * 1024) };
    }
    case "credentials.clear": {
      const provider = requiredString(record, "provider", 128, IDENTIFIER_RE);
      if (!KEYED_PROVIDERS.some((entry) => entry.id === provider || entry.provider === provider)) {
        return fail("command-not-allowed", "provider is not in the desktop credential allowlist");
      }
      return { provider };
    }
  }
}

function decodeJsonInput(input: string | Uint8Array | unknown, maxBytes: number): unknown {
  if (typeof input !== "string" && !(input instanceof Uint8Array)) {
    let encoded: string;
    try {
      encoded = JSON.stringify(input);
    } catch {
      return fail("invalid-json", "message is not JSON serializable");
    }
    if (Buffer.byteLength(encoded, "utf8") > maxBytes) return fail("frame-too-large", "control frame exceeds byte limit");
    return input;
  }
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  if (bytes.length > maxBytes) return fail("frame-too-large", "control frame exceeds byte limit");
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    return fail("invalid-json", "control frame is malformed JSON");
  }
}

export function parseRemoteCommand(input: string | Uint8Array | unknown): RemoteCommand {
  const record = asRecord(decodeJsonInput(input, MAX_CONTROL_FRAME_BYTES), "command");
  if (record.protocolVersion !== REMOTE_PROTOCOL_VERSION) return fail("unsupported-version", "unsupported remote protocol version");
  if (record.type !== "command") return fail("invalid-schema", "message type must be command");
  const command = requiredString(record, "command", 64) as RemoteCommandName;
  if (!REMOTE_COMMAND_ALLOWLIST.has(command)) return fail("command-not-allowed", "command is not in the remote allowlist");
  const sessionId = optionalString(record, "sessionId", 128, IDENTIFIER_RE);
  const parsed = {
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    type: "command" as const,
    commandId: requiredString(record, "commandId", 36, UUID_RE).toLowerCase(),
    commandCounter: requiredString(record, "commandCounter", 20, DECIMAL_COUNTER_RE),
    hostGeneration: requiredString(record, "hostGeneration", 128, IDENTIFIER_RE),
    sessionId,
    command,
    payload: parseCommandPayload(command, record.payload),
  };
  parseUint64Decimal(parsed.commandCounter, "commandCounter");
  return parsed as RemoteCommand;
}

export type CapabilityVerb = "view" | "prompt" | "approve" | "files" | "session.manage" | "settings.manage" | "credentials.manage";

export interface CapabilityManifest {
  protocolVersion: typeof REMOTE_PROTOCOL_VERSION;
  manifestId: string;
  deviceId: string;
  keyEpoch: number;
  issuedAt: number;
  expiresAt: number;
  verbs: CapabilityVerb[];
  sessionIds: string[];
  workspaceRoots: string[];
  allSessions: boolean;
}

const CAPABILITY_VERBS: ReadonlySet<CapabilityVerb> = new Set([
  "view", "prompt", "approve", "files", "session.manage", "settings.manage", "credentials.manage",
]);

export function parseCapabilityManifest(input: unknown): CapabilityManifest {
  const record = asRecord(input, "capability manifest");
  if (record.protocolVersion !== REMOTE_PROTOCOL_VERSION) return fail("unsupported-version", "unsupported capability version");
  const verbs = parseStringArray(record.verbs, "verbs", CAPABILITY_VERBS.size, 32) as CapabilityVerb[];
  if (verbs.some((verb) => !CAPABILITY_VERBS.has(verb))) return fail("invalid-capability", "manifest contains an unknown capability verb");
  const sessionIds = parseStringArray(record.sessionIds, "sessionIds", 256, 128, IDENTIFIER_RE);
  const workspaceRoots = parseStringArray(record.workspaceRoots, "workspaceRoots", 64, 4096);
  if (workspaceRoots.some((root) => !isAbsoluteHostPath(root))) return fail("invalid-capability", "workspace roots must be absolute paths");
  const result: CapabilityManifest = {
    protocolVersion: REMOTE_PROTOCOL_VERSION,
    manifestId: requiredString(record, "manifestId", 36, UUID_RE).toLowerCase(),
    deviceId: requiredString(record, "deviceId", 128, IDENTIFIER_RE),
    keyEpoch: requiredInteger(record, "keyEpoch", 1, 0xffff_ffff),
    issuedAt: requiredInteger(record, "issuedAt", 0, Number.MAX_SAFE_INTEGER),
    expiresAt: requiredInteger(record, "expiresAt", 1, Number.MAX_SAFE_INTEGER),
    verbs,
    sessionIds,
    workspaceRoots,
    allSessions: requiredBoolean(record, "allSessions"),
  };
  if (result.expiresAt <= result.issuedAt) return fail("invalid-capability", "manifest expiry must follow issue time");
  return result;
}

export const COMMAND_CAPABILITY: Readonly<Record<RemoteCommandName, CapabilityVerb>> = {
  "session.sync": "view", "transcript.get": "view", "prompt.send": "prompt", "turn.abort": "prompt",
  "approval.respond": "approve", "model.set": "prompt", "thinking.set": "prompt", "approval-mode.set": "settings.manage",
  "models.probe": "prompt",
  "attachment.start": "files", "attachment.commit": "files", "attachment.cancel": "files", "files.search": "files",
  "diff.get": "files", "revert.apply": "files", "editor.insert": "files", "transcript.export": "view",
  "sessions.list": "session.manage", "session.create": "session.manage", "session.switch": "session.manage",
  "session.rename": "session.manage", "session.reset": "session.manage", "session.compact": "session.manage",
  "session.restart": "session.manage", "session.close": "session.manage", "history.list": "session.manage",
  "settings.update": "settings.manage", "profile.update": "settings.manage", "auth.login": "credentials.manage",
  "credentials.set": "credentials.manage", "credentials.clear": "credentials.manage",
  "history.open": "session.manage", "diagnostics.get": "view", "remote.stop": "view",
};

const SESSION_SCOPED_COMMANDS: ReadonlySet<RemoteCommandName> = new Set([
  "session.sync", "transcript.get", "prompt.send", "turn.abort", "approval.respond", "model.set", "models.probe", "thinking.set",
  "attachment.start", "attachment.commit", "attachment.cancel", "files.search", "diff.get",
  "revert.apply", "editor.insert", "transcript.export", "session.rename", "session.reset", "session.compact",
  "session.restart", "session.close", "history.open", "profile.update", "auth.login",
]);

const ALL_SESSION_COMMANDS: ReadonlySet<RemoteCommandName> = new Set([
  "sessions.list", "session.create", "session.switch", "history.list", "approval-mode.set",
]);

export interface CapabilityCheckContext {
  nowMs?: number;
  keyEpoch: number;
  workspacePath?: string;
}

export interface CapabilityDecision {
  allowed: boolean;
  reason?: "expired" | "wrong-epoch" | "missing-verb" | "missing-session" | "all-sessions-required" | "path-outside-workspace";
}

export function authorizeRemoteCommand(
  manifest: CapabilityManifest,
  command: RemoteCommand,
  context: CapabilityCheckContext,
): CapabilityDecision {
  const nowMs = context.nowMs ?? Date.now();
  if (nowMs < manifest.issuedAt || nowMs >= manifest.expiresAt) return { allowed: false, reason: "expired" };
  if (manifest.keyEpoch !== context.keyEpoch) return { allowed: false, reason: "wrong-epoch" };
  const requiredVerb = COMMAND_CAPABILITY[command.command];
  if (!manifest.verbs.includes(requiredVerb)) return { allowed: false, reason: "missing-verb" };
  if (ALL_SESSION_COMMANDS.has(command.command) && !manifest.allSessions) {
    return { allowed: false, reason: "all-sessions-required" };
  }
  if (SESSION_SCOPED_COMMANDS.has(command.command)) {
    // `allSessions` permits lifecycle commands; concrete live session ids are
    // still the signed, canonical-root-filtered set maintained by the host.
    if (!command.sessionId || !manifest.sessionIds.includes(command.sessionId)) {
      return { allowed: false, reason: "missing-session" };
    }
  }
  const workspacePaths = context.workspacePath === undefined ? [] : [context.workspacePath];
  if (command.command === "session.create" && command.payload.workspaceRoot !== undefined) {
    workspacePaths.push(command.payload.workspaceRoot);
  }
  for (const workspacePath of workspacePaths) {
    if (!isPathWithinWorkspaceRoots(workspacePath, manifest.workspaceRoots)) {
      return { allowed: false, reason: "path-outside-workspace" };
    }
  }
  return { allowed: true };
}

function isAbsoluteHostPath(value: string): boolean {
  return path.posix.isAbsolute(value) || path.win32.isAbsolute(value);
}

export function isPathWithinWorkspaceRoots(candidate: string, roots: readonly string[]): boolean {
  if (candidate.includes("\0") || !isAbsoluteHostPath(candidate)) return false;
  const windows = path.win32.isAbsolute(candidate);
  const implementation = windows ? path.win32 : path.posix;
  const normalizedCandidate = implementation.resolve(candidate);
  return roots.some((root) => {
    if (path.win32.isAbsolute(root) !== windows && path.posix.isAbsolute(root) !== !windows) return false;
    const normalizedRoot = implementation.resolve(root);
    const relative = implementation.relative(normalizedRoot, normalizedCandidate);
    const outside = relative === ".." || relative.startsWith(`..${implementation.sep}`) || implementation.isAbsolute(relative);
    return !outside;
  });
}

export type DurableCommandStatus = "accepted" | "completed" | "rejected" | "indeterminate";

export interface DurableCommandRecord {
  commandId: string;
  counter: string;
  digest: string;
  status: DurableCommandStatus;
  acceptedAt: number;
  updatedAt: number;
  result?: JsonValue;
  errorCode?: string;
}

export interface DurableDeviceCommandState {
  highWaterCounter: string | null;
  commands: Record<string, DurableCommandRecord>;
}

export interface DurableCommandState {
  keyEpoch: number;
  devices: Record<string, DurableDeviceCommandState>;
}

export type DurableCommandAction =
  | { type: "receive"; keyEpoch: number; deviceId: string; commandId: string; counter: string; digest: string; nowMs: number }
  | { type: "settle"; deviceId: string; commandId: string; status: "completed" | "rejected"; nowMs: number; result?: JsonValue; errorCode?: string }
  | { type: "recover"; nowMs: number }
  | { type: "rotate"; keyEpoch: number };

export type DurableCommandDecision =
  | { kind: "accepted"; record: DurableCommandRecord }
  | { kind: "duplicate"; record: DurableCommandRecord }
  | { kind: "replay" }
  | { kind: "conflict" }
  | { kind: "stale-epoch" }
  | { kind: "settled"; record: DurableCommandRecord }
  | { kind: "missing" }
  | { kind: "recovered"; count: number }
  | { kind: "rotated" };

export interface DurableCommandReduction {
  state: DurableCommandState;
  decision: DurableCommandDecision;
}

export function createDurableCommandState(keyEpoch: number): DurableCommandState {
  if (!Number.isInteger(keyEpoch) || keyEpoch < 1 || keyEpoch > 0xffff_ffff) return fail("invalid-epoch", "keyEpoch must be a positive uint32");
  return { keyEpoch, devices: {} };
}

/**
 * Read a previously accepted command without advancing the replay high-water
 * mark. This is intentionally narrower than `reduceDurableCommand`: it is used
 * only after a host-generation rotation so a device can learn the durable
 * outcome of the exact command that was already accepted before the restart.
 */
export function findExactDurableCommand(
  state: DurableCommandState,
  identity: {
    keyEpoch: number;
    deviceId: string;
    commandId: string;
    counter: string;
    digest: string;
  },
): DurableCommandRecord | undefined {
  if (
    identity.keyEpoch !== state.keyEpoch ||
    !IDENTIFIER_RE.test(identity.deviceId) ||
    !UUID_RE.test(identity.commandId) ||
    !DECIMAL_COUNTER_RE.test(identity.counter) ||
    !SHA256_RE.test(identity.digest)
  ) return undefined;
  try {
    parseUint64Decimal(identity.counter);
  } catch {
    return undefined;
  }
  const record = state.devices[identity.deviceId]?.commands[identity.commandId.toLowerCase()];
  if (
    !record ||
    record.status === "accepted" ||
    record.counter !== identity.counter ||
    record.digest !== identity.digest
  ) return undefined;
  return record;
}

export function reduceDurableCommand(state: DurableCommandState, action: DurableCommandAction): DurableCommandReduction {
  if (action.type === "rotate") {
    if (!Number.isInteger(action.keyEpoch) || action.keyEpoch <= state.keyEpoch || action.keyEpoch > 0xffff_ffff) {
      return { state, decision: { kind: "stale-epoch" } };
    }
    return { state: createDurableCommandState(action.keyEpoch), decision: { kind: "rotated" } };
  }
  if (action.type === "recover") {
    let count = 0;
    const devices: Record<string, DurableDeviceCommandState> = {};
    for (const [deviceId, device] of Object.entries(state.devices)) {
      const commands: Record<string, DurableCommandRecord> = {};
      for (const [commandId, record] of Object.entries(device.commands)) {
        if (record.status === "accepted") {
          commands[commandId] = { ...record, status: "indeterminate", updatedAt: action.nowMs };
          count += 1;
        } else {
          commands[commandId] = record;
        }
      }
      devices[deviceId] = { highWaterCounter: device.highWaterCounter, commands };
    }
    return { state: { ...state, devices }, decision: { kind: "recovered", count } };
  }
  if (action.type === "settle") {
    const device = state.devices[action.deviceId];
    const commandId = action.commandId.toLowerCase();
    const existing = device?.commands[commandId];
    if (!device || !existing || existing.status !== "accepted") return { state, decision: { kind: "missing" } };
    if (action.result !== undefined && !isJsonValue(action.result)) return fail("invalid-result", "durable result is not bounded JSON");
    const record: DurableCommandRecord = {
      ...existing,
      status: action.status,
      updatedAt: action.nowMs,
      result: action.result,
      errorCode: action.errorCode,
    };
    return {
      state: {
        ...state,
        devices: {
          ...state.devices,
          [action.deviceId]: { ...device, commands: { ...device.commands, [commandId]: record } },
        },
      },
      decision: { kind: "settled", record },
    };
  }
  if (action.keyEpoch !== state.keyEpoch) return { state, decision: { kind: "stale-epoch" } };
  if (!IDENTIFIER_RE.test(action.deviceId) || !UUID_RE.test(action.commandId) || !SHA256_RE.test(action.digest)) {
    return fail("invalid-command", "durable command identity or digest is invalid");
  }
  const counter = parseUint64Decimal(action.counter);
  const commandId = action.commandId.toLowerCase();
  const device = state.devices[action.deviceId] ?? { highWaterCounter: null, commands: {} };
  const sameId = device.commands[commandId];
  if (sameId) {
    if (sameId.counter === action.counter && sameId.digest === action.digest) {
      return { state, decision: { kind: "duplicate", record: sameId } };
    }
    return { state, decision: { kind: "conflict" } };
  }
  if (device.highWaterCounter !== null && counter <= parseUint64Decimal(device.highWaterCounter)) {
    return { state, decision: { kind: "replay" } };
  }
  const record: DurableCommandRecord = {
    commandId,
    counter: action.counter,
    digest: action.digest,
    status: "accepted",
    acceptedAt: action.nowMs,
    updatedAt: action.nowMs,
  };
  const nextDevice: DurableDeviceCommandState = {
    highWaterCounter: action.counter,
    commands: { ...device.commands, [record.commandId]: record },
  };
  return {
    state: { ...state, devices: { ...state.devices, [action.deviceId]: nextDevice } },
    decision: { kind: "accepted", record },
  };
}

export const ATTACHMENT_CHUNK_HEADER_BYTES = 36;
const ATTACHMENT_CHUNK_MAGIC = Buffer.from("OMPA", "ascii");

export interface AttachmentChunk {
  attachmentId: string;
  offset: bigint;
  data: Uint8Array;
}

function uuidToBytes(value: string): Buffer {
  if (!UUID_RE.test(value)) return fail("invalid-attachment", "attachmentId must be a UUID");
  return Buffer.from(value.replaceAll("-", ""), "hex");
}

function bytesToUuid(value: Uint8Array): string {
  const hex = Buffer.from(value).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function encodeAttachmentChunk(chunk: AttachmentChunk): Uint8Array {
  if (chunk.data.byteLength === 0) return fail("invalid-attachment-chunk", "attachment chunk must not be empty");
  if (chunk.data.byteLength > MAX_ATTACHMENT_CHUNK_BYTES) return fail("attachment-chunk-too-large", "attachment chunk exceeds 256 KiB");
  if (chunk.offset < 0n || chunk.offset > UINT64_MAX) return fail("invalid-attachment-offset", "attachment offset is outside uint64");
  const frame = Buffer.allocUnsafe(ATTACHMENT_CHUNK_HEADER_BYTES + chunk.data.byteLength);
  ATTACHMENT_CHUNK_MAGIC.copy(frame, 0);
  frame.writeUInt8(REMOTE_PROTOCOL_VERSION, 4);
  frame.writeUInt8(0, 5);
  frame.writeUInt16BE(ATTACHMENT_CHUNK_HEADER_BYTES, 6);
  uuidToBytes(chunk.attachmentId).copy(frame, 8);
  frame.writeBigUInt64BE(chunk.offset, 24);
  frame.writeUInt32BE(chunk.data.byteLength, 32);
  Buffer.from(chunk.data).copy(frame, ATTACHMENT_CHUNK_HEADER_BYTES);
  return frame;
}

export function decodeAttachmentChunk(frame: Uint8Array): AttachmentChunk {
  const bytes = Buffer.from(frame);
  if (bytes.length < ATTACHMENT_CHUNK_HEADER_BYTES) return fail("invalid-attachment-chunk", "attachment chunk is truncated");
  if (!bytes.subarray(0, 4).equals(ATTACHMENT_CHUNK_MAGIC)) return fail("invalid-attachment-chunk", "attachment chunk magic is invalid");
  if (bytes.readUInt8(4) !== REMOTE_PROTOCOL_VERSION) return fail("unsupported-version", "attachment chunk version is unsupported");
  if (bytes.readUInt8(5) !== 0 || bytes.readUInt16BE(6) !== ATTACHMENT_CHUNK_HEADER_BYTES) {
    return fail("invalid-attachment-chunk", "attachment chunk header flags or length are invalid");
  }
  const length = bytes.readUInt32BE(32);
  if (length === 0) return fail("invalid-attachment-chunk", "attachment chunk must not be empty");
  if (length > MAX_ATTACHMENT_CHUNK_BYTES) return fail("attachment-chunk-too-large", "attachment chunk exceeds 256 KiB");
  if (bytes.length !== ATTACHMENT_CHUNK_HEADER_BYTES + length) return fail("invalid-attachment-chunk", "attachment chunk length does not match frame");
  return {
    attachmentId: bytesToUuid(bytes.subarray(8, 24)),
    offset: bytes.readBigUInt64BE(24),
    data: bytes.subarray(ATTACHMENT_CHUNK_HEADER_BYTES),
  };
}

export interface AttachmentTransfer {
  meta: AttachmentStartPayload;
  nextOffset: number;
  startedAt: number;
  updatedAt: number;
}

export interface AttachmentBookState {
  active: Record<string, AttachmentTransfer>;
}

export type AttachmentBookAction =
  | { type: "start"; meta: AttachmentStartPayload; nowMs: number }
  | { type: "chunk"; chunk: AttachmentChunk; nowMs: number }
  | { type: "commit"; attachmentId: string; actualSha256: string; nowMs: number }
  | { type: "cancel"; attachmentId: string }
  | { type: "cleanup"; nowMs: number; timeoutMs?: number };

export type AttachmentBookDecision =
  | { kind: "started" | "chunk-accepted" | "committed" | "cancelled" }
  | { kind: "duplicate" }
  | { kind: "missing" }
  | { kind: "quota-exceeded" }
  | { kind: "offset-mismatch"; expectedOffset: number }
  | { kind: "incomplete"; expectedOffset: number }
  | { kind: "hash-mismatch" }
  | { kind: "cleaned"; attachmentIds: string[] };

export interface AttachmentBookReduction {
  state: AttachmentBookState;
  decision: AttachmentBookDecision;
}

export function createAttachmentBookState(): AttachmentBookState {
  return { active: {} };
}

export function reduceAttachmentBook(
  state: AttachmentBookState,
  action: AttachmentBookAction,
  quotaBytes = DEFAULT_ATTACHMENT_DEVICE_QUOTA_BYTES,
): AttachmentBookReduction {
  if (action.type === "start") {
    const meta = parseAttachmentStart(action.meta);
    if (state.active[meta.attachmentId]) return { state, decision: { kind: "duplicate" } };
    const reserved = Object.values(state.active).reduce((sum, transfer) => sum + transfer.meta.totalBytes, 0);
    if (reserved + meta.totalBytes > quotaBytes) return { state, decision: { kind: "quota-exceeded" } };
    const transfer: AttachmentTransfer = { meta, nextOffset: 0, startedAt: action.nowMs, updatedAt: action.nowMs };
    return {
      state: { active: { ...state.active, [meta.attachmentId]: transfer } },
      decision: { kind: "started" },
    };
  }
  if (action.type === "cleanup") {
    const timeoutMs = action.timeoutMs ?? DEFAULT_ATTACHMENT_CLEANUP_MS;
    const active: Record<string, AttachmentTransfer> = {};
    const attachmentIds: string[] = [];
    for (const [id, transfer] of Object.entries(state.active)) {
      if (action.nowMs - transfer.updatedAt >= timeoutMs) attachmentIds.push(id);
      else active[id] = transfer;
    }
    return { state: { active }, decision: { kind: "cleaned", attachmentIds } };
  }
  const id = action.type === "chunk" ? action.chunk.attachmentId.toLowerCase() : action.attachmentId.toLowerCase();
  const transfer = state.active[id];
  if (!transfer) return { state, decision: { kind: "missing" } };
  if (action.type === "cancel") {
    const active = { ...state.active };
    delete active[id];
    return { state: { active }, decision: { kind: "cancelled" } };
  }
  if (action.type === "chunk") {
    if (action.chunk.data.byteLength === 0) return fail("invalid-attachment-chunk", "attachment chunk must not be empty");
    if (action.chunk.data.byteLength > MAX_ATTACHMENT_CHUNK_BYTES) return fail("attachment-chunk-too-large", "attachment chunk exceeds 256 KiB");
    if (action.chunk.offset !== BigInt(transfer.nextOffset)) {
      return { state, decision: { kind: "offset-mismatch", expectedOffset: transfer.nextOffset } };
    }
    const nextOffset = transfer.nextOffset + action.chunk.data.byteLength;
    if (nextOffset > transfer.meta.totalBytes) return fail("invalid-attachment-chunk", "attachment chunk exceeds declared total size");
    return {
      state: {
        active: {
          ...state.active,
          [id]: { ...transfer, nextOffset, updatedAt: action.nowMs },
        },
      },
      decision: { kind: "chunk-accepted" },
    };
  }
  if (transfer.nextOffset !== transfer.meta.totalBytes) {
    return { state, decision: { kind: "incomplete", expectedOffset: transfer.nextOffset } };
  }
  if (!SHA256_RE.test(action.actualSha256) || action.actualSha256 !== transfer.meta.sha256) {
    return { state, decision: { kind: "hash-mismatch" } };
  }
  const active = { ...state.active };
  delete active[id];
  return { state: { active }, decision: { kind: "committed" } };
}

export function sha256Chunks(chunks: readonly Uint8Array[]): string {
  const hash = createHash("sha256");
  for (const chunk of chunks) hash.update(chunk);
  return hash.digest("hex");
}
