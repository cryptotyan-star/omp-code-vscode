/*! Portions derived from microsoft/vscode (extensions/git/src/git.ts, extensions/git/src/repository.ts), MIT, Copyright (c) Microsoft Corporation.
 *  Portions derived from jackiotyu/git-worktree-manager (src/core/git/*.ts), MIT, Copyright (c) 2023-2026 BingFeng Huang.
 *  Portions derived from stravu/crystal (main/src/utils/mutex.ts, main/src/services/gitPlumbingCommands.ts), MIT, Copyright (c) 2024 Stravu.
 *  Adapted for OMP Code. */

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Every git call the workspace layer makes.
 *
 * Deliberately free of `vscode`: the extension host must never block on git, so
 * everything here is async `spawn` (never `execSync`), and the module can be
 * unit-tested with plain `node --test`.
 */

export type GitErrorCode =
  | "WorktreeContainsChanges"
  | "WorktreeAlreadyExists"
  | "BranchAlreadyUsedByWorktree"
  | "BranchAlreadyExists"
  | "BranchNotFound"
  | "NotAGitRepository"
  | "PathExists"
  | "MergeConflict"
  | "NoFastForward"
  | "LocalChangesOverwritten"
  | "StashConflict"
  | "UnmergedFiles"
  | "Unknown";

export class GitError extends Error {
  readonly code: GitErrorCode;
  readonly stderr: string;
  readonly args: string[];
  /**
   * The `errno` of a spawn failure ("ENOENT" when git itself is missing or the
   * cwd is gone), absent when git ran and exited non-zero. Callers need the
   * difference: a repository that no longer exists is not the same problem as
   * a git that refused.
   */
  readonly errno?: string;

  constructor(message: string, code: GitErrorCode, stderr: string, args: string[], errno?: string) {
    super(message);
    this.name = "GitError";
    this.code = code;
    this.stderr = stderr;
    this.args = args;
    this.errno = errno;
  }
}

/**
 * Map git's own wording onto a code we can branch on. The phrases come from
 * vscode's git extension, which has been keeping them current against real git
 * releases for years — far safer than inventing our own.
 *
 * Order matters: several messages contain "already exists", so the most
 * specific pattern has to be tested first.
 */
export function classifyGitError(stderr: string): GitErrorCode {
  if (/contains modified or untracked files|use --force to delete it/i.test(stderr)) {
    return "WorktreeContainsChanges";
  }
  if (/used by worktree at|is already checked out at/i.test(stderr)) {
    return "BranchAlreadyUsedByWorktree";
  }
  if (/a branch named '.+' already exists|branch '.+' already exists/i.test(stderr)) {
    return "BranchAlreadyExists";
  }
  if (/already exists and is not an empty directory|destination path '.+' already exists/i.test(stderr)) {
    return "PathExists";
  }
  if (/'[^']+' already exists|is already registered/i.test(stderr)) {
    return "WorktreeAlreadyExists";
  }
  if (
    /branch '.+' not found|not a valid object name|unknown revision or path not in the working tree|invalid reference|Needed a single revision|did not match any file\(s\) known to git/i.test(
      stderr,
    )
  ) {
    return "BranchNotFound";
  }
  if (/not a git repository/i.test(stderr)) {
    return "NotAGitRepository";
  }
  // The merge family. git reports most of these on stdout rather than stderr
  // ("CONFLICT (content): …" from merge, rebase and stash pop alike), so
  // callers that care hand the two streams in together.
  //
  // The stash entry line has to be tested before the generic CONFLICT: a
  // conflicting `git stash pop` prints both, and only the stash line says that
  // uncommitted work is now sitting in the stash list where the user cannot
  // see it.
  if (/The stash entry is kept in case you need it again|could not restore untracked files from stash/i.test(stderr)) {
    return "StashConflict";
  }
  if (/Your local changes to the following files would be overwritten|Please,? commit your changes or stash them/i.test(stderr)) {
    return "LocalChangesOverwritten";
  }
  if (
    /not possible because you have unmerged files|you need to resolve your current index first|Exiting because of an unresolved conflict|fix conflicts and run "git commit"/i.test(
      stderr,
    )
  ) {
    return "UnmergedFiles";
  }
  if (/^CONFLICT \(|Automatic merge failed|Merge conflict in |could not apply [0-9a-f]/im.test(stderr)) {
    return "MergeConflict";
  }
  if (/Not possible to fast-forward|\(non-fast-forward\)|fatal: Not possible to fast forward/i.test(stderr)) {
    return "NoFastForward";
  }
  return "Unknown";
}

