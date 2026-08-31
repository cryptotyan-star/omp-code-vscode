import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { t } from "../l10n.ts";
import type { ApprovalMode } from "../ompSession";
import {
  GitError,
  addWorktree,
  aheadBehind,
  branchToDirName,
  canonicalPath,
  currentBranch,
  defaultWorktreeDir,
  deleteBranch,
  isDirty,
  listBranches,
  listWorktrees,
  pathExists,
  pruneWorktrees,
  removeWorktree,
  revParse,
  samePath,
  uniquePath,
  withRepoLock,
} from "./git.ts";
import { reconcile, type ReconcileResult, type WorkspaceRegistry } from "./registry.ts";
import { readWorkspaceConfig } from "./setup.ts";
// Type-only: `setupRun` needs `vscode`, and this module must stay importable by
// `node --test`. The runner itself arrives through the deps below.
import type { SetupOutcome } from "./setupRun.ts";
import type {
  WorkspaceConfig,
  WorkspaceCreateOptions,
  WorkspaceRecord,
  WorkspaceSetupState,
} from "./types";

/**
 * The lifecycle of a workspace — a git worktree plus the omp process that works
 * in it. Everything here is pure Node: the UI it needs (a chat tab, a modal
 * confirmation) arrives as callbacks so the ordering rules below can be tested
 * without an extension host, and so `commands.ts` stays the only file that
 * knows about VS Code.
 */

/** What a workspace name may contain — it becomes a branch and a directory. */
const NAME_DISALLOWED = /[^A-Za-z0-9._-]+/g;

/**
 * Fold arbitrary user input into a name that is safe as both a path segment and
 * a git ref: runs of forbidden characters collapse to one dash, runs of dots
 * collapse to one (`a..b` is an illegal ref), and leading/trailing dots and
 * dashes go (git rejects a ref starting with `-`, and `.`/`..` are not
 * directory names). Returns "" when nothing usable survives.
 */
export function sanitizeWorkspaceName(name: string): string {
  return name
    .trim()
    .replace(NAME_DISALLOWED, "-")
    .replace(/-{2,}/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[-.]+/, "")
    .replace(/[-.]+$/, "");
}

export interface WorkspaceManagerDeps {
  registry: WorkspaceRegistry;
  output: { appendLine(s: string): void };
  settings(): {
    worktreeBaseDir: string;
    branchPrefix: string;
    setupPolicy: "auto" | "ask" | "never";
    defaultModel: string;
    approvalMode: ApprovalMode;
  };
  /** Opens a chat tab bound to this worktree, with the record's overrides. */
  openChat(record: WorkspaceRecord, prompt?: string): Promise<{ sessionId: string } | undefined>;
  /** Closes that tab and its omp process, if one is open. */
  closeChat(record: WorkspaceRecord): Promise<void>;
  /**
   * Runs the setup commands. Injected rather than imported: running them needs
   * a VS Code terminal, and this module is deliberately host-free.
   */
  runSetup?: (
    record: WorkspaceRecord,
    config: WorkspaceConfig,
    output: { appendLine(s: string): void },
  ) => Promise<SetupOutcome>;
  /**
   * A modal question. `message` is the headline VS Code renders in bold;
   * `detail` is the itemised body — an enumeration of what is about to be lost
   * is unreadable as one bold blob.
   */
  confirm(message: string, detail: string, ok: string): Promise<boolean>;
}

/** What {@link WorkspaceManager.runSetup} did, for the command that reports it. */
export interface SetupResult extends SetupOutcome {
  /** False when the worktree has no setup commands at all — nothing ran. */
  ran: boolean;
}

/** Working-tree and branch state that a delete would throw away. */
interface WorkspaceLoss {
  dirty: boolean;
  untracked: number;
  modified: number;
  /** Git-ignored files — `.env`, `node_modules` — the directory delete takes too. */
  ignored: number;
  ahead: number;
  behind: number;
  /**
   * False when git could not answer. "We do not know" must not be read as
   * "nothing to lose": an index locked by a concurrent git would otherwise
   * delete a dirty worktree with no prompt at all.
   */
  known: boolean;
}

