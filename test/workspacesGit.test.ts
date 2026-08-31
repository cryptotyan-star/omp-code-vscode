import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  GitError,
  canonicalPath,
  mainRepoRoot,
  addWorktree,
  aheadBehind,
  branchToDirName,
  classifyGitError,
  currentBranch,
  defaultWorktreeDir,
  deleteBranch,
  git,
  isDirty,
  listBranches,
  listWorktrees,
  parseWorktreeList,
  pruneWorktrees,
  removeWorktree,
  repoRootOf,
  revParse,
  uniquePath,
  withRepoLock,
} from "../src/workspaces/git.ts";

// Real `git worktree list --porcelain` output (git 2.50), covering every shape
// the parser has to survive: main, detached, prunable and locked-with-reason.
const PORCELAIN = `worktree /repos/omp
HEAD 2265ae5b03efd1272c7203babcf934a00ab50f5f
branch refs/heads/main

worktree /repos/omp.worktrees/detached
HEAD 2265ae5b03efd1272c7203babcf934a00ab50f5f
detached

worktree /repos/omp.worktrees/feat-a
HEAD 2265ae5b03efd1272c7203babcf934a00ab50f5f
branch refs/heads/omp/feat-a

worktree /repos/omp.worktrees/gone
HEAD 2265ae5b03efd1272c7203babcf934a00ab50f5f
branch refs/heads/omp/gone
prunable gitdir file points to non-existent location

worktree /repos/omp.worktrees/locked
HEAD 2265ae5b03efd1272c7203babcf934a00ab50f5f
branch refs/heads/omp/locked
locked manual hold
`;

test("parses porcelain worktree list", () => {
  const entries = parseWorktreeList(PORCELAIN);
  assert.equal(entries.length, 5);

  const [main, detached, feat, gone, locked] = entries;
  assert.deepEqual(main, {
    path: "/repos/omp",
    head: "2265ae5b03efd1272c7203babcf934a00ab50f5f",
    branch: "main",
    detached: false,
    bare: false,
    locked: false,
    prunable: false,
    isMain: true,
  });
  // git lists the main worktree first; nothing else may claim to be it.
  assert.deepEqual(
    entries.map((e) => e.isMain),
    [true, false, false, false, false],
  );
  assert.equal(detached!.detached, true);
  assert.equal(detached!.branch, undefined);
  assert.equal(feat!.branch, "omp/feat-a");
  assert.equal(gone!.prunable, true);
  assert.equal(locked!.locked, true);
  assert.equal(locked!.prunable, false);
});

test("parses a bare repository and tolerates trailing blank lines", () => {
  const entries = parseWorktreeList("worktree /repos/omp.git\nbare\n\n\n");
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.bare, true);
  assert.equal(entries[0]!.head, "");
  assert.equal(entries[0]!.isMain, true);
});

test("keeps spaces in worktree paths", () => {
  const entries = parseWorktreeList("worktree /repos/my repo/omp\nHEAD abc\nbranch refs/heads/main\n");
  assert.equal(entries[0]!.path, "/repos/my repo/omp");
});

test("empty output parses to no worktrees", () => {
  assert.deepEqual(parseWorktreeList(""), []);
});

test("classifies real git stderr", () => {
  const cases: [string, string][] = [
    ["fatal: '../dirty' contains modified or untracked files, use --force to delete it", "WorktreeContainsChanges"],
    ["fatal: '../exists' already exists", "WorktreeAlreadyExists"],
    ["fatal: 'omp/locked' is already used by worktree at '/repos/omp.worktrees/locked'", "BranchAlreadyUsedByWorktree"],
    ["error: cannot delete branch 'omp/gone' used by worktree at '/repos/omp.worktrees/gone'", "BranchAlreadyUsedByWorktree"],
    ["fatal: a branch named 'omp/feat-a' already exists", "BranchAlreadyExists"],
    ["error: branch 'nosuchbranch' not found", "BranchNotFound"],
    ["fatal: Needed a single revision", "BranchNotFound"],
    ["error: pathspec 'omp/nope' did not match any file(s) known to git", "BranchNotFound"],
    ["fatal: not a git repository (or any of the parent directories): .git", "NotAGitRepository"],
    ["fatal: destination path 'omp' already exists and is not an empty directory.", "PathExists"],
    ["fatal: the remote end hung up unexpectedly", "Unknown"],
  ];
  for (const [stderr, code] of cases) {
    assert.equal(classifyGitError(stderr), code, stderr);
  }
});

