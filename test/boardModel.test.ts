import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBoardSnapshot } from "../src/boardModel.ts";
import type { BoardSnapshot, WorkspaceStatusLike } from "../src/boardTypes.ts";

const NOW = 1_000_000;
const LIMITS = { perWorkspaceUsd: 0, perSessionUsd: 0 };

function ws(over: Partial<WorkspaceStatusLike> = {}): WorkspaceStatusLike {
  return {
    id: "w1",
    name: "worker-1",
    branch: "feat/a",
    model: "kimi-code/k3",
    state: "working",
    cost: 1.5,
    setupState: "ready",
    ...over,
  };
}

function orch(over: Partial<{ id: string; model: string; costUsd: number; state: "starting" | "asks" | "working" | "idle"; startedAt?: number }> = {}) {
  return { id: "orch", model: "anthropic/claude-opus-5", costUsd: 0.5, state: "working" as const, ...over };
}

function row(snapshot: BoardSnapshot, id: string) {
  const row = snapshot.rows.find((r) => r.id === id);
  assert.ok(row, `row ${id} missing`);
  return row;
}

test("lastError maps any state to the error bar", () => {
  const snap = buildBoardSnapshot({ workspaces: [ws({ lastError: "boom" })], limits: LIMITS, now: NOW });
  const r = row(snap, "w1");
  assert.equal(r.bar, "error");
  assert.equal(r.lastError, "boom");
  assert.equal(r.progress, 100);
  assert.equal(r.needsHuman, true);
});

test("overBudget beats every state except error", () => {
  const snap = buildBoardSnapshot({ workspaces: [ws({ overBudget: true })], limits: LIMITS, now: NOW });
  const r = row(snap, "w1");
  assert.equal(r.bar, "budget");
  assert.equal(r.overBudget, true);
  assert.equal(r.progress, 100);
  assert.equal(r.needsHuman, true);
});

test("error beats budget", () => {
  const snap = buildBoardSnapshot({
    workspaces: [ws({ state: "needs_input", overBudget: true, lastError: "crashed" })],
    limits: LIMITS,
    now: NOW,
  });
  assert.equal(row(snap, "w1").bar, "error");
});

test("budget beats waiting", () => {
  const snap = buildBoardSnapshot({
    workspaces: [ws({ state: "needs_input", overBudget: true })],
    limits: LIMITS,
    now: NOW,
  });
  assert.equal(row(snap, "w1").bar, "budget");
});

test("needs_input maps to waiting", () => {
  const snap = buildBoardSnapshot({ workspaces: [ws({ state: "needs_input" })], limits: LIMITS, now: NOW });
  const r = row(snap, "w1");
  assert.equal(r.bar, "waiting");
  assert.equal(r.progress, 100);
  assert.equal(r.needsHuman, true);
});

test("no_session maps to idle", () => {
  const snap = buildBoardSnapshot({ workspaces: [ws({ state: "no_session" })], limits: LIMITS, now: NOW });
  const r = row(snap, "w1");
  assert.equal(r.bar, "idle");
  assert.equal(r.progress, 0);
  assert.equal(r.needsHuman, false);
});

test("starting maps to idle", () => {
  const snap = buildBoardSnapshot({ workspaces: [ws({ state: "starting" })], limits: LIMITS, now: NOW });
  assert.equal(row(snap, "w1").bar, "idle");
});

test("working maps to running; missing stage counts as created (progress 0)", () => {
  const snap = buildBoardSnapshot({ workspaces: [ws({ state: "working" })], limits: LIMITS, now: NOW });
  const r = row(snap, "w1");
  assert.equal(r.bar, "running");
  assert.equal(r.progress, 0);
  assert.equal("stage" in r, false);
  assert.equal(r.needsHuman, false);
});

test("idle with merged stage is done; stage passes through", () => {
  const snap = buildBoardSnapshot({
    workspaces: [ws({ state: "idle", stage: "merged" })],
    limits: LIMITS,
    now: NOW,
  });
  const r = row(snap, "w1");
  assert.equal(r.bar, "done");
  assert.equal(r.stage, "merged");
  assert.equal(r.progress, 100);
  assert.equal(r.needsHuman, false);
});

test("idle without merged stage stays idle", () => {
  const snap = buildBoardSnapshot({
    workspaces: [ws({ state: "idle", stage: "diffed" })],
    limits: LIMITS,
    now: NOW,
  });
  const r = row(snap, "w1");
  assert.equal(r.bar, "idle");
  assert.equal(r.progress, 0);
  assert.equal(r.needsHuman, false);
});