type ChangeListener = () => void;

export class WorkspaceManager {
  private readonly listeners = new Set<ChangeListener>();
  private readonly registrySub: { dispose(): void };
  // Assigned in the body rather than as a parameter property: `node --test`
  // strips types without transforming, and a parameter property is syntax it
  // refuses — this module has to stay directly runnable there.
  private readonly deps: WorkspaceManagerDeps;

  constructor(deps: WorkspaceManagerDeps) {
    this.deps = deps;
    // Every mutation this class makes goes through the registry, so forwarding
    // its event is the whole change signal — there is no second source of truth
    // that could drift out of sync with it.
    this.registrySub = deps.registry.onDidChange(() => this.fire());
  }

  readonly onDidChange = (listener: ChangeListener): { dispose(): void } => {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  };

  list(): WorkspaceRecord[] {
    return this.deps.registry.list();
  }

  get(id: string): WorkspaceRecord | undefined {
    return this.deps.registry.get(id);
  }

  /**
   * Create the worktree, register it, run setup, open its chat.
   *
   * Only the git and registry half runs under the repository lock. Setup is an
   * `npm install` in the general case and the chat waits on a process
   * handshake; holding a 60-second mutex across either would make a second
   * "New Workspace" fail rather than queue.
   */
  async create(repoRoot: string, opts: WorkspaceCreateOptions): Promise<WorkspaceRecord> {
    const name = sanitizeWorkspaceName(opts.name);
    if (!name) {
      throw new Error(t("A workspace needs a name."));
    }
    const settings = this.deps.settings();
    // Canonical from here on: git reports real paths, so a record holding a
    // symlinked spelling would never match its own worktree again.
    const root = await canonicalPath(repoRoot);

    const record = await withRepoLock(root, async () => {
      const baseRef = opts.baseRef?.trim() || (await currentBranch(root)) || "main";
      // The base is resolved to a SHA once, here. The branch it names keeps
      // moving as other work lands, and a diff against a moving target stops
      // meaning "what this workspace changed".
      const baseSha = await revParse(root, baseRef);
      const branch = opts.branch?.trim() || `${settings.branchPrefix}${name}`;
      // Checked up front because git only reports it from `worktree add`, which
      // is several seconds and one directory later.
      if ((await listBranches(root)).includes(branch)) {
        throw new Error(t("Branch {0} already exists — pick another workspace name.", branch));
      }
      // git creates the leaf itself; the container above it may be the very
      // first `<repo>.worktrees` directory and has to exist first. It is made
      // before the name is chosen so the collision check reads the real
      // directory, and canonicalised so the record matches what git will print.
      const container = defaultWorktreeDir(root, settings.worktreeBaseDir);
      await fs.mkdir(container, { recursive: true });
      const canonicalContainer = await canonicalPath(container);
      // One listing instead of a stat per candidate: `existsSync` in here would
      // block the extension host on a network volume, inside the repo lock.
      const siblings = new Set(await fs.readdir(canonicalContainer).catch(() => [] as string[]));
      const worktreePath = uniquePath(
        path.join(canonicalContainer, branchToDirName(branch, settings.branchPrefix)),
        (candidate) => siblings.has(path.basename(candidate)),
      );
      // Checked out at the pinned SHA rather than the ref name: the ref could
      // have moved since the rev-parse above, and the record would then be
      // lying about the commit this branch started from.
      await addWorktree({
        repoRoot: root,
        path: worktreePath,
        branch,
        commitish: baseSha,
        noTrack: true,
      });
      const created: WorkspaceRecord = {
        id: randomUUID(),
        name,
        repoRoot: root,
        worktreePath,
        branch,
        baseRef,
        baseSha,
        createdAt: Date.now(),
        // Pinned at creation, default included: a workspace is a parallel agent
        // with its own model and its own approval tier, and changing the global
        // default later must not silently re-aim work already in flight.
        model: (opts.model ?? settings.defaultModel).trim() || undefined,
        approvalMode: opts.approvalMode ?? settings.approvalMode,
        setupState: "pending",
      };
      // Registered before setup runs: a crash mid-setup then leaves a row on the
      // board that can be cleaned up, instead of a stray worktree nobody owns.
      try {
        await this.deps.registry.upsert(created);
      } catch (err) {
        // Storage refused. Without a record nothing can ever adopt this
        // worktree — reconcile only drops records that lost their worktree,
        // never the reverse — so it is unwound here rather than left to rot and
        // block the next create with the same name.
        this.deps.output.appendLine(
          `[omp] workspace ${created.name}: not registered (${describe(err)}) — rolling back the worktree`,
        );
        await removeWorktree({ repoRoot: root, path: worktreePath, force: true }).catch(() => undefined);
        await pruneWorktrees(root).catch(() => undefined);
        await deleteBranch(root, branch, true).catch(() => undefined);
        throw err;
      }
      this.deps.output.appendLine(
        `[omp] workspace ${created.name}: ${created.branch} at ${created.worktreePath} (base ${baseRef} ${baseSha.slice(0, 8)})`,
      );
      return created;
    });

    await this.applySetupPolicy(record, opts.runSetup, settings.setupPolicy);
    await this.openChatFor(record, opts.prompt);
    // Setup moved the state on since `record` was built.
    return this.deps.registry.get(record.id) ?? record;
  }

