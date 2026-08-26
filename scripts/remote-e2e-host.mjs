#!/usr/bin/env node

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { lstat, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
  canonicalJsonBytes,
  deriveConnectionTrafficKey,
  deriveDirectionalKey,
  deriveEnrolmentCounter,
  derivePairRequestCounter,
  handshakeProof,
  openEnvelope,
  randomHandshakeNonce,
  randomPairingKey,
  ReplayCounterGuard,
  rotateRemoteSecrets,
  sealEnvelope,
  signCapabilityManifest,
  verifyCapabilityManifestSignature,
  verifyHandshakeProof,
} from "../src/remoteCrypto.ts";
import {
  credentialDigest,
  encodeRemoteHandshakeFrame,
  parseRemoteHandshakeFrame,
} from "../src/remoteHandshake.ts";
import {
  formatPairingUri,
  parseCapabilityManifest,
  parsePairingUri,
  REMOTE_PROTOCOL_VERSION,
} from "../src/remoteProtocol.ts";
import { planRemoteFullSync } from "../src/remoteSync.ts";
import { parseDeviceControlFrame } from "../src/remoteTransport.ts";
import { createBlindRelay, WebSocket } from "../remote-relay/relay.mjs";

export const E2E_SESSION_ID = "remote-e2e-session";
const E2E_WORKSPACE = "/tmp/omp-remote-e2e";
const DEFAULT_TIMEOUT_MS = 180_000;
const MIN_TIMEOUT_MS = 2_000;
const MAX_TIMEOUT_MS = 10 * 60_000;
const PAIRING_TTL_MS = 10 * 60_000;
const HARNESS_COMMANDS = new Set(["session.sync", "prompt.send"]);

