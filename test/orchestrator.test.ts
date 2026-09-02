import { test } from "node:test";
import assert from "node:assert/strict";
import { Orchestrator, type OrchestratorDeps, type WorkspaceStatus } from "../src/orchestrator.ts";
import type { WorkspaceManager } from "../src/workspaces/manager.ts";
import type { WorkspaceRecord } from "../src/workspaces/types.ts";
import type { OmpSession } from "../src/ompSession";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { WorkspaceStatusLike } from "../src/boardTypes.ts";
import { git } from "../src/workspaces/git.ts";

/**
 * The rules the orchestrator exists to enforce, against fakes: a wait that
 * ends on an event rather than a clock and reports its deadline as a normal
 * outcome, the four board statuses mapped onto the five this layer publishes,
 * and a create that refuses past the configured ceiling.
 *
 * No git and no extension host anywhere in here. Every call under test is one
 * that decides something; the ones that only forward to `merge.ts`/`diff.ts`
 * are covered by those modules' own tests against real repositories.
 */

type BoardStatus = "starting" | "asks" | "working" | "idle";

/** Just enough `OmpSession` for the orchestrator to read a status off. */
function fakeSession(
  status: BoardStatus,
  opts?: { cost?: number; lastText?: string; pending?: boolean },
): {
  session: OmpSession;
  setStatus(next: BoardStatus): void;
  setPending(next: boolean): void;
  setCost(next: number): void;
  prompts: { message: string; mode: string }[];
} {
  let current = status;
  let pending = opts?.pending ?? false;
  let cost = opts?.cost ?? 0;
  const prompts: { message: string; mode: string }[] = [];
  const session = {
    snapshot: () => ({
      id: "s",
      title: "",
      cwd: "/repo",
      model: "qwen3.8-max",
      provider: "dashscope",
      status: current,
      // A real session reports this for the whole life of a turn, including
      // the gap before its first frame arrives — see SessionInfo.pending.
      pending: pending || current === "working",
      cost,
      subagents: [],
      closable: true,
    }),
    sendPrompt: async (message: string, mode = "prompt") => {
      prompts.push({ message, mode });
    },
    lastAssistantText: async () => opts?.lastText,
    // Private fields make `OmpSession` structurally unimplementable; the cast
    // is the point of the fake, not a shortcut around a type error.
  } as unknown as OmpSession;
  return {
    session,
    setStatus(next: BoardStatus) {
      current = next;
    },
    setPending(next: boolean) {
      pending = next;
    },
    setCost(next: number) {
      cost = next;
    },
    prompts,
  };
}

function record(id: string, over?: Partial<WorkspaceRecord>): WorkspaceRecord {
  return {
    id,
    name: id,
    repoRoot: "/repo",
    // Deliberately not a real path: every git read in the orchestrator is
    // best-effort, so a failing one must degrade to zeroes, never throw.
    worktreePath: `/repo.worktrees/${id}`,
    branch: `omp/${id}`,
    baseRef: "main",
    baseSha: "0".repeat(40),
    createdAt: 0,
    setupState: "done",
    ...over,
  };
}

interface Harness {
  orchestrator: Orchestrator;
  records: WorkspaceRecord[];
  sessions: Map<string, OmpSession>;
  /** Stands in for `OmpSession.onBoardChange`. */
  fireBoard(): void;
  fireRegistry(): void;
  created: { repoRoot: string; opts: Record<string, unknown> }[];
  removed: { id: string; opts: unknown }[];
  reopened: string[];
  /** What `manager.reopen` does; by default nothing, as a failed reopen would. */
  onReopen(hook: (id: string) => void): void;
  log: string[];
}

function harness(over?: Partial<OrchestratorDeps> & { max?: number }): Harness {
  const records: WorkspaceRecord[] = [];
  const sessions = new Map<string, OmpSession>();
  const boardListeners = new Set<() => void>();
  const registryListeners = new Set<() => void>();
  const created: { repoRoot: string; opts: Record<string, unknown> }[] = [];
  const removed: { id: string; opts: unknown }[] = [];
  const reopened: string[] = [];
  const log: string[] = [];
  let reopenHook: ((id: string) => void) | undefined;

  const manager = {
    list: () => [...records],
    get: (id: string) => records.find((r) => r.id === id),
    onDidChange: (listener: () => void) => {
      registryListeners.add(listener);
      return { dispose: () => registryListeners.delete(listener) };
    },
    create: async (repoRoot: string, opts: Record<string, unknown>) => {
      created.push({ repoRoot, opts });
      const next = record(String(opts["name"]), { model: opts["model"] as string | undefined });
      records.push(next);
      return next;
    },
    remove: async (id: string, opts: unknown) => {
      removed.push({ id, opts });
      const at = records.findIndex((r) => r.id === id);
      if (at >= 0) records.splice(at, 1);
    },
    reopen: async (id: string) => {
      reopened.push(id);
      reopenHook?.(id);
    },
  } as unknown as WorkspaceManager;

  const deps: OrchestratorDeps = {
    manager,
    sessionFor: (id) => sessions.get(id),
    repoRoot: async () => "/repo",
    output: { appendLine: (s) => log.push(s) },
    onBoardChange: (listener) => {
      boardListeners.add(listener);
      return { dispose: () => boardListeners.delete(listener) };
    },
    maxWorkspaces: () => over?.max ?? 5,
    ...over,
  };

  return {
    orchestrator: new Orchestrator(deps),
    records,
    sessions,
    fireBoard: () => {
      for (const listener of [...boardListeners]) listener();
    },
    fireRegistry: () => {
      for (const listener of [...registryListeners]) listener();
    },
    created,
    removed,
    reopened,
    onReopen: (hook) => {
      reopenHook = hook;
    },
    log,
  };
}

