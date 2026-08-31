import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  baseContent,
  countLines,
  fileDiff,
  parseNumstatZ,
  summarize,
  workspaceDiff,
} from "../src/workspaces/diff.ts";
import { git } from "../src/workspaces/git.ts";

/**
 * Real `git diff --numstat -z` bytes (git 2.50), captured from a throwaway repo
 * rather than written from memory: the rename shape in particular is easy to
 * get wrong, and a hand-written fixture would have hidden that.
 *
 * It covers, in order: a plain add, a modification, a deletion, a rename with
 * a space in the new name, and a binary file.
 */
const NUMSTAT_Z =
  "2\t0\tadded.txt\0" +
  "2\t1\tmod.txt\0" +
  "0\t2\tdel.txt\0" +
  "0\t0\t\0oldname.txt\0new name.txt\0" +
  "-\t-\trealbin.dat\0";

test("parseNumstatZ reads ordinary records", () => {
  const files = parseNumstatZ(NUMSTAT_Z);
  const added = files.find((f) => f.path === "added.txt")!;
  assert.deepEqual(added, { path: "added.txt", status: "modified", added: 2, deleted: 0, binary: false });

  const modified = files.find((f) => f.path === "mod.txt")!;
  assert.equal(modified.added, 2);
  assert.equal(modified.deleted, 1);

  const deleted = files.find((f) => f.path === "del.txt")!;
  assert.equal(deleted.added, 0);
  assert.equal(deleted.deleted, 2);
});

test("parseNumstatZ reads the three-field rename form", () => {
  const files = parseNumstatZ(NUMSTAT_Z);
  const renamed = files.find((f) => f.status === "renamed")!;
  // The path slot of the first field is empty and the two names follow it, so a
  // parser that split on NUL naively would emit two bogus entries here.
  assert.equal(renamed.path, "new name.txt");
  assert.equal(renamed.oldPath, "oldname.txt");
  assert.equal(renamed.added, 0);
  assert.equal(renamed.deleted, 0);
  assert.equal(files.length, 5);
});

test("parseNumstatZ keeps a rename that also changed lines", () => {
  const [renamed] = parseNumstatZ("7\t3\t\0src/old.ts\0src/new.ts\0");
  assert.equal(renamed!.path, "src/new.ts");
  assert.equal(renamed!.oldPath, "src/old.ts");
  assert.equal(renamed!.added, 7);
  assert.equal(renamed!.deleted, 3);
});

test("parseNumstatZ marks binary files instead of inventing counts", () => {
  const binary = parseNumstatZ(NUMSTAT_Z).find((f) => f.path === "realbin.dat")!;
  assert.equal(binary.binary, true);
  assert.equal(binary.added, 0);
  assert.equal(binary.deleted, 0);

  const [renamedBinary] = parseNumstatZ("-\t-\t\0a.png\0b.png\0");
  assert.equal(renamedBinary!.binary, true);
  assert.equal(renamedBinary!.status, "renamed");
  assert.equal(renamedBinary!.path, "b.png");
});

test("parseNumstatZ survives empty and malformed input", () => {
  assert.deepEqual(parseNumstatZ(""), []);
  assert.deepEqual(parseNumstatZ("\0"), []);
  assert.deepEqual(parseNumstatZ("garbage\0"), []);
  // A rename record cut off mid-way yields nothing rather than half an entry.
  assert.deepEqual(parseNumstatZ("1\t1\t\0only-old-name.txt\0"), []);
  // Unparseable records are dropped, the good ones around them survive.
  assert.deepEqual(
    parseNumstatZ("1\t0\tgood.txt\0nonsense\0x\ty\tbad.txt\0").map((f) => f.path),
    ["good.txt"],
  );
});

test("parseNumstatZ does not choke on a path containing a tab", () => {
  const [file] = parseNumstatZ("3\t1\tweird\tname.txt\0");
  assert.equal(file!.path, "weird\tname.txt");
  assert.equal(file!.added, 3);
});

test("countLines counts a final unterminated line", () => {
  assert.equal(countLines(""), 0);
  assert.equal(countLines("\n"), 1);
  assert.equal(countLines("a"), 1);
  assert.equal(countLines("a\n"), 1);
  assert.equal(countLines("a\nb"), 2);
  assert.equal(countLines("a\nb\n"), 2);
  assert.equal(countLines("a\r\nb\r\n"), 2);
  assert.equal(countLines("\n\n\n"), 3);
});

test("summarize adds up both columns", () => {
  assert.deepEqual(summarize(parseNumstatZ(NUMSTAT_Z)), { added: 4, deleted: 3 });
  assert.deepEqual(summarize([]), { added: 0, deleted: 0 });
});

