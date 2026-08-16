import * as crypto from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { OmpProcess, type OmpFrame } from "./ompProcess";
import { syncCustomProviders } from "./modelsSync";

export const ANTHROPIC_KEY_SECRET = "ompcode.anthropicApiKey";
export const MOONSHOT_KEY_SECRET = "ompcode.moonshotApiKey";

interface WebviewMessage {
  t?: string;
  [key: string]: unknown;
}

export interface OmpSessionCallbacks {
  /** Asked by the webview to open a new chat tab (topbar ＋). */
  onOpenNewTab?: () => void;
  /** Session title changed by the agent (used for editor tab titles). */
  onTitle?: (title: string) => void;
}

/**
 * One chat session: a single OmpProcess bridged to exactly one attached
 * webview (the sidebar view or an editor tab panel).
 */
export class OmpSession implements vscode.Disposable {
  private static readonly active = new Set<OmpSession>();

  /** Run fn for every live session (config-change restarts, key updates). */
  static forEachActive(fn: (session: OmpSession) => void): void {
    for (const session of OmpSession.active) {
      fn(session);
    }
  }

  private webview: vscode.Webview | undefined;
  private messageSub: vscode.Disposable | undefined;
  private proc: OmpProcess | undefined;
  private startPromise: Promise<void> | undefined;
  private initialized = false;
  private initDone: Promise<void> = Promise.resolve();
  private initResolve: (() => void) | undefined;
  private initReject: ((err: Error) => void) | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly callbacks: OmpSessionCallbacks = {},
  ) {
    OmpSession.active.add(this);
  }

  dispose(): void {
    OmpSession.active.delete(this);
    this.messageSub?.dispose();
    this.messageSub = undefined;
    this.webview = undefined;
    const proc = this.proc;
    this.proc = undefined;
    this.initialized = false;
    proc?.stop();
  }

  /**
   * Bind the session to a webview. The caller must have set
   * `webview.options` (enableScripts + localResourceRoots) beforehand.
   */
  attach(webview: vscode.Webview): void {
    if (this.webview === webview) {
      return;
    }
    this.detach();
    this.webview = webview;
    webview.html = this.getHtml(webview);
    this.messageSub = webview.onDidReceiveMessage((msg: WebviewMessage) => {
      void this.onWebviewMessage(msg);
    });
  }

  detach(): void {
    this.messageSub?.dispose();
    this.messageSub = undefined;
    this.webview = undefined;
  }

  /** New session in place: RPC + reset the attached webview transcript. */
  async newSession(): Promise<void> {
    try {
      await this.ensureStarted();
      await this.request({ type: "new_session" });
      this.post({ t: "reset" });
      await this.pushState();
    } catch (err) {
      this.reportError("new_session", err);
    }
  }

  /** Stop the current process (if any) and start a fresh one. */
  async restart(): Promise<void> {
    if (!this.proc && !this.webview) {
      return; // never started and no UI — nothing to do
    }
    this.output.appendLine("[omp] restarting agent…");
    const proc = this.proc;
    this.proc = undefined;
    this.initialized = false;
    proc?.stop();
    try {
      await this.ensureStarted();
    } catch (err) {
      this.reportError("restart", err);
    }
  }

  // ------------------------------------------------------------------ process

  private ensureStarted(bootstrapLogin = false): Promise<void> {
    if (this.proc?.running) {
      return Promise.resolve();
    }
    if (!this.startPromise) {
      this.startPromise = this.startProcess(bootstrapLogin).finally(() => {
        this.startPromise = undefined;
      });
    }
    return this.startPromise;
  }

  private async startProcess(bootstrapLogin = false): Promise<void> {
    const stale = this.proc;
    this.proc = undefined;
    this.initialized = false;
    stale?.stop();

    // Deferred settled by initialize() — gates prompts until the agent is negotiated.
    this.initDone = new Promise<void>((resolve, reject) => {
      this.initResolve = resolve;
      this.initReject = reject;
    });
    this.initDone.catch(() => {}); // avoid unhandled rejection when nobody awaits

    this.post({ t: "proc", status: "starting" });

    const cfg = vscode.workspace.getConfiguration("ompcode");
    const ompPath = cfg.get<string>("ompPath", "omp") || "omp";
    const approvalMode = cfg.get<string>("approvalMode", "always-ask");
    const customProviders = cfg.get<Record<string, unknown>>("customProviders", {});

    try {
      await syncCustomProviders(customProviders);
    } catch (err) {
      this.output.appendLine(
        `[omp] models.yml sync failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const env: NodeJS.ProcessEnv = { ...process.env };
    const anthropicKey = await this.context.secrets.get(ANTHROPIC_KEY_SECRET);
    if (anthropicKey) {
      env.ANTHROPIC_API_KEY = anthropicKey;
    }
    const moonshotKey = await this.context.secrets.get(MOONSHOT_KEY_SECRET);
    if (moonshotKey) {
      env.MOONSHOT_API_KEY = moonshotKey;
    }
    if (bootstrapLogin && !env.ANTHROPIC_API_KEY) {
      // omp refuses to start with zero models, but OAuth sign-in needs a live
      // RPC session. A placeholder key makes the static Anthropic catalog load;
      // it is never used for requests — after login we restart without it.
      env.ANTHROPIC_API_KEY = "sk-ant-placeholder-for-oauth-login";
    }
    const bunBin = path.join(os.homedir(), ".bun", "bin");
    const currentPath = env.PATH ?? "";
    if (!currentPath.split(path.delimiter).includes(bunBin)) {
      env.PATH = currentPath ? `${bunBin}${path.delimiter}${currentPath}` : bunBin;
    }

    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();

    const proc = new OmpProcess();
    this.proc = proc;

    let stderrTail = "";
    proc.onStderr((text) => {
      stderrTail = (stderrTail + text).slice(-4000);
      this.output.append(text);
    });
    proc.onFrame((frame) => {
      this.handleFrame(proc, frame);
    });
    proc.onExit((code, signal) => {
      if (this.proc !== proc) {
        return;
      }
      this.initialized = false;
      const detail = `agent exited (code ${code ?? "?"}${signal ? `, signal ${signal}` : ""})`;
      this.initReject?.(new Error(detail));
      this.output.appendLine(`[omp] ${detail}`);
      // omp exits immediately when it has no configured models/keys.
      const needsSetup = /No models available/i.test(stderrTail);
      this.post({ t: "proc", status: "exited", detail, needsSetup });
    });
    proc.onError((err) => {
      if (this.proc !== proc) {
        return;
      }
      this.initialized = false;
      this.initReject?.(err);
      this.output.appendLine(`[omp] process error: ${err.message}`);
      this.post({ t: "proc", status: "error", detail: err.message });
    });

    this.output.appendLine(
      `[omp] starting: ${ompPath} --mode rpc-ui --cwd ${cwd}` +
        (approvalMode !== "always-ask" ? ` --approval-mode ${approvalMode}` : ""),
    );
    proc.start({ ompPath, cwd, env, approvalMode });
  }

  private handleFrame(proc: OmpProcess, frame: OmpFrame): void {
    if (this.proc !== proc) {
      return; // frame from an old process
    }
    if (frame.type === "ready") {
      void this.initialize(proc);
    }
    // Forward ALL non-response frames to the webview.
    this.post({ t: "frame", frame });
    if (frame.type === "extension_ui_request") {
      if (frame.method === "open_url") {
        const url = typeof frame.url === "string" ? frame.url : undefined;
        if (url) {
          void vscode.env.openExternal(vscode.Uri.parse(url));
        }
      } else if (frame.method === "setTitle") {
        const title = typeof frame.title === "string" ? frame.title : undefined;
        if (title) {
          this.callbacks.onTitle?.(title);
        }
      }
    }
  }

  private async initialize(proc: OmpProcess): Promise<void> {
    try {
      await proc.request({ type: "negotiate_protocol", protocolVersion: 2 });
      if (this.proc !== proc) {
        return;
      }
      this.post({ t: "proc", status: "running" });

      // Initial fetches (state is re-fetched after set_* below).
      await proc.request({ type: "get_state" });
      const models = this.extractList(
        await proc.request({ type: "get_available_models" }),
        "models",
      );
      const commands = this.extractList(
        await proc.request({ type: "get_available_commands" }),
        "commands",
      );

      const cfg = vscode.workspace.getConfiguration("ompcode");
      const defaultModel = (cfg.get<string>("defaultModel", "") ?? "").trim();
      if (defaultModel) {
        const slash = defaultModel.indexOf("/");
        if (slash > 0 && slash < defaultModel.length - 1) {
          const provider = defaultModel.slice(0, slash);
          const modelId = defaultModel.slice(slash + 1);
          try {
            await proc.request({ type: "set_model", provider, modelId });
          } catch (err) {
            this.output.appendLine(
              `[omp] set_model "${defaultModel}" failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        } else {
          this.output.appendLine(
            `[omp] ompcode.defaultModel "${defaultModel}" is not "provider/modelId" — skipped`,
          );
        }
      }

      const level = cfg.get<string>("thinkingLevel", "auto");
      try {
        await proc.request({ type: "set_thinking_level", level });
      } catch (err) {
        this.output.appendLine(
          `[omp] set_thinking_level "${level}" failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      if (this.proc !== proc) {
        return;
      }
      const state = await proc.request({ type: "get_state" });

      // Proactively push everything to the webview.
      this.post({ t: "models", models });
      this.post({ t: "commands", commands });
      this.post({ t: "state", state });
      this.initialized = true;
      this.initResolve?.();
      this.output.appendLine("[omp] agent ready");
    } catch (err) {
      if (this.proc !== proc) {
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.initReject?.(new Error(`init failed: ${message}`));
      this.output.appendLine(`[omp] init failed: ${message}`);
      this.post({ t: "proc", status: "error", detail: `init failed: ${message}` });
    }
  }

  // ---------------------------------------------------------- webview bridge

  private async onWebviewMessage(msg: WebviewMessage): Promise<void> {
    try {
      switch (msg.t) {
        case "ready": {
          void this.ensureStarted().catch((err) => this.reportError("start", err));
          const cfg = vscode.workspace.getConfiguration("ompcode");
          this.post({
            t: "boot",
            cfg: {
              defaultModel: cfg.get<string>("defaultModel", ""),
              thinkingLevel: cfg.get<string>("thinkingLevel", "auto"),
            },
          });
          await this.pushKeyStatus();
          if (this.initialized) {
            // Webview was re-created against a live agent — re-hydrate it.
            await this.pushModels();
            await this.pushCommands();
            await this.pushState();
          }
          return;
        }
        case "prompt": {
          const text = typeof msg.text === "string" ? msg.text : "";
          if (!text) {
            return;
          }
          try {
            await this.ensureStarted();
            if (!this.initialized) {
              await this.initDone;
            }
            await this.request({
              type: "prompt",
              message: text,
              streamingBehavior: "steer",
            });
          } catch (err) {
            this.post({ t: "promptFailed" });
            this.reportError("prompt", err);
          }
          return;
        }
        case "abort":
          this.proc?.send({ type: "abort" });
          return;
        case "newSession":
          await this.newSession();
          return;
        case "openNewTab":
          this.callbacks.onOpenNewTab?.();
          return;
        case "setModel":
          await this.request({
            type: "set_model",
            provider: msg.provider,
            modelId: msg.modelId,
          });
          await this.pushState();
          return;
        case "setThinking":
          await this.request({ type: "set_thinking_level", level: msg.level });
          await this.pushState();
          return;
        case "getModels":
          await this.pushModels();
          return;
        case "getState":
          await this.pushState();
          return;
        case "getCommands":
          await this.pushCommands();
          return;
        case "uiResponse":
          if (msg.frame && typeof msg.frame === "object") {
            this.proc?.send(msg.frame as Record<string, unknown>);
          }
          return;
        case "openExternal":
          if (typeof msg.url === "string") {
            void vscode.env.openExternal(vscode.Uri.parse(msg.url));
          }
          return;
        case "setKeys": {
          const anthropic = typeof msg.anthropic === "string" ? msg.anthropic.trim() : "";
          const moonshot = typeof msg.moonshot === "string" ? msg.moonshot.trim() : "";
          if (anthropic) {
            await this.context.secrets.store(ANTHROPIC_KEY_SECRET, anthropic);
          }
          if (moonshot) {
            await this.context.secrets.store(MOONSHOT_KEY_SECRET, moonshot);
          }
          if (anthropic || moonshot) {
            this.output.appendLine("[omp] API keys saved — restarting all sessions");
            OmpSession.forEachActive((session) => {
              void session.restart();
            });
          }
          await this.pushKeyStatus();
          return;
        }
        case "getKeyStatus":
          await this.pushKeyStatus();
          return;
        case "login": {
          const providerId = typeof msg.providerId === "string" ? msg.providerId : "anthropic";
          await this.loginProvider(providerId);
          return;
        }
        case "compact":
          await this.request({ type: "compact" });
          return;
        case "restart":
          await this.restart();
          return;
        default:
          return;
      }
    } catch (err) {
      this.reportError(String(msg.t ?? "message"), err);
    }
  }

  private request(cmd: Record<string, unknown>): Promise<unknown> {
    const proc = this.proc;
    if (!proc?.running) {
      return Promise.reject(new Error("omp agent is not running"));
    }
    return proc.request(cmd);
  }

  /**
   * OAuth sign-in (e.g. Claude Pro/Max subscription). Bootstraps the agent
   * with a placeholder key when it cannot start for lack of models, runs the
   * RPC `login` flow (browser opens via the forwarded open_url frame), then
   * restarts the agent cleanly so it picks up the stored OAuth credential.
   */
  async loginProvider(providerId: string): Promise<void> {
    if (!this.proc?.running) {
      await this.ensureStarted(true);
    }
    if (!this.initialized) {
      await this.initDone;
    }
    this.post({
      t: "frame",
      frame: { type: "notice", level: "info", message: "Opening browser for sign-in…" },
    });
    try {
      await this.request({ type: "login", providerId });
      this.output.appendLine(`[omp] login "${providerId}" succeeded — restarting agent`);
      this.post({
        t: "frame",
        frame: { type: "notice", level: "info", message: "Signed in. Restarting agent…" },
      });
      await this.restart();
    } catch (err) {
      this.reportError(`login ${providerId}`, err);
    }
  }

  private async pushKeyStatus(): Promise<void> {
    const anthropic = Boolean(await this.context.secrets.get(ANTHROPIC_KEY_SECRET));
    const moonshot = Boolean(await this.context.secrets.get(MOONSHOT_KEY_SECRET));
    this.post({ t: "keyStatus", anthropic, moonshot });
  }

  private async pushState(): Promise<void> {
    const state = await this.request({ type: "get_state" });
    this.post({ t: "state", state });
  }

  private async pushModels(): Promise<void> {
    const data = await this.request({ type: "get_available_models" });
    this.post({ t: "models", models: this.extractList(data, "models") });
  }

  private async pushCommands(): Promise<void> {
    const data = await this.request({ type: "get_available_commands" });
    this.post({ t: "commands", commands: this.extractList(data, "commands") });
  }

  private extractList(data: unknown, key: string): unknown[] {
    if (Array.isArray(data)) {
      return data;
    }
    if (data && typeof data === "object") {
      const value = (data as Record<string, unknown>)[key];
      if (Array.isArray(value)) {
        return value;
      }
    }
    return [];
  }

  private post(msg: Record<string, unknown>): void {
    void this.webview?.postMessage(msg);
  }

  private reportError(context: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    this.output.appendLine(`[omp] ${context} failed: ${message}`);
    this.post({
      t: "frame",
      frame: { type: "notice", level: "error", message },
    });
  }

  // ------------------------------------------------------------------- html

  private getHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString("base64");
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "main.css"),
    );
    const jsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "main.js"),
    );
    const csp = [
      `default-src 'none'`,
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${cssUri.toString()}">
<title>OMP Code</title>
</head>
<body>
<div id="app">
  <header class="topbar">
    <div class="topbar-title"><span class="spark">✳</span><span id="session-title">OMP Code</span></div>
    <div class="topbar-actions">
      <button id="btn-new" class="icon-btn" title="New chat tab">＋</button>
      <button id="btn-settings" class="icon-btn" title="Settings">⚙</button>
    </div>
  </header>
  <main id="messages">
    <div class="welcome">
      <div class="welcome-spark">✳</div>
      <h1>What can I help you build?</h1>
      <p class="welcome-sub">Enter to send · Shift+Enter for a new line · type / for commands · Esc to interrupt</p>
    </div>
    <div id="working" class="status-line hidden"><span class="spark spin">✳</span> Working… <span class="dim">esc to interrupt</span></div>
  </main>
  <div id="modal-holder"></div>
  <footer class="composer">
    <div class="composer-box">
      <div id="slash-popup" class="slash-popup hidden"></div>
      <textarea id="input" rows="1" placeholder="Ask OMP Code…"></textarea>
      <div class="composer-row">
        <button id="model-chip" class="chip">model</button>
        <button id="thinking-chip" class="chip">think: auto</button>
        <span id="ctx-chip" class="chip ghost hidden"></span>
        <span class="flex-spacer"></span>
        <button id="btn-send" class="send-btn" title="Send">↑</button>
        <button id="btn-stop" class="send-btn stop hidden" title="Stop">■</button>
      </div>
    </div>
    <div id="proc-banner" class="proc-banner hidden"><span id="proc-msg">Agent is not running.</span> <button id="btn-restart">Restart</button></div>
  </footer>
  <div id="menu-holder"></div>
  <div id="toast-holder"></div>
</div>
<script nonce="${nonce}" src="${jsUri.toString()}"></script>
</body>
</html>`;
  }
}