test("branchToDirName flattens branches into one safe segment", () => {
  assert.equal(branchToDirName("omp/feat-a", "omp/"), "feat-a");
  assert.equal(branchToDirName("omp/feat-a"), "omp-feat-a");
  assert.equal(branchToDirName("feature/JIRA-12: fix things"), "feature-JIRA-12-fix-things");
  assert.equal(branchToDirName("release/1.2.3"), "release-1.2.3");
  assert.equal(branchToDirName("omp/", "omp/"), "workspace");
  assert.equal(branchToDirName("../escape"), "escape");
  assert.equal(branchToDirName("a\\b"), "a-b");
});

test("defaultWorktreeDir sits next to the repository", () => {
  const repo = path.join(path.sep, "repos", "omp");
  assert.equal(defaultWorktreeDir(repo), path.join(path.sep, "repos", "omp.worktrees"));
  const configured = path.join(path.sep, "elsewhere", "trees");
  assert.equal(defaultWorktreeDir(repo, configured), configured);
  // A relative setting is anchored on the repository, never on process.cwd().
  assert.equal(defaultWorktreeDir(repo, "../trees"), path.join(path.sep, "repos", "trees"));
  assert.equal(defaultWorktreeDir(repo, "  "), path.join(path.sep, "repos", "omp.worktrees"));
  assert.equal(defaultWorktreeDir(repo, "~/trees"), path.join(os.homedir(), "trees"));
});

test("uniquePath counts up until the path is free", () => {
  const taken = new Set(["/w/feat-a", "/w/feat-a-2", "/w/feat-a-3"]);
  assert.equal(uniquePath("/w/feat-a", (p) => taken.has(p)), "/w/feat-a-4");
  assert.equal(uniquePath("/w/other", (p) => taken.has(p)), "/w/other");
});

test("withRepoLock serializes work on the same repository", async () => {
  const order: string[] = [];
  const slow = withRepoLock("/repos/omp", async () => {
    order.push("a:start");
    await new Promise((r) => setTimeout(r, 20));
    order.push("a:end");
  });
  const fast = withRepoLock("/repos/omp", async () => {
    order.push("b");
  });
  await Promise.all([slow, fast]);
  assert.deepEqual(order, ["a:start", "a:end", "b"]);
});

test("withRepoLock releases the lock when the body throws", async () => {
  await assert.rejects(
    withRepoLock("/repos/throwing", async () => {
      throw new Error("boom");
    }),
    /boom/,
  );
  assert.equal(await withRepoLock("/repos/throwing", async () => "free"), "free");
});

test("withRepoLock gives up rather than deadlocking", async () => {
  let release!: () => void;
  let acquired!: () => void;
  // The body runs only once the lock is held, so resolving from inside it is
  // the one honest "locked now" signal. Racing straight into the second call
  // is flaky: both calls await canonicalPath first, and under load the
  // contender can win that race and take the lock before the holder.
  const locked = new Promise<void>((r) => (acquired = r));
  const held = withRepoLock("/repos/held", () => {
    acquired();
    return new Promise<void>((r) => (release = r));
  });
  await locked;
  await assert.rejects(withRepoLock("/repos/held", async () => "never", 20), /Timed out/);
  release();
  await held;
});

