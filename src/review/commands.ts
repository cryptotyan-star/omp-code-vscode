import * as path from "node:path";
import * as vscode from "vscode";
import { t } from "../l10n.ts";
import { workspaceDiff, type FileChange, type WorkspaceDiff } from "../workspaces/diff.ts";
import { samePath } from "../workspaces/git.ts";
import type { WorkspaceManager } from "../workspaces/manager.ts";
import {
  discardWorkspaceFile,
  mergeWorkspace,
  planMerge,
  preflight,
  type MergePreflight,
  type MergeResult,
  type MergeStrategy,
} from "../workspaces/merge.ts";
import type { WorkspaceRecord } from "../workspaces/types.ts";
import { BaseContentProvider } from "./baseContentProvider.ts";
import type { ReviewNode, ReviewProvider } from "./reviewProvider.ts";

/**
 * Every review command's user interface. `diff.ts` and `merge.ts` own the git
 * work and touch no VS Code API; this file owns the prompts, the progress and
 * the error surface, and holds no state beyond the diffs it reads on demand.
 *
 * The house rule for this file: a dialog names what is about to be lost or
 * changed before it happens. Merging into the base branch and discarding a
 * file are both unrecoverable from inside the editor, so neither is ever one
 * unlabelled click away.
 */

/** Branch marker, matched to the board and workspace rows. */
const BRANCH_MARK = "⎇";

/** Reads as "base compared with branch" in a diff title. */
const AGAINST_MARK = "⇄";

/**
 * `vscode.changes` opens every entry as a tab of its own. Fifty is already a
 * lot of tabs; past that the command stops being a review tool and starts
 * being a way to lock the window up, so the rest is reported instead.
 */
const MAX_MULTI_DIFF = 50;

/** How many file names a one-line notification carries before it summarises. */
const MAX_NAMES_INLINE = 8;

/**
 * Preflight failures the operator can genuinely take responsibility for:
 * `mergeWorkspace` knows how to commit a dirty worktree, stash a dirty base
 * and merge onto a base that has moved. `conflicts` is not on the list on
 * purpose — forcing past it produces a half-merged checkout that nothing in
 * this extension knows how to unwind. `no-commits` and `branch-missing` are
 * not overridable either: there is nothing to merge at all.
 */
const RECOVERABLE_REASONS: ReadonlySet<NonNullable<MergePreflight["reason"]>> = new Set([
  "base-dirty",
  "base-moved",
  "worktree-dirty",
]);

export interface ReviewCommandDeps {
  manager: WorkspaceManager;
  provider: ReviewProvider;
  output: { appendLine(s: string): void };
}

/**
 * What a command receives: a review tree node, a bare workspace id, a board
 * node, or nothing at all from the palette. Typed structurally on top of
 * `ReviewNode` so a board row — which carries `record` but not `kind: "file"` —
 * is accepted without this file importing the board.
 */
type ReviewCommandArg =
  | string
  | ReviewNode
  | { kind?: unknown; record?: WorkspaceRecord }
  | undefined;

