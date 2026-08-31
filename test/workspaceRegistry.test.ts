import { test } from "node:test";
import assert from "node:assert/strict";
import { WORKSPACES_KEY, WorkspaceRegistry, reconcile } from "../src/workspaces/registry.ts";

/** A `vscode.Memento` stand-in that keeps everything in a plain map. */
function makeStore(initial) {
  const data = new Map(Object.entries(initial ?? {}));
  return {
    data,
    writes: 0,
    get(key, def) {
      return data.has(key) ? data.get(key) : def;
    },
    update(key, value) {
      this.writes += 1;
      data.set(key, value);
      return Promise.resolve();
    },
  };
}

function record(over) {
  return {
    id: "id-1",
    name: "feat-a",
    repoRoot: "/repo",
    worktreePath: "/repo.worktrees/feat-a",
    branch: "omp/feat-a",
    baseRef: "main",
    baseSha: "abc123",
    createdAt: 1_700_000_000_000,
    setupState: "pending",
    ...over,
  };
}

function worktree(over) {
  return {
    path: "/repo.worktrees/feat-a",
    head: "abc123",
    branch: "refs/heads/omp/feat-a",
    detached: false,
    bare: false,
    locked: false,
    prunable: false,
    isMain: false,
    ...over,
  };
}

test("reconcile keeps records git still has a worktree for", () => {
  const a = record({ id: "a", worktreePath: "/wt/a" });
  const b = record({ id: "b", worktreePath: "/wt/b" });
  const result = reconcile(
    [a, b],
    [worktree({ path: "/repo", isMain: true }), worktree({ path: "/wt/a" })],
  );
  assert.deepEqual(
    result.kept.map((r) => r.id),
    ["a"],
  );
  assert.deepEqual(
    result.orphaned.map((r) => r.id),
    ["b"],
  );
});

test("reconcile matches paths by identity, not by string", () => {
  const a = record({ worktreePath: "/wt/a" });
  // Trailing separator and a redundant segment are the same directory.
  const result = reconcile([a], [worktree({ path: "/wt/./a/" })]);
  assert.equal(result.kept.length, 1);
  assert.equal(result.orphaned.length, 0);
});

test("reconcile never matches a record against the main checkout", () => {
  // A stale record pointing at the repo root must still read as orphaned,
  // otherwise it would look alive forever and never be cleaned up.
  const a = record({ worktreePath: "/repo" });
  const result = reconcile([a], [worktree({ path: "/repo", isMain: true, branch: "refs/heads/main" })]);
  assert.deepEqual(result.kept, []);
  assert.equal(result.orphaned.length, 1);
});

test("reconcile ignores a bare entry", () => {
  const a = record({ worktreePath: "/bare" });
  const result = reconcile([a], [worktree({ path: "/bare", bare: true, isMain: false })]);
  assert.equal(result.orphaned.length, 1);
});

test("reconcile on an empty git listing orphans everything", () => {
  const result = reconcile([record()], []);
  assert.equal(result.kept.length, 0);
  assert.equal(result.orphaned.length, 1);
});

test("the registry skips stored garbage instead of throwing", () => {
  const store = makeStore({
    [WORKSPACES_KEY]: [
      record({ id: "good" }),
      null,
      "nope",
      42,
      record({ id: "", name: "empty id" }),
      { ...record({ id: "no-sha" }), baseSha: undefined },
      { ...record({ id: "bad-date" }), createdAt: "yesterday" },
      { ...record({ id: "bad-state" }), setupState: "halfway" },
      { ...record({ id: "bad-approval" }), approvalMode: "whatever" },
      { ...record({ id: "bad-model" }), model: 7 },
    ],
  });
  const registry = new WorkspaceRegistry(store);
  assert.deepEqual(
    registry.list().map((r) => r.id),
    ["good"],
  );
});

test("valid optional fields survive the round trip", () => {
  const full = record({
    id: "full",
    model: "anthropic/claude-opus-4",
    approvalMode: "yolo",
    sessionFile: "/sessions/x.jsonl",
    setupState: "done",
  });
  const store = makeStore({ [WORKSPACES_KEY]: [full] });
  assert.deepEqual(new WorkspaceRegistry(store).list(), [full]);
});

test("a non-array stored value reads as no workspaces", () => {
  assert.deepEqual(new WorkspaceRegistry(makeStore({ [WORKSPACES_KEY]: { a: 1 } })).list(), []);
  assert.deepEqual(new WorkspaceRegistry(makeStore({})).list(), []);
});

test("upsert adds, then replaces by id", async () => {
  const store = makeStore({});
  const registry = new WorkspaceRegistry(store);
  await registry.upsert(record({ id: "a" }));
  await registry.upsert(record({ id: "b" }));
  await registry.upsert(record({ id: "a", setupState: "done" }));
  assert.deepEqual(
    registry.list().map((r) => r.id),
    ["a", "b"],
  );
  assert.equal(registry.get("a").setupState, "done");
  // The store holds the same thing the registry reports.
  assert.equal(store.data.get(WORKSPACES_KEY).length, 2);
});

test("list hands out a copy, so callers cannot edit the registry by accident", async () => {
  const registry = new WorkspaceRegistry(makeStore({}));
  await registry.upsert(record({ id: "a" }));
  registry.list().pop();
  assert.equal(registry.list().length, 1);
});

test("remove drops the record and does not write when there is nothing to drop", async () => {
  const store = makeStore({});
  const registry = new WorkspaceRegistry(store);
  await registry.upsert(record({ id: "a" }));
  const before = store.writes;
  await registry.remove("missing");
  assert.equal(store.writes, before);
  await registry.remove("a");
  assert.deepEqual(registry.list(), []);
  assert.equal(store.writes, before + 1);
});

test("onDidChange fires on every write and stops once disposed", async () => {
  const registry = new WorkspaceRegistry(makeStore({}));
  let fired = 0;
  const sub = registry.onDidChange(() => {
    fired += 1;
  });
  await registry.upsert(record({ id: "a" }));
  await registry.remove("a");
  assert.equal(fired, 2);
  sub.dispose();
  await registry.upsert(record({ id: "b" }));
  assert.equal(fired, 2);
});

test("a failed store write leaves the registry describing what is stored", async () => {
  const store = makeStore({});
  store.update = () => Promise.reject(new Error("memento is full"));
  const registry = new WorkspaceRegistry(store);
  let fired = 0;
  registry.onDidChange(() => {
    fired += 1;
  });
  await assert.rejects(() => registry.upsert(record({ id: "a" })));
  assert.deepEqual(registry.list(), []);
  assert.equal(fired, 0);
});

test("records persist across registry instances over the same store", async () => {
  const store = makeStore({});
  await new WorkspaceRegistry(store).upsert(record({ id: "a" }));
  assert.deepEqual(
    new WorkspaceRegistry(store).list().map((r) => r.id),
    ["a"],
  );
});
