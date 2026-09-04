import { createHash } from "node:crypto";
import type { JsonValue } from "./remoteProtocol.ts";

export const MAX_INLINE_REMOTE_COMMAND_RESULT_BYTES = 64 * 1024;
export const MAX_REMOTE_COMMAND_RESULT_BYTES = 2 * 1024 * 1024;
export const MAX_REMOTE_COMMAND_RESULT_CHUNK_BYTES = 96 * 1024;
export const MAX_REMOTE_COMMAND_RESULT_CHUNKS = 32;

export interface RemoteCommandResultPacket {
  payload: JsonValue;
}

export type RemoteCommandResultPlan =
  | { kind: "inline"; result: JsonValue; totalBytes: number }
  | {
      kind: "stream";
      packets: readonly RemoteCommandResultPacket[];
      marker: JsonValue;
      totalBytes: number;
      sha256: string;
    }
  | {
      kind: "rejected";
      errorCode: "result-too-large";
      totalBytes: number;
      maximumBytes: number;
    };

function encodeJson(value: unknown): { value: JsonValue; bytes: Buffer } {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value, (_key, entry: unknown) =>
      typeof entry === "bigint" ? entry.toString(10) : entry);
  } catch {
    throw new Error("remote command result is not JSON serializable");
  }
  if (encoded === undefined) encoded = "null";
  return {
    value: JSON.parse(encoded) as JsonValue,
    bytes: Buffer.from(encoded, "utf8"),
  };
}

/**
 * Plan a private command result without ever replacing its schema with a
 * preview. Small results remain inline; larger JSON is split into a bounded,
 * authenticated event stream which the caller sends atomically.
 */
export function planRemoteCommandResult(
  commandId: string,
  streamId: string,
  result: unknown,
): RemoteCommandResultPlan {
  const encoded = encodeJson(result);
  const totalBytes = encoded.bytes.byteLength;
  if (totalBytes <= MAX_INLINE_REMOTE_COMMAND_RESULT_BYTES) {
    return { kind: "inline", result: encoded.value, totalBytes };
  }
  if (totalBytes > MAX_REMOTE_COMMAND_RESULT_BYTES) {
    return {
      kind: "rejected",
      errorCode: "result-too-large",
      totalBytes,
      maximumBytes: MAX_REMOTE_COMMAND_RESULT_BYTES,
    };
  }

  const chunkCount = Math.ceil(totalBytes / MAX_REMOTE_COMMAND_RESULT_CHUNK_BYTES);
  if (chunkCount < 1 || chunkCount > MAX_REMOTE_COMMAND_RESULT_CHUNKS) {
    return {
      kind: "rejected",
      errorCode: "result-too-large",
      totalBytes,
      maximumBytes: MAX_REMOTE_COMMAND_RESULT_BYTES,
    };
  }
  const sha256 = createHash("sha256").update(encoded.bytes).digest("hex");
  const packets: RemoteCommandResultPacket[] = [{
    payload: {
      phase: "begin",
      streamId,
      commandId,
      encoding: "base64-json",
      totalBytes,
      chunkCount,
      sha256,
    },
  }];
  for (let index = 0; index < chunkCount; index += 1) {
    const chunk = encoded.bytes.subarray(
      index * MAX_REMOTE_COMMAND_RESULT_CHUNK_BYTES,
      (index + 1) * MAX_REMOTE_COMMAND_RESULT_CHUNK_BYTES,
    );
    packets.push({
      payload: {
        phase: "chunk",
        streamId,
        commandId,
        index,
        chunkCount,
        data: chunk.toString("base64"),
      },
    });
  }
  packets.push({
    payload: {
      phase: "commit",
      streamId,
      commandId,
      totalBytes,
      chunkCount,
      sha256,
    },
  });
  return {
    kind: "stream",
    packets,
    marker: { streamed: true, totalBytes, sha256 },
    totalBytes,
    sha256,
  };
}
