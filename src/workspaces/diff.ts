/*! Portions derived from stravu/crystal (main/src/services/gitDiffManager.ts), MIT, Copyright (c) 2024 Stravu.
 *  Adapted for OMP Code. */

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { GitError, classifyGitError, git } from "./git.ts";

/**
 * What one agent's worktree changed, measured against the SHA its workspace was
 * created at.
 *
 * Two rules shape everything here:
 *
 *  - **Nothing may mutate the worktree.** The agent is still working in it. The
 *    obvious way to see its new files — `git add -N .` — writes to that live
 *    index, so it is off the table; untracked files are counted separately
 *    instead (see {@link workspaceDiff}). Every git call here also carries
 *    `--no-optional-locks`: without it a plain `git diff` opportunistically
 *    refreshes the index's stat cache, which takes `index.lock` and rewrites
 *    `.git/index` — and the watcher recount below runs often enough to race
 *    the agent's own git commands into "Unable to create '…/index.lock'".
 *  - **The base is a SHA, never a branch name.** `main` keeps moving while the
 *    agent works, and diffing against a moving base repaints files the agent
 *    never touched as "changed". `WorkspaceRecord.baseSha` pins it.
 *
 * Deliberately free of `vscode`, like the rest of `src/workspaces/`: the parsers
 * below are the interesting part and they are unit-tested with plain
 * `node --test`.
 */

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "untracked";

export interface FileChange {
  /** POSIX-relative to the worktree root, exactly as git spells it under `-z`. */
  path: string;
  /** The name the file had in the base, present only for `renamed`. */
  oldPath?: string;
  status: ChangeStatus;
  added: number;
  deleted: number;
  binary: boolean;
}

export interface WorkspaceDiff {
  /** Sorted by directory, then by file name. */
  files: FileChange[];
  added: number;
  deleted: number;
  /** True when `files` was cut down to `maxFiles`; the totals still count all of them. */
  truncated: boolean;
}

/** git's own binary heuristic: a NUL anywhere in the first 8000 bytes. */
const BINARY_PEEK_BYTES = 8000;

/** Above this an untracked file is counted by streaming rather than read whole. */
const INLINE_READ_BYTES = 4 * 1024 * 1024;

const STREAM_CHUNK_BYTES = 64 * 1024;

const DEFAULT_MAX_FILES = 500;

const DEFAULT_MAX_DIFF_BYTES = 1024 * 1024;

const LF = 0x0a;

/**
 * Parse the NUL-separated output of `git diff --numstat -z`.
 *
 * The `-z` form has two record shapes, both verified against git 2.50:
 *
 *   ordinary   `"12\t3\tsrc/a.ts"` NUL
 *   renamed    `"12\t3\t"` NUL `"old/name.ts"` NUL `"new name.ts"` NUL
 *
 * — that is, a rename leaves the path slot of the first field *empty* and spends
 * two further NUL-separated fields on the old and new names. Binary files come
 * through as `"-\t-\tblob.png"`: git cannot count lines it does not read.
 *
 * Under `-z` git never quotes or escapes a path, so a name with spaces or
 * non-ASCII arrives verbatim and needs no unescaping — which is precisely why
 * this layer uses `-z` everywhere instead of the friendlier default output.
 *
 * numstat carries counts but not statuses, so every non-rename record comes out
 * as `modified`; {@link workspaceDiff} overlays the real status from a
 * `--name-status` pass. A record it cannot make sense of is skipped rather than
 * guessed at — a half-understood diff is worse than a short one.
 */
export function parseNumstatZ(out: string): FileChange[] {
  const fields = out.split("\0");
  const changes: FileChange[] = [];

  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    if (!field) {
      // The final NUL leaves an empty tail field, and a truncated read can too.
      continue;
    }
    // Split on the first two tabs only: everything after them is the path, and a
    // path is allowed to contain tabs of its own.
    const firstTab = field.indexOf("\t");
    if (firstTab < 0) {
      continue;
    }
    const secondTab = field.indexOf("\t", firstTab + 1);
    if (secondTab < 0) {
      continue;
    }
    const addedRaw = field.slice(0, firstTab);
    const deletedRaw = field.slice(firstTab + 1, secondTab);
    const binary = addedRaw === "-" || deletedRaw === "-";
    const added = binary ? 0 : Number.parseInt(addedRaw, 10);
    const deleted = binary ? 0 : Number.parseInt(deletedRaw, 10);
    if (!Number.isFinite(added) || !Number.isFinite(deleted)) {
      continue;
    }

    const rest = field.slice(secondTab + 1);
    if (rest.length > 0) {
      changes.push({ path: rest, status: "modified", added, deleted, binary });
      continue;
    }

    // Rename: the two names live in the next two fields. Either being absent —
    // or empty, which is what the tail of a stream cut mid-record looks like —
    // means the output stopped short, and there is nothing sensible left to read.
    const oldPath = fields[i + 1];
    const newPath = fields[i + 2];
    if (!oldPath || !newPath) {
      break;
    }
    i += 2;
    changes.push({ path: newPath, oldPath, status: "renamed", added, deleted, binary });
  }

  return changes;
}

