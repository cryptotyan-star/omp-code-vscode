import * as vscode from "vscode";
import { OmpSession, type SessionInfo } from "./ompSession";
import type { SubagentInfo } from "./subagents";
import type { WorkspaceRecord } from "./workspaces/types";
import { t } from "./l10n.ts";

/**
 * A row of the board.
 *
 * Without workspaces the tree is flat — sessions at the root, the subagents omp
 * spawned for a session under it — so one glance covers every agent doing work,
 * the detached ones included, which have no other surface in the UI.
 *
 * Once a workspace exists the root splits in two: a workspace is a branch plus
 * a worktree that outlives any chat, so it has to stay on the board while its
 * agent is stopped. Mixing those rows with ordinary chats would make "is this
 * still running?" unanswerable at a glance, hence the groups.
 */
export type BoardNode =
  | { kind: "group"; id: "workspaces" | "chats" }
  | { kind: "workspace"; record: WorkspaceRecord; info?: SessionInfo }
  | { kind: "session"; info: SessionInfo }
  | { kind: "subagent"; sessionId: string; info: SubagentInfo };

/** The board's read-only view of the workspace layer. */
export interface WorkspaceSource {
  list(): WorkspaceRecord[];
  onDidChange(listener: () => void): { dispose(): void };
}

/**
 * How much a workspace has changed, for the row's `+N −M`.
 *
 * A function rather than a value so the board never asks git anything itself,
 * and optional so it stays a dependency the board can live without: the review
 * layer owns the diff cache, and the board must keep rendering — with no
 * numbers — when that cache is empty, still counting, or not wired up at all.
 * `undefined` means "not counted", which is deliberately different from
 * `{ added: 0, deleted: 0 }` ("counted, and nothing changed").
 */
export type WorkspaceStats = (id: string) => { added: number; deleted: number } | undefined;

/**
 * Listening ports per workspace, out of the port scanner's cache. The same
 * kind of dependency as `WorkspaceStats`: the board asks, is never pushed to,
 * and never scans anything itself.
 */
export type WorkspacePorts = (id: string) => { port: number }[];

/** Task excerpt a subagent tooltip carries: enough to tell two spawns apart. */
const TASK_TOOLTIP_CHARS = 400;

/** Branch marker, matched to the chat tab title so the two rows read alike. */
const BRANCH_MARK = "⎇";

/**
 * The session board: one row per live OmpSession (sidebar view + every chat
 * tab) and one per workspace, with the model, the lifecycle state, the running
 * cost and actions — the oversight surface for parallel chats. Rendered as a
 * native tree view: no CSP, no bundled script, nothing that can silently fail
 * to load.
 */
export class SessionBoardProvider implements vscode.TreeDataProvider<BoardNode>, vscode.Disposable {
  public static readonly viewType = "ompcode.sessions";

  private readonly emitter = new vscode.EventEmitter<BoardNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly changeSub: vscode.Disposable;
  private readonly workspaceSub: { dispose(): void } | undefined;

  constructor(
    private readonly workspaces?: WorkspaceSource,
    private readonly stats?: WorkspaceStats,
    private readonly ports?: WorkspacePorts,
  ) {
    this.changeSub = OmpSession.onBoardChange(() => this.emitter.fire(undefined));
    // A workspace row exists with no session behind it, so the session layer's
    // own change signal cannot be the only thing that repaints the tree.
    this.workspaceSub = workspaces?.onDidChange(() => this.emitter.fire(undefined));
  }

  /** Language changes re-translate the rows without touching the sessions. */
  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(node: BoardNode): vscode.TreeItem {
    switch (node.kind) {
      case "group":
        return this.groupItem(node.id);
      case "workspace":
        return this.workspaceItem(node);
      case "session":
        return this.sessionItem(node.info);
      default:
        return this.subagentItem(node);
    }
  }

  getChildren(element?: BoardNode): BoardNode[] {
    if (!element) {
      const records = this.records();
      // No workspaces, no grouping: a single-chat user should never have to
      // expand a group to reach the only row on the board.
      return records.length === 0
        ? this.sessionNodes()
        : [
            { kind: "group", id: "workspaces" },
            { kind: "group", id: "chats" },
          ];
    }
    if (element.kind === "group") {
      return element.id === "workspaces" ? this.workspaceNodes() : this.chatNodes();
    }
    if (element.kind === "workspace") {
      return element.info ? this.subagentNodes(element.info) : [];
    }
    if (element.kind === "session") {
      return this.subagentNodes(element.info);
    }
    return [];
  }

