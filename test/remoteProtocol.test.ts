import { test } from "node:test";
import assert from "node:assert/strict";
import {
  authorizeRemoteCommand,
  createAttachmentBookState,
  createDurableCommandState,
  decodeAttachmentChunk,
  encodeAttachmentChunk,
  findExactDurableCommand,
  formatPairingUri,
  isPathWithinWorkspaceRoots,
  MAX_ATTACHMENT_CHUNK_BYTES,
  parseCapabilityManifest,
  parsePairingUri,
  parseRemoteCommand,
  reduceAttachmentBook,
  reduceDurableCommand,
  RemoteProtocolError,
  sha256Chunks,
} from "../src/remoteProtocol.ts";
import type {
  AttachmentBookState,
  AttachmentStartPayload,
  CapabilityManifest,
  RemoteCommand,
} from "../src/remoteProtocol.ts";

const COMMAND_ID = "123e4567-e89b-42d3-a456-426614174000";
const COMMAND_ID_2 = "223e4567-e89b-42d3-a456-426614174001";
const ATTACHMENT_ID = "323e4567-e89b-42d3-a456-426614174002";
const ROOM_ID = "00112233445566778899aabbccddeeff";
const PAIRING_KEY = Buffer.from(Array.from({ length: 32 }, (_, index) => index));

function command(commandName: string, payload: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    protocolVersion: 1,
    type: "command",
    commandId: COMMAND_ID,
    commandCounter: "1",
    hostGeneration: "host-generation-1",
    sessionId: "session-1",
    command: commandName,
    payload,
    ...extra,
  };
}

function expectProtocolError(fn: () => unknown, code: string): void {
  assert.throws(fn, (error: unknown) => error instanceof RemoteProtocolError && error.code === code);
}

test("pairing URI round-trips canonical fields and normalizes https to wss", () => {
  const nowMs = 2_000_000_000_000;
  const uri = formatPairingUri({
    relayUrl: "https://relay.example.test",
    roomId: ROOM_ID,
    pairingKey: PAIRING_KEY,
    expiresAt: nowMs + 600_000,
    keyEpoch: 7,
  });
  assert.match(uri, /^omp-code:\/\/pair\?/);
  const parsed = parsePairingUri(uri, { nowMs });
  assert.equal(parsed.protocolVersion, 1);
  assert.equal(parsed.relayUrl, "wss://relay.example.test");
  assert.equal(parsed.roomId, ROOM_ID);
  assert.deepEqual(parsed.pairingKey, PAIRING_KEY);
  assert.equal(parsed.pairingKeyBase64Url, PAIRING_KEY.toString("base64url"));
  assert.equal(parsed.expiresAt, nowMs + 600_000);
  assert.equal(parsed.keyEpoch, 7);
});

test("pairing parser rejects expired, overlong, duplicate and unknown fields", () => {
  const nowMs = 2_000_000_000_000;
  const base = formatPairingUri({
    relayUrl: "wss://relay.example.test",
    roomId: ROOM_ID,
    pairingKey: PAIRING_KEY,
    expiresAt: nowMs + 1,
    keyEpoch: 1,
  });
  expectProtocolError(() => parsePairingUri(base, { nowMs: nowMs + 1 }), "pairing-expired");
  expectProtocolError(() => parsePairingUri(`${base}&room=${ROOM_ID}`, { nowMs }), "invalid-pairing-uri");
  expectProtocolError(() => parsePairingUri(`${base}&admin=true`, { nowMs }), "invalid-pairing-uri");
  expectProtocolError(() => parsePairingUri(base.replace("expires=2000000000001", "expires=2000001000000"), { nowMs }), "invalid-expiry");
});

test("pairing parser permits local ws but rejects insecure remote ws and relay paths", () => {
  const nowMs = 2_000_000_000_000;
  const local = formatPairingUri({
    relayUrl: "ws://127.0.0.1:8080",
    roomId: ROOM_ID,
    pairingKey: PAIRING_KEY,
    expiresAt: nowMs + 10_000,
    keyEpoch: 1,
  });
  assert.equal(parsePairingUri(local, { nowMs }).relayUrl, "ws://127.0.0.1:8080");
  expectProtocolError(() => formatPairingUri({
    relayUrl: "ws://relay.example.test",
    roomId: ROOM_ID,
    pairingKey: PAIRING_KEY,
    expiresAt: nowMs + 1,
    keyEpoch: 1,
  }), "invalid-relay");
  expectProtocolError(() => formatPairingUri({
    relayUrl: "wss://relay.example.test/base",
    roomId: ROOM_ID,
    pairingKey: PAIRING_KEY,
    expiresAt: nowMs + 1,
    keyEpoch: 1,
  }), "invalid-relay");
});

