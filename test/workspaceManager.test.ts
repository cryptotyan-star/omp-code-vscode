import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { git, listWorktrees } from "../src/workspaces/git.ts";
import { mergeWorkspace } from "../src/workspaces/merge.ts";
import { WorkspaceManager, type WorkspaceManagerDeps } from "../src/workspaces/manager.ts";
import { WorkspaceRegistry, type WorkspaceStore } from "../src/workspaces/registry.ts";
import type { WorkspaceRecord } from "../src/workspaces/types.ts";

/**
 * The ordering rules `WorkspaceManager` exists to enforce — close the chat
 * before the worktree is touched, ask before anything is lost, never ask twice
 * for a workspace with nothing in it — against a real repository, with the UI
 * half of the deps recorded rather than rendered.
 */

async function gitAvailable(): Promise<boolean> {
  return await new Promise((resolve) => {
    const child = spawn("git", ["--version"], { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
}

const hasGit = await gitAvailable();
const skip = hasGit ? false : "git is not on PATH";

/** `vscode.Memento` without VS Code. */
class MemoryStore implements WorkspaceStore {
  private readonly data = new Map<string, unknown>();
  /** Set to reject the next write — the storage failure `create` must unwind. */
  failNextUpdate = false;

  get<T>(key: string, def: T): T {
    return this.data.has(key) ? (this.data.get(key) as T) : def;
  }

  update(key: string, value: unknown): Thenable<void> {
    if (this.failNextUpdate) {
      this.failNextUpdate = false;
      return Promise.reject(new Error("storage is full"));
    }
    this.data.set(key, value);
    return Promise.resolve();
  }
}

interface Harness {
  manager: WorkspaceManager;
  calls: string[];
  confirmations: Array<{ message: string; detail: string }>;
  store: MemoryStore;
  answers: { confirm: boolean };
  settings: {
    worktreeBaseDir: string;
    branchPrefix: string;
    setupPolicy: "auto" | "ask" | "never";
    defaultModel: string;
    approvalMode: "always-ask" | "write" | "yolo";
  };
}

function harness(overrides: Partial<WorkspaceManagerDeps> = {}): Harness {
  const calls: string[] = [];
  const confirmations: Array<{ message: string; detail: string }> = [];
  const store = new MemoryStore();
  const answers = { confirm: true };
  const settings: Harness["settings"] = {
    worktreeBaseDir: "",
    branchPrefix: "omp/",
    setupPolicy: "never",
    defaultModel: "prov/model",
    approvalMode: "always-ask",
  };
  const manager = new WorkspaceManager({
    registry: new WorkspaceRegistry(store),
    output: { appendLine: () => undefined },
    settings: () => settings,
    runSetup: async () => {
      calls.push("runSetup");
      return { ok: true, supervised: true };
    },
    openChat: async () => {
      calls.push("openChat");
      return { sessionId: "session-1" };
    },
    closeChat: async () => {
      calls.push("closeChat");
    },
    confirm: async (message, detail) => {
      calls.push("confirm");
      confirmations.push({ message, detail });
      return answers.confirm;
    },
    ...overrides,
  });
  return { manager, calls, confirmations, store, answers, settings };
}

/** A one-commit repository, plus a symlinked spelling of the same directory. */
async function makeRepo(t: { after(fn: () => unknown): void }): Promise<string> {
  const tmp = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "ompcode-mgr-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const repo = path.join(tmp, "repo");
  await fs.mkdir(repo);
  await git(["-c", "init.defaultBranch=main", "init", "-q", "."], { cwd: repo });
  await fs.writeFile(path.join(repo, "a.txt"), "hello\n");
  await git(["add", "a.txt"], { cwd: repo });
  await git(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "first"], {
    cwd: repo,
  });
  return repo;
}

test("create pins the base commit and opens the chat", { skip }, async (t) => {
  const repo = await makeRepo(t);
  const h = harness();
  const record = await h.manager.create(repo, { name: "feat a!", prompt: "go" });

  assert.equal(record.name, "feat-a");
  assert.equal(record.branch, "omp/feat-a");
  assert.equal(record.baseRef, "main");
  assert.match(record.baseSha, /^[0-9a-f]{40}$/);
  assert.equal(record.model, "prov/model");
  assert.equal(record.approvalMode, "always-ask");
  // Policy "never" — nothing ran, and the state says so rather than "done".
  assert.equal(record.setupState, "skipped");
  assert.deepEqual(h.calls, ["openChat"]);

  const live = await listWorktrees(repo);
  assert.ok(live.some((entry) => entry.branch === "omp/feat-a"));
  assert.deepEqual((await h.manager.reconcileWithGit(repo)).orphaned, []);
});

test("a record stores the path git will report, symlinks resolved", { skip }, async (t) => {
  const repo = await makeRepo(t);
  const parent = path.dirname(repo);
  const link = path.join(parent, "link");
  await fs.symlink(parent, link);

  const h = harness();
  // The base directory is reached through a symlink — exactly what `/tmp` is on
  // macOS. git prints the real path, so a record holding the link would be
  // classed as orphaned on the next activation and silently dropped.
  h.settings.worktreeBaseDir = path.join(link, "trees");
  const record = await h.manager.create(repo, { name: "feat-a" });

  assert.equal(record.worktreePath, path.join(parent, "trees", "feat-a"));
  const result = await h.manager.reconcileWithGit(repo);
  assert.deepEqual(result.orphaned, []);
  assert.equal(result.kept.length, 1);
});

test("create unwinds the worktree when the record cannot be stored", { skip }, async (t) => {
  const repo = await makeRepo(t);
  const h = harness();
  h.store.failNextUpdate = true;

  await assert.rejects(h.manager.create(repo, { name: "feat-a" }), /storage is full/);
  // Neither a stray worktree nor a branch that would block the next attempt.
  const live = await listWorktrees(repo);
  assert.equal(live.length, 1);
  assert.equal(live[0]!.isMain, true);
  const { stdout } = await git(["for-each-ref", "--format=%(refname:short)", "refs/heads"], {
    cwd: repo,
  });
  assert.deepEqual(stdout.trim().split("\n"), ["main"]);
});

test("removing a clean workspace closes the chat and asks nothing", { skip }, async (t) => {
  const repo = await makeRepo(t);
  const h = harness();
  const record = await h.manager.create(repo, { name: "feat-a" });
  h.calls.length = 0;

  await h.manager.remove(record.id, { deleteBranch: true });

  assert.deepEqual(h.calls, ["closeChat"]);
  assert.equal(h.manager.get(record.id), undefined);
  assert.equal((await listWorktrees(repo)).length, 1);
  const { stdout } = await git(["for-each-ref", "--format=%(refname:short)", "refs/heads"], {
    cwd: repo,
  });
  assert.deepEqual(stdout.trim().split("\n"), ["main"]);
});

test("uncommitted work is named in the confirmation and forces the removal", { skip }, async (t) => {
  const repo = await makeRepo(t);
  const h = harness();
  const record = await h.manager.create(repo, { name: "feat-a" });
  await fs.writeFile(path.join(record.worktreePath, "scratch.txt"), "work\n");
  await fs.writeFile(path.join(record.worktreePath, ".gitignore"), ".env\n");
  await fs.writeFile(path.join(record.worktreePath, ".env"), "TOKEN=1\n");
  h.calls.length = 0;

  await h.manager.remove(record.id);

  // The chat is closed before anything reads or deletes the worktree.
  assert.deepEqual(h.calls, ["closeChat", "confirm"]);
  const asked = h.confirmations.at(-1)!;
  assert.match(asked.message, /feat-a/);
  assert.match(asked.detail, /untracked: 2/);
  // Ignored files are counted too: `.env` is not replaceable by a setup script.
  assert.match(asked.detail, /\.env/);
  assert.match(asked.detail, /1/);
  assert.equal(h.manager.get(record.id), undefined);
  assert.equal((await listWorktrees(repo)).length, 1);
});

test("answering no keeps the workspace and puts its chat back", { skip }, async (t) => {
  const repo = await makeRepo(t);
  const h = harness();
  const record = await h.manager.create(repo, { name: "feat-a" });
  await fs.writeFile(path.join(record.worktreePath, "scratch.txt"), "work\n");
  h.answers.confirm = false;
  h.calls.length = 0;

  await h.manager.remove(record.id);

  // The chat was killed to release the directory; cancelling must not leave the
  // operator with a stopped agent and no tab.
  assert.deepEqual(h.calls, ["closeChat", "confirm", "openChat"]);
  assert.ok(h.manager.get(record.id));
  assert.equal((await listWorktrees(repo)).length, 2);
});

test("a workspace whose repository is gone can still be deleted", { skip }, async (t) => {
  const repo = await makeRepo(t);
  const h = harness();
  const record = await h.manager.create(repo, { name: "feat-a" });
  await fs.rm(repo, { recursive: true, force: true });
  await fs.rm(record.worktreePath, { recursive: true, force: true });

  await h.manager.remove(record.id);

  assert.equal(h.manager.get(record.id), undefined);
});

test("the setup policy decides what runs", { skip }, async (t) => {
  const repo = await makeRepo(t);
  const h = harness();

  // No config in the repository: "ask" must not open a dialog for nothing.
  h.settings.setupPolicy = "ask";
  const bare = await h.manager.create(repo, { name: "bare" });
  assert.deepEqual(h.calls, ["openChat"]);
  assert.equal(bare.setupState, "skipped");

  await fs.mkdir(path.join(repo, ".ompcode"), { recursive: true });
  await fs.writeFile(
    path.join(repo, ".ompcode", "workspace.json"),
    JSON.stringify({ setup: ["echo hi"] }),
  );
  await git(["add", "-A"], { cwd: repo });
  await git(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "config"], {
    cwd: repo,
  });

  h.settings.setupPolicy = "auto";
  h.calls.length = 0;
  const auto = await h.manager.create(repo, { name: "auto" });
  assert.deepEqual(h.calls, ["runSetup", "openChat"]);
  assert.equal(auto.setupState, "done");

  // An explicit answer outranks the policy.
  h.calls.length = 0;
  const declined = await h.manager.create(repo, { name: "declined", runSetup: false });
  assert.deepEqual(h.calls, ["openChat"]);
  assert.equal(declined.setupState, "skipped");

  // "ask" with something to run asks, and the commands are the modal's detail.
  h.settings.setupPolicy = "ask";
  h.calls.length = 0;
  const asked = await h.manager.create(repo, { name: "asked" });
  assert.deepEqual(h.calls, ["confirm", "runSetup", "openChat"]);
  assert.equal(h.confirmations.at(-1)!.detail, "echo hi");
  assert.equal(asked.setupState, "done");

  // Saying no is a decision, not a failure.
  h.answers.confirm = false;
  h.calls.length = 0;
  const refused = await h.manager.create(repo, { name: "refused" });
  assert.deepEqual(h.calls, ["confirm", "openChat"]);
  assert.equal(refused.setupState, "skipped");
});

test("an unsupervised setup is not recorded as done", { skip }, async (t) => {
  const repo = await makeRepo(t);
  const h = harness({
    runSetup: async () => ({ ok: true, supervised: false }),
  });
  await fs.mkdir(path.join(repo, ".ompcode"), { recursive: true });
  await fs.writeFile(
    path.join(repo, ".ompcode", "workspace.json"),
    JSON.stringify({ setup: ["echo hi"] }),
  );
  // Committed, so the worktree git creates carries it.
  await git(["add", "-A"], { cwd: repo });
  await git(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "config"], {
    cwd: repo,
  });
  h.settings.setupPolicy = "auto";

  const record = await h.manager.create(repo, { name: "feat-a" });
  // Nobody knows how those commands ended, so the record stays retryable.
  assert.equal(record.setupState, "pending");
  assert.deepEqual(await h.manager.runSetup(record.id), { ok: true, supervised: false, ran: true });
});

test("runSetup reports that a workspace has nothing to run", { skip }, async (t) => {
  const repo = await makeRepo(t);
  const h = harness();
  const record = await h.manager.create(repo, { name: "feat-a" });

  const result = await h.manager.runSetup(record.id);
  assert.equal(result.ran, false);
  assert.equal(result.ok, true);
});

test("overlapping writes to the registry cannot lose a record", { skip }, async () => {
  const store = new MemoryStore();
  const registry = new WorkspaceRegistry(store);
  const record = (id: string): WorkspaceRecord => ({
    id,
    name: id,
    repoRoot: "/repo",
    worktreePath: `/repo.worktrees/${id}`,
    branch: `omp/${id}`,
    baseRef: "main",
    baseSha: "0".repeat(40),
    createdAt: 1,
    setupState: "pending",
  });

  // Both start from the same list; a snapshot-based write would keep only one.
  await Promise.all([registry.upsert(record("a")), registry.upsert(record("b"))]);
  assert.deepEqual(
    registry.list().map((entry) => entry.id).sort(),
    ["a", "b"],
  );
});

test("the extension wires the terminal setup runner into the manager", async () => {
  // `manager.ts` cannot import it: the runner needs `vscode`, and the manager is
  // deliberately host-free. Nothing but this check keeps the wiring honest.
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const source = await fs.readFile(path.join(root, "src", "extension.ts"), "utf8");
  assert.match(source, /runSetup: runWorkspaceSetup/);
  assert.match(source, /from "\.\/workspaces\/setupRun"/);
});

// ------------------------------------------------- registry write races ----

/** `MemoryStore` whose updates wait on a gate, to hold the write queue open. */
class GatedStore extends MemoryStore {
  private gate: Promise<void> = Promise.resolve();

  hold(gate: Promise<void>): void {
    this.gate = gate;
  }

  override update(key: string, value: unknown): Thenable<void> {
    return this.gate.then(() => super.update(key, value));
  }
}

/** A record that exists only in the registry — enough for the field writers. */
function unregisteredRecord(over: Partial<WorkspaceRecord> = {}): WorkspaceRecord {
  return {
    id: "ws-1",
    name: "feat-a",
    repoRoot: "/nowhere",
    worktreePath: "/nowhere/feat-a",
    branch: "omp/feat-a",
    baseRef: "main",
    baseSha: "0".repeat(40),
    createdAt: 1,
    setupState: "pending",
    ...over,
  };
}

test("a field write landing after a delete cannot resurrect the record", async () => {
  // The interleaving the manager used to lose: the session layer reads the
  // record (still present — the queue is held open), a delete is queued under
  // it, and the stale snapshot is then written back on top. Deterministic,
  // because every step is queued before the gate opens.
  const store = new GatedStore();
  const registry = new WorkspaceRegistry(store);
  const h = harness({ registry });
  await registry.upsert(unregisteredRecord());

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  store.hold(gate);
  const blocker = registry.upsert(unregisteredRecord({ id: "ws-2", name: "stranger" }));
  const deleting = registry.remove("ws-1");
  // Reads ws-1 as present and queues its write behind the delete.
  const remembering = h.manager.rememberSessionFile("ws-1", "/late/session.jsonl");
  release();
  await Promise.all([blocker, deleting, remembering]);

  assert.equal(h.manager.get("ws-1"), undefined);
  assert.deepEqual(
    registry.list().map((r) => r.id),
    ["ws-2"],
  );
});

test("concurrent field updates on one record compose", async () => {
  const registry = new WorkspaceRegistry(new MemoryStore());
  const h = harness({ registry });
  await registry.upsert(unregisteredRecord());

  await Promise.all([
    h.manager.rememberModel("ws-1", "prov/x"),
    h.manager.rememberApprovalMode("ws-1", "yolo"),
    h.manager.rememberSessionFile("ws-1", "/s.jsonl"),
  ]);

  const after = h.manager.get("ws-1")!;
  assert.equal(after.model, "prov/x");
  assert.equal(after.approvalMode, "yolo");
  assert.equal(after.sessionFile, "/s.jsonl");
});

test("a delete racing field writes on a live workspace always ends deleted", { skip }, async (t) => {
  const repo = await makeRepo(t);
  const h = harness();
  const record = await h.manager.create(repo, { name: "feat-a" });

  await Promise.all([
    h.manager.remove(record.id, { deleteBranch: true }),
    h.manager.rememberModel(record.id, "prov/x"),
    h.manager.rememberApprovalMode(record.id, "yolo"),
  ]);

  assert.equal(h.manager.get(record.id), undefined);
  assert.equal((await listWorktrees(repo)).length, 1);
});

test("concurrent creates in one repository both land", { skip }, async (t) => {
  const repo = await makeRepo(t);
  const h = harness();

  const [a, b] = await Promise.all([
    h.manager.create(repo, { name: "feat-a" }),
    h.manager.create(repo, { name: "feat-b" }),
  ]);

  assert.deepEqual(
    h.manager.list().map((r) => r.name).sort(),
    ["feat-a", "feat-b"],
  );
  // Main + both worktrees, on distinct branches and in distinct directories.
  assert.equal((await listWorktrees(repo)).length, 3);
  assert.notEqual(a.worktreePath, b.worktreePath);
});

test("concurrent deletes of two workspaces in one repository both land", { skip }, async (t) => {
  const repo = await makeRepo(t);
  const h = harness();
  const a = await h.manager.create(repo, { name: "feat-a" });
  const b = await h.manager.create(repo, { name: "feat-b" });

  await Promise.all([
    h.manager.remove(a.id, { deleteBranch: true }),
    h.manager.remove(b.id, { deleteBranch: true }),
  ]);

  assert.deepEqual(h.manager.list(), []);
  assert.equal((await listWorktrees(repo)).length, 1);
});

test("a create in one repository racing a delete in another keeps both honest", { skip }, async (t) => {
  const repoA = await makeRepo(t);
  const repoB = await makeRepo(t);
  const h = harness();
  const doomed = await h.manager.create(repoA, { name: "feat-a" });

  const [, created] = await Promise.all([
    h.manager.remove(doomed.id, { deleteBranch: true }),
    h.manager.create(repoB, { name: "feat-b" }),
  ]);

  assert.equal(h.manager.get(doomed.id), undefined);
  assert.equal(h.manager.get(created.id)!.repoRoot, created.repoRoot);
  assert.equal((await listWorktrees(repoA)).length, 1);
  assert.equal((await listWorktrees(repoB)).length, 2);
});

test("create and merge on one repository are serialized by the repo lock", { skip }, async (t) => {
  const repo = await makeRepo(t);
  const h = harness();
  const record = await h.manager.create(repo, { name: "feat-a" });
  await fs.writeFile(path.join(record.worktreePath, "a.txt"), "merged work\n");
  await git(["add", "a.txt"], { cwd: record.worktreePath });
  await git(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "work"], {
    cwd: record.worktreePath,
  });

  const [, mergeResult] = await Promise.all([
    h.manager.create(repo, { name: "feat-b" }),
    mergeWorkspace({
      repoRoot: repo,
      worktreePath: record.worktreePath,
      branch: record.branch,
      baseRef: record.baseRef,
      baseSha: record.baseSha,
      strategy: "merge",
    }),
  ]);

  assert.equal(mergeResult.merged, true, mergeResult.message);
  assert.equal(h.manager.list().length, 2);
  assert.equal(await fs.readFile(path.join(repo, "a.txt"), "utf8"), "merged work\n");
});