export function registerReviewCommands(
  context: vscode.ExtensionContext,
  deps: ReviewCommandDeps,
): vscode.Disposable[] {
  // The caller owns the lifetime of what we return; nothing here outlives it.
  void context;
  const { manager, provider, output } = deps;

  return [
    vscode.commands.registerCommand("ompcode.review.openFile", async (arg?: ReviewCommandArg) => {
      // A row click carries its file. From the palette there is none, so the
      // command asks — first which workspace, then which of its changed files.
      const picked = fileNodeOf(arg) ?? (await pickFile(manager, arg));
      if (!picked) {
        return;
      }
      await openFileDiff(picked.record, picked.change);
    }),

    vscode.commands.registerCommand("ompcode.review.openAll", async (arg?: ReviewCommandArg) => {
      const record = await resolveWorkspace(manager, arg);
      if (!record) {
        return;
      }
      const diff = await readDiff(record);
      if (!diff) {
        return;
      }
      if (diff.files.length === 0) {
        void vscode.window.showInformationMessage(
          t("{0} has not changed anything yet.", record.name),
        );
        return;
      }
      const shown = diff.files.slice(0, MAX_MULTI_DIFF);
      await vscode.commands.executeCommand(
        "vscode.changes",
        // Composed rather than translated: every part is an identifier, so a
        // translation bundle would have nothing to say about it.
        `${record.name} (${record.baseRef} ${AGAINST_MARK} ${record.branch})`,
        shown.map((change) => [
          // [what the row is named after, left side, right side].
          fileUri(record, change.path),
          baseUri(record, change),
          currentUri(record, change),
        ]),
      );
      const hidden = diff.files.length - shown.length;
      if (hidden > 0) {
        void vscode.window.showWarningMessage(
          t("Showing {0} of {1} changed files — {2} more are not open.", shown.length, diff.files.length, hidden),
        );
      }
    }),

    vscode.commands.registerCommand("ompcode.review.discardFile", async (arg?: ReviewCommandArg) => {
      const picked = fileNodeOf(arg) ?? (await pickFile(manager, arg));
      if (!picked) {
        return;
      }
      const { record, change } = picked;
      // The confirmation spells out the two different things "discard" means:
      // an untracked file is deleted outright, a tracked one is rewound to the
      // base commit. Both are unrecoverable — nothing here goes to a stash.
      const untracked = change.status === "untracked";
      const confirm = untracked
        ? {
            message: t("Delete {0}?", change.path),
            detail: t(
              "It was never committed, so discarding it deletes the file from {0}. Its {1} lines are not recoverable.",
              record.name,
              change.added,
            ),
            ok: t("Delete file"),
          }
        : {
            message: t("Discard changes to {0}?", change.path),
            detail: change.oldPath
              ? t(
                  "{0} goes back to {1} as it was in {2}, undoing the rename and +{3} −{4}. This cannot be undone.",
                  change.path,
                  change.oldPath,
                  short(record.baseSha),
                  change.added,
                  change.deleted,
                )
              : t(
                  "{0} goes back to its content in {1}, losing +{2} −{3}. This cannot be undone.",
                  change.path,
                  short(record.baseSha),
                  change.added,
                  change.deleted,
                ),
            ok: t("Discard"),
          };
      const answer = await vscode.window.showWarningMessage(
        confirm.message,
        { modal: true, detail: confirm.detail },
        confirm.ok,
      );
      if (answer !== confirm.ok) {
        return;
      }
      try {
        await discardWorkspaceFile(record.worktreePath, record.baseSha, change.path);
      } catch (err) {
        output.appendLine(`[review] discard ${record.name}:${change.path} failed: ${describeError(err)}`);
        void vscode.window.showErrorMessage(
          t("Could not discard {0}: {1}", change.path, describeError(err)),
        );
        return;
      }
      output.appendLine(`[review] discarded ${change.path} in ${record.name}`);
      provider.refresh(record.id);
    }),

    vscode.commands.registerCommand("ompcode.review.merge", async (arg?: ReviewCommandArg) => {
      const record = await resolveWorkspace(manager, arg);
      if (!record) {
        return;
      }
      const strategy = await pickStrategy(record);
      if (!strategy) {
        return;
      }

      const pre = await runPreflight(record, output);
      if (!pre) {
        return;
      }
      const plan = planMerge(pre, strategy);
      const approved = await confirmMerge(record, pre, plan, strategy);
      if (approved === "cancel") {
        return;
      }
      if (approved === "show-diff") {
        await vscode.commands.executeCommand("ompcode.review.openAll", record.id);
        return;
      }

      const result = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: t("Merging {0} into {1}…", record.name, record.baseRef),
          cancellable: true,
        },
        async (_progress, token) => {
          // git is a child process; cancelling the notification has to reach it,
          // or "Cancel" would only hide the progress bar while the merge ran on.
          const controller = new AbortController();
          const sub = token.onCancellationRequested(() => controller.abort());
          try {
            return await mergeWorkspace(
              {
                repoRoot: record.repoRoot,
                worktreePath: record.worktreePath,
                branch: record.branch,
                baseRef: record.baseRef,
                baseSha: record.baseSha,
                strategy,
                force: approved === "force",
              },
              { signal: controller.signal },
            );
          } catch (err) {
            output.appendLine(`[review] merge ${record.branch} failed: ${describeError(err)}`);
            void vscode.window.showErrorMessage(
              t("Could not merge {0}: {1}", record.name, describeError(err)),
            );
            return undefined;
          } finally {
            sub.dispose();
          }
        },
      );
      if (!result) {
        return;
      }
      output.appendLine(
        `[review] merge ${record.branch} → ${record.baseRef} (${result.strategy}): ` +
          `${result.merged ? `merged ${result.commit ?? ""}` : "refused"} — ${result.message}` +
          (result.conflictingFiles.length ? ` [${result.conflictingFiles.join(", ")}]` : ""),
      );
      provider.refresh(record.id);

      if (!result.merged) {
        await reportRefusal(record, result.conflictingFiles, result.message);
        return;
      }
      await reportSuccess(manager, record, result, output);
    }),

    vscode.commands.registerCommand("ompcode.review.refresh", (arg?: ReviewCommandArg) => {
      // No node means the view's title button: refresh everything.
      provider.refresh(workspaceIdOf(arg));
    }),

    vscode.commands.registerCommand("ompcode.review.deleteLosers", async (arg?: ReviewCommandArg) => {
      const record = await resolveWorkspace(manager, arg);
      if (!record) {
        return;
      }
      // Only this repository's other workspaces: a second project's agents are
      // not "the losers" of this race, and offering them would be a trap.
      const others = manager
        .list()
        .filter((other) => other.id !== record.id && samePath(other.repoRoot, record.repoRoot));
      if (others.length === 0) {
        void vscode.window.showInformationMessage(
          t("{0} is the only workspace in this repository.", record.name),
        );
        return;
      }
      const picked = await vscode.window.showQuickPick(
        others.map((other) => ({
          label: other.name,
          description: `${BRANCH_MARK} ${other.branch}`,
          detail: other.worktreePath,
          record: other,
          picked: true,
        })),
        {
          title: t("Delete the other workspaces?"),
          placeHolder: t("Everything still ticked is deleted, branch and all"),
          canPickMany: true,
          ignoreFocusOut: true,
        },
      );
      if (!picked || picked.length === 0) {
        return;
      }
      // One confirmation for the whole batch, per the review flow: the manager's
      // own per-workspace prompt is suppressed with `force` below, so this
      // message has to carry the full loss on its own.
      const names = picked.map((item) => item.record.name).join(", ");
      // One is the common case — a two-agent race leaves exactly one loser — so
      // the singular gets its own string rather than "Delete 1 workspaces".
      const one = picked.length === 1;
      const ok = one ? t("Delete this workspace") : t("Delete {0} workspaces", picked.length);
      const answer = await vscode.window.showWarningMessage(
        one
          ? t("Delete {0} and its branch?", picked[0]!.record.name)
          : t("Delete {0} workspaces and their branches?", picked.length),
        {
          modal: true,
          detail: t(
            "{0}\n\nEach worktree is removed and its branch force-deleted. Any commit that lives only on those branches is gone — merge the one you want to keep first. Any chat still open for them is closed and its agent stopped, mid-turn or not.",
            names,
          ),
        },
        ok,
      );
      if (answer !== ok) {
        return;
      }
      const failed: string[] = [];
      for (const item of picked) {
        try {
          // force: the batch confirmation above already covered the loss, and a
          // second modal per workspace would train the operator to click through.
          await manager.remove(item.record.id, { deleteBranch: true, force: true });
        } catch (err) {
          failed.push(item.record.name);
          output.appendLine(`[review] delete ${item.record.name} failed: ${describeError(err)}`);
        }
      }
      const deleted = picked.length - failed.length;
      if (failed.length > 0) {
        void vscode.window.showErrorMessage(
          t("Deleted {0} workspaces; {1} could not be removed — see the OMP Code output.", deleted, failed.join(", ")),
        );
      } else {
        void vscode.window.showInformationMessage(
          deleted === 1 ? t("Deleted 1 workspace.") : t("Deleted {0} workspaces.", deleted),
        );
      }
    }),
  ];
}

