import * as vscode from "vscode";
import type { Attachment } from "./attachments";
import { OmpSession, type DiffStore } from "./ompSession";

export { ANTHROPIC_KEY_SECRET, MOONSHOT_KEY_SECRET } from "./ompSession";

/**
 * Sidebar chat view (`ompcode.chat`). Thin shell around one OmpSession; the
 * same session class also backs editor-area chat tabs (see extension.ts).
 */
export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  public static readonly viewType = "ompcode.chat";

  private readonly session: OmpSession;

  constructor(
    private readonly context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
    openNewTab: () => void,
    onState?: (state: unknown) => void,
    diffStore?: DiffStore,
  ) {
    this.session = new OmpSession(context, output, {
      onOpenNewTab: openNewTab,
      onState,
      onReveal: () => void vscode.commands.executeCommand("ompcode.chat.focus"),
    }, diffStore);
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    const webview = webviewView.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    this.session.attach(webview);
    webviewView.onDidDispose(() => {
      this.session.detach();
    });
  }

  loginProvider(providerId: string): Promise<void> {
    return this.session.loginProvider(providerId);
  }

  restart(): Promise<void> {
    return this.session.restart();
  }

  showHistory(): void {
    this.session.showHistory();
  }

  /** Forward an editor selection to the sidebar chat's composer. */
  attachContext(attachment: Attachment): void {
    this.session.attachContext(attachment);
  }

  dispose(): void {
    this.session.dispose();
  }
}