  /** Needed by `TreeView.reveal`, which walks a node up to the root. */
  getParent(node: BoardNode): BoardNode | undefined {
    const records = this.records();
    switch (node.kind) {
      case "group":
        return undefined;
      case "workspace":
        return { kind: "group", id: "workspaces" };
      case "session":
        // Flat root while no workspace exists; grouped once one does.
        return records.length === 0 ? undefined : { kind: "group", id: "chats" };
      default: {
        const parent = SessionBoardProvider.findSession(node.sessionId);
        if (!parent) {
          return undefined;
        }
        const info = parent.snapshot();
        // A subagent hangs under whichever row actually shows its session: the
        // workspace row when the session belongs to one, the chat row otherwise.
        const record = records.find((candidate) => candidate.id === info.workspaceId);
        return record ? { kind: "workspace", record, info } : { kind: "session", info };
      }
    }
  }

  /**
   * Look a session up by whatever the tree hands back to commands: a board row
   * id, a session node, a workspace node (which resolves to its live session,
   * if it has one) or a subagent node (which resolves to its owner).
   */
  static findSession(target: string | BoardNode): OmpSession | undefined {
    const id = SessionBoardProvider.sessionIdOf(target);
    if (!id) {
      return undefined;
    }
    return OmpSession.allSessions().find((session) => session.snapshot().id === id);
  }

  private static sessionIdOf(target: string | BoardNode): string | undefined {
    if (typeof target === "string") {
      return target || undefined;
    }
    switch (target.kind) {
      case "group":
        return undefined;
      case "workspace":
        return target.info?.id || undefined;
      case "session":
        return target.info.id || undefined;
      default:
        return target.sessionId || undefined;
    }
  }

  private records(): WorkspaceRecord[] {
    return this.workspaces?.list() ?? [];
  }

  private sessionNodes(): BoardNode[] {
    return OmpSession.allSessions().map((session) => ({
      kind: "session" as const,
      info: session.snapshot(),
    }));
  }

  private workspaceNodes(): BoardNode[] {
    const live = OmpSession.allSessions().map((session) => session.snapshot());
    return this.records().map((record) => ({
      kind: "workspace" as const,
      record,
      info: live.find((info) => info.workspaceId === record.id),
    }));
  }

  /** Sessions that belong to no workspace — including orphans of a removed one. */
  private chatNodes(): BoardNode[] {
    const ids = new Set(this.records().map((record) => record.id));
    return this.sessionNodes().filter(
      (node) => node.kind === "session" && !(node.info.workspaceId && ids.has(node.info.workspaceId)),
    );
  }

  private subagentNodes(info: SessionInfo): BoardNode[] {
    return subagentsOf(info).map((sub) => ({
      kind: "subagent" as const,
      sessionId: info.id,
      info: sub,
    }));
  }

  private groupItem(id: "workspaces" | "chats"): vscode.TreeItem {
    const item = new vscode.TreeItem(
      id === "workspaces" ? t("Workspaces") : t("Chats"),
      vscode.TreeItemCollapsibleState.Expanded,
    );
    item.id = `grp:${id}`;
    item.contextValue = `group-${id}`;
    return item;
  }

  private workspaceItem(node: { record: WorkspaceRecord; info?: SessionInfo }): vscode.TreeItem {
    const { record, info } = node;
    const children = info ? subagentsOf(info).length > 0 : false;
    const item = new vscode.TreeItem(
      record.name,
      children
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );
    // Namespaced: a workspace id and a session id are both opaque strings and
    // must never collide on the same tree.
    item.id = `ws:${record.id}`;
    item.description = this.describeWorkspace(record, info);
    item.tooltip = this.workspaceTooltip(record, info);
    // A stopped workspace is still a branch on disk, so it keeps a branch icon
    // rather than borrowing the idle-session dot.
    item.iconPath = new vscode.ThemeIcon(info ? this.icon(info.status) : "git-branch");
    item.contextValue = `workspace-${info ? info.status : "stopped"}`;
    item.command = {
      command: "ompcode.workspace.reveal",
      title: t("Open workspace"),
      arguments: [node],
    };
    return item;
  }

