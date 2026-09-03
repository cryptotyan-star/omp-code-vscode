import * as crypto from "node:crypto";
import * as vscode from "vscode";
import type { BoardSnapshot, BoardToHost, HostToBoard } from "./boardTypes.ts";
import { currentBundle, currentLanguage, t } from "./l10n.ts";

/**
 * Everything the board panel needs from the extension. Same snapshot contract
 * as the sidebar board — extension.ts hands both surfaces one cache and one
 * set of refresh triggers.
 */
export interface BoardPanelDeps {
  snapshot(): BoardSnapshot;
  /** Fires when a board-visible value may have moved; the push is throttled. */
  onChange(listener: () => void): vscode.Disposable;
  reveal(id: string): void;
  stop(id: string): void;
  remove(id: string): void;
  /** The orchestrator facade prompt; throws on over-budget / needs_input. */
  prompt(id: string, text: string): Promise<unknown>;
  /** The branch the live workspaces share, when there are any. */
  baseBranch(): string | undefined;
}

/** Trailing-edge throttle window; identical to the sidebar board's. */
const BOARD_FLUSH_MS = 250;

/**
 * The panel speaks one message the sidebar does not: a prompt refusal comes
 * back as `{ t: "promptError", id, message }`, drawn as a `.tool.bad` log
 * line. `HostToBoard` itself is untouched — board.mjs ignores anything whose
 * `t` it does not know.
 */
type HostToBoardPanel =
  | (HostToBoard & { baseBranch?: string })
  | { t: "promptError"; id: string; message: string };

/**
 * The process board as an editor-area webview panel (`ompcode.boardPanel`):
 * the whole docs/design/process-board.mock.html window — tree, tabs, crumbs,
 * stage strip, log, composer, status bar — on the live BoardSnapshot. One
 * panel per window; `ompcode.openBoard` creates or reveals it, the serializer
 * adopts it back after a window reload.
 */
export class BoardPanel implements vscode.Disposable {
  public static readonly viewType = "ompcode.boardPanel";

  private panel: vscode.WebviewPanel | undefined;
  private changes: vscode.Disposable | undefined;
  private flushTimer: NodeJS.Timeout | undefined;
  private flushDirty = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly deps: BoardPanelDeps,
  ) {}

  /** True while the panel exists and is on screen — the poll skips anything else. */
  get active(): boolean {
    return this.panel !== undefined && this.panel.visible;
  }

  /** The command entry: reveal the live panel, or open a new one. */
  show(): void {
    if (this.panel) {
      this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Active);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      BoardPanel.viewType,
      t("Process Board"),
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
      },
    );
    this.bind(panel);
  }

  /**
   * The serializer entry: VS Code kept the panel across a reload and hands it
   * back empty. Rebinding is exactly `show` minus the creation — the webview
   * reloads its HTML, posts `ready`, and the first snapshot follows.
   */
  adopt(panel: vscode.WebviewPanel): void {
    if (this.panel && this.panel !== panel) {
      // A panel already owns the board; a second one would only double every
      // postMessage. The live one wins, the restored shell goes.
      panel.dispose();
      return;
    }
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    this.bind(panel);
  }

  /** Trailing-edge throttle: at most one snapshot per window, last state wins. */
  refresh(): void {
    if (!this.panel || !this.panel.visible) {
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

  private bind(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    panel.webview.html = this.getHtml(panel.webview);
    this.changes?.dispose();
    this.changes = this.deps.onChange(() => this.refresh());
    panel.webview.onDidReceiveMessage((msg: BoardToHost) => this.onMessage(msg));
    panel.onDidDispose(() => {
      this.panel = undefined;
      this.changes?.dispose();
      this.changes = undefined;
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = undefined;
      }
    });
  }

  private post(msg: HostToBoardPanel): void {
    if (this.panel) {
      void this.panel.webview.postMessage(msg);
    }
  }

  private push(): void {
    // The base branch rides along with every snapshot rather than being baked
    // into the HTML: the panel is normally opened *before* any workspace
    // exists, and a `data-base` fixed at bind time then stayed empty for the
    // life of the tab — no breadcrumb, no branch in the status bar.
    const base = (this.deps.baseBranch() ?? "").trim();
    this.post({
      t: "board",
      snapshot: this.deps.snapshot(),
      ...(base ? { baseBranch: base } : {}),
    });
  }

  /**
   * A composer line goes to the workspace's agent through the orchestrator
   * facade — the same one workspace tools use. Its refusals (over budget,
   * blocked on an approval dialog) come back to the panel as a log line.
   */
  private async prompt(id: string, text: string): Promise<void> {
    try {
      await this.deps.prompt(id, text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.post({ t: "promptError", id, message });
      return;
    }
    // A sent prompt moves the row off screen only through the snapshot, so
    // push at once rather than wait out the change event.
    void this.push();
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
      case "prompt":
        void this.prompt(msg.id, msg.text);
        return;
    }
  }

  // ------------------------------------------------------------------- html

  /** Skeleton after BoardViewProvider.getHtml: nonce-locked CSP, bundle baked in. */
  private getHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString("base64");
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "board.css"),
    );
    const jsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "boardPanel.mjs"),
    );
    const cfg = vscode.workspace.getConfiguration("ompcode");
    // A custom accent travels as a data attribute; the renderer validates it
    // and applies it through the CSSOM, since the CSP forbids inline <style>.
    const accent = String(cfg.get<string>("accentColor", "") ?? "").trim();
    // The base branch the workspaces share. First paint only — every snapshot
    // carries the live value, which is what the renderer prefers.
    const base = (this.deps.baseBranch() ?? "").trim();
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
    const orchestrator = esc(t("Orchestrator"));

    // Ids carry the panel- prefix on purpose: board.mjs boots on import and
    // stays inert only while the document has no #tree element.
    return `<!DOCTYPE html>
<html lang="${currentLanguage()}" data-theme="${dark ? "dark" : "light"}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${cssUri.toString()}">
<title>OMP Code</title>
</head>
<body${accent ? ` data-accent="${esc(accent)}"` : ""}${base ? ` data-base="${esc(base)}"` : ""}>
<div class="board-window">
  <aside class="pane">
    <div class="section">
      <span class="chev"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></span>
      <span>${orchestrator}</span>
      <span class="grow"></span>
    </div>
    <div id="panel-orch"></div>
    <div class="section">
      <span class="chev"><svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></span>
      <span>${processes}</span>
      <span class="grow"></span>
      <span class="count" id="panel-cnt-all">0</span>
      <span class="count err" id="panel-cnt-err" hidden>0</span>
    </div>
    <div class="tree" id="panel-tree" role="listbox" aria-label="${processes}"></div>
  </aside>
  <section class="editor" id="panel-editor" aria-live="polite"></section>
  <footer class="status" id="panel-status"></footer>
</div>
<script nonce="${nonce}" type="application/json" id="l10n-bundle">${bundle}</script>
<script nonce="${nonce}" type="module" src="${jsUri.toString()}"></script>
</body>
</html>`;
  }
}