function harnessCommand(value) {
  if (!HARNESS_COMMANDS.has(value)) throw new Error("--command must be session.sync or prompt.send");
  return value;
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function redactedId(value) {
  if (!value) return undefined;
  return `sha256:${createHash("sha256").update(String(value)).digest("hex").slice(0, 12)}`;
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && timingSafeEqual(a, b);
}

function machineLogger(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function websocketOpen(url) {
  return new Promise((resolvePromise, reject) => {
    const socket = new WebSocket(url, { perMessageDeflate: false });
    const onError = (error) => {
      socket.off("open", onOpen);
      reject(error);
    };
    const onOpen = () => {
      socket.off("error", onError);
      resolvePromise(socket);
    };
    socket.once("error", onError);
    socket.once("open", onOpen);
  });
}

function sendWebSocket(socket, value) {
  return new Promise((resolvePromise, reject) => {
    if (socket.readyState !== WebSocket.OPEN) {
      reject(new Error("relay socket is not open"));
      return;
    }
    socket.send(value, { binary: true }, (error) => error ? reject(error) : resolvePromise());
  });
}

async function writePairingLink(target, pairingUri) {
  if (!isAbsolute(target)) throw new Error("pairing link path must be absolute");
  const resolvedTarget = resolve(target);
  const parent = await realpath(resolve(resolvedTarget, ".."));
  const rootCandidates = [...new Set([tmpdir(), ...(process.platform === "win32" ? [] : ["/tmp"])])];
  const temporaryRoots = [];
  for (const candidate of rootCandidates) {
    try {
      temporaryRoots.push(await realpath(candidate));
    } catch {
      // A platform need not provide every conventional temporary root.
    }
  }
  const insideTemporaryRoot = temporaryRoots.some((temporaryRoot) => {
    const fromTemporaryRoot = relative(temporaryRoot, parent);
    return fromTemporaryRoot === "" || (!isAbsolute(fromTemporaryRoot) && fromTemporaryRoot !== ".." && !fromTemporaryRoot.startsWith(`..${sep}`));
  });
  if (!insideTemporaryRoot) {
    throw new Error("pairing link path must be inside the system temporary directory");
  }
  try {
    await lstat(resolvedTarget);
    throw new Error("pairing link target already exists");
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "ENOENT")) throw error;
  }
  await writeFile(resolvedTarget, `${pairingUri}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return resolvedTarget;
}

function createSessionSummary() {
  return {
    id: E2E_SESSION_ID,
    title: "Android live E2E",
    cwd: E2E_WORKSPACE,
    model: "e2e-harness",
    provider: "local",
    status: "idle",
    cost: 0,
    closable: false,
  };
}

function createSessionSnapshot() {
  return {
    session: createSessionSummary(),
    state: { model: { provider: "local", id: "e2e-harness" }, streaming: false },
    models: [{ provider: "local", id: "e2e-harness", name: "E2E harness" }],
    commands: [],
    transcript: [{ role: "assistant", content: "Encrypted Android Remote Control E2E harness connected." }],
    stats: { cost: 0 },
    approvalMode: "always-ask",
    profile: null,
    configuration: { defaultModel: "local/e2e-harness", thinkingLevel: "auto", theme: "violet" },
    approvals: [],
  };
}

function resultPromise() {
  let resolveResult;
  const promise = new Promise((resolvePromise) => {
    resolveResult = resolvePromise;
  });
  return { promise, resolve: resolveResult };
}

/**
 * A deliberately small host authority for live Android protocol verification.
 * It never starts VS Code or OMP and it never executes a phone prompt.
 */
export class RemoteE2EHost {
  constructor(options = {}) {
    this.port = options.port ?? 0;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.writeLinkPath = options.writeLinkPath;
    this.expectedCommand = harnessCommand(options.expectedCommand ?? "session.sync");
    this.log = options.logger ?? machineLogger;
    if (!Number.isInteger(this.port) || this.port < 0 || this.port > 65_535) throw new Error("port must be between 0 and 65535");
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < MIN_TIMEOUT_MS || this.timeoutMs > MAX_TIMEOUT_MS) {
      throw new Error(`timeout must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS} milliseconds`);
    }

    this.relay = undefined;
    this.socket = undefined;
    this.phase = "starting";
    this.closed = false;
    this.finished = false;
    this.incomingQueue = Promise.resolve();
    this.timeout = undefined;
    this.resultState = resultPromise();
    this.pairingKey = randomPairingKey();
    this.secrets = rotateRemoteSecrets(0);
    this.pairingExpiresAt = Date.now() + Math.min(PAIRING_TTL_MS, Math.max(120_000, this.timeoutMs + 30_000));
    this.pairingUri = undefined;
    this.linkPath = undefined;
    this.pending = undefined;
    this.device = undefined;
    this.connection = undefined;
    this.eventSequence = 0n;
    this.highestEventAck = 0n;
    this.successPending = undefined;
    this.commandRecords = new Map();
  }

  async start() {
    this.relay = createBlindRelay({ maxGuestsPerRoom: 1 });
    const address = await this.relay.listen(this.port, "127.0.0.1");
    if (!address || typeof address === "string") throw new Error("relay did not return a TCP address");
    const relayOrigin = `ws://127.0.0.1:${address.port}`;
    this.pairingUri = formatPairingUri({
      relayUrl: relayOrigin,
      roomId: this.secrets.roomId,
      pairingKey: this.pairingKey,
      expiresAt: this.pairingExpiresAt,
      keyEpoch: this.secrets.keyEpoch,
    });
    if (this.writeLinkPath) this.linkPath = await writePairingLink(this.writeLinkPath, this.pairingUri);
    this.socket = await websocketOpen(`${relayOrigin}/r/${this.secrets.roomId}?role=host`);
    this.socket.on("message", (data, isBinary) => {
      this.incomingQueue = this.incomingQueue
        .then(() => this.handleRelayMessage(Buffer.from(data), isBinary))
        .catch(() => this.fail("protocol-error"));
    });
    this.socket.on("error", () => this.fail("relay-error"));
    this.socket.on("close", () => {
      if (!this.closed && !this.finished) this.fail("relay-closed");
    });
    this.phase = "await-pair";
    this.timeout = setTimeout(() => this.finish({
      status: "timeout",
      phase: this.phase,
      room: redactedId(this.secrets.roomId),
      device: redactedId(this.device?.deviceId),
    }), this.timeoutMs);
    this.timeout.unref?.();
    this.log({
      type: "remote-e2e",
      status: "ready",
      port: address.port,
      linkPath: this.linkPath,
      room: redactedId(this.secrets.roomId),
      timeoutMs: this.timeoutMs,
      expectedCommand: this.expectedCommand,
      adbReverse: `tcp:${address.port}`,
    });
    return { port: address.port, relayOrigin, pairingUri: this.pairingUri, linkPath: this.linkPath };
  }

  waitForResult() {
    return this.resultState.promise;
  }

  pairKey(direction) {
    return deriveDirectionalKey(this.pairingKey, {
      roomId: this.secrets.roomId,
      keyEpoch: this.secrets.keyEpoch,
      purpose: "pair",
      direction,
    });
  }

  authKey(direction) {
    return deriveDirectionalKey(this.secrets.deviceToken, {
      roomId: this.secrets.roomId,
      keyEpoch: this.secrets.keyEpoch,
      purpose: "auth",
      direction,
    });
  }

  makeCapability(deviceId) {
    const now = Date.now();
    return parseCapabilityManifest({
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      manifestId: randomUUID(),
      deviceId,
      keyEpoch: this.secrets.keyEpoch,
      issuedAt: now,
      expiresAt: now + 60 * 60_000,
      verbs: ["view", "prompt", "approve", "files", "session.manage", "settings.manage", "credentials.manage"],
      sessionIds: [E2E_SESSION_ID],
      workspaceRoots: [E2E_WORKSPACE],
      allSessions: true,
    });
  }

  capabilitySignature(capability) {
    return signCapabilityManifest(this.authKey("host-to-device"), capability);
  }

  async handleRelayMessage(data, isBinary) {
    if (!isBinary) {
      const control = JSON.parse(data.toString("utf8"));
      if (control.t === "peer-left" && !this.successPending) this.phase = "await-reconnect";
      return;
    }
    if (data.byteLength < 32) throw new Error("wire frame is truncated");
    const peerId = data.readUInt32BE(0);
    if (this.phase === "await-pair") {
      await this.handlePair(data, peerId);
      return;
    }
    if (this.phase === "await-enrolled-ack") {
      const digest = createHash("sha256").update(data.subarray(4)).digest("hex");
      if (this.pending?.pairCipherDigest === digest) {
        await sendWebSocket(this.socket, this.pending.enrolledEnvelope);
        return;
      }
      await this.handleEnrolledAck(data, peerId);
      return;
    }
    if (this.phase === "await-hello") {
      await this.handleHello(data, peerId);
      return;
    }
    if (this.phase === "await-proof") {
      await this.handleProof(data, peerId);
      return;
    }
    if (this.phase === "active" || this.phase === "await-command-event-ack") {
      await this.handleActive(data, peerId);
      return;
    }
    throw new Error("wire frame arrived in an invalid phase");
  }

  async handlePair(frame, peerId) {
    if (Date.now() >= this.pairingExpiresAt) throw new Error("pairing expired");
    const opened = openEnvelope(frame, {
      key: this.pairKey("device-to-host"),
      roomId: this.secrets.roomId,
      keyEpoch: this.secrets.keyEpoch,
      direction: "device-to-host",
      aadPeerId: 0,
      expectedEnvelopePeerId: peerId,
    });
    const pair = parseRemoteHandshakeFrame(opened.plaintext);
    if (pair.type !== "pair") throw new Error("expected pair frame");
    if (opened.counter !== derivePairRequestCounter(Buffer.from(pair.deviceNonce, "base64url"))) {
      throw new Error("pair counter is invalid");
    }
    const capability = this.makeCapability(pair.deviceId);
    const capabilitySignature = this.capabilitySignature(capability);
    const enrolmentId = randomUUID();
    const enrolled = encodeRemoteHandshakeFrame({
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      type: "enrolled",
      enrolmentId,
      deviceId: pair.deviceId,
      assignedPeerId: peerId,
      roomMasterKey: base64Url(this.secrets.roomMasterKey),
      deviceToken: base64Url(this.secrets.deviceToken),
      keyEpoch: this.secrets.keyEpoch,
      hostGeneration: this.secrets.hostGeneration,
      capability,
      capabilitySignature,
    });
    const enrolledEnvelope = sealEnvelope({
      key: this.pairKey("host-to-device"),
      roomId: this.secrets.roomId,
      keyEpoch: this.secrets.keyEpoch,
      direction: "host-to-device",
      peerId,
      envelopePeerId: peerId,
      counter: deriveEnrolmentCounter(peerId),
      plaintext: enrolled,
    });
    this.pending = {
      pairCipherDigest: createHash("sha256").update(frame.subarray(4)).digest("hex"),
      peerId,
      pair,
      enrolmentId,
      capability,
      capabilitySignature,
      enrolledEnvelope,
    };
    this.phase = "await-enrolled-ack";
    await sendWebSocket(this.socket, enrolledEnvelope);
  }

  async handleEnrolledAck(frame, peerId) {
    const pending = this.pending;
    if (!pending || pending.peerId !== peerId) throw new Error("unknown enrolment acknowledgement");
    const opened = openEnvelope(frame, {
      key: this.pairKey("device-to-host"),
      roomId: this.secrets.roomId,
      keyEpoch: this.secrets.keyEpoch,
      direction: "device-to-host",
      aadPeerId: peerId,
      expectedEnvelopePeerId: peerId,
    });
    if (opened.counter !== deriveEnrolmentCounter(peerId)) throw new Error("enrolment acknowledgement counter is invalid");
    const ack = parseRemoteHandshakeFrame(opened.plaintext);
    if (ack.type !== "enrolled-ack" || ack.deviceId !== pending.pair.deviceId || ack.enrolmentId !== pending.enrolmentId) {
      throw new Error("enrolment acknowledgement does not match");
    }
    const expectedDigest = credentialDigest(
      this.secrets.roomId,
      this.secrets.keyEpoch,
      pending.pair.deviceId,
      base64Url(this.secrets.roomMasterKey),
      base64Url(this.secrets.deviceToken),
    );
    if (!safeEqual(ack.credentialDigest, expectedDigest)) throw new Error("credential digest mismatch");
    this.device = {
      deviceId: pending.pair.deviceId,
      deviceName: pending.pair.deviceName,
      capability: pending.capability,
      capabilitySignature: pending.capabilitySignature,
    };
    this.phase = "await-hello";
  }

  async handleHello(frame, peerId) {
    if (!this.device) throw new Error("device is not enrolled");
    const authIncoming = new ReplayCounterGuard();
    const opened = openEnvelope(frame, {
      key: this.authKey("device-to-host"),
      roomId: this.secrets.roomId,
      keyEpoch: this.secrets.keyEpoch,
      direction: "device-to-host",
      aadPeerId: 0,
      expectedEnvelopePeerId: peerId,
      replayGuard: authIncoming,
    });
    const hello = parseRemoteHandshakeFrame(opened.plaintext);
    if (hello.type !== "hello" || hello.deviceId !== this.device.deviceId || !safeEqual(hello.deviceToken, base64Url(this.secrets.deviceToken))) {
      throw new Error("hello credential mismatch");
    }
    if (hello.hostGeneration !== undefined && hello.hostGeneration !== this.secrets.hostGeneration) {
      throw new Error("hello generation mismatch");
    }
    const hostNonce = randomHandshakeNonce();
    const challenge = {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      type: "challenge",
      connectionId: randomUUID(),
      deviceId: this.device.deviceId,
      assignedPeerId: peerId,
      deviceNonce: hello.deviceNonce,
      hostNonce: base64Url(hostNonce),
      hostGeneration: this.secrets.hostGeneration,
      keyEpoch: this.secrets.keyEpoch,
    };
    const deviceNonce = Buffer.from(hello.deviceNonce, "base64url");
    const trafficDeviceToHost = deriveConnectionTrafficKey(this.secrets.roomMasterKey, {
      roomId: this.secrets.roomId,
      keyEpoch: this.secrets.keyEpoch,
      direction: "device-to-host",
      hostNonce,
      deviceNonce,
    });
    const trafficHostToDevice = deriveConnectionTrafficKey(this.secrets.roomMasterKey, {
      roomId: this.secrets.roomId,
      keyEpoch: this.secrets.keyEpoch,
      direction: "host-to-device",
      hostNonce,
      deviceNonce,
    });
    this.connection = {
      peerId,
      hello,
      challenge,
      trafficDeviceToHost,
      trafficHostToDevice,
      incoming: new ReplayCounterGuard(),
      outgoingCounter: 0n,
    };
    const encrypted = sealEnvelope({
      key: this.authKey("host-to-device"),
      roomId: this.secrets.roomId,
      keyEpoch: this.secrets.keyEpoch,
      direction: "host-to-device",
      peerId,
      envelopePeerId: peerId,
      counter: 0n,
      plaintext: encodeRemoteHandshakeFrame(challenge),
    });
    this.phase = "await-proof";
    await sendWebSocket(this.socket, encrypted);
  }

  async handleProof(frame, peerId) {
    const connection = this.connection;
    if (!connection || connection.peerId !== peerId || !this.device) throw new Error("unknown proof peer");
    const opened = openEnvelope(frame, {
      key: connection.trafficDeviceToHost,
      roomId: this.secrets.roomId,
      keyEpoch: this.secrets.keyEpoch,
      direction: "device-to-host",
      expectedEnvelopePeerId: peerId,
      replayGuard: connection.incoming,
    });
    if (opened.counter !== 0n) throw new Error("proof counter is invalid");
    const proof = parseRemoteHandshakeFrame(opened.plaintext);
    if (proof.type !== "proof" || proof.connectionId !== connection.challenge.connectionId) throw new Error("proof connection mismatch");
    const transcript = canonicalJsonBytes([connection.hello, connection.challenge]);
    if (!verifyHandshakeProof(this.authKey("device-to-host"), transcript, Buffer.from(proof.proof, "base64url"))) {
      throw new Error("proof verification failed");
    }
    const welcome = encodeRemoteHandshakeFrame({
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      type: "welcome",
      connectionId: connection.challenge.connectionId,
      hostGeneration: this.secrets.hostGeneration,
      sequence: this.eventSequence.toString(),
      capability: this.device.capability,
      capabilitySignature: this.device.capabilitySignature,
    });
    const welcomeEnvelope = sealEnvelope({
      key: connection.trafficHostToDevice,
      roomId: this.secrets.roomId,
      keyEpoch: this.secrets.keyEpoch,
      direction: "host-to-device",
      peerId,
      envelopePeerId: peerId,
      counter: 0n,
      plaintext: welcome,
    });
    connection.outgoingCounter = 1n;
    this.phase = "active";
    await sendWebSocket(this.socket, welcomeEnvelope);
    await this.sendInitialState();
  }

  async sendTrafficJson(value) {
    const connection = this.connection;
    if (!connection) throw new Error("traffic keys are unavailable");
    const counter = connection.outgoingCounter;
    connection.outgoingCounter += 1n;
    const frame = sealEnvelope({
      key: connection.trafficHostToDevice,
      roomId: this.secrets.roomId,
      keyEpoch: this.secrets.keyEpoch,
      direction: "host-to-device",
      peerId: connection.peerId,
      envelopePeerId: connection.peerId,
      counter,
      plaintext: Buffer.from(JSON.stringify(value), "utf8"),
    });
    await sendWebSocket(this.socket, frame);
  }

  async sendEvent(event, payload, sessionId) {
    this.eventSequence += 1n;
    const sequence = this.eventSequence;
    await this.sendTrafficJson({
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      type: "event",
      hostGeneration: this.secrets.hostGeneration,
      sequence: sequence.toString(),
      eventId: randomUUID(),
      ...(sessionId === undefined ? {} : { sessionId }),
      event,
      payload,
    });
    return sequence;
  }

  async sendInitialState() {
    const summary = createSessionSummary();
    await this.sendEvent("session-board", { sessions: [summary], selectedSessionId: E2E_SESSION_ID });
    await this.sendPhasedFullSync();
  }

  async sendPhasedFullSync() {
    const packets = planRemoteFullSync(
      randomUUID(),
      [{ sessionId: E2E_SESSION_ID, snapshot: createSessionSnapshot() }],
      E2E_SESSION_ID,
    );
    for (const packet of packets) await this.sendEvent("full-sync", packet.payload, packet.sessionId);
  }

  async sendCommandAck(command, status, result, errorCode, message) {
    await this.sendTrafficJson({
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      type: "command-ack",
      hostGeneration: this.secrets.hostGeneration,
      commandId: command.commandId,
      status,
      ...(result === undefined ? {} : { result }),
      ...(errorCode === undefined ? {} : { errorCode }),
      ...(message === undefined ? {} : { message }),
    });
  }

  async handleActive(frame, peerId) {
    const connection = this.connection;
    if (!connection || connection.peerId !== peerId) throw new Error("unknown active peer");
    const opened = openEnvelope(frame, {
      key: connection.trafficDeviceToHost,
      roomId: this.secrets.roomId,
      keyEpoch: this.secrets.keyEpoch,
      direction: "device-to-host",
      expectedEnvelopePeerId: peerId,
      replayGuard: connection.incoming,
    });
    const control = parseDeviceControlFrame(opened.plaintext);
    if (control.type === "event-ack") {
      if (control.hostGeneration !== this.secrets.hostGeneration) throw new Error("event acknowledgement generation mismatch");
      const sequence = BigInt(control.sequence);
      if (sequence > this.eventSequence) throw new Error("event acknowledgement is ahead of host state");
      if (sequence > this.highestEventAck) this.highestEventAck = sequence;
      if (this.successPending && sequence >= this.successPending.eventSequence) {
        this.finish({
          status: "success",
          command: this.successPending.command,
          room: redactedId(this.secrets.roomId),
          device: redactedId(this.device?.deviceId),
          peer: redactedId(peerId),
          eventSequence: sequence.toString(),
        });
      }
      return;
    }
    if (control.type === "ping") {
      await this.sendTrafficJson({ protocolVersion: REMOTE_PROTOCOL_VERSION, type: "pong", nonce: control.nonce });
      return;
    }
    if (control.type === "pong") return;
    if (control.hostGeneration !== this.secrets.hostGeneration) {
      await this.sendCommandAck(control, "rejected", undefined, "wrong-generation", "Host generation changed");
      return;
    }
    if (control.sessionId !== E2E_SESSION_ID || (control.command !== "session.sync" && control.command !== "prompt.send")) {
      await this.sendCommandAck(control, "rejected", undefined, "harness-command-not-supported", "Live harness accepts only session.sync or prompt.send");
      return;
    }
    const prior = this.commandRecords.get(control.commandId);
    if (prior) {
      await this.sendCommandAck(control, "completed", prior.result);
      return;
    }
    await this.sendCommandAck(control, "accepted");
    const result = control.command === "session.sync" ? { syncQueued: true } : { accepted: true, executed: false };
    this.commandRecords.set(control.commandId, { result });
    if (control.command === "session.sync") await this.sendPhasedFullSync();
    await this.sendCommandAck(control, "completed", result);
    const eventSequence = control.command === "prompt.send"
      ? await this.sendEvent("session-message", {
          t: "frame",
          frame: {
            type: "notice",
            level: "info",
            message: "Phone prompt reached the encrypted E2E host; OMP execution is intentionally disabled in this harness.",
          },
        }, E2E_SESSION_ID)
      : await this.sendEvent("remote-status", { transport: "connected", harness: true });
    if (!this.successPending && control.command === this.expectedCommand) {
      this.successPending = { command: control.command, eventSequence };
      this.phase = "await-command-event-ack";
    }
  }

  fail(errorCode) {
    this.finish({
      status: "error",
      errorCode,
      phase: this.phase,
      room: redactedId(this.secrets.roomId),
      device: redactedId(this.device?.deviceId),
    });
  }

  finish(result) {
    if (this.finished) return;
    this.finished = true;
    if (this.timeout) clearTimeout(this.timeout);
    this.log({ type: "remote-e2e", ...result });
    this.resultState.resolve(result);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    if (this.timeout) clearTimeout(this.timeout);
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) this.socket.terminate();
    if (this.relay) await this.relay.close();
    this.pairingKey.fill(0);
    this.secrets.roomMasterKey.fill(0);
    this.secrets.deviceToken.fill(0);
  }
}

