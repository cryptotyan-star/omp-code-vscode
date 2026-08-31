import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import QRCode from "qrcode";
import * as vscode from "vscode";
import { safeFileName, type Attachment } from "./attachments";
import { OmpSession, type RemoteSessionMessage } from "./ompSession";
import { KEYED_PROVIDERS } from "./providers";
import {
  createAttachmentBookState,
  createDurableCommandState,
  decodeAttachmentChunk,
  findExactDurableCommand,
  formatPairingUri,
  formatUint64Decimal,
  normalizeRelayUrl,
  parseCapabilityManifest,
  reduceAttachmentBook,
  reduceDurableCommand,
  sha256Chunks,
  authorizeRemoteCommand,
  DEFAULT_ATTACHMENT_CLEANUP_MS,
  REMOTE_PROTOCOL_VERSION,
  type AttachmentBookState,
  type CapabilityManifest,
  type CapabilityVerb,
  type DurableCommandRecord,
  type DurableCommandState,
  type JsonValue,
  type RemoteCommand,
} from "./remoteProtocol.ts";
import {
  canonicalJsonBytes,
  deriveConnectionTrafficKey,
  deriveDirectionalKey,
  deriveEnrolmentCounter,
  derivePairRequestCounter,
  digestRemoteCommand,
  openEnvelope,
  randomHandshakeNonce,
  randomPairingKey,
  ReplayCounterGuard,
  rotateRemoteSecrets,
  sealEnvelope,
  signCapabilityManifest,
  verifyHandshakeProof,
} from "./remoteCrypto.ts";
import {
  credentialDigest,
  encodeRemoteHandshakeFrame,
  parseRemoteHandshakeFrame,
  type ChallengeFrame,
  type HelloFrame,
} from "./remoteHandshake.ts";
import {
  parseDeviceControlFrame,
  RemoteRelayTransport,
  type RemoteCommandAckFrame,
  type RemoteHostEventFrame,
  type RemoteTransportStatus,
} from "./remoteTransport.ts";
import { listSessions } from "./sessions";
import { t } from "./l10n.ts";
import { filterRemoteSessionMessage } from "./remoteEventFilter.ts";
import { requireCanonicalRemotePath } from "./remotePathPolicy.ts";
import { planRemoteFullSync } from "./remoteSync.ts";
import { OrderedSnapshotWriter } from "./remotePersistence.ts";
import {
  remoteCapabilityRefreshDelay,
  selectRestoredRemoteSessionIds,
  shouldRefreshRemoteCapability,
} from "./remoteCapability.ts";
import { RemoteEventAckWindow } from "./remoteEventWindow.ts";
import {
  MAX_REMOTE_COMMAND_RESULT_BYTES,
  planRemoteCommandResult,
  type RemoteCommandResultPacket,
} from "./remoteCommandResult.ts";
import {
  commitRemoteRevocation,
  isRemoteEpochRevoked,
  RemoteRevocationAdmissionBarrier,
} from "./remoteRevocation.ts";
import { RemoteSerialQueue } from "./remoteSerialQueue.ts";
import { RemoteCommandScheduler } from "./remoteCommandScheduler.ts";

const SECRET_KEY = "ompcode.remote.secrets.v1";
const DURABLE_KEY = "ompcode.remote.durable.v1";
const LAST_EPOCH_KEY = "ompcode.remote.lastEpoch.v1";
const REVOKED_EPOCH_KEY = "ompcode.remote.revokedEpoch.v1";
const PAIRING_TTL_MS = 10 * 60 * 1000;
const CAPABILITY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_EVENT_JSON_BYTES = 220 * 1024;
const MAX_TERMINAL_COMMAND_RECORDS_PER_DEVICE = 256;
const MAX_LIVE_COMMAND_RESULT_STREAMS = 8;

export type RemoteGrant = "current" | "all" | "all-with-credentials";

interface StoredScope {
  allSessions: boolean;
  sessionIds: string[];
  workspaceRoots: string[];
  verbs: CapabilityVerb[];
}

interface StoredPendingEnrolment {
  peerId: number;
  deviceId: string;
  deviceName: string;
  enrolmentId: string;
  pairCipherDigest: string;
  enrolledCiphertext: string;
  capability: CapabilityManifest;
  capabilitySignature: string;
}

interface StoredDevice {
  deviceId: string;
  deviceName: string;
  capability: CapabilityManifest;
  capabilitySignature: string;
}

interface StoredRemoteSecrets {
  relayUrl: string;
  roomId: string;
  keyEpoch: number;
  hostGeneration: string;
  roomMasterKey: string;
  deviceToken: string;
  scope: StoredScope;
  pairingKey?: string;
  pairingExpiresAt?: number;
  pending?: StoredPendingEnrolment;
  device?: StoredDevice;
  hostAuthNext: string;
  deviceAuthHighWater: string | null;
}

interface StoredEvent {
  frame: RemoteHostEventFrame;
}

interface StoredDurableRemoteState {
  commands: DurableCommandState;
  eventSequence: string;
  events: StoredEvent[];
}

interface ConnectionState {
  peerId: number;
  stage: "challenged" | "active";
  hello: HelloFrame;
  challenge: ChallengeFrame;
  authDeviceToHost: Uint8Array;
  trafficDeviceToHost: Uint8Array;
  trafficHostToDevice: Uint8Array;
  incoming: ReplayCounterGuard;
  outgoingCounter: bigint;
  eventWindow: RemoteEventAckWindow;
  highestSentEventSequence: bigint;
}

interface BufferedAttachment {
  chunks: Uint8Array[];
}

interface CommittedAttachment {
  attachment: Attachment;
  storedPath: string;
  committedAt: number;
}

interface CachedCommandResultStream {
  deviceId: string;
  commandId: string;
  packets: readonly RemoteCommandResultPacket[];
  marker: JsonValue;
}

export interface RemoteControlServiceOptions {
  createSession(workspaceRoot?: string): Promise<OmpSession | undefined>;
}

export interface RemoteControlStatus {
  running: boolean;
  transport: RemoteTransportStatus;
  relayUrl?: string;
  roomId?: string;
  pairedDevice?: string;
  pairingExpiresAt?: number;
  selectedSessionId?: string;
}

function jsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === "bigint" ? entry.toString(10) : entry)) as JsonValue;
}

function boundedJson(value: unknown, maximumBytes = MAX_EVENT_JSON_BYTES): JsonValue {
  const normalized = jsonValue(value);
  const encoded = JSON.stringify(normalized);
  const bytes = Buffer.byteLength(encoded);
  if (bytes <= maximumBytes) return normalized;
  return {
    truncated: true,
    originalBytes: bytes,
    preview: encoded.slice(0, Math.max(0, maximumBytes - 1024)),
  };
}

function isStreamedCommandResultMarker(value: JsonValue | undefined): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, JsonValue>;
  return Object.keys(record).sort().join(",") === "sha256,streamed,totalBytes" &&
    record.streamed === true &&
    Number.isInteger(record.totalBytes) &&
    Number(record.totalBytes) > 64 * 1024 &&
    Number(record.totalBytes) <= MAX_REMOTE_COMMAND_RESULT_BYTES &&
    typeof record.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(record.sha256);
}

function base64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Desktop owner of one encrypted Android Remote Control room. */
export class RemoteControlService implements vscode.Disposable {
  private readonly context: vscode.ExtensionContext;
  private readonly output: vscode.OutputChannel;
  private readonly options: RemoteControlServiceOptions;
  private readonly leases = new Map<string, vscode.Disposable>();
  private readonly connections = new Map<number, ConnectionState>();
  private readonly bufferedAttachments = new Map<string, BufferedAttachment>();
  private readonly committedAttachments = new Map<string, CommittedAttachment>();
  private readonly promptAttachmentsBySession = new Map<string, Set<string>>();
  private readonly commandResultStreams = new Map<string, CachedCommandResultStream>();
  private readonly subscriptions: vscode.Disposable[];
  private transport: RemoteRelayTransport | undefined;
  private secrets: StoredRemoteSecrets | undefined;
  private durable: StoredDurableRemoteState | undefined;
  private selectedSessionId: string | undefined;
  private pairingUri: string | undefined;
  private status: RemoteTransportStatus = "stopped";
  private panel: vscode.WebviewPanel | undefined;
  private incomingQueue: Promise<void> = Promise.resolve();
  private readonly commandScheduler = new RemoteCommandScheduler();
  private readonly eventQueue = new RemoteSerialQueue();
  private scopeRefreshQueue: Promise<void> = Promise.resolve();
  private readonly durableWriter = new OrderedSnapshotWriter<StoredDurableRemoteState | undefined>();
  private readonly secretWriter = new OrderedSnapshotWriter<string | undefined>();
  private cleanupTimer: NodeJS.Timeout;
  private capabilityRefreshTimer: NodeJS.Timeout | undefined;
  private pairingExpiryTimer: NodeJS.Timeout | undefined;
  private disposed = false;
  private restoreDeferred = false;
  private restoreInProgress = false;
  private revocationCommitted = false;
  private readonly revocationAdmission = new RemoteRevocationAdmissionBarrier();

  constructor(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
    options: RemoteControlServiceOptions,
  ) {
    this.context = context;
    this.output = output;
    this.options = options;
    this.subscriptions = [
      OmpSession.onRemoteMessage((event) => this.onSessionMessage(event)),
      OmpSession.onBoardChange(() => this.onSessionBoardChange()),
    ];
    this.cleanupTimer = setInterval(() => void this.cleanupAttachments(), 60_000);
    void this.sweepAttachmentDirectory();
  }

  currentStatus(): RemoteControlStatus {
    return {
      running: this.secrets !== undefined,
      transport: this.status,
      relayUrl: this.secrets?.relayUrl,
      roomId: this.secrets?.roomId,
      pairedDevice: this.secrets?.device?.deviceName,
      pairingExpiresAt: this.secrets?.pairingExpiresAt,
      selectedSessionId: this.selectedSessionId,
    };
  }