test("command parser uses a closed allowlist and removes unknown optional fields", () => {
  const parsed = parseRemoteCommand(command("prompt.send", {
    text: "hello",
    attachmentIds: [],
    ignoredFutureField: true,
  }, { ignoredTopLevel: "value" }));
  assert.equal(parsed.command, "prompt.send");
  assert.deepEqual(parsed.payload, { text: "hello", attachmentIds: [] });
  assert.equal("ignoredTopLevel" in parsed, false);
  expectProtocolError(() => parseRemoteCommand(command("omp.raw-rpc", {})), "command-not-allowed");
  expectProtocolError(() => parseRemoteCommand("{not-json"), "invalid-json");
  expectProtocolError(() => parseRemoteCommand({ ...command("turn.abort", {}), protocolVersion: 2 }), "unsupported-version");
});

test("prompt permits attachments-only but rejects a completely empty send", () => {
  const parsed = parseRemoteCommand(command("prompt.send", { text: "", attachmentIds: [ATTACHMENT_ID] }));
  assert.deepEqual(parsed.payload, { text: "", attachmentIds: [ATTACHMENT_ID] });
  expectProtocolError(() => parseRemoteCommand(command("prompt.send", { text: "", attachmentIds: [] })), "invalid-schema");
});

test("prompt route and history open use closed validated payloads", () => {
  assert.deepEqual(parseRemoteCommand(command("prompt.send", {
    text: "route this",
    attachmentIds: [],
    forModel: { provider: "anthropic", modelId: "claude-sonnet" },
  })).payload, {
    text: "route this",
    attachmentIds: [],
    forModel: { provider: "anthropic", modelId: "claude-sonnet" },
  });
  expectProtocolError(() => parseRemoteCommand(command("prompt.send", {
    text: "bad route", attachmentIds: [], forModel: { provider: "", modelId: "model" },
  })), "invalid-schema");
  assert.deepEqual(parseRemoteCommand(command("history.open", { sessionPath: "/allowed/session.jsonl" })).payload, {
    sessionPath: "/allowed/session.jsonl",
  });
});

test("command-specific schemas require provider/model and constrain approvals/settings", () => {
  assert.deepEqual(
    parseRemoteCommand(command("model.set", { provider: "anthropic", modelId: "claude-sonnet" })).payload,
    { provider: "anthropic", modelId: "claude-sonnet" },
  );
  expectProtocolError(() => parseRemoteCommand(command("model.set", { modelId: "ambiguous" })), "invalid-schema");
  expectProtocolError(
    () => parseRemoteCommand(command("approval.respond", { requestId: "req-1", response: { kind: "select", index: -1 } })),
    "invalid-schema",
  );
  expectProtocolError(
    () => parseRemoteCommand(command("settings.update", { key: "ompPath", value: "/tmp/evil" })),
    "command-not-allowed",
  );
  expectProtocolError(
    () => parseRemoteCommand(command("settings.update", { key: "approvalMode", value: "unrestricted" })),
    "invalid-schema",
  );
  assert.equal(parseRemoteCommand(command("models.probe", {})).command, "models.probe");
  assert.deepEqual(parseRemoteCommand(command("auth.login", { providerId: "kimi-code" })).payload, {
    providerId: "kimi-code",
  });
  expectProtocolError(() => parseRemoteCommand(command("auth.login", { providerId: "evil-provider" })), "command-not-allowed");
  assert.deepEqual(parseRemoteCommand(command("profile.update", {
    family: "claude",
    field: "runtime.thinking",
    value: "xhigh",
  })).payload, { family: "claude", field: "runtime.thinking", value: "xhigh" });
  expectProtocolError(() => parseRemoteCommand(command("profile.update", {
    family: "claude", field: "spawn.overlay", value: "raw yaml",
  })), "command-not-allowed");
  expectProtocolError(() => parseRemoteCommand(command("credentials.set", {
    provider: "arbitrary-secret-slot", value: "secret",
  })), "command-not-allowed");
});

function manifest(overrides: Partial<CapabilityManifest> = {}): CapabilityManifest {
  return parseCapabilityManifest({
    protocolVersion: 1,
    manifestId: "423e4567-e89b-42d3-a456-426614174003",
    deviceId: "phone-1",
    keyEpoch: 3,
    issuedAt: 100,
    expiresAt: 10_000,
    verbs: ["view", "prompt", "approve", "files"],
    sessionIds: ["session-1"],
    workspaceRoots: ["/workspace/project"],
    allSessions: false,
    ...overrides,
  });
}