class SocketInbox {
  constructor(socket) {
    this.socket = socket;
    this.queue = [];
    this.waiters = [];
    socket.on("message", (data, isBinary) => {
      const item = { data: Buffer.from(data), isBinary };
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(item);
      else this.queue.push(item);
    });
    socket.on("close", (code) => {
      for (const waiter of this.waiters.splice(0)) waiter.reject(new Error(`guest socket closed (${code})`));
    });
    socket.on("error", (error) => {
      for (const waiter of this.waiters.splice(0)) waiter.reject(error);
    });
  }

  next(timeoutMs = 5_000) {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolvePromise, reject) => {
      const entry = {
        resolve: (value) => {
          clearTimeout(timer);
          resolvePromise(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(entry);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("timed out waiting for guest frame"));
      }, timeoutMs);
      this.waiters.push(entry);
    });
  }

  async nextBinary(timeoutMs = 5_000) {
    while (true) {
      const item = await this.next(timeoutMs);
      if (item.isBinary) return item.data;
    }
  }
}

/** In-process Android-shaped guest used by the addressable harness test. */
export async function runSyntheticGuest(pairingUri, options = {}) {
  const parsed = parsePairingUri(pairingUri);
  const deviceId = options.deviceId ?? `synthetic-${randomUUID()}`;
  const socket = await websocketOpen(`${parsed.relayUrl}/r/${parsed.roomId}?role=guest`);
  const inbox = new SocketInbox(socket);
  try {
    const deviceNonce = randomHandshakeNonce();
    const pair = {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      type: "pair",
      deviceId,
      deviceName: "Synthetic Android",
      deviceNonce: base64Url(deviceNonce),
    };
    const pairD2H = deriveDirectionalKey(parsed.pairingKey, {
      roomId: parsed.roomId,
      keyEpoch: parsed.keyEpoch,
      purpose: "pair",
      direction: "device-to-host",
    });
    await sendWebSocket(socket, sealEnvelope({
      key: pairD2H,
      roomId: parsed.roomId,
      keyEpoch: parsed.keyEpoch,
      direction: "device-to-host",
      peerId: 0,
      envelopePeerId: 0,
      counter: derivePairRequestCounter(deviceNonce),
      plaintext: encodeRemoteHandshakeFrame(pair),
    }));

    const enrolledEnvelope = await inbox.nextBinary();
    const peerId = enrolledEnvelope.readUInt32BE(0);
    const pairH2D = deriveDirectionalKey(parsed.pairingKey, {
      roomId: parsed.roomId,
      keyEpoch: parsed.keyEpoch,
      purpose: "pair",
      direction: "host-to-device",
    });
    const enrolledOpened = openEnvelope(enrolledEnvelope, {
      key: pairH2D,
      roomId: parsed.roomId,
      keyEpoch: parsed.keyEpoch,
      direction: "host-to-device",
      expectedEnvelopePeerId: peerId,
    });
    if (enrolledOpened.counter !== deriveEnrolmentCounter(peerId)) throw new Error("synthetic enrolled counter mismatch");
    const enrolled = parseRemoteHandshakeFrame(enrolledOpened.plaintext);
    if (enrolled.type !== "enrolled" || enrolled.deviceId !== deviceId || enrolled.assignedPeerId !== peerId) {
      throw new Error("synthetic enrolled frame mismatch");
    }
    const token = Buffer.from(enrolled.deviceToken, "base64url");
    const signatureKey = deriveDirectionalKey(token, {
      roomId: parsed.roomId,
      keyEpoch: parsed.keyEpoch,
      purpose: "auth",
      direction: "host-to-device",
    });
    if (!verifyCapabilityManifestSignature(signatureKey, enrolled.capability, enrolled.capabilitySignature)) {
      throw new Error("synthetic capability signature mismatch");
    }
    const ack = {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      type: "enrolled-ack",
      enrolmentId: enrolled.enrolmentId,
      deviceId,
      credentialDigest: credentialDigest(parsed.roomId, parsed.keyEpoch, deviceId, enrolled.roomMasterKey, enrolled.deviceToken),
    };
    await sendWebSocket(socket, sealEnvelope({
      key: pairD2H,
      roomId: parsed.roomId,
      keyEpoch: parsed.keyEpoch,
      direction: "device-to-host",
      peerId,
      envelopePeerId: 0,
      counter: deriveEnrolmentCounter(peerId),
      plaintext: encodeRemoteHandshakeFrame(ack),
    }));

    const helloNonce = randomHandshakeNonce();
    const hello = {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      type: "hello",
      deviceId,
      deviceToken: enrolled.deviceToken,
      deviceNonce: base64Url(helloNonce),
      hostGeneration: enrolled.hostGeneration,
      lastSequence: "0",
      clientVersion: "android-e2e",
    };
    const authD2H = deriveDirectionalKey(token, {
      roomId: parsed.roomId,
      keyEpoch: parsed.keyEpoch,
      purpose: "auth",
      direction: "device-to-host",
    });
    await sendWebSocket(socket, sealEnvelope({
      key: authD2H,
      roomId: parsed.roomId,
      keyEpoch: parsed.keyEpoch,
      direction: "device-to-host",
      peerId: 0,
      envelopePeerId: 0,
      counter: 0n,
      plaintext: encodeRemoteHandshakeFrame(hello),
    }));

    const challengeEnvelope = await inbox.nextBinary();
    const authH2D = deriveDirectionalKey(token, {
      roomId: parsed.roomId,
      keyEpoch: parsed.keyEpoch,
      purpose: "auth",
      direction: "host-to-device",
    });
    const challengeOpened = openEnvelope(challengeEnvelope, {
      key: authH2D,
      roomId: parsed.roomId,
      keyEpoch: parsed.keyEpoch,
      direction: "host-to-device",
      expectedEnvelopePeerId: peerId,
    });
    const challenge = parseRemoteHandshakeFrame(challengeOpened.plaintext);
    if (challenge.type !== "challenge" || challenge.deviceNonce !== hello.deviceNonce) throw new Error("synthetic challenge mismatch");
    const hostNonce = Buffer.from(challenge.hostNonce, "base64url");
    const master = Buffer.from(enrolled.roomMasterKey, "base64url");
    const trafficD2H = deriveConnectionTrafficKey(master, {
      roomId: parsed.roomId,
      keyEpoch: parsed.keyEpoch,
      direction: "device-to-host",
      hostNonce,
      deviceNonce: helloNonce,
    });
    const trafficH2D = deriveConnectionTrafficKey(master, {
      roomId: parsed.roomId,
      keyEpoch: parsed.keyEpoch,
      direction: "host-to-device",
      hostNonce,
      deviceNonce: helloNonce,
    });
    const proofBytes = handshakeProof(authD2H, canonicalJsonBytes([hello, challenge]));
    await sendWebSocket(socket, sealEnvelope({
      key: trafficD2H,
      roomId: parsed.roomId,
      keyEpoch: parsed.keyEpoch,
      direction: "device-to-host",
      peerId,
      envelopePeerId: 0,
      counter: 0n,
      plaintext: encodeRemoteHandshakeFrame({
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        type: "proof",
        connectionId: challenge.connectionId,
        proof: base64Url(proofBytes),
      }),
    }));

    const hostIncoming = new ReplayCounterGuard();
    const welcomeEnvelope = await inbox.nextBinary();
    const welcomeOpened = openEnvelope(welcomeEnvelope, {
      key: trafficH2D,
      roomId: parsed.roomId,
      keyEpoch: parsed.keyEpoch,
      direction: "host-to-device",
      expectedEnvelopePeerId: peerId,
      replayGuard: hostIncoming,
    });
    const welcome = parseRemoteHandshakeFrame(welcomeOpened.plaintext);
    if (welcome.type !== "welcome" || welcome.connectionId !== challenge.connectionId) throw new Error("synthetic welcome mismatch");

    let outgoingCounter = 1n;
    let sawBoard = false;
    let sawFullSyncComplete = false;
    const sendDeviceJson = async (value) => {
      const counter = outgoingCounter;
      outgoingCounter += 1n;
      await sendWebSocket(socket, sealEnvelope({
        key: trafficD2H,
        roomId: parsed.roomId,
        keyEpoch: parsed.keyEpoch,
        direction: "device-to-host",
        peerId,
        envelopePeerId: 0,
        counter,
        plaintext: Buffer.from(JSON.stringify(value), "utf8"),
      }));
    };
    const readHostJson = async () => {
      const envelope = await inbox.nextBinary();
      const opened = openEnvelope(envelope, {
        key: trafficH2D,
        roomId: parsed.roomId,
        keyEpoch: parsed.keyEpoch,
        direction: "host-to-device",
        expectedEnvelopePeerId: peerId,
        replayGuard: hostIncoming,
      });
      return JSON.parse(Buffer.from(opened.plaintext).toString("utf8"));
    };
    while (!sawBoard || !sawFullSyncComplete) {
      const value = await readHostJson();
      if (value.type !== "event") continue;
      if (value.event === "session-board") sawBoard = true;
      if (value.event === "full-sync" && value.payload?.phase === "complete") sawFullSyncComplete = true;
      await sendDeviceJson({
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        type: "event-ack",
        hostGeneration: welcome.hostGeneration,
        sequence: value.sequence,
      });
    }

    const commandNames = options.commands ?? [options.command ?? "session.sync"];
    if (!Array.isArray(commandNames) || commandNames.length === 0 || commandNames.some((command) => !HARNESS_COMMANDS.has(command))) {
      throw new Error("synthetic commands must contain only session.sync or prompt.send");
    }
    const commandResults = [];
    for (let commandIndex = 0; commandIndex < commandNames.length; commandIndex += 1) {
      const commandId = randomUUID();
      const commandName = commandNames[commandIndex];
      const command = {
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        type: "command",
        commandId,
        commandCounter: String(commandIndex + 1),
        hostGeneration: welcome.hostGeneration,
        sessionId: E2E_SESSION_ID,
        command: commandName,
        payload: commandName === "prompt.send" ? { text: "synthetic live E2E", attachmentIds: [] } : {},
      };
      await sendDeviceJson(command);
      const statuses = new Set();
      let sawPostCommandEvent = false;
      let sawFreshFullSyncComplete = false;
      while (!statuses.has("accepted") || !statuses.has("completed") || !sawPostCommandEvent) {
        const value = await readHostJson();
        if (value.type === "command-ack" && value.commandId === commandId) statuses.add(value.status);
        if (value.type === "event") {
          if (value.event === "full-sync" && value.payload?.phase === "complete") sawFreshFullSyncComplete = true;
          await sendDeviceJson({
            protocolVersion: REMOTE_PROTOCOL_VERSION,
            type: "event-ack",
            hostGeneration: welcome.hostGeneration,
            sequence: value.sequence,
          });
          // Resync packets intentionally precede the terminal ACK. Success is
          // gated on a distinct event observed after `completed`.
          if (statuses.has("completed")) sawPostCommandEvent = true;
        }
      }
      commandResults.push({ command: commandName, statuses: [...statuses], sawPostCommandEvent, sawFreshFullSyncComplete });
    }
    const finalCommand = commandResults.at(-1);
    return {
      statuses: finalCommand.statuses,
      sawBoard,
      sawFullSyncComplete,
      sawPostCommandEvent: finalCommand.sawPostCommandEvent,
      commandResults,
    };
  } finally {
    if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    parsed.pairingKey.fill(0);
  }
}