/**
 * Parse `git diff --name-status -z`: `"M"` NUL `"path"` NUL, with renames and
 * copies carrying a similarity score (`R100`) and spending two path fields.
 *
 * Only the statuses are wanted; the counts come from numstat.
 */
function parseNameStatusZ(out: string): Map<string, ChangeStatus> {
  const statuses = new Map<string, ChangeStatus>();
  const fields = out.split("\0");

  for (let i = 0; i < fields.length; i++) {
    const code = fields[i]!;
    if (!code) {
      continue;
    }
    const letter = code[0]!;
    // R and C spend two path fields (old, new); everything else spends one.
    const renameLike = letter === "R" || letter === "C";
    const first = fields[i + 1];
    if (first === undefined) {
      break;
    }
    if (renameLike) {
      const second = fields[i + 2];
      if (second === undefined) {
        break;
      }
      i += 2;
      // A copy is a brand-new file in the base's eyes, so it reads as "added";
      // only a true rename keeps its old name on screen.
      statuses.set(second, letter === "R" ? "renamed" : "added");
      continue;
    }
    i += 1;
    statuses.set(first, letterToStatus(letter));
  }

  return statuses;
}

function letterToStatus(letter: string): ChangeStatus {
  switch (letter) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    // T (type change, file ↔ symlink) and U (unmerged) are both "the content is
    // not what the base had", which is what `modified` means to a reviewer.
    default:
      return "modified";
  }
}

/**
 * Lines in a blob of text, the way a diff counts them: a file with no trailing
 * newline still ends in a line, and an empty file has none at all.
 */
export function countLines(content: string): number {
  if (content.length === 0) {
    return 0;
  }
  let lines = 0;
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === LF) {
      lines++;
    }
  }
  // Anything after the last newline is a final, unterminated line.
  if (content.charCodeAt(content.length - 1) !== LF) {
    lines++;
  }
  return lines;
}

export function summarize(files: FileChange[]): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;
  for (const file of files) {
    added += file.added;
    deleted += file.deleted;
  }
  return { added, deleted };
}

export interface DiffOptions {
  maxFiles?: number;
  signal?: AbortSignal;
}

/**
 * Sort by directory first, then by file name, so a review reads folder by
 * folder. Compared by code unit rather than by locale: the order has to be the
 * same on every machine, or a cached tree and a fresh one disagree.
 */
function compareChanges(a: FileChange, b: FileChange): number {
  const dirA = path.posix.dirname(a.path);
  const dirB = path.posix.dirname(b.path);
  if (dirA !== dirB) {
    return dirA < dirB ? -1 : 1;
  }
  const nameA = path.posix.basename(a.path);
  const nameB = path.posix.basename(b.path);
  if (nameA === nameB) {
    return 0;
  }
  return nameA < nameB ? -1 : 1;
}

/** git reports POSIX separators under `-z`; callers may not. */
function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join("/").replace(/^\.\//, "");
}

/**
 * Everything this worktree changed since `baseSha`, tracked and untracked.
 *
 * Three reads, deliberately sequential:
 *
 *  1. `--numstat -z` — the counts for tracked files (staged and unstaged both,
 *     since diffing against a commit compares the working tree to it).
 *  2. `--name-status -z` — the statuses numstat cannot express.
 *  3. `ls-files --others --exclude-standard -z` — the files the agent created,
 *     which are invisible to `git diff` until something adds them to the index.
 *     Adding them is exactly what we refuse to do, so their line counts are read
 *     off the filesystem instead.
 *
 * Sequential because `git diff` opportunistically refreshes the index's stat
 * cache, and two of them racing for `index.lock` would fail for no reason.
 * The worktree keeps changing under all three anyway — an agent is writing to
 * it — so a status without a matching count simply falls back to `modified`
 * rather than being treated as an inconsistency worth reporting.
 */