export interface GitExecOptions {
  cwd: string;
  signal?: AbortSignal;
  gitPath?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Run git and collect its output.
 *
 * The locale is forced so that {@link classifyGitError}'s English patterns keep
 * matching on a translated system, and the credential/pager prompts are turned
 * off — an extension host has no terminal to answer them on, so a prompting git
 * would simply hang forever.
 */
export function git(args: string[], opts: GitExecOptions): Promise<{ stdout: string; stderr: string }> {
  const file = opts.gitPath ?? "git";
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      signal: opts.signal,
      env: {
        ...process.env,
        ...opts.env,
        GIT_PAGER: "cat",
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "NEVER",
        LC_ALL: "en_US.UTF-8",
        LANG: "en_US.UTF-8",
      },
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.once("error", (err: Error) => {
      // Spawn failures (git missing, cwd gone, aborted signal) never reach the
      // close handler, so they get their own GitError with the same shape. The
      // errno is kept: "the directory is gone" is recoverable, "git is not
      // installed" is not, and only errno tells them apart.
      const errno = (err as NodeJS.ErrnoException).code;
      reject(
        new GitError(err.message, classifyGitError(err.message), stderr || err.message, args, errno),
      );
    });

    child.once("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      // git prints progress ("Preparing worktree …") to stderr before the line
      // that says what went wrong, so the first line is usually chatter. The
      // `fatal:`/`error:` line is the reason, and is what callers show.
      const lines = (stderr.trim() || stdout.trim() || `git ${args[0] ?? ""} failed`).split(/\r?\n/);
      const message = lines.find((line) => /^\s*(fatal|error):/i.test(line))?.trim() ?? lines[0]!;
      reject(new GitError(message, classifyGitError(stderr), stderr, args));
    });
  });
}

function withCwd(cwd: string, opts?: Partial<GitExecOptions>): GitExecOptions {
  return { ...opts, cwd };
}

export interface WorktreeEntry {
  path: string;
  head: string;
  branch?: string;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
  isMain: boolean;
}

/**
 * Parse `git worktree list --porcelain`: blank-line separated records of
 * `key value` (or bare `key`) lines. `locked` and `prunable` may carry a
 * reason, so presence of the key — not its value — is what counts.
 *
 * git always emits the main worktree (or the bare repository) first, which is
 * the only way to tell it apart from the linked ones in this output.
 */
export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  for (const block of porcelain.split(/\r?\n\s*\r?\n/)) {
    const fields = new Map<string, string>();
    for (const line of block.split(/\r?\n/)) {
      // Only the line ending is stripped, never surrounding spaces: a worktree
      // path may legitimately begin or end with one, and trimming it here would
      // corrupt the identity every later comparison relies on.
      const text = line.replace(/\r$/, "");
      if (!text.trim()) {
        continue;
      }
      const space = text.indexOf(" ");
      if (space === -1) {
        fields.set(text, "");
      } else {
        fields.set(text.slice(0, space), text.slice(space + 1));
      }
    }
    const worktree = fields.get("worktree");
    if (!worktree) {
      continue;
    }
    const branch = fields.get("branch");
    entries.push({
      path: worktree,
      head: fields.get("HEAD") ?? "",
      branch: branch ? branch.replace(/^refs\/heads\//, "") : undefined,
      detached: fields.has("detached"),
      bare: fields.has("bare"),
      locked: fields.has("locked"),
      prunable: fields.has("prunable"),
      isMain: entries.length === 0,
    });
  }
  return entries;
}

