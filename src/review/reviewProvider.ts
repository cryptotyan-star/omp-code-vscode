import * as path from "node:path";
import * as vscode from "vscode";
import { t } from "../l10n.ts";
import { workspaceDiff, type FileChange, type WorkspaceDiff } from "../workspaces/diff.ts";
import { samePath } from "../workspaces/git.ts";
import type { WorkspaceRecord } from "../workspaces/types.ts";

/**
 * The review tree: one row per workspace, its changed files underneath.
 *
 * This is the half of the parallel-agents story that happens after the agents
 * stop. Three models wrote three branches in three worktrees; before anything
 * can be merged, the operator has to see what each of them actually did, and
 * the numbers have to be comparable — which is why every diff here is taken
 * against `record.baseSha`, the commit the workspace was cut from, and never
 * against the base *branch*. The branch keeps moving while the agents work,
 * and a moving base repaints untouched files as changed, so two workspaces
 * created an hour apart would stop being comparable at all.
 *
 * Counting is lazy and cached. `workspaceDiff` is two git spawns over a whole
 * tree; doing that for every workspace on every repaint would make the tree
 * unusable on a large repository, so a workspace is only counted once its row
 * is expanded, and only recounted when something actually writes to its
 * worktree.
 */

/** Branch marker, matched to the session board so the two trees read alike. */
const BRANCH_MARK = "⎇";

/** Matches `DiffOptions.maxFiles`; named here so the row can say it truncated. */
const MAX_FILES = 500;

/**
 * How long a worktree has to go quiet before we recount. An agent editing
 * files fires dozens of watcher events per second, and each recount is two git
 * processes — without a debounce the view would spawn git faster than it can
 * finish.
 */
const WATCH_DEBOUNCE_MS = 400;

/**
 * At most this many `workspaceDiff` calls in flight. Expanding the view on a
 * ten-workspace repo would otherwise put twenty git processes on the machine
 * at once, competing with the agents that are still running.
 */
const MAX_PARALLEL_DIFFS = 3;

/**
 * A row of the review tree.
 *
 * The `message` variant is not in the original contract, which had only
 * `workspace` and `file` — but the same contract requires a failed count to be
 * shown as a child row rather than swallowed, and there is no other way to put
 * a non-file row under a workspace. It is additive: nothing that only ever
 * constructs or inspects `workspace`/`file` nodes changes because of it. Rows
 * of this kind carry `contextValue: "review-message"` and no `command`, so no
 * review command can ever be invoked on one.
 */
export type ReviewNode =
  | { kind: "workspace"; record: WorkspaceRecord; diff?: WorkspaceDiff }
  | { kind: "file"; workspaceId: string; record: WorkspaceRecord; change: FileChange }
  | {
      kind: "message";
      workspaceId: string;
      /** Carried so a message row answers `node.record` like every other row. */
      record: WorkspaceRecord;
      text: string;
      tooltip?: string;
      icon?: string;
    };

/** The review tree's read-only view of the workspace layer. */
export interface ReviewSource {
  list(): WorkspaceRecord[];
  onDidChange(listener: () => void): { dispose(): void };
}

/** What the session board borrows to put "+N −M" on its own workspace rows. */
export interface ReviewStats {
  added: number;
  deleted: number;
}

/**
 * What we know about one workspace's diff. `stale` rather than deletion on
 * invalidation: the old numbers stay on screen while the recount runs, so a
 * saving agent does not make the tree flicker empty every 400 ms.
 */
interface CacheEntry {
  /**
   * Identity of what was measured. A workspace whose worktree moved or whose
   * base was re-pinned is a different measurement, and reusing the old one
   * would show numbers taken against a commit that is no longer the base.
   */
  key: string;
  diff?: WorkspaceDiff;
  error?: string;
  stale: boolean;
  pending?: Promise<void>;
  controller?: AbortController;
}