test("capability checks are host-authoritative for verb, session, epoch and path", () => {
  const prompt = parseRemoteCommand(command("prompt.send", { text: "hi", attachmentIds: [] }));
  const policy = manifest();
  assert.deepEqual(authorizeRemoteCommand(policy, prompt, {
    nowMs: 500,
    keyEpoch: 3,
    workspacePath: "/workspace/project/src/a.ts",
  }), { allowed: true });
  assert.equal(authorizeRemoteCommand(policy, prompt, { nowMs: 500, keyEpoch: 4 }).reason, "wrong-epoch");
  assert.equal(authorizeRemoteCommand(policy, prompt, { nowMs: 10_000, keyEpoch: 3 }).reason, "expired");
  assert.equal(authorizeRemoteCommand(policy, prompt, {
    nowMs: 500,
    keyEpoch: 3,
    workspacePath: "/workspace/project/../secret.txt",
  }).reason, "path-outside-workspace");
  const anotherSession = { ...prompt, sessionId: "session-2" } as RemoteCommand;
  assert.equal(authorizeRemoteCommand(policy, anotherSession, { nowMs: 500, keyEpoch: 3 }).reason, "missing-session");
});

test("default capability cannot elevate to global/session/settings/credentials control", () => {
  const policy = manifest();
  const list = parseRemoteCommand(command("sessions.list", {}, { sessionId: undefined }));
  assert.equal(authorizeRemoteCommand(policy, list, { nowMs: 500, keyEpoch: 3 }).reason, "missing-verb");
  const approvalMode = parseRemoteCommand(command("approval-mode.set", { mode: "yolo" }, { sessionId: undefined }));
  assert.equal(authorizeRemoteCommand(policy, approvalMode, { nowMs: 500, keyEpoch: 3 }).reason, "missing-verb");
  const credentials = parseRemoteCommand(command("credentials.set", { provider: "anthropic", value: "secret" }, { sessionId: undefined }));
  assert.equal(authorizeRemoteCommand(policy, credentials, { nowMs: 500, keyEpoch: 3 }).reason, "missing-verb");
  const selfRevoke = parseRemoteCommand(command("remote.stop", {}, { sessionId: undefined }));
  assert.deepEqual(authorizeRemoteCommand(policy, selfRevoke, { nowMs: 500, keyEpoch: 3 }), { allowed: true });

  const settingsOnly = manifest({ verbs: ["settings.manage"], allSessions: false });
  assert.equal(authorizeRemoteCommand(settingsOnly, approvalMode, { nowMs: 500, keyEpoch: 3 }).reason, "all-sessions-required");

  const fullSessions = manifest({ verbs: ["session.manage"], allSessions: true });
  const outsideCreate = parseRemoteCommand(command("session.create", { workspaceRoot: "/outside/project" }, { sessionId: undefined }));
  assert.equal(authorizeRemoteCommand(fullSessions, outsideCreate, { nowMs: 500, keyEpoch: 3 }).reason, "path-outside-workspace");
  const outsideSwitchTarget = parseRemoteCommand(command("session.close", {}, { sessionId: "outside-session" }));
  assert.equal(authorizeRemoteCommand(fullSessions, outsideSwitchTarget, { nowMs: 500, keyEpoch: 3 }).reason, "missing-session");
});

test("workspace path containment blocks traversal and prefix confusion on POSIX and Windows", () => {
  assert.equal(isPathWithinWorkspaceRoots("/work/repo/a.ts", ["/work/repo"]), true);
  assert.equal(isPathWithinWorkspaceRoots("/work/repository/a.ts", ["/work/repo"]), false);
  assert.equal(isPathWithinWorkspaceRoots("/work/repo/../../etc/passwd", ["/work/repo"]), false);
  assert.equal(isPathWithinWorkspaceRoots("C:\\Work\\Repo\\src\\a.ts", ["C:\\Work\\Repo"]), true);
  assert.equal(isPathWithinWorkspaceRoots("C:\\Work\\Other\\a.ts", ["C:\\Work\\Repo"]), false);
  assert.equal(isPathWithinWorkspaceRoots("relative/a.ts", ["/work/repo"]), false);
});

