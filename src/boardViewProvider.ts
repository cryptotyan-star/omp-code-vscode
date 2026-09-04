import * as crypto from "node:crypto";
import * as vscode from "vscode";
import type { BoardSnapshot, BoardToHost, HostToBoard } from "./boardTypes.ts";
import { currentBundle, currentLanguage, t } from "./l10n.ts";

/**
 * Everything the board view needs from the extension. `snapshot` is
 * synchronous — whatever assembles it (extension.ts) keeps its own cache, so
 * the throttled push never waits on a promise.
 */
export interface BoardViewDeps {
  snapshot(): BoardSnapshot;
  /** Fires when a board-visible value may have moved; the push is throttled. */
  onChange(listener: () => void): vscode.Disposable;
  reveal(id: string): void;
  stop(id: string): void;
  remove(id: string): void;
}

/** Trailing-edge throttle window; mirrors SUBAGENT_FLUSH_MS in ompSession.ts. */
const BOARD_FLUSH_MS = 250;

/**
 * The process board sidebar view (`ompcode.board`): orchestrator row, the
 * «Процессы» section with its counts badges, one row per workspace, and the
 * totals footer. All rendering lives in media/board.mjs + media/board.css;
 * this class only ships snapshots in and routes the four BoardToHost messages
 * back out.
 */
export class BoardViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = "ompcode.board";

  private view: vscode.WebviewView | undefined;
  private changes: vscode.Disposable | undefined;
  private flushTimer: NodeJS.Timeout | undefined;
  private flushDirty = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly deps: BoardViewDeps,
  ) {}

  /** True while the view exists and is on screen — the poll skips anything else. */
  get active(): boolean {
    return this.view !== undefined && this.view.visible;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    view.webview.html = this.getHtml(view.webview);
    this.changes?.dispose();
    this.changes = this.deps.onChange(() => this.refresh());
    view.webview.onDidReceiveMessage((msg: BoardToHost) => this.onMessage(msg));
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        // The snapshot may have moved while hidden; repaint on the way back.
        this.refresh();
      }
    });
    view.onDidDispose(() => {
      this.view = undefined;
      this.changes?.dispose();
      this.changes = undefined;
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = undefined;
      }
    });
  }

  /** Trailing-edge throttle: at most one snapshot per window, last state wins. */
  refresh(): void {
    if (!this.view || !this.view.visible) {
      return;
    }
    if (this.flushTimer) {
      this.flushDirty = true;
      return;
    }
    this.push();
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      if (this.flushDirty) {
        this.flushDirty = false;
        this.refresh();
      }
    }, BOARD_FLUSH_MS);
  }

  dispose(): void {
    this.changes?.dispose();
    this.changes = undefined;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  private push(): void {
    if (!this.view) {
      return;
    }
    const msg: HostToBoard = { t: "board", snapshot: this.deps.snapshot() };
    void this.view.webview.postMessage(msg);
  }

  private onMessage(msg: BoardToHost): void {
    switch (msg.t) {
      case "ready":
        // The webview just (re)loaded: answer at once, outside the throttle.
        this.push();
        return;
      case "reveal":
        this.deps.reveal(msg.id);
        return;
      case "stop":
        this.deps.stop(msg.id);
        return;
      case "delete":
        this.deps.remove(msg.id);
        return;
    }
  }

  // ------------------------------------------------------------------- html

  /** Skeleton after OmpSession.getHtml: nonce-locked CSP, bundle baked in. */
  private getHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString("base64");
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "board.css"),
    );
    const jsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "board.mjs"),
    );
    const cfg = vscode.workspace.getConfiguration("ompcode");
    // A custom accent travels as a data attribute; board.mjs validates it and
    // applies it through the CSSOM, since the CSP forbids inline <style>.
    const accent = String(cfg.get<string>("accentColor", "") ?? "").trim();
    const kind = vscode.window.activeColorTheme.kind;
    const dark =
      kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast;
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
    ].join("; ");

    const esc = (text: string): string =>
      text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    // `<` is escaped so a translation can never close this script tag early.
    const bundle = JSON.stringify(currentBundle()).replace(/</g, "\\u003c");
    const processes = esc(t("Processes"));

    return `<!DOCTYPE html>
<html lang="${currentLanguage()}" data-theme="${dark ? "dark" : "light"}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${cssUri.toString()}">
<title>OMP Code</title>
</head>
<body${accent ? ` data-accent="${esc(accent)}"` : ""}>
<div class="board">
  <div id="orch"></div>
  <div class="section">
    <span class="chev"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></span>
    <span>${processes}</span>
    <span class="grow"></span>
    <span class="count" id="cnt-all">0</span>
    <span class="count err" id="cnt-err" hidden>0</span>
  </div>
  <div class="tree" id="tree" role="listbox" aria-label="${processes}"></div>
  <div class="sb-foot" id="foot"></div>
</div>
<script nonce="${nonce}" type="application/json" id="l10n-bundle">${bundle}</script>
<script nonce="${nonce}" type="module" src="${jsUri.toString()}"></script>
</body>
</html>`;
  }
}