test("running progress follows the 0-based stage index over 5", () => {
  const stages = { created: 0, working: 20, diffed: 40, verified: 60, merged: 80 } as const;
  for (const [stage, expected] of Object.entries(stages)) {
    const snap = buildBoardSnapshot({
      workspaces: [ws({ state: "working", stage: stage as WorkspaceStatusLike["stage"] })],
      limits: LIMITS,
      now: NOW,
    });
    assert.equal(row(snap, "w1").progress, expected, stage);
  }
});

test("done, error, waiting and budget rows all read progress 100", () => {
  const snap = buildBoardSnapshot({
    workspaces: [
      ws({ id: "d", state: "idle", stage: "merged" }),
      ws({ id: "e", lastError: "x" }),
      ws({ id: "w", state: "needs_input" }),
      ws({ id: "b", overBudget: true }),
    ],
    limits: LIMITS,
    now: NOW,
  });
  for (const id of ["d", "e", "w", "b"]) {
    assert.equal(row(snap, id).progress, 100, id);
  }
});

test("orchestrator bar follows its state", () => {
  const cases = { working: "running", asks: "waiting", starting: "idle", idle: "idle" } as const;
  for (const [state, bar] of Object.entries(cases)) {
    const snap = buildBoardSnapshot({
      orchestrator: orch({ state: state as "working" }),
      workspaces: [ws()],
      limits: LIMITS,
      now: NOW,
    });
    assert.equal(snap.rows[0].bar, bar, state);
  }
});

test("orchestrator progress is the merged fraction of workspaces", () => {
  const none = buildBoardSnapshot({ orchestrator: orch(), workspaces: [ws(), ws({ id: "w2" })], limits: LIMITS, now: NOW });
  assert.equal(none.rows[0].progress, 0);

  const some = buildBoardSnapshot({
    orchestrator: orch(),
    workspaces: [ws({ stage: "merged" }), ws({ id: "w2", stage: "merged" }), ws({ id: "w3" }), ws({ id: "w4" })],
    limits: LIMITS,
    now: NOW,
  });
  assert.equal(some.rows[0].progress, 50);

  const third = buildBoardSnapshot({
    orchestrator: orch(),
    workspaces: [ws({ stage: "merged" }), ws({ id: "w2" }), ws({ id: "w3" })],
    limits: LIMITS,
    now: NOW,
  });
  assert.ok(Math.abs(third.rows[0].progress - 100 / 3) < 1e-9);

  const all = buildBoardSnapshot({
    orchestrator: orch(),
    workspaces: [ws({ stage: "merged" }), ws({ id: "w2", stage: "merged" })],
    limits: LIMITS,
    now: NOW,
  });
  assert.equal(all.rows[0].progress, 100);
});

test("no workspaces means orchestrator progress 0", () => {
  const snap = buildBoardSnapshot({ orchestrator: orch(), workspaces: [], limits: LIMITS, now: NOW });
  assert.equal(snap.rows[0].progress, 0);
});

test("orchestrator absent leaves plain workspace rows", () => {
  const snap = buildBoardSnapshot({ workspaces: [ws()], limits: LIMITS, now: NOW });
  assert.equal(snap.rows.length, 1);
  assert.equal(snap.rows[0].kind, "workspace");
  assert.equal("parentId" in snap.rows[0], false);
  assert.equal(snap.totalCostUsd, 1.5);
});

test("orchestrator row comes first and workspaces get parentId", () => {
  const snap = buildBoardSnapshot({ orchestrator: orch(), workspaces: [ws(), ws({ id: "w2" })], limits: LIMITS, now: NOW });
  assert.equal(snap.rows[0].kind, "orchestrator");
  assert.equal(snap.rows[0].id, "orch");
  assert.equal(snap.rows[1].parentId, "orch");
  assert.equal(snap.rows[2].parentId, "orch");
});

test("workspace row fields pass through", () => {
  const snap = buildBoardSnapshot({
    workspaces: [ws({ lastText: "fixing tests", stage: "diffed" })],
    limits: LIMITS,
    now: NOW,
  });
  const r = row(snap, "w1");
  assert.equal(r.kind, "workspace");
  assert.equal(r.name, "worker-1");
  assert.equal(r.model, "kimi-code/k3");
  assert.equal(r.branch, "feat/a");
  assert.equal(r.stage, "diffed");
  assert.equal(r.lastText, "fixing tests");
  assert.equal(r.costUsd, 1.5);
  assert.equal(r.overBudget, false);
});