test("durable reducer accepts once, returns terminal duplicate metadata and rejects replay/conflict", () => {
  const digest = "a".repeat(64);
  let state = createDurableCommandState(3);
  const initialState = state;
  let reduction = reduceDurableCommand(state, {
    type: "receive",
    keyEpoch: 3,
    deviceId: "phone-1",
    commandId: COMMAND_ID.toUpperCase(),
    counter: "5",
    digest,
    nowMs: 100,
  });
  assert.equal(reduction.decision.kind, "accepted");
  state = reduction.state;
  assert.deepEqual(initialState, { keyEpoch: 3, devices: {} }, "reducer must not mutate its input");

  reduction = reduceDurableCommand(state, {
    type: "receive", keyEpoch: 3, deviceId: "phone-1", commandId: COMMAND_ID,
    counter: "5", digest, nowMs: 101,
  });
  assert.equal(reduction.decision.kind, "duplicate", "UUID case cannot bypass duplicate detection");

  reduction = reduceDurableCommand(state, {
    type: "settle", deviceId: "phone-1", commandId: COMMAND_ID.toUpperCase(), status: "completed",
    nowMs: 110, result: { delivered: true },
  });
  assert.equal(reduction.decision.kind, "settled");
  state = reduction.state;

  reduction = reduceDurableCommand(state, {
    type: "receive", keyEpoch: 3, deviceId: "phone-1", commandId: COMMAND_ID,
    counter: "5", digest, nowMs: 120,
  });
  assert.equal(reduction.decision.kind, "duplicate");
  if (reduction.decision.kind === "duplicate") {
    assert.equal(reduction.decision.record.status, "completed");
    assert.deepEqual(reduction.decision.record.result, { delivered: true });
  }

  assert.equal(reduceDurableCommand(state, {
    type: "receive", keyEpoch: 3, deviceId: "phone-1", commandId: COMMAND_ID_2,
    counter: "4", digest, nowMs: 120,
  }).decision.kind, "replay");
  assert.equal(reduceDurableCommand(state, {
    type: "receive", keyEpoch: 3, deviceId: "phone-1", commandId: COMMAND_ID,
    counter: "6", digest: "b".repeat(64), nowMs: 120,
  }).decision.kind, "conflict");
});

test("durable reducer marks crash-boundary work indeterminate and clears state only on epoch rotation", () => {
  const digest = "c".repeat(64);
  let state = reduceDurableCommand(createDurableCommandState(7), {
    type: "receive", keyEpoch: 7, deviceId: "phone-1", commandId: COMMAND_ID,
    counter: "0", digest, nowMs: 10,
  }).state;
  let reduction = reduceDurableCommand(state, { type: "recover", nowMs: 20 });
  assert.deepEqual(reduction.decision, { kind: "recovered", count: 1 });
  state = reduction.state;
  assert.equal(state.devices["phone-1"].commands[COMMAND_ID].status, "indeterminate");
  assert.equal(reduceDurableCommand(state, {
    type: "settle", deviceId: "phone-1", commandId: COMMAND_ID, status: "completed", nowMs: 30,
  }).decision.kind, "missing", "indeterminate commands cannot be re-dispatched or optimistically completed");
  assert.equal(reduceDurableCommand(state, {
    type: "receive", keyEpoch: 6, deviceId: "phone-1", commandId: COMMAND_ID_2,
    counter: "1", digest, nowMs: 40,
  }).decision.kind, "stale-epoch");
  reduction = reduceDurableCommand(state, { type: "rotate", keyEpoch: 8 });
  assert.equal(reduction.decision.kind, "rotated");
  assert.deepEqual(reduction.state, { keyEpoch: 8, devices: {} });
});

test("host restart can read only an exact terminal durable command without mutating replay state", () => {
  const digest = "d".repeat(64);
  let state = reduceDurableCommand(createDurableCommandState(9), {
    type: "receive", keyEpoch: 9, deviceId: "phone-1", commandId: COMMAND_ID,
    counter: "17", digest, nowMs: 10,
  }).state;
  assert.equal(findExactDurableCommand(state, {
    keyEpoch: 9, deviceId: "phone-1", commandId: COMMAND_ID,
    counter: "17", digest,
  }), undefined, "live accepted work must not be acknowledged through the restart-only lookup");

  state = reduceDurableCommand(state, { type: "recover", nowMs: 20 }).state;
  const snapshot = structuredClone(state);
  const recovered = findExactDurableCommand(state, {
    keyEpoch: 9, deviceId: "phone-1", commandId: COMMAND_ID.toUpperCase(),
    counter: "17", digest,
  });
  assert.equal(recovered?.status, "indeterminate");
  assert.deepEqual(state, snapshot, "restart lookup must be read-only");
  assert.equal(findExactDurableCommand(state, {
    keyEpoch: 9, deviceId: "phone-1", commandId: COMMAND_ID,
    counter: "18", digest,
  }), undefined);
  assert.equal(findExactDurableCommand(state, {
    keyEpoch: 9, deviceId: "phone-1", commandId: COMMAND_ID,
    counter: "17", digest: "e".repeat(64),
  }), undefined);
  assert.equal(findExactDurableCommand(state, {
    keyEpoch: 10, deviceId: "phone-1", commandId: COMMAND_ID,
    counter: "17", digest,
  }), undefined);
});

