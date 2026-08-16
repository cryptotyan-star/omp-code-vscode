import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { ChatViewProvider, ANTHROPIC_KEY_SECRET, MOONSHOT_KEY_SECRET } from "./chatViewProvider";
import { OmpSession } from "./ompSession";

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

  /** Open a fresh chat session as its own editor-area tab. */
  async function openChatTab(): Promise<void> {
    const panel = vscode.window.createWebviewPanel(
      "ompcode.chatTab",
      "OMP Code",
      vscode.ViewColumn.Active,
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
    });
    panel.onDidDispose(() => session.dispose());
    session.attach(panel.webview);
  }

  const provider = new ChatViewProvider(context, output, () => {
    void openChatTab();
  });

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
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("ompcode")) {
        output.appendLine("[omp] configuration changed — restarting all sessions");
        void restartAllSessions();
      }
    }),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),

    vscode.commands.registerCommand("ompcode.newSession", () => openChatTab()),

    vscode.commands.registerCommand("ompcode.setAnthropicKey", () =>
      setKeyCommand("Anthropic", ANTHROPIC_KEY_SECRET, "sk-ant-…", "ANTHROPIC_API_KEY"),
    ),

    vscode.commands.registerCommand("ompcode.setKimiKey", () =>
      setKeyCommand("Kimi (Moonshot)", MOONSHOT_KEY_SECRET, "sk-…", "MOONSHOT_API_KEY"),
    ),

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

    vscode.commands.registerCommand("ompcode.loginClaude", async () => {
      await vscode.commands.executeCommand("ompcode.chat.focus");
      await provider.loginProvider("anthropic");
    }),

    vscode.commands.registerCommand("ompcode.loginKimi", async () => {
      await vscode.commands.executeCommand("ompcode.chat.focus");
      await provider.loginProvider("kimi-code");
    }),
  );
}

export function deactivate(): void {
  // Cleanup happens via context.subscriptions (provider.dispose stops the process).
}