/** Open one file side by side with its content in the workspace's base commit. */
async function openFileDiff(record: WorkspaceRecord, change: FileChange): Promise<void> {
  await vscode.commands.executeCommand(
    "vscode.diff",
    baseUri(record, change),
    currentUri(record, change),
    `${path.posix.basename(change.path)} (${record.baseRef} ${AGAINST_MARK} ${record.branch})`,
  );
}

/**
 * The left-hand side of every diff. A rename is compared against the path the
 * content had in the base commit, otherwise the left side would come back empty
 * and a moved file would read as "everything added".
 */
function baseUri(record: WorkspaceRecord, change: FileChange): vscode.Uri {
  return BaseContentProvider.uriFor(record, change.oldPath ?? change.path);
}

/**
 * The right-hand side. A file the agent deleted is not on disk, and a `file:`
 * URI for a missing path opens as an error pane rather than as an empty one —
 * so "deleted" is drawn with an empty virtual document instead.
 */
function currentUri(record: WorkspaceRecord, change: FileChange): vscode.Uri {
  return change.status === "deleted"
    ? BaseContentProvider.emptyUriFor(record, change.path)
    : fileUri(record, change.path);
}

/** `change.path` is POSIX-relative to the worktree; the file system needs both halves native. */
function fileUri(record: WorkspaceRecord, relPath: string): vscode.Uri {
  return vscode.Uri.file(path.join(record.worktreePath, ...relPath.split("/")));
}