export async function workspaceDiff(
  worktreePath: string,
  baseSha: string,
  opts?: DiffOptions,
): Promise<WorkspaceDiff> {
  const maxFiles = opts?.maxFiles ?? DEFAULT_MAX_FILES;
  const exec = (args: string[]) => git(args, { cwd: worktreePath, signal: opts?.signal });

  const numstat = await exec(["--no-optional-locks", "diff", "--numstat", "-z", "--find-renames", baseSha, "--"]);
  const files = parseNumstatZ(numstat.stdout);

  const nameStatus = await exec(["--no-optional-locks", "diff", "--name-status", "-z", "--find-renames", baseSha, "--"]);
  const statuses = parseNameStatusZ(nameStatus.stdout);
  for (const file of files) {
    const status = statuses.get(file.path);
    if (status) {
      file.status = status;
    }
  }

  const seen = new Set(files.map((file) => file.path));
  const others = await exec(["--no-optional-locks", "ls-files", "--others", "--exclude-standard", "-z"]);
  for (const relative of others.stdout.split("\0")) {
    if (!relative || seen.has(relative)) {
      // A path can be both: `git rm --cached` leaves a tracked deletion and an
      // untracked file of the same name. The tracked record is the truthful one.
      continue;
    }
    const stats = await untrackedStats(path.join(worktreePath, relative));
    if (!stats) {
      // Gone between the listing and the read — a build artifact, most likely.
      continue;
    }
    seen.add(relative);
    files.push({
      path: relative,
      status: "untracked",
      added: stats.added,
      deleted: 0,
      binary: stats.binary,
    });
  }

  files.sort(compareChanges);
  // Totals are taken before the cut so the board's "+N −M" stays truthful even
  // when the list shown is only the first `maxFiles` of it.
  const totals = summarize(files);
  const truncated = files.length > maxFiles;

  return {
    files: truncated ? files.slice(0, maxFiles) : files,
    added: totals.added,
    deleted: totals.deleted,
    truncated,
  };
}

/**
 * Line count and binary-ness of an untracked file, without holding it in memory.
 *
 * Binary detection copies git's own rule (a NUL in the first 8000 bytes) so the
 * flag means the same thing here as it does on the tracked side. A large text
 * file is counted by streaming: an agent that dumps a 200 MB log into its
 * worktree must not take the extension host down with it.
 *
 * `undefined` means the entry is not a countable file any more — deleted since
 * the listing, or a symlink to a directory.
 */
async function untrackedStats(absolutePath: string): Promise<{ added: number; binary: boolean } | undefined> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(absolutePath, "r");
  } catch {
    return undefined;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      return undefined;
    }

    const head = Buffer.alloc(BINARY_PEEK_BYTES);
    const { bytesRead } = await handle.read(head, 0, BINARY_PEEK_BYTES, 0);
    if (head.subarray(0, bytesRead).includes(0)) {
      return { added: 0, binary: true };
    }
    if (stat.size === 0) {
      return { added: 0, binary: false };
    }

    if (stat.size <= INLINE_READ_BYTES) {
      const buffer = await handle.readFile();
      return { added: countLines(buffer.toString("utf8")), binary: false };
    }

    const chunk = Buffer.alloc(STREAM_CHUNK_BYTES);
    let lines = 0;
    let position = 0;
    let lastByte = 0;
    for (;;) {
      const read = await handle.read(chunk, 0, STREAM_CHUNK_BYTES, position);
      if (read.bytesRead === 0) {
        break;
      }
      position += read.bytesRead;
      for (let i = 0; i < read.bytesRead; i++) {
        if (chunk[i] === LF) {
          lines++;
        }
      }
      lastByte = chunk[read.bytesRead - 1]!;
    }
    if (position > 0 && lastByte !== LF) {
      lines++;
    }
    return { added: lines, binary: false };
  } catch {
    return undefined;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * A unified diff of one file against the base, ready to drop into an editor.
 *
 * An untracked file has no base side at all, so it is diffed against
 * `/dev/null` with `--no-index` — which reports "these differ" as **exit 1**,
 * the normal outcome here rather than a failure (see {@link runGitTolerant}).
 *
 * A rename is diffed under its new name only. Pathspec-limited rename detection
 * needs both names on the command line and the contract passes one, so the new
 * file reads as added — verbose, but never wrong.
 *
 * No in-tree caller: the review UI builds its diffs from
 * `BaseContentProvider` + a file URI, which is what gives it VS Code's own
 * diff editor. This is part of the module's published API and is covered by
 * `test/workspaceDiff.test.ts`; do not go looking for the product code that
 * uses it.
 */
export async function fileDiff(
  worktreePath: string,
  baseSha: string,
  filePath: string,
  opts?: { maxBytes?: number },
): Promise<string> {
  const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_DIFF_BYTES;
  const relative = toPosix(filePath);

  if (await isTracked(worktreePath, relative)) {
    const { stdout } = await git(["--no-optional-locks", "diff", "--find-renames", baseSha, "--", relative], { cwd: worktreePath });
    return truncateDiff(stdout, maxBytes);
  }

  const result = await runGitTolerant(["--no-optional-locks", "diff", "--no-index", "--", "/dev/null", relative], worktreePath, [0, 1]);
  return truncateDiff(result.stdout, maxBytes);
}

/**
 * Is git tracking this path? Asked with `ls-files`, which still answers yes for
 * a file deleted from the working tree but present in the index — the case that
 * separates "the agent removed a file" from "the agent created one".
 */
async function isTracked(worktreePath: string, relativePath: string): Promise<boolean> {
  const { stdout } = await git(["--no-optional-locks", "ls-files", "-z", "--", relativePath], { cwd: worktreePath });
  return stdout.replace(/\0/g, "").length > 0;
}

/**
 * Cut an oversized diff, always on a line boundary — which also guarantees the
 * cut never lands inside a multi-byte character, since a newline is its own
 * byte. The marker is left in English on purpose: it sits inside git's own
 * untranslated output, where a localised line would read as part of the diff.
 */
function truncateDiff(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) {
    return text;
  }
  let cut = buffer.lastIndexOf(LF, maxBytes - 1);
  if (cut < 0) {
    cut = maxBytes - 1;
  }
  const head = buffer.subarray(0, cut + 1).toString("utf8");
  return `${head}*** diff truncated at ${cut + 1} of ${buffer.length} bytes ***\n`;
}