  private sessionItem(info: SessionInfo): vscode.TreeItem {
    const label = info.title || "OMP Code";
    // Subagents are the reason to look at the board, so a session that has any
    // opens on its own rather than hiding them behind a twistie.
    const children = subagentsOf(info).length > 0;
    const item = new vscode.TreeItem(
      label,
      children
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );
    item.id = info.id;
    item.description = this.describe(info);
    item.tooltip = this.tooltip(info);
    item.iconPath = new vscode.ThemeIcon(this.icon(info.status));
    // `status` drives the when-clauses; `-closable` adds the close button.
    item.contextValue = info.status + (info.closable ? "-closable" : "");
    // Clicking a row brings that session's chat surface to the front.
    item.command = {
      command: "ompcode.sessionReveal",
      title: "Reveal",
      arguments: [info.id],
    };
    return item;
  }

  private subagentItem(node: { sessionId: string; info: SubagentInfo }): vscode.TreeItem {
    const sub = node.info;
    const label = sub.description || sub.agent || t("subagent");
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
    // Two sessions can host subagents with the same omp-side id, so the row key
    // has to carry the owner as well or the tree collapses them into one row.
    item.id = `${node.sessionId}/${sub.id}`;
    item.description = this.describeSubagent(sub);
    item.tooltip = this.subagentTooltip(sub);
    item.iconPath = new vscode.ThemeIcon(this.subagentIcon(sub.status));
    item.contextValue = `subagent-${sub.status}`;
    // Subagents have no chat surface — the JSONL transcript is the only way to
    // see what one actually did.
    item.command = {
      command: "ompcode.subagentTranscript",
      title: t("Open subagent transcript"),
      arguments: [node],
    };
    return item;
  }

  private describe(info: SessionInfo): string {
    const parts: string[] = [];
    const model = modelLabel(info);
    if (model) {
      parts.push(model);
    }
    const status = this.statusLabel(info.status);
    if (status) {
      parts.push(status);
    }
    if (info.cost > 0) {
      parts.push(formatCost(info.cost));
    }
    return parts.join(" · ");
  }

  private describeWorkspace(record: WorkspaceRecord, info?: SessionInfo): string {
    // The branch is what makes two workspaces different, so it leads the row
    // even when the agent is stopped and there is nothing else to show.
    const parts: string[] = [`${BRANCH_MARK} ${record.branch}`];
    // Right after the branch: comparing three agents is comparing how much each
    // wrote, and that has to be legible without expanding anything. Read from
    // the review layer's cache, never computed here — a `getTreeItem` that
    // shelled out to git would run once per row on every repaint.
    const churn = this.churn(record.id);
    if (churn) {
      parts.push(churn);
    }
    // Untranslated like the churn: an arrow and a number read the same in
    // every language. One mark per port, so two servers never read as one.
    const ports = this.ports?.(record.id) ?? [];
    if (ports.length > 0) {
      parts.push(ports.map((p) => `⇡ ${p.port}`).join(" "));
    }
    const model = (info ? modelLabel(info) : "") || record.model || "";
    if (model) {
      parts.push(model);
    }
    parts.push(this.workspaceStatusLabel(record, info));
    if (info && info.cost > 0) {
      parts.push(formatCost(info.cost));
    }
    return parts.join(" · ");
  }

  /**
   * `+N −M`, or nothing at all.
   *
   * An untouched workspace says nothing rather than `+0 −0`: a row that reads
   * "zero" and a row whose diff has not been counted yet would look identical,
   * and the honest answer for both is silence. Not translated — it is two
   * numbers and two signs, and the signs are the same in every language.
   */
  private churn(id: string): string {
    // The review layer computes diffs lazily and can throw while a worktree is
    // mid-write; a failed count must cost the row its numbers, not its row.
    let counts: { added: number; deleted: number } | undefined;
    try {
      counts = this.stats?.(id);
    } catch {
      return "";
    }
    if (!counts || (counts.added === 0 && counts.deleted === 0)) {
      return "";
    }
    // U+2212 MINUS, not a hyphen: it lines up with the plus at the same weight.
    return `+${counts.added} −${counts.deleted}`;
  }

  private describeSubagent(sub: SubagentInfo): string {
    const parts: string[] = [];
    // A subagent can run on a different provider than its parent session, so
    // the model belongs on the row, not just in the tooltip.
    if (sub.resolvedModel) {
      parts.push(sub.resolvedModel);
    }
    if (sub.currentTool) {
      parts.push(sub.currentTool);
    }
    if (sub.cost > 0) {
      parts.push(formatCost(sub.cost));
    }
    if (sub.tokens > 0) {
      parts.push(formatTokens(sub.tokens));
    }
    return parts.join(" · ");
  }

