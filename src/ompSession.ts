import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { OmpProcess, type OmpFrame } from "./ompProcess";
import { syncCustomProviders } from "./modelsSync";
import { isNoisyNotice } from "./notices";
import { runDiagnostics } from "./diagnostics";
import { formatTranscript, listSessions } from "./sessions";
import {
  composePrompt,
  formatSize,
  MAX_ATTACHMENT_BYTES,
  MAX_SNIPPET_CHARS,
  parseUriList,
  safeFileName,
  type Attachment,
} from "./attachments";
import {
  isCacheFresh,
  isProviderLevelFailure,
  modelKey,
  probeModels,
  type ProbeCandidate,
  type ProbeResults,
} from "./probe";
import { KEYED_PROVIDERS } from "./providers";
import { needsManualLoad, readInstructionFile } from "./instructionFiles";
import { currentBundle, currentLanguage, t } from "./l10n.ts";
import { overlayArgs, writeAppendPrompt, writeOverlay } from "./profileOverlay";
import {
  isValidProfileRow,
  resolveProfile,
  spawnSignature,
  type MatchableModel,
  type ModelProfile,
  type ResolvedProfile,
} from "./modelProfiles";

/** globalState key holding the last probe verdicts, shared by every session. */
const PROBE_STATE_KEY = "ompcode.probeResults";

/**
 * omp's three approval tiers (`--approval-mode`). Native harnesses have four
 * to six modes each — Claude Code alone has six — so the picker presents
 * these as the nearest rung, never as an equivalence.
 */
