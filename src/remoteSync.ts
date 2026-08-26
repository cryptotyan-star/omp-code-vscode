import type { JsonValue } from "./remoteProtocol.ts";

export const MAX_REMOTE_SYNC_PAYLOAD_BYTES = 180 * 1024;
export const MAX_REMOTE_SYNC_SESSIONS = 128;
export const MAX_REMOTE_SYNC_FRAGMENTS = 32;
export const MAX_REMOTE_SYNC_LOGICAL_BYTES = 2 * 1024 * 1024;
const FRAGMENT_SOURCE_BYTES = 96 * 1024;
const MAX_SESSION_META_BYTES = 1024;

export interface RemoteSyncSession {
  sessionId: string;
  snapshot: JsonValue;
}

export interface RemoteSyncPacket {
  sessionId?: string;
  payload: JsonValue;
}

function object(value: JsonValue): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {};
}

function packetBytes(packet: RemoteSyncPacket): number {
  return Buffer.byteLength(JSON.stringify(packet.payload));
}

function logicalBytes(value: JsonValue): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function noticeValue(code: string, originalBytes: number, detail: Record<string, JsonValue> = {}): JsonValue {
  return {
    remoteSyncNotice: {
      code,
      originalBytes,
      message: "Remote item omitted from live sync; use transcript export on the desktop for the complete content.",
      ...detail,
    },
  };
}

function fragments(
  syncId: string,
  sessionId: string,
  phase: "section-fragment" | "transcript-fragment",
  identity: Record<string, JsonValue>,
  value: JsonValue,
): RemoteSyncPacket[] {
  const encoded = Buffer.from(JSON.stringify(value), "utf8");
  if (encoded.byteLength > MAX_REMOTE_SYNC_LOGICAL_BYTES) {
    throw new Error("remote full-sync logical item exceeds the reassembly limit");
  }
  const count = Math.ceil(encoded.byteLength / FRAGMENT_SOURCE_BYTES);
  if (count > MAX_REMOTE_SYNC_FRAGMENTS) {
    throw new Error("remote full-sync item exceeds the fragment-count limit");
  }
  const result: RemoteSyncPacket[] = [];
  for (let index = 0; index < count; index += 1) {
    const data = encoded.subarray(index * FRAGMENT_SOURCE_BYTES, (index + 1) * FRAGMENT_SOURCE_BYTES).toString("base64");
    result.push({
      sessionId,
      payload: {
        phase,
        syncId,
        sessionId,
        encoding: "base64-json",
        fragmentIndex: index,
        fragmentCount: count,
        data,
        ...identity,
      },
    });
  }
  return result;
}

/**
 * Deterministic full-sync plan. Structure is never replaced by a preview:
 * large sections/messages use explicit reassembly fragments.
 */