  /** Resume an enrolled room or an unexpired two-phase enrolment after extension-host restart. */
  async restore(): Promise<boolean> {
    if (this.restoreInProgress || this.secrets) return this.secrets !== undefined;
    this.restoreInProgress = true;
    try {
    const stored = await this.readSecrets();
    if (!stored) return false;
    const revokedThroughEpoch = this.context.globalState.get<number>(REVOKED_EPOCH_KEY, 0);
    if (isRemoteEpochRevoked(stored.keyEpoch, revokedThroughEpoch)) {
      await Promise.all([
        this.deleteSecrets(),
        this.context.globalState.update(DURABLE_KEY, undefined),
        this.context.globalState.update(LAST_EPOCH_KEY, Math.max(stored.keyEpoch, revokedThroughEpoch)),
      ]);
      return false;
    }
    const sessions = OmpSession.allSessions();
    if (!sessions.length) {
      this.restoreDeferred = true;
      return false;
    }
    this.restoreDeferred = false;
    const restoredScope = await this.remapScopeToLiveSessions(stored, sessions);
    if (!restoredScope) {
      await this.revokeUnrestorableStoredEpoch(stored);
      this.output.appendLine("[remote] exact current-session grant is no longer live; revoked and requires pairing");
      return false;
    }
    if (stored.device) {
      stored.hostGeneration = randomUUID();
      stored.device.capability = this.makeCapability(stored.device.deviceId, stored);
      stored.device.capabilitySignature = this.signCapability(stored, stored.device.capability);
    } else if (stored.pairingKey && stored.pairingExpiresAt && stored.pairingExpiresAt > Date.now()) {
      this.pairingUri = formatPairingUri({
        relayUrl: stored.relayUrl,
        roomId: stored.roomId,
        pairingKey: Buffer.from(stored.pairingKey, "base64url"),
        expiresAt: stored.pairingExpiresAt,
        keyEpoch: stored.keyEpoch,
      });
    } else {
      await this.deleteSecrets();
      return false;
    }
    this.secrets = stored;
    this.selectedSessionId = stored.scope.sessionIds[0] ?? sessions[0]?.remoteSessionId;
    const persisted = this.context.globalState.get<StoredDurableRemoteState>(DURABLE_KEY);
    const recovered = reduceDurableCommand(
      persisted?.commands?.keyEpoch === stored.keyEpoch
        ? persisted.commands
        : createDurableCommandState(stored.keyEpoch),
      { type: "recover", nowMs: Date.now() },
    );
    this.durable = {
      commands: recovered.state,
      eventSequence: persisted?.eventSequence ?? "0",
      events: persisted?.events ?? [],
    };
    await Promise.all([this.writeSecrets(), this.persistDurable()]);
    this.acquireScopedLeases();
    this.scheduleCapabilityRefresh();
    this.schedulePairingExpiry();
    this.openTransport();
    this.output.appendLine(`[remote] restored encrypted room at epoch ${stored.keyEpoch}`);
    return true;
    } finally {
      this.restoreInProgress = false;
    }
  }

  async start(origin: OmpSession, grant: RemoteGrant): Promise<string> {
    await this.stop(true);
    const previousEpoch = this.context.globalState.get<number>(LAST_EPOCH_KEY, 0);
    const rotated = rotateRemoteSecrets(previousEpoch);
    const pairingKey = randomPairingKey();
    const allSessions = grant !== "current";
    const sessions = allSessions ? OmpSession.allSessions() : [origin];
    const verbs: CapabilityVerb[] = ["view", "prompt", "approve", "files"];
    if (allSessions) verbs.push("session.manage", "settings.manage");
    if (grant === "all-with-credentials") verbs.push("credentials.manage");
    const relayUrl = normalizeRelayUrl(vscode.workspace
      .getConfiguration("ompcode")
      .get<string>("remoteRelayUrl", "wss://my.omp.sh"));
    const expiresAt = Date.now() + PAIRING_TTL_MS;
    const canonicalRoots = await Promise.all(
      [...new Set(sessions.map((session) => session.remoteWorkspaceRoot))].map((root) => fs.realpath(path.resolve(root))),
    );
    this.revocationCommitted = false;
    this.revocationAdmission.reset();
    this.secrets = {
      relayUrl,
      roomId: rotated.roomId,
      keyEpoch: rotated.keyEpoch,
      hostGeneration: rotated.hostGeneration,
      roomMasterKey: base64(rotated.roomMasterKey),
      deviceToken: base64(rotated.deviceToken),
      scope: {
        allSessions,
        sessionIds: sessions.map((session) => session.remoteSessionId),
        workspaceRoots: canonicalRoots,
        verbs,
      },
      pairingKey: base64(pairingKey),
      pairingExpiresAt: expiresAt,
      hostAuthNext: "0",
      deviceAuthHighWater: null,
    };
    this.selectedSessionId = origin.remoteSessionId;
    this.durable = {
      commands: createDurableCommandState(rotated.keyEpoch),
      eventSequence: "0",
      events: [],
    };
    this.pairingUri = formatPairingUri({
      relayUrl,
      roomId: rotated.roomId,
      pairingKey,
      expiresAt,
      keyEpoch: rotated.keyEpoch,
    });
    await Promise.all([
      this.writeSecrets(),
      this.persistDurable(),
      this.context.globalState.update(LAST_EPOCH_KEY, rotated.keyEpoch),
    ]);
    this.acquireScopedLeases();
    this.openTransport();
    this.schedulePairingExpiry();
    await this.openStatusPanel();
    return this.pairingUri;
  }

  async stop(revoke: boolean): Promise<void> {
    if (revoke) this.revocationAdmission.begin();
    if (revoke && this.secrets && !this.revocationCommitted) {
      await this.commitActiveRevocation();
    }
    this.transport?.stop();
    this.transport = undefined;
    this.status = "stopped";
    this.clearConnections("remote control stopped");
    this.commandResultStreams.clear();
    if (this.capabilityRefreshTimer) clearTimeout(this.capabilityRefreshTimer);
    this.capabilityRefreshTimer = undefined;
    if (this.pairingExpiryTimer) clearTimeout(this.pairingExpiryTimer);
    this.pairingExpiryTimer = undefined;
    this.pairingUri = undefined;
    for (const lease of this.leases.values()) lease.dispose();
    this.leases.clear();
    await this.removeAllAttachments();
    this.promptAttachmentsBySession.clear();
    if (revoke) {
      const epoch = this.secrets?.keyEpoch;
      if (epoch !== undefined) await this.context.globalState.update(LAST_EPOCH_KEY, epoch);
      this.secrets = undefined;
      await this.deleteSecrets();
      this.durable = undefined;
      await this.persistDurable();
      this.revocationCommitted = false;
      this.revocationAdmission.reset();
    }
    await this.refreshPanel();
  }

  /**
   * Mint a fresh pairing secret inside the room that is already running.
   *
   * A QR is a one-time bearer secret that lives ten minutes, and the ordinary way
   * to lose one is simply not having the phone to hand. Re-minting keeps the grant
   * that was already consented to — same room, same key epoch, same scope, same
   * frozen workspace roots — so this is not a second consent decision. What it is
   * not allowed to do is disturb a phone that is already talking: an enrolled
   * device authenticates with its own token and never sees this key.
   */
  async refreshPairing(): Promise<string | undefined> {
    const secrets = this.secrets;
    if (!secrets || this.status === "stopped") return undefined;
    const pairingKey = randomPairingKey();
    const expiresAt = Date.now() + PAIRING_TTL_MS;
    // A half-finished enrolment was sealed under the key being replaced. It can
    // never complete now, and leaving it behind would make the next pair frame
    // look like a conflicting request instead of a fresh one.
    delete secrets.pending;
    secrets.pairingKey = base64(pairingKey);
    secrets.pairingExpiresAt = expiresAt;
    this.pairingUri = formatPairingUri({
      relayUrl: secrets.relayUrl,
      roomId: secrets.roomId,
      pairingKey,
      expiresAt,
      keyEpoch: secrets.keyEpoch,
    });
    await this.writeSecrets();
    this.schedulePairingExpiry();
    await this.openStatusPanel();
    return this.pairingUri;
  }

  /** Whether a phone is already enrolled, which a new QR would let another replace. */
  hasPairedDevice(): boolean {
    return Boolean(this.secrets?.device);
  }

  /** Whether there is a live room a refreshed QR could belong to. */
  canRefreshPairing(): boolean {
    return Boolean(this.secrets) && this.status !== "stopped";
  }

  async copyPairingUri(): Promise<boolean> {
    if (!this.pairingUri || !this.secrets?.pairingExpiresAt || this.secrets.pairingExpiresAt <= Date.now()) {
      return false;
    }
    await vscode.env.clipboard.writeText(this.pairingUri);
    return true;
  }