function byId(statuses: WorkspaceStatus[], id: string): WorkspaceStatus {
  const found = statuses.find((s) => s.id === id);
  assert.ok(found, `no status for ${id}`);
  return found;
}

// --------------------------------------------------------------- state mapping

test("the board's four statuses map onto the five the orchestrator publishes", async () => {
  const h = harness();
  const cases: [BoardStatus, string][] = [
    ["starting", "starting"],
    ["working", "working"],
    ["asks", "needs_input"],
    ["idle", "idle"],
  ];
  for (const [board, expected] of cases) {
    const id = `w-${board}`;
    h.records.push(record(id));
    h.sessions.set(id, fakeSession(board).session);
    const statuses = await h.orchestrator.list();
    assert.equal(byId(statuses, id).state, expected, `${board} → ${expected}`);
  }
});

test("a session with a turn queued but not yet streaming reads as working", async () => {
  // The board turns "working" only on the agent's first frame, a round trip
  // (and for a fresh workspace, a whole handshake) after the prompt was sent.
  // Read as idle, that gap tells the orchestrator the worker already finished.
  const h = harness();
  h.records.push(record("a"));
  h.sessions.set("a", fakeSession("idle", { pending: true }).session);
  const [status] = await h.orchestrator.list();
  assert.equal(status?.state, "working");
});

test("wait does not settle on a workspace whose turn is only queued", async () => {
  const h = harness();
  h.records.push(record("a"));
  const fake = fakeSession("idle", { pending: true });
  h.sessions.set("a", fake.session);

  assert.equal(
    (await h.orchestrator.wait({ ids: ["a"], until: "idle", timeoutMs: 40 })).timedOut,
    true,
    "a queued turn is not a finished one",
  );

  const pending = h.orchestrator.wait({ ids: ["a"], until: "idle", timeoutMs: 60_000 });
  fake.setPending(false);
  h.fireBoard();
  assert.equal((await pending).timedOut, false, "and it settles once the turn is really over");
});

test("statuses carry the worktree path, the one way to name the checkout", async () => {
  const h = harness();
  h.records.push(record("a"));
  const [status] = await h.orchestrator.list();
  assert.equal(status?.worktreePath, "/repo.worktrees/a");
});

test("a workspace with no live agent reads as no_session, not as idle", async () => {
  const h = harness();
  h.records.push(record("orphan"));
  const [status] = await h.orchestrator.list();
  assert.equal(status?.state, "no_session");
  assert.equal(status?.cost, 0);
});

test("list carries the pinned model, the branch and the setup state", async () => {
  const h = harness();
  h.records.push(record("a", { model: "dashscope/qwen3.8-max", setupState: "failed" }));
  h.sessions.set("a", fakeSession("idle", { cost: 1.25 }).session);
  const [status] = await h.orchestrator.list();
  assert.equal(status?.model, "dashscope/qwen3.8-max");
  assert.equal(status?.branch, "omp/a");
  assert.equal(status?.setupState, "failed");
  assert.equal(status?.cost, 1.25);
});

test("a workspace with no pin falls back to its live session's model", async () => {
  const h = harness();
  h.records.push(record("a"));
  h.sessions.set("a", fakeSession("idle").session);
  const [status] = await h.orchestrator.list();
  assert.equal(status?.model, "dashscope/qwen3.8-max");
});

test("diff totals stay at zero unless they were asked for", async () => {
  const h = harness();
  h.records.push(record("a"));
  const [plain] = await h.orchestrator.list();
  assert.deepEqual([plain?.added, plain?.deleted, plain?.files], [0, 0, 0]);
  // The worktree does not exist, so measuring fails — and must degrade to
  // zeroes rather than take the whole listing down.
  const [measured] = await h.orchestrator.list({ withDiff: true });
  assert.deepEqual([measured?.added, measured?.deleted, measured?.files], [0, 0, 0]);
});

// ----------------------------------------------------------------------- wait

test("wait reports its deadline as a normal result, not as an exception", async () => {
  const h = harness();
  h.records.push(record("busy"));
  h.sessions.set("busy", fakeSession("working").session);

  const result = await h.orchestrator.wait({ ids: ["busy"], timeoutMs: 20 });
  assert.equal(result.timedOut, true);
  assert.equal(byId(result.statuses, "busy").state, "working");
});