export async function listWorktrees(repoRoot: string, opts?: Partial<GitExecOptions>): Promise<WorktreeEntry[]> {
  const { stdout } = await git(["worktree", "list", "--porcelain"], withCwd(repoRoot, opts));
  return parseWorktreeList(stdout);
}

/**
 * Locate the repository around `cwd`.
 *
 * `--git-common-dir` points at the *main* repository's `.git` even from inside
 * a linked worktree, so comparing it with `--git-dir` is how we know whether we
 * are standing in one.
 */
export async function repoRootOf(
  cwd: string,
  opts?: Partial<GitExecOptions>,
): Promise<{ root: string; commonDir: string; isWorktree: boolean }> {
  const { stdout } = await git(
    ["rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir"],
    withCwd(cwd, opts),
  );
  const [top = "", gitDir = "", commonDir = ""] = stdout.split(/\r?\n/).map((line) => line.trim());
  const absolute = (p: string) => path.normalize(path.isAbsolute(p) ? p : path.resolve(cwd, p));
  const resolvedGitDir = absolute(gitDir);
  const resolvedCommonDir = commonDir ? absolute(commonDir) : resolvedGitDir;
  return {
    root: path.normalize(top),
    commonDir: resolvedCommonDir,
    isWorktree: resolvedGitDir !== resolvedCommonDir,
  };
}

/**
 * The main checkout of the repository around `cwd`, canonicalised.
 *
 * `rev-parse --show-toplevel` answers with the *current* worktree's top, so a
 * window opened on a linked worktree would otherwise treat that worktree as the
 * repository: new worktrees would nest inside it, the per-repository lock would
 * get a second key, and records created from the main checkout would never
 * reconcile. `--git-common-dir` always points at the main repository's `.git`,
 * so its parent is the main checkout (a bare repository has no parent checkout,
 * and the common dir itself is the best answer there).
 */
export async function mainRepoRoot(cwd: string, opts?: Partial<GitExecOptions>): Promise<string> {
  const info = await repoRootOf(cwd, opts);
  if (!info.isWorktree) {
    return canonicalPath(info.root);
  }
  const parent = path.dirname(info.commonDir);
  return canonicalPath(path.basename(info.commonDir) === ".git" ? parent : info.commonDir);
}

export async function revParse(repoRoot: string, ref: string, opts?: Partial<GitExecOptions>): Promise<string> {
  // `^{commit}` peels tags and rejects a ref that is not a commit, so callers
  // always get something a worktree can be created at.
  const { stdout } = await git(["rev-parse", "--verify", `${ref}^{commit}`], withCwd(repoRoot, opts));
  return stdout.trim();
}

/** Current branch, or "" when HEAD is detached (or the repo has no commits yet). */
export async function currentBranch(repoRoot: string, opts?: Partial<GitExecOptions>): Promise<string> {
  try {
    const { stdout } = await git(["symbolic-ref", "--quiet", "--short", "HEAD"], withCwd(repoRoot, opts));
    return stdout.trim();
  } catch {
    return "";
  }
}