/** Read a workspace's diff, reporting a failure rather than showing an empty list. */
async function readDiff(record: WorkspaceRecord): Promise<WorkspaceDiff | undefined> {
  try {
    return await workspaceDiff(record.worktreePath, record.baseSha);
  } catch (err) {
    void vscode.window.showErrorMessage(
      t("Could not read what {0} changed: {1}", record.name, describeError(err)),
    );
    return undefined;
  }
}

/** Preflight with its own progress: `merge-tree` on a big repository is not instant. */
async function runPreflight(
  record: WorkspaceRecord,
  output: { appendLine(s: string): void },
): Promise<MergePreflight | undefined> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: t("Checking whether {0} merges cleanly…", record.name),
    },
    async () => {
      try {
        return await preflight({
          repoRoot: record.repoRoot,
          worktreePath: record.worktreePath,
          branch: record.branch,
          baseRef: record.baseRef,
          baseSha: record.baseSha,
        });
      } catch (err) {
        output.appendLine(`[review] preflight ${record.branch} failed: ${describeError(err)}`);
        void vscode.window.showErrorMessage(
          t("Could not check {0} for conflicts: {1}", record.name, describeError(err)),
        );
        return undefined;
      }
    },
  );
}

/**
 * The one modal that stands between a click and a rewritten base branch. It
 * always lists the steps `merge.ts` will actually run, so the answer is given
 * with the plan in view rather than on trust.
 */
async function confirmMerge(
  record: WorkspaceRecord,
  pre: MergePreflight,
  plan: { steps: string[]; blockers: string[]; warnings: string[] },
  strategy: MergeStrategy,
): Promise<"go" | "force" | "show-diff" | "cancel"> {
  // An omp agent normally leaves its work uncommitted, so `worktree-dirty` is
  // the ordinary state of a workspace worth merging, not an obstacle. When
  // every reason is one the merge machinery clears by itself, the blockers are
  // billed as things it will handle — and the dialog asks rather than refuses.
  const recoverable = pre.reason !== undefined && RECOVERABLE_REASONS.has(pre.reason);

  const lines: string[] = [];
  if (plan.blockers.length > 0) {
    lines.push(recoverable ? t("First:") : t("In the way:"), ...plan.blockers.map((b) => `• ${b}`), "");
  }
  if (plan.warnings.length > 0) {
    lines.push(...plan.warnings.map((w) => `⚠ ${w}`), "");
  }
  lines.push(t("What this does:"), ...plan.steps.map((step, i) => `${i + 1}. ${step}`));
  const detail = lines.join("\n");

  if (pre.ok) {
    const ok = t("Merge");
    const answer = await vscode.window.showWarningMessage(
      t("Merge {0} into {1}?", record.branch, record.baseRef),
      { modal: true, detail },
      ok,
    );
    return answer === ok ? "go" : "cancel";
  }

  if (recoverable) {
    // "Cannot be merged as it stands" is kept for the dead ends below, so that
    // it still reads as a stop sign when it does appear.
    const ok = t("Merge anyway");
    const answer = await vscode.window.showWarningMessage(
      t("Merge {0} into {1}? It is not in a clean state.", record.branch, record.baseRef),
      { modal: true, detail },
      ok,
    );
    return answer === ok ? "force" : "cancel";
  }

  // A dead end: a conflict, nothing to merge, or no branch left. Only a
  // conflict has anything to offer, and a modal whose sole button is Cancel is
  // a dialog that cannot be answered — so the rest is said in a notification.
  const headline = t("{0} cannot be merged into {1} as it stands.", record.branch, record.baseRef);
  if (pre.conflictingFiles.length === 0) {
    void vscode.window.showWarningMessage(`${headline} ${plan.blockers.join(" ")}`);
    return "cancel";
  }
  const showDiff = t("Show diff");
  const answer = await vscode.window.showWarningMessage(
    headline,
    { modal: true, detail: appendConflicts(detail, pre.conflictingFiles) },
    showDiff,
  );
  return answer === showDiff ? "show-diff" : "cancel";
}