  /**
   * Tear a workspace down. The order is load-bearing: the chat closes first
   * because its omp process holds the worktree as its cwd — on Windows an open
   * handle in that directory makes `git worktree remove` fail outright, and
   * everywhere else it would keep writing into a directory being deleted.
   */
  async remove(id: string, opts?: { deleteBranch?: boolean; force?: boolean }): Promise<void> {
    const record = this.require(id);
    try {
      await this.deps.closeChat(record);
    } catch (err) {
      // A chat that refuses to close must not strand the worktree: the operator
      // asked for this to go away.
      this.deps.output.appendLine(
        `[omp] workspace ${record.name}: chat did not close cleanly: ${describe(err)}`,
      );
    }

    // Read outside the lock: these are read-only, and the confirmation below is
    // a modal the user may sit on for a minute.
    const loss = await this.inspectLoss(record);
    // "Could not read" is grouped with "has changes": both mean the delete may
    // destroy work, and both deserve the same question.
    const atRisk = loss.dirty || loss.ignored > 0 || loss.ahead > 0 || !loss.known;
    if (!opts?.force && atRisk) {
      const { message, detail } = this.lossMessage(record, loss);
      const proceed = await this.deps.confirm(message, detail, t("Delete"));
      if (!proceed) {
        // The chat was already closed to get the worktree's files released, so
        // backing out here would otherwise leave the operator with a killed
        // agent and no tab. Put it back the way it was.
        this.deps.output.appendLine(
          `[omp] workspace ${record.name}: delete cancelled — reopening its chat`,
        );
        await this.openChatFor(record);
        return;
      }
    }
    // Forced whenever anything is uncommitted or unreadable: git declines
    // outright in that case, and by now the operator has either passed force or
    // agreed to the loss spelled out above.
    const force = opts?.force === true || loss.dirty || loss.ignored > 0 || !loss.known;

    await withRepoLock(record.repoRoot, async () => {
      // The repository itself is gone (moved, renamed, an unmounted drive).
      // git cannot even start there, and refusing to finish would leave a row
      // on the board that nothing could ever delete.
      if (!(await pathExists(record.repoRoot))) {
        this.deps.output.appendLine(
          `[omp] workspace ${record.name}: ${record.repoRoot} no longer exists — dropping the record`,
        );
        await this.deps.registry.remove(record.id);
        return;
      }
      await this.removeWorktreeOf(record, force);
      // The bookkeeping under .git/worktrees outlives the directory; without
      // this the branch stays "already used by a worktree" forever.
      await pruneWorktrees(record.repoRoot);
      await this.deps.registry.remove(record.id);
      if (opts?.deleteBranch) {
        try {
          // Force-delete: a workspace branch is unmerged by definition once
          // anything was committed on it, and deleting it was asked for
          // explicitly, after the same confirmation.
          await deleteBranch(record.repoRoot, record.branch, true);
        } catch (err) {
          // The worktree is already gone by now, so this cannot be unwound —
          // report it and leave the branch for the operator to remove by hand.
          this.deps.output.appendLine(
            `[omp] workspace ${record.name}: branch ${record.branch} not deleted: ${describe(err)}`,
          );
        }
      }
    });
  }