test("wait wakes on a board event rather than on a clock", async () => {
  const h = harness();
  h.records.push(record("w"));
  const fake = fakeSession("working", { lastText: "done with the parser" });
  h.sessions.set("w", fake.session);

  // A generous deadline: if this test passes quickly it can only be because
  // the event woke the wait, and if the wait polled it would still be running.
  const pending = h.orchestrator.wait({ ids: ["w"], timeoutMs: 60_000 });
  fake.setStatus("idle");
  h.fireBoard();

  const result = await pending;
  assert.equal(result.timedOut, false);
  assert.equal(byId(result.statuses, "w").state, "idle");
  assert.equal(byId(result.statuses, "w").lastText, "done with the parser");
});

test("until:'needs_input' returns as soon as one agent stops to ask", async () => {
  const h = harness();
  h.records.push(record("a"), record("b"));
  const a = fakeSession("working");
  const b = fakeSession("working");
  h.sessions.set("a", a.session);
  h.sessions.set("b", b.session);

  const pending = h.orchestrator.wait({ until: "needs_input", timeoutMs: 60_000 });
  b.setStatus("asks");
  h.fireBoard();

  const result = await pending;
  assert.equal(result.timedOut, false);
  assert.equal(byId(result.statuses, "b").state, "needs_input");
  assert.equal(byId(result.statuses, "a").state, "working", "the other one is still running");
});

test("until:'idle' waits for every target, until:'any' for the first one", async () => {
  const h = harness();
  h.records.push(record("a"), record("b"));
  const a = fakeSession("working");
  const b = fakeSession("working");
  h.sessions.set("a", a.session);
  h.sessions.set("b", b.session);

  // "any" is satisfied by the first finisher.
  const anyWait = h.orchestrator.wait({ until: "any", timeoutMs: 60_000 });
  a.setStatus("idle");
  h.fireBoard();
  assert.equal((await anyWait).timedOut, false);

  // "idle" is not, while b is still working.
  const allWait = h.orchestrator.wait({ until: "idle", timeoutMs: 40 });
  assert.equal((await allWait).timedOut, true, "one worker still running means not idle");

  b.setStatus("idle");
  const settled = await h.orchestrator.wait({ until: "idle", timeoutMs: 60_000 });
  assert.equal(settled.timedOut, false);
});

test("an agent blocked on a question counts as settled for until:'idle'", async () => {
  // Otherwise "wait until idle" is a guaranteed timeout: an agent waiting for
  // an answer never reaches idle on its own.
  const h = harness();
  h.records.push(record("a"));
  h.sessions.set("a", fakeSession("asks").session);
  const result = await h.orchestrator.wait({ until: "idle", timeoutMs: 60_000 });
  assert.equal(result.timedOut, false);
  assert.equal(byId(result.statuses, "a").state, "needs_input");
});

test("wait wakes on the registry event too, so a deleted target cannot hang it", async () => {
  const h = harness();
  h.records.push(record("a"), record("b"));
  h.sessions.set("a", fakeSession("idle").session);
  h.sessions.set("b", fakeSession("working").session);

  const pending = h.orchestrator.wait({ until: "idle", timeoutMs: 60_000 });
  h.records.splice(1, 1);
  h.fireRegistry();

  assert.equal((await pending).timedOut, false);
});

test("waiting on nothing returns at once instead of timing out", async () => {
  const h = harness();
  const result = await h.orchestrator.wait({ timeoutMs: 60_000 });
  assert.deepEqual(result, { statuses: [], timedOut: false, unknownIds: [] });
});

test("wait drops an id no workspace has instead of failing the whole call", async () => {
  // `wait` is the one tool that must never come back as an error: a workspace
  // merged and deleted between two waits, or one typo in an array of five ids,
  // would otherwise read as "the run is broken" rather than "keep going".
  const h = harness();
  h.records.push(record("a"));
  h.sessions.set("a", fakeSession("idle").session);

  const result = await h.orchestrator.wait({ ids: ["a", "nope"], timeoutMs: 60_000 });
  assert.equal(result.timedOut, false);
  assert.deepEqual(result.unknownIds, ["nope"], "the dropped id is reported, not swallowed");
  assert.equal(result.statuses.length, 1);
  assert.equal(byId(result.statuses, "a").state, "idle");
});

test("an aborted wait resolves as timed out instead of throwing", async () => {
  const h = harness();
  h.records.push(record("a"));
  h.sessions.set("a", fakeSession("working").session);
  const controller = new AbortController();
  const pending = h.orchestrator.wait({ timeoutMs: 60_000, signal: controller.signal });
  controller.abort();
  assert.equal((await pending).timedOut, true);
});

test("progress is reported at most once per five seconds", async () => {
  const h = harness();
  h.records.push(record("a"));
  h.sessions.set("a", fakeSession("working").session);

  let calls = 0;
  const pending = h.orchestrator.wait({
    timeoutMs: 40,
    onProgress: () => {
      calls += 1;
    },
  });
  for (let i = 0; i < 10; i++) {
    h.fireBoard();
  }
  await pending;
  assert.ok(calls <= 1, `a burst of board events produced ${calls} progress reports`);
});

// --------------------------------------------------------------------- create

