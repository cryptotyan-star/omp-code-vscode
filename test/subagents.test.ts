import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isSubagentFrame,
  reduceSubagentFrame,
  reduceSubagentList,
  subagentSnapshot,
  type SubagentInfo,
} from "../src/subagents.ts";

/**
 * The frames below are verbatim captures from a live `omp --mode rpc-ui` run
 * (omp 17.3.5): a qwen3.8-max session that spawned one subagent, which omp
 * resolved onto claude-haiku-4-5. Two details in them have burned this wiring
 * before and are what most of these tests pin: every field lives under
 * `payload`, and a progress frame carries no `id` of its own — the identifier
 * is inside `payload.progress`.
 */
const PARENT = "call_1e0aaa8d05c1418dbc1ddaa0";

function lifecycle(status: string, over: Record<string, unknown> = {}) {
  return {
    type: "subagent_lifecycle",
    payload: {
      id: "worker",
      agent: "scout",
      parentToolCallId: PARENT,
      detached: true,
      agentSource: "bundled",
      description: "worker",
      status,
      sessionFile: "/Users/x/.omp/agent/sessions/s/worker.jsonl",
      index: 0,
      ...over,
    },
  };
}

function progress(over: Record<string, unknown> = {}, progressOver: Record<string, unknown> = {}) {
  return {
    type: "subagent_progress",
    payload: {
      index: 0,
      agent: "scout",
      agentSource: "bundled",
      task: "Count the .ts files under src/",
      parentToolCallId: PARENT,
      detached: true,
      sessionFile: "/Users/x/.omp/agent/sessions/s/worker.jsonl",
      progress: {
        id: "worker",
        index: 0,
        agent: "scout",
        agentSource: "bundled",
        status: "running",
        task: "Count the .ts files under src/",
        currentTool: "glob",
        recentTools: [],
        recentOutput: [],
        toolCount: 2,
        requests: 1,
        tokens: 1234,
        cost: 0.0042,
        durationMs: 900,
        resolvedModel: "anthropic/claude-haiku-4-5",
        ...progressOver,
      },
      ...over,
    },
  };
}

function reduce(frames: unknown[], start = new Map<string, SubagentInfo>()): Map<string, SubagentInfo> {
  let state = start;
  let clock = 1_000;
  for (const frame of frames) {
    const next = reduceSubagentFrame(state, frame, (clock += 10));
    if (next) {
      state = next;
    }
  }
  return state;
}

test("only the three subagent frames are claimed", () => {
  assert.equal(isSubagentFrame(lifecycle("started")), true);
  assert.equal(isSubagentFrame(progress()), true);
  assert.equal(isSubagentFrame({ type: "subagent_event", payload: { id: "worker" } }), true);
  assert.equal(isSubagentFrame({ type: "agent_end" }), false);
  assert.equal(isSubagentFrame(undefined), false);
});

test("a foreign frame leaves the caller's state alone", () => {
  const state = new Map<string, SubagentInfo>();
  assert.equal(reduceSubagentFrame(state, { type: "agent_end" }, 1), null);
  assert.equal(reduceSubagentFrame(state, "not a frame", 1), null);
});

test("lifecycle fields are read from payload, never the top level", () => {
  const state = reduce([lifecycle("started")]);
  const sub = state.get("worker");
  assert.ok(sub, "the subagent must be keyed by payload.id");
  assert.equal(sub.agent, "scout");
  assert.equal(sub.agentSource, "bundled");
  assert.equal(sub.parentToolCallId, PARENT);
  assert.equal(sub.detached, true);
  assert.equal(sub.status, "started");
  assert.match(sub.sessionFile, /worker\.jsonl$/);
});

test("a frame that puts its fields at the top level yields nothing", () => {
  // Guards the exact mistake the first draft of this wiring made.
  const flat = { type: "subagent_lifecycle", id: "worker", agent: "scout", status: "started" };
  const state = reduce([flat]);
  assert.equal(state.size, 0);
});

test("progress is keyed by payload.progress.id", () => {
  const state = reduce([progress()]);
  assert.deepEqual([...state.keys()], ["worker"]);
  const sub = state.get("worker");
  assert.equal(sub?.resolvedModel, "anthropic/claude-haiku-4-5");
  assert.equal(sub?.currentTool, "glob");
  assert.equal(sub?.cost, 0.0042);
  assert.equal(sub?.tokens, 1234);
});