  /**
   * `git worktree remove`, with the one retry that has a user behind it.
   *
   * git refuses a worktree with changes unless forced. When the dirty probe
   * said "clean" and git disagrees — a submodule, a file written between the
   * two calls — the operator would otherwise be stuck: the record survives, the
   * error is raw git stderr, and no command in the UI passes `force`. So ask
   * once, then force.
   */
  private async removeWorktreeOf(record: WorkspaceRecord, force: boolean): Promise<void> {
    try {
      await removeWorktree({ repoRoot: record.repoRoot, path: record.worktreePath, force });
    } catch (err) {
      if (force || !(err instanceof GitError) || err.code !== "WorktreeContainsChanges") {
        throw err;
      }
      const proceed = await this.deps.confirm(
        t("Delete the workspace {0} anyway?", record.name),
        t("git will not remove {0}: it still holds changes.", record.worktreePath),
        t("Delete anyway"),
      );
      if (!proceed) {
        throw err;
      }
      await removeWorktree({ repoRoot: record.repoRoot, path: record.worktreePath, force: true });
    }
  }

  /**
   * Bring a workspace back after a VS Code restart. Nothing is restored here:
   * the session layer replays `record.sessionFile` through `switch_session`
   * once its process is up.
   */
  async reopen(id: string): Promise<void> {
    const record = this.require(id);
    await this.deps.openChat(record);
  }

  /**
   * Drop records whose worktree no longer exists — deleted with `git worktree
   * remove` from a terminal, or with `rm -rf`. Only this repository's records
   * take part: one belonging to another checkout has no worktree in this list
   * and would look orphaned to a pure comparison.
   */
  async reconcileWithGit(repoRoot: string): Promise<ReconcileResult> {
    const live = await listWorktrees(repoRoot);
    // Compared the way every other path in this layer is compared: a trailing
    // separator or a drive letter in the other case would otherwise match
    // nothing at all, and orphan cleanup would quietly stop working.
    const mine = this.deps.registry.list().filter((record) => samePath(record.repoRoot, repoRoot));
    const result = reconcile(mine, live);
    for (const orphan of result.orphaned) {
      // Translated: the output channel is where the operator finds out why a row
      // they were using vanished from the board.
      this.deps.output.appendLine(
        t("The worktree of {0} is gone — removing it from the list.", orphan.name),
      );
      await this.deps.registry.remove(orphan.id);
    }
    return result;
  }

  /** Remember the JSONL a session landed on, so a restart can resume it. */
  async rememberSessionFile(id: string, sessionFile: string): Promise<void> {
    // `update`, not read-then-upsert: the session layer can land this while a
    // delete of the same workspace is in flight, and a snapshot-based write
    // would resurrect the record the delete had just removed.
    await this.deps.registry.update(id, (record) =>
      record.sessionFile === sessionFile ? record : { ...record, sessionFile },
    );
  }