interface WatchEntry {
  watcher: vscode.FileSystemWatcher;
  subs: vscode.Disposable[];
  timer?: ReturnType<typeof setTimeout>;
  /**
   * The directory this watcher is actually watching. The cache is keyed by
   * worktree path and base SHA, the watchers only by workspace id — so without
   * this a record whose worktree moved would keep a watcher pointed at the old
   * directory forever, and the new one would never trigger a recount.
   */
  path: string;
}

/** Bounded concurrency, so expanding the view cannot fork git without limit. */
class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
      // Woken with the slot already ours — see the `finally` below.
    } else {
      this.active += 1;
    }
    try {
      return await fn();
    } finally {
      // The slot is *handed* to the next waiter rather than released and
      // re-taken. Releasing first leaves a window between this decrement and
      // the waiter resuming on a later microtask, in which a fresh `run()`
      // sees a free slot and takes it too — so both proceed and the limit is
      // exceeded, which is exactly what several `invalidate()` calls landing
      // in one tick would do.
      const next = this.waiting.shift();
      if (next) {
        next();
      } else {
        this.active -= 1;
      }
    }
  }
}

function cacheKey(record: WorkspaceRecord): string {
  return `${record.worktreePath}\u0000${record.baseSha}`;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Noise a recount must ignore. `.git` churns on every git command we ourselves
 * run — including the ones this class spawns — so watching it would make the
 * view recount itself forever; `node_modules` churns for a whole minute during
 * workspace setup and holds nothing the reviewer wants to read.
 */
function isNoise(worktreePath: string, uri: vscode.Uri): boolean {
  const relative = path.relative(worktreePath, uri.fsPath);
  if (!relative || relative.startsWith("..")) {
    return true;
  }
  const segments = relative.split(/[\\/]/);
  return segments.includes(".git") || segments.includes("node_modules");
}

export class ReviewProvider implements vscode.TreeDataProvider<ReviewNode>, vscode.Disposable {
  public static readonly viewType = "ompcode.review";

  private readonly emitter = new vscode.EventEmitter<ReviewNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  /**
   * Fired when a cached count changed. The session board reads those numbers
   * through {@link stats} but has no way of knowing when they move, and it is
   * a separate tree with its own refresh — so it gets its own signal rather
   * than being wired into this tree's `onDidChangeTreeData`.
   */
  private readonly statsEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeStats = this.statsEmitter.event;

  private readonly cache = new Map<string, CacheEntry>();
  private readonly watchers = new Map<string, WatchEntry>();
  private readonly gate = new Semaphore(MAX_PARALLEL_DIFFS);
  private readonly subs: Array<{ dispose(): void }> = [];
  private repaintTimer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  constructor(private readonly source: ReviewSource) {
    this.subs.push(
      source.onDidChange(() => {
        this.prune();
        this.scheduleRepaint();
      }),
    );
    // Turning the setting off has to actually stop the watchers, not just skip
    // the recount: a recursive watcher on a big worktree is the expensive part.
    this.subs.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("ompcode.reviewAutoRefresh")) {
          this.syncWatchers();
        }
      }),
    );
  }

  // ---------------------------------------------------------------- tree data

  getTreeItem(node: ReviewNode): vscode.TreeItem {
    switch (node.kind) {
      case "workspace":
        return this.workspaceItem(node);
      case "file":
        return this.fileItem(node);
      default:
        return this.messageItem(node);
    }
  }

  async getChildren(element?: ReviewNode): Promise<ReviewNode[]> {
    if (!element) {
      return this.source.list().map((record) => ({
        kind: "workspace",
        record,
        diff: this.cache.get(record.id)?.diff,
      }));
    }
    if (element.kind !== "workspace") {
      return [];
    }
    // Re-read the record: the node object was built when the tree was last
    // painted and may name a worktree that has since moved.
    const record = this.current(element.record.id) ?? element.record;
    // Expansion is the trigger for counting — this is the only place a diff is
    // computed for a workspace that has never been looked at.
    await this.load(record);
    if (this.disposed) {
      return [];
    }
    const entry = this.cache.get(record.id);
    if (entry?.error !== undefined) {
      // Loudly, as a row. A silent empty list reads as "this agent wrote
      // nothing", which is the opposite of what a failed count means.
      return [
        {
          kind: "message",
          workspaceId: record.id,
          record,
          text: t("Could not read the changes: {0}", entry.error),
          tooltip: entry.error,
          icon: "error",
        },
      ];
    }
    const diff = entry?.diff;
    if (!diff || diff.files.length === 0) {
      return [
        {
          kind: "message",
          workspaceId: record.id,
          record,
          text: t("This workspace has no changes to review."),
          icon: "circle-outline",
        },
      ];
    }
    const out: ReviewNode[] = diff.files.map((change) => ({
      kind: "file",
      workspaceId: record.id,
      record,
      change,
    }));
    if (diff.truncated) {
      out.push({
        kind: "message",
        workspaceId: record.id,
        record,
        text: t("The file list was cut off at {0} files.", MAX_FILES),
        icon: "ellipsis",
      });
    }
    return out;
  }

  /** Needed by `TreeView.reveal`, which walks a node up to the root. */
  getParent(node: ReviewNode): ReviewNode | undefined {
    if (node.kind === "workspace") {
      return undefined;
    }
    const record = this.current(node.workspaceId);
    return record ? { kind: "workspace", record, diff: this.cache.get(record.id)?.diff } : undefined;
  }

  // ------------------------------------------------------------------ commands

  /**
   * Recount. Without an id, every workspace that has ever been expanded —
   * one that has not is not counted here either, or "refresh" on a repo with
   * twenty workspaces would spawn forty git processes for rows nobody opened.
   */
  refresh(id?: string): void {
    if (id === undefined) {
      for (const key of this.cache.keys()) {
        this.invalidate(key);
      }
    } else {
      this.invalidate(id, true);
    }
    this.scheduleRepaint();
  }

  /** The workspace row for `id`, for `TreeView.reveal` from the board. */
  nodeFor(id: string): ReviewNode | undefined {
    const record = this.current(id);
    return record ? { kind: "workspace", record, diff: this.cache.get(id)?.diff } : undefined;
  }

  /**
   * The cached totals for a workspace, or `undefined` when it has never been
   * expanded. Synchronous on purpose: the session board builds its rows inside
   * `getTreeItem`, which cannot await, and a board that had to wait on git
   * would stall on every repaint.
   */
  stats(id: string): ReviewStats | undefined {
    const diff = this.cache.get(id)?.diff;
    return diff ? { added: diff.added, deleted: diff.deleted } : undefined;
  }

  dispose(): void {
    this.disposed = true;
    if (this.repaintTimer) {
      clearTimeout(this.repaintTimer);
      this.repaintTimer = undefined;
    }
    for (const entry of this.cache.values()) {
      entry.controller?.abort();
    }
    this.cache.clear();
    for (const id of [...this.watchers.keys()]) {
      this.unwatch(id);
    }
    for (const sub of this.subs.splice(0)) {
      sub.dispose();
    }
    this.emitter.dispose();
    this.statsEmitter.dispose();
  }

  // ------------------------------------------------------------------- counting

  private current(id: string): WorkspaceRecord | undefined {
    return this.source.list().find((record) => record.id === id);
  }

  /**
   * Ensure `record` has a fresh count, waiting on one already in flight rather
   * than starting a second. Never rejects: a diff that cannot be taken is a row
   * in the tree, not an unhandled rejection in the extension host.
   */
  private load(record: WorkspaceRecord): Promise<void> {
    const key = cacheKey(record);
    let entry = this.cache.get(record.id);
    if (!entry || entry.key !== key) {
      // Measured against a different worktree or base — abandon it rather than
      // show numbers that no longer mean anything.
      entry?.controller?.abort();
      entry = { key, stale: true };
      this.cache.set(record.id, entry);
    }
    if (entry.pending) {
      return entry.pending;
    }
    if (!entry.stale && (entry.diff !== undefined || entry.error !== undefined)) {
      return Promise.resolve();
    }
    // Only a workspace we actually count gets a watcher, so an unopened row
    // costs nothing.
    this.watch(record);

    const controller = new AbortController();
    const settled = entry;
    settled.controller = controller;
    // `controller` doubles as this run's identity token: a run that has been
    // superseded (the worktree was written to while it was queued) must not
    // clear the *replacement* run's `pending` when it finally unwinds, or a
    // third run would start behind it.
    const finish = (): void => {
      if (settled.controller === controller) {
        settled.controller = undefined;
        settled.pending = undefined;
      }
      this.scheduleRepaint();
    };
    settled.pending = this.gate
      .run(async () => {
        if (controller.signal.aborted || this.disposed) {
          return;
        }
        // Cleared before the call, not after: anything written *during* the
        // count is not reflected in it, and marking it stale afterwards would
        // erase that fact and leave the tree one edit behind for good.
        settled.stale = false;
        const diff = await workspaceDiff(record.worktreePath, record.baseSha, {
          maxFiles: MAX_FILES,
          signal: controller.signal,
        });
        if (this.cache.get(record.id) !== settled) {
          return;
        }
        settled.diff = diff;
        settled.error = undefined;
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || this.cache.get(record.id) !== settled) {
          return;
        }
        settled.error = describeError(err);
        settled.diff = undefined;
      })
      .finally(finish);
    return settled.pending;
  }

  /**
   * Mark a workspace's count out of date and recount it in the background,
   * keeping the previous numbers on screen meanwhile.
   */
  private invalidate(id: string, seed = false): void {
    const record = this.current(id);
    if (!record) {
      return;
    }
    let entry = this.cache.get(id);
    if (!entry) {
      if (!seed) {
        // The no-id sweep only recounts rows somebody has opened; counting the
        // rest would fork git for workspaces nobody is looking at.
        return;
      }
      // A targeted refresh is the opposite case: it follows a merge or a
      // discard on *this* workspace, and the board's "+N −M" for it has to
      // start existing even if its row was never expanded.
      entry = { key: cacheKey(record), stale: true };
      this.cache.set(id, entry);
    }
    entry.stale = true;
    // A run already in flight was started before the write that invalidated
    // us, so it has to be replaced rather than waited on.
    if (entry.pending) {
      entry.controller?.abort();
      entry.controller = undefined;
      entry.pending = undefined;
    }
    void this.load(record);
  }

  /** Drop cache and watchers for workspaces that no longer exist. */
  private prune(): void {
    const live = new Set(this.source.list().map((record) => record.id));
    for (const [id, entry] of [...this.cache]) {
      if (!live.has(id)) {
        entry.controller?.abort();
        this.cache.delete(id);
      }
    }
    for (const id of [...this.watchers.keys()]) {
      if (!live.has(id)) {
        this.unwatch(id);
      }
    }
  }

  /**
   * One repaint per tick. Three workspaces expanded together settle within
   * microseconds of each other, and firing three times would make VS Code walk
   * the whole tree three times.
   */
  private scheduleRepaint(): void {
    if (this.disposed || this.repaintTimer) {
      return;
    }
    this.repaintTimer = setTimeout(() => {
      this.repaintTimer = undefined;
      if (this.disposed) {
        return;
      }
      // Whole tree rather than a node: `getChildren` hands out fresh node
      // objects on every pass, so there is no stable element identity for VS
      // Code to match a targeted fire against. Expansion state survives
      // anyway — it is keyed off the stable `TreeItem.id` we set below — and
      // every re-read hits the cache.
      this.emitter.fire(undefined);
      this.statsEmitter.fire();
    }, 0);
  }

  // ------------------------------------------------------------------ watching

  private autoRefresh(): boolean {
    return vscode.workspace.getConfiguration("ompcode").get<boolean>("reviewAutoRefresh", true);
  }

  private watch(record: WorkspaceRecord): void {
    if (this.disposed || !this.autoRefresh()) {
      return;
    }
    const existing = this.watchers.get(record.id);
    if (existing) {
      if (samePath(existing.path, record.worktreePath)) {
        return;
      }
      // Same workspace, different directory: the old watcher is watching a
      // path this record no longer has.
      this.unwatch(record.id);
    }
    let watcher: vscode.FileSystemWatcher;
    try {
      watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(record.worktreePath), "**/*"),
      );
    } catch {
      // A worktree that has been deleted out from under us cannot be watched.
      // The view still works, it just will not recount by itself.
      return;
    }
    const entry: WatchEntry = { watcher, subs: [], path: record.worktreePath };
    const touched = (uri: vscode.Uri): void => {
      if (isNoise(record.worktreePath, uri)) {
        return;
      }
      if (entry.timer) {
        clearTimeout(entry.timer);
      }
      entry.timer = setTimeout(() => {
        entry.timer = undefined;
        this.invalidate(record.id);
        this.scheduleRepaint();
      }, WATCH_DEBOUNCE_MS);
    };
    entry.subs.push(watcher.onDidCreate(touched), watcher.onDidChange(touched), watcher.onDidDelete(touched));
    this.watchers.set(record.id, entry);
  }

  private unwatch(id: string): void {
    const entry = this.watchers.get(id);
    if (!entry) {
      return;
    }
    this.watchers.delete(id);
    if (entry.timer) {
      clearTimeout(entry.timer);
    }
    for (const sub of entry.subs) {
      sub.dispose();
    }
    entry.watcher.dispose();
  }

  /** Apply `ompcode.reviewAutoRefresh` to workspaces already being counted. */
  private syncWatchers(): void {
    if (!this.autoRefresh()) {
      for (const id of [...this.watchers.keys()]) {
        this.unwatch(id);
      }
      return;
    }
    for (const id of this.cache.keys()) {
      const record = this.current(id);
      if (record) {
        this.watch(record);
      }
    }
  }

  // ---------------------------------------------------------------- tree items

  private workspaceItem(node: { record: WorkspaceRecord; diff?: WorkspaceDiff }): vscode.TreeItem {
    const record = this.current(node.record.id) ?? node.record;
    const entry = this.cache.get(record.id);
    const diff = entry?.diff ?? node.diff;
    const item = new vscode.TreeItem(record.name, vscode.TreeItemCollapsibleState.Collapsed);
    // Namespaced: this tree and the board can be open at once and their rows
    // must not be confused for one another by VS Code's node cache.
    item.id = `review:${record.id}`;
    item.description = this.describeWorkspace(record, diff, entry?.pending !== undefined);
    item.tooltip = this.workspaceTooltip(record, diff, entry?.error);
    // A row whose count blew up says so with the icon rather than a word in the
    // description: the reason is a git message, and only the tooltip and the
    // child row have room for one.
    item.iconPath = new vscode.ThemeIcon(entry?.error === undefined ? "git-branch" : "error");
    // The menu when-clauses match `/^review-workspace/`; the suffix is there so
    // a future menu can tell a workspace with work in it from an empty one.
    item.contextValue = diff && diff.files.length > 0 ? "review-workspace-changed" : "review-workspace";
    return item;
  }

  private fileItem(node: { workspaceId: string; record: WorkspaceRecord; change: FileChange }): vscode.TreeItem {
    const { change } = node;
    const item = new vscode.TreeItem(path.posix.basename(change.path), vscode.TreeItemCollapsibleState.None);
    item.id = `review:${node.workspaceId}:${change.path}`;
    const dir = path.posix.dirname(change.path);
    item.description = [dir === "." ? "" : dir, formatStat(change)].filter(Boolean).join(" ");
    item.tooltip = fileTooltip(node.record, change);
    item.iconPath = statusIcon(change.status);
    item.contextValue = "review-file";
    item.command = {
      command: "ompcode.review.openFile",
      title: t("Open the diff"),
      arguments: [node],
    };
    return item;
  }

  private messageItem(node: { workspaceId: string; text: string; tooltip?: string; icon?: string }): vscode.TreeItem {
    const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
    item.id = `review:${node.workspaceId}:!${node.text}`;
    item.tooltip = node.tooltip ?? node.text;
    item.iconPath = new vscode.ThemeIcon(node.icon ?? "info");
    // Deliberately not "review-file": no review command may fire on this row.
    item.contextValue = "review-message";
    return item;
  }

  private describeWorkspace(
    record: WorkspaceRecord,
    diff: WorkspaceDiff | undefined,
    counting: boolean,
  ): string {
    // The branch leads the row: it is what makes two workspaces different, and
    // it is there before any counting has happened.
    const parts: string[] = [`${BRANCH_MARK} ${record.branch}`];
    if (diff) {
      parts.push(diff.files.length === 0 ? t("no changes yet") : `+${diff.added} −${diff.deleted}`);
      if (diff.files.length > 0) {
        parts.push(fileCount(diff.files.length));
      }
    }
    // Appended rather than substituted, so a recount does not blank the numbers
    // the reviewer was reading a moment ago.
    if (counting) {
      parts.push(t("Counting changes…"));
    }
    return parts.join(" · ");
  }

  private workspaceTooltip(
    record: WorkspaceRecord,
    diff: WorkspaceDiff | undefined,
    error: string | undefined,
  ): string {
    const lines = [
      record.name,
      record.worktreePath,
      t("Branch: {0}", record.branch),
      // The pinned base is the whole basis of these numbers, so the reviewer
      // gets to read it rather than assume the diff is against the branch tip.
      t("Base: {0} ({1})", record.baseRef, record.baseSha.slice(0, 7)),
    ];
    if (error !== undefined) {
      lines.push("", error);
    } else if (diff) {
      lines.push(
        t("Changes: {0}", `+${diff.added} −${diff.deleted}`),
        diff.files.length === 0 ? t("no changes yet") : fileCount(diff.files.length),
      );
      if (diff.truncated) {
        lines.push(t("The file list was cut off at {0} files.", MAX_FILES));
      }
    }
    return lines.join("\n");
  }
}