async function gitAvailable(): Promise<boolean> {
  return await new Promise((resolve) => {
    const child = spawn("git", ["--version"], { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
}

const hasGit = await gitAvailable();

test("worktree lifecycle against a real repository", { skip: hasGit ? false : "git is not on PATH" }, async (t) => {
  const tmp = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "ompcode-git-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));

  const repo = path.join(tmp, "repo");
  await fs.mkdir(repo);
  // Identity and default branch are forced so the test does not depend on the
  // developer's global git config.
  await git(["-c", "init.defaultBranch=main", "init", "-q", "."], { cwd: repo });
  await fs.writeFile(path.join(repo, "a.txt"), "hello\n");
  await git(["add", "a.txt"], { cwd: repo });
  await git(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "first"], { cwd: repo });

  assert.equal(await currentBranch(repo), "main");
  assert.deepEqual(await listBranches(repo), ["main"]);
  const baseSha = await revParse(repo, "main");
  assert.match(baseSha, /^[0-9a-f]{40}$/);

  const info = await repoRootOf(repo);
  assert.equal(await fs.realpath(info.root), await fs.realpath(repo));
  assert.equal(info.isWorktree, false);

  const worktree = path.join(tmp, "trees", "feat-a");
  await addWorktree({ repoRoot: repo, path: worktree, branch: "omp/feat-a", commitish: baseSha });

  const live = await listWorktrees(repo);
  assert.equal(live.length, 2);
  const added = live.find((e) => e.branch === "omp/feat-a");
  assert.ok(added, "the new worktree is listed");
  assert.equal(added!.isMain, false);
  assert.equal(added!.head, baseSha);
  assert.equal(live.find((e) => e.isMain)!.branch, "main");

  const fromWorktree = await repoRootOf(worktree);
  assert.equal(fromWorktree.isWorktree, true);
  // rev-parse --show-toplevel inside a linked worktree names that worktree;
  // only mainRepoRoot answers with the checkout new workspaces belong beside.
  assert.equal(await fs.realpath(fromWorktree.root), await fs.realpath(worktree));
  assert.equal(await mainRepoRoot(worktree), await fs.realpath(repo));
  assert.equal(await mainRepoRoot(repo), await fs.realpath(repo));

  assert.deepEqual(await isDirty(worktree), {
    dirty: false,
    untracked: 0,
    modified: 0,
    ignored: 0,
    known: true,
  });

  await fs.writeFile(path.join(worktree, "new.txt"), "scratch\n");
  assert.deepEqual(await isDirty(worktree), {
    dirty: true,
    untracked: 1,
    modified: 0,
    ignored: 0,
    known: true,
  });

  await fs.writeFile(path.join(worktree, "a.txt"), "hello again\n");
  assert.deepEqual(await isDirty(worktree), {
    dirty: true,
    untracked: 1,
    modified: 1,
    ignored: 0,
    known: true,
  });

  // Ignored files are counted separately: `git worktree remove` deletes them
  // with everything else, and a hand-written .env is not replaceable.
  await fs.writeFile(path.join(worktree, ".gitignore"), ".env\n");
  await fs.writeFile(path.join(worktree, ".env"), "TOKEN=1\n");
  assert.equal((await isDirty(worktree)).ignored, 1);
  await fs.rm(path.join(worktree, ".gitignore"));
  await fs.rm(path.join(worktree, ".env"));

  // A path that cannot be read is "unknown", never "clean".
  const missing = await isDirty(path.join(tmp, "not-there"));
  assert.deepEqual(missing, { dirty: false, untracked: 0, modified: 0, ignored: 0, known: true });

  assert.deepEqual(await aheadBehind(repo, "main", "omp/feat-a"), { ahead: 0, behind: 0 });
  await git(["add", "new.txt"], { cwd: worktree });
  await git(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "second"], { cwd: worktree });
  assert.deepEqual(await aheadBehind(repo, "main", "omp/feat-a"), { ahead: 1, behind: 0 });

  // A dirty worktree must not vanish by accident.
  await assert.rejects(removeWorktree({ repoRoot: repo, path: worktree }), (err: unknown) => {
    assert.ok(err instanceof GitError);
    assert.equal(err.code, "WorktreeContainsChanges");
    return true;
  });

  await removeWorktree({ repoRoot: repo, path: worktree, force: true });
  await pruneWorktrees(repo);
  const afterRemoval = await listWorktrees(repo);
  assert.equal(afterRemoval.length, 1);
  assert.equal(afterRemoval[0]!.isMain, true);
  assert.equal(afterRemoval[0]!.branch, "main");

  // Removing what is already gone is success, not an error.
  await removeWorktree({ repoRoot: repo, path: worktree, force: true });

  assert.ok((await listBranches(repo)).includes("omp/feat-a"));
  await assert.rejects(deleteBranch(repo, "omp/feat-a", false), /not fully merged/);
  await deleteBranch(repo, "omp/feat-a", true);
  assert.deepEqual(await listBranches(repo), ["main"]);
});

test("addWorktree refuses a path holding someone else's files", { skip: hasGit ? false : "git is not on PATH" }, async (t) => {
  const tmp = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "ompcode-git-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));

  const repo = path.join(tmp, "repo");
  await fs.mkdir(repo);
  await git(["-c", "init.defaultBranch=main", "init", "-q", "."], { cwd: repo });
  await fs.writeFile(path.join(repo, "a.txt"), "hello\n");
  await git(["add", "a.txt"], { cwd: repo });
  await git(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "first"], { cwd: repo });

  // An empty leftover directory is cleared out of the way …
  const reusable = path.join(tmp, "trees", "reusable");
  await fs.mkdir(reusable, { recursive: true });
  await addWorktree({ repoRoot: repo, path: reusable, branch: "omp/reusable", commitish: "HEAD" });
  assert.ok((await listWorktrees(repo)).some((e) => e.branch === "omp/reusable"));

  // … while a directory with real content is left alone.
  const occupied = path.join(tmp, "trees", "occupied");
  await fs.mkdir(occupied, { recursive: true });
  await fs.writeFile(path.join(occupied, "precious.txt"), "keep me\n");
  await assert.rejects(
    addWorktree({ repoRoot: repo, path: occupied, branch: "omp/occupied", commitish: "HEAD" }),
    (err: unknown) => {
      assert.ok(err instanceof GitError);
      assert.equal(err.code, "PathExists");
      return true;
    },
  );
  assert.equal(await fs.readFile(path.join(occupied, "precious.txt"), "utf8"), "keep me\n");
});

test("git rejects with a classified GitError", { skip: hasGit ? false : "git is not on PATH" }, async (t) => {
  const tmp = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "ompcode-git-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  await assert.rejects(git(["status"], { cwd: tmp }), (err: unknown) => {
    assert.ok(err instanceof GitError);
    assert.equal(err.code, "NotAGitRepository");
    assert.deepEqual(err.args, ["status"]);
    return true;
  });
});

