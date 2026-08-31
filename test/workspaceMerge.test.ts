import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { classifyGitError, git } from "../src/workspaces/git.ts";
import {
  discardWorkspaceFile,
  mergeWorkspace,
  parseLegacyMergeTreeConflicts,
  parseMergeTreeConflicts,
  planMerge,
  preflight,
  type MergePreflight,
} from "../src/workspaces/merge.ts";

/**
 * The module that can destroy a day's work, exercised for real.
 *
 * `planMerge` is pure and is tested on its own — it is the text the user is
 * shown before they say yes, so it has to be right without a repository. The
 * rest runs against actual repositories with actual worktrees, because the only
 * interesting failures here (a conflict, a dirty main checkout, a base that
 * moved) are failures of git's real behaviour, not of our bookkeeping.
 */

async function gitAvailable(): Promise<boolean> {
  return await new Promise((resolve) => {
    const child = spawn("git", ["--version"], { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
}

const skip = (await gitAvailable()) ? false : "git is not on PATH";

// ---------------------------------------------------------------- pure ----

function preflightOf(over: Partial<MergePreflight> = {}): MergePreflight {
  return {
    ok: true,
    conflictingFiles: [],
    ahead: 1,
    behind: 0,
    baseMoved: false,
    baseDirty: false,
    worktreeDirty: false,
    ...over,
  };
}

const joined = (lines: string[]) => lines.join("\n");

test("planMerge describes a clean merge and blocks nothing", () => {
  const plan = planMerge(preflightOf(), "merge");
  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(plan.warnings, []);
  assert.match(joined(plan.steps), /Check out the base branch/);
  assert.match(joined(plan.steps), /--no-ff/);
  // A clean merge touches neither worktree nor stash, and must not claim to.
  assert.doesNotMatch(joined(plan.steps), /Stash|Commit the uncommitted/);
});

test("planMerge describes the squash path as rebase, collapse, fast-forward", () => {
  const plan = planMerge(preflightOf({ ahead: 3 }), "squash");
  const steps = joined(plan.steps);
  assert.match(steps, /Rebase the workspace branch/);
  assert.match(steps, /Collapse the workspace commits/);
  assert.match(steps, /--ff-only/);
  assert.doesNotMatch(steps, /--no-ff/);
  // Squashing rewrites the workspace branch; that has to be said out loud.
  assert.match(joined(plan.warnings), /rewrites the workspace branch: its 3 commits/);
});

test("planMerge blocks on conflicts and names the files", () => {
  const plan = planMerge(
    preflightOf({ ok: false, reason: "conflicts", conflictingFiles: ["src/a.ts", "src/b.ts"] }),
    "merge",
  );
  assert.equal(plan.blockers.length, 1);
  assert.match(plan.blockers[0]!, /2 file\(s\) conflict/);
  assert.match(plan.blockers[0]!, /src\/a\.ts, src\/b\.ts/);
});

test("planMerge blocks on nothing to merge and on a missing branch", () => {
  const nothing = planMerge(preflightOf({ ok: false, reason: "no-commits", ahead: 0 }), "merge");
  assert.match(joined(nothing.blockers), /no commits of its own/);

  const missing = planMerge(preflightOf({ ok: false, reason: "branch-missing", ahead: 0 }), "squash");
  assert.match(joined(missing.blockers), /branch no longer exists/);
});

test("planMerge spells out the two mutations it makes: the worktree commit and the stash", () => {
  const dirtyWorktree = planMerge(preflightOf({ ok: false, reason: "worktree-dirty", worktreeDirty: true }), "merge");
  assert.equal(dirtyWorktree.steps[0], "Commit the uncommitted work in the worktree onto the workspace branch.");
  assert.match(joined(dirtyWorktree.blockers), /committed onto the workspace branch first/);
  assert.match(joined(dirtyWorktree.warnings), /only change made inside the agent's worktree/);

  const dirtyBase = planMerge(preflightOf({ ok: false, reason: "base-dirty", baseDirty: true }), "merge");
  assert.match(joined(dirtyBase.steps), /Stash the uncommitted changes in the main checkout/);
  assert.match(joined(dirtyBase.steps), /Restore the stashed changes/);
  assert.match(joined(dirtyBase.blockers), /stashed and restored/);
});

test("planMerge warns about a moved base and about being behind", () => {
  const moved = planMerge(preflightOf({ ok: false, reason: "base-moved", baseMoved: true, behind: 4 }), "merge");
  assert.match(joined(moved.blockers), /base branch has moved/);
  assert.match(joined(moved.warnings), /4 commit\(s\) behind/);
});

test("planMerge lists every blocking condition, not just the winning reason", () => {
  const plan = planMerge(
    preflightOf({ ok: false, reason: "worktree-dirty", worktreeDirty: true, baseDirty: true, baseMoved: true }),
    "merge",
  );
  assert.equal(plan.blockers.length, 3);
});

test("planMerge blocks nothing when the preflight is ok", () => {
  // Belt and braces: a caller that hands in an inconsistent preflight must not
  // get a dialog full of blockers for a merge that is allowed to proceed.
  const plan = planMerge(preflightOf({ ok: true, baseDirty: true, worktreeDirty: true }), "merge");
  assert.deepEqual(plan.blockers, []);
});

test("parseMergeTreeConflicts reads the names and stops at the message block", () => {
  const out = [
    "f4545ba3c9670524d477c73db6e9d0dd08485142",
    "src/a.ts",
    "src/b.ts",
    "",
    "Auto-merging src/a.ts",
    "CONFLICT (content): Merge conflict in src/a.ts",
    "",
  ].join("\n");
  assert.deepEqual(parseMergeTreeConflicts(out), ["src/a.ts", "src/b.ts"]);
  // A clean run prints the tree OID and nothing else.
  assert.deepEqual(parseMergeTreeConflicts("33d3ed1ceb7148d18959792be73218b95c29b238\n"), []);
  assert.deepEqual(parseMergeTreeConflicts(""), []);
});

test("parseLegacyMergeTreeConflicts finds files with conflict markers", () => {
  const out = [
    "changed in both",
    "  base   100644 aaaaaaa src/a.ts",
    "  our    100644 bbbbbbb src/a.ts",
    "  their  100644 ccccccc src/a.ts",
    "@@ -1,3 +1,3 @@",
    "++<<<<<<< .our",
    "+ours",
    "++=======",
    "+ theirs",
    "++>>>>>>> .their",
    "merged",
    "  result 100644 ddddddd src/clean.ts",
  ].join("\n");
  assert.deepEqual(parseLegacyMergeTreeConflicts(out), ["src/a.ts"]);
});

test("classifyGitError knows the merge family", () => {
  assert.equal(classifyGitError("CONFLICT (content): Merge conflict in f.txt"), "MergeConflict");
  assert.equal(classifyGitError("Automatic merge failed; fix conflicts and then commit the result."), "MergeConflict");
  assert.equal(classifyGitError("error: could not apply d1ca741... feat-change"), "MergeConflict");
  assert.equal(classifyGitError("fatal: Not possible to fast-forward, aborting."), "NoFastForward");
  assert.equal(
    classifyGitError("error: Your local changes to the following files would be overwritten by merge:"),
    "LocalChangesOverwritten",
  );
  // A conflicting `git stash pop` prints both CONFLICT and the stash line; the
  // stash line wins, because it is the one that says work is hidden away.
  assert.equal(
    classifyGitError("CONFLICT (content): Merge conflict in f.txt\nThe stash entry is kept in case you need it again."),
    "StashConflict",
  );
  assert.equal(
    classifyGitError("error: Committing is not possible because you have unmerged files."),
    "UnmergedFiles",
  );
  // The codes that were already there must keep winning where they used to.
  assert.equal(classifyGitError("fatal: not a git repository"), "NotAGitRepository");
  assert.equal(classifyGitError("hello"), "Unknown");
});

// --------------------------------------------------------- integration ----

interface Fixture {
  tmp: string;
  repo: string;
  baseSha: string;
}

async function makeRepo(): Promise<Fixture> {
  const tmp = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "ompcode-merge-"));
  const repo = path.join(tmp, "repo");
  await fs.mkdir(repo);
  await git(["-c", "init.defaultBranch=main", "init", "-q", "."], { cwd: repo });
  // `mergeWorkspace` commits on its own, so the identity has to live in the
  // repository rather than on the command line.
  await git(["config", "user.email", "t@example.com"], { cwd: repo });
  await git(["config", "user.name", "t"], { cwd: repo });
  await git(["config", "commit.gpgsign", "false"], { cwd: repo });
  await fs.writeFile(path.join(repo, "a.txt"), "a1\na2\na3\n");
  await fs.writeFile(path.join(repo, "b.txt"), "b1\nb2\nb3\n");
  await git(["add", "-A"], { cwd: repo });
  await git(["commit", "-qm", "first"], { cwd: repo });
  const baseSha = (await git(["rev-parse", "HEAD"], { cwd: repo })).stdout.trim();
  return { tmp, repo, baseSha };
}

async function addWorkspace(f: Fixture, name: string): Promise<{ path: string; branch: string }> {
  const worktree = path.join(f.tmp, name);
  const branch = `omp/${name}`;
  await git(["worktree", "add", "-q", "-b", branch, worktree, "main"], { cwd: f.repo });
  return { path: worktree, branch };
}

async function write(dir: string, file: string, content: string): Promise<void> {
  await fs.writeFile(path.join(dir, file), content);
}

async function commitAll(dir: string, message: string): Promise<void> {
  await git(["add", "-A"], { cwd: dir });
  await git(["commit", "-qm", message], { cwd: dir });
}

async function read(dir: string, file: string): Promise<string> {
  return await fs.readFile(path.join(dir, file), "utf8");
}

async function head(dir: string): Promise<string> {
  return (await git(["rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
}

test("two workspaces on different files both land on main", { skip }, async (t) => {
  const f = await makeRepo();
  t.after(() => fs.rm(f.tmp, { recursive: true, force: true }));
  const one = await addWorkspace(f, "one");
  const two = await addWorkspace(f, "two");
  await write(one.path, "a.txt", "ONE\na2\na3\n");
  await commitAll(one.path, "one");
  await write(two.path, "b.txt", "TWO\nb2\nb3\n");
  await commitAll(two.path, "two");

  const first = await preflight({
    repoRoot: f.repo,
    worktreePath: one.path,
    branch: one.branch,
    baseRef: "main",
    baseSha: f.baseSha,
  });
  assert.equal(first.ok, true, `expected a clean preflight, got ${first.reason}`);
  assert.equal(first.ahead, 1);
  assert.deepEqual(first.conflictingFiles, []);

  const merged = await mergeWorkspace({
    repoRoot: f.repo,
    worktreePath: one.path,
    branch: one.branch,
    baseRef: "main",
    baseSha: f.baseSha,
    strategy: "merge",
  });
  assert.equal(merged.merged, true, merged.message);
  assert.equal(merged.stashed, false);
  assert.equal(await read(f.repo, "a.txt"), "ONE\na2\na3\n");

  // main has moved now, which is a consent point rather than a failure.
  const second = await preflight({
    repoRoot: f.repo,
    worktreePath: two.path,
    branch: two.branch,
    baseRef: "main",
    baseSha: f.baseSha,
  });
  assert.equal(second.ok, false);
  assert.equal(second.reason, "base-moved");
  assert.equal(second.baseMoved, true);
  assert.deepEqual(second.conflictingFiles, []);

  const mergedTwo = await mergeWorkspace({
    repoRoot: f.repo,
    worktreePath: two.path,
    branch: two.branch,
    baseRef: "main",
    baseSha: f.baseSha,
    strategy: "merge",
    force: true,
  });
  assert.equal(mergedTwo.merged, true, mergedTwo.message);
  assert.equal(await read(f.repo, "a.txt"), "ONE\na2\na3\n");
  assert.equal(await read(f.repo, "b.txt"), "TWO\nb2\nb3\n");
});

test("two workspaces on one file conflict, and main is left alone", { skip }, async (t) => {
  const f = await makeRepo();
  t.after(() => fs.rm(f.tmp, { recursive: true, force: true }));
  const one = await addWorkspace(f, "one");
  const two = await addWorkspace(f, "two");
  await write(one.path, "a.txt", "ONE\na2\na3\n");
  await commitAll(one.path, "one");
  await write(two.path, "a.txt", "TWO\na2\na3\n");
  await commitAll(two.path, "two");

  await mergeWorkspace({
    repoRoot: f.repo,
    worktreePath: one.path,
    branch: one.branch,
    baseRef: "main",
    baseSha: f.baseSha,
    strategy: "merge",
  });
  const before = await head(f.repo);

  const pre = await preflight({
    repoRoot: f.repo,
    worktreePath: two.path,
    branch: two.branch,
    baseRef: "main",
    baseSha: f.baseSha,
  });
  assert.equal(pre.ok, false);
  assert.equal(pre.reason, "conflicts");
  assert.deepEqual(pre.conflictingFiles, ["a.txt"]);

  // Even forced: a conflict is not something the user can wave through, and
  // nothing at all may change.
  const result = await mergeWorkspace({
    repoRoot: f.repo,
    worktreePath: two.path,
    branch: two.branch,
    baseRef: "main",
    baseSha: f.baseSha,
    strategy: "merge",
    force: true,
  });
  assert.equal(result.merged, false);
  assert.deepEqual(result.conflictingFiles, ["a.txt"]);
  assert.match(result.message, /Nothing was changed/);
  assert.equal(await head(f.repo), before);
  assert.equal(await read(f.repo, "a.txt"), "ONE\na2\na3\n");
});

test("a dirty main checkout is stashed around the merge and comes back whole", { skip }, async (t) => {
  const f = await makeRepo();
  t.after(() => fs.rm(f.tmp, { recursive: true, force: true }));
  const one = await addWorkspace(f, "one");
  await write(one.path, "a.txt", "ONE\na2\na3\n");
  await commitAll(one.path, "one");

  // Uncommitted work in main, tracked and untracked alike.
  await write(f.repo, "b.txt", "LOCAL\nb2\nb3\n");
  await write(f.repo, "scratch.txt", "not committed\n");

  const pre = await preflight({
    repoRoot: f.repo,
    worktreePath: one.path,
    branch: one.branch,
    baseRef: "main",
    baseSha: f.baseSha,
  });
  assert.equal(pre.reason, "base-dirty");
  assert.equal(pre.baseDirty, true);

  const result = await mergeWorkspace({
    repoRoot: f.repo,
    worktreePath: one.path,
    branch: one.branch,
    baseRef: "main",
    baseSha: f.baseSha,
    strategy: "merge",
    force: true,
  });
  assert.equal(result.merged, true, result.message);
  assert.equal(result.stashed, true);
  assert.match(result.message, /stashed and restored/);
  assert.equal(await read(f.repo, "a.txt"), "ONE\na2\na3\n");
  assert.equal(await read(f.repo, "b.txt"), "LOCAL\nb2\nb3\n");
  assert.equal(await read(f.repo, "scratch.txt"), "not committed\n");
  // Nothing may be left behind in the stash list.
  const stashes = (await git(["stash", "list"], { cwd: f.repo })).stdout.trim();
  assert.equal(stashes, "");
});

test("squash lands exactly one commit and carries the uncommitted work with it", { skip }, async (t) => {
  const f = await makeRepo();
  t.after(() => fs.rm(f.tmp, { recursive: true, force: true }));
  const one = await addWorkspace(f, "one");
  await write(one.path, "a.txt", "ONE\na2\na3\n");
  await commitAll(one.path, "step 1");
  await write(one.path, "a.txt", "ONE\nTWO\na3\n");
  await commitAll(one.path, "step 2");
  // Left uncommitted by the agent, plus a brand new file git has never seen.
  await write(one.path, "a.txt", "ONE\nTWO\nTHREE\n");
  await write(one.path, "new.txt", "fresh\n");

  const pre = await preflight({
    repoRoot: f.repo,
    worktreePath: one.path,
    branch: one.branch,
    baseRef: "main",
    baseSha: f.baseSha,
  });
  assert.equal(pre.reason, "worktree-dirty");
  assert.equal(pre.worktreeDirty, true);
  assert.equal(pre.ahead, 2);

  const result = await mergeWorkspace({
    repoRoot: f.repo,
    worktreePath: one.path,
    branch: one.branch,
    baseRef: "main",
    baseSha: f.baseSha,
    strategy: "squash",
    force: true,
  });
  assert.equal(result.merged, true, result.message);
  assert.match(result.message, /committed onto omp\/one first/);

  const count = (await git(["rev-list", "--count", `${f.baseSha}..HEAD`], { cwd: f.repo })).stdout.trim();
  assert.equal(count, "1", "squash must leave exactly one commit on top of the base");
  assert.equal(await read(f.repo, "a.txt"), "ONE\nTWO\nTHREE\n");
  assert.equal(await read(f.repo, "new.txt"), "fresh\n");
  assert.equal(await head(f.repo), result.commit);
});

test("a workspace with nothing in it is refused without touching anything", { skip }, async (t) => {
  const f = await makeRepo();
  t.after(() => fs.rm(f.tmp, { recursive: true, force: true }));
  const one = await addWorkspace(f, "one");

  const pre = await preflight({
    repoRoot: f.repo,
    worktreePath: one.path,
    branch: one.branch,
    baseRef: "main",
    baseSha: f.baseSha,
  });
  assert.equal(pre.reason, "no-commits");
  assert.equal(pre.ahead, 0);

  const before = await head(f.repo);
  const result = await mergeWorkspace({
    repoRoot: f.repo,
    worktreePath: one.path,
    branch: one.branch,
    baseRef: "main",
    baseSha: f.baseSha,
    strategy: "merge",
    force: true,
  });
  assert.equal(result.merged, false);
  assert.match(result.message, /Nothing was changed/);
  assert.equal(await head(f.repo), before);
});

test("preflight reports a branch that is gone instead of guessing", { skip }, async (t) => {
  const f = await makeRepo();
  t.after(() => fs.rm(f.tmp, { recursive: true, force: true }));
  const pre = await preflight({
    repoRoot: f.repo,
    worktreePath: f.repo,
    branch: "omp/never-existed",
    baseRef: "main",
    baseSha: f.baseSha,
  });
  assert.equal(pre.ok, false);
  assert.equal(pre.reason, "branch-missing");
});

test("discardWorkspaceFile puts one file back the way the base had it", { skip }, async (t) => {
  const f = await makeRepo();
  t.after(() => fs.rm(f.tmp, { recursive: true, force: true }));
  const one = await addWorkspace(f, "one");
  await write(one.path, "a.txt", "CHANGED\na2\na3\n");
  await write(one.path, "brand-new.txt", "untracked\n");
  await write(one.path, "committed-new.txt", "committed on the branch\n");
  await commitAll(one.path, "adds a file");

  // Tracked and modified: back to the base content.
  await discardWorkspaceFile(one.path, f.baseSha, "a.txt");
  assert.equal(await read(one.path, "a.txt"), "a1\na2\na3\n");

  // Never tracked: simply gone.
  await discardWorkspaceFile(one.path, f.baseSha, "brand-new.txt");
  assert.equal(await fs.access(path.join(one.path, "brand-new.txt")).then(() => true, () => false), false);

  // Tracked here but absent from the base: the base state is "no such file".
  await discardWorkspaceFile(one.path, f.baseSha, "committed-new.txt");
  assert.equal(
    await fs.access(path.join(one.path, "committed-new.txt")).then(() => true, () => false),
    false,
  );
});

test("a conflict hidden in uncommitted work aborts and leaves both sides intact", { skip }, async (t) => {
  // The nastiest shape: `merge-tree` sees no conflict, because the conflicting
  // edit has not been committed yet. The merge itself has to catch it, undo
  // itself, and still leave the agent's work safe on its own branch.
  const f = await makeRepo();
  t.after(() => fs.rm(f.tmp, { recursive: true, force: true }));
  const one = await addWorkspace(f, "one");
  await write(f.repo, "a.txt", "MAIN\na2\na3\n");
  await commitAll(f.repo, "main moves on");
  await write(one.path, "a.txt", "AGENT\na2\na3\n");

  const pre = await preflight({
    repoRoot: f.repo,
    worktreePath: one.path,
    branch: one.branch,
    baseRef: "main",
    baseSha: f.baseSha,
  });
  assert.equal(pre.reason, "worktree-dirty");
  assert.deepEqual(pre.conflictingFiles, [], "an uncommitted edit is invisible to merge-tree");

  const before = await head(f.repo);
  for (const strategy of ["merge", "squash"] as const) {
    const result = await mergeWorkspace({
      repoRoot: f.repo,
      worktreePath: one.path,
      branch: one.branch,
      baseRef: "main",
      baseSha: f.baseSha,
      strategy,
      force: true,
    });
    assert.equal(result.merged, false, `${strategy}: ${result.message}`);
    assert.deepEqual(result.conflictingFiles, ["a.txt"]);
    assert.equal(await head(f.repo), before, `${strategy} must leave main alone`);
    assert.equal(await read(f.repo, "a.txt"), "MAIN\na2\na3\n");
    // The agent's work survives — as a commit on its own branch, which is the
    // one mutation this module is allowed to make inside a worktree.
    assert.equal(await read(one.path, "a.txt"), "AGENT\na2\na3\n");
    assert.equal((await git(["status", "--porcelain"], { cwd: one.path })).stdout, "");
  }
});

test("a stash that will not come back is reported, never swallowed", { skip }, async (t) => {
  const f = await makeRepo();
  t.after(() => fs.rm(f.tmp, { recursive: true, force: true }));
  const one = await addWorkspace(f, "one");
  await write(one.path, "a.txt", "WORKSPACE\na2\na3\n");
  await commitAll(one.path, "one");
  // main holds an uncommitted edit to the same line: the merge succeeds, and
  // then the stash cannot be popped back on top of it.
  await write(f.repo, "a.txt", "LOCAL\na2\na3\n");

  const result = await mergeWorkspace({
    repoRoot: f.repo,
    worktreePath: one.path,
    branch: one.branch,
    baseRef: "main",
    baseSha: f.baseSha,
    strategy: "merge",
    force: true,
  });
  assert.equal(result.merged, true, result.message);
  assert.equal(result.stashed, true);
  // A conflicting `git stash pop` has already applied the stash — with markers
  // — and kept the entry, so the advice is "resolve, then drop", never "pop
  // again", and the entry has to be named either way.
  assert.match(result.message, /ompcode-merge-omp\/one/);
  assert.match(result.message, /git stash drop/);
  assert.doesNotMatch(result.message, /run `git stash pop`/);
  assert.match((await read(f.repo, "a.txt")), /<{7}/);
  // git kept the entry; the user has to be able to find it.
  assert.match((await git(["stash", "list"], { cwd: f.repo })).stdout, /ompcode-merge-omp\/one/);
});

test("the main checkout is put back on the branch it was on", { skip }, async (t) => {
  const f = await makeRepo();
  t.after(() => fs.rm(f.tmp, { recursive: true, force: true }));
  const one = await addWorkspace(f, "one");
  await write(one.path, "b.txt", "ONE\nb2\nb3\n");
  await commitAll(one.path, "one");

  // The operator is working on a branch of their own, with uncommitted work on
  // it — the ordinary state of a repository somebody is using.
  await git(["checkout", "-q", "-b", "my-feature"], { cwd: f.repo });
  await write(f.repo, "a.txt", "LOCAL\na2\na3\n");
  await write(f.repo, "scratch.txt", "notes\n");

  const result = await mergeWorkspace({
    repoRoot: f.repo,
    worktreePath: one.path,
    branch: one.branch,
    baseRef: "main",
    baseSha: f.baseSha,
    strategy: "merge",
    force: true,
  });
  assert.equal(result.merged, true, result.message);
  // Their branch, not the base: the next commit they make has to land where
  // they were working, and the stash has to come back onto the same branch.
  assert.equal(
    (await git(["rev-parse", "--abbrev-ref", "HEAD"], { cwd: f.repo })).stdout.trim(),
    "my-feature",
  );
  assert.equal(await read(f.repo, "a.txt"), "LOCAL\na2\na3\n");
  assert.equal(await read(f.repo, "scratch.txt"), "notes\n");
  assert.equal((await git(["stash", "list"], { cwd: f.repo })).stdout.trim(), "");
  // main really did move, even though nothing is standing on it.
  assert.equal(
    (await git(["show", "main:b.txt"], { cwd: f.repo })).stdout,
    "ONE\nb2\nb3\n",
  );
  // And the work that was theirs stayed uncommitted on their branch.
  assert.match((await git(["status", "--porcelain"], { cwd: f.repo })).stdout, /a\.txt/);
});

test("a refusal still reports the worktree commit it made", { skip }, async (t) => {
  const f = await makeRepo();
  t.after(() => fs.rm(f.tmp, { recursive: true, force: true }));
  const one = await addWorkspace(f, "one");
  // main moves first, so the agent's uncommitted edit to the same line cannot
  // merge — the failure happens *after* step 3 has already committed it.
  await write(f.repo, "a.txt", "MAIN\na2\na3\n");
  await commitAll(f.repo, "main moves");
  await write(one.path, "a.txt", "AGENT\na2\na3\n");

  const result = await mergeWorkspace({
    repoRoot: f.repo,
    worktreePath: one.path,
    branch: one.branch,
    baseRef: "main",
    baseSha: f.baseSha,
    strategy: "merge",
    force: true,
  });
  assert.equal(result.merged, false);
  // The one mutation this module makes inside a worktree is never left out of
  // the report, however the merge itself ended.
  assert.match(result.message, /committed onto omp\/one first/);
  assert.equal((await git(["status", "--porcelain"], { cwd: one.path })).stdout, "");
});

test("a squash with nothing left after the rebase is not reported as a merge", { skip }, async (t) => {
  const f = await makeRepo();
  t.after(() => fs.rm(f.tmp, { recursive: true, force: true }));
  const one = await addWorkspace(f, "one");
  await write(one.path, "a.txt", "SAME\na2\na3\n");
  await commitAll(one.path, "one");
  // The same change lands on main as a different commit: the rebase drops the
  // workspace's commit as empty and `merge --ff-only` says "Already up to
  // date" with exit 0.
  await write(f.repo, "a.txt", "SAME\na2\na3\n");
  await commitAll(f.repo, "main did the same thing");
  const before = await head(f.repo);

  const result = await mergeWorkspace({
    repoRoot: f.repo,
    worktreePath: one.path,
    branch: one.branch,
    baseRef: "main",
    baseSha: f.baseSha,
    strategy: "squash",
    force: true,
  });
  assert.equal(result.merged, false, result.message);
  assert.equal(result.commit, undefined);
  assert.match(result.message, /Nothing was merged/);
  assert.equal(await head(f.repo), before);
});

test("a worktree that is not on its branch is refused before anything is touched", { skip }, async (t) => {
  const f = await makeRepo();
  t.after(() => fs.rm(f.tmp, { recursive: true, force: true }));
  const one = await addWorkspace(f, "one");
  await write(one.path, "b.txt", "ONE\nb2\nb3\n");
  await commitAll(one.path, "one");
  const branchTip = (await git(["rev-parse", one.branch], { cwd: f.repo })).stdout.trim();
  // The agent wandered off its branch and left work behind: committing here
  // would put it on a commit no ref can reach.
  await git(["checkout", "-q", "--detach"], { cwd: one.path });
  await write(one.path, "loose.txt", "loose\n");
  const before = await head(f.repo);

  const result = await mergeWorkspace({
    repoRoot: f.repo,
    worktreePath: one.path,
    branch: one.branch,
    baseRef: "main",
    baseSha: f.baseSha,
    strategy: "merge",
    force: true,
  });
  assert.equal(result.merged, false);
  assert.match(result.message, /not checked out/);
  assert.equal(await head(f.repo), before);
  assert.equal((await git(["rev-parse", one.branch], { cwd: f.repo })).stdout.trim(), branchTip);
  // Untouched: the loose file is still uncommitted, not swept into a commit.
  assert.match((await git(["status", "--porcelain"], { cwd: one.path })).stdout, /loose\.txt/);
});

test("discarding a rename brings the old file back instead of deleting both", { skip }, async (t) => {
  const f = await makeRepo();
  t.after(() => fs.rm(f.tmp, { recursive: true, force: true }));
  const one = await addWorkspace(f, "one");
  await fs.mkdir(path.join(one.path, "sub"));
  await git(["mv", "a.txt", "sub/new name.txt"], { cwd: one.path });
  // Left unmodified on purpose: that is exactly when git reports the change as
  // a rename, and so exactly when the review tree offers a "renamed" row to
  // discard. A rename whose new file has also been edited comes back from git
  // as a delete plus an add, and the two rows are discarded separately.
  await discardWorkspaceFile(one.path, f.baseSha, "sub/new name.txt");

  // The dialog promises the file goes back to its old name as the base had it,
  // and that is what has to happen: the old content is in no commit of this
  // worktree's own, so deleting the new path alone destroys it.
  assert.equal(await read(one.path, "a.txt"), "a1\na2\na3\n");
  await assert.rejects(read(one.path, "sub/new name.txt"));
});

test("discarding an untracked directory removes it rather than throwing", { skip }, async (t) => {
  const f = await makeRepo();
  t.after(() => fs.rm(f.tmp, { recursive: true, force: true }));
  const one = await addWorkspace(f, "one");
  await fs.mkdir(path.join(one.path, "scratch"));
  await write(one.path, "scratch/note.txt", "note\n");

  await discardWorkspaceFile(one.path, f.baseSha, "scratch");
  await assert.rejects(fs.stat(path.join(one.path, "scratch")));
});