export async function listBranches(repoRoot: string, opts?: Partial<GitExecOptions>): Promise<string[]> {
  const { stdout } = await git(
    ["for-each-ref", "--format=%(refname:short)", "refs/heads"],
    withCwd(repoRoot, opts),
  );
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * Compare two filesystem paths as identities. `path.resolve` first (git reports
 * forward slashes even on Windows), then fold case only on Windows, where the
 * filesystem genuinely ignores it — folding on macOS would merge two real
 * worktrees on a case-sensitive volume into one.
 */
export function samePath(a: string, b: string): boolean {
  const normalize = (p: string) => {
    const value = path.resolve(p).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? value.toLowerCase() : value;
  };
  return normalize(a) === normalize(b);
}

/**
 * The path git would print for this location: symlinks resolved, because
 * `git worktree list --porcelain` always reports the real path. A record that
 * stored the unresolved spelling (macOS `/tmp`, any symlinked dev directory)
 * would never match its own worktree again and would be dropped as an orphan.
 *
 * A path that does not exist yet is returned as given — the deepest existing
 * ancestor is resolved instead, so a not-yet-created worktree still gets the
 * canonical spelling of the directory it will live in.
 */
export async function canonicalPath(target: string): Promise<string> {
  const absolute = path.resolve(target);
  try {
    return await fs.realpath(absolute);
  } catch {
    const parent = path.dirname(absolute);
    if (parent === absolute) {
      return absolute;
    }
    return path.join(await canonicalPath(parent), path.basename(absolute));
  }
}

/**
 * Create a worktree on a fresh branch.
 *
 * `--no-track` by default: these branches are local scratch space for one agent,
 * and an accidental upstream turns a later `git push` into a push to someone
 * else's branch.
 *
 * A leftover directory from a worktree git no longer knows about (VS Code
 * crashed mid-remove, someone deleted `.git/worktrees/...`) would make `add`
 * fail forever, so it is cleaned up first — but only if it is empty after git
 * has had its own go at it. Anything else is the user's data and stays put.
 */
export async function addWorktree(
  a: { repoRoot: string; path: string; branch: string; commitish: string; noTrack?: boolean },
  opts?: Partial<GitExecOptions>,
): Promise<void> {
  if (await pathExists(a.path)) {
    const live = await listWorktrees(a.repoRoot, opts);
    if (!live.some((entry) => samePath(entry.path, a.path))) {
      await removeWorktree({ repoRoot: a.repoRoot, path: a.path, force: true }, opts);
      await fs.rmdir(a.path).catch(() => undefined);
    }
    if (await pathExists(a.path)) {
      throw new GitError(`'${a.path}' already exists`, "PathExists", "", ["worktree", "add", a.path]);
    }
  }

  const args = ["worktree", "add"];
  // `--no-track` only exists since git 2.30, and an older git fails the whole
  // create with "unknown option". Branching from a raw SHA has no upstream to
  // inherit in the first place, so the flag is a no-op there and is left off —
  // which is the only case this extension actually produces.
  if (a.noTrack !== false && !/^[0-9a-f]{7,40}$/i.test(a.commitish)) {
    args.push("--no-track");
  }
  args.push("-b", a.branch, a.path, a.commitish);
  await git(args, withCwd(a.repoRoot, opts));
}

/** Remove a worktree. A worktree that is already gone is success, not failure. */
export async function removeWorktree(
  a: { repoRoot: string; path: string; force?: boolean },
  opts?: Partial<GitExecOptions>,
): Promise<void> {
  const args = ["worktree", "remove"];
  if (a.force) {
    args.push("--force");
  }
  args.push(a.path);
  try {
    await git(args, withCwd(a.repoRoot, opts));
  } catch (err) {
    // git never even started: the cwd is gone (repository moved, drive
    // unmounted, the parent worktree deleted). Nothing is left to remove, so
    // this is the same success as git's own "is not a working tree" — but only
    // once the repository really is missing, since the identical errno is what
    // a machine with no git installed reports.
    if (
      err instanceof GitError &&
      (err.errno === "ENOENT" || err.errno === "ENOTDIR") &&
      !(await pathExists(a.repoRoot))
    ) {
      return;
    }
    const stderr = err instanceof GitError ? err.stderr || err.message : String(err);
    if (/is not a working tree|No such file or directory|not a valid path|is not a valid directory/i.test(stderr)) {
      return;
    }
    throw err;
  }
}

export async function pruneWorktrees(repoRoot: string, opts?: Partial<GitExecOptions>): Promise<void> {
  await git(["worktree", "prune"], withCwd(repoRoot, opts));
}

export async function deleteBranch(
  repoRoot: string,
  branch: string,
  force: boolean,
  opts?: Partial<GitExecOptions>,
): Promise<void> {
  await git(["branch", force ? "-D" : "-d", branch], withCwd(repoRoot, opts));
}

/**
 * Commits on `head` that `base` does not have, and vice versa.
 *
 * `rev-list --left-right --count base...head` prints "<left>\t<right>": the
 * left side is what only `base` has (we are behind by that many), the right is
 * what only `head` has (ahead).
 */
export async function aheadBehind(
  repoRoot: string,
  base: string,
  head: string,
  opts?: Partial<GitExecOptions>,
): Promise<{ ahead: number; behind: number }> {
  try {
    const { stdout } = await git(
      ["rev-list", "--left-right", "--count", `${base}...${head}`, "--"],
      withCwd(repoRoot, opts),
    );
    const [behind, ahead] = stdout.trim().split(/\s+/).map((n) => Number.parseInt(n, 10));
    if (!Number.isFinite(ahead) || !Number.isFinite(behind)) {
      return { ahead: 0, behind: 0 };
    }
    return { ahead: ahead!, behind: behind! };
  } catch {
    // An unborn or unrelated ref is not worth surfacing: callers only use this
    // to decide how loud a deletion prompt should be.
    return { ahead: 0, behind: 0 };
  }
}

/** git's empty tree, so a repository without a first commit can still be diffed. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

function countLines(stdout: string): string[] {
  return stdout.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

/**
 * Is there uncommitted work in this worktree?
 *
 * Plumbing rather than `git status --porcelain` (the trick is from crystal):
 * refresh the index once, then ask three cheap questions. On a big repository
 * this is the difference between a snappy board and a stuttering one.
 */
export async function isDirty(
  worktreePath: string,
  opts?: Partial<GitExecOptions>,
): Promise<{ dirty: boolean; untracked: number; modified: number; ignored: number; known: boolean }> {
  // A worktree whose directory is gone has nothing left to lose; reporting it
  // clean is what makes "delete" quiet instead of scary.
  if (!(await pathExists(worktreePath))) {
    return { dirty: false, untracked: 0, modified: 0, ignored: 0, known: true };
  }
  const exec = (args: string[]) => git(args, withCwd(worktreePath, opts));
  // A read that fails says nothing about the worktree, and reporting "clean"
  // for it would delete uncommitted work without asking. Callers get `known`
  // and can treat the unknown case as "confirm, then force".
  let known = true;
  const attempt = async (args: string[]) => {
    try {
      return await exec(args);
    } catch {
      known = false;
      return undefined;
    }
  };

  // Clears the "stat is newer" false positives; it exits non-zero when it finds
  // real changes, which is exactly what the next two calls report properly.
  await exec(["update-index", "--refresh", "--ignore-submodules"]).catch(() => undefined);

  const changed = new Set<string>();
  const unstaged = await attempt(["diff-files", "--name-only", "--ignore-submodules"]);
  for (const file of countLines(unstaged?.stdout ?? "")) {
    changed.add(file);
  }

  let staged = await exec(["diff-index", "--cached", "--name-only", "--ignore-submodules", "HEAD"]).catch(
    () => undefined,
  );
  if (!staged) {
    // A repository without a first commit has no HEAD to diff against; the
    // empty tree is the equivalent question there, and only its failure counts.
    staged = await attempt(["diff-index", "--cached", "--name-only", "--ignore-submodules", EMPTY_TREE]);
  }
  for (const file of countLines(staged?.stdout ?? "")) {
    changed.add(file);
  }

  const others = await attempt(["ls-files", "--others", "--exclude-standard"]);
  const untracked = countLines(others?.stdout ?? "").length;

  // Ignored files count as loss too: `node_modules` is replaceable, but the
  // `.env` a setup script wrote next to it is not, and `git worktree remove`
  // deletes the whole directory either way.
  const ignoredOut = await attempt(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory"]);
  const ignored = countLines(ignoredOut?.stdout ?? "").length;

  return { dirty: changed.size > 0 || untracked > 0, untracked, modified: changed.size, ignored, known };
}

/**
 * Turn a branch name into a directory name: "omp/feat-a" → "feat-a".
 *
 * Slashes would create nested directories and anything outside
 * `[A-Za-z0-9._-]` is a portability hazard (colons and backslashes are illegal
 * on Windows), so both collapse to "-".
 */
export function branchToDirName(branch: string, stripPrefix?: string): string {
  let name = branch.trim();
  if (stripPrefix && name.startsWith(stripPrefix)) {
    name = name.slice(stripPrefix.length);
  }
  name = name
    .replace(/[\\/]+/g, "-")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+/, "")
    .replace(/[-.]+$/, "");
  return name || "workspace";
}

/**
 * Where worktrees live by default: `<repoParent>/<repoName>.worktrees`, the
 * layout vscode's git extension uses. Outside the repository on purpose — a
 * worktree nested inside its own checkout shows up as untracked files in every
 * diff and in every agent's file listing.
 */
export function defaultWorktreeDir(repoRoot: string, baseDirSetting?: string): string {
  const configured = baseDirSetting?.trim();
  if (configured) {
    const expanded =
      configured === "~" || configured.startsWith(`~${path.sep}`) || configured.startsWith("~/")
        ? path.join(os.homedir(), configured.slice(1))
        : configured;
    return path.resolve(repoRoot, expanded);
  }
  return path.join(path.dirname(repoRoot), `${path.basename(repoRoot)}.worktrees`);
}

/** `candidate`, or `candidate-2`, `candidate-3` … until one is free. */
export function uniquePath(candidate: string, exists: (p: string) => boolean): string {
  if (!exists(candidate)) {
    return candidate;
  }
  for (let counter = 2; counter < 10_000; counter++) {
    const next = `${candidate}-${counter}`;
    if (!exists(next)) {
      return next;
    }
  }
  throw new Error(`No free path next to ${candidate}`);
}

const repoLocks = new Map<string, Promise<void>>();

/**
 * Serialize work per repository (named mutex, adapted from crystal).
 *
 * Two `git worktree add` runs against the same repository race on
 * `.git/worktrees` and on branch creation, and a board that creates several
 * workspaces at once would hit that regularly. The timeout is a deadlock
 * escape hatch: a lost release must not freeze the feature until reload.
 */
export async function withRepoLock<T>(repoRoot: string, fn: () => Promise<T>, timeoutMs = 60_000): Promise<T> {
  // Keyed on the canonical path so that two spellings of one repository (the
  // `/tmp` vs `/private/tmp` symlink on macOS, a drive letter in either case on
  // Windows) cannot hand out two locks for the same `.git`.
  const resolved = await canonicalPath(repoRoot);
  const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const start = Date.now();

  while (repoLocks.has(key)) {
    const held = repoLocks.get(key)!;
    const remaining = timeoutMs - (Date.now() - start);
    if (remaining <= 0) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for the repository lock on ${repoRoot}`);
    }
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([held, new Promise<void>((resolve) => (timer = setTimeout(resolve, remaining)))]);
    if (timer) {
      clearTimeout(timer);
    }
  }

  let release!: () => void;
  const holder = new Promise<void>((resolve) => (release = resolve));
  repoLocks.set(key, holder);
  try {
    return await fn();
  } finally {
    if (repoLocks.get(key) === holder) {
      repoLocks.delete(key);
    }
    release();
  }
}