  private tooltip(info: SessionInfo): string {
    const lines = [info.title || t("Untitled chat"), info.cwd];
    if (info.cost > 0) {
      lines.push(t("Session cost: {0}", `$${info.cost.toFixed(4)}`));
    }
    return lines.join("\n");
  }

  private workspaceTooltip(record: WorkspaceRecord, info?: SessionInfo): string {
    const lines = [
      record.name,
      record.worktreePath,
      t("Branch: {0}", record.branch),
      // The pinned base commit is what every diff of this workspace is taken
      // against, so it belongs where the operator can read it.
      t("Base: {0} ({1})", record.baseRef, record.baseSha.slice(0, 7)),
      t("Status: {0}", this.workspaceStatusLabel(record, info)),
    ];
    const model = (info ? modelLabel(info) : "") || record.model;
    if (model) {
      lines.push(t("Model: {0}", model));
    }
    if (info && info.cost > 0) {
      lines.push(t("Session cost: {0}", `$${info.cost.toFixed(4)}`));
    }
    return lines.join("\n");
  }

  private subagentTooltip(sub: SubagentInfo): string {
    const lines = [sub.description || sub.agent || t("subagent")];
    if (sub.agent) {
      lines.push(
        sub.agentSource
          ? t("Agent: {0} ({1})", sub.agent, sub.agentSource)
          : t("Agent: {0}", sub.agent),
      );
    }
    lines.push(t("Status: {0}", this.subagentStatusLabel(sub.status)));
    if (sub.resolvedModel) {
      lines.push(t("Model: {0}", sub.resolvedModel));
    }
    if (sub.task) {
      lines.push("", truncate(sub.task, TASK_TOOLTIP_CHARS));
    }
    if (sub.sessionFile) {
      lines.push("", sub.sessionFile);
    }
    // omp runs every subagent in yolo mode whatever the parent session was
    // started with — the operator has to be told, not left to assume.
    lines.push("", t("Subagents always run auto-approved, whatever the session's approval mode."));
    return lines.join("\n");
  }

  /** Idle is the absence of news, so a plain chat row says nothing for it. */
  private statusLabel(status: SessionInfo["status"]): string {
    switch (status) {
      case "asks":
        return t("waiting for approval");
      case "working":
        return t("working");
      case "starting":
        return t("starting");
      default:
        return "";
    }
  }

  /**
   * A workspace row always carries a state word: with no agent attached, the
   * absence of one would read as "nothing is happening here" when setup may
   * still be running or may have failed.
   */
  private workspaceStatusLabel(record: WorkspaceRecord, info?: SessionInfo): string {
    if (record.setupState === "running") {
      return t("setting up");
    }
    if (record.setupState === "failed") {
      return t("setup failed");
    }
    if (!info) {
      return t("stopped");
    }
    return this.statusLabel(info.status) || t("idle");
  }

  private subagentStatusLabel(status: SubagentInfo["status"]): string {
    switch (status) {
      case "started":
        return t("running");
      case "completed":
        return t("completed");
      case "failed":
        return t("failed");
      default:
        return t("aborted");
    }
  }

  private icon(status: SessionInfo["status"]): string {
    switch (status) {
      case "starting":
        return "sync~spin";
      case "working":
        return "sparkle";
      case "asks":
        return "warning";
      default:
        return "circle-outline";
    }
  }

  private subagentIcon(status: SubagentInfo["status"]): string {
    switch (status) {
      case "started":
        return "sync~spin";
      case "completed":
        return "pass";
      case "failed":
        return "error";
      default:
        return "circle-slash";
    }
  }

  dispose(): void {
    this.changeSub.dispose();
    this.workspaceSub?.dispose();
    this.emitter.dispose();
  }
}

/**
 * Subagents carried by a session snapshot. Read defensively: the board must
 * still render sessions produced before the session layer starts tracking them.
 */
function subagentsOf(info: SessionInfo): SubagentInfo[] {
  const list = (info as { subagents?: SubagentInfo[] }).subagents;
  return Array.isArray(list) ? list : [];
}

/** "provider/model" when both are known, otherwise whichever half there is. */
function modelLabel(info: SessionInfo): string {
  if (!info.model) {
    return "";
  }
  return info.provider ? `${info.provider}/${info.model}` : info.model;
}

/** Sub-cent costs need four digits to be worth showing at all. */
function formatCost(cost: number): string {
  return `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`;
}

function formatTokens(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