test("create refuses past ompcode.orchestratorMaxWorkspaces and names the way out", async () => {
  const h = harness({ max: 2 });
  h.records.push(record("a"), record("b"));
  await assert.rejects(
    () => h.orchestrator.create({ name: "c", prompt: "do the thing" }),
    (err: Error) => {
      assert.match(err.message, /2 of 2/, "the message states the count and the limit");
      assert.match(err.message, /ompcode\.orchestratorMaxWorkspaces/, "and names the setting");
      return true;
    },
  );
  assert.equal(h.created.length, 0, "nothing was created");
});

test("concurrent creates cannot walk past the ceiling between them", async () => {
  // The host tool bridge answers calls in parallel and the instruction file
  // tells the model to fan out, so three creates from one turn read the count
  // before any of them has added a row. Unserialized, all three are allowed.
  const h = harness({ max: 5 });
  h.records.push(record("a"), record("b"), record("c"), record("d"));

  const results = await Promise.allSettled([
    h.orchestrator.create({ name: "e", prompt: "go" }),
    h.orchestrator.create({ name: "f", prompt: "go" }),
    h.orchestrator.create({ name: "g", prompt: "go" }),
  ]);
  assert.equal(h.created.length, 1, "only the one that fits was created");
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(h.records.length, 5, "the ceiling held");
  for (const rejected of results.filter((r) => r.status === "rejected")) {
    assert.match(
      (rejected as PromiseRejectedResult).reason.message,
      /Workspace limit reached/,
      "and the refusals say why",
    );
  }
});

test("a refused create does not wedge the creates queued behind it", async () => {
  const h = harness();
  const refused = h.orchestrator.create({ name: " ", prompt: "go" });
  await assert.rejects(() => refused, /needs a name/);
  await h.orchestrator.create({ name: "b", prompt: "go" });
  assert.equal(h.created.length, 1);
});

test("a workspace nobody is watching is created on yolo, not on the window's tier", async () => {
  // `always-ask` in an unattended worker is a deadlock: the first edit opens a
  // modal only a human can click, and no host tool can answer it.
  const h = harness();
  await h.orchestrator.create({ name: "a", prompt: "go" });
  assert.equal(h.created[0]?.opts["approvalMode"], "yolo");
});

test("the user's workspaceSetup=never outranks a model asking for runSetup", async () => {
  const h = harness({ setupPolicy: () => "never" });
  await h.orchestrator.create({ name: "a", prompt: "go", runSetup: true });
  assert.equal(h.created[0]?.opts["runSetup"], false, "the opt-out is not a model-controlled switch");

  const asked = harness({ setupPolicy: () => "ask" });
  await asked.orchestrator.create({ name: "a", prompt: "go", runSetup: true });
  assert.equal(asked.created[0]?.opts["runSetup"], true, "and 'ask' is left alone");
});

test("the ceiling counts only this repository's workspaces", async () => {
  const h = harness({ max: 2 });
  h.records.push(record("a"), record("elsewhere", { repoRoot: "/other-repo" }));
  await h.orchestrator.create({ name: "c", prompt: "do the thing" });
  assert.equal(h.created.length, 1);
});

test("a nonsense ceiling is clamped rather than obeyed", async () => {
  // A `0` in settings.json would otherwise make every create refuse, with the
  // reason buried in a JSON file the model cannot read.
  const h = harness({ max: 0 });
  await h.orchestrator.create({ name: "a", prompt: "go" });
  assert.equal(h.created.length, 1);
});

test("create demands both a name and an opening prompt", async () => {
  const h = harness();
  await assert.rejects(() => h.orchestrator.create({ name: "  ", prompt: "go" }), /needs a name/);
  await assert.rejects(() => h.orchestrator.create({ name: "a", prompt: " " }), /opening prompt/);
});

test("create forwards the model, base and approval tier and returns a live status", async () => {
  const h = harness();
  const status = await h.orchestrator.create({
    name: "auth-jwt",
    prompt: "implement JWT login",
    model: "dashscope/qwen3.8-max",
    baseRef: "develop",
    approvalMode: "yolo",
    runSetup: true,
  });
  assert.deepEqual(h.created[0]?.opts, {
    name: "auth-jwt",
    prompt: "implement JWT login",
    model: "dashscope/qwen3.8-max",
    baseRef: "develop",
    approvalMode: "yolo",
    runSetup: true,
  });
  assert.equal(status.name, "auth-jwt");
  assert.equal(status.state, "no_session", "no agent has attached yet");
});

// --------------------------------------------------------------------- prompt

test("prompt forwards the mode verbatim so steer stays steer", async () => {
  const h = harness();
  h.records.push(record("a"));
  const fake = fakeSession("working");
  h.sessions.set("a", fake.session);

  await h.orchestrator.prompt({ id: "a", message: "stop and write tests", mode: "steer" });
  assert.deepEqual(fake.prompts, [{ message: "stop and write tests", mode: "steer" }]);
});

test("prompting a workspace whose chat was closed reopens it first", async () => {
  // Over a twelve-hour run a tab gets closed by hand or by a window reload.
  // Losing the ability to talk to a branch the orchestrator created is worse
  // than an unexpected tab reappearing.
  const h = harness();
  h.records.push(record("a"));
  const fake = fakeSession("idle");
  h.onReopen((id) => h.sessions.set(id, fake.session));

  await h.orchestrator.prompt({ id: "a", message: "carry on" });
  assert.deepEqual(h.reopened, ["a"]);
  assert.deepEqual(fake.prompts, [{ message: "carry on", mode: "prompt" }]);
});