  /**
   * Run the workspace's setup commands on demand — the retry path for a setup
   * that failed, was declined, or was added to the repo after creation.
   */
  async runSetup(id: string): Promise<SetupResult> {
    const record = this.require(id);
    const { config, source } = await readWorkspaceConfig(record.worktreePath);
    if (source === "none" || config.setup.length === 0) {
      this.deps.output.appendLine(`[omp] workspace ${record.name}: no setup commands configured`);
      // Only a workspace still waiting for setup is marked skipped: a record
      // that already reached "done" ran its commands, and a later run against a
      // config that has since been deleted must not demote it.
      if (record.setupState === "pending") {
        await this.setSetupState(record.id, "skipped");
      }
      return { ok: true, ran: false };
    }
    return this.execSetup(record, config);
  }

  /** Persist a model the user switched to from this workspace's chat. */
  async rememberModel(id: string, model: string): Promise<void> {
    const next = model.trim() || undefined;
    // `update` so a concurrent field write (a setup state landing, a session
    // file being remembered) is composed with rather than erased, and a delete
    // racing this still ends with the record gone.
    await this.deps.registry.update(id, (record) =>
      record.model === next ? record : { ...record, model: next },
    );
  }

  /** Persist an approval tier the user switched to from this workspace's chat. */
  async rememberApprovalMode(id: string, approvalMode: ApprovalMode): Promise<void> {
    await this.deps.registry.update(id, (record) =>
      record.approvalMode === approvalMode ? record : { ...record, approvalMode },
    );
  }

  /** Releases the registry subscription; the manager outlives nothing else. */
  dispose(): void {
    this.registrySub.dispose();
    this.listeners.clear();
  }

  /**
   * `runSetup: false` and `runSetup: true` are an explicit answer and win over
   * the policy; `undefined` means "whatever the setting says". The `ask` policy
   * only asks when there is something to run — a repo with no workspace config
   * must not open a dialog on every create.
   */
  private async applySetupPolicy(
    record: WorkspaceRecord,
    explicit: boolean | undefined,
    policy: "auto" | "ask" | "never",
  ): Promise<void> {
    if (explicit === false || (explicit === undefined && policy === "never")) {
      await this.setSetupState(record.id, "skipped");
      return;
    }
    if (explicit === true || policy === "auto") {
      await this.runSetup(record.id);
      return;
    }
    const { config, source } = await readWorkspaceConfig(record.worktreePath);
    if (source === "none" || config.setup.length === 0) {
      await this.setSetupState(record.id, "skipped");
      return;
    }
    const proceed = await this.deps.confirm(
      t("Run the setup commands for {0}?", record.name),
      // The commands themselves are not translatable text, so they are the
      // detail body rather than a placeholder inside the sentence.
      config.setup.join("\n"),
      t("Run setup"),
    );
    if (!proceed) {
      await this.setSetupState(record.id, "skipped");
      return;
    }
    await this.execSetup(record, config);
  }

  private async execSetup(record: WorkspaceRecord, config: WorkspaceConfig): Promise<SetupResult> {
    const run = this.deps.runSetup;
    if (!run) {
      // Only a host that forgot to wire the runner lands here; say so rather
      // than reporting a setup that never happened as done.
      this.deps.output.appendLine(`[omp] workspace ${record.name}: no setup runner is wired`);
      await this.setSetupState(record.id, "failed");
      return { ok: false, ran: true };
    }
    await this.setSetupState(record.id, "running");
    try {
      const result = await run(record, config, this.deps.output);
      // An unsupervised run (no shell integration, no exit code) is not a
      // success: the commands may still be installing, or may have failed. It
      // stays "pending", which is also what makes "Run setup" offer a retry.
      await this.setSetupState(
        record.id,
        result.ok ? (result.supervised === false ? "pending" : "done") : "failed",
      );
      return { ...result, ran: true };
    } catch (err) {
      this.deps.output.appendLine(`[omp] workspace ${record.name}: setup failed: ${describe(err)}`);
      await this.setSetupState(record.id, "failed");
      return { ok: false, ran: true };
    }
  }