test("attachment chunk binary framing guards length, id and offset", () => {
  const encoded = encodeAttachmentChunk({ attachmentId: ATTACHMENT_ID, offset: 42n, data: Buffer.from("abc") });
  const decoded = decodeAttachmentChunk(encoded);
  assert.equal(decoded.attachmentId, ATTACHMENT_ID);
  assert.equal(decoded.offset, 42n);
  assert.equal(Buffer.from(decoded.data).toString("utf8"), "abc");
  expectProtocolError(() => decodeAttachmentChunk(encoded.subarray(0, encoded.length - 1)), "invalid-attachment-chunk");
  expectProtocolError(() => encodeAttachmentChunk({
    attachmentId: ATTACHMENT_ID,
    offset: 0n,
    data: new Uint8Array(MAX_ATTACHMENT_CHUNK_BYTES + 1),
  }), "attachment-chunk-too-large");
  expectProtocolError(() => encodeAttachmentChunk({ attachmentId: ATTACHMENT_ID, offset: 0n, data: new Uint8Array() }), "invalid-attachment-chunk");
});

function attachmentMeta(data: Uint8Array): AttachmentStartPayload {
  return {
    attachmentId: ATTACHMENT_ID,
    fileName: "photo.jpg",
    mediaType: "image/jpeg",
    totalBytes: data.byteLength,
    sha256: sha256Chunks([data]),
  };
}

test("attachment reducer enforces ordered resume, declared total and final SHA-256", () => {
  const data = Buffer.from("abcdef");
  const meta = attachmentMeta(data);
  let state = reduceAttachmentBook(createAttachmentBookState(), { type: "start", meta, nowMs: 0 }).state;
  let reduction = reduceAttachmentBook(state, {
    type: "chunk", chunk: { attachmentId: ATTACHMENT_ID, offset: 3n, data: data.subarray(3) }, nowMs: 1,
  });
  assert.deepEqual(reduction.decision, { kind: "offset-mismatch", expectedOffset: 0 });

  reduction = reduceAttachmentBook(state, {
    type: "chunk", chunk: { attachmentId: ATTACHMENT_ID, offset: 0n, data: data.subarray(0, 3) }, nowMs: 2,
  });
  assert.equal(reduction.decision.kind, "chunk-accepted");
  state = reduction.state;
  assert.deepEqual(reduceAttachmentBook(state, {
    type: "commit", attachmentId: ATTACHMENT_ID, actualSha256: meta.sha256, nowMs: 3,
  }).decision, { kind: "incomplete", expectedOffset: 3 });

  state = reduceAttachmentBook(state, {
    type: "chunk", chunk: { attachmentId: ATTACHMENT_ID, offset: 3n, data: data.subarray(3) }, nowMs: 4,
  }).state;
  assert.equal(reduceAttachmentBook(state, {
    type: "commit", attachmentId: ATTACHMENT_ID, actualSha256: "0".repeat(64), nowMs: 5,
  }).decision.kind, "hash-mismatch");
  reduction = reduceAttachmentBook(state, {
    type: "commit", attachmentId: ATTACHMENT_ID, actualSha256: meta.sha256, nowMs: 6,
  });
  assert.equal(reduction.decision.kind, "committed");
  assert.deepEqual(reduction.state, { active: {} });
});

test("attachment reducer enforces quota, cancel and cleanup timeout", () => {
  const data = Buffer.from("12345");
  const meta = attachmentMeta(data);
  const overQuota = reduceAttachmentBook(createAttachmentBookState(), { type: "start", meta, nowMs: 0 }, 4);
  assert.equal(overQuota.decision.kind, "quota-exceeded");

  let state: AttachmentBookState = reduceAttachmentBook(createAttachmentBookState(), { type: "start", meta, nowMs: 0 }).state;
  let reduction = reduceAttachmentBook(state, { type: "cancel", attachmentId: ATTACHMENT_ID });
  assert.equal(reduction.decision.kind, "cancelled");
  assert.deepEqual(reduction.state, { active: {} });

  state = reduceAttachmentBook(createAttachmentBookState(), { type: "start", meta, nowMs: 100 }).state;
  reduction = reduceAttachmentBook(state, { type: "cleanup", nowMs: 1_100, timeoutMs: 1_000 });
  assert.deepEqual(reduction.decision, { kind: "cleaned", attachmentIds: [ATTACHMENT_ID] });
  assert.deepEqual(reduction.state, { active: {} });
});
