/*! Portions derived from stravu/crystal (main/src/services/worktreeManager.ts), MIT, Copyright (c) 2024 Stravu.
 *  Portions derived from microsoft/vscode (extensions/git/src/git.ts), MIT, Copyright (c) Microsoft Corporation.
 *  Adapted for OMP Code. */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { t } from "../l10n.ts";
import {
  GitError,
  aheadBehind,
  classifyGitError,
  git,
  isDirty,
  revParse,
  withRepoLock,
  type GitExecOptions,
} from "./git.ts";

/**
 * Landing one workspace's work on the base branch, and throwing one file away.
 *
 * This is the module that can destroy work, so every step below is ordered for
 * safety rather than convenience: look before touching anything, never rewrite
 * the base branch's history, and leave a trail (the returned `message`) naming
 * every mutation that happened.
 *
 * Deliberately free of `vscode`, like the rest of `src/workspaces/`, so the
 * dangerous half can be exercised against real repositories under
 * `node --test`.
 */

/**
 * `merge` keeps the workspace's own commits and records the join with a merge
 * commit (`--no-ff`); no history is rewritten anywhere. `squash` collapses the
 * workspace into a single commit on top of the base — which *does* rewrite the
 * workspace branch, but still never the base, because the base only ever moves
 * by fast-forward.
 */
export type MergeStrategy = "merge" | "squash";

export interface MergePreflight {
  /** Can we merge without the human having to decide something first? */
  ok: boolean;
  /** Why not; the most blocking condition when several hold at once. */
  reason?: "no-commits" | "conflicts" | "base-dirty" | "base-moved" | "branch-missing" | "worktree-dirty";
  conflictingFiles: string[];
  /** Commits on the workspace branch that the base does not have, and vice versa. */
  ahead: number;
  behind: number;
  /** `baseRef` no longer points at the SHA this workspace was branched from. */
  baseMoved: boolean;
  /** The main checkout has uncommitted work of its own. */
  baseDirty: boolean;
  /** The agent's worktree has uncommitted work. */
  worktreeDirty: boolean;
}

export interface MergeResult {
  merged: boolean;
  strategy: MergeStrategy;
  /** The base branch's new tip, when the merge happened. */
  commit?: string;
  conflictingFiles: string[];
  /**
   * What was done, or why nothing was — in every branch of this module it names
   * the mutations that actually happened, because a half-finished merge the
   * user cannot see is the worst outcome this file can produce.
   */
  message: string;
  /**
   * A stash entry was created from the main checkout during this merge. The
   * message says whether it was restored again; a failed `stash pop` leaves it
   * in the stash list and says so.
   */
  stashed: boolean;
}

/** git's own name for a merge that ran but could not be completed. */
const MERGE_TREE_CONFLICT_EXIT = 1;

/**
 * git, tolerating a non-zero exit.
 *
 * `git merge-tree --write-tree` answers "these two branches conflict" with exit
 * code 1 and puts the answer — the conflicting file names — on *stdout*. The
 * shared {@link git} helper turns any non-zero exit into a rejection that
 * carries stderr only, so the answer would be thrown away. Nothing else needs
 * this, so it stays private here instead of widening that helper's contract.
 *
 * The environment mirrors `git()` for the same reasons: English messages so the
 * patterns keep matching, and no prompt that an extension host cannot answer.
 */