  private async setSetupState(id: string, state: WorkspaceSetupState): Promise<void> {
    // `update`: a record removed while setup was running is not an error worth
    // throwing — the result has nowhere to go — and a snapshot-based write here
    // would resurrect it. Unchanged state skips the write entirely.
    await this.deps.registry.update(id, (record) =>
      record.setupState === state ? record : { ...record, setupState: state },
    );
  }

  private async openChatFor(record: WorkspaceRecord, prompt?: string): Promise<void> {
    try {
      const opened = await this.deps.openChat(record, prompt);
      if (opened) {
        this.deps.output.appendLine(
          `[omp] workspace ${record.name}: chat session ${opened.sessionId}`,
        );
      }
    } catch (err) {
      // The worktree exists and is registered by now, and Reveal reopens the
      // chat — a failed tab must not unwind a workspace that is otherwise fine.
      this.deps.output.appendLine(
        `[omp] workspace ${record.name}: chat did not open: ${describe(err)}`,
      );
    }
  }

  /**
   * What a delete would destroy. Both reads are best-effort: a worktree the
   * user already deleted by hand must still be removable from the board, and a
   * missing branch must not block the cleanup that would forget it.
   */
  private async inspectLoss(record: WorkspaceRecord): Promise<WorkspaceLoss> {
    const loss: WorkspaceLoss = {
      dirty: false,
      untracked: 0,
      modified: 0,
      ignored: 0,
      ahead: 0,
      behind: 0,
      known: true,
    };
    try {
      Object.assign(loss, await isDirty(record.worktreePath));
    } catch (err) {
      loss.known = false;
      this.deps.output.appendLine(
        `[omp] workspace ${record.name}: could not read working tree state: ${describe(err)}`,
      );
    }
    try {
      // Against the pinned base SHA, not the base branch: "ahead" has to mean
      // "commits that exist only here", which a base branch that moved on would
      // understate.
      Object.assign(loss, await aheadBehind(record.repoRoot, record.baseSha, record.branch));
    } catch (err) {
      loss.known = false;
      this.deps.output.appendLine(
        `[omp] workspace ${record.name}: could not count commits: ${describe(err)}`,
      );
    }
    return loss;
  }

  /**
   * Names what is about to be lost, line by line — never just "are you sure?".
   *
   * The headline and the itemised body are returned apart because a modal
   * renders its message as one bold heading; the list belongs in `detail`.
   *
   * Every count is worded so that no sentence has to agree with it
   * grammatically ("modified: 1"), which is the only way one string can be
   * correct in both English and a language with three plural forms.
   */
  private lossMessage(
    record: WorkspaceRecord,
    loss: WorkspaceLoss,
  ): { message: string; detail: string } {
    const lines: string[] = [];
    if (!loss.known) {
      lines.push(t("The state of this worktree could not be read — it may hold uncommitted work."));
    }
    // `modified` and `untracked` are disjoint counts, so both are named.
    if (loss.modified + loss.untracked > 0) {
      lines.push(
        t(
          "Uncommitted changes will be lost — modified: {0}, untracked: {1}.",
          loss.modified,
          loss.untracked,
        ),
      );
    }
    if (loss.ignored > 0) {
      lines.push(
        t(
          "Ignored files will be deleted too (.env, node_modules and the like) — {0} entries.",
          loss.ignored,
        ),
      );
    }
    if (loss.ahead > 0) {
      lines.push(
        t("Commits that exist only on {0} will be lost — {1}.", record.branch, loss.ahead),
      );
    }
    lines.push(t("The worktree at {0} will be removed.", record.worktreePath));
    return { message: t("Delete the workspace {0}?", record.name), detail: lines.join("\n") };
  }

  private require(id: string): WorkspaceRecord {
    const record = this.deps.registry.get(id);
    if (!record) {
      throw new Error(t("That workspace is no longer on the board."));
    }
    return record;
  }

  private fire(): void {
    // Copied first: a listener may dispose itself while being notified.
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