export const APPROVAL_MODES = ["always-ask", "write", "yolo"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

interface WebviewMessage {
  t?: string;
  [key: string]: unknown;
}

export interface OmpSessionCallbacks {
  /** Asked by the webview to open a new chat tab (topbar ＋). */
  onOpenNewTab?: () => void;
  /** Session title changed by the agent (used for editor tab titles). */
  onTitle?: (title: string) => void;
  /** Fresh agent state — drives the status bar item. */
  onState?: (state: unknown) => void;
  /** Bring this session's UI to the front (notification "Open chat"). */
  onReveal?: () => void;
}

/**
 * Stores "before" file contents for the diff editor. Implemented in
 * extension.ts, where the TextDocumentContentProvider is registered.
 */
export interface DiffStore {
  put(toolCallId: string, filePath: string, content: string): vscode.Uri;
}

/** A file's state captured just before an edit/write tool ran. */
interface ToolSnapshot {
  path: string;
  before: string;
}

/** Identity of a diagnostic for before/after delta — position + text. */
function diagKey(d: vscode.Diagnostic): string {
  return `${d.range.start.line}:${d.range.start.character}:${d.severity}:${d.message}`;
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

  /** Any live session — commands that need one but don't care which. */
  static anyActive(): OmpSession | undefined {
    for (const session of OmpSession.active) {
      return session;
    }
    return undefined;
  }

  private webview: vscode.Webview | undefined;
  private messageSub: vscode.Disposable | undefined;
  private proc: OmpProcess | undefined;
  private startPromise: Promise<void> | undefined;
  private initialized = false;
  private initDone: Promise<void> = Promise.resolve();
  private initResolve: (() => void) | undefined;
  private initReject: ((err: Error) => void) | undefined;
  /** Last known streaming state — drives `streamingBehavior:"steer"` on prompts. */
  private streaming = false;
  /** showHistory() asked before the webview was listening; replayed on ready. */
  private pendingShowHistory = false;
  /** Webview script signalled `ready`; gates messages that need a live listener. */
  private webviewReady = false;
  /** Editor selections attached before the webview could receive them. */
  private pendingContexts: Attachment[] = [];
  /** One resume attempt per session — never on webview re-attach. */
  private resumeAttempted = false;
  /** Spawn parameters of the live agent, reused verbatim by the prober. */
  private launch:
    | { ompPath: string; cwd: string; env: NodeJS.ProcessEnv; injectedEnvKeys: string[] }
    | undefined;
  /** One probe run at a time across all sessions — verdicts are global. */
  private static probeRun: Promise<void> | undefined;
  private static probeCancelled = false;

  /** "Before" contents of files touched by edit/write tools, by toolCallId. */
  private readonly diffSnaps = new Map<string, ToolSnapshot>();
  /** Diagnostics captured before the first pending edit, by file path. */
  private readonly diagBaseline = new Map<string, Set<string>>();
  /** Trailing debounce per file so a burst of edits reports once. */
  private readonly diagTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly callbacks: OmpSessionCallbacks = {},
    private readonly diffStore?: DiffStore,
    /** Multi-root workspaces: the folder this session's agent runs in. */
    private readonly sessionCwd?: string,
  ) {
    OmpSession.active.add(this);
  }

  /** Agent working directory: the picked folder, else the first workspace root. */
  private workspaceCwd(): string {
    return (
      this.sessionCwd ??
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
      os.homedir()
    );
  }

  dispose(): void {
    OmpSession.active.delete(this);
    this.messageSub?.dispose();
    this.messageSub = undefined;
    this.webview = undefined;
    for (const timer of this.diagTimers.values()) {
      clearTimeout(timer);
    }
    this.diagTimers.clear();
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
    this.webviewReady = false;
    this.webview = webview;
    webview.html = this.getHtml(webview);
    this.messageSub = webview.onDidReceiveMessage((msg: WebviewMessage) => {
      void this.onWebviewMessage(msg);
    });
  }

  /**
   * Rebuild the webview HTML in place. The translation bundle is baked into
   * the markup, so a language change cannot be pushed as a message — the
   * skeleton itself has to be regenerated.
   */
  reloadHtml(): void {
    const webview = this.webview;
    if (!webview) {
      return;
    }
    this.webviewReady = false;
    webview.html = this.getHtml(webview);
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
      this.diffSnaps.clear();
      this.diagBaseline.clear();
      this.post({ t: "reset" });
      await this.pushState();
    } catch (err) {
      this.reportError("new_session", err);
    }
  }

  /** Note the live conversation's JSONL path so a restart can reattach to it. */
  private rememberSessionFile(state: unknown): void {
    const file =
      state && typeof state === "object"
        ? (state as Record<string, unknown>).sessionFile
        : undefined;
    if (typeof file === "string" && file) {
      this.lastSessionFile = file;
    }
  }

  /**
   * Reattach a freshly restarted agent to the conversation it was serving.
   *
   * omp starts a brand-new session on spawn, so without this the agent has no
   * memory of a chat the webview is still displaying. `sessionFile` is
   * optional in the RPC state, so when it is missing the transcript is cleared
   * instead — an empty chat is honest, a stale one is not.
   */
  private async resumeAfterRestart(previous: string | undefined): Promise<boolean> {
    if (!previous) {
      this.post({ t: "reset" });
      return false;
    }
    try {
      const result = (await this.request({ type: "switch_session", sessionPath: previous })) as
        | { cancelled?: boolean }
        | undefined;
      if (result?.cancelled) {
        this.post({ t: "reset" });
        return false;
      }
      const data = await this.request({ type: "get_messages" });
      this.post({ t: "reset" });
      this.post({ t: "transcript", messages: this.extractList(data, "messages") });
      this.lastSessionFile = previous;
      this.output.appendLine(`[omp] reattached to ${previous}`);
      return true;
    } catch (err) {
      // Reattaching is best-effort; a failure must not leave the webview
      // showing history the new agent does not have.
      this.output.appendLine(`[omp] could not reattach: ${String(err)}`);
      this.post({ t: "reset" });
      return false;
    }
  }

  /** Stop the current process (if any) and start a fresh one. */
  async restart(): Promise<void> {
    if (!this.proc && !this.webview) {
      return; // never started and no UI — nothing to do
    }
    this.output.appendLine("[omp] restarting agent…");
    const previousSession = this.lastSessionFile;
    const proc = this.proc;
    this.proc = undefined;
    this.initialized = false;
    this.autoRestartAttempts = 0;
    proc?.stop();
    try {
      await this.ensureStarted();
      // ensureStarted resolves once the child is spawned; initDone resolves
      // when the handshake is through, which is what "restarted" should mean.
      await this.initDone;
      const resumed = await this.resumeAfterRestart(previousSession);
      const model = await this.currentModel().catch(() => undefined);
      this.post({
        t: "frame",
        frame: {
          type: "notice",
          level: "info",
          message:
            (model
              ? t("Agent restarted — {0}/{1}.", model.provider, model.id)
              : t("Agent restarted.")) +
            (resumed ? "" : " " + t("The conversation was not carried over.")),
        },
      });
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

  /**
   * Environment for the agent: Secret Storage keys as provider env vars, plus
   * ~/.bun/bin on PATH (VS Code does not inherit a login shell's PATH).
   * Returns the injected variable *names* so diagnostics can report them
   * without ever touching their values.
   */
  private async buildEnv(
    bootstrapLogin = false,
  ): Promise<{ env: NodeJS.ProcessEnv; injectedEnvKeys: string[] }> {
    const env: NodeJS.ProcessEnv = { ...process.env };
    const injectedEnvKeys: string[] = [];
    for (const p of KEYED_PROVIDERS) {
      const key = await this.context.secrets.get(p.secret);
      if (key) {
        env[p.envVar] = key;
        injectedEnvKeys.push(p.envVar);
      }
    }
    if (bootstrapLogin && !env.ANTHROPIC_API_KEY) {
      // omp refuses to start with zero models, but OAuth sign-in needs a live
      // RPC session. A placeholder key makes the static Anthropic catalog load;
      // it is never used for requests — after login we restart without it.
      env.ANTHROPIC_API_KEY = "sk-ant-placeholder-for-oauth-login";
      injectedEnvKeys.push("ANTHROPIC_API_KEY (OAuth bootstrap placeholder)");
    }
    const bunBin = path.join(os.homedir(), ".bun", "bin");
    const currentPath = env.PATH ?? "";
    if (!currentPath.split(path.delimiter).includes(bunBin)) {
      env.PATH = currentPath ? `${bunBin}${path.delimiter}${currentPath}` : bunBin;
    }
    return { env, injectedEnvKeys };
  }

  /**
   * `--config` / `--append-system-prompt` arguments for the profile this
   * process will run under.
   *
   * Never throws: a profile that cannot be materialised must degrade to the
   * agent's normal behaviour rather than stopping it from starting.
   */
  private async profileSpawnArgs(cwd: string): Promise<string[]> {
    try {
      const cfg = vscode.workspace.getConfiguration("ompcode");
      const target = cfg.get<string>("defaultModel", "").trim();
      if (!target) {
        return []; // nothing to resolve against until a model is picked
      }
      const slash = target.indexOf("/");
      const profile = resolveProfile(
        slash > 0
          ? { provider: target.slice(0, slash), id: target.slice(slash + 1) }
          : { id: target },
        this.userProfiles(),
      );

      const dir = path.join(this.context.globalStorageUri.fsPath, "profiles");
      const overlayPath = await writeOverlay(dir, profile);

      // A family whose own instruction file omp cannot discover (QWEN.md) has
      // to have it read here and appended, or the model silently runs without
      // the project's instructions.
      let instructions: string | undefined;
      if (needsManualLoad(profile.contextFile)) {
        instructions = await readInstructionFile(cwd, profile.contextFile);
      }
      const appendPath = await writeAppendPrompt(dir, profile, instructions);

      return overlayArgs(overlayPath, appendPath);
    } catch (err) {
      this.output.appendLine(`[omp] could not apply profile spawn settings: ${String(err)}`);
      return [];
    }
  }

  /** Build a self-test report; works even when the agent never started. */
  async diagnosticsReport(): Promise<string> {
    const cfg = vscode.workspace.getConfiguration("ompcode");
    const launch =
      this.launch ??
      {
        ompPath: cfg.get<string>("ompPath", "omp") || "omp",
        cwd: this.workspaceCwd(),
        ...(await this.buildEnv()),
      };
    return runDiagnostics({
      ompPath: launch.ompPath,
      cwd: launch.cwd,
      env: launch.env,
      injectedEnvKeys: launch.injectedEnvKeys,
      probeResults: this.probeResults(),
      config: {
        ompPath: cfg.get("ompPath"),
        defaultModel: cfg.get("defaultModel"),
        thinkingLevel: cfg.get("thinkingLevel"),
        approvalMode: cfg.get("approvalMode"),
        verifyModels: cfg.get("verifyModels"),
        hideStartupNotices: cfg.get("hideStartupNotices"),
        customProviders: Object.keys(cfg.get<Record<string, unknown>>("customProviders", {})),
      },
    });
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
    const approvalMode = this.approvalSetting().mode;
    const customProviders = await this.injectProviderKeys(
      cfg.get<Record<string, unknown>>("customProviders", {}),
    );

    try {
      await syncCustomProviders(customProviders);
    } catch (err) {
      this.output.appendLine(
        `[omp] models.yml sync failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const { env, injectedEnvKeys } = await this.buildEnv(bootstrapLogin);
    const cwd = this.workspaceCwd();
    this.launch = { ompPath, cwd, env, injectedEnvKeys };

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
        // Every intentional stop (dispose/restart/startProcess) detaches the
        // old process first — reaching this point means a genuine crash.
        return;
      }
      this.initialized = false;
      const detail = `agent exited (code ${code ?? "?"}${signal ? `, signal ${signal}` : ""})`;
      this.initReject?.(new Error(detail));
      this.output.appendLine(`[omp] ${detail}`);
      // omp exits immediately when it has no configured models/keys — no
      // amount of restarting fixes that, so go straight to the setup card.
      const needsSetup = /No models available/i.test(stderrTail);
      if (needsSetup) {
        this.post({ t: "proc", status: "exited", detail, needsSetup });
        return;
      }
      this.autoRestartAttempts++;
      if (this.autoRestartAttempts <= 1) {
        this.output.appendLine("[omp] auto-restarting after crash…");
        this.post({ t: "proc", status: "restarting", detail });
        this.post({
          t: "frame",
          frame: {
            type: "notice",
            level: "warning",
            message: t("Agent crashed ({0}) — restarting…", detail),
          },
        });
        const previousSession = this.lastSessionFile;
        setTimeout(() => {
          if (this.proc !== proc) {
            return; // user restarted or closed the session meanwhile
          }
          void this.ensureStarted()
            .then(() => this.initDone)
            // A crash loses the conversation exactly as a deliberate restart
            // does, so the recovery path has to reattach too.
            .then(() => this.resumeAfterRestart(previousSession))
            .catch((err) => this.reportError("auto-restart", err));
        }, 1000);
        return;
      }
      this.post({ t: "proc", status: "exited", detail, needsSetup });
    });
    proc.onError((err: NodeJS.ErrnoException) => {
      if (this.proc !== proc) {
        return;
      }
      this.initialized = false;
      const isEnoent = err.code === "ENOENT";
      const detail = isEnoent
        ? t(
            'Cannot find the omp binary "{0}". Install it (bun install -g @oh-my-pi/pi-coding-agent) or set "ompcode.ompPath" to the correct path.',
            ompPath,
          )
        : `omp process error: ${err.message}`;
      this.initReject?.(new Error(detail));
      this.output.appendLine(`[omp] ${detail}`);
      this.post({ t: "proc", status: "error", detail });
    });

    // Spawn-tier profile settings. The model is only selected after the
    // handshake, so the profile is resolved from the configured default model
    // — the one this process will actually end up on. Switching to another
    // family later needs a restart, which pushProfile logs.
    const extraArgs = await this.profileSpawnArgs(cwd);

    this.output.appendLine(
      `[omp] starting: ${ompPath} --mode rpc-ui --cwd ${cwd} --approval-mode ${approvalMode}` +
        (extraArgs.length ? ` ${extraArgs.join(" ")}` : ""),
    );
    proc.start({ ompPath, cwd, env, approvalMode, extraArgs });
  }

  private handleFrame(proc: OmpProcess, frame: OmpFrame): void {
    if (this.proc !== proc) {
      return; // frame from an old process
    }
    if (frame.type === "notice" && this.hideNoisyNotices() && isNoisyNotice(frame)) {
      this.output.appendLine(`[omp] notice suppressed: ${String(frame.message ?? "")}`);
      return;
    }
    if (frame.type === "ready") {
      void this.initialize(proc);
    } else if (frame.type === "agent_start") {
      this.streaming = true;
      this.turnStartedAt = Date.now();
    } else if (frame.type === "agent_end") {
      this.streaming = false;
      this.notifyTurnDone();
      void this.pushSessionStats();
    } else if (frame.type === "tool_execution_start") {
      void this.snapshotTool(frame);
    } else if (frame.type === "tool_execution_end") {
      this.finishToolSnapshot(frame);
    }
    // Forward ALL non-response frames to the webview.
    this.post({ t: "frame", frame });
    if (frame.type === "extension_ui_request") {
      if (frame.method === "open_url") {
        // Device-code providers (Kimi Code) pass the one-time user code in
        // `instructions`; the browser page is useless without it, so the
        // webview renders a card and the URL opens from `launchUrl` when the
        // provider distinguishes "page to open" from "page to display".
        const url = typeof frame.url === "string" ? frame.url : undefined;
        const launchUrl = typeof frame.launchUrl === "string" ? frame.launchUrl : undefined;
        const target = launchUrl ?? url;
        if (target) {
          void vscode.env.openExternal(vscode.Uri.parse(target));
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

      // Initial fetches run concurrently (state is re-fetched after set_* below).
      const [stateInit, modelsData, commandsData] = await Promise.all([
        proc.request({ type: "get_state" }),
        proc.request({ type: "get_available_models" }),
        proc.request({ type: "get_available_commands" }),
      ]);
      const models = this.extractList(modelsData, "models");
      const commands = this.extractList(commandsData, "commands");
      if (typeof (stateInit as Record<string, unknown>)?.isStreaming === "boolean") {
        this.streaming = (stateInit as Record<string, unknown>).isStreaming as boolean;
      }

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
      this.rememberSessionFile(state);

      // Proactively push everything to the webview.
      this.post({ t: "models", models });
      this.post({ t: "commands", commands });
      this.post({ t: "state", state });
      // A restart re-reads config but never calls pushState(), so the chip
      // would keep showing the tier from before the restart.
      this.pushApproval();
      this.callbacks.onState?.(state);
      this.initialized = true;
      this.autoRestartAttempts = 0; // a full handshake proves the agent is healthy
      this.initResolve?.();
      this.output.appendLine("[omp] agent ready");
      void this.verifyModels(models);
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
          this.webviewReady = true;
          void this.ensureStarted().catch((err) => this.reportError("start", err));
          const cfg = vscode.workspace.getConfiguration("ompcode");
          this.post({
            t: "boot",
            cfg: {
              defaultModel: cfg.get<string>("defaultModel", ""),
              thinkingLevel: cfg.get<string>("thinkingLevel", "auto"),
              approvalMode: this.approvalSetting().mode,
              theme: OmpSession.themeId(cfg.get<string>("theme", "violet")),
              accentColor: cfg.get<string>("accentColor", ""),
            },
          });
          await this.pushKeyStatus();
          this.post({
            t: "probe",
            results: this.probeResults(),
            running: OmpSession.probeRun !== undefined,
            enabled: cfg.get<boolean>("verifyModels", true),
          });
          if (this.pendingShowHistory) {
            this.pendingShowHistory = false;
            this.post({ t: "showHistory" });
          }
          if (this.pendingContexts.length) {
            const queued = this.pendingContexts;
            this.pendingContexts = [];
            for (const attachment of queued) {
              this.post({ t: "attachContext", attachment });
            }
          }
          this.pushActiveFile();
          if (!this.resumeAttempted && cfg.get<boolean>("resumeLastSession", false)) {
            this.resumeAttempted = true;
            void this.resumeLastSession();
          }
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
          const attachments = OmpSession.readAttachments(msg.attachments);
          // Attachments are appended host-side so there is one prompt format.
          const message = composePrompt(text, attachments);
          if (!message) {
            return;
          }
          try {
            await this.ensureStarted();
            if (!this.initialized) {
              await this.initDone;
            }
            await this.request({
              type: "prompt",
              message,
              streamingBehavior: this.streaming ? "steer" : undefined,
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
        case "setApproval": {
          // Approval is a spawn argument, so it can only change by restarting.
          const mode = typeof msg.mode === "string" ? msg.mode : "";
          if (!(APPROVAL_MODES as readonly string[]).includes(mode)) {
            return;
          }
          // Write into whichever scope is actually in effect: a Workspace
          // value shadows Global, so writing Global there would restart the
          // agent on the old tier while the chip claimed the new one.
          const { target } = this.approvalSetting();
          await vscode.workspace
            .getConfiguration("ompcode")
            .update("approvalMode", mode, target);
          // The config-change watcher restarts every session, so do not
          // restart here as well — that would spawn the agent twice.
          return;
        }
        case "getModels":
          await this.pushModels();
          return;
        case "recheckModels":
          await this.recheckModels();
          return;
        case "diagnostics":
          await this.openDiagnostics();
          return;
        case "exportTranscript":
          await this.exportTranscript();
          return;
        case "getHistory": {
          const sessions = await listSessions();
          this.post({
            t: "history",
            sessions,
            cwd: this.workspaceCwd(),
          });
          return;
        }
        case "openSession":
          if (typeof msg.path === "string") {
            await this.openSession(msg.path);
          }
          return;
        case "uiError":
          // The webview keeps rendering after an exception; without this the
          // failure would only exist in a devtools console nobody opens.
          this.output.appendLine(
            `[webview] error while handling "${String(msg.context ?? "?")}": ${String(msg.message ?? "")}`,
          );
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
        case "copy":
          // Clipboard writes go through the host: the webview's async clipboard
          // API is gesture-gated and unavailable in some VS Code builds.
          if (typeof msg.text === "string" && msg.text) {
            await vscode.env.clipboard.writeText(msg.text);
          }
          return;
        case "insertAtCursor": {
          const text = typeof msg.text === "string" ? msg.text : "";
          if (!text) {
            return;
          }
          const editor = vscode.window.activeTextEditor;
          if (!editor) {
            this.post({
              t: "frame",
              frame: {
                type: "notice",
                level: "warning",
                message: t("No active editor — click into a file first."),
              },
            });
            return;
          }
          const ok = await editor.edit((eb) => eb.insert(editor.selection.active, text));
          if (ok) {
            // Bring the target back into view: the chat just stole the focus.
            await vscode.window.showTextDocument(editor.document, editor.viewColumn);
          }
          return;
        }
        case "openDiff":
          await this.openDiff(typeof msg.toolCallId === "string" ? msg.toolCallId : "");
          return;
        case "pickFiles":
          await this.pickAttachments();
          return;
        case "findFiles":
          await this.findFiles(
            typeof msg.query === "string" ? msg.query : "",
            typeof msg.token === "string" ? msg.token : undefined,
          );
          return;
        case "attachPaths":
          // Paths that already exist on disk (file picker, editor/explorer
          // drag, pasted path text) — referenced in place, never copied.
          await this.attachPaths(
            Array.isArray(msg.paths) ? msg.paths.map((p) => String(p)) : [],
            typeof msg.token === "string" ? msg.token : undefined,
          );
          return;
        case "attachData":
          // Bytes with no path of their own (clipboard image, Finder paste,
          // OS drag) — spilled into extension storage so the agent can read it.
          await this.attachData(msg);
          return;
        case "setKeys": {
          const keys =
            msg.keys && typeof msg.keys === "object"
              ? (msg.keys as Record<string, unknown>)
              : {};
          let saved = 0;
          for (const p of KEYED_PROVIDERS) {
            const value = typeof keys[p.id] === "string" ? (keys[p.id] as string).trim() : "";
            if (value) {
              await this.context.secrets.store(p.secret, value);
              saved++;
            }
          }
          if (saved) {
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
        case "clearKey": {
          // A key that answers 401 is worse than no key: it makes omp list the
          // provider's whole model range, all of it dead.
          const entry = KEYED_PROVIDERS.find((p) => p.id === msg.which);
          if (!entry) {
            return;
          }
          await this.context.secrets.delete(entry.secret);
          this.output.appendLine(`[omp] cleared secret ${entry.secret} — restarting all sessions`);
          await this.pushKeyStatus();
          OmpSession.forEachActive((session) => {
            void session.restart();
          });
          return;
        }
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

  // -------------------------------------------------------------- attachments

  /** Re-validate the attachment list the webview sends back with a prompt. */
  private static readAttachments(raw: unknown): Attachment[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    const out: Attachment[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") {
        continue;
      }
      const record = entry as Record<string, unknown>;
      const filePath = typeof record.path === "string" ? record.path : "";
      if (!filePath) {
        continue;
      }
      const att: Attachment = {
        path: filePath,
        name: typeof record.name === "string" && record.name ? record.name : path.basename(filePath),
        size: typeof record.size === "number" ? record.size : undefined,
      };
      // Editor-selection attachments carry a validated line range and a
      // bounded snippet; anything malformed degrades to a plain file ref.
      const sel = record.selection;
      if (sel && typeof sel === "object") {
        const s = (sel as Record<string, unknown>).startLine;
        const e = (sel as Record<string, unknown>).endLine;
        if (
          typeof s === "number" && Number.isInteger(s) && s >= 1 &&
          typeof e === "number" && Number.isInteger(e) && e >= s
        ) {
          att.selection = { startLine: s, endLine: e };
        }
      }
      if (typeof record.snippet === "string" && record.snippet) {
        att.snippet = record.snippet.slice(0, MAX_SNIPPET_CHARS);
      }
      if (typeof record.language === "string" && record.language) {
        att.language = record.language;
      }
      out.push(att);
    }
    return out;
  }

  /** Live palette update — cheap enough that it must not restart the agent. */
  pushTheme(): void {
    const cfg = vscode.workspace.getConfiguration("ompcode");
    this.post({
      t: "theme",
      theme: OmpSession.themeId(cfg.get<string>("theme", "violet")),
      accentColor: cfg.get<string>("accentColor", ""),
    });
  }

  /** Composer 📎 → native open dialog, rooted at the session's workspace. */
  private async pickAttachments(): Promise<void> {
    const folder = vscode.Uri.file(this.workspaceCwd());
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFiles: true,
      canSelectFolders: false,
      openLabel: "Attach",
      defaultUri: folder,
    });
    if (!picked || picked.length === 0) {
      return;
    }
    await this.attachPaths(picked.map((uri) => uri.fsPath));
  }

  /** Latest @-mention query wins; stale ones are cancelled, not just ignored. */
  private findFilesCancel: vscode.CancellationTokenSource | undefined;

  /** Consecutive crash count; reset on a successful handshake or manual restart. */
  private autoRestartAttempts = 0;
  /**
   * JSONL path of the live conversation, captured from every state push.
   *
   * A restart spawns a fresh agent with no memory of the chat, while the
   * webview keeps showing the transcript — so without reattaching, the UI
   * displays a conversation the agent has forgotten. omp reports the path as
   * `state.sessionFile`, and `switch_session` takes exactly that.
   */
  private lastSessionFile: string | undefined;
  /** Profile of the model currently selected, or undefined before the first state. */
  private activeProfile: ResolvedProfile | undefined;

  /** agent_start timestamp — completion notifications only fire for slow turns. */
  private turnStartedAt = 0;

  /**
   * Native notification when a long turn finishes while VS Code is unfocused.
   * Short turns stay silent — the user is plainly still watching.
   */
  private notifyTurnDone(): void {
    const elapsed = Date.now() - this.turnStartedAt;
    this.turnStartedAt = 0;
    if (vscode.window.state.focused || elapsed < 15_000) {
      return;
    }
    void vscode.window
      .showInformationMessage(t("OMP Code: the agent finished."), t("Open chat"))
      .then((action) => {
        if (action) {
          this.callbacks.onReveal?.();
        }
      });
  }

  /**
   * File candidates for the composer's @-mention popup. `findFiles` globs, so
   * the query becomes a basename substring pattern; glob metacharacters are
   * stripped (a user typing `[` mid-query must not crash the search).
   */
  private async findFiles(query: string, token?: string): Promise<void> {
    const base = query.split("/").pop()?.replace(/[*?[\]{}\\]/g, "") ?? "";
    if (!base || !token) {
      this.post({ t: "fileCandidates", token, files: [] });
      return;
    }
    this.findFilesCancel?.cancel();
    this.findFilesCancel?.dispose();
    const cancel = new vscode.CancellationTokenSource();
    this.findFilesCancel = cancel;
    try {
      const uris = await vscode.workspace.findFiles(
        `**/*${base}*`,
        "{**/node_modules/**,**/.git/**,**/dist/**}",
        40,
        cancel.token,
      );
      if (cancel.token.isCancellationRequested) {
        return;
      }
      const files = uris.map((uri) => ({
        path: uri.fsPath,
        name: path.basename(uri.fsPath),
        relative: vscode.workspace.asRelativePath(uri, false),
      }));
      files.sort((a, b) => a.relative.length - b.relative.length);
      this.post({ t: "fileCandidates", token, files });
    } finally {
      if (this.findFilesCancel === cancel) {
        this.findFilesCancel = undefined;
      }
      cancel.dispose();
    }
  }

  /**
   * Turn dropped/picked entries into attachments. Input may be plain paths or
   * `file://` URIs (VS Code hands drags over as a uri-list), so everything
   * goes through parseUriList first. A path that does not resolve is reported
   * rather than silently dropped — a chip pointing at nothing produces an
   * agent that appears to "ignore" the file.
   */
  private async attachPaths(entries: string[], token?: string): Promise<void> {
    const files: Attachment[] = [];
    const rejected: string[] = [];
    const candidates = parseUriList(entries.join("\n"));
    if (candidates.length === 0 && entries.length > 0) {
      rejected.push("no local file paths in that drop");
    }
    for (const candidate of candidates) {
      try {
        const stat = await fs.stat(candidate);
        if (stat.isDirectory()) {
          // A directory is a legitimate thing to point an agent at.
          files.push({ path: candidate, name: path.basename(candidate) || candidate });
          continue;
        }
        if (!stat.isFile()) {
          rejected.push(`${path.basename(candidate)}: not a regular file`);
          continue;
        }
        files.push({ path: candidate, name: path.basename(candidate), size: stat.size });
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        rejected.push(`${path.basename(candidate)}: ${reason}`);
      }
    }
    this.postAttached(files, rejected, token);
  }

  /**
   * Persist clipboard/drop bytes into extension storage and attach the copy.
   * Webview File objects carry no usable path, so this is the only way a
   * pasted screenshot or a file dragged out of Finder reaches the agent.
   */
  private async attachData(msg: WebviewMessage): Promise<void> {
    const token = typeof msg.token === "string" ? msg.token : undefined;
    const base64 = typeof msg.data === "string" ? msg.data : "";
    const name = safeFileName(typeof msg.name === "string" ? msg.name : "", "pasted-file");
    if (!base64) {
      this.postAttached([], [`${name}: empty payload`], token);
      return;
    }
    const bytes = Buffer.from(base64, "base64");
    if (bytes.byteLength === 0) {
      this.postAttached([], [`${name}: empty payload`], token);
      return;
    }
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      this.postAttached(
        [],
        [
          t(
            "{0}: {1} exceeds the {2} limit",
            name,
            formatSize(bytes.byteLength),
            formatSize(MAX_ATTACHMENT_BYTES),
          ),
        ],
        token,
      );
      return;
    }
    try {
      const dir = path.join(this.context.globalStorageUri.fsPath, "attachments");
      await fs.mkdir(dir, { recursive: true });
      const stamp = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
      const target = path.join(dir, `${stamp}-${name}`);
      await fs.writeFile(target, bytes);
      this.output.appendLine(`[omp] attachment stored: ${target} (${formatSize(bytes.byteLength)})`);
      this.postAttached([{ path: target, name, size: bytes.byteLength }], [], token);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.postAttached([], [`${name}: ${reason}`], token);
    }
  }

  private postAttached(files: Attachment[], rejected: string[], token?: string): void {
    this.post({ t: "attached", files, rejected, token });
    for (const problem of rejected) {
      this.output.appendLine(`[omp] attachment rejected — ${problem}`);
    }
  }

  // ------------------------------------------------------------ edit feedback

  /**
   * Absolute path an edit/write tool is about to touch, or undefined for
   * everything else. Relative paths resolve against the agent's cwd.
   */
  private editToolPath(frame: OmpFrame): string | undefined {
    if (!/edit|write|create|patch/i.test(String(frame.toolName ?? ""))) {
      return undefined;
    }
    const args = frame.args;
    if (!args || typeof args !== "object") {
      return undefined;
    }
    for (const key of ["path", "file_path", "filePath", "target_file"]) {
      const value = (args as Record<string, unknown>)[key];
      if (typeof value === "string" && value) {
        return path.isAbsolute(value)
          ? value
          : path.join(this.launch?.cwd ?? os.homedir(), value);
      }
    }
    return undefined;
  }

  /**
   * Capture a file's content and diagnostics just before the tool runs. The
   * read races the tool by milliseconds at worst — good enough for a "before"
   * buffer, and the protocol offers nothing earlier.
   */
  private async snapshotTool(frame: OmpFrame): Promise<void> {
    const id = typeof frame.toolCallId === "string" ? frame.toolCallId : "";
    const filePath = id ? this.editToolPath(frame) : undefined;
    if (!id || !filePath) {
      return;
    }
    let before = "";
    try {
      before = await fs.readFile(filePath, "utf8");
    } catch {
      // File does not exist yet — the tool is creating it; diff against empty.
    }
    if (before.length > 2_000_000) {
      return; // a diff this big helps nobody; skip rather than hoard memory
    }
    this.diffSnaps.set(id, { path: filePath, before });
    if (this.diffSnaps.size > 50) {
      const oldest = this.diffSnaps.keys().next().value;
      if (oldest !== undefined) {
        this.diffSnaps.delete(oldest);
      }
    }
    if (!this.diagBaseline.has(filePath)) {
      const keys = new Set(
        vscode.languages
          .getDiagnostics(vscode.Uri.file(filePath))
          .filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning)
          .map(diagKey),
      );
      this.diagBaseline.set(filePath, keys);
    }
  }

  private finishToolSnapshot(frame: OmpFrame): void {
    const id = typeof frame.toolCallId === "string" ? frame.toolCallId : "";
    const snap = id ? this.diffSnaps.get(id) : undefined;
    if (!id || !snap) {
      return;
    }
    if (frame.isError) {
      this.diffSnaps.delete(id);
      return;
    }
    if (this.diffStore) {
      this.post({ t: "diffAvailable", toolCallId: id, path: snap.path });
    }
    this.scheduleDiagCheck(snap.path);
  }

  /** Report diagnostics an edit *introduced* — a fast "you broke X" loop. */
  private scheduleDiagCheck(filePath: string): void {
    const existing = this.diagTimers.get(filePath);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    this.diagTimers.set(
      filePath,
      setTimeout(() => {
        this.diagTimers.delete(filePath);
        const baseline = this.diagBaseline.get(filePath);
        this.diagBaseline.delete(filePath);
        if (!baseline) {
          return;
        }
        const added = vscode.languages
          .getDiagnostics(vscode.Uri.file(filePath))
          .filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning)
          .filter((d) => !baseline.has(diagKey(d)));
        if (!added.length) {
          return;
        }
        const shown = added
          .slice(0, 3)
          .map((d) => `L${d.range.start.line + 1}: ${d.message.split("\n")[0]}`);
        const more = added.length > 3 ? " · " + t("+{0} more", added.length - 3) : "";
        this.post({
          t: "frame",
          frame: {
            type: "notice",
            level: "warning",
            message:
              (added.length > 1
                ? t("{0} new problems in {1} after the edit", added.length, path.basename(filePath))
                : t("1 new problem in {0} after the edit", path.basename(filePath))) +
              ` — ${shown.join(" · ")}${more}`,
          },
        });
      }, 700), // give the language server a beat to re-analyze
    );
  }

  /** "Open diff" on a tool card: before-snapshot ↔ the file as it is now. */
  private async openDiff(toolCallId: string): Promise<void> {
    const snap = this.diffSnaps.get(toolCallId);
    if (!snap || !this.diffStore) {
      this.post({
        t: "frame",
        frame: {
          type: "notice",
          level: "warning",
          message: t("That diff snapshot is no longer available."),
        },
      });
      return;
    }
    const beforeUri = this.diffStore.put(toolCallId, snap.path, snap.before);
    await vscode.commands.executeCommand(
      "vscode.diff",
      beforeUri,
      vscode.Uri.file(snap.path),
      `${path.basename(snap.path)} (before ↔ current)`,
    );
  }

  // ------------------------------------------------------------ model probing

  private probeResults(): ProbeResults {
    return this.context.globalState.get<ProbeResults>(PROBE_STATE_KEY, {});
  }

  private static toCandidates(models: unknown[]): ProbeCandidate[] {
    const out: ProbeCandidate[] = [];
    for (const model of models) {
      if (!model || typeof model !== "object") {
        continue;
      }
      const record = model as Record<string, unknown>;
      const provider = typeof record.provider === "string" ? record.provider : "";
      const id = typeof record.id === "string" ? record.id : "";
      if (!provider || !id) {
        continue;
      }
      const cost = record.cost as { input?: number } | undefined;
      out.push({ provider, id, cost });
    }
    return out;
  }

  /**
   * Send one throwaway request per model so the picker can hide everything that
   * would answer 401. Runs in the background, reports verdicts to the webview
   * as they land, and shares its cache across every session; `force` bypasses
   * the TTL for the "Re-check subscriptions" action.
   */
  private async verifyModels(models: unknown[], force = false): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("ompcode");
    if (!cfg.get<boolean>("verifyModels", true)) {
      this.post({ t: "probe", results: {}, running: false, enabled: false });
      return;
    }
    const candidates = OmpSession.toCandidates(models);
    if (!candidates.length || !this.launch) {
      return;
    }

    if (OmpSession.probeRun) {
      return; // another session is already probing; its verdicts are shared
    }
    // Only drop the cache once we know this call will actually re-run: wiping
    // it and then bailing out leaves the picker with nothing to filter on.
    const cached = force ? {} : this.probeResults();
    if (force) {
      await this.context.globalState.update(PROBE_STATE_KEY, cached);
    }
    this.post({ t: "probe", results: cached, running: false, enabled: true });
    if (isCacheFresh(candidates, cached, Date.now())) {
      return;
    }

    const launch = this.launch;
    const run = (async () => {
      this.post({ t: "probe", results: cached, running: true, enabled: true });
      this.output.appendLine(`[omp] verifying ${candidates.length} models…`);
      const results = { ...cached };
      await probeModels(candidates, {
        ompPath: launch.ompPath,
        cwd: launch.cwd,
        env: launch.env,
        createProcess: () => new OmpProcess(),
        log: (line) => this.output.appendLine(line),
        isCancelled: () => OmpSession.probeCancelled,
        onVerdict: (key, verdict) => {
          results[key] = verdict;
          OmpSession.forEachActive((session) => {
            session.post({ t: "probe", results, running: true, enabled: true });
          });
        },
      });
      await this.context.globalState.update(PROBE_STATE_KEY, results);
      const usable = Object.values(results).filter((v) => v.ok).length;
      this.output.appendLine(`[omp] verification done: ${usable}/${candidates.length} models usable`);
      OmpSession.forEachActive((session) => {
        session.post({ t: "probe", results, running: false, enabled: true });
      });
      if (!Object.keys(results).length) {
        // Never fail silently: an empty run leaves the picker unfiltered and
        // used to look exactly like "the feature does nothing".
        const detail =
          "Model verification produced no result — see the \"OMP Code\" output channel ([probe] lines) or run diagnostics from the ⚙ menu.";
        this.output.appendLine(`[omp] ${detail}`);
        OmpSession.forEachActive((session) => {
          session.post({ t: "frame", frame: { type: "notice", level: "warning", message: detail } });
        });
      }
      await this.warnAboutDeadKeys(results);
      await this.switchAwayFromDeadModel(results, candidates);
    })();

    OmpSession.probeRun = run.finally(() => {
      OmpSession.probeRun = undefined;
    });
    await OmpSession.probeRun;
  }

  /** `{provider, modelId}` of the model the agent currently has selected. */
  private async currentModel(): Promise<{ provider: string; id: string } | undefined> {
    const state = (await this.request({ type: "get_state" })) as Record<string, unknown> | undefined;
    const model = state?.model;
    if (typeof model === "string") {
      const slash = model.indexOf("/");
      return slash > 0 ? { provider: model.slice(0, slash), id: model.slice(slash + 1) } : undefined;
    }
    if (model && typeof model === "object") {
      const record = model as Record<string, unknown>;
      const provider = typeof record.provider === "string" ? record.provider : "";
      const id = typeof record.id === "string" ? record.id : "";
      return provider && id ? { provider, id } : undefined;
    }
    return undefined;
  }

  /**
   * If the selected model just failed verification, move to one that answered.
   * Otherwise the first prompt after startup still hits the dead model — which
   * is exactly how a stale key reads to the user as "nothing works".
   */
  private async switchAwayFromDeadModel(
    results: ProbeResults,
    candidates: ProbeCandidate[],
  ): Promise<void> {
    try {
      const current = await this.currentModel();
      if (!current) {
        return;
      }
      const verdict = results[modelKey(current.provider, current.id)];
      if (!verdict || verdict.ok) {
        return;
      }
      const usable = candidates.filter((m) => results[modelKey(m.provider, m.id)]?.ok);
      const replacement =
        usable.find((m) => m.provider === current.provider) ?? usable[0];
      if (!replacement) {
        return;
      }
      await this.request({
        type: "set_model",
        provider: replacement.provider,
        modelId: replacement.id,
      });
      await this.pushState();
      const message =
        `${current.provider}/${current.id} did not answer` +
        `${verdict.status ? ` (${verdict.status})` : ""} — switched to ${replacement.provider}/${replacement.id}.`;
      this.output.appendLine(`[omp] ${message}`);
      this.post({ t: "frame", frame: { type: "notice", level: "info", message } });
    } catch (err) {
      this.output.appendLine(
        `[omp] could not switch off a dead model: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * `ompcode.resumeLastSession`: reopen the newest session that has real user
   * messages (empty shells from agent starts are filtered by listSessions).
   */
  private async resumeLastSession(): Promise<void> {
    try {
      const [latest] = await listSessions();
      if (!latest) {
        return;
      }
      this.output.appendLine(`[omp] resuming session ${latest.path}`);
      await this.openSession(latest.path);
    } catch (err) {
      this.output.appendLine(
        `[omp] resume last session failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Reopen a past session by its JSONL path (`switch_session` takes a path, so
   * sessions from other workspaces open too) and replay its transcript into the
   * webview.
   */
  async openSession(sessionPath: string): Promise<void> {
    try {
      await this.ensureStarted();
      if (!this.initialized) {
        await this.initDone;
      }
      const result = (await this.request({ type: "switch_session", sessionPath })) as
        | { cancelled?: boolean }
        | undefined;
      if (result?.cancelled) {
        this.post({
          t: "frame",
          frame: {
            type: "notice",
            level: "warning",
            message: t("Session switch was cancelled."),
          },
        });
        return;
      }
      const data = await this.request({ type: "get_messages" });
      this.post({ t: "reset" });
      this.post({ t: "transcript", messages: this.extractList(data, "messages") });
      await this.pushState();
      this.output.appendLine(`[omp] switched to session ${sessionPath}`);
    } catch (err) {
      this.reportError("open session", err);
    }
  }

  /**
   * Ask the webview to open its history panel (command / title-bar entry
   * point). A freshly created panel has no listener yet, so the request is also
   * remembered and replayed once the webview reports `ready`.
   */
  showHistory(): void {
    this.pendingShowHistory = true;
    this.post({ t: "showHistory" });
  }

  /**
   * Drop an editor selection onto the composer's attachment tray
   * (`ompcode.addSelectionToChat`). Queued when the webview has not reported
   * `ready` yet — a chat tab opened *by* the command would otherwise lose it.
   */
  attachContext(attachment: Attachment): void {
    if (!this.webviewReady) {
      this.pendingContexts.push(attachment);
      return;
    }
    this.post({ t: "attachContext", attachment });
  }

  /** Push the active text editor's file to the webview's composer chip. */
  pushActiveFile(): void {
    const editor = vscode.window.activeTextEditor;
    const uri = editor?.document.uri;
    const file =
      editor && uri?.scheme === "file"
        ? { path: uri.fsPath, name: path.basename(uri.fsPath) }
        : null;
    this.post({ t: "activeFile", file });
  }

  /** Run the self-test and show the report in an editor tab. */
  async openDiagnostics(): Promise<void> {
    this.output.appendLine("[omp] running diagnostics…");
    const report = await this.diagnosticsReport();
    this.output.appendLine(report);
    const doc = await vscode.workspace.openTextDocument({ content: report, language: "markdown" });
    await vscode.window.showTextDocument(doc, { preview: false });
  }

  /** Serialize the live transcript via get_messages and save it as Markdown. */
  async exportTranscript(): Promise<void> {
    try {
      await this.ensureStarted();
      if (!this.initialized) {
        await this.initDone;
      }
      const data = await this.request({ type: "get_messages" });
      const messages = this.extractList(data, "messages");
      if (!messages.length) {
        this.post({
          t: "frame",
          frame: { type: "notice", level: "info", message: t("Nothing to export yet.") },
        });
        return;
      }
      const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(this.workspaceCwd(), `omp-chat-${stamp}.md`)),
        filters: { Markdown: ["md"] },
      });
      if (!uri) {
        return;
      }
      await fs.writeFile(uri.fsPath, formatTranscript(messages), "utf8");
      this.output.appendLine(`[omp] transcript exported to ${uri.fsPath}`);
      this.post({
        t: "frame",
        frame: { type: "notice", level: "info", message: t("Transcript saved to {0}", uri.fsPath) },
      });
    } catch (err) {
      this.reportError("export transcript", err);
    }
  }

  /**
   * A stored key that answers 401 is the worst state to be in: omp offers the
   * provider's whole model range and every entry fails. Tell the webview so it
   * can offer removing it in one click.
   */
  private async warnAboutDeadKeys(results: ProbeResults): Promise<void> {
    for (const entry of KEYED_PROVIDERS) {
      const dead = Object.entries(results).some(
        ([key, verdict]) =>
          key.startsWith(`${entry.provider}/`) && !verdict.ok && isProviderLevelFailure(verdict),
      );
      if (!dead || !(await this.context.secrets.get(entry.secret))) {
        continue;
      }
      this.output.appendLine(`[omp] stored ${entry.label} API key is rejected (401)`);
      OmpSession.forEachActive((session) => {
        session.post({ t: "deadKey", which: entry.id, label: entry.label });
      });
    }
  }

  /** Drop cached verdicts and probe again from scratch. */
  private async recheckModels(): Promise<void> {
    if (OmpSession.probeRun) {
      OmpSession.probeCancelled = true;
      await OmpSession.probeRun.catch(() => {});
      OmpSession.probeCancelled = false;
    }
    const data = await this.request({ type: "get_available_models" });
    await this.verifyModels(this.extractList(data, "models"), true);
  }

  private hideNoisyNotices(): boolean {
    return vscode.workspace
      .getConfiguration("ompcode")
      .get<boolean>("hideStartupNotices", true);
  }

  private request(cmd: Record<string, unknown>): Promise<unknown> {
    const proc = this.proc;
    if (!proc?.running) {
      return Promise.reject(new Error("omp agent is not running"));
    }
    return proc.request(cmd);
  }

  /**
   * OAuth sign-in (Claude Pro/Max, Kimi Code subscription). Bootstraps the
   * agent with a placeholder key when it cannot start for lack of models, runs
   * the RPC `login` flow (the browser opens from the forwarded open_url frame,
   * whose `instructions` carry the device code for device-code providers),
   * then restarts the agent cleanly so it picks up the stored credential.
   *
   * The RPC request deliberately has no timeout: a device-code flow stays
   * pending until the user authorizes it in the browser (Kimi allows 30 min).
   */
  async loginProvider(providerId: string): Promise<void> {
    if (!this.proc?.running) {
      await this.ensureStarted(true);
    }
    if (!this.initialized) {
      await this.initDone;
    }
    this.post({ t: "authStart", providerId });
    try {
      await this.request({ type: "login", providerId });
      this.output.appendLine(`[omp] login "${providerId}" succeeded — restarting agent`);
      this.post({ t: "authDone", providerId, ok: true });
      this.post({
        t: "frame",
        frame: { type: "notice", level: "info", message: t("Signed in. Restarting agent…") },
      });
      await this.restart();
    } catch (err) {
      this.post({
        t: "authDone",
        providerId,
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
      this.reportError(`login ${providerId}`, err);
    }
  }

  private async pushKeyStatus(): Promise<void> {
    const keys: Record<string, boolean> = {};
    for (const p of KEYED_PROVIDERS) {
      keys[p.id] = Boolean(await this.context.secrets.get(p.secret));
    }
    // The setup form renders from this list, so a new table row needs no
    // webview change.
    this.post({
      t: "keyStatus",
      keys,
      providers: KEYED_PROVIDERS.map((p) => ({
        id: p.id,
        label: p.label,
        envVar: p.envVar,
        placeholder: p.placeholder,
      })),
    });
  }

  /**
   * Override each provider's `apiKey` with the value from Secret Storage
   * (`ompcode.providerKey.<name>`), if one is stored there. A provider with no
   * stored secret keeps whatever `apiKey` (if any) the settings.json entry
   * declared, so the plaintext path still works as a fallback.
   */
  private async injectProviderKeys(
    cfg: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {};
    for (const [name, def] of Object.entries(cfg)) {
      if (def && typeof def === "object") {
        const secret = await this.context.secrets.get(`ompcode.providerKey.${name}`);
        if (secret) {
          out[name] = { ...(def as Record<string, unknown>), apiKey: secret };
          continue;
        }
      }
      out[name] = def;
    }
    return out;
  }

  /**
   * Effective approval tier, and the config scope it comes from.
   *
   * `ompcode.approvalMode` is window-scoped, so a Workspace or Folder value
   * beats a Global one. Writing blindly to Global would leave the chip
   * showing a tier the agent was never launched with.
   */
  private approvalSetting(): { mode: ApprovalMode; target: vscode.ConfigurationTarget } {
    const cfg = vscode.workspace.getConfiguration("ompcode");
    const info = cfg.inspect<string>("approvalMode");
    const target =
      info?.workspaceFolderValue !== undefined
        ? vscode.ConfigurationTarget.WorkspaceFolder
        : info?.workspaceValue !== undefined
          ? vscode.ConfigurationTarget.Workspace
          : vscode.ConfigurationTarget.Global;
    const raw = cfg.get<string>("approvalMode", "always-ask");
    // A hand-edited value outside the enum reaches --approval-mode verbatim,
    // where omp warns and falls back to its own default of `yolo` — the one
    // tier nobody wants to arrive at by typo.
    const mode = (APPROVAL_MODES as readonly string[]).includes(raw)
      ? (raw as ApprovalMode)
      : "always-ask";
    if (mode !== raw) {
      this.output.appendLine(
        `[omp] ignoring invalid ompcode.approvalMode "${raw}" — using "${mode}"`,
      );
    }
    return { mode, target };
  }

  /**
   * User-authored profile rows. Invalid entries are dropped rather than
   * throwing: a typo in settings.json must not stop the agent from starting.
   */
  private userProfiles(): ModelProfile[] {
    const raw = vscode.workspace.getConfiguration("ompcode").get<unknown[]>("modelProfiles", []);
    if (!Array.isArray(raw)) {
      return [];
    }
    const rows: ModelProfile[] = [];
    for (const entry of raw) {
      if (!isValidProfileRow(entry)) {
        this.output.appendLine(`[omp] ignoring invalid ompcode.modelProfiles entry: ${JSON.stringify(entry)}`);
        continue;
      }
      // `match.id` arrives from JSON as a string; the resolver wants a RegExp.
      const row = entry as ModelProfile & { match: { id?: unknown } };
      if (typeof row.match.id === "string") {
        try {
          row.match = { ...row.match, id: new RegExp(row.match.id, "i") };
        } catch {
          this.output.appendLine(`[omp] ignoring profile row with an invalid match.id regex: ${String(row.match.id)}`);
          continue;
        }
      }
      rows.push(row);
    }
    return rows;
  }

  /** Resolve the profile for the model in `state` and send it to the webview. */
  private pushProfile(state: unknown): void {
    const model = state && typeof state === "object" ? (state as Record<string, unknown>).model : undefined;
    if (!model || typeof model !== "object") {
      this.post({ t: "profile", profile: undefined });
      return;
    }
    const m = model as Record<string, unknown>;
    const matchable: MatchableModel = {
      provider: typeof m.provider === "string" ? m.provider : undefined,
      id: typeof m.id === "string" ? m.id : undefined,
      baseUrl: typeof m.baseUrl === "string" ? m.baseUrl : undefined,
    };
    const profile = resolveProfile(matchable, this.userProfiles());
    const previous = this.activeProfile;
    this.activeProfile = profile;
    this.post({ t: "profile", profile });

    // Spawn-tier fields (approval tier, overlay, instruction file) only reach
    // omp through argv, so a change there needs a respawn. Record it and say
    // so once, rather than restarting the agent behind the user's back.
    if (previous && spawnSignature(previous) !== spawnSignature(profile)) {
      this.output.appendLine(
        `[omp] profile "${profile.family}" wants different spawn settings — restart to apply`,
      );
    }
    void this.applyRuntimeProfile(profile, state);
  }

  /**
   * Apply the profile's runtime fields over RPC — no restart, so switching
   * models stays instant.
   *
   * Only fields the profile actually sets are sent, and only when they differ
   * from what the agent already reports, so this never fights a level the user
   * has just chosen by hand.
   */
  private async applyRuntimeProfile(profile: ResolvedProfile, state: unknown): Promise<void> {
    const runtime = profile.runtime;
    if (!runtime) {
      return;
    }
    const current = state && typeof state === "object" ? (state as Record<string, unknown>) : {};
    try {
      let level = runtime.thinking;
      if (level === "inherit") {
        // No literal fits a whole family — qwen3.7-plus is [minimal..high]
        // while qwen3.8-max is [low, medium, xhigh] — so defer to the ladder
        // omp resolved for this exact model.
        const model = current.model as Record<string, unknown> | undefined;
        const thinking = model?.thinking as Record<string, unknown> | undefined;
        const fallback = typeof thinking?.defaultLevel === "string" ? thinking.defaultLevel : undefined;
        level = (fallback as typeof level) ?? "auto";
      }
      if (level && level !== current.thinkingLevel) {
        await this.request({ type: "set_thinking_level", level });
      }
      if (runtime.steeringMode && runtime.steeringMode !== current.steeringMode) {
        await this.request({ type: "set_steering_mode", mode: runtime.steeringMode });
      }
      if (runtime.interruptMode && runtime.interruptMode !== current.interruptMode) {
        await this.request({ type: "set_interrupt_mode", mode: runtime.interruptMode });
      }
    } catch (err) {
      // A profile that cannot be applied must not break model switching.
      this.output.appendLine(`[omp] could not apply profile "${profile.family}": ${String(err)}`);
    }
  }

  /** Tell the webview which tier the agent is actually running under. */
  private pushApproval(): void {
    this.post({ t: "approval", mode: this.approvalSetting().mode });
  }

  private async pushState(): Promise<void> {
    const state = await this.request({ type: "get_state" });
    this.rememberSessionFile(state);
    if (state && typeof state === "object" && typeof (state as Record<string, unknown>).isStreaming === "boolean") {
      this.streaming = (state as Record<string, unknown>).isStreaming as boolean;
    }
    this.post({ t: "state", state });
    this.pushApproval();
    this.pushProfile(state);
    this.callbacks.onState?.(state);
  }

  /**
   * Token/cost totals after each agent run (get_session_stats →
   * {tokens:{input,output,…}, cost, contextUsage}). Older omp builds without
   * the command just leave the footer chip hidden.
   */
  private async pushSessionStats(): Promise<void> {
    try {
      const stats = await this.request({ type: "get_session_stats" });
      this.post({ t: "sessionStats", stats });
    } catch {
      // Command unknown or agent mid-restart — the chip simply stays stale.
    }
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

  /** Known palettes; anything else falls back to the default. */
  private static themeId(raw: string | undefined): string {
    const known: Record<string, true> = {
      violet: true,
      coral: true,
      emerald: true,
      amber: true,
      magenta: true,
    };
    const id = String(raw ?? "").trim();
    return known[id] ? id : "violet";
  }

  // ------------------------------------------------------------------- html

  private getHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString("base64");
    const cssUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "main.css"),
    );
    const mdUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "markdown.mjs"),
    );
    const jsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "main.mjs"),
    );
    const cfg = vscode.workspace.getConfiguration("ompcode");
    // Palette is an HTML attribute (CSP forbids inline <style>); a custom
    // accentColor is applied later by main.mjs through the CSSOM.
    const theme = OmpSession.themeId(cfg.get<string>("theme", "violet"));
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
    // Translated text goes through esc; the few strings that carry markup
    // keep a {0} placeholder and have it filled in after escaping.
    // `<` is escaped so a translation can never close this script tag early.
    const bundle = JSON.stringify(currentBundle()).replace(/</g, "\\u003c");
    const welcome = esc(
      t(
        "Ask questions, run commands, edit files. Type {0} for commands. Attach files with 📎, Ctrl/Cmd+V, or Shift+drag. Shift+Enter for a new line, Esc to interrupt.",
      ),
    ).replace("{0}", "<code>/</code>");

    return `<!DOCTYPE html>
<html lang="${currentLanguage()}">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${cssUri.toString()}">
<title>OMP Code</title>
</head>
<body data-theme="${theme}">
<div id="app">
  <header class="topbar">
    <div class="topbar-title"><span class="spark">✳</span><span id="session-title">OMP Code</span></div>
    <div class="topbar-actions">
      <button id="btn-history" class="icon-btn" title="${esc(t("Session history"))}" aria-label="${esc(t("Session history"))}"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="8" cy="8" r="6.25"/><polyline points="8 4.75 8 8 10.25 9.5"/></svg></button>
      <button id="btn-new" class="icon-btn" title="${esc(t("New chat tab"))}" aria-label="${esc(t("New chat tab"))}">＋</button>
      <button id="btn-settings" class="icon-btn" title="${esc(t("Settings"))}" aria-label="${esc(t("Settings"))}">⚙</button>
    </div>
  </header>
  <main id="messages">
    <div class="welcome">
      <div class="welcome-spark">✳</div>
      <h1>${esc(t("What can I help you build?"))}</h1>
      <p class="welcome-sub">${welcome}</p>
    </div>
    <div id="working" class="status-line hidden" role="status" aria-live="polite"><span class="spark spin">✳</span> <span id="working-text">${esc(t("Working…"))}</span> <span class="dim">${esc(t("esc to interrupt"))}</span></div>
  </main>
  <div id="modal-holder"></div>
  <footer class="composer">
    <div class="composer-box">
      <div id="slash-popup" class="slash-popup hidden"></div>
      <div id="at-popup" class="slash-popup hidden"></div>
      <div id="attachments" class="attachments" aria-label="${esc(t("Attached files"))}"></div>
      <textarea id="input" rows="1" placeholder="${esc(t("Ask OMP Code…"))}" aria-label="${esc(t("Prompt"))}"></textarea>
      <div class="composer-row">
        <button id="btn-attach" class="chip attach" title="${esc(t("Attach files (Ctrl/Cmd+V to paste, Shift+drag to drop)"))}" aria-label="${esc(t("Attach files"))}">📎</button>
        <button id="model-chip" class="chip" aria-label="${esc(t("Select model"))}">${esc(t("model"))}</button>
        <button id="profile-chip" class="chip hidden" aria-label="${esc(t("Model profile"))}"></button>
        <button id="thinking-chip" class="chip" aria-label="${esc(t("Thinking level"))}">${esc(t("think: auto"))}</button>
        <button id="approval-chip" class="chip" aria-label="${esc(t("Tool access level"))}">${esc(t("access: ask"))}</button>
        <span id="file-chip" class="chip ghost hidden" aria-label="${esc(t("Active editor file"))}"></span>
        <span id="stats-chip" class="chip ghost hidden" aria-label="${esc(t("Session tokens and cost"))}"></span>
        <span class="flex-spacer"></span>
        <button id="btn-send" class="send-btn" title="${esc(t("Send"))}" aria-label="${esc(t("Send"))}">↑</button>
        <button id="btn-stop" class="send-btn stop hidden" title="${esc(t("Stop"))}" aria-label="${esc(t("Stop"))}">■</button>
      </div>
    </div>
    <div id="proc-banner" class="proc-banner hidden"><span id="proc-text">${esc(t("Agent is not running."))}</span> <button id="btn-restart">${esc(t("Restart"))}</button></div>
  </footer>
  <div id="menu-holder"></div>
  <div id="toast-holder"></div>
<div id="drop-overlay" class="hidden"><div><span class="drop-title">${esc(t("Drop files to attach"))}</span>${esc(t("Release to add them to the prompt."))}</div></div>
</div>
<script nonce="${nonce}" type="application/json" id="l10n-bundle">${bundle}</script>
<script nonce="${nonce}" type="module" src="${mdUri.toString()}"></script>
<script nonce="${nonce}" type="module" src="${jsUri.toString()}"></script>
</body>
</html>`;
  }
}