function gitTolerant(
  args: string[],
  opts: GitExecOptions,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(opts.gitPath ?? "git", args, {
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
    // A spawn failure is still a failure: git missing, or the cwd gone.
    child.once("error", (err: Error) => reject(err));
    child.once("close", (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

const versions = new Map<string, Promise<{ major: number; minor: number }>>();

/**
 * git's version, cached per binary.
 *
 * `merge-tree --write-tree` only exists from 2.38 (2022); older gits need the
 * legacy three-argument form, which reports conflicts as diff markers in a
 * successful run. Asking once per session is cheap; asking per preflight would
 * double the process count of a board full of workspaces.
 */
async function gitVersion(gitPath = "git"): Promise<{ major: number; minor: number }> {
  let pending = versions.get(gitPath);
  if (!pending) {
    pending = (async () => {
      try {
        const { stdout } = await gitTolerant(["--version"], { cwd: process.cwd(), gitPath });
        const match = /(\d+)\.(\d+)/.exec(stdout);
        return { major: Number(match?.[1] ?? 0), minor: Number(match?.[2] ?? 0) };
      } catch {
        // Unknown version: assume old, so we take the path that works everywhere.
        return { major: 0, minor: 0 };
      }
    })();
    versions.set(gitPath, pending);
  }
  return pending;
}

/**
 * Undo git's `core.quotePath` escaping. We ask for it to be off, but a path
 * containing a newline or a quote is escaped regardless — it has to be, since
 * the output is line-based.
 */
function unquotePath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) {
    return value;
  }
  try {
    return JSON.parse(value) as string;
  } catch {
    return value.slice(1, -1);
  }
}

/**
 * `git merge-tree --write-tree --name-only A B` prints the OID of the merged
 * tree on the first line, then one conflicting path per line, then a blank line
 * and a human-readable "Auto-merging …/CONFLICT (…)" block. Only the middle
 * part is machine-readable, so parsing stops at the blank line.
 */
export function parseMergeTreeConflicts(stdout: string): string[] {
  const lines = stdout.split(/\r?\n/);
  const files: string[] = [];
  for (const line of lines.slice(1)) {
    if (line.trim() === "") {
      break;
    }
    files.push(unquotePath(line.replace(/\r$/, "")));
  }
  return files;
}

/**
 * The pre-2.38 form: `git merge-tree <base> <A> <B>` always exits 0 and prints
 * a combined diff. A file is in conflict when its section carries the familiar
 * `<<<<<<<` marker, and the section header names it three times (base/our/
 * their) — any one of them will do.
 */
export function parseLegacyMergeTreeConflicts(stdout: string): string[] {
  const files: string[] = [];
  let current: string | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    const header = /^\s+(?:base|our|their)\s+\d{6}\s+[0-9a-f]{7,64}\s+(.+)$/.exec(line);
    if (header) {
      current = unquotePath(header[1]!.trim());
      continue;
    }
    if (/^\+*<{7}/.test(line) && current && !files.includes(current)) {
      files.push(current);
    }
  }
  return files;
}

/**
 * Would merging `branch` into `baseRef` conflict, and where?
 *
 * Asked entirely in the object database — nothing is checked out, no index is
 * touched, and the agent's worktree keeps running undisturbed. Exit code 1 is
 * the *answer* ("they conflict"), not a failure, which is why this cannot go
 * through the throwing helper.
 */
async function conflictsBetween(
  repoRoot: string,
  baseRef: string,
  branch: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const version = await gitVersion();
  const modern = version.major > 2 || (version.major === 2 && version.minor >= 38);
  try {
    if (modern) {
      const result = await gitTolerant(
        // `core.quotePath=false` keeps non-ASCII paths readable; the parser
        // still un-escapes, because a newline in a path is escaped regardless.
        ["-c", "core.quotePath=false", "merge-tree", "--write-tree", "--name-only", baseRef, branch],
        { cwd: repoRoot, signal },
      );
      if (result.code === MERGE_TREE_CONFLICT_EXIT) {
        return parseMergeTreeConflicts(result.stdout);
      }
      if (result.code !== 0) {
        // Anything else (unknown ref, unrelated histories) is not a conflict we
        // can describe; the real merge will report it properly.
        return [];
      }
      return [];
    }
    const base = await git(["merge-base", baseRef, branch], { cwd: repoRoot, signal });
    const legacy = await gitTolerant(["merge-tree", base.stdout.trim(), baseRef, branch], {
      cwd: repoRoot,
      signal,
    });
    return parseLegacyMergeTreeConflicts(legacy.stdout);
  } catch {
    // A conflict probe that cannot run must not block a merge: the merge itself
    // still refuses to damage anything, and it reports conflicts exactly.
    return [];
  }
}

/**
 * Paths git left unmerged in this checkout's index, after a failed merge or
 * rebase.
 *
 * Deliberately takes no `AbortSignal`: this runs while cleaning up, and the
 * thing that most often makes cleanup necessary is the caller cancelling. An
 * aborted signal here would return an empty list and the user would be told
 * that nothing conflicted.
 */
async function unmergedFiles(cwd: string): Promise<string[]> {
  try {
    const { stdout } = await gitTolerant(
      ["diff", "--name-only", "--diff-filter=U", "-z", "--"],
      { cwd },
    );
    return stdout.split("\0").filter((name) => name.length > 0);
  } catch {
    return [];
  }
}

/**
 * Which branch is checked out in a worktree.
 *
 * `known: false` means the question could not be asked at all (the directory is
 * gone) — different from "asked, and it is detached", which is `known: true`
 * with no branch. Callers act on the two differently: a missing worktree only
 * blocks the steps that would write in it, a detached HEAD blocks everything.
 */
async function worktreeBranch(
  worktreePath: string,
  signal?: AbortSignal,
): Promise<{ known: boolean; branch?: string }> {
  try {
    const { code, stdout } = await gitTolerant(["symbolic-ref", "--quiet", "--short", "HEAD"], {
      cwd: worktreePath,
      signal,
    });
    return code === 0 ? { known: true, branch: stdout.trim() } : { known: true };
  } catch {
    return { known: false };
  }
}

/** The stash tip, or undefined when the repository has no stash yet. */
async function stashTip(repoRoot: string, signal?: AbortSignal): Promise<string | undefined> {
  const { code, stdout } = await gitTolerant(["rev-parse", "--quiet", "--verify", "refs/stash"], {
    cwd: repoRoot,
    signal,
  });
  return code === 0 && stdout.trim() ? stdout.trim() : undefined;
}

/** Is `name` a branch in this repository (as opposed to a tag, a SHA or nothing)? */
async function isLocalBranch(repoRoot: string, name: string, signal?: AbortSignal): Promise<boolean> {
  const { code } = await gitTolerant(["rev-parse", "--quiet", "--verify", `refs/heads/${name}`], {
    cwd: repoRoot,
    signal,
  });
  return code === 0;
}

/**
 * Everything the merge needs to know before it is allowed to touch anything.
 *
 * Read-only by construction: not one call here writes to an index, a ref or a
 * working tree, so it is safe to run repeatedly while an agent is working.
 */
export async function preflight(
  a: { repoRoot: string; worktreePath: string; branch: string; baseRef: string; baseSha: string },
  opts?: { signal?: AbortSignal },
): Promise<MergePreflight> {
  const signal = opts?.signal;
  const empty: MergePreflight = {
    ok: false,
    conflictingFiles: [],
    ahead: 0,
    behind: 0,
    baseMoved: false,
    baseDirty: false,
    worktreeDirty: false,
  };

  if (!(await isLocalBranch(a.repoRoot, a.branch, signal))) {
    // Nothing else can be answered meaningfully without the branch, and every
    // later question would report a misleading zero.
    return { ...empty, reason: "branch-missing" };
  }

  const { ahead, behind } = await aheadBehind(a.repoRoot, a.baseRef, a.branch, { signal });
  const baseNow = await revParse(a.repoRoot, a.baseRef, { signal }).catch(() => "");
  // An unreadable base is not a moved base: saying "moved" for a ref we failed
  // to resolve would demand a confirmation for a question we never asked.
  const baseMoved = baseNow !== "" && baseNow !== a.baseSha;
  const baseDirty = (await isDirty(a.repoRoot, { signal })).dirty;
  const worktreeDirty = (await isDirty(a.worktreePath, { signal })).dirty;
  const conflictingFiles = await conflictsBetween(a.repoRoot, a.baseRef, a.branch, signal);

  // Most blocking first. Conflicts and "nothing to merge" are dead ends;
  // the three below them are consent points the caller may override.
  let reason: MergePreflight["reason"];
  if (conflictingFiles.length > 0) {
    reason = "conflicts";
  } else if (ahead === 0 && !worktreeDirty) {
    // Uncommitted work still counts as something to merge — it becomes a commit
    // in step 3 — so "no commits" only holds when the worktree is clean too.
    reason = "no-commits";
  } else if (worktreeDirty) {
    reason = "worktree-dirty";
  } else if (baseDirty) {
    reason = "base-dirty";
  } else if (baseMoved) {
    reason = "base-moved";
  }

  return {
    ok: reason === undefined,
    reason,
    conflictingFiles,
    ahead,
    behind,
    baseMoved,
    baseDirty,
    worktreeDirty,
  };
}

/**
 * Describe the merge in words, before anything happens.
 *
 * Pure on purpose: this is what the confirmation dialog shows, what the output
 * channel records, and what the tests can assert on without a repository. If
 * the steps here and the code in {@link mergeWorkspace} ever disagree, this is
 * the lie the user was told — so they are written side by side.
 *
 * `blockers` are the conditions that stop the merge (all of them, not just the
 * winning `reason`, so a dialog can list everything the user is consenting to);
 * `warnings` are consequences of going ahead.
 */
export function planMerge(
  p: MergePreflight,
  strategy: MergeStrategy,
): { steps: string[]; blockers: string[]; warnings: string[] } {
  const steps: string[] = [];
  if (p.worktreeDirty) {
    steps.push(t("Commit the uncommitted work in the worktree onto the workspace branch."));
  }
  if (p.baseDirty) {
    steps.push(t("Stash the uncommitted changes in the main checkout."));
  }
  // Named as a round trip because that is what the code does: the main
  // checkout is put back on whatever it was standing on before, so a stash
  // taken from another branch is restored onto that branch and not onto base.
  steps.push(t("Check out the base branch in the main checkout, then put it back on the branch it was on."));
  if (strategy === "squash") {
    steps.push(t("Rebase the workspace branch onto the base branch."));
    steps.push(t("Collapse the workspace commits into a single commit."));
    steps.push(t("Fast-forward the base branch onto it (--ff-only, so base history is never rewritten)."));
  } else {
    steps.push(t("Merge the workspace branch with a merge commit (--no-ff), keeping its history."));
  }
  if (p.baseDirty) {
    steps.push(t("Restore the stashed changes in the main checkout."));
  }

  const blockers: string[] = [];
  if (p.reason === "branch-missing") {
    blockers.push(t("The workspace branch no longer exists — there is nothing to merge."));
  }
  if (p.conflictingFiles.length > 0) {
    blockers.push(
      t(
        "{0} file(s) conflict with the base branch and have to be resolved by hand first: {1}",
        p.conflictingFiles.length,
        p.conflictingFiles.slice(0, 5).join(", "),
      ),
    );
  }
  if (p.reason === "no-commits") {
    blockers.push(t("The workspace has no commits of its own and nothing uncommitted."));
  }
  if (p.worktreeDirty) {
    blockers.push(
      t("The worktree has uncommitted changes; they will be committed onto the workspace branch first."),
    );
  }
  if (p.baseDirty) {
    blockers.push(
      t("The main checkout has uncommitted changes; they will be stashed and restored afterwards."),
    );
  }
  if (p.baseMoved) {
    blockers.push(
      t("The base branch has moved since this workspace was created — the reviewed diff is against the older base."),
    );
  }

  const warnings: string[] = [];
  if (p.worktreeDirty) {
    warnings.push(t("Committing the worktree is the only change made inside the agent's worktree."));
  }
  if (strategy === "squash" && p.ahead > 1) {
    warnings.push(t("Squashing rewrites the workspace branch: its {0} commits become one.", p.ahead));
  }
  if (p.behind > 0) {
    warnings.push(t("The workspace branch is {0} commit(s) behind the base branch.", p.behind));
  }

  return { steps, blockers: p.ok ? [] : blockers, warnings };
}

/** Reasons a human can wave through; a conflict or a missing branch is not one. */
function isOverridable(reason: MergePreflight["reason"]): boolean {
  return reason === "worktree-dirty" || reason === "base-dirty" || reason === "base-moved";
}

function describeGitError(err: unknown): string {
  if (err instanceof GitError) {
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Land a workspace on its base branch.
 *
 * The order of the steps below is the whole point of this function and is not
 * negotiable — each one exists because doing it later loses work:
 *
 *  1. take the repository lock (a second merge, or a workspace being created,
 *     would race on the index and on the refs),
 *  2. preflight, and refuse without touching anything when it says so,
 *  3. commit the worktree's uncommitted work *onto the workspace branch* —
 *     otherwise it simply is not part of what gets merged,
 *  4. stash the main checkout's own uncommitted work, so checkout and merge
 *     cannot refuse (or clobber) it,
 *  5. make sure the main checkout is actually on the base branch,
 *  6. merge (`--no-ff`) or rebase+squash+`--ff-only`; the base branch only ever
 *     moves forward, so its history can never be rewritten by this code,
 *  7. on conflict, collect the unmerged paths *before* aborting — the abort
 *     erases them,
 *  8. always try to restore the stash, and say so loudly when it fails.
 */
export async function mergeWorkspace(
  a: {
    repoRoot: string;
    worktreePath: string;
    branch: string;
    baseRef: string;
    baseSha: string;
    strategy: MergeStrategy;
    commitMessage?: string;
    force?: boolean;
  },
  opts?: { signal?: AbortSignal },
): Promise<MergeResult> {
  // 1) One merge at a time per repository.
  return withRepoLock(a.repoRoot, () => mergeLocked(a, opts));
}

async function mergeLocked(
  a: {
    repoRoot: string;
    worktreePath: string;
    branch: string;
    baseRef: string;
    baseSha: string;
    strategy: MergeStrategy;
    commitMessage?: string;
    force?: boolean;
  },
  opts?: { signal?: AbortSignal },
): Promise<MergeResult> {
  const signal = opts?.signal;
  const inRepo = (args: string[]) => git(args, { cwd: a.repoRoot, signal });
  const inWorktree = (args: string[]) => git(args, { cwd: a.worktreePath, signal });
  /**
   * Cleanup runs on no signal at all.
   *
   * Every rollback below exists because something went wrong, and the most
   * common "something" is the operator pressing Cancel — which aborts `signal`.
   * Sharing it would make `merge --abort`, `rebase --abort` and `stash pop`
   * reject at spawn time, leaving the repository mid-merge while we reported it
   * as untouched. Cleanup must not be cancellable by the thing that made
   * cleanup necessary.
   */
  const cleanupRepo = (args: string[]) => git(args, { cwd: a.repoRoot });
  const cleanupWorktree = (args: string[]) => git(args, { cwd: a.worktreePath });
  const strategy = a.strategy;

  // Set by step 3, the one write this module makes inside the agent's worktree.
  // `failed` reads it so that *every* refusal after that point still names the
  // mutation — a caller told "nothing changed" while the agent's branch grew a
  // commit is exactly the report this module must never produce.
  let committedWorktree = false;
  const failed = (message: string, conflictingFiles: string[] = []): MergeResult => ({
    merged: false,
    strategy,
    conflictingFiles,
    message: committedWorktree
      ? `${message} ${t("The worktree's uncommitted changes were committed onto {0} first.", a.branch)}`
      : message,
    stashed: false,
  });

  // Commit messages are not translated: they end up in the user's repository
  // history, where a machine-generated Russian line among English ones is worse
  // than a plain one, and they are read by tools long after the UI language
  // changed.
  const wipMessage = a.commitMessage ?? `omp: ${a.branch} work in progress`;
  const landMessage =
    a.commitMessage ??
    (strategy === "squash" ? `omp: ${a.branch}` : `omp: merge ${a.branch} into ${a.baseRef}`);

  // 2) Look before touching. A refusal here has changed nothing at all.
  const pre = await preflight(a, opts);
  if (!pre.ok && !(a.force === true && isOverridable(pre.reason))) {
    const { blockers } = planMerge(pre, strategy);
    return failed(
      t("Nothing was changed. {0}", blockers.join(" ")),
      pre.conflictingFiles,
    );
  }

  // Still nothing touched: the base has to be a local branch, because a merge
  // into a detached HEAD would advance no ref and the work would look lost.
  if (!(await isLocalBranch(a.repoRoot, a.baseRef, signal))) {
    return failed(
      t("Nothing was changed. The base {0} is not a local branch, so there is nothing to merge into.", a.baseRef),
    );
  }

  // The worktree has to be standing on its own branch, or step 3 and the squash
  // rebase would write onto whatever it *is* standing on. On a detached HEAD
  // that means a dangling commit: `merge --ff-only <branch>` then lands the
  // branch's older tip and reports success while the agent's work is reachable
  // from nothing. Neither `aheadBehind` (which measures the branch) nor
  // `isDirty` (which measures the worktree) can see this.
  const onBranch = await worktreeBranch(a.worktreePath, signal);
  const writesWorktree = pre.worktreeDirty || strategy === "squash";
  if (onBranch.known ? onBranch.branch !== a.branch : writesWorktree) {
    return failed(
      t(
        "Nothing was merged: {0} is not checked out in {1}, so its work would not land on the branch.",
        a.branch,
        a.worktreePath,
      ),
    );
  }

  const stashName = `ompcode-merge-${a.branch}`;
  let stashed = false;
  let popFailed = false;
  let popConflicted = false;
  /** Where the main checkout stood before step 5 moved it: a branch, or `HEAD` when detached. */
  let startedOn: string | undefined;
  let startedAt: string | undefined;
  let checkoutMoved = false;
  let checkoutStranded = false;
  const startedLabel = (): string =>
    (startedOn === "HEAD" ? startedAt?.slice(0, 8) : startedOn) ?? a.baseRef;

  /**
   * Put the main checkout back on the branch it was on.
   *
   * This has to happen *before* the stash is popped: the stash was taken from
   * that branch, and popping it while standing on the base would transplant the
   * user's uncommitted work onto a branch it does not belong to — silently, and
   * with a conflict whenever the merged content touches the same lines.
   */
  const restoreCheckout = async (): Promise<void> => {
    if (!checkoutMoved) {
      return;
    }
    checkoutMoved = false;
    const target = startedOn === "HEAD" ? startedAt : startedOn;
    if (!target) {
      return;
    }
    try {
      await cleanupRepo(["checkout", target]);
    } catch {
      // Do not pop now: the stash staying put is recoverable, work landing on
      // the wrong branch is not obvious enough to be.
      checkoutStranded = true;
    }
  };

  const restoreStash = async (): Promise<void> => {
    if (!stashed) {
      return;
    }
    if (checkoutStranded) {
      popFailed = true;
      return;
    }
    // Tolerant rather than throwing: a conflicting `git stash pop` prints
    // "CONFLICT (…)" and "The stash entry is kept…" on *stdout* and exits 1,
    // and the throwing helper only ever classifies stderr — so the difference
    // between "applied with conflicts" and "not applied at all" would be lost,
    // and those two need opposite advice.
    let popped: { code: number; stdout: string; stderr: string };
    try {
      popped = await gitTolerant(["stash", "pop"], { cwd: a.repoRoot });
    } catch {
      popFailed = true;
      return;
    }
    if (popped.code === 0) {
      return;
    }
    // Never swallowed: a stash left behind is uncommitted work the user cannot
    // see in their working tree any more, and they have to be told.
    popFailed = true;
    popConflicted = classifyGitError(`${popped.stdout}\n${popped.stderr}`) === "StashConflict";
  };

  /** Both halves of putting the main checkout back, in the only safe order. */
  const unwind = async (): Promise<void> => {
    await restoreCheckout();
    await restoreStash();
  };

  const withStashNote = (result: MergeResult): MergeResult => {
    result.stashed = stashed;
    const notes: string[] = [];
    if (checkoutStranded) {
      notes.push(
        t("The main checkout could not be put back on {0} and is left on {1}.", startedLabel(), a.baseRef),
      );
    }
    if (popFailed) {
      notes.push(
        popConflicted
          ? // The pop *did* apply, with markers, and kept the entry — telling
            // the user to pop again would either refuse or apply twice.
            t(
              "The main checkout's stashed changes came back with conflicts — resolve the markers in your working tree, then run `git stash drop` to remove the leftover entry {0}.",
              stashName,
            )
          : t(
              "The main checkout's uncommitted changes were not restored — they are still in the stash as {0}; run `git stash pop` to get them back.",
              stashName,
            ),
      );
    }
    if (notes.length > 0) {
      result.message = `${result.message} ${notes.join(" ")}`;
    }
    return result;
  };

  try {
    // 3) The agent's uncommitted work has to become a commit on its own branch,
    // or the merge simply would not carry it. This is the ONLY write this
    // module makes inside the agent's worktree, and it is always reported.
    if (pre.worktreeDirty) {
      try {
        await inWorktree(["add", "-A"]);
      } catch (err) {
        return failed(
          t("Nothing was merged: the worktree's changes could not be staged ({0}).", describeGitError(err)),
        );
      }
      const staged = (await inWorktree(["diff", "--cached", "--name-only", "HEAD", "--"])).stdout.trim();
      if (staged) {
        try {
          await inWorktree(["commit", "-m", wipMessage]);
          committedWorktree = true;
        } catch (err) {
          // `git add -A` already ran, so the worktree's index is staged. Saying
          // so is the honest report; silently resetting it would throw away
          // whatever the agent had staged on purpose.
          return failed(
            t(
              "Nothing was merged: the worktree's changes are staged but could not be committed ({0}).",
              describeGitError(err),
            ),
          );
        }
      }
    }

    // 4) The main checkout's own uncommitted work goes into a named stash, so
    // neither the checkout nor the merge can refuse or overwrite it.
    if (pre.baseDirty) {
      const before = await stashTip(a.repoRoot, signal);
      try {
        await inRepo(["stash", "push", "-u", "-m", stashName]);
      } catch (err) {
        return failed(
          t("Nothing was merged: the main checkout's changes could not be stashed ({0}).", describeGitError(err)),
        );
      }
      // `stash push` exits 0 with "No local changes to save" too, so the ref is
      // what decides whether there is anything to put back later.
      stashed = (await stashTip(a.repoRoot, signal)) !== before;
    }

    // 5) Merge into the base branch means standing on it — and, once we are
    // done, standing back where we found it. The main checkout may well be on
    // some other branch of the user's own, and both the stash we are holding
    // and the next commit they make belong to *that* branch.
    const head = (await inRepo(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    if (head !== a.baseRef) {
      startedOn = head;
      // `--abbrev-ref` answers a literal "HEAD" for a detached checkout, which
      // is not a ref anything can be checked out by; the SHA is.
      startedAt = (await inRepo(["rev-parse", "HEAD"])).stdout.trim();
      try {
        await inRepo(["checkout", a.baseRef]);
        checkoutMoved = true;
      } catch (err) {
        await unwind();
        return withStashNote(
          failed(
            t("Nothing was merged: {0} could not be checked out ({1}).", a.baseRef, describeGitError(err)),
          ),
        );
      }
    }

    // The base's tip before we touch it. Both `merge --no-ff` and
    // `merge --ff-only` answer "Already up to date." with exit 0 and an
    // unmoved HEAD, so comparing against this is the only way to tell a merge
    // that landed from one that did nothing.
    const baseBefore = (await inRepo(["rev-parse", "HEAD"])).stdout.trim();

    // 6) Land it.
    if (strategy === "squash") {
      // Crystal's ordering: rebase first, so the squashed commit sits directly
      // on top of the base and the final move can be a fast-forward. A conflict
      // here is discovered in the worktree, which we abort back to where it was.
      try {
        await inWorktree(["rebase", a.baseRef]);
      } catch (err) {
        // 7) Names first — `rebase --abort` erases the unmerged index.
        const conflicts = await unmergedFiles(a.worktreePath);
        const aborted = await cleanupWorktree(["rebase", "--abort"]).then(
          () => true,
          () => false,
        );
        await unwind();
        if (!aborted) {
          // A worktree left mid-rebase is the worst thing this path can do to
          // a still-running agent, so it is never reported as a clean refusal.
          return withStashNote(
            failed(
              t(
                "{0} could not be rebased onto {1}, and the rebase could not be aborted — {2} is left mid-rebase; run `git rebase --abort` there.",
                a.branch,
                a.baseRef,
                a.worktreePath,
              ),
              conflicts,
            ),
          );
        }
        return withStashNote(
          failed(
            conflicts.length > 0
              ? t("{0} could not be rebased onto {1}: {2} file(s) conflict.", a.branch, a.baseRef, conflicts.length)
              : t("{0} could not be rebased onto {1} ({2}).", a.branch, a.baseRef, describeGitError(err)),
            conflicts,
          ),
        );
      }

      const mergeBase = (await inWorktree(["merge-base", a.baseRef, "HEAD"])).stdout.trim();
      // `reset --soft` keeps every change in the index and only moves the branch
      // pointer back, so the single commit that follows contains exactly what
      // the branch had.
      await inWorktree(["reset", "--soft", mergeBase]);
      const staged = (await inWorktree(["diff", "--cached", "--name-only", "HEAD", "--"])).stdout.trim();
      if (staged) {
        await inWorktree(["commit", "-m", landMessage]);
      }

      try {
        // `--ff-only` is the guarantee: if the base moved under us, this refuses
        // rather than rewriting the base's history.
        await inRepo(["merge", "--ff-only", a.branch]);
      } catch (err) {
        await unwind();
        return withStashNote(
          failed(
            t(
              "{0} was squashed onto {1} in the worktree, but {1} could not be fast-forwarded to it ({2}). The base branch is unchanged.",
              a.branch,
              a.baseRef,
              describeGitError(err),
            ),
          ),
        );
      }
    } else {
      try {
        // `--no-ff` always records the join, so the workspace stays visible in
        // the base branch's history instead of silently becoming part of it.
        await inRepo(["merge", "--no-ff", a.branch, "-m", landMessage]);
      } catch (err) {
        // 7) Collect the conflicting names while the failed merge is still in
        // the index; `merge --abort` throws them away.
        const conflicts = await unmergedFiles(a.repoRoot);
        // An abort that itself fails leaves MERGE_HEAD and a conflicted index
        // behind, so it is reported rather than swallowed: "the base is
        // unchanged" would be a lie in exactly that case.
        const aborted = await cleanupRepo(["merge", "--abort"]).then(
          () => true,
          () => false,
        );
        await unwind();
        if (!aborted) {
          return withStashNote(
            failed(
              t(
                "{0} could not be merged into {1}, and the failed merge could not be aborted — {1} is left mid-merge; run `git merge --abort` in {2}.",
                a.branch,
                a.baseRef,
                a.repoRoot,
              ),
              conflicts,
            ),
          );
        }
        return withStashNote(
          failed(
            conflicts.length > 0
              ? t("{0} conflicts with {1} in {2} file(s); the merge was aborted and {1} is unchanged.", a.branch, a.baseRef, conflicts.length)
              : t("{0} could not be merged into {1} ({2}); {1} is unchanged.", a.branch, a.baseRef, describeGitError(err)),
            conflicts,
          ),
        );
      }
    }

    // The dangerous half is over. Everything below is bookkeeping, and it is
    // kept out of the outer catch's reach on purpose: a merge that has already
    // moved the base branch must never be reported as a failure just because
    // reading the new tip back did not work — that invites a retry of an
    // operation that already happened.
    let commit: string | undefined;
    try {
      commit = (await inRepo(["rev-parse", "HEAD"])).stdout.trim();
    } catch {
      commit = undefined;
    }

    if (commit !== undefined && commit === baseBefore) {
      // git exited 0 and moved nothing: the branch had no changes the base did
      // not already have (or the rebase turned them all into no-ops). Reporting
      // this as a merge would hand back a SHA that predates the operation and
      // then offer to delete the workspace.
      await unwind();
      return withStashNote(
        failed(
          strategy === "squash"
            ? t("Nothing was merged: {0} had no changes left after rebasing onto {1}.", a.branch, a.baseRef)
            : t("Nothing was merged: {1} already contains everything on {0}.", a.branch, a.baseRef),
        ),
      );
    }

    // 8) Put the main checkout back where it was, and its own work with it.
    await unwind();
    const parts = [
      commit === undefined
        ? t("{0} landed on {1}, but the new commit could not be read back.", a.branch, a.baseRef)
        : strategy === "squash"
          ? t("{0} was squashed onto {1} as {2}.", a.branch, a.baseRef, commit.slice(0, 8))
          : t("{0} was merged into {1} as {2}.", a.branch, a.baseRef, commit.slice(0, 8)),
    ];
    if (committedWorktree) {
      parts.push(t("The worktree's uncommitted changes were committed onto {0} first.", a.branch));
    }
    if (stashed && !popFailed) {
      parts.push(t("The main checkout's uncommitted changes were stashed and restored."));
    }
    return withStashNote({
      merged: true,
      strategy,
      commit,
      conflictingFiles: [],
      message: parts.join(" "),
      stashed,
    });
  } catch (err) {
    // Anything unforeseen — the caller cancelling mid-merge above all — can
    // leave a merge or a rebase half-applied. Undo whichever one this call
    // started before giving the stash back; an abort with nothing to abort
    // simply fails and is ignored.
    if (strategy === "merge") {
      await cleanupRepo(["merge", "--abort"]).catch(() => undefined);
    } else {
      await cleanupWorktree(["rebase", "--abort"]).catch(() => undefined);
    }
    await unwind();
    return withStashNote(failed(t("The merge failed: {0}", describeGitError(err))));
  }
}

/**
 * Throw one file's changes away, back to how the base had it.
 *
 * A file git never knew about cannot be checked out of anything, so it is
 * deleted; a file the base did not have is likewise removed rather than
 * restored. Everything else comes back from `baseSha` — the pinned base, not
 * the moving branch, so "discard" means "as the reviewer saw it".
 */
export async function discardWorkspaceFile(
  worktreePath: string,
  baseSha: string,
  filePath: string,
): Promise<void> {
  const exec = (args: string[]) => git(args, { cwd: worktreePath });
  // Paths travel as POSIX-relative; the filesystem wants the platform's shape.
  const absolute = path.join(worktreePath, ...filePath.split("/"));

  const tracked = await exec(["ls-files", "--error-unmatch", "--", filePath])
    .then(() => true)
    .catch(() => false);
  if (!tracked) {
    // `recursive` because `ls-files --others` names a whole untracked directory
    // when nothing inside it is tracked, and `rm` on a directory without it
    // throws EISDIR instead of discarding anything.
    await fs.rm(absolute, { force: true, recursive: true });
    return;
  }

  try {
    await exec(["checkout", baseSha, "--", filePath]);
  } catch (err) {
    const text = err instanceof GitError ? `${err.stderr}\n${err.message}` : String(err);
    if (/did not match any file|does not exist in|pathspec/i.test(text)) {
      // Tracked here, absent in the base — which is either a file the agent
      // created, or one it renamed. A rename has to bring the old name back
      // first: deleting the new path alone would destroy content that the base
      // still has under another name, and no stash or commit holds a copy.
      const oldPath = await renameSource(worktreePath, baseSha, filePath);
      if (oldPath !== undefined) {
        await exec(["checkout", baseSha, "--", oldPath]);
      }
      await exec(["rm", "--force", "--quiet", "--", filePath]);
      return;
    }
    throw err;
  }
}

/**
 * The path this file had in the base commit, when the change is a rename.
 *
 * `--name-status -z` emits a rename as three NUL-separated fields — `R<score>`,
 * the old path, the new one — against the two fields of every other status, so
 * the record shape itself is what identifies it.
 *
 * Asked exactly the way {@link workspaceDiff} asks it, and against the working
 * tree rather than the index, so this sees a rename in precisely the cases the
 * review row calls one. (git stops reporting a rename as soon as the new file
 * is also modified: it becomes a delete plus an add, and those are two rows the
 * reviewer discards separately.)
 */
async function renameSource(
  worktreePath: string,
  baseSha: string,
  filePath: string,
): Promise<string | undefined> {
  let stdout: string;
  try {
    ({ stdout } = await git(
      ["--no-optional-locks", "diff", "--name-status", "-z", "--find-renames", baseSha, "--"],
      { cwd: worktreePath },
    ));
  } catch {
    return undefined;
  }
  const fields = stdout.split("\0");
  for (let i = 0; i < fields.length; i += 1) {
    const status = fields[i];
    if (!status) {
      continue;
    }
    if (status.startsWith("R")) {
      const from = fields[i + 1];
      const to = fields[i + 2];
      i += 2;
      if (to === filePath && from) {
        return from;
      }
      continue;
    }
    // Every other status carries exactly one path.
    i += 1;
  }
  return undefined;
}