async function gitAvailable(): Promise<boolean> {
  return await new Promise((resolve) => {
    const child = spawn("git", ["--version"], { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("close", (code) => resolve(code === 0));
  });
}

const hasGit = await gitAvailable();

/** A repository with one commit, plus a worktree-shaped place to work in it. */
async function makeRepo(t: { after(fn: () => unknown): void }): Promise<{ repo: string; baseSha: string }> {
  const tmp = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "ompcode-diff-"));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));
  const repo = path.join(tmp, "repo");
  await fs.mkdir(repo);
  // Identity and default branch forced so the test ignores the developer's
  // global git config.
  await git(["-c", "init.defaultBranch=main", "init", "-q", "."], { cwd: repo });
  await fs.writeFile(path.join(repo, "kept.txt"), "one\ntwo\n");
  await fs.writeFile(path.join(repo, "edited.txt"), "a\nb\nc\n");
  await fs.mkdir(path.join(repo, "src"));
  await fs.writeFile(path.join(repo, "src", "gone.txt"), "x\ny\n");
  await git(["add", "-A"], { cwd: repo });
  await git(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "base"], { cwd: repo });
  const { stdout } = await git(["rev-parse", "HEAD"], { cwd: repo });
  return { repo, baseSha: stdout.trim() };
}

const commit = (repo: string, message: string) =>
  git(["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", message], { cwd: repo });

test(
  "workspaceDiff sees committed, uncommitted and untracked work at once",
  { skip: hasGit ? false : "git is not on PATH" },
  async (t) => {
    const { repo, baseSha } = await makeRepo(t);

    // 1. A committed change on the branch.
    await fs.writeFile(path.join(repo, "committed.txt"), "c1\nc2\nc3\n");
    await git(["add", "committed.txt"], { cwd: repo });
    await commit(repo, "agent work");

    // 2. An uncommitted edit to a tracked file, and a deletion.
    await fs.writeFile(path.join(repo, "edited.txt"), "a\nB\nc\nd\n");
    await fs.rm(path.join(repo, "src", "gone.txt"));

    // 3. A brand-new file the agent never added — invisible to `git diff`
    //    unless something writes to the index, which we refuse to do.
    await fs.writeFile(path.join(repo, "fresh.txt"), "new1\nnew2\nnew3\n");

    const diff = await workspaceDiff(repo, baseSha);
    const byPath = new Map(diff.files.map((f) => [f.path, f]));

    assert.equal(byPath.get("committed.txt")?.status, "added");
    assert.equal(byPath.get("committed.txt")?.added, 3);

    assert.equal(byPath.get("edited.txt")?.status, "modified");
    assert.equal(byPath.get("edited.txt")?.added, 2);
    assert.equal(byPath.get("edited.txt")?.deleted, 1);

    assert.equal(byPath.get("src/gone.txt")?.status, "deleted");
    assert.equal(byPath.get("src/gone.txt")?.deleted, 2);

    assert.equal(byPath.get("fresh.txt")?.status, "untracked");
    assert.equal(byPath.get("fresh.txt")?.added, 3);
    assert.equal(byPath.get("fresh.txt")?.deleted, 0);

    // The untouched file must not appear at all: pinning the base SHA is what
    // keeps a moving `main` from repainting it as changed.
    assert.equal(byPath.has("kept.txt"), false);
    assert.equal(diff.files.length, 4);
    assert.equal(diff.truncated, false);
    assert.deepEqual(
      { added: diff.added, deleted: diff.deleted },
      { added: 3 + 2 + 0 + 3, deleted: 0 + 1 + 2 + 0 },
    );

    // Nothing may have been staged on the agent's behalf.
    const staged = await git(["diff", "--cached", "--name-only"], { cwd: repo });
    assert.equal(staged.stdout.trim(), "");
  },
);

test(
  "workspaceDiff reports renames and binary files",
  { skip: hasGit ? false : "git is not on PATH" },
  async (t) => {
    const { repo, baseSha } = await makeRepo(t);
    await git(["mv", "kept.txt", "moved name.txt"], { cwd: repo });
    await fs.writeFile(path.join(repo, "blob.bin"), Buffer.from([0x41, 0x00, 0x42, 0x00]));
    await git(["add", "blob.bin"], { cwd: repo });
    await commit(repo, "move and add binary");

    const diff = await workspaceDiff(repo, baseSha);
    const renamed = diff.files.find((f) => f.status === "renamed")!;
    assert.equal(renamed.path, "moved name.txt");
    assert.equal(renamed.oldPath, "kept.txt");

    const binary = diff.files.find((f) => f.path === "blob.bin")!;
    assert.equal(binary.binary, true);
    assert.equal(binary.added, 0);
  },
);

test(
  "an untracked binary file is flagged, not line-counted",
  { skip: hasGit ? false : "git is not on PATH" },
  async (t) => {
    const { repo, baseSha } = await makeRepo(t);
    await fs.writeFile(path.join(repo, "raw.bin"), Buffer.from([0x00, 0x01, 0x02, 0x0a, 0x0a]));
    await fs.writeFile(path.join(repo, "empty.txt"), "");

    const diff = await workspaceDiff(repo, baseSha);
    const binary = diff.files.find((f) => f.path === "raw.bin")!;
    assert.equal(binary.status, "untracked");
    assert.equal(binary.binary, true);
    assert.equal(binary.added, 0);

    const empty = diff.files.find((f) => f.path === "empty.txt")!;
    assert.equal(empty.added, 0);
    assert.equal(empty.binary, false);
  },
);