test("progress without any id falls back to parentToolCallId:index", () => {
  const frame = progress({}, {});
  delete (frame.payload as Record<string, unknown> & { progress: Record<string, unknown> }).progress
    .id;
  const state = reduce([frame]);
  assert.deepEqual([...state.keys()], [`${PARENT}:0`]);
});

test("progress and lifecycle for one spawn converge on a single row", () => {
  const state = reduce([lifecycle("started"), progress(), progress()]);
  assert.equal(state.size, 1);
});

test("AgentProgress statuses are normalised into the lifecycle vocabulary", () => {
  // AgentProgress says "running"/"pending"; the lifecycle frame says "started".
  // Surfaces switch exhaustively on the latter, so an unmapped value would be
  // drawn as aborted — a running agent reported as dead.
  for (const raw of ["running", "pending"]) {
    const state = reduce([progress({}, { status: raw })]);
    assert.equal(state.get("worker")?.status, "started", `status ${raw}`);
  }
});

test("a late progress frame cannot resurrect a finished subagent", () => {
  const state = reduce([lifecycle("started"), lifecycle("completed"), progress()]);
  assert.equal(state.get("worker")?.status, "completed");
});

test("terminated subagents stay as history", () => {
  // omp drops them from its own registry the moment they finish, and
  // `get_subagents` only ever answers with running ones.
  const state = reduce([lifecycle("started"), progress(), lifecycle("completed")]);
  assert.equal(state.size, 1);
  assert.equal(state.get("worker")?.cost, 0.0042);
});

test("subagent_event is recognised but changes nothing", () => {
  const before = reduce([lifecycle("started")]);
  const after = reduceSubagentFrame(before, { type: "subagent_event", payload: { id: "worker" } }, 5);
  assert.equal(after, before);
});

test("the input map is never mutated", () => {
  const before = reduce([lifecycle("started")]);
  const snapshotBefore = JSON.stringify([...before.entries()]);
  reduceSubagentFrame(before, progress(), 9_999);
  assert.equal(JSON.stringify([...before.entries()]), snapshotBefore);
});

test("description falls back to the agent name", () => {
  const state = reduce([lifecycle("started", { description: undefined })]);
  assert.equal(state.get("worker")?.description, "scout");
});

test("get_subagents merges into state without erasing history", () => {
  const history = reduce([lifecycle("started", { id: "old" }), lifecycle("completed", { id: "old" })]);
  const merged = reduceSubagentList(
    history,
    {
      data: {
        subagents: [
          {
            id: "fresh",
            index: 1,
            agent: "reviewer",
            agentSource: "project",
            status: "running",
            task: "review the diff",
            parentToolCallId: PARENT,
            sessionFile: "/tmp/fresh.jsonl",
            lastUpdate: 4_242,
            progress: { cost: 0.1, tokens: 99, resolvedModel: "dashscope/glm-5.2" },
          },
        ],
      },
    },
    7_000,
  );
  assert.deepEqual([...merged.keys()].sort(), ["fresh", "old"]);
  const fresh = merged.get("fresh");
  assert.equal(fresh?.status, "started");
  assert.equal(fresh?.resolvedModel, "dashscope/glm-5.2");
  assert.equal(fresh?.updatedAt, 4_242);
  assert.equal(merged.get("old")?.status, "completed");
});

test("a malformed get_subagents answer is a no-op", () => {
  const state = reduce([lifecycle("started")]);
  assert.equal(reduceSubagentList(state, { data: {} }, 1), state);
  assert.equal(reduceSubagentList(state, undefined, 1), state);
});

test("the snapshot puts running agents first and counts them", () => {
  let state = reduce([lifecycle("started", { id: "first" })]);
  state = reduce([lifecycle("completed", { id: "first" })], state);
  state = reduce([lifecycle("started", { id: "second" })], state);
  const snap = subagentSnapshot(state);
  assert.deepEqual(
    snap.subagents.map((s) => s.id),
    ["second", "first"],
  );
  assert.equal(snap.running, 1);
});

test("rows of the same group keep a stable oldest-first order", () => {
  let state = reduce([lifecycle("started", { id: "a" })]);
  state = reduce([lifecycle("started", { id: "b" })], state);
  state = reduce([progress({}, { id: "b", cost: 9 })], state);
  assert.deepEqual(
    subagentSnapshot(state).subagents.map((s) => s.id),
    ["a", "b"],
  );
});