/** Russian and English both need the singular spelled out separately. */
function fileCount(n: number): string {
  return n === 1 ? t("1 file") : t("{0} files", n);
}

function formatStat(change: FileChange): string {
  return change.binary ? t("binary") : `+${change.added} −${change.deleted}`;
}

function fileTooltip(record: WorkspaceRecord, change: FileChange): string {
  const lines = [change.path];
  if (change.oldPath) {
    lines.push(t("Renamed from {0}", change.oldPath));
  }
  lines.push(t("Status: {0}", statusLabel(change.status)), formatStat(change), record.worktreePath);
  return lines.join("\n");
}

function statusLabel(status: FileChange["status"]): string {
  switch (status) {
    case "added":
      return t("added");
    case "modified":
      return t("modified");
    case "deleted":
      return t("deleted");
    case "renamed":
      return t("renamed");
    default:
      return t("untracked");
  }
}

/**
 * Colours borrowed from the built-in git decorations rather than picked here:
 * the reviewer already reads green/red/orange that way in the SCM view, and a
 * second colour language for the same three states would only be noise.
 */
function statusIcon(status: FileChange["status"]): vscode.ThemeIcon {
  switch (status) {
    case "added":
      return new vscode.ThemeIcon("diff-added", new vscode.ThemeColor("gitDecoration.addedResourceForeground"));
    case "modified":
      return new vscode.ThemeIcon("diff-modified", new vscode.ThemeColor("gitDecoration.modifiedResourceForeground"));
    case "deleted":
      return new vscode.ThemeIcon("diff-removed", new vscode.ThemeColor("gitDecoration.deletedResourceForeground"));
    case "renamed":
      return new vscode.ThemeIcon("diff-renamed", new vscode.ThemeColor("gitDecoration.renamedResourceForeground"));
    default:
      // Untracked is "added" as far as the diff goes, but the agent has not
      // staged it — the git palette keeps that distinction, so we keep it too.
      return new vscode.ThemeIcon("diff-added", new vscode.ThemeColor("gitDecoration.untrackedResourceForeground"));
  }
}