test("a reopen that brings no session back is reported, not silently dropped", async () => {
  const h = harness();
  h.records.push(record("a"));
  await assert.rejects(
    () => h.orchestrator.prompt({ id: "a", message: "carry on" }),
    /could not be reopened/,
  );
  assert.deepEqual(h.reopened, ["a"], "it did try before giving up");
});

test("prompting a workspace blocked on an approval dialog is refused, not queued", async () => {
  // Only a person can answer that dialog; a prompt sent now would sit behind a
  // block that never lifts while the model believed it had unblocked the worker.
  const h = harness();
  h.records.push(record("a"));
  const fake = fakeSession("asks");
  h.sessions.set("a", fake.session);
  await assert.rejects(
    () => h.orchestrator.prompt({ id: "a", message: "answer yes" }),
    /approval dialog/,
  );
  assert.deepEqual(fake.prompts, [], "nothing was sent into the void");
});

test("an empty message is refused instead of being sent", async () => {
  const h = harness();
  h.records.push(record("a"));
  h.sessions.set("a", fakeSession("idle").session);
  await assert.rejects(() => h.orchestrator.prompt({ id: "a", message: "   " }), /empty/);
});

test("every id-taking call names the tool that lists valid ids", async () => {
  const h = harness();
  await assert.rejects(
    () => h.orchestrator.prompt({ id: "ghost", message: "hi" }),
    /workspace_list/,
  );
});

// --------------------------------------------------------------------- delete

test("delete with force never asks the manager to open a modal", async () => {
  // An unattended run has nobody to answer a dialog, so the risk gate lives in
  // the orchestrator and the manager is always called forced.
  const h = harness();
  h.records.push(record("a"));
  await h.orchestrator.remove({ id: "a", force: true, deleteBranch: true });
  assert.deepEqual(h.removed, [{ id: "a", opts: { deleteBranch: true, force: true } }]);
});

test("delete without force refuses a workspace whose agent is mid-turn", async () => {
  // An agent still thinking or reading files has written nothing yet, so git
  // reports a clean worktree and nothing ahead: the risk gate below cannot see
  // it. In a "merge the winner, delete the rest" sweep that quietly kills the
  // candidate that merely started slower.
  const h = harness();
  h.records.push(record("a"));
  h.sessions.set("a", fakeSession("working").session);
  await assert.rejects(() => h.orchestrator.remove({ id: "a" }), /still working/);
  assert.equal(h.removed.length, 0);

  await h.orchestrator.remove({ id: "a", force: true });
  assert.equal(h.removed.length, 1, "force still stops it and throws the work away");
});

test("delete without force refuses when the workspace's state cannot be read", async () => {
  // The worktree in these fakes does not exist, so preflight fails — and "we
  // could not tell" must be treated as "there may be work here".
  const h = harness();
  h.records.push(record("a"));
  await assert.rejects(() => h.orchestrator.remove({ id: "a" }), /force=true/);
  assert.equal(h.removed.length, 0);
});

// ------------------------------------------------------- create serialization

test("concurrent creates run one at a time, in arrival order", async () => {
  const h = harness();
  await Promise.all([
    h.orchestrator.create({ name: "a", prompt: "go" }),
    h.orchestrator.create({ name: "b", prompt: "go" }),
    h.orchestrator.create({ name: "c", prompt: "go" }),
  ]);
  assert.deepEqual(
    h.created.map((c) => c.opts["name"]),
    ["a", "b", "c"],
    "each create must see the previous one's row before deciding",
  );
});

test("a double-started name fails at the manager and does not wedge the chain", async () => {
  // Two creates with the same name from one fan-out are two links on the
  // chain: the second reaches a manager that already holds the first's
  // checkout, the way git holds a duplicate branch. That rejection must not
  // stop the creates queued behind it — the chain swallows the failure and
  // keeps moving.
  const seen: string[] = [];
  const records: WorkspaceRecord[] = [];
  const manager = {
    list: () => [...records],
    onDidChange: () => ({ dispose: () => {} }),
    create: async (_repoRoot: string, opts: Record<string, unknown>) => {
      const name = String(opts["name"]);
      seen.push(name);
      if (records.some((r) => r.name === name)) {
        throw new Error(`a branch named omp/${name} already exists`);
      }
      const next = record(name);
      records.push(next);
      return next;
    },
  } as unknown as WorkspaceManager; // the same structural fake the harness itself casts
  const h = harness({ manager });

  const [first, dup] = await Promise.allSettled([
    h.orchestrator.create({ name: "dup", prompt: "go" }),
    h.orchestrator.create({ name: "dup", prompt: "go" }),
  ]);
  assert.equal(first.status, "fulfilled");
  assert.equal(dup.status, "rejected");
  assert.match((dup as PromiseRejectedResult).reason.message, /already exists/);

  const after = await h.orchestrator.create({ name: "next", prompt: "go" });
  assert.equal(after.name, "next", "the chain survived the rejected link");
  assert.deepEqual(seen, ["dup", "dup", "next"]);
});