/** Which of the two histories the operator wants, worded by what it leaves behind. */
async function pickStrategy(record: WorkspaceRecord): Promise<MergeStrategy | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      {
        strategy: "merge" as const,
        label: t("Merge commit"),
        detail: t(
          "Every commit on {0} stays as it is, joined by one merge commit on {1}.",
          record.branch,
          record.baseRef,
        ),
      },
      {
        strategy: "squash" as const,
        label: t("Squash into one commit"),
        detail: t(
          "{0} is rebased onto {1} and lands as a single commit. Its own history is rewritten.",
          record.branch,
          record.baseRef,
        ),
      },
    ],
    { title: t("How should {0} land?", record.name), ignoreFocusOut: true },
  );
  return picked?.strategy;
}

/** A merge that did not happen: say which files stopped it, and offer to show them. */
async function reportRefusal(
  record: WorkspaceRecord,
  conflictingFiles: string[],
  message: string,
): Promise<void> {
  // `message` is never dropped, even when the conflict list already explains
  // the refusal: `merge.ts` appends the mutations that did happen to it — a
  // worktree that was committed, a stash still holding the operator's work —
  // and those are the parts nothing else in this dialog can say.
  const summary =
    conflictingFiles.length > 0
      ? `${t("{0} was not merged — {1} conflicts with {2}: {3}", record.name, record.branch, record.baseRef, listNames(conflictingFiles))} ${message}`
      : t("{0} was not merged: {1}", record.name, message);
  const showDiff = t("Show diff");
  const answer = await vscode.window.showWarningMessage(summary, showDiff);
  if (answer === showDiff) {
    await vscode.commands.executeCommand("ompcode.review.openAll", record.id);
  }
}

/**
 * A merge that happened. The two follow-ups are offered here rather than left
 * to the operator to find: the whole point of the race is that the losing
 * worktrees are meant to go away once a winner is in.
 */
async function reportSuccess(
  manager: WorkspaceManager,
  record: WorkspaceRecord,
  result: MergeResult,
  output: { appendLine(s: string): void },
): Promise<void> {
  // The body is `result.message` verbatim, never re-derived from `stashed`:
  // that flag is `true` both when the stash came back and when it did not, and
  // `merge.ts` is the only layer that knows which. Composing a cheerful line
  // here once told operators their uncommitted work had been restored while it
  // was sitting in a stash they had never been shown.
  const message = `${record.name}: ${result.message}`;
  const deleteThis = t("Delete this workspace");
  const deleteOthers = t("Delete the others");
  const answer = await vscode.window.showInformationMessage(message, deleteThis, deleteOthers);
  if (answer === deleteThis) {
    try {
      // No `force`: the manager still checks for work that the merge did not
      // take along — ignored files, or commits made after the preflight ran.
      await manager.remove(record.id, { deleteBranch: true });
    } catch (err) {
      output.appendLine(`[review] delete ${record.name} failed: ${describeError(err)}`);
      void vscode.window.showErrorMessage(
        t("Could not delete the workspace: {0}", describeError(err)),
      );
    }
    return;
  }
  if (answer === deleteOthers) {
    await vscode.commands.executeCommand("ompcode.review.deleteLosers", record.id);
  }
}