test(
  "workspaceDiff sorts by directory then name, and truncates on maxFiles",
  { skip: hasGit ? false : "git is not on PATH" },
  async (t) => {
    const { repo, baseSha } = await makeRepo(t);
    for (const relative of ["z.txt", "a.txt", "src/b.txt", "src/a.txt", "lib/x.txt"]) {
      const target = path.join(repo, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, "line\n");
    }

    const diff = await workspaceDiff(repo, baseSha);
    assert.deepEqual(
      diff.files.map((f) => f.path),
      ["a.txt", "z.txt", "lib/x.txt", "src/a.txt", "src/b.txt"],
    );

    const cut = await workspaceDiff(repo, baseSha, { maxFiles: 2 });
    assert.equal(cut.files.length, 2);
    assert.equal(cut.truncated, true);
    // The totals still describe the whole workspace, not the visible slice.
    assert.equal(cut.added, diff.added);
  },
);

test(
  "fileDiff handles tracked, deleted and untracked files",
  { skip: hasGit ? false : "git is not on PATH" },
  async (t) => {
    const { repo, baseSha } = await makeRepo(t);
    await fs.writeFile(path.join(repo, "edited.txt"), "a\nB\nc\n");
    await fs.rm(path.join(repo, "src", "gone.txt"));
    await fs.writeFile(path.join(repo, "fresh.txt"), "new1\nnew2\n");

    const tracked = await fileDiff(repo, baseSha, "edited.txt");
    assert.match(tracked, /^diff --git a\/edited\.txt b\/edited\.txt$/m);
    assert.match(tracked, /^-b$/m);
    assert.match(tracked, /^\+B$/m);

    const deleted = await fileDiff(repo, baseSha, "src/gone.txt");
    assert.match(deleted, /deleted file mode/);

    // `--no-index` answers "the files differ" with exit 1; treating that as a
    // failure would leave every new file in the review with an empty diff.
    const untracked = await fileDiff(repo, baseSha, "fresh.txt");
    assert.match(untracked, /new file mode/);
    assert.match(untracked, /^\+new1$/m);
    assert.match(untracked, /^\+new2$/m);
  },
);

test(
  "fileDiff truncates on a line boundary and says so",
  { skip: hasGit ? false : "git is not on PATH" },
  async (t) => {
    const { repo, baseSha } = await makeRepo(t);
    await fs.writeFile(path.join(repo, "big.txt"), Array.from({ length: 500 }, (_, i) => `line ${i}\n`).join(""));

    const cut = await fileDiff(repo, baseSha, "big.txt", { maxBytes: 200 });
    assert.ok(Buffer.byteLength(cut, "utf8") < 400, "the cut diff stays near the limit");
    assert.match(cut, /\*\*\* diff truncated at \d+ of \d+ bytes \*\*\*\n$/);
    // Everything before the marker is still whole lines of a real diff.
    const body = cut.slice(0, cut.lastIndexOf("*** diff truncated"));
    assert.ok(body.endsWith("\n"));
    assert.match(body, /^diff --git /);

    const whole = await fileDiff(repo, baseSha, "big.txt");
    assert.doesNotMatch(whole, /diff truncated/);
  },
);

test(
  "baseContent returns the base version, or undefined when there was none",
  { skip: hasGit ? false : "git is not on PATH" },
  async (t) => {
    const { repo, baseSha } = await makeRepo(t);
    await fs.writeFile(path.join(repo, "edited.txt"), "changed\n");
    await fs.writeFile(path.join(repo, "fresh.txt"), "new\n");
    await git(["add", "-A"], { cwd: repo });
    await commit(repo, "work");

    assert.equal(await baseContent(repo, baseSha, "edited.txt"), "a\nb\nc\n");
    assert.equal(await baseContent(repo, baseSha, "src/gone.txt"), "x\ny\n");
    // Added on the branch, so the left-hand side of the diff editor is empty.
    assert.equal(await baseContent(repo, baseSha, "fresh.txt"), undefined);
    assert.equal(await baseContent(repo, baseSha, "never/existed.txt"), undefined);
    // A leading "./" is tolerated, since callers build paths with path.join.
    assert.equal(await baseContent(repo, baseSha, "./src/gone.txt"), "x\ny\n");
  },
);

test(
  "a broken base SHA is an error, not an empty diff",
  { skip: hasGit ? false : "git is not on PATH" },
  async (t) => {
    const { repo } = await makeRepo(t);
    await assert.rejects(() => workspaceDiff(repo, "0".repeat(40)));
    await assert.rejects(() => baseContent(repo, "0".repeat(40), "kept.txt"));
  },
);