// ------------------------------------------------------------- pipeline stages

test("a workspace the facade created reports stage and start time", async () => {
  const h = harness();
  const before = Date.now();
  const status = await h.orchestrator.create({ name: "a", prompt: "go" });
  assert.equal(status.stage, "created", "the first step of the pipeline");
  assert.ok(typeof status.startedAt === "number" && status.startedAt >= before);
  const [listed] = await h.orchestrator.list();
  assert.equal(listed?.stage, "created");
  assert.equal(listed?.startedAt, status.startedAt, "the start time is stable");
});

test("a record the facade never created has no stage or start time", async () => {
  // Stages live in the facade's memory, not in the registry: a workspace that
  // predates this facade instance has no progress to report.
  const h = harness();
  h.records.push(record("old"));
  const [status] = await h.orchestrator.list();
  assert.equal(status?.stage, undefined);
  assert.equal(status?.startedAt, undefined);
});

test("the first working observation advances created to working", async () => {
  const h = harness();
  await h.orchestrator.create({ name: "a", prompt: "go" });
  h.sessions.set("a", fakeSession("working").session);
  const [status] = await h.orchestrator.list();
  assert.equal(status?.stage, "working");
});

test("stages never move backwards on a later refresh", async () => {
  const h = harness();
  await h.orchestrator.create({ name: "a", prompt: "go" });
  const session = fakeSession("working");
  h.sessions.set("a", session.session);
  await h.orchestrator.list();
  session.setStatus("idle");
  const [status] = await h.orchestrator.list();
  assert.equal(status?.stage, "working", "an idle session does not demote the stage");
});

test("diff, verify and merge advance diffed, verified and merged", async () => {
  const h = harness();
  h.records.push(record("a"));
  h.sessions.set("a", fakeSession("idle").session);
  const f = await makeStageRepo();
  h.records[0] = record("a", {
    repoRoot: f.repo,
    worktreePath: f.worktree,
    branch: f.branch,
    baseSha: f.baseSha,
  });

  await h.orchestrator.diff({ id: "a" });
  let [status] = await h.orchestrator.list();
  assert.equal(status?.stage, "diffed");

  await h.orchestrator.verify({ id: "a", command: "npm run ok" });
  [status] = await h.orchestrator.list();
  assert.equal(status?.stage, "verified");

  const result = await h.orchestrator.merge({ id: "a", force: true });
  assert.equal(result.merged, true, result.message);
  [status] = await h.orchestrator.list();
  assert.equal(status?.stage, "merged");
});

test("a failed verify leaves the stage where it was", async () => {
  const h = harness();
  h.records.push(record("a"));
  h.sessions.set("a", fakeSession("idle").session);
  const result = await h.orchestrator.verify({ id: "a", command: "npm run nope" });
  assert.equal(result.ok, false);
  const [status] = await h.orchestrator.list();
  assert.equal(status?.stage, undefined, "no step of the pipeline was completed");
});

test("a refused merge leaves the stage where it was", async () => {
  const h = harness();
  h.records.push(record("a"));
  h.sessions.set("a", fakeSession("idle").session);
  const f = await makeStageRepo({ dirty: false });
  h.records[0] = record("a", {
    repoRoot: f.repo,
    worktreePath: f.worktree,
    branch: f.branch,
    baseSha: f.baseSha,
  });

  await h.orchestrator.diff({ id: "a" });
  // Nothing to merge — the branch has no commits of its own and the worktree
  // is clean. The refusal must not advance (or demote) the pipeline stage.
  const result = await h.orchestrator.merge({ id: "a" });
  assert.equal(result.merged, false, result.message);
  const [status] = await h.orchestrator.list();
  assert.equal(status?.stage, "diffed");
});

test("a deleted workspace takes its stage, start time and abort record with it", async () => {
  const h = harness();
  h.records.push(record("a"));
  h.sessions.set("a", fakeSession("idle").session);
  const aborted: string[] = [];
  const limited = harness({
    costLimits: () => ({ perWorkspaceUsd: 1, perSessionUsd: 0 }),
    abortTurn: (id) => aborted.push(id),
  });
  limited.records.push(record("b"));
  const spent = fakeSession("idle", { cost: 2 });
  limited.sessions.set("b", spent.session);
  await limited.orchestrator.list();
  assert.equal(aborted.length, 1);

  await limited.orchestrator.remove({ id: "b", force: true });
  limited.records.push(record("b"));
  limited.sessions.set("b", spent.session);
  await limited.orchestrator.list();
  assert.equal(aborted.length, 2, "a recycled id starts its budget afresh");
});

test("orchestrator statuses satisfy the board's structural contract", () => {
  // Compile-time guard: WorkspaceStatus must stay assignable to the board's
  // WorkspaceStatusLike. The rows below are exactly what list() returns.
  const rows: WorkspaceStatus[] = [
    {
      id: "ws-1",
      name: "a",
      branch: "omp/a",
      worktreePath: "/repo.worktrees/a",
      model: "dashscope/qwen3.8-max",
      state: "working",
      cost: 1,
      added: 0,
      deleted: 0,
      files: 0,
      setupState: "done",
      stage: "working",
      startedAt: 1,
      costLimitUsd: 2,
      overBudget: true,
      lastError: "over",
    },
    {
      id: "ws-2",
      name: "b",
      branch: "omp/b",
      worktreePath: "/repo.worktrees/b",
      model: "",
      state: "idle",
      cost: 0,
      added: 0,
      deleted: 0,
      files: 0,
      setupState: "done",
    },
  ];
  const like: WorkspaceStatusLike[] = rows;
  assert.equal(like.length, 2);
});