/** Fold a conflict list into a modal's detail, without letting it run off the dialog. */
function appendConflicts(detail: string, files: string[]): string {
  if (files.length === 0) {
    return detail;
  }
  return `${detail}\n\n${t("Conflicting files:")}\n${files
    .slice(0, MAX_NAMES_INLINE)
    .map((file) => `• ${file}`)
    .join("\n")}${files.length > MAX_NAMES_INLINE ? `\n${t("…and {0} more", files.length - MAX_NAMES_INLINE)}` : ""}`;
}

function listNames(files: string[]): string {
  if (files.length <= MAX_NAMES_INLINE) {
    return files.join(", ");
  }
  return t(
    "{0} and {1} more",
    files.slice(0, MAX_NAMES_INLINE).join(", "),
    files.length - MAX_NAMES_INLINE,
  );
}

function short(sha: string): string {
  return sha.slice(0, 8);
}

/** The file a row action carries, or nothing when the command came from elsewhere. */
function fileNodeOf(
  arg: ReviewCommandArg,
): { record: WorkspaceRecord; change: FileChange } | undefined {
  if (!arg || typeof arg === "string" || arg.kind !== "file") {
    return undefined;
  }
  // Narrowed by `kind` above; the structural board-node member of the union
  // cannot be excluded by the compiler because its `kind` is `unknown`.
  const node = arg as Extract<ReviewNode, { kind: "file" }>;
  return { record: node.record, change: node.change };
}

function workspaceIdOf(arg: ReviewCommandArg): string | undefined {
  if (typeof arg === "string") {
    return arg || undefined;
  }
  return arg?.record?.id;
}

/**
 * Which workspace a command acts on. A row action carries the node, the merge
 * follow-ups pass an id, the palette carries nothing — and the palette case has
 * to ask, never guess, since two of these commands delete.
 */
async function resolveWorkspace(
  manager: WorkspaceManager,
  arg: ReviewCommandArg,
): Promise<WorkspaceRecord | undefined> {
  const id = workspaceIdOf(arg);
  if (id) {
    // The node carries the snapshot the tree was painted with; the registry has
    // the current one, and the base or session may have moved on since.
    return manager.get(id) ?? (typeof arg === "string" ? undefined : arg?.record);
  }
  return pickWorkspace(manager);
}

async function pickWorkspace(manager: WorkspaceManager): Promise<WorkspaceRecord | undefined> {
  const records = manager.list();
  if (records.length === 0) {
    void vscode.window.showInformationMessage(t("No workspaces yet — create one first."));
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    records.map((record) => ({
      label: record.name,
      description: `${BRANCH_MARK} ${record.branch}`,
      detail: record.worktreePath,
      record,
    })),
    { placeHolder: t("Select a workspace"), ignoreFocusOut: true },
  );
  return picked?.record;
}

/** The palette path into a file command: pick the workspace, then one of its files. */
async function pickFile(
  manager: WorkspaceManager,
  arg: ReviewCommandArg,
): Promise<{ record: WorkspaceRecord; change: FileChange } | undefined> {
  const record = await resolveWorkspace(manager, arg);
  if (!record) {
    return undefined;
  }
  const diff = await readDiff(record);
  if (!diff) {
    return undefined;
  }
  if (diff.files.length === 0) {
    void vscode.window.showInformationMessage(t("{0} has not changed anything yet.", record.name));
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    diff.files.map((change) => ({
      label: path.posix.basename(change.path),
      description: `${path.posix.dirname(change.path) === "." ? "" : path.posix.dirname(change.path)} +${change.added} −${change.deleted}`.trim(),
      detail: change.oldPath ? t("was {0}", change.oldPath) : undefined,
      change,
    })),
    { title: t("Changed in {0}", record.name), ignoreFocusOut: true },
  );
  return picked ? { record, change: picked.change } : undefined;
}

/**
 * git's own stderr is the most actionable thing a failure carries and needs no
 * translation, so a `GitError` reports that rather than a wrapper message.
 * Duck-typed to keep this file off the git module's error class.
 */
function describeError(err: unknown): string {
  if (err && typeof err === "object" && "stderr" in err) {
    const stderr = String((err as { stderr: unknown }).stderr).trim();
    if (stderr) {
      return stderr;
    }
  }
  return err instanceof Error ? err.message : String(err);
}