  async openStatusPanel(): Promise<void> {
    if (this.panel) {
      this.panel.reveal();
      await this.refreshPanel();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "ompcode.remoteStatus",
      "OMP Code Remote Control",
      vscode.ViewColumn.Beside,
      { enableScripts: false, enableCommandUris: true, retainContextWhenHidden: true },
    );
    this.panel = panel;
    panel.onDidDispose(() => {
      if (this.panel === panel) this.panel = undefined;
    });
    await this.refreshPanel();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.cleanupTimer);
    if (this.capabilityRefreshTimer) clearTimeout(this.capabilityRefreshTimer);
    if (this.pairingExpiryTimer) clearTimeout(this.pairingExpiryTimer);
    for (const subscription of this.subscriptions) subscription.dispose();
    this.transport?.stop();
    for (const lease of this.leases.values()) lease.dispose();
    this.leases.clear();
    this.panel?.dispose();
  }

  private openTransport(): void {
    const secrets = this.secrets;
    if (!secrets) return;
    this.transport?.stop();
    this.transport = new RemoteRelayTransport(secrets.relayUrl, secrets.roomId, {
      onBinary: (frame) => {
        this.incomingQueue = this.incomingQueue
          .then(() => this.handleBinary(frame))
          .catch((error) => this.output.appendLine(`[remote] frame rejected: ${String(error)}`));
      },
      onControl: (frame) => {
        if (frame.t === "peer-left") this.dropConnection(frame.peer, "relay peer left");
        if (frame.t === "room-closed") void this.stop(true);
      },
      onStatus: (status, detail) => this.onTransportStatus(status, detail),
    });
    this.transport.start();
  }

  private onTransportStatus(status: RemoteTransportStatus, detail?: string): void {
    this.status = status;
    this.output.appendLine(`[remote] relay ${status}${detail ? `: ${detail}` : ""}`);
    if (status !== "connected") this.clearConnections("relay connection changed");
    void this.refreshPanel();
    if (status === "connected" && this.secrets?.device) {
      void this.queueEvent("remote-status", { transport: status });
    }
  }

  private async handleBinary(frame: Uint8Array): Promise<void> {
    const secrets = this.secrets;
    if (!secrets || frame.byteLength < 4) return;
    const peerId = Buffer.from(frame).readUInt32BE(0);
    // Relay rewrites only the outer peer header. The exact encrypted guest
    // payload remains stable across reconnect and is the idempotency identity.
    const wireDigest = createHash("sha256").update(Buffer.from(frame).subarray(4)).digest("hex");
    if (secrets.pending?.pairCipherDigest === wireDigest) {
      if (secrets.pending.peerId !== peerId) {
        await this.rebindPendingEnrolment(peerId);
      }
      this.transport?.send(Buffer.from(this.requireSecrets().pending?.enrolledCiphertext ?? "", "base64"));
      return;
    }
    if (secrets.pending) {
      if (secrets.pending.peerId === peerId) {
        await this.handleEnrolledAck(frame, peerId);
        return;
      }
      throw new Error("a different pairing request conflicts with the pending enrolment");
    }
    if (secrets.pairingKey) {
      await this.handlePair(frame, peerId, wireDigest);
      return;
    }
    const connection = this.connections.get(peerId);
    if (!connection) {
      await this.handleHello(frame, peerId);
      return;
    }
    if (connection.stage === "challenged") {
      await this.handleProof(frame, connection);
      return;
    }
    await this.handleData(frame, connection);
  }

  private pairKey(direction: "device-to-host" | "host-to-device"): Uint8Array {
    const secrets = this.requireSecrets();
    if (!secrets.pairingKey) throw new Error("pairing key is unavailable");
    return deriveDirectionalKey(Buffer.from(secrets.pairingKey, "base64url"), {
      roomId: secrets.roomId,
      keyEpoch: secrets.keyEpoch,
      purpose: "pair",
      direction,
    });
  }

  private authKey(direction: "device-to-host" | "host-to-device"): Uint8Array {
    const secrets = this.requireSecrets();
    return deriveDirectionalKey(Buffer.from(secrets.deviceToken, "base64url"), {
      roomId: secrets.roomId,
      keyEpoch: secrets.keyEpoch,
      purpose: "auth",
      direction,
    });
  }

  private async handlePair(frame: Uint8Array, peerId: number, wireDigest: string): Promise<void> {
    const secrets = this.requireSecrets();
    if (!secrets.pairingExpiresAt || secrets.pairingExpiresAt <= Date.now()) throw new Error("pairing expired");
    const opened = openEnvelope(frame, {
      key: this.pairKey("device-to-host"),
      roomId: secrets.roomId,
      keyEpoch: secrets.keyEpoch,
      direction: "device-to-host",
      aadPeerId: 0,
      expectedEnvelopePeerId: peerId,
    });
    const pair = parseRemoteHandshakeFrame(opened.plaintext);
    if (pair.type !== "pair") throw new Error("expected pair frame");
    const expectedPairCounter = derivePairRequestCounter(Buffer.from(pair.deviceNonce, "base64url"));
    if (opened.counter !== expectedPairCounter) throw new Error("pair counter does not match device nonce");
    const capability = this.makeCapability(pair.deviceId, secrets);
    const capabilitySignature = this.signCapability(secrets, capability);
    const enrolmentId = randomUUID();
    const enrolled = encodeRemoteHandshakeFrame({
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      type: "enrolled",
      enrolmentId,
      deviceId: pair.deviceId,
      assignedPeerId: peerId,
      roomMasterKey: secrets.roomMasterKey,
      deviceToken: secrets.deviceToken,
      keyEpoch: secrets.keyEpoch,
      hostGeneration: secrets.hostGeneration,
      capability,
      capabilitySignature,
    });
    const encrypted = sealEnvelope({
      key: this.pairKey("host-to-device"),
      roomId: secrets.roomId,
      keyEpoch: secrets.keyEpoch,
      direction: "host-to-device",
      peerId,
      envelopePeerId: peerId,
      counter: deriveEnrolmentCounter(peerId),
      plaintext: enrolled,
    });
    secrets.pending = {
      peerId,
      deviceId: pair.deviceId,
      deviceName: pair.deviceName,
      enrolmentId,
      pairCipherDigest: wireDigest,
      enrolledCiphertext: Buffer.from(encrypted).toString("base64"),
      capability,
      capabilitySignature,
    };
    await this.writeSecrets();
    if (!this.transport?.send(encrypted)) throw new Error("relay is not connected");
  }

  /** Re-target the same fixed enrolment transaction after relay peer reassignment. */
  private async rebindPendingEnrolment(peerId: number): Promise<void> {
    const secrets = this.requireSecrets();
    const pending = secrets.pending;
    if (!pending || !secrets.pairingKey) throw new Error("pending enrolment is unavailable");
    const enrolled = encodeRemoteHandshakeFrame({
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      type: "enrolled",
      enrolmentId: pending.enrolmentId,
      deviceId: pending.deviceId,
      assignedPeerId: peerId,
      roomMasterKey: secrets.roomMasterKey,
      deviceToken: secrets.deviceToken,
      keyEpoch: secrets.keyEpoch,
      hostGeneration: secrets.hostGeneration,
      capability: pending.capability,
      capabilitySignature: pending.capabilitySignature,
    });
    const encrypted = sealEnvelope({
      key: this.pairKey("host-to-device"),
      roomId: secrets.roomId,
      keyEpoch: secrets.keyEpoch,
      direction: "host-to-device",
      peerId,
      envelopePeerId: peerId,
      counter: deriveEnrolmentCounter(peerId),
      plaintext: enrolled,
    });
    pending.peerId = peerId;
    pending.enrolledCiphertext = Buffer.from(encrypted).toString("base64");
    await this.writeSecrets();
  }

  private async handleEnrolledAck(frame: Uint8Array, peerId: number): Promise<void> {
    const secrets = this.requireSecrets();
    const pending = secrets.pending;
    if (!pending || pending.peerId !== peerId) throw new Error("unknown pending enrolment");
    if (!secrets.pairingExpiresAt || secrets.pairingExpiresAt <= Date.now()) {
      throw new Error("pending enrolment expired before acknowledgement");
    }
    const opened = openEnvelope(frame, {
      key: this.pairKey("device-to-host"),
      roomId: secrets.roomId,
      keyEpoch: secrets.keyEpoch,
      direction: "device-to-host",
      aadPeerId: peerId,
      expectedEnvelopePeerId: peerId,
    });
    if (opened.counter !== deriveEnrolmentCounter(peerId)) {
      throw new Error("enrolled ACK counter must bind the assigned relay peer");
    }
    const ack = parseRemoteHandshakeFrame(opened.plaintext);
    if (ack.type !== "enrolled-ack" || ack.deviceId !== pending.deviceId || ack.enrolmentId !== pending.enrolmentId) {
      throw new Error("enrolled ACK does not match pending transaction");
    }
    const expected = credentialDigest(
      secrets.roomId,
      secrets.keyEpoch,
      pending.deviceId,
      secrets.roomMasterKey,
      secrets.deviceToken,
    );
    if (!sameSecret(ack.credentialDigest, expected)) throw new Error("credential digest mismatch");
    // Scope may have been remapped to new live session ids after a desktop
    // extension-host restart; welcome carries the freshly signed authority.
    const capability = this.makeCapability(pending.deviceId, secrets);
    secrets.device = {
      deviceId: pending.deviceId,
      deviceName: pending.deviceName,
      capability,
      capabilitySignature: this.signCapability(secrets, capability),
    };
    delete secrets.pending;
    delete secrets.pairingKey;
    delete secrets.pairingExpiresAt;
    this.pairingUri = undefined;
    if (this.pairingExpiryTimer) clearTimeout(this.pairingExpiryTimer);
    this.pairingExpiryTimer = undefined;
    await this.writeSecrets();
    this.scheduleCapabilityRefresh();
    await this.refreshPanel();
  }

  private async handleHello(frame: Uint8Array, peerId: number): Promise<void> {
    const secrets = this.requireSecrets();
    const device = secrets.device;
    if (!device) throw new Error("no enrolled device");
    const incoming = new ReplayCounterGuard(secrets.deviceAuthHighWater);
    const opened = openEnvelope(frame, {
      key: this.authKey("device-to-host"),
      roomId: secrets.roomId,
      keyEpoch: secrets.keyEpoch,
      direction: "device-to-host",
      aadPeerId: 0,
      expectedEnvelopePeerId: peerId,
      replayGuard: incoming,
    });
    const hello = parseRemoteHandshakeFrame(opened.plaintext);
    if (hello.type !== "hello" || hello.deviceId !== device.deviceId || !sameSecret(hello.deviceToken, secrets.deviceToken)) {
      throw new Error("hello credential mismatch");
    }
    if (shouldRefreshRemoteCapability(device.capability.expiresAt, Date.now())) {
      device.capability = this.makeCapability(device.deviceId, secrets);
      device.capabilitySignature = this.signCapability(secrets, device.capability);
    }
    secrets.deviceAuthHighWater = incoming.snapshot();
    const hostNonce = randomHandshakeNonce();
    const challenge: ChallengeFrame = {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      type: "challenge",
      connectionId: randomUUID(),
      deviceId: device.deviceId,
      assignedPeerId: peerId,
      deviceNonce: hello.deviceNonce,
      hostNonce: base64(hostNonce),
      hostGeneration: secrets.hostGeneration,
      keyEpoch: secrets.keyEpoch,
    };
    const deviceNonce = Buffer.from(hello.deviceNonce, "base64url");
    const roomMasterKey = Buffer.from(secrets.roomMasterKey, "base64url");
    const trafficDeviceToHost = deriveConnectionTrafficKey(roomMasterKey, {
      roomId: secrets.roomId, keyEpoch: secrets.keyEpoch, direction: "device-to-host", hostNonce, deviceNonce,
    });
    const trafficHostToDevice = deriveConnectionTrafficKey(roomMasterKey, {
      roomId: secrets.roomId, keyEpoch: secrets.keyEpoch, direction: "host-to-device", hostNonce, deviceNonce,
    });
    const outgoingCounter = BigInt(secrets.hostAuthNext);
    const encrypted = sealEnvelope({
      key: this.authKey("host-to-device"),
      roomId: secrets.roomId,
      keyEpoch: secrets.keyEpoch,
      direction: "host-to-device",
      peerId,
      envelopePeerId: peerId,
      counter: outgoingCounter,
      plaintext: encodeRemoteHandshakeFrame(challenge),
    });
    secrets.hostAuthNext = formatUint64Decimal(outgoingCounter + 1n);
    await this.writeSecrets(); // reserve auth nonce before network write
    this.clearConnections("device reconnected");
    const durableHighWater = BigInt(this.durable?.eventSequence ?? "0");
    const claimedHighWater = BigInt(hello.lastSequence);
    const acknowledgedHighWater = hello.hostGeneration === secrets.hostGeneration && claimedHighWater <= durableHighWater
      ? claimedHighWater
      : 0n;
    const eventWindow = new RemoteEventAckWindow(acknowledgedHighWater, 4, 30_000, (sequence, error) => {
      this.onEventAckTimeout(peerId, eventWindow, sequence, error);
    });
    this.connections.set(peerId, {
      peerId,
      stage: "challenged",
      hello,
      challenge,
      authDeviceToHost: this.authKey("device-to-host"),
      trafficDeviceToHost,
      trafficHostToDevice,
      incoming: new ReplayCounterGuard(),
      outgoingCounter: 0n,
      eventWindow,
      highestSentEventSequence: acknowledgedHighWater,
    });
    if (!this.transport?.send(encrypted)) throw new Error("relay is not connected");
    this.scheduleCapabilityRefresh();
  }

  private async handleProof(frame: Uint8Array, connection: ConnectionState): Promise<void> {
    const secrets = this.requireSecrets();
    const opened = openEnvelope(frame, {
      key: connection.trafficDeviceToHost,
      roomId: secrets.roomId,
      keyEpoch: secrets.keyEpoch,
      direction: "device-to-host",
      expectedEnvelopePeerId: connection.peerId,
      replayGuard: connection.incoming,
    });
    if (opened.counter !== 0n) throw new Error("proof counter must be zero");
    const proof = parseRemoteHandshakeFrame(opened.plaintext);
    if (proof.type !== "proof" || proof.connectionId !== connection.challenge.connectionId) {
      throw new Error("proof connection mismatch");
    }
    const transcript = canonicalJsonBytes(jsonValue([connection.hello, connection.challenge]));
    if (!verifyHandshakeProof(connection.authDeviceToHost, transcript, Buffer.from(proof.proof, "base64url"))) {
      throw new Error("handshake proof mismatch");
    }
    const device = secrets.device;
    if (!device) throw new Error("device was revoked during handshake");
    const welcome = encodeRemoteHandshakeFrame({
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      type: "welcome",
      connectionId: connection.challenge.connectionId,
      hostGeneration: secrets.hostGeneration,
      sequence: this.durable?.eventSequence ?? "0",
      capability: device.capability,
      capabilitySignature: device.capabilitySignature,
    });
    const encrypted = sealEnvelope({
      key: connection.trafficHostToDevice,
      roomId: secrets.roomId,
      keyEpoch: secrets.keyEpoch,
      direction: "host-to-device",
      peerId: connection.peerId,
      envelopePeerId: connection.peerId,
      counter: 0n,
      plaintext: welcome,
    });
    connection.outgoingCounter = 1n;
    connection.stage = "active";
    if (!this.transport?.send(encrypted)) throw new Error("relay is not connected");
    void this.sendFullSync(connection.peerId).catch((error) => {
      this.output.appendLine(`[remote] full sync failed: ${String(error)}`);
    });
  }

  private async handleData(frame: Uint8Array, connection: ConnectionState): Promise<void> {
    const secrets = this.requireSecrets();
    const opened = openEnvelope(frame, {
      key: connection.trafficDeviceToHost,
      roomId: secrets.roomId,
      keyEpoch: secrets.keyEpoch,
      direction: "device-to-host",
      expectedEnvelopePeerId: connection.peerId,
      replayGuard: connection.incoming,
    });
    const plaintext = Buffer.from(opened.plaintext);
    if (plaintext.subarray(0, 4).toString("ascii") === "OMPA") {
      await this.handleAttachmentChunk(plaintext, connection.peerId);
      return;
    }
    const control = parseDeviceControlFrame(plaintext);
    if (control.type === "event-ack") {
      if (control.hostGeneration !== secrets.hostGeneration) throw new Error("event ACK generation mismatch");
      this.acceptEventAck(connection, BigInt(control.sequence));
      return;
    }
    if (control.type === "ping") {
      this.sendJson(connection.peerId, { protocolVersion: 1, type: "pong", nonce: control.nonce });
      return;
    }
    if (control.type === "pong") return;
    if (!("command" in control)) throw new Error("unexpected presence frame");
    // Durable admission is globally serialized. Accepted long operations then
    // move to per-session lanes; approval/abort have a priority control lane
    // and can resolve a routed prompt that is waiting for agent_end.
    void this.commandScheduler.admit(
      () => this.processCommand(control, connection.peerId),
      (error) => this.output.appendLine(`[remote] command admission failed: ${String(error)}`),
    ).catch(() => {});
  }

  private async processCommand(command: RemoteCommand, peerId: number): Promise<void> {
    const secrets = this.requireSecrets();
    const device = secrets.device;
    const durable = this.durable;
    if (!device || !durable) throw new Error("remote state is unavailable");
    await this.refreshScopedSessions();
    const commandDigest = digestRemoteCommand(command);
    if (this.revocationAdmission.active) {
      const existing = durable.commands.devices[device.deviceId]
        ?.commands[command.commandId.toLowerCase()];
      const exactDuplicate = Boolean(existing &&
        existing.counter === command.commandCounter &&
        existing.digest === commandDigest);
      if (exactDuplicate && existing) {
        this.scheduleRemoteCommandTask(command, () => this.sendStoredCommandAck(peerId, command, existing));
      } else {
        this.sendCommandAck(
          peerId,
          command,
          "rejected",
          undefined,
          "revocation-in-progress",
          "Remote authority is being revoked",
        );
      }
      return;
    }
    if (command.hostGeneration !== secrets.hostGeneration) {
      const previous = findExactDurableCommand(durable.commands, {
        keyEpoch: secrets.keyEpoch,
        deviceId: device.deviceId,
        commandId: command.commandId,
        counter: command.commandCounter,
        digest: commandDigest,
      });
      if (previous) {
        this.scheduleRemoteCommandTask(command, () => this.sendStoredCommandAck(peerId, command, previous));
        return;
      }
      this.sendCommandAck(peerId, command, "rejected", undefined, "wrong-generation", "Host restarted; resync required");
      void this.sendFullSync(peerId).catch((error) => this.output.appendLine(`[remote] resync failed: ${String(error)}`));
      return;
    }
    const target = command.sessionId ? this.findAllowedSession(command.sessionId) : undefined;
    const authorization = authorizeRemoteCommand(device.capability, command, {
      keyEpoch: secrets.keyEpoch,
      workspacePath: target?.remoteWorkspaceRoot,
    });
    if (!authorization.allowed) {
      this.sendCommandAck(peerId, command, "rejected", undefined, authorization.reason ?? "not-authorized", "Command is outside the desktop grant");
      return;
    }
    const received = reduceDurableCommand(durable.commands, {
      type: "receive",
      keyEpoch: secrets.keyEpoch,
      deviceId: device.deviceId,
      commandId: command.commandId,
      counter: command.commandCounter,
      digest: commandDigest,
      nowMs: Date.now(),
    });
    durable.commands = received.state;
    if (received.decision.kind === "duplicate") {
      const duplicateRecord = received.decision.record;
      this.scheduleRemoteCommandTask(
        command,
        () => this.sendStoredCommandAck(peerId, command, duplicateRecord),
      );
      return;
    }
    if (received.decision.kind !== "accepted") {
      this.sendCommandAck(peerId, command, "rejected", undefined, received.decision.kind, "Command replay/conflict rejected");
      return;
    }
    if (command.command === "remote.stop") {
      this.revocationAdmission.begin();
      // Revoke is the exceptional idempotent authority operation: its
      // tombstone and SecretStorage deletion must commit before the accepted
      // command record. A crash can lose the ACK/record, never resurrect the
      // room between accepted persistence and the tombstone.
      await this.commitActiveRevocation();
    }
    await this.persistDurable(); // atomic accept boundary before ordinary side effects
    this.sendCommandAck(peerId, command, "accepted");
    this.scheduleRemoteCommandTask(
      command,
      () => this.executeAcceptedCommand(command, peerId, target, device.deviceId, durable),
    );
  }

  private scheduleRemoteCommandTask(command: RemoteCommand, operation: () => Promise<void>): void {
    const lane = command.command === "approval.respond" || command.command === "turn.abort"
      ? "control"
      : command.sessionId
        ? "session"
        : "host";
    void this.commandScheduler.run(
      lane,
      command.sessionId,
      operation,
      (error) => this.output.appendLine(`[remote] command execution lane failed: ${String(error)}`),
    ).catch(() => {});
  }

  private async executeAcceptedCommand(
    command: RemoteCommand,
    peerId: number,
    target: OmpSession | undefined,
    deviceId: string,
    durable: StoredDurableRemoteState,
  ): Promise<void> {
    if (this.durable !== durable || this.secrets?.device?.deviceId !== deviceId) {
      // Rotation/revocation owns the accepted-but-not-run recovery boundary.
      return;
    }
    let terminalSettled = false;
    try {
      const rawResult = await this.executeCommand(command, target);
      const resultPlan = planRemoteCommandResult(command.commandId, randomUUID(), rawResult);
      if (resultPlan.kind === "rejected") {
        const settled = reduceDurableCommand(durable.commands, {
          type: "settle", deviceId, commandId: command.commandId,
          status: "rejected", nowMs: Date.now(), errorCode: resultPlan.errorCode,
        });
        durable.commands = settled.state;
        this.pruneLiveCommandRecords();
        await this.persistDurable();
        this.sendCommandAck(
          peerId,
          command,
          "rejected",
          undefined,
          resultPlan.errorCode,
          `Command result is ${resultPlan.totalBytes} bytes; remote limit is ${resultPlan.maximumBytes} bytes`,
        );
        return;
      }
      const result = resultPlan.kind === "inline" ? resultPlan.result : resultPlan.marker;
      if (resultPlan.kind === "stream") {
        this.cacheCommandResultStream({
          deviceId,
          commandId: command.commandId,
          packets: resultPlan.packets,
          marker: resultPlan.marker,
        });
      }
      const settled = reduceDurableCommand(durable.commands, {
        type: "settle", deviceId, commandId: command.commandId,
        status: "completed", nowMs: Date.now(), result,
      });
      durable.commands = settled.state;
      this.pruneLiveCommandRecords();
      await this.persistDurable();
      terminalSettled = true;
      if (resultPlan.kind === "stream") {
        await this.sendCommandResultStream(peerId, command, resultPlan.packets, resultPlan.marker);
      }
      if (command.command === "remote.stop") {
        await this.sendCommandAckAndFlush(peerId, command, "completed", result);
        await this.stop(true);
        return;
      } else if (resultPlan.kind === "inline") {
        this.sendCommandAck(peerId, command, "completed", result);
      }
      if (
        command.command === "session.sync" ||
        command.command === "session.create" ||
        command.command === "session.switch" ||
        command.command === "history.open"
      ) {
        void this.sendFullSync(peerId).catch((error) => this.output.appendLine(`[remote] resync failed: ${String(error)}`));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (terminalSettled) {
        // The command outcome is already durable. A disconnected peer can
        // resend the exact command and receive the bounded in-memory stream;
        // never rewrite a completed command as rejected or execute it again.
        this.output.appendLine(`[remote] completed command result delivery interrupted: ${message}`);
        return;
      }
      const errorCode = command.command === "approval.respond" &&
        typeof error === "object" && error !== null &&
        (error as { code?: unknown }).code === "host-not-pending"
        ? "host-not-pending"
        : "command-failed";
      const settled = reduceDurableCommand(durable.commands, {
        type: "settle", deviceId, commandId: command.commandId,
        status: "rejected", nowMs: Date.now(), errorCode,
      });
      durable.commands = settled.state;
      this.pruneLiveCommandRecords();
      await this.persistDurable();
      this.sendCommandAck(peerId, command, "rejected", undefined, errorCode, message);
    }
  }

  private async executeCommand(command: RemoteCommand, target?: OmpSession): Promise<JsonValue> {
    switch (command.command) {
      case "session.sync":
        return { syncQueued: true };
      case "attachment.start": {
        const reduction = reduceAttachmentBook(this.attachmentBook, { type: "start", meta: command.payload, nowMs: Date.now() });
        this.attachmentBook = reduction.state;
        if (reduction.decision.kind !== "started" && reduction.decision.kind !== "duplicate") {
          throw new Error(`attachment start rejected: ${reduction.decision.kind}`);
        }
        if (!this.bufferedAttachments.has(command.payload.attachmentId)) {
          this.bufferedAttachments.set(command.payload.attachmentId, { chunks: [] });
        }
        return jsonValue(reduction.decision);
      }
      case "attachment.commit":
        return this.commitAttachment(command.payload.attachmentId);
      case "attachment.cancel":
        return this.cancelAttachment(command.payload.attachmentId);
      case "sessions.list":
        return jsonValue({ sessions: this.allowedSessions().map((session) => session.snapshot()) });
      case "session.create": {
        const requestedRoot = command.payload.workspaceRoot === undefined
          ? this.requireSecrets().scope.workspaceRoots[0]
          : await requireCanonicalRemotePath(command.payload.workspaceRoot, this.requireSecrets().scope.workspaceRoots);
        if (!requestedRoot) throw new Error("no granted workspace root is available");
        const created = await this.options.createSession(requestedRoot);
        if (!created) throw new Error("session creation was cancelled");
        const secrets = this.requireSecrets();
        await requireCanonicalRemotePath(created.remoteWorkspaceRoot, secrets.scope.workspaceRoots);
        if (!secrets.scope.sessionIds.includes(created.remoteSessionId)) {
          secrets.scope.sessionIds.push(created.remoteSessionId);
        }
        if (secrets.device) {
          secrets.device.capability = this.makeCapability(secrets.device.deviceId, secrets);
          secrets.device.capabilitySignature = this.signCapability(secrets, secrets.device.capability);
        }
        await this.writeSecrets();
        this.publishCapabilityUpdate();
        this.acquireLease(created);
        this.selectedSessionId = created.remoteSessionId;
        return jsonValue({ session: created.snapshot() });
      }
      case "session.switch": {
        const selected = this.findAllowedSession(command.payload.targetSessionId);
        if (!selected) throw new Error("target session is outside the grant");
        this.selectedSessionId = selected.remoteSessionId;
        return jsonValue({ selectedSessionId: selected.remoteSessionId });
      }
      case "session.close":
        if (!target) throw new Error("session is unavailable");
        if (!target.canRemoteClose) throw new Error("the persistent sidebar session cannot be closed");
        this.leases.get(target.remoteSessionId)?.dispose();
        this.leases.delete(target.remoteSessionId);
        target.requestClose();
        if (this.selectedSessionId === target.remoteSessionId) {
          this.selectedSessionId = this.allowedSessions()
            .find((session) => session.remoteSessionId !== target.remoteSessionId)?.remoteSessionId;
        }
        return { closed: true };
      case "history.list": {
        const query = command.payload.query?.toLocaleLowerCase() ?? "";
        const history = (await this.allowedHistory())
          .filter((entry) => !query || JSON.stringify(entry).toLocaleLowerCase().includes(query))
          .slice(0, command.payload.limit);
        return jsonValue({ sessions: history });
      }
      case "history.open": {
        if (!target) throw new Error("target session is unavailable");
        const requested = command.payload.sessionPath;
        const match = (await this.allowedHistory()).find((entry) => entry.path === requested);
        if (!match) throw new Error("history entry is not in the current allowed history list");
        await target.openSession(match.path, false);
        this.selectedSessionId = target.remoteSessionId;
        return { opened: true, selectedSessionId: target.remoteSessionId };
      }
      case "approval-mode.set":
        await vscode.workspace.getConfiguration("ompcode").update("approvalMode", command.payload.mode, vscode.ConfigurationTarget.Workspace);
        return { changed: true };
      case "settings.update":
        await vscode.workspace.getConfiguration("ompcode").update(command.payload.key, command.payload.value, vscode.ConfigurationTarget.Workspace);
        return { changed: true };
      case "credentials.set": {
        const provider = KEYED_PROVIDERS.find((entry) => entry.id === command.payload.provider || entry.provider === command.payload.provider);
        if (!provider) throw new Error("provider is not in the desktop credential allowlist");
        await this.context.secrets.store(provider.secret, command.payload.value);
        await this.restartAllSessions();
        await this.queueEvent("session-message", await this.remoteKeyStatus(), this.selectedSessionId);
        return { changed: true };
      }
      case "credentials.clear": {
        const provider = KEYED_PROVIDERS.find((entry) => entry.id === command.payload.provider || entry.provider === command.payload.provider);
        if (!provider) throw new Error("provider is not in the desktop credential allowlist");
        await this.context.secrets.delete(provider.secret);
        await this.restartAllSessions();
        await this.queueEvent("session-message", await this.remoteKeyStatus(), this.selectedSessionId);
        return { changed: true };
      }
      case "diagnostics.get": {
        const session = target ?? this.findAllowedSession(this.selectedSessionId ?? "") ?? this.allowedSessions()[0];
        if (!session) throw new Error("no session for diagnostics");
        return { markdown: await session.diagnosticsReport() };
      }
      case "remote.stop":
        return { revoked: true };
      default: {
        if (!target) throw new Error("session is unavailable");
        const attachmentIds = command.command === "prompt.send" ? command.payload.attachmentIds : [];
        const attachments = command.command === "prompt.send"
          ? attachmentIds.map((id) => {
              const committed = this.committedAttachments.get(id);
              if (!committed) throw new Error(`attachment ${id} is not committed`);
              return committed.attachment;
            })
          : [];
        if (command.command === "prompt.send") {
          const staged = this.promptAttachmentsBySession.get(target.remoteSessionId) ?? new Set<string>();
          for (const id of attachmentIds) staged.add(id);
          this.promptAttachmentsBySession.set(target.remoteSessionId, staged);
        }
        try {
          return await target.handleRemoteCommand(command, attachments);
        } catch (error) {
          // A rejected prompt never handed the paths to the agent. Keep the
          // committed files available for retry/cancel, but detach this turn.
          if (command.command === "prompt.send") {
            const staged = this.promptAttachmentsBySession.get(target.remoteSessionId);
            for (const id of attachmentIds) staged?.delete(id);
            if (!staged?.size) this.promptAttachmentsBySession.delete(target.remoteSessionId);
          }
          throw error;
        }
      }
    }
  }

  private attachmentBook: AttachmentBookState = createAttachmentBookState();

  private async handleAttachmentChunk(plaintext: Uint8Array, peerId: number): Promise<void> {
    const chunk = decodeAttachmentChunk(plaintext);
    const reduction = reduceAttachmentBook(this.attachmentBook, { type: "chunk", chunk, nowMs: Date.now() });
    this.attachmentBook = reduction.state;
    if (reduction.decision.kind === "chunk-accepted") {
      this.bufferedAttachments.get(chunk.attachmentId)?.chunks.push(Buffer.from(chunk.data));
    }
    void this.queueEvent("session-message", {
      t: "attachmentAck",
      attachmentId: chunk.attachmentId,
      decision: reduction.decision,
    }, this.selectedSessionId, peerId);
  }

  private async commitAttachment(attachmentId: string): Promise<JsonValue> {
    const active = this.attachmentBook.active[attachmentId];
    const buffered = this.bufferedAttachments.get(attachmentId);
    if (!active || !buffered) throw new Error("attachment is not active");
    const actualSha256 = sha256Chunks(buffered.chunks);
    const reduction = reduceAttachmentBook(this.attachmentBook, {
      type: "commit", attachmentId, actualSha256, nowMs: Date.now(),
    });
    this.attachmentBook = reduction.state;
    if (reduction.decision.kind !== "committed") throw new Error(`attachment commit rejected: ${reduction.decision.kind}`);
    const bytes = Buffer.concat(buffered.chunks.map((chunk) => Buffer.from(chunk)));
    const name = safeFileName(active.meta.fileName, "remote-file");
    const dir = path.join(this.context.globalStorageUri.fsPath, "remote-attachments");
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.chmod(dir, 0o700).catch(() => {});
    const target = path.join(dir, `${attachmentId}-${name}`);
    await fs.writeFile(target, bytes, { flag: "wx", mode: 0o600 });
    this.committedAttachments.set(attachmentId, {
      storedPath: target,
      committedAt: Date.now(),
      attachment: { path: target, name, size: bytes.byteLength },
    });
    this.bufferedAttachments.delete(attachmentId);
    return { attachmentId, committed: true, size: bytes.byteLength };
  }

  private async cancelAttachment(attachmentId: string): Promise<JsonValue> {
    if ([...this.promptAttachmentsBySession.values()].some((ids) => ids.has(attachmentId))) {
      throw new Error("attachment is in use by an active agent turn");
    }
    const committed = this.committedAttachments.get(attachmentId);
    if (committed) {
      this.committedAttachments.delete(attachmentId);
      await fs.unlink(committed.storedPath).catch(() => {});
      return { kind: "cancelled" };
    }
    const reduction = reduceAttachmentBook(this.attachmentBook, { type: "cancel", attachmentId });
    this.attachmentBook = reduction.state;
    this.bufferedAttachments.delete(attachmentId);
    return jsonValue(reduction.decision);
  }

  private async cleanupAttachments(): Promise<void> {
    const reduction = reduceAttachmentBook(this.attachmentBook, {
      type: "cleanup", nowMs: Date.now(), timeoutMs: DEFAULT_ATTACHMENT_CLEANUP_MS,
    });
    this.attachmentBook = reduction.state;
    if (reduction.decision.kind === "cleaned") {
      for (const id of reduction.decision.attachmentIds) this.bufferedAttachments.delete(id);
    }
    const inUse = new Set([...this.promptAttachmentsBySession.values()].flatMap((ids) => [...ids]));
    const staleCommitted = [...this.committedAttachments.entries()]
      .filter(([id, entry]) => !inUse.has(id) && Date.now() - entry.committedAt >= DEFAULT_ATTACHMENT_CLEANUP_MS);
    for (const [id, entry] of staleCommitted) {
      this.committedAttachments.delete(id);
      await fs.unlink(entry.storedPath).catch(() => {});
    }
  }

  private async consumeCommittedAttachments(ids: readonly string[]): Promise<void> {
    for (const id of ids) {
      const committed = this.committedAttachments.get(id);
      if (!committed) continue;
      this.committedAttachments.delete(id);
      await fs.unlink(committed.storedPath).catch(() => {});
    }
  }

  /** Remove stale crash leftovers without following symlinks or broad globs. */
  private async sweepAttachmentDirectory(): Promise<void> {
    const dir = path.join(this.context.globalStorageUri.fsPath, "remote-attachments");
    let entries: Array<{ name: string; isFile(): boolean }>;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : "";
      if (code !== "ENOENT") this.output.appendLine(`[remote] attachment sweep failed: ${String(error)}`);
      return;
    }
    const cutoff = Date.now() - DEFAULT_ATTACHMENT_CLEANUP_MS;
    for (const entry of entries) {
      if (!entry.isFile() || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-/i.test(entry.name)) {
        continue;
      }
      const target = path.join(dir, entry.name);
      try {
        const stat = await fs.lstat(target);
        if (stat.isFile() && stat.mtimeMs <= cutoff) await fs.unlink(target);
      } catch {
        // A concurrent cleanup/extension host may already have removed it.
      }
    }
  }

  private async removeAllAttachments(): Promise<void> {
    const paths = [...this.committedAttachments.values()].map((entry) => entry.storedPath);
    this.committedAttachments.clear();
    this.bufferedAttachments.clear();
    this.promptAttachmentsBySession.clear();
    this.attachmentBook = createAttachmentBookState();
    await Promise.all(paths.map((target) => fs.unlink(target).catch(() => {})));
  }

  private sendCommandAck(
    peerId: number,
    command: RemoteCommand,
    status: RemoteCommandAckFrame["status"],
    result?: JsonValue,
    errorCode?: string,
    message?: string,
  ): void {
    this.sendJson(peerId, this.makeCommandAck(command, status, result, errorCode, message));
  }

  private makeCommandAck(
    command: RemoteCommand,
    status: RemoteCommandAckFrame["status"],
    result?: JsonValue,
    errorCode?: string,
    message?: string,
  ): RemoteCommandAckFrame {
    const secrets = this.requireSecrets();
    return {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      type: "command-ack",
      hostGeneration: secrets.hostGeneration,
      commandId: command.commandId,
      status,
      ...(result === undefined ? {} : { result: boundedJson(result) }),
      ...(errorCode === undefined ? {} : { errorCode }),
      ...(message === undefined ? {} : { message: message.slice(0, 1024) }),
    };
  }

  private async sendCommandAckAndFlush(
    peerId: number,
    command: RemoteCommand,
    status: RemoteCommandAckFrame["status"],
    result?: JsonValue,
    errorCode?: string,
    message?: string,
  ): Promise<void> {
    await this.sendJsonAsync(peerId, this.makeCommandAck(command, status, result, errorCode, message));
  }

  private async sendStoredCommandAck(peerId: number, command: RemoteCommand, record: DurableCommandRecord): Promise<void> {
    const status = record.status;
    const deviceId = this.secrets?.device?.deviceId;
    const cached = deviceId
      ? this.commandResultStreams.get(this.commandResultStreamKey(deviceId, command.commandId))
      : undefined;
    if (status === "completed" && cached) {
      await this.sendCommandResultStream(peerId, command, cached.packets, cached.marker);
      return;
    }
    if (status === "completed" && isStreamedCommandResultMarker(record.result)) {
      this.sendCommandAck(
        peerId,
        command,
        "indeterminate",
        undefined,
        "result-unavailable",
        "The command completed, but its private result stream was lost when the host restarted; do not retry a mutating action",
      );
      return;
    }
    this.sendCommandAck(
      peerId,
      command,
      status,
      record.result,
      record.errorCode,
      status === "indeterminate" ? "Host restarted after accepting this command; it was not re-dispatched" : undefined,
    );
  }

  private commandResultStreamKey(deviceId: string, commandId: string): string {
    return `${deviceId}:${commandId.toLowerCase()}`;
  }

  private cacheCommandResultStream(stream: CachedCommandResultStream): void {
    const key = this.commandResultStreamKey(stream.deviceId, stream.commandId);
    this.commandResultStreams.delete(key);
    this.commandResultStreams.set(key, stream);
    while (this.commandResultStreams.size > MAX_LIVE_COMMAND_RESULT_STREAMS) {
      const oldest = this.commandResultStreams.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.commandResultStreams.delete(oldest);
    }
  }

  private sendJson(peerId: number, value: unknown): boolean {
    const connection = this.connections.get(peerId);
    const secrets = this.secrets;
    if (!connection || connection.stage !== "active" || !secrets) return false;
    const plaintext = Buffer.from(JSON.stringify(value), "utf8");
    const counter = connection.outgoingCounter;
    connection.outgoingCounter += 1n;
    return this.transport?.send(sealEnvelope({
      key: connection.trafficHostToDevice,
      roomId: secrets.roomId,
      keyEpoch: secrets.keyEpoch,
      direction: "host-to-device",
      peerId,
      envelopePeerId: peerId,
      counter,
      plaintext,
    })) ?? false;
  }

  private async sendJsonAsync(peerId: number, value: unknown): Promise<boolean> {
    const connection = this.connections.get(peerId);
    const secrets = this.secrets;
    if (!connection || connection.stage !== "active" || !secrets) return false;
    const plaintext = Buffer.from(JSON.stringify(value), "utf8");
    const counter = connection.outgoingCounter;
    connection.outgoingCounter += 1n;
    return this.transport?.sendAndWait(sealEnvelope({
      key: connection.trafficHostToDevice,
      roomId: secrets.roomId,
      keyEpoch: secrets.keyEpoch,
      direction: "host-to-device",
      peerId,
      envelopePeerId: peerId,
      counter,
      plaintext,
    })) ?? false;
  }

  private async queueEvent(
    event: RemoteHostEventFrame["event"],
    payload: unknown,
    sessionId?: string,
    onlyPeerId?: number,
  ): Promise<void> {
    const task = this.eventQueue.enqueue(async () => {
      await this.emitEventNow(event, payload, sessionId, onlyPeerId);
      await this.persistDurable();
    }, (error) => {
      this.output.appendLine(`[remote] event delivery failed: ${String(error)}`);
    });
    await task;
  }

  private makeEventFrame(
    event: RemoteHostEventFrame["event"],
    payload: unknown,
    sessionId?: string,
  ): RemoteHostEventFrame | undefined {
    const secrets = this.secrets;
    const durable = this.durable;
    if (!secrets || !durable) return undefined;
    durable.eventSequence = formatUint64Decimal(BigInt(durable.eventSequence) + 1n);
    const frame: RemoteHostEventFrame = {
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      type: "event",
      hostGeneration: secrets.hostGeneration,
      sequence: durable.eventSequence,
      eventId: randomUUID(),
      ...(sessionId === undefined ? {} : { sessionId }),
      event,
      payload: boundedJson(payload),
    };
    // Reconnect always receives a deterministic full sync. Event payloads
    // (transcripts/diffs/diagnostics) never enter plaintext extension storage.
    durable.events = [];
    return frame;
  }

  private async emitEventNow(
    event: RemoteHostEventFrame["event"],
    payload: unknown,
    sessionId?: string,
    onlyPeerId?: number,
  ): Promise<void> {
    const frame = this.makeEventFrame(event, payload, sessionId);
    if (!frame) return;
    if (onlyPeerId !== undefined) {
      await this.sendEventFrame(onlyPeerId, frame);
    } else {
      const peers = [...this.connections.entries()]
        .filter(([, connection]) => connection.stage === "active")
        .map(([peerId]) => peerId);
      await Promise.all(peers.map((peerId) => this.sendEventFrame(peerId, frame)));
    }
  }

  /** Pace every sequenced host event and reserve at most four unacked frames. */
  private async sendEventFrame(
    peerId: number,
    frame: RemoteHostEventFrame,
  ): Promise<{ ack: Promise<void> } | undefined> {
    const connection = this.connections.get(peerId);
    if (!connection || connection.stage !== "active") return undefined;
    const sequence = BigInt(frame.sequence);
    const reservation = await connection.eventWindow.reserve(sequence);
    if (this.connections.get(peerId) !== connection || connection.stage !== "active") {
      connection.eventWindow.reject(sequence, "connection changed before event send");
      return undefined;
    }
    connection.highestSentEventSequence = sequence;
    if (!(await this.sendJsonAsync(peerId, frame))) {
      connection.eventWindow.reject(sequence, "relay disconnected while sending event");
      throw new Error("relay disconnected while sending event");
    }
    return reservation;
  }

  private async sendFullSync(peerId: number): Promise<void> {
    // The entire snapshot/replay is one event-queue transaction. Live frames
    // arriving while RPC reads are in flight are queued only after `complete`.
    const task = this.eventQueue.enqueue(async () => {
      const sessions = this.allowedSessions();
      const sessionData: Array<{ sessionId: string; snapshot: JsonValue }> = [];
      for (const session of sessions) {
        try {
          sessionData.push({ sessionId: session.remoteSessionId, snapshot: await session.remoteFullSync() });
        } catch (error) {
          sessionData.push({ sessionId: session.remoteSessionId, snapshot: { error: String(error) } });
        }
      }
      const syncId = randomUUID();
      let finalAck: Promise<void> | undefined;
      for (const packet of planRemoteFullSync(syncId, sessionData, this.selectedSessionId)) {
        const frame = this.makeEventFrame("full-sync", packet.payload, packet.sessionId);
        if (!frame) throw new Error("remote state disappeared during full sync");
        const sent = await this.sendEventFrame(peerId, frame);
        if (!sent) throw new Error("device disconnected during full sync");
        finalAck = sent.ack;
      }
      if (this.secrets?.scope.verbs.includes("credentials.manage")) {
        const keyStatusFrame = this.makeEventFrame(
          "session-message",
          await this.remoteKeyStatus(),
          this.selectedSessionId,
        );
        if (keyStatusFrame) {
          const sent = await this.sendEventFrame(peerId, keyStatusFrame);
          if (!sent) throw new Error("device disconnected during credential status sync");
          finalAck = sent.ack;
        }
      }
      // Holding the event queue until `complete` is applied prevents a live
      // frame from appearing between reset/transcript snapshot phases.
      await finalAck;
      await this.persistDurable();
    }, (error) => {
      this.output.appendLine(`[remote] atomic full sync stopped: ${String(error)}`);
    });
    await task;
  }

  /**
   * Send one private command result as an indivisible sequenced event batch.
   * No live/full-sync event can interleave, and the terminal command ACK is
   * emitted by the caller only after Android cumulatively ACKs `commit`.
   */
  private async sendCommandResultStream(
    peerId: number,
    command: RemoteCommand,
    packets: readonly RemoteCommandResultPacket[],
    marker: JsonValue,
  ): Promise<void> {
    const task = this.eventQueue.enqueue(async () => {
      let finalAck: Promise<void> | undefined;
      for (const packet of packets) {
        const frame = this.makeEventFrame("command-result", packet.payload, command.sessionId);
        if (!frame) throw new Error("remote state disappeared during command-result stream");
        const sent = await this.sendEventFrame(peerId, frame);
        if (!sent) throw new Error("device disconnected during command-result stream");
        finalAck = sent.ack;
      }
      if (!finalAck) throw new Error("command-result stream was empty");
      await finalAck;
      await this.persistDurable();
      if (!(await this.sendJsonAsync(peerId, this.makeCommandAck(command, "completed", marker)))) {
        throw new Error("device disconnected before command-result terminal ACK");
      }
    }, (error) => {
      this.output.appendLine(`[remote] atomic command-result stream stopped: ${String(error)}`);
    });
    await task;
  }

  private acceptEventAck(connection: ConnectionState, sequence: bigint): void {
    if (sequence > connection.highestSentEventSequence) {
      throw new Error("event ACK is ahead of the sequence sent to this device");
    }
    connection.eventWindow.acknowledge(sequence);
  }

  private dropConnection(peerId: number, reason: string): void {
    const connection = this.connections.get(peerId);
    if (!connection) return;
    this.connections.delete(peerId);
    connection.eventWindow.close(reason);
  }

  private onEventAckTimeout(
    peerId: number,
    eventWindow: RemoteEventAckWindow,
    sequence: bigint,
    error: Error,
  ): void {
    if (this.connections.get(peerId)?.eventWindow !== eventWindow) return;
    this.output.appendLine(`[remote] ${error.message}; reconnecting for deterministic resync`);
    this.dropConnection(peerId, `event ACK timeout at ${sequence.toString(10)}`);
    this.transport?.forceReconnect("remote event ACK timeout");
  }

  private clearConnections(reason: string): void {
    for (const peerId of [...this.connections.keys()]) this.dropConnection(peerId, reason);
  }

  private onSessionMessage(event: RemoteSessionMessage): void {
    if (!this.secrets || !this.isSessionAllowed(event.sessionId)) return;
    const frame = event.message.t === "frame" && event.message.frame && typeof event.message.frame === "object"
      ? event.message.frame as Record<string, unknown>
      : undefined;
    if (frame?.type === "agent_end") {
      const attachmentIds = this.promptAttachmentsBySession.get(event.sessionId);
      if (attachmentIds?.size) {
        this.promptAttachmentsBySession.delete(event.sessionId);
        void this.consumeCommittedAttachments([...attachmentIds]).catch((error) => {
          this.output.appendLine(`[remote] completed-turn attachment cleanup failed: ${String(error)}`);
        });
      }
    }
    const filtered = filterRemoteSessionMessage(event.message, this.secrets.scope.verbs);
    if (filtered) void this.queueEvent("session-message", filtered, event.sessionId);
  }

  private onSessionBoardChange(): void {
    if (!this.secrets) {
      if (this.restoreDeferred && !this.restoreInProgress) {
        void this.restore().catch((error) => this.output.appendLine(`[remote] deferred restore failed: ${String(error)}`));
      }
      return;
    }
    void this.refreshScopedSessions().then(async () => {
      this.acquireScopedLeases();
      await this.queueEvent("session-board", {
        sessions: this.allowedSessions().map((session) => session.snapshot()),
        selectedSessionId: this.selectedSessionId,
      });
    }).catch((error) => this.output.appendLine(`[remote] session scope refresh failed: ${String(error)}`));
  }

  private acquireScopedLeases(): void {
    const allowed = this.allowedSessions();
    const liveIds = new Set(allowed.map((session) => session.remoteSessionId));
    for (const [sessionId, lease] of this.leases) {
      if (!liveIds.has(sessionId)) {
        lease.dispose();
        this.leases.delete(sessionId);
      }
    }
    for (const session of allowed) this.acquireLease(session);
  }

  private acquireLease(session: OmpSession): void {
    if (!this.leases.has(session.remoteSessionId)) {
      this.leases.set(session.remoteSessionId, session.retainRemoteLease());
    }
  }

  private allowedSessions(): OmpSession[] {
    const scope = this.secrets?.scope;
    if (!scope) return [];
    // `allSessions` grants lifecycle verbs but never expands the frozen
    // desktop-consented workspace/session set implicitly.
    return OmpSession.allSessions().filter((session) => scope.sessionIds.includes(session.remoteSessionId));
  }

  private isSessionAllowed(sessionId: string): boolean {
    const scope = this.secrets?.scope;
    return !!scope && scope.sessionIds.includes(sessionId);
  }

  private findAllowedSession(sessionId: string): OmpSession | undefined {
    return this.allowedSessions().find((session) => session.remoteSessionId === sessionId);
  }

  private async remapScopeToLiveSessions(secrets: StoredRemoteSecrets, sessions: OmpSession[]): Promise<boolean> {
    const inside: OmpSession[] = [];
    for (const session of sessions) {
      try {
        await requireCanonicalRemotePath(session.remoteWorkspaceRoot, secrets.scope.workspaceRoots);
        inside.push(session);
      } catch {
        // A newly added/outside workspace never inherits an old phone grant.
      }
    }
    const restored = selectRestoredRemoteSessionIds(
      secrets.scope.allSessions,
      secrets.scope.sessionIds,
      inside.map((session) => session.remoteSessionId),
    );
    if (!restored) return false;
    secrets.scope.sessionIds = restored;
    return true;
  }

  /**
   * `allSessions` expands only inside the immutable desktop-consented roots.
   * Canonical checks happen before a new live session enters the signed grant.
   */
  private refreshScopedSessions(): Promise<void> {
    const task = this.scopeRefreshQueue.then(async () => {
      const secrets = this.secrets;
      if (!secrets?.scope.allSessions) return;
      const nextIds: string[] = [];
      const liveSessions = OmpSession.allSessions();
      for (const session of liveSessions) {
        try {
          await requireCanonicalRemotePath(session.remoteWorkspaceRoot, secrets.scope.workspaceRoots);
          nextIds.push(session.remoteSessionId);
        } catch {
          // Sessions outside the frozen canonical roots are invisible remotely.
        }
      }
      const liveIds = new Set(liveSessions.map((session) => session.remoteSessionId));
      for (const [sessionId, attachmentIds] of this.promptAttachmentsBySession) {
        if (liveIds.has(sessionId)) continue;
        this.promptAttachmentsBySession.delete(sessionId);
        await this.consumeCommittedAttachments([...attachmentIds]);
      }
      const unchanged = nextIds.length === secrets.scope.sessionIds.length &&
        nextIds.every((sessionId, index) => sessionId === secrets.scope.sessionIds[index]);
      if (unchanged) return;
      secrets.scope.sessionIds = nextIds;
      if (secrets.device) {
        secrets.device.capability = this.makeCapability(secrets.device.deviceId, secrets);
        secrets.device.capabilitySignature = this.signCapability(secrets, secrets.device.capability);
      }
      if (!nextIds.includes(this.selectedSessionId ?? "")) this.selectedSessionId = nextIds[0];
      await this.writeSecrets();
      this.publishCapabilityUpdate();
    });
    this.scopeRefreshQueue = task.catch(() => {});
    return task;
  }

  private makeCapability(deviceId: string, secrets: StoredRemoteSecrets): CapabilityManifest {
    const now = Date.now();
    return parseCapabilityManifest({
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      manifestId: randomUUID(),
      deviceId,
      keyEpoch: secrets.keyEpoch,
      issuedAt: now,
      expiresAt: now + CAPABILITY_TTL_MS,
      verbs: secrets.scope.verbs,
      sessionIds: secrets.scope.sessionIds,
      workspaceRoots: secrets.scope.workspaceRoots,
      allSessions: secrets.scope.allSessions,
    });
  }

  private signCapability(secrets: StoredRemoteSecrets, capability: CapabilityManifest): string {
    const signingKey = deriveDirectionalKey(Buffer.from(secrets.deviceToken, "base64url"), {
      roomId: secrets.roomId,
      keyEpoch: secrets.keyEpoch,
      purpose: "auth",
      direction: "host-to-device",
    });
    return signCapabilityManifest(signingKey, capability);
  }

  private scheduleCapabilityRefresh(): void {
    if (this.capabilityRefreshTimer) clearTimeout(this.capabilityRefreshTimer);
    this.capabilityRefreshTimer = undefined;
    const device = this.secrets?.device;
    if (!device) return;
    const delay = remoteCapabilityRefreshDelay(device.capability.expiresAt, Date.now());
    this.capabilityRefreshTimer = setTimeout(() => {
      this.capabilityRefreshTimer = undefined;
      void this.refreshActiveCapability().catch((error) => {
        this.output.appendLine(`[remote] capability refresh failed: ${String(error)}`);
        this.scheduleCapabilityRefresh();
      });
    }, Math.max(1, delay));
  }

  private schedulePairingExpiry(): void {
    if (this.pairingExpiryTimer) clearTimeout(this.pairingExpiryTimer);
    this.pairingExpiryTimer = undefined;
    const expiresAt = this.secrets?.pairingExpiresAt;
    if (!expiresAt) return;
    this.pairingExpiryTimer = setTimeout(() => {
      this.pairingExpiryTimer = undefined;
      const secrets = this.secrets;
      if (!secrets?.pairingExpiresAt || secrets.pairingExpiresAt > Date.now()) {
        this.schedulePairingExpiry();
        return;
      }
      if (secrets.device) {
        // A refreshed QR that nobody scanned while a phone is already paired is
        // just a stale bearer secret. Drop it; the live session is untouched.
        delete secrets.pairingKey;
        delete secrets.pairingExpiresAt;
        delete secrets.pending;
        this.pairingUri = undefined;
        void this.writeSecrets()
          .then(() => this.refreshPanel())
          .catch((error) => this.output.appendLine(`[remote] stale pairing cleanup failed: ${String(error)}`));
        return;
      }
      void this.stop(true).catch((error) => {
        this.output.appendLine(`[remote] expired pairing cleanup failed: ${String(error)}`);
      });
    }, Math.max(1, expiresAt - Date.now()));
  }

  private async refreshActiveCapability(): Promise<void> {
    const secrets = this.secrets;
    const device = secrets?.device;
    if (!secrets || !device) return;
    if (shouldRefreshRemoteCapability(device.capability.expiresAt, Date.now())) {
      device.capability = this.makeCapability(device.deviceId, secrets);
      device.capabilitySignature = this.signCapability(secrets, device.capability);
      await this.writeSecrets();
      await this.queueEvent("capability-update", {
        capability: device.capability,
        capabilitySignature: device.capabilitySignature,
      });
    }
    this.scheduleCapabilityRefresh();
  }

  private publishCapabilityUpdate(): void {
    const device = this.secrets?.device;
    if (!device) return;
    this.scheduleCapabilityRefresh();
    void this.queueEvent("capability-update", {
      capability: device.capability,
      capabilitySignature: device.capabilitySignature,
    });
  }

  private restartAllSessions(): Promise<void> {
    return Promise.all(OmpSession.allSessions().map((session) => session.restart())).then(() => undefined);
  }

  /** Credential presence only; secret values never enter the remote event feed. */
  private async remoteKeyStatus(): Promise<JsonValue> {
    const keys: Record<string, boolean> = {};
    for (const provider of KEYED_PROVIDERS) {
      keys[provider.id] = Boolean(await this.context.secrets.get(provider.secret));
    }
    return {
      t: "keyStatus",
      keys,
      providers: KEYED_PROVIDERS.map((provider) => ({
        id: provider.id,
        label: provider.label,
        // Absent for providers keyed through models.yml — the phone renders the
        // label alone rather than naming a variable nothing reads.
        ...(provider.envVar === undefined ? {} : { envVar: provider.envVar }),
        placeholder: provider.placeholder,
      })),
    };
  }

  private async allowedHistory(): Promise<Awaited<ReturnType<typeof listSessions>>> {
    const roots = this.requireSecrets().scope.workspaceRoots;
    const entries = await listSessions(500);
    const allowed: Awaited<ReturnType<typeof listSessions>> = [];
    for (const entry of entries) {
      if (!entry.cwd) continue;
      try {
        await requireCanonicalRemotePath(entry.cwd, roots);
        allowed.push(entry);
      } catch {
        // History from another workspace stays outside this device grant.
      }
    }
    return allowed;
  }

  private pruneLiveCommandRecords(): void {
    const durable = this.durable;
    if (!durable) return;
    const devices: DurableCommandState["devices"] = {};
    for (const [deviceId, device] of Object.entries(durable.commands.devices)) {
      const unsettled = Object.values(device.commands)
        .filter((record) => record.status === "accepted" || record.status === "indeterminate");
      const terminal = Object.values(device.commands)
        .filter((record) => record.status === "completed" || record.status === "rejected")
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_TERMINAL_COMMAND_RECORDS_PER_DEVICE);
      devices[deviceId] = {
        highWaterCounter: device.highWaterCounter,
        commands: Object.fromEntries([...unsettled, ...terminal].map((record) => [record.commandId, record])),
      };
    }
    durable.commands = { ...durable.commands, devices };
  }

  private requireSecrets(): StoredRemoteSecrets {
    if (!this.secrets) throw new Error("remote control is not running");
    return this.secrets;
  }

  private async readSecrets(): Promise<StoredRemoteSecrets | undefined> {
    const encoded = await this.context.secrets.get(SECRET_KEY);
    if (!encoded) return undefined;
    try {
      return JSON.parse(encoded) as StoredRemoteSecrets;
    } catch {
      await this.deleteSecrets();
      return undefined;
    }
  }

  private async commitActiveRevocation(): Promise<void> {
    const secrets = this.requireSecrets();
    if (this.revocationCommitted) return;
    this.revocationCommitted = true;
    try {
      await commitRemoteRevocation(
        secrets.keyEpoch,
        async (keyEpoch) => {
          const previousRevokedEpoch = this.context.globalState.get<number>(REVOKED_EPOCH_KEY, 0);
          await Promise.all([
            this.context.globalState.update(REVOKED_EPOCH_KEY, Math.max(previousRevokedEpoch, keyEpoch)),
            this.context.globalState.update(LAST_EPOCH_KEY, keyEpoch),
          ]);
        },
        () => this.deleteSecrets(),
      );
    } catch (error) {
      // Keep the in-memory flag set: subsequent SecretStorage writes must not
      // resurrect an epoch once its tombstone may have committed.
      this.transport?.stop();
      this.clearConnections("remote revocation persistence failed");
      throw error;
    }
  }

  private async revokeUnrestorableStoredEpoch(stored: StoredRemoteSecrets): Promise<void> {
    await commitRemoteRevocation(
      stored.keyEpoch,
      async (keyEpoch) => {
        const previousRevokedEpoch = this.context.globalState.get<number>(REVOKED_EPOCH_KEY, 0);
        await Promise.all([
          this.context.globalState.update(REVOKED_EPOCH_KEY, Math.max(previousRevokedEpoch, keyEpoch)),
          this.context.globalState.update(LAST_EPOCH_KEY, keyEpoch),
        ]);
      },
      () => this.deleteSecrets(),
    );
    await this.context.globalState.update(DURABLE_KEY, undefined);
  }

  private writeSecrets(): Promise<void> {
    if (this.revocationCommitted) return this.deleteSecrets();
    const secrets = this.requireSecrets();
    const snapshot = JSON.stringify(secrets);
    return this.secretWriter.enqueue(snapshot, (encoded) =>
      encoded === undefined
        ? this.context.secrets.delete(SECRET_KEY)
        : this.context.secrets.store(SECRET_KEY, encoded));
  }

  private deleteSecrets(): Promise<void> {
    return this.secretWriter.enqueue(undefined, () => this.context.secrets.delete(SECRET_KEY));
  }

  private persistDurable(): Promise<void> {
    const durable = this.durable;
    if (!durable) {
      return this.durableWriter.enqueue(undefined, (snapshot) =>
        this.context.globalState.update(DURABLE_KEY, snapshot));
    }
    const devices: DurableCommandState["devices"] = {};
    for (const [deviceId, device] of Object.entries(durable.commands.devices)) {
      const records = Object.values(device.commands);
      const unsettled = records.filter((record) => record.status === "accepted" || record.status === "indeterminate");
      const terminal = records
        .filter((record) => record.status === "completed" || record.status === "rejected")
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, MAX_TERMINAL_COMMAND_RECORDS_PER_DEVICE);
      const commands: Record<string, DurableCommandRecord> = {};
      for (const record of [...unsettled, ...terminal]) {
        commands[record.commandId] = {
          ...record,
          // Results can contain transcripts, diffs or diagnostics. Terminal
          // status/high-water is sufficient across restart; resync rebuilds UI.
          result: isStreamedCommandResultMarker(record.result) ? record.result : undefined,
        };
      }
      devices[deviceId] = { highWaterCounter: device.highWaterCounter, commands };
    }
    const persisted: StoredDurableRemoteState = {
      commands: { keyEpoch: durable.commands.keyEpoch, devices },
      eventSequence: durable.eventSequence,
      events: [],
    };
    return this.durableWriter.enqueue(persisted, (snapshot) =>
      this.context.globalState.update(DURABLE_KEY, snapshot));
  }

  private async refreshPanel(): Promise<void> {
    const panel = this.panel;
    if (!panel) return;
    const esc = (value: unknown): string => String(value ?? "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const status = this.currentStatus();
    const live = Boolean(this.pairingUri && status.pairingExpiresAt && status.pairingExpiresAt > Date.now());
    let qr = "";
    if (live) {
      qr = await QRCode.toString(this.pairingUri!, { type: "svg", width: 360, margin: 2, errorCorrectionLevel: "M" });
    }
    // A QR that has quietly gone stale looks exactly like one that still works, and
    // the scan fails on the phone instead of here. Say when it dies, and offer the
    // one action that fixes it without walking back through the grant prompt.
    const expiresLabel = live
      ? t("This code stops working at {0}.", new Date(status.pairingExpiresAt!).toLocaleTimeString())
      : "";
    const refresh = this.canRefreshPairing()
      ? `<p><a href="command:ompcode.remoteRefreshPairing">${esc(t("Refresh the QR code"))}</a>${
        this.hasPairedDevice() ? ` <span class="muted">${esc(t("— a new code lets another phone take this one's place"))}</span>` : ""
      }</p>`
      : "";
    const expired = !live && this.canRefreshPairing() && !this.hasPairedDevice()
      ? `<p class="muted">${esc(t("The pairing code has expired."))}</p>`
      : "";
    const nonce = randomUUID().replace(/-/g, "");
    panel.webview.html = `<!doctype html><html><head>
      <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; img-src data:;">
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <style nonce="${nonce}">body{font:14px var(--vscode-font-family);padding:24px;max-width:720px;margin:auto;color:var(--vscode-foreground)}.card{border:1px solid var(--vscode-panel-border);border-radius:12px;padding:20px;background:var(--vscode-editor-background)}.qr{max-width:360px;background:white;padding:10px;border-radius:8px}.row{margin:10px 0}.muted{color:var(--vscode-descriptionForeground)}a{color:var(--vscode-textLink-foreground)}</style>
      </head><body><div class="card"><h1>OMP Code Remote Control</h1>
      <div class="row">Relay: <code>${esc(status.relayUrl ?? "stopped")}</code></div>
      <div class="row">Transport: <strong>${esc(status.transport)}</strong></div>
      ${status.pairedDevice ? `<div class="row">Device: <strong>${esc(status.pairedDevice)}</strong></div>` : ""}
      ${qr ? `<div class="qr">${qr}</div><p class="muted">${esc(expiresLabel)}</p><p><a href="command:ompcode.remoteCopyPairing">${esc(t("Copy pairing link"))}</a></p><p class="muted">${esc(t("The QR contains a short-lived secret. Do not publish screenshots."))}</p>` : ""}
      ${expired}
      ${refresh}
      ${!status.running ? `<p>${esc(t("Remote Control is stopped and old credentials are revoked."))}</p>` : ""}
      </div></body></html>`;
  }
}