// ---------------------------------------------------------------- budgets
//
// The two settings arrive through `deps.costLimits`; every test below names
// them through that callback. No callback, or a limit of 0, means the limit
// is off and everything must behave exactly as before.

test("an over-budget workspace is flagged and refused at prompt", async () => {
  const aborted: string[] = [];
  const h = harness({
    costLimits: () => ({ perWorkspaceUsd: 2, perSessionUsd: 0 }),
    abortTurn: (id) => aborted.push(id),
  });
  h.records.push(record("a", { name: "auth-jwt" }));
  h.sessions.set("a", fakeSession("idle", { cost: 2.5 }).session);

  const [status] = await h.orchestrator.list();
  assert.equal(status?.overBudget, true);
  assert.equal(status?.costLimitUsd, 2);
  assert.equal(status?.lastError, undefined, "a spent budget is not an error");
  assert.deepEqual(aborted, ["a"], "the turn is stopped once, at the first refresh");

  await h.orchestrator.list();
  assert.equal(aborted.length, 1, "the abort never repeats");

  await assert.rejects(
    () => h.orchestrator.prompt({ id: "a", message: "carry on" }),
    (err: Error) => {
      assert.match(err.message, /workspace auth-jwt spent \$2\.50 of its \$2\.00 limit/);
      assert.match(err.message, /ompcode\.costLimitPerWorkspaceUsd or delete the workspace/);
      return true;
    },
  );
  assert.equal(aborted.length, 1, "a refused prompt does not abort again");
});

test("the first over-budget prompt stops the turn too, exactly once", async () => {
  // Enforcement runs on every status refresh — the prompt path included — so
  // an agent that crosses its limit between two lists is stopped there.
  const aborted: string[] = [];
  const h = harness({
    costLimits: () => ({ perWorkspaceUsd: 1, perSessionUsd: 0 }),
    abortTurn: (id) => aborted.push(id),
  });
  h.records.push(record("a", { name: "a" }));
  const fake = fakeSession("idle", { cost: 1.5 });
  h.sessions.set("a", fake.session);
  await assert.rejects(
    () => h.orchestrator.prompt({ id: "a", message: "go on" }),
    /spent \$1\.50 of its \$1\.00 limit/,
  );
  assert.deepEqual(aborted, ["a"]);
  assert.deepEqual(fake.prompts, [], "nothing was delivered to a spent workspace");
  await assert.rejects(() => h.orchestrator.prompt({ id: "a", message: "again" }), /limit/);
  assert.equal(aborted.length, 1);
});

test("a workspace under its limit is prompted as before", async () => {
  const aborted: string[] = [];
  const h = harness({
    costLimits: () => ({ perWorkspaceUsd: 5, perSessionUsd: 0 }),
    abortTurn: (id) => aborted.push(id),
  });
  h.records.push(record("a"));
  const fake = fakeSession("idle", { cost: 4 });
  h.sessions.set("a", fake.session);
  const status = await h.orchestrator.prompt({ id: "a", message: "carry on" });
  assert.equal(status.overBudget, undefined);
  assert.deepEqual(aborted, []);
  assert.equal(fake.prompts.length, 1);
});

test("an over-session-budget create refuses with the numbers and the setting", async () => {
  const h = harness({
    costLimits: () => ({ perWorkspaceUsd: 0, perSessionUsd: 10 }),
    sessionCostUsd: () => 6,
  });
  h.records.push(record("a"));
  h.sessions.set("a", fakeSession("idle", { cost: 4 }).session);

  await assert.rejects(
    () => h.orchestrator.create({ name: "b", prompt: "do the thing" }),
    (err: Error) => {
      assert.match(err.message, /\$10\.00 of its \$10\.00 cost limit/, "total and limit are in the message");
      assert.match(err.message, /ompcode\.costLimitPerSessionUsd/);
      return true;
    },
  );
  assert.equal(h.created.length, 0);
});

test("an over-session-budget prompt refuses, and a wait returns over_budget", async () => {
  const h = harness({
    costLimits: () => ({ perWorkspaceUsd: 0, perSessionUsd: 10 }),
    sessionCostUsd: () => 9,
  });
  h.records.push(record("busy"));
  h.sessions.set("busy", fakeSession("working", { cost: 1 }).session);

  await assert.rejects(
    () => h.orchestrator.prompt({ id: "busy", message: "keep going" }),
    /ompcode\.costLimitPerSessionUsd/,
  );

  // A wait past the session budget returns at once — never blocks — and says
  // so; a model that waited on it would hang on agents that keep working.
  const started = Date.now();
  const result = await h.orchestrator.wait({ ids: ["busy"], timeoutMs: 60_000 });
  assert.equal(result.reason, "over_budget");
  assert.equal(result.timedOut, false);
  assert.equal(byId(result.statuses, "busy").state, "working", "the live state is still reported");
  assert.ok(Date.now() - started < 5000, "the wait returned immediately");
});

