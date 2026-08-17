import { test } from "node:test";
import assert from "node:assert/strict";
import { OmpProcess } from "../src/ompProcess.ts";

// Chunk reassembly lives in private methods handleFrame/handleChunk. We exercise
// it by casting to a type exposing those privates — standard technique for
// unit-testing framing logic without spawning a real process.
type Internals = {
  handleFrame(frame: unknown): void;
  handleChunk(frame: unknown): void;
  chunks: Map<string, unknown>;
  onFrame(cb: (f: unknown) => void): void;
};

function make(): { p: OmpProcess; seen: unknown[] } {
  const p = new OmpProcess();
  const seen: unknown[] = [];
  p.onFrame((f) => seen.push(f));
  return { p, seen };
}

interface ChunkFrame {
  type: string;
  chunkId: string | number;
  index: number;
  count: number;
  data: string;
}

function chunk(chunkId: string | number, index: number, count: number, data: string): ChunkFrame {
  return { type: "rpc_chunk", chunkId, index, count, data };
}

// Slice a JSON frame's UTF-8 string into `count` raw string parts (no base64):
// the spec says "concat data of all parts in index order, then JSON.parse".
function frameToChunks(frame: object, chunkId: string | number, count: number): ChunkFrame[] {
  const str = JSON.stringify(frame);
  const partLen = Math.ceil(str.length / count);
  const out: ChunkFrame[] = [];
  for (let i = 0; i < count; i++) {
    out.push(chunk(chunkId, i, count, str.slice(i * partLen, (i + 1) * partLen)));
  }
  return out;
}

test("handleChunk: reassembles multi-part frame in any order", () => {
  const { p, seen } = make();
  const inner = { type: "notice", level: "info", message: "hello world" };
  const parts = frameToChunks(inner, "c1", 3);
  (p as unknown as Internals).handleChunk(parts[2]);
  (p as unknown as Internals).handleChunk(parts[0]);
  (p as unknown as Internals).handleChunk(parts[1]);
  assert.deepEqual(seen, [inner]);
  assert.equal((p as unknown as Internals).chunks.size, 0, "buffer cleaned after reassembly");
});

test("handleChunk: single-part chunk forwards immediately", () => {
  const { p, seen } = make();
  const inner = { type: "agent_end" };
  const parts = frameToChunks(inner, "single", 1);
  (p as unknown as Internals).handleChunk(parts[0]);
  assert.deepEqual(seen, [inner]);
});

test("handleChunk: numeric chunkId is accepted", () => {
  const { p, seen } = make();
  const inner = { type: "notice", message: "from-numeric" };
  const parts = frameToChunks(inner, 7, 1);
  (p as unknown as Internals).handleChunk(parts[0]);
  assert.deepEqual(seen, [inner]);
});

test("handleChunk: ignores parts with bad metadata", () => {
  const { p, seen } = make();
  const i = p as unknown as Internals;
  // missing chunkId
  i.handleChunk({ type: "rpc_chunk", index: 0, count: 2, data: "" });
  // bad index (negative, non-integer)
  i.handleChunk({ type: "rpc_chunk", chunkId: "x", index: -1, count: 2, data: "" });
  i.handleChunk({ type: "rpc_chunk", chunkId: "x", index: 1.5, count: 2, data: "" });
  // bad count (zero, negative, non-integer)
  i.handleChunk({ type: "rpc_chunk", chunkId: "y", index: 0, count: 0, data: "" });
  i.handleChunk({ type: "rpc_chunk", chunkId: "y", index: 0, count: -1, data: "" });
  i.handleChunk({ type: "rpc_chunk", chunkId: "y", index: 0, count: 2.5, data: "" });
  // non-string data
  // non-string data coerces to "" and may buffer, but must not forward
  i.handleChunk({ type: "rpc_chunk", chunkId: "z", index: 0, count: 1, data: 123 });
  assert.equal(seen.length, 0, "no frame forwarded for malformed parts");
});

test("handleChunk: incomplete set stays buffered, no premature forward", () => {
  const { p, seen } = make();
  const inner = { type: "notice", message: "partial" };
  const parts = frameToChunks(inner, "c2", 3);
  (p as unknown as Internals).handleChunk(parts[0]);
  (p as unknown as Internals).handleChunk(parts[1]);
  assert.equal(seen.length, 0, "not forwarded until complete");
  assert.equal((p as unknown as Internals).chunks.size, 1, "buffer holds partial");
  (p as unknown as Internals).handleChunk(parts[2]);
  assert.deepEqual(seen, [inner]);
  assert.equal((p as unknown as Internals).chunks.size, 0);
});

test("handleChunk: malformed reassembled JSON is dropped, not thrown", () => {
  const { p, seen } = make();
  const bad = "not json at all";
  const half = Math.ceil(bad.length / 2);
  (p as unknown as Internals).handleChunk(chunk("bad", 0, 2, bad.slice(0, half)));
  (p as unknown as Internals).handleChunk(chunk("bad", 1, 2, bad.slice(half)));
  assert.equal(seen.length, 0, "dropped silently");
  assert.equal((p as unknown as Internals).chunks.size, 0, "cleaned even on parse failure");
});

test("handleFrame: forwards non-response, non-chunk frames to handlers", () => {
  const { p, seen } = make();
  const i = p as unknown as Internals;
  i.handleFrame({ type: "agent_start" });
  i.handleFrame({ type: "notice", level: "info", message: "hi" });
  assert.deepEqual(seen, [{ type: "agent_start" }, { type: "notice", level: "info", message: "hi" }]);
});

test("handleFrame: response frames are NOT forwarded", () => {
  const { p, seen } = make();
  (p as unknown as Internals).handleFrame({ type: "response", id: "r99", success: true, data: {} });
  assert.equal(seen.length, 0);
});