export function parseCliArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (argument === "--write-link") {
      options.writeLinkPath = argv[++index];
      if (!options.writeLinkPath) throw new Error("--write-link requires a path");
      continue;
    }
    if (argument === "--port") {
      options.port = Number(argv[++index]);
      continue;
    }
    if (argument === "--timeout-ms") {
      options.timeoutMs = Number(argv[++index]);
      continue;
    }
    if (argument === "--command") {
      options.expectedCommand = harnessCommand(argv[++index]);
      continue;
    }
    throw new Error("unknown command-line option");
  }
  if (!options.writeLinkPath) throw new Error("--write-link is required for CLI use");
  return options;
}

async function runCli() {
  let host;
  let signalCode = 0;
  try {
    const options = parseCliArguments(process.argv.slice(2));
    if (options.help) {
      process.stdout.write("Usage: node --experimental-strip-types scripts/remote-e2e-host.mjs --write-link /safe/temp/dir/pairing.txt [--port 8787] [--timeout-ms 180000] [--command session.sync|prompt.send]\n");
      return;
    }
    host = new RemoteE2EHost(options);
    const onSignal = (signal) => {
      signalCode = signal === "SIGINT" ? 130 : 143;
      host.finish({ status: "interrupted", signal });
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    await host.start();
    const result = await host.waitForResult();
    if (result.status !== "success") process.exitCode = signalCode || 1;
  } catch {
    machineLogger({ type: "remote-e2e", status: "error", errorCode: "startup-failed" });
    process.exitCode = 1;
  } finally {
    await host?.close().catch(() => {});
  }
}

const invokedAsScript = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (invokedAsScript) await runCli();