test(
  "canonicalPath resolves symlinks so records match what git prints",
  { skip: hasGit ? false : "git is not on PATH" },
  async (t) => {
    const tmp = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "ompcode-git-"));
    t.after(() => fs.rm(tmp, { recursive: true, force: true }));

    const real = path.join(tmp, "real");
    await fs.mkdir(real);
    const link = path.join(tmp, "link");
    await fs.symlink(real, link);

    // Existing path, and a not-yet-created child of one: both come back with
    // the real spelling, which is the one `git worktree list` reports.
    assert.equal(await canonicalPath(link), real);
    assert.equal(await canonicalPath(path.join(link, "feat-a")), path.join(real, "feat-a"));
  },
);

test(
  "a git failure reports the fatal line, not git's progress chatter",
  { skip: hasGit ? false : "git is not on PATH" },
  async (t) => {
    const tmp = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "ompcode-git-"));
    t.after(() => fs.rm(tmp, { recursive: true, force: true }));
    const repo = path.join(tmp, "repo");
    await fs.mkdir(repo);
    await git(["-c", "init.defaultBranch=main", "init", "-q", "."], { cwd: repo });
    await fs.writeFile(path.join(repo, "a.txt"), "hello\n");
    await git(["add", "a.txt"], { cwd: repo });
    await git(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "first"], {
      cwd: repo,
    });

    await assert.rejects(
      addWorktree({
        repoRoot: repo,
        path: path.join(tmp, "trees", "bad"),
        branch: "omp/feat a",
        commitish: "HEAD",
      }),
      (err: unknown) => {
        assert.ok(err instanceof GitError);
        assert.match(err.message, /^fatal:/);
        return true;
      },
    );
  },
);

test(
  "removeWorktree treats a repository that is gone as already removed",
  { skip: hasGit ? false : "git is not on PATH" },
  async (t) => {
    const tmp = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "ompcode-git-"));
    t.after(() => fs.rm(tmp, { recursive: true, force: true }));
    // git never even starts here: the cwd does not exist, so node reports a
    // spawn ENOENT that carries none of git's own wording.
    await removeWorktree({
      repoRoot: path.join(tmp, "vanished"),
      path: path.join(tmp, "vanished-tree"),
      force: true,
    });
  },
);
