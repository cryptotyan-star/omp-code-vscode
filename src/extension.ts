import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { MAX_SNIPPET_CHARS, type Attachment } from "./attachments";
import { ChatViewProvider } from "./chatViewProvider";
import { OmpSession, type DiffStore } from "./ompSession";
import { KEYED_PROVIDERS } from "./providers";

const MODELS_YML_TEMPLATE = `# ~/.omp/agent/models.yml — custom model providers for the omp CLI.
#
# OMP Code merges the VS Code setting "ompcode.customProviders" into this
# file automatically before the agent starts. Existing entries are never
# deleted; same-named providers are overwritten with the configured values.
#
# You can also edit this file by hand. Example (uncomment and adjust):
#
# providers:
#   akemi:
#     baseUrl: "http://host:8000/v1"
#     api: openai-completions
#     apiKey: "sk-..."
#     models:
#       - id: akemi-1
#         name: Akemi
#         contextWindow: 128000
#         maxTokens: 32000
`;

function modelsYmlPath(): string {
  return path.join(os.homedir(), ".omp", "agent", "models.yml");
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("OMP Code");
  output.appendLine("[omp] extension activated");

  /** Chat panels currently open in the editor area, oldest first. */
  const chatPanels = new Map<vscode.WebviewPanel, OmpSession>();

  // Status bar: model + context fill of whichever session reported last.
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "ompcode.openChat";
  statusBar.text = "$(sparkle) OMP Code";
  statusBar.tooltip = "OMP Code — open chat";
  statusBar.show();

  function onSessionState(state: unknown): void {
    const s = state && typeof state === "object" ? (state as Record<string, unknown>) : undefined;
    const model = s?.model;
    let name = "";
    if (typeof model === "string") {
      name = model.slice(model.indexOf("/") + 1) || model;
    } else if (model && typeof model === "object") {
      const m = model as Record<string, unknown>;
      name = String(m.name ?? m.id ?? "");
    }
    let ctx = "";
    const usage = s?.contextUsage;
    const percent =
      usage && typeof usage === "object"
        ? (usage as Record<string, unknown>).percent
        : undefined;
    if (typeof percent === "number" && Number.isFinite(percent)) {
      ctx = ` · ${Math.round(percent)}%`;
    }
    statusBar.text = name ? `$(sparkle) ${name}${ctx}` : "$(sparkle) OMP Code";
    statusBar.tooltip = "OMP Code — open chat";
  }

  /**
   * Where a chat tab belongs: its own group to the right of the code, and every
   * later chat as a tab in that same group rather than yet another split.
   */
  function chatColumn(): vscode.ViewColumn {
    for (const panel of chatPanels.keys()) {
      if (panel.viewColumn !== undefined) {
        return panel.viewColumn;
      }
    }
    return vscode.ViewColumn.Beside;
  }

  /** Open a fresh chat session as its own editor-area tab, to the right. */
  async function openChatTab(): Promise<vscode.WebviewPanel | undefined> {
    // Multi-root: each chat's agent runs in one folder — ask which.
    const folders = vscode.workspace.workspaceFolders ?? [];
    let cwd: string | undefined;
    if (folders.length > 1) {
      const picked = await vscode.window.showWorkspaceFolderPick({
        placeHolder: "Which folder should this chat's agent work in?",
      });
      if (!picked) {
        return undefined; // cancelled — no tab without a folder
      }
      cwd = picked.uri.fsPath;
    }
    const panel = vscode.window.createWebviewPanel(
      "ompcode.chatTab",
      "OMP Code",
      chatColumn(),
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
      },
    );
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.svg");
    const session = new OmpSession(context, output, {
      onOpenNewTab: () => {
        void openChatTab();
      },
      onTitle: (title) => {
        panel.title = title;
      },
      onState: onSessionState,
      onReveal: () => {
        panel.reveal(panel.viewColumn ?? vscode.ViewColumn.Beside);
      },
    }, diffStore, cwd);
    chatPanels.set(panel, session);
    panel.onDidDispose(() => {
      chatPanels.delete(panel);
      session.dispose();
    });
    session.attach(panel.webview);
    return panel;
  }

  /** Reveal the existing chat tab if there is one, otherwise open the first. */
  async function revealChatTab(): Promise<OmpSession | undefined> {
    for (const [panel, session] of chatPanels) {
      panel.reveal(panel.viewColumn ?? vscode.ViewColumn.Beside);
      return session;
    }
    const panel = await openChatTab();
    return panel ? chatPanels.get(panel) : undefined;
  }

  /**
   * Read-only documents holding a file's pre-edit content, so "Open diff" can
   * diff the snapshot against the live file. Content addressed by URI path;
   * the store evicts oldest-first past 50 entries.
   */
  const diffContents = new Map<string, string>();
  const diffStore: DiffStore = {
    put(toolCallId, filePath, content) {
      const uri = vscode.Uri.from({
        scheme: "ompcode-diff",
        path: `/${toolCallId}/${path.basename(filePath)}`,
      });
      diffContents.set(uri.path, content);
      if (diffContents.size > 50) {
        const oldest = diffContents.keys().next().value;
        if (oldest !== undefined) {
          diffContents.delete(oldest);
        }
      }
      return uri;
    },
  };

  const provider = new ChatViewProvider(context, output, () => {
    openChatTab();
  }, onSessionState, diffStore);

  function restartAllSessions(): Promise<void> {
    const sessions: Promise<void>[] = [];
    OmpSession.forEachActive((session) => {
      sessions.push(session.restart());
    });
    return Promise.all(sessions).then(() => undefined);
  }

  async function setKeyCommand(
    label: string,
    secretKey: string,
    placeHolder: string,
    envVar: string,
  ): Promise<void> {
    const value = await vscode.window.showInputBox({
      title: `OMP Code: ${label} API Key`,
      prompt: `Stored in VS Code Secret Storage and passed to the omp agent as ${envVar}. Leave empty to clear.`,
      password: true,
      ignoreFocusOut: true,
      placeHolder,
    });
    if (value === undefined) {
      return; // cancelled
    }
    const trimmed = value.trim();
    if (trimmed) {
      await context.secrets.store(secretKey, trimmed);
    } else {
      await context.secrets.delete(secretKey);
    }
    const action = await vscode.window.showInformationMessage(
      `${label} API key ${trimmed ? "saved" : "cleared"}. Restart the agent to apply it.`,
      "Restart Agent",
    );
    if (action === "Restart Agent") {
      await restartAllSessions();
    }
  }

  context.subscriptions.push(
    output,
    provider,
    statusBar,
    vscode.workspace.registerTextDocumentContentProvider("ompcode-diff", {
      provideTextDocumentContent: (uri) => diffContents.get(uri.path) ?? "",
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      // Palette changes are cosmetic: pushing them beats killing a live agent.
      const themeOnly =
        (e.affectsConfiguration("ompcode.theme") || e.affectsConfiguration("ompcode.accentColor")) &&
        ["ompPath", "customProviders", "defaultModel", "verifyModels", "hideStartupNotices", "thinkingLevel", "approvalMode"]
          .every((key) => !e.affectsConfiguration(`ompcode.${key}`));
      if (themeOnly) {
        output.appendLine("[omp] palette changed — updating webviews");
        OmpSession.forEachActive((session) => session.pushTheme());
        return;
      }
      if (e.affectsConfiguration("ompcode")) {
        output.appendLine("[omp] configuration changed — restarting all sessions");
        void restartAllSessions();
      }
    }),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),

    vscode.commands.registerCommand("ompcode.newSession", () => void openChatTab()),

    // Title-bar entry point: the chat opens as an editor tab beside the code,
    // not as the left sidebar view.
    vscode.commands.registerCommand("ompcode.openChat", () => void revealChatTab()),

    vscode.commands.registerCommand("ompcode.showHistory", async () => {
      (await revealChatTab())?.showHistory();
    }),

    ...KEYED_PROVIDERS.map((p) =>
      vscode.commands.registerCommand(p.commandId, () =>
        setKeyCommand(p.label, p.secret, p.placeholder, p.envVar),
      ),
    ),

    vscode.commands.registerCommand("ompcode.diagnostics", async () => {
      const session = OmpSession.anyActive();
      if (!session) {
        await vscode.commands.executeCommand("ompcode.chat.focus");
      }
      await (OmpSession.anyActive() ?? session)?.openDiagnostics();
    }),

    vscode.commands.registerCommand("ompcode.clearKeys", async () => {
      // A stale key is worse than no key: omp lists the provider's whole model
      // range and every one of them answers 401.
      const picked = await vscode.window.showQuickPick(
        KEYED_PROVIDERS.map((p) => ({ label: `${p.label} API key`, secret: p.secret })),
        { title: "OMP Code: Clear stored API key", placeHolder: "Subscription sign-ins are not affected" },
      );
      if (!picked) return;
      await context.secrets.delete(picked.secret);
      const action = await vscode.window.showInformationMessage(
        `${picked.label} cleared. Restart the agent to apply it.`,
        "Restart Agent",
      );
      if (action === "Restart Agent") {
        await restartAllSessions();
      }
    }),

    vscode.commands.registerCommand("ompcode.setProviderKey", async () => {
      // Provider API keys live in Secret Storage (not the plaintext settings JSON).
      const cfg = vscode.workspace.getConfiguration("ompcode");
      const providers = cfg.get<Record<string, unknown>>("customProviders", {});
      const names = Object.keys(providers).sort();
      if (!names.length) {
        const action = await vscode.window.showInformationMessage(
          "No custom providers configured. Add one under \"ompcode.customProviders\" first.",
          "Open models.yml",
        );
        if (action === "Open models.yml") {
          await vscode.commands.executeCommand("ompcode.openModelsConfig");
        }
        return;
      }
      const name = await vscode.window.showQuickPick(names, {
        title: "OMP Code: Provider API key",
        placeHolder: "Select a custom provider",
      });
      if (!name) return;
      const secretKey = `ompcode.providerKey.${name}`;
      const value = await vscode.window.showInputBox({
        title: `OMP Code: ${name} API key`,
        prompt: `Stored in Secret Storage and injected into the "${name}" provider in models.yml. Leave empty to clear.`,
        password: true,
        ignoreFocusOut: true,
        placeHolder: "sk-…",
      });
      if (value === undefined) return;
      const trimmed = value.trim();
      if (trimmed) {
        await context.secrets.store(secretKey, trimmed);
      } else {
        await context.secrets.delete(secretKey);
      }
      const action = await vscode.window.showInformationMessage(
        `${name} API key ${trimmed ? "saved" : "cleared"}. Restart the agent to apply it.`,
        "Restart Agent",
      );
      if (action === "Restart Agent") {
        await restartAllSessions();
      }
    }),

    vscode.commands.registerCommand("ompcode.openModelsConfig", async () => {
      const file = modelsYmlPath();
      await fs.mkdir(path.dirname(file), { recursive: true });
      try {
        await fs.access(file);
      } catch {
        await fs.writeFile(file, MODELS_YML_TEMPLATE, "utf8");
      }
      const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      await vscode.window.showTextDocument(doc, { preview: false });
    }),

    vscode.commands.registerCommand("ompcode.restart", () => restartAllSessions()),

    vscode.commands.registerCommand("ompcode.exportTranscript", async () => {
      const session = OmpSession.anyActive();
      if (!session) {
        await vscode.window.showInformationMessage("OMP Code: open a chat first.");
        return;
      }
      await session.exportTranscript();
    }),

    // Editor context menu: send the current selection to the chat the user
    // sees — an active chat tab first, then the most recent one, then the
    // sidebar view (which always exists once the extension is up).
    vscode.commands.registerCommand("ompcode.addSelectionToChat", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty || editor.document.uri.scheme !== "file") {
        return;
      }
      const doc = editor.document;
      const sel = editor.selection;
      let snippet = doc.getText(sel);
      if (snippet.length > MAX_SNIPPET_CHARS) {
        snippet = snippet.slice(0, MAX_SNIPPET_CHARS);
      }
      // A selection ending exactly at a line boundary does not include that
      // trailing empty line — report the range the user actually highlighted.
      const startLine = sel.start.line + 1;
      const endLine =
        sel.end.character === 0 && sel.end.line > sel.start.line
          ? sel.end.line
          : sel.end.line + 1;
      const attachment: Attachment = {
        path: doc.uri.fsPath,
        name: path.basename(doc.uri.fsPath),
        size: Buffer.byteLength(snippet),
        selection: { startLine, endLine },
        snippet,
        language: doc.languageId,
      };
      for (const [panel, session] of chatPanels) {
        if (panel.active) {
          session.attachContext(attachment);
          return;
        }
      }
      const last = [...chatPanels].pop();
      if (last) {
        last[0].reveal(last[0].viewColumn ?? vscode.ViewColumn.Beside);
        last[1].attachContext(attachment);
        return;
      }
      provider.attachContext(attachment);
      // No chat tab open — surface the sidebar view so the chip is visible.
      void vscode.commands.executeCommand("ompcode.chat.focus");
    }),

    // Live "current file" chip in every chat composer.
    vscode.window.onDidChangeActiveTextEditor(() => {
      OmpSession.forEachActive((session) => session.pushActiveFile());
    }),

    // Sign-in runs on the chat the user can actually see, so its agent is the
    // one that restarts with the fresh credential.
    vscode.commands.registerCommand("ompcode.loginClaude", async () => {
      await (await revealChatTab())?.loginProvider("anthropic");
    }),

    vscode.commands.registerCommand("ompcode.loginKimi", async () => {
      await (await revealChatTab())?.loginProvider("kimi-code");
    }),
  );
}

export function deactivate(): void {
  // Stop every live session's omp process so we don't leave orphans on
  // extension deactivation (editor tabs + sidebar share OmpSession.active).
  OmpSession.forEachActive((session) => session.dispose());
}