test("totalCostUsd sums orchestrator and workspace costs", () => {
  const snap = buildBoardSnapshot({
    orchestrator: orch({ costUsd: 0.25 }),
    workspaces: [ws({ cost: 1 }), ws({ id: "w2", cost: 2 })],
    limits: LIMITS,
    now: NOW,
  });
  assert.equal(snap.totalCostUsd, 3.25);
});

test("per-workspace limit: own value wins, then shared limit, then none", () => {
  const own = buildBoardSnapshot({
    workspaces: [ws({ costLimitUsd: 9 })],
    limits: { perWorkspaceUsd: 2, perSessionUsd: 0 },
    now: NOW,
  });
  assert.equal(row(own, "w1").costLimitUsd, 9);

  const shared = buildBoardSnapshot({
    workspaces: [ws()],
    limits: { perWorkspaceUsd: 2, perSessionUsd: 0 },
    now: NOW,
  });
  assert.equal(row(shared, "w1").costLimitUsd, 2);

  const off = buildBoardSnapshot({ workspaces: [ws()], limits: LIMITS, now: NOW });
  assert.equal("costLimitUsd" in row(off, "w1"), false);
});

test("session limit of 0 means no session limit", () => {
  const snap = buildBoardSnapshot({
    workspaces: [ws({ cost: 100 })],
    limits: { perWorkspaceUsd: 0, perSessionUsd: 0 },
    now: NOW,
  });
  assert.equal("sessionLimitUsd" in snap, false);
  assert.equal(snap.overSessionBudget, false);
});

test("session limit on but not exceeded", () => {
  const snap = buildBoardSnapshot({
    orchestrator: orch({ costUsd: 0.5 }),
    workspaces: [ws({ cost: 1 })],
    limits: { perWorkspaceUsd: 0, perSessionUsd: 5 },
    now: NOW,
  });
  assert.equal(snap.sessionLimitUsd, 5);
  assert.equal(snap.overSessionBudget, false);
});

test("session budget trips at equality", () => {
  const snap = buildBoardSnapshot({
    orchestrator: orch({ costUsd: 0.5 }),
    workspaces: [ws({ cost: 4.5 })],
    limits: { perWorkspaceUsd: 0, perSessionUsd: 5 },
    now: NOW,
  });
  assert.equal(snap.totalCostUsd, 5);
  assert.equal(snap.overSessionBudget, true);
});

test("counts include the orchestrator row and skip idle and budget", () => {
  const snap = buildBoardSnapshot({
    orchestrator: orch({ state: "asks" }),
    workspaces: [
      ws({ id: "run" }),
      ws({ id: "done", state: "idle", stage: "merged" }),
      ws({ id: "err", lastError: "x" }),
      ws({ id: "bud", overBudget: true }),
      ws({ id: "zzz", state: "starting" }),
    ],
    limits: LIMITS,
    now: NOW,
  });
  assert.deepEqual(snap.counts, { running: 1, done: 1, error: 1, waiting: 1 });
});

test("elapsedSec counts from startedAt and never goes negative", () => {
  const snap = buildBoardSnapshot({
    orchestrator: orch({ startedAt: NOW - 60_000 }),
    workspaces: [ws({ startedAt: NOW - 90_000 }), ws({ id: "future", startedAt: NOW + 5_000 })],
    limits: LIMITS,
    now: NOW,
  });
  assert.equal(snap.rows[0].elapsedSec, 60);
  assert.equal(row(snap, "w1").elapsedSec, 90);
  assert.equal(row(snap, "future").elapsedSec, 0);

  const unset = buildBoardSnapshot({ workspaces: [ws()], limits: LIMITS, now: NOW });
  assert.equal("elapsedSec" in row(unset, "w1"), false);
});

test("empty input produces an empty board", () => {
  const snap = buildBoardSnapshot({ workspaces: [], limits: LIMITS, now: NOW });
  assert.deepEqual(snap, {
    rows: [],
    totalCostUsd: 0,
    overSessionBudget: false,
    counts: { running: 0, done: 0, error: 0, waiting: 0 },
  });
});
