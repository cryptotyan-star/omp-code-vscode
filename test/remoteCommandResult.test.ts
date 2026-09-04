import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  MAX_INLINE_REMOTE_COMMAND_RESULT_BYTES,
  MAX_REMOTE_COMMAND_RESULT_BYTES,
  MAX_REMOTE_COMMAND_RESULT_CHUNK_BYTES,
  MAX_REMOTE_COMMAND_RESULT_CHUNKS,
  planRemoteCommandResult,
} from "../src/remoteCommandResult.ts";

const COMMAND_ID = "11111111-1111-4111-8111-111111111111";
const STREAM_ID = "22222222-2222-4222-8222-222222222222";

test("a small command result remains schema-identical inline", () => {
  const result = { markdown: "small diff", nested: { token: "correlation" } };
  const plan = planRemoteCommandResult(COMMAND_ID, STREAM_ID, result);
  assert.equal(plan.kind, "inline");
  if (plan.kind !== "inline") return;
  assert.deepEqual(plan.result, result);
  assert.ok(plan.totalBytes <= MAX_INLINE_REMOTE_COMMAND_RESULT_BYTES);
});

test("a 65 KiB diff-like result uses bounded begin/chunk/commit events", () => {
  const result = { diff: "Ж".repeat(34_000), path: "/workspace/change.ts" };
  const source = Buffer.from(JSON.stringify(result), "utf8");
  assert.ok(source.byteLength > MAX_INLINE_REMOTE_COMMAND_RESULT_BYTES);
  const plan = planRemoteCommandResult(COMMAND_ID, STREAM_ID, result);
  assert.equal(plan.kind, "stream");
  if (plan.kind !== "stream") return;

  const payloads = plan.packets.map((packet) => packet.payload as Record<string, unknown>);
  assert.equal(payloads[0]?.phase, "begin");
  assert.equal(payloads.at(-1)?.phase, "commit");
  const chunks = payloads.filter((payload) => payload.phase === "chunk");
  assert.ok(chunks.length > 0 && chunks.length <= MAX_REMOTE_COMMAND_RESULT_CHUNKS);
  assert.ok(chunks.every((payload) =>
    Buffer.from(String(payload.data), "base64").byteLength <= MAX_REMOTE_COMMAND_RESULT_CHUNK_BYTES));
  const rebuilt = Buffer.concat(chunks
    .sort((left, right) => Number(left.index) - Number(right.index))
    .map((payload) => Buffer.from(String(payload.data), "base64")));
  assert.deepEqual(JSON.parse(rebuilt.toString("utf8")), result);
  assert.equal(createHash("sha256").update(rebuilt).digest("hex"), plan.sha256);
  assert.deepEqual(plan.marker, { streamed: true, totalBytes: source.byteLength, sha256: plan.sha256 });
  assert.ok(plan.packets.every((packet) => Buffer.byteLength(JSON.stringify(packet.payload)) < 180 * 1024));
});

test("a result over two MiB is typed-rejected without chunks or preview", () => {
  const marker = "must-not-cross-wire-";
  const result = { diff: marker + "x".repeat(MAX_REMOTE_COMMAND_RESULT_BYTES) };
  const plan = planRemoteCommandResult(COMMAND_ID, STREAM_ID, result);
  assert.deepEqual(plan, {
    kind: "rejected",
    errorCode: "result-too-large",
    totalBytes: Buffer.byteLength(JSON.stringify(result)),
    maximumBytes: MAX_REMOTE_COMMAND_RESULT_BYTES,
  });
  assert.equal(JSON.stringify(plan).includes(marker), false);
});