export function planRemoteFullSync(
  syncId: string,
  sessions: readonly RemoteSyncSession[],
  selectedSessionId?: string,
): RemoteSyncPacket[] {
  const included = sessions.slice(0, MAX_REMOTE_SYNC_SESSIONS);
  const includedIds = new Set(included.map((entry) => entry.sessionId));
  const effectiveSelectedSessionId = selectedSessionId && includedIds.has(selectedSessionId)
    ? selectedSessionId
    : included[0]?.sessionId;
  const packets: RemoteSyncPacket[] = [{
    payload: {
      phase: "begin",
      syncId,
      selectedSessionId: effectiveSelectedSessionId ?? null,
      sessions: included.map(({ sessionId, snapshot }) => {
        const metadata = object(snapshot).session ?? null;
        return {
        sessionId,
          session: logicalBytes(metadata) <= MAX_SESSION_META_BYTES
            ? metadata
            : noticeValue("session-metadata-too-large", logicalBytes(metadata), { sessionId }),
        };
      }),
    },
  }];
  if (sessions.length > included.length) {
    packets.push({
      payload: {
        phase: "notice",
        syncId,
        code: "session-limit",
        totalSessions: sessions.length,
        includedSessions: included.length,
        omittedSessions: sessions.length - included.length,
      },
    });
  }
  const sectionNames = [
    "state", "models", "commands", "stats", "approvalMode", "profile", "configuration", "approvals",
  ] as const;
  for (const entry of included) {
    const snapshot = object(entry.snapshot);
    packets.push({
      sessionId: entry.sessionId,
      payload: { phase: "reset", syncId, sessionId: entry.sessionId },
    });
    for (const section of sectionNames) {
      const originalValue = snapshot[section] ?? null;
      const originalBytes = logicalBytes(originalValue);
      const value = originalBytes <= MAX_REMOTE_SYNC_LOGICAL_BYTES
        ? originalValue
        : noticeValue("section-too-large", originalBytes, { section });
      const direct: RemoteSyncPacket = {
        sessionId: entry.sessionId,
        payload: { phase: "section", syncId, sessionId: entry.sessionId, section, value },
      };
      if (packetBytes(direct) <= MAX_REMOTE_SYNC_PAYLOAD_BYTES) {
        packets.push(direct);
      } else {
        packets.push(...fragments(syncId, entry.sessionId, "section-fragment", { section }, value));
      }
    }
    const transcriptValue = snapshot.transcript;
    const transcript = Array.isArray(transcriptValue) ? transcriptValue : [];
    let messages: JsonValue[] = [];
    let chunkIndex = 0;
    const flush = (): void => {
      if (!messages.length) return;
      packets.push({
        sessionId: entry.sessionId,
        payload: {
          phase: "transcript",
          syncId,
          sessionId: entry.sessionId,
          chunkIndex,
          messages,
        },
      });
      messages = [];
      chunkIndex += 1;
    };
    transcript.forEach((originalMessage, messageIndex) => {
      const originalBytes = logicalBytes(originalMessage);
      const message = originalBytes <= MAX_REMOTE_SYNC_LOGICAL_BYTES
        ? originalMessage
        : {
            role: "system",
            content: "One transcript message is too large for Remote Control live sync.",
            ...object(noticeValue("transcript-message-too-large", originalBytes, { messageIndex })),
          } as JsonValue;
      const candidate: RemoteSyncPacket = {
        sessionId: entry.sessionId,
        payload: {
          phase: "transcript",
          syncId,
          sessionId: entry.sessionId,
          chunkIndex,
          messages: [...messages, message],
        },
      };
      if (packetBytes(candidate) <= MAX_REMOTE_SYNC_PAYLOAD_BYTES) {
        messages.push(message);
        return;
      }
      flush();
      const single: RemoteSyncPacket = {
        sessionId: entry.sessionId,
        payload: { phase: "transcript", syncId, sessionId: entry.sessionId, chunkIndex, messages: [message] },
      };
      if (packetBytes(single) <= MAX_REMOTE_SYNC_PAYLOAD_BYTES) {
        messages.push(message);
      } else {
        packets.push(...fragments(
          syncId,
          entry.sessionId,
          "transcript-fragment",
          { messageIndex },
          message,
        ));
      }
    });
    flush();
    packets.push({
      sessionId: entry.sessionId,
      payload: { phase: "session-complete", syncId, sessionId: entry.sessionId },
    });
  }
  packets.push({ payload: { phase: "complete", syncId } });
  for (const packet of packets) {
    if (packetBytes(packet) > MAX_REMOTE_SYNC_PAYLOAD_BYTES) {
      throw new Error("remote full-sync planner emitted an oversized packet");
    }
  }
  const fragmentCounts = new Map<string, number>();
  for (const packet of packets) {
    const payload = object(packet.payload);
    if (payload.phase !== "section-fragment" && payload.phase !== "transcript-fragment") continue;
    const key = `${String(payload.sessionId)}:${String(payload.phase)}:${String(payload.section ?? payload.messageIndex)}`;
    fragmentCounts.set(key, Number(payload.fragmentCount));
  }
  if ([...fragmentCounts.values()].some((count) => count > MAX_REMOTE_SYNC_FRAGMENTS)) {
    throw new Error("remote full-sync planner exceeded the fragment-count limit");
  }
  return packets;
}