/**
 * The file's contents in the base commit, or `undefined` when the base had no
 * such file (added, or untracked) — which is how a diff editor is told to draw
 * an empty left-hand side.
 *
 * Only git's two "no such path in that tree" wordings are swallowed. A base SHA
 * that has been garbage-collected away, or a worktree that is gone, is a real
 * failure and has to reach the caller.
 */
export async function baseContent(
  worktreePath: string,
  baseSha: string,
  filePath: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await git(["--no-optional-locks", "show", `${baseSha}:${toPosix(filePath)}`], { cwd: worktreePath });
    return stdout;
  } catch (err) {
    const stderr = err instanceof GitError ? err.stderr || err.message : String(err);
    if (/does not exist in|exists on disk, but not in/i.test(stderr)) {
      // Verified against git 2.50: `git show` blames the *path* even when the
      // revision is the missing half — a garbage SHA produces the identical
      // "path 'x' exists on disk, but not in '<sha>'". So the base has to be
      // confirmed separately, or a garbage-collected baseSha would quietly turn
      // every file in the review into "added".
      await git(["cat-file", "-e", `${baseSha}^{commit}`], { cwd: worktreePath });
      return undefined;
    }
    throw err;
  }
}

/**
 * Run git where a non-zero exit is an answer, not an error.
 *
 * `git()` in `./git.ts` rejects on any non-zero exit and keeps only stderr,
 * which is right for every command that layer runs. `git diff --no-index` is
 * the exception the whole review feature depends on: it signals "the files
 * differ" with exit 1 and puts the diff — the thing we came for — on stdout.
 * Rather than loosen the shared helper for one caller, this module runs that
 * command itself, mirroring the same locale and prompt hardening so error
 * classification keeps working.
 */
function runGitTolerant(
  args: string[],
  cwd: string,
  okExitCodes: number[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: {
        ...process.env,
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
      const errno = (err as NodeJS.ErrnoException).code;
      reject(new GitError(err.message, classifyGitError(err.message), stderr || err.message, args, errno));
    });

    child.once("close", (code) => {
      const exit = code ?? -1;
      if (okExitCodes.includes(exit)) {
        resolve({ stdout, stderr, code: exit });
        return;
      }
      const lines = (stderr.trim() || `git ${args[0] ?? ""} failed`).split(/\r?\n/);
      const message = lines.find((line) => /^\s*(fatal|error):/i.test(line))?.trim() ?? lines[0]!;
      reject(new GitError(message, classifyGitError(stderr), stderr, args));
    });
  });
}
