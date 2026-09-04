import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MAX_REMOTE_SYNC_FRAGMENTS,
  MAX_REMOTE_SYNC_PAYLOAD_BYTES,
  MAX_REMOTE_SYNC_SESSIONS,
  planRemoteFullSync,
} from "../src/remoteSync.ts";

test("full sync chunks a transcript larger than 256 KiB without preview truncation", () => {
  const transcript = Array.from({ length: 320 }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    content: `${index}:` + "Ж".repeat(700),
  }));
  const packets = planRemoteFullSync("sync-1", [{
    sessionId: "session-1",
    snapshot: { session: { id: "session-1" }, state: {}, transcript },
  }], "session-1");
  assert.ok(Buffer.byteLength(JSON.stringify(transcript)) > 256 * 1024);
  assert.ok(packets.every((packet) => Buffer.byteLength(JSON.stringify(packet.payload)) <= MAX_REMOTE_SYNC_PAYLOAD_BYTES));
  const rebuilt = packets
    .map((packet) => packet.payload as Record<string, unknown>)
    .filter((payload) => payload.phase === "transcript")
    .flatMap((payload) => payload.messages as unknown[]);
  assert.deepEqual(rebuilt, transcript);
  assert.equal(packets.some((packet) => JSON.stringify(packet).includes('"truncated":true')), false);
});

test("one oversized transcript message uses byte-safe base64 JSON fragments", () => {
  const message = { role: "assistant", content: "x".repeat(400_000) };
  const packets = planRemoteFullSync("sync-2", [{
    sessionId: "session-1",
    snapshot: { session: {}, transcript: [message] },
  }]);
  const fragments = packets
    .map((packet) => packet.payload as Record<string, unknown>)
    .filter((payload) => payload.phase === "transcript-fragment")
    .sort((a, b) => Number(a.fragmentIndex) - Number(b.fragmentIndex));
  const rebuilt = JSON.parse(Buffer.concat(fragments.map((fragment) => Buffer.from(String(fragment.data), "base64"))).toString("utf8"));
  assert.deepEqual(rebuilt, message);
  assert.ok(packets.every((packet) => Buffer.byteLength(JSON.stringify(packet.payload)) <= MAX_REMOTE_SYNC_PAYLOAD_BYTES));
});

test("full sync caps the session manifest and emits an explicit omission notice", () => {
  const sessions = Array.from({ length: MAX_REMOTE_SYNC_SESSIONS + 1 }, (_, index) => ({
    sessionId: `session-${index}`,
    snapshot: { session: { id: `session-${index}`, title: "x".repeat(5_000) }, transcript: [] },
  }));
  const packets = planRemoteFullSync("sync-many", sessions, `session-${MAX_REMOTE_SYNC_SESSIONS}`);
  const begin = packets[0]?.payload as Record<string, unknown>;
  assert.equal((begin.sessions as unknown[]).length, MAX_REMOTE_SYNC_SESSIONS);
  assert.equal(begin.selectedSessionId, "session-0");
  assert.ok(Buffer.byteLength(JSON.stringify(begin)) <= MAX_REMOTE_SYNC_PAYLOAD_BYTES);
  assert.ok(packets.some((packet) => {
    const payload = packet.payload as Record<string, unknown>;
    return payload.phase === "notice" && payload.code === "session-limit" && payload.omittedSessions === 1;
  }));
  assert.equal(packets.some((packet) => packet.sessionId === `session-${MAX_REMOTE_SYNC_SESSIONS}`), false);
});

test("a logical message over two MiB becomes a typed placeholder, never more than 32 fragments", () => {
  const hugeMarker = "secret-marker-should-not-cross-wire-" + "z".repeat(2 * 1024 * 1024);
  const packets = planRemoteFullSync("sync-huge", [{
    sessionId: "session-1",
    snapshot: { session: {}, transcript: [{ role: "assistant", content: hugeMarker }] },
  }]);
  const wire = JSON.stringify(packets);
  assert.equal(wire.includes("secret-marker-should-not-cross-wire"), false);
  assert.match(wire, /transcript-message-too-large/);
  const fragments = packets
    .map((packet) => packet.payload as Record<string, unknown>)
    .filter((payload) => payload.phase === "section-fragment" || payload.phase === "transcript-fragment");
  assert.ok(fragments.every((payload) => Number(payload.fragmentCount) <= MAX_REMOTE_SYNC_FRAGMENTS));
});
