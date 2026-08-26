import * as vscode from "vscode";
import { OmpSession, type SessionInfo } from "./ompSession";
import { t } from "./l10n.ts";

/**
 * The session board: one row per live OmpSession (sidebar view + every chat
 * tab), with the model, the lifecycle state, the running cost and actions —
 * the oversight surface for parallel chats. Rendered as a native tree view:
 * no CSP, no bundled script, nothing that can silently fail to load.
 */
export class SessionBoardProvider implements vscode.TreeDataProvider<SessionInfo>, vscode.Disposable {
  public static readonly viewType = "ompcode.sessions";

  private readonly emitter = new vscode.EventEmitter<SessionInfo | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly changeSub: vscode.Disposable;

  constructor() {
    this.changeSub = OmpSession.onBoardChange(() => this.emitter.fire(undefined));
  }

  /** Language changes re-translate the rows without touching the sessions. */
  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(info: SessionInfo): vscode.TreeItem {
    const label = info.title || "OMP Code";
    const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
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

  getChildren(): SessionInfo[] {
    return OmpSession.allSessions().map((session) => session.snapshot());
  }

  /** Look a session up by the board row id the tree hands back to commands. */
  static findSession(id: string): OmpSession | undefined {
    return OmpSession.allSessions().find((session) => session.snapshot().id === id);
  }

  private describe(info: SessionInfo): string {
    const parts: string[] = [];
    if (info.model) {
      parts.push(info.provider ? `${info.provider}/${info.model}` : info.model);
    }
    if (info.status === "asks") {
      parts.push(t("waiting for approval"));
    } else if (info.status === "working") {
      parts.push(t("working"));
    } else if (info.status === "starting") {
      parts.push(t("starting"));
    }
    if (info.cost > 0) {
      parts.push(`$${info.cost < 0.01 ? info.cost.toFixed(4) : info.cost.toFixed(2)}`);
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

  dispose(): void {
    this.changeSub.dispose();
    this.emitter.dispose();
  }
}