test("the workspace limit refuses before the session limit does", async () => {
  // Both limits broken at once: the refusal must name the workspace and its
  // own limit, because that is the one the orchestrating model can act on.
  const h = harness({
    costLimits: () => ({ perWorkspaceUsd: 1, perSessionUsd: 1 }),
    sessionCostUsd: () => 5,
  });
  h.records.push(record("a", { name: "auth-jwt" }));
  h.sessions.set("a", fakeSession("idle", { cost: 2 }).session);
  await assert.rejects(
    () => h.orchestrator.prompt({ id: "a", message: "go on" }),
    /workspace auth-jwt spent \$2\.00 of its \$1\.00 limit/,
  );
});

test("a workspace with no session costs the session total zero", async () => {
  // No session means no spend: the total must not refuse a create just
  // because a worktree exists.
  const h = harness({
    costLimits: () => ({ perWorkspaceUsd: 0, perSessionUsd: 10 }),
    sessionCostUsd: () => 0,
  });
  h.records.push(record("orphan"));
  await h.orchestrator.create({ name: "b", prompt: "go" });
  assert.equal(h.created.length, 1);
});

test("session totals count every workspace, not just the waited-for ids", async () => {
  // wait(ids) must still see the whole session's spend: a model waiting on
  // one workspace while another burns the budget must not get past the gate.
  const h = harness({
    costLimits: () => ({ perWorkspaceUsd: 0, perSessionUsd: 5 }),
    sessionCostUsd: () => 0,
  });
  h.records.push(record("a"), record("b"));
  h.sessions.set("a", fakeSession("idle", { cost: 3 }).session);
  h.sessions.set("b", fakeSession("working", { cost: 3 }).session);
  const result = await h.orchestrator.wait({ ids: ["a"], timeoutMs: 1000 });
  assert.equal(result.reason, "over_budget", "the other workspace's spend counted");
});

test("limits of zero mean off, and missing callbacks mean no limits", async () => {
  const zeroed = harness({
    costLimits: () => ({ perWorkspaceUsd: 0, perSessionUsd: 0 }),
    sessionCostUsd: () => 100,
  });
  zeroed.records.push(record("a"));
  zeroed.sessions.set("a", fakeSession("idle", { cost: 50 }).session);
  const [status] = await zeroed.orchestrator.list();
  assert.equal(status?.overBudget, undefined);
  await zeroed.orchestrator.create({ name: "b", prompt: "go" });
  assert.equal(zeroed.created.length, 1);

  const bare = harness();
  bare.records.push(record("a"));
  bare.sessions.set("a", fakeSession("idle", { cost: 1000 }).session);
  const [plain] = await bare.orchestrator.list();
  assert.equal(plain?.overBudget, undefined);
  await bare.orchestrator.prompt({ id: "a", message: "carry on" });
});

test("a nonsense limit is clamped to off rather than obeyed", async () => {
  // NaN in settings.json would otherwise refuse everything; the orchestrator
  // treats an unreadable limit as no limit.
  const h = harness({ costLimits: () => ({ perWorkspaceUsd: Number.NaN, perSessionUsd: -1 }) });
  h.records.push(record("a"));
  h.sessions.set("a", fakeSession("idle", { cost: 1000 }).session);
  const [status] = await h.orchestrator.list();
  assert.equal(status?.overBudget, undefined);
  await h.orchestrator.create({ name: "b", prompt: "go" });
  assert.equal(h.created.length, 1);
});

// A real git fixture for the diff stage: the orchestrator only advances the
// pipeline on a successful diff, so the stage test needs one that succeeds.
async function makeStageRepo(opts?: { dirty?: boolean }): Promise<{ repo: string; worktree: string; branch: string; baseSha: string }> {
  const tmp = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "ompcode-stage-"));
  const repo = path.join(tmp, "repo");
  await fs.mkdir(repo);
  await git(["-c", "init.defaultBranch=main", "init", "-q", "."], { cwd: repo });
  await git(["config", "user.email", "t@example.com"], { cwd: repo });
  await git(["config", "user.name", "t"], { cwd: repo });
  await git(["config", "commit.gpgsign", "false"], { cwd: repo });
  await fs.writeFile(path.join(repo, "a.txt"), "one\ntwo\n");
  await fs.writeFile(
    path.join(repo, "package.json"),
    JSON.stringify({ scripts: { ok: "echo ok", nope: "exit 3" } }),
  );
  await git(["add", "-A"], { cwd: repo });
  await git(["commit", "-qm", "first"], { cwd: repo });
  const baseSha = (await git(["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  const worktree = path.join(tmp, "wt");
  const branch = "omp/stage-ws";
  await git(["worktree", "add", "-q", "-b", branch, worktree, "main"], { cwd: repo });
  if (opts?.dirty !== false) {
    await fs.writeFile(path.join(worktree, "a.txt"), "one\nchanged\n");
  }
  return { repo, worktree, branch, baseSha };
}
