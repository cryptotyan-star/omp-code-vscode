import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { OmpProcess, type OmpFrame } from "./ompProcess";
import { pruneCustomProvider, syncCustomProviders } from "./modelsSync";
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
import { CONFIG_PROVIDERS, KEYED_PROVIDERS, LOGIN_PROVIDERS } from "./providers";
import { needsManualLoad, readInstructionFile } from "./instructionFiles";
import { currentBundle, currentLanguage, t } from "./l10n.ts";
import { overlayArgs, writeAppendPrompt, writeOverlay } from "./profileOverlay";
import { planRevert, revertStateHash } from "./revert";
import {
  isSubagentFrame,
  reduceSubagentFrame,
  reduceSubagentList,
  subagentSnapshot,
  type SubagentInfo,
} from "./subagents";
import {
  type ApprovalResponse,
  type JsonValue,
  type RemoteCommand,
} from "./remoteProtocol.ts";
import { requireCanonicalRemotePath } from "./remotePathPolicy.ts";
import { ApprovalNotPendingError, claimPendingApproval } from "./remoteApproval.ts";
import {
  applyProfileFieldEdit,
  builtinMatchForFamily,
  exactMatchFor,
  isEditableProfileField,
  isValidProfileRow,
  resolveProfile,
  spawnSignature,
  type MatchableModel,
  type EditableProfileField,
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
/**
 * Coalescing window for subagent progress. One subagent emitted 29 progress
 * frames in eight seconds in a live run, and every `post()` is mirrored to a
 * paired phone as well as the webview, so the raw rate is not worth relaying.
 */
const SUBAGENT_FLUSH_MS = 250;

export const APPROVAL_MODES = ["always-ask", "write", "yolo"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

/** One row of the session board — a live OmpSession reduced to display data. */
export interface SessionInfo {
  /** Stable identity of the session (the board's row key). */
  id: string;
  /** Title the agent set via `setTitle`, "" before the first one. */
  title: string;
  /** Folder the agent works in — disambiguates same-named chats in multi-root. */
  cwd: string;
  /** Selected model id, "" before the first state frame. */
  model: string;
  provider: string;
  /** Board-facing lifecycle: startup, an approval waiting, a running turn, idle. */
  status: "starting" | "asks" | "working" | "idle";
  /**
   * A turn is queued or running — true from the moment a prompt is handed to
   * this session until `agent_end`.
   *
   * `status` cannot answer this: it turns "working" only on the `agent_start`
   * frame, which arrives a round trip (and, for a freshly spawned agent, a
   * whole handshake) after the prompt was sent. Anything that reads "idle" as
   * "this agent has stopped" — the orchestrator's `workspace_wait` above all —
   * needs the gap covered, or it decides a worker finished before it started.
   */
  pending: boolean;
  /** Session cost in dollars from the last get_session_stats. */
  cost: number;
  /**
   * Subagents omp spawned for this session, running ones first. Terminated
   * agents stay in the list: their cost and transcript outlive the run.
   */
  subagents: SubagentInfo[];
  /** False for the sidebar session — its surface cannot be closed. */
  closable: boolean;
  /** Workspace (git worktree) this session belongs to, when it was opened for one. */
  workspaceId?: string;
  /** Branch of that workspace — the board shows it instead of a bare folder name. */
  branch?: string;
  /** Child process lifecycle, mirroring the last `{t:"proc"}` post. */
  procState: "starting" | "running" | "exited" | "restarting" | "error";
  /** Last process/init failure detail; undefined while the process is healthy. */
  lastError?: string;
  /** Turns this session completed — agent_end increments, session stats correct. */
  turnsCompleted: number;
  /** Wall-clock start of the running turn; undefined between turns. */
  turnStartedAt?: number;
}

/**
 * Per-session pins that outrank the window's own settings.
 *
 * A workspace session runs in its own worktree on its own model and approval
 * tier, so it cannot read those from `ompcode.*`: those settings are shared by
 * every session in the window, and changing one for a new workspace would move
 * the ground under all the others. Every field is optional — a session without
 * overrides behaves exactly as before.
 */
export interface SessionOverrides {
  /** "provider/modelId" this process runs on, instead of `ompcode.defaultModel`. */
  model?: string;
  /** Approval tier this process was spawned with, instead of `ompcode.approvalMode`. */
  approvalMode?: ApprovalMode;
  /** Workspace record id, surfaced on the board row. */
  workspaceId?: string;
  /** Branch checked out in the workspace's worktree. */
  branch?: string;
  /** JSONL of the conversation to reattach to on the first handshake. */
  sessionFile?: string;
  /**
   * Identity of the editor tab this session is attached to, echoed into the
   * webview so `vscode.setState` can carry it across a window reload; see
   * src/chatTabs.ts. Sessions with no tab of their own (the sidebar) leave it
   * unset and are simply never restored.
   */
  tabId?: string;
  /** Called whenever the live conversation's JSONL path changes, so the owner can persist it. */
  onSessionFile?: (file: string) => void;
  /**
   * Called when the user switches this session's model, so the owner can move
   * the pin with them — otherwise the old pin wins again on the next restart.
   */
  onModel?: (model: string) => void;
  /** Same for the approval tier, which is a spawn argument and needs a restart. */
  onApprovalMode?: (mode: ApprovalMode) => void;
  /**
   * Whether this session drives other workspaces through host tools.
   *
   * Left unset it follows the session's role: a plain chat orchestrates, a
   * session opened *for* a workspace does not. A worker that could call
   * `workspace_create` would spawn workers of its own, and nothing in the
   * protocol stops that recursion once it starts.
   */
  orchestrator?: boolean;
}

/**
 * One host tool as omp's `set_host_tools` expects it (its
 * `RpcHostToolDefinition`). Declared structurally rather than imported: omp is
 * not a build dependency of the extension, and the session must not reach into
 * the orchestrator module it is driven by.
 */
export interface HostToolDefinition {
  name: string;
  label?: string;
  description: string;
  /** JSON Schema of the arguments object. */
  parameters: Record<string, unknown>;
  hidden?: boolean;
  loadMode?: string;
}

/**
 * The half of `HostToolBridge` the session talks to.
 *
 * The bridge is built in extension.ts (it needs the Orchestrator, which needs
 * the WorkspaceManager, which needs sessions) and handed down through
 * {@link OmpSession.setHostToolBridge}. Depending on the concrete class here
 * would close that loop into an import cycle.
 */
export interface HostToolBridgeLike {
  /**
   * The tools this bridge answers, when it carries them itself. The session
   * announces these at handshake; `setHostToolBridge`'s second argument wins
   * over them, and with neither the session registers nothing and says so.
   *
   * A method rather than a property because the bridge derives it from the
   * handlers it was built with, so there is no array to hold.
   */
  definitions?(): readonly HostToolDefinition[];
  /** Must return immediately: omp issues parallel calls in a single turn. */
  handleCall(frame: {
    id: string;
    toolCallId: string;
    toolName: string;
    arguments: Record<string, unknown>;
  }): void;
  handleCancel(frame: { id: string; targetId: string }): void;
  /** The agent this bridge answered is gone; settle everything still pending. */
  abortAll(reason: string): void;
  /**
   * The session itself is gone for good. Unlike `abortAll` this is permanent:
   * a call still buffered in the parser when the tab closed must be refused,
   * not started. Optional so a host can hand in a bridge that only aborts.
   */
  dispose?(): void;
}

/** Sanitized messages mirrored to an authenticated Remote Control device. */
export interface RemoteSessionMessage {
  sessionId: string;
  message: Record<string, unknown>;
}

interface WebviewMessage {
  t?: string;
  [key: string]: unknown;
}

/**
 * VS Code commands the composer's own slash commands may run.
 *
 * Only the local webview can reach this: a paired phone speaks the typed
 * RemoteCommand protocol, which has no passthrough for raw webview messages.
 * The allowlist is what keeps that true if a passthrough is ever added --
 * `ompcode.remoteStart` mints a fresh pairing secret, so a phone must never
 * be able to ask for one.
 */
const PANEL_SLASH_COMMANDS: ReadonlySet<string> = new Set([
  "ompcode.remoteStart",
  "ompcode.remoteStartAllSessions",
  "ompcode.remoteRefreshPairing",
  "ompcode.remoteStatus",
  "ompcode.remoteStop",
]);

export interface OmpSessionCallbacks {
  /** Asked by the webview to open a new chat tab (topbar ＋). */
  onOpenNewTab?: () => void;
  /** Session title changed by the agent (used for editor tab titles). */
  onTitle?: (title: string) => void;
  /** Fresh agent state — drives the status bar item. */
  onState?: (state: unknown) => void;
  /** Bring this session's UI to the front (notification "Open chat"). */
  onReveal?: () => void;
  /** Close this session's UI surface — the board's per-row close action. */
  onClose?: () => void;
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
  existedBefore: boolean;
  /** File state immediately after tool_execution_end; absent if it could not be read. */
  afterHash?: string;
}

/** One routed prompt, held until its original model has been restored. */
interface RoutedTurn {
  proc: OmpProcess;
  restore: { provider: string; modelId: string };
  done: Promise<void>;
  resolve: () => void;
  restoring?: Promise<void>;
}

/** Identity of a diagnostic for before/after delta — position + text. */
function diagKey(d: vscode.Diagnostic): string {
  return `${d.range.start.line}:${d.range.start.character}:${d.severity}:${d.message}`;
}

function isEnoent(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as NodeJS.ErrnoException).code === "ENOENT";
}

function toRemoteJson(value: unknown): JsonValue {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

/**
 * One chat session: a single OmpProcess bridged to exactly one attached
 * webview (the sidebar view or an editor tab panel).
 */
export class OmpSession implements vscode.Disposable {
  private static readonly active = new Set<OmpSession>();
  private static remoteMessageEmitter: vscode.EventEmitter<RemoteSessionMessage> | undefined;

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

  /** Same host-side UI feed the webview consumes; never accepts data back. */
  static get onRemoteMessage(): vscode.Event<RemoteSessionMessage> {
    if (!OmpSession.remoteMessageEmitter) {
      OmpSession.remoteMessageEmitter = new vscode.EventEmitter<RemoteSessionMessage>();
    }
    return OmpSession.remoteMessageEmitter.event;
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
  /** What the active profile was resolved from; see pushProfile. */
  private activeModel: MatchableModel | undefined;
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
  /** Snapshot reads may still be running when the matching tool-end arrives. */
  private readonly snapshotJobs = new Map<string, Promise<void>>();
  /** Diagnostics captured before the first pending edit, by file path. */
  private readonly diagBaseline = new Map<string, Set<string>>();
  /** Trailing debounce per file so a burst of edits reports once. */
  private readonly diagTimers = new Map<string, NodeJS.Timeout>();

  /** Prompts and model mutations are ordered per session. */
  private modelOperationQueue: Promise<void> = Promise.resolve();
  /** Routed transaction held through agent_end and restoration. */
  private routedTurn: RoutedTurn | undefined;
  /** Covers the prompt-ack → agent_start gap as well as an actively streaming turn. */
  private turnPendingOrActive = false;
  /**
   * Sends handed to this session that have not reached the agent yet.
   *
   * `turnPendingOrActive` only starts at the `prompt` request itself, so it
   * misses everything before it: the handshake a workspace's opening prompt
   * waits on, and the model-operation queue. A counter rather than a flag
   * because a steer can be handed over while an earlier send is still in
   * flight, and the first one to land must not clear the other's mark.
   */
  private queuedSends = 0;
  /** A published session outlives a closed editor surface until Remote Control releases it. */
  private remoteLeaseCount = 0;
  private surfaceClosed = false;
  private fullyDisposed = false;

  // ------------------------------------------------------------- session board

  /** Modal approval dialogs queued or on screen, by request id — the board's "asks" state. */
  private readonly uiPendingIds = new Set<string>();
  /** Original closed-schema request needed to validate a remote response. */
  private readonly uiPendingFrames = new Map<string, OmpFrame>();
  /** Last session cost in dollars from get_session_stats. */
  private lastCost = 0;

  // ------------------------------------------------------------- host tools

  /** Orchestration bridge, when extension.ts wired one into this session. */
  private hostToolBridge: HostToolBridgeLike | undefined;
  /** Definitions announced with `set_host_tools` on every handshake. */
  private hostToolDefs: readonly HostToolDefinition[] = [];
  /**
   * Tool name per in-flight call id. `host_tool_result` carries only the id,
   * so without this the chat line for a finished call could not name the tool.
   */
  private readonly hostToolCalls = new Map<string, string>();

  /**
   * Subagents seen on this process, keyed by omp's subagent id. Kept by the
   * extension rather than fetched on demand: `get_subagents` answers with the
   * running agents only, so a finished one would vanish from the board the
   * moment it succeeded, taking its cost and transcript link with it.
   */
  private subagentState = new Map<string, SubagentInfo>();
  /** Pending coalesced flush of subagent progress; see `noteSubagentProgress`. */
  private subagentFlushTimer: ReturnType<typeof setTimeout> | undefined;
  /** A progress frame arrived while the flush window was open. */
  private subagentDirty = false;
  /** Title the agent set for this session (`setTitle`), if any. */
  private sessionTitle = "";
  /** Stable identity for the board; random, never persisted. */
  private readonly sessionId = crypto.randomUUID();
  /** Change feed the session board listens to. */
  private static boardEmitter: vscode.EventEmitter<void> | undefined;

  private static boardChanges(): vscode.EventEmitter<void> {
    if (!OmpSession.boardEmitter) {
      OmpSession.boardEmitter = new vscode.EventEmitter<void>();
    }
    return OmpSession.boardEmitter;
  }

  /** Fires whenever any board-visible field of any session may have moved. */
  static get onBoardChange(): vscode.Event<void> {
    return OmpSession.boardChanges().event;
  }

  private static notifyBoard(): void {
    OmpSession.boardChanges().fire();
  }

  /** Board row data for this session. */
  snapshot(): SessionInfo {
    return {
      id: this.sessionId,
      title: this.sessionTitle,
      cwd: this.workspaceCwd(),
      model:
        this.activeModel?.id ??
        (this.activeModel?.provider ? String(this.activeModel.provider) : ""),
      provider: this.activeModel?.provider ?? "",
      status: !this.initialized
        ? "starting"
        : this.uiPendingIds.size > 0
          ? "asks"
          : this.streaming
            ? "working"
            : "idle",
      pending: this.queuedSends > 0 || this.turnPendingOrActive || this.streaming,
      procState: this.procState,
      turnsCompleted: this.turnsCompleted,
      ...(this.lastError ? { lastError: this.lastError } : {}),
      ...(this.turnStartedAt ? { turnStartedAt: this.turnStartedAt } : {}),
      cost: this.lastCost,
      subagents: subagentSnapshot(this.subagentState).subagents,
      closable: !this.surfaceClosed && this.callbacks.onClose !== undefined,
      ...(this.overrides.workspaceId ? { workspaceId: this.overrides.workspaceId } : {}),
      ...(this.overrides.branch ? { branch: this.overrides.branch } : {}),
    };
  }

  /** Every live session, oldest first — the board's row order. */
  static allSessions(): OmpSession[] {
    return [...OmpSession.active];
  }

  /** Send the abort signal — the board's stop button. */
  abort(): void {
    this.proc?.send({ type: "abort" });
  }

  /** Public abort surface for board and remote wiring; same signal as abort(). */
  abortTurn(): void {
    this.abort();
  }

  /** Close the session's UI surface when it has one. */
  requestClose(): void {
    this.callbacks.onClose?.();
  }

  /** Bring this session's chat surface to the front — the board's reveal action. */
  reveal(): void {
    if (!this.surfaceClosed) {
      this.callbacks.onReveal?.();
    }
  }

  get remoteSessionId(): string {
    return this.sessionId;
  }

  get remoteWorkspaceRoot(): string {
    return this.workspaceCwd();
  }

  get canRemoteClose(): boolean {
    return this.callbacks.onClose !== undefined;
  }

  /** Hold the existing process; this never spawns a second `omp`. */
  retainRemoteLease(): vscode.Disposable {
    if (this.fullyDisposed) {
      throw new Error("session is already disposed");
    }
    this.remoteLeaseCount += 1;
    let released = false;
    return new vscode.Disposable(() => {
      if (released) return;
      released = true;
      this.remoteLeaseCount = Math.max(0, this.remoteLeaseCount - 1);
      if (this.remoteLeaseCount === 0 && this.surfaceClosed) {
        this.disposeNow();
      }
    });
  }

  /**
   * True when this session may drive workspaces. Explicit override first, then
   * the role: workspace sessions are workers and never orchestrate.
   */
  get orchestrates(): boolean {
    return this.overrides.orchestrator ?? this.overrides.workspaceId === undefined;
  }

  /**
   * Write one raw frame to this session's agent — the transport a
   * HostToolBridge is built with (`transport: { send: (f) => s.sendHostToolFrame(f) }`,
   * or just `s.hostToolTransport`).
   *
   * Results are addressed by call id, so a frame written after the process
   * died is dropped on the floor; the bridge hears about that through
   * `abortAll` instead.
   */
  sendHostToolFrame(frame: Record<string, unknown>): void {
    this.noteHostToolResult(frame);
    this.proc?.send(frame);
  }

  /** `sendHostToolFrame` in the shape a bridge takes as its transport. */
  get hostToolTransport(): { send(frame: Record<string, unknown>): void } {
    return { send: (frame: Record<string, unknown>): void => this.sendHostToolFrame(frame) };
  }

  /**
   * Install the orchestration bridge, and the definitions to announce for it.
   *
   * The bridge is built in extension.ts and pushed down here rather than
   * imported, so a live agent can be told at once and a not-yet-started one
   * announces the tools on its first handshake. Attaching a bridge is not
   * itself the switch: `ompcode.orchestratorTools` is read at handshake time,
   * so toggling it takes effect on the next agent start with no re-wiring.
   */
  setHostToolBridge(
    bridge: HostToolBridgeLike,
    definitions: readonly HostToolDefinition[] = bridge.definitions?.() ?? [],
  ): void {
    this.hostToolBridge = bridge;
    this.hostToolDefs = definitions;
    if (definitions.length === 0) {
      this.output.appendLine(
        "[omp] host tool bridge attached with no tool definitions — nothing will be registered",
      );
    }
    if (this.initialized && this.proc) {
      void this.registerHostTools(this.proc);
    }
  }

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly callbacks: OmpSessionCallbacks = {},
    private readonly diffStore?: DiffStore,
    /** Multi-root workspaces: the folder this session's agent runs in. */
    private readonly sessionCwd?: string,
    /** Workspace pins that win over the window-wide settings; see SessionOverrides. */
    private readonly overrides: SessionOverrides = {},
  ) {
    OmpSession.active.add(this);
    OmpSession.notifyBoard();
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
    if (this.fullyDisposed) return;
    // A panel can close while a phone is still controlling its live process.
    // Detach only the surface; the final lease release performs real cleanup.
    this.surfaceClosed = true;
    this.detach();
    if (this.remoteLeaseCount > 0) {
      OmpSession.notifyBoard();
      return;
    }
    this.disposeNow();
  }

  /**
   * Stop this session and wait until its omp process is really gone.
   *
   * `dispose()` deliberately keeps the child alive while a Remote Control
   * device holds a lease, and `stop()` only sends SIGTERM. Deleting a workspace
   * has to know that the process holding the worktree as its cwd has released
   * it before the directory is removed — on Windows an open handle there makes
   * `git worktree remove` fail outright.
   */
  async disposeAndWait(): Promise<void> {
    const proc = this.proc;
    this.forceDispose();
    await proc?.whenExited();
  }

  /** Extension shutdown must never leave an orphan child process. */
  forceDispose(): void {
    this.remoteLeaseCount = 0;
    this.surfaceClosed = true;
    this.disposeNow();
  }

  private disposeNow(): void {
    if (this.fullyDisposed) return;
    this.fullyDisposed = true;
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
    this.streaming = false;
    this.turnPendingOrActive = false;
    this.queuedSends = 0;
    this.uiPendingIds.clear();
    this.uiPendingFrames.clear();
    this.resetSubagents();
    this.abandonRoutedTurn();
    this.hostToolsDown("session disposed");
    // Permanent, unlike the abort the line above does: this session will never
    // handshake again, so a host_tool_call still sitting in the stdout parser
    // must be refused rather than started against a dead process. The
    // restart/exit paths keep using `hostToolsDown` alone — they do come back.
    this.hostToolBridge?.dispose?.();
    proc?.stop();
    OmpSession.notifyBoard();
  }

  /**
   * Bind the session to a webview. The caller must have set
   * `webview.options` (enableScripts + localResourceRoots) beforehand.
   */
  attach(webview: vscode.Webview): void {
    if (this.fullyDisposed) {
      throw new Error("cannot attach a disposed OMP session");
    }
    this.surfaceClosed = false;
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
      this.resetSubagents(); // the new conversation inherits no subagents
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
    if (typeof file === "string" && file && file !== this.lastSessionFile) {
      this.lastSessionFile = file;
      // The owner (a workspace record) persists this so the conversation can be
      // reopened after VS Code restarts. Only real moves are reported — every
      // state push carries the path, and rewriting storage on each would churn.
      this.overrides.onSessionFile?.(file);
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

  /**
   * First handshake of a session that was opened for an existing workspace:
   * reattach to the conversation that workspace was last on.
   *
   * omp always starts a fresh session on spawn, so reopening a workspace after
   * a VS Code restart would otherwise face an agent with no memory of its own
   * worktree. Runs once: every later respawn is a restart, and `restart()` /
   * the crash path already reattach to the *live* conversation, which by then
   * has moved past the file the workspace record was created with.
   */
  private async resumeOverrideSession(proc: OmpProcess): Promise<boolean> {
    const sessionPath = this.overrides.sessionFile;
    if (!sessionPath || this.overrideResumeAttempted) {
      return false;
    }
    this.overrideResumeAttempted = true;
    try {
      const result = (await proc.request({ type: "switch_session", sessionPath })) as
        | { cancelled?: boolean }
        | undefined;
      if (this.proc !== proc || result?.cancelled) {
        return false;
      }
      const data = await proc.request({ type: "get_messages" });
      if (this.proc !== proc) {
        return false;
      }
      this.post({ t: "reset" });
      this.post({ t: "transcript", messages: this.extractList(data, "messages") });
      this.lastSessionFile = sessionPath;
      this.output.appendLine(`[omp] reopened workspace session ${sessionPath}`);
      return true;
    } catch (err) {
      // A stale or deleted JSONL must not stop the workspace from opening: the
      // agent stays on the empty session it started with.
      this.output.appendLine(
        `[omp] could not reopen workspace session ${sessionPath}: ${String(err)}`,
      );
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
    this.streaming = false;
    this.turnPendingOrActive = false;
    this.turnStartedAt = 0;
    this.autoRestartAttempts = 0;
    this.uiPendingIds.clear(); // dialogs of the dying process will never be answered
    this.uiPendingFrames.clear();
    this.resetSubagents();
    this.abandonRoutedTurn(); // the restored model died with the process
    this.hostToolsDown("agent restarting");
    proc?.stop();
    OmpSession.notifyBoard();
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
      // A provider with no env var carries its key in models.yml instead;
      // inventing a variable name for it here would only mislead diagnostics.
      if (!p.envVar) {
        continue;
      }
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
      const target = this.configuredModel();
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

  /**
   * "provider/modelId" this process runs on: the session's own pin when it has
   * one, otherwise the window's default. Read through this everywhere, so the
   * model chosen at spawn and the one set after the handshake cannot diverge.
   */
  private configuredModel(): string {
    const pinned = this.overrides.model?.trim();
    if (pinned) {
      return pinned;
    }
    return (
      vscode.workspace.getConfiguration("ompcode").get<string>("defaultModel", "") ?? ""
    ).trim();
  }

  /**
   * Put the process on {@link configuredModel}. Failures are logged, never
   * thrown: a model omp does not know must leave a usable agent behind.
   */
  private async applyConfiguredModel(proc: OmpProcess): Promise<void> {
    const target = this.configuredModel();
    if (!target) {
      return;
    }
    const slash = target.indexOf("/");
    if (slash <= 0 || slash >= target.length - 1) {
      this.output.appendLine(`[omp] model "${target}" is not "provider/modelId" — skipped`);
      return;
    }
    try {
      await proc.request({
        type: "set_model",
        provider: target.slice(0, slash),
        modelId: target.slice(slash + 1),
      });
    } catch (err) {
      this.output.appendLine(
        `[omp] set_model "${target}" failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Pin this session to a model the user just chose.
   *
   * Picking a model in a chat pins it to that chat. Restarts are routine here —
   * changing the approval tier or any `ompcode.*` value respawns the process —
   * and `configuredModel()` reads this pin. Without it a restart fell back to
   * `ompcode.defaultModel`, so a session the user had moved to another model
   * silently came back on the window default. A pinned session also stops
   * following later changes of that default, which is the point: the pick was
   * explicit, and parallel chats on different models are the reason this
   * extension has per-session models at all.
   *
   * Shared by the chat's own picker and by Remote Control's `model.set`, so a
   * model chosen from the phone survives a restart and a window reload exactly
   * as one chosen in the panel does. Deliberately *not* used by the dead-model
   * failover or by a routed turn's temporary swap: those are the machine's
   * choice, not the user's, and leaving the pin alone is what lets the original
   * model be retried.
   */
  private pinModel(provider: string, modelId: string): void {
    const pinned = `${provider}/${modelId}`;
    this.overrides.model = pinned;
    // Workspace sessions carry the model in their record, so the owner
    // persists it; a plain chat's tab record keeps it for the restore path.
    this.overrides.onModel?.(pinned);
  }

  /**
   * Whether this session still follows the window-wide setting `key`.
   *
   * The configuration watcher restarts every session when any `ompcode.*` value
   * moves. A session that pinned the value has nothing to pick up from such a
   * change, and restarting it would throw away a running turn for nothing.
   */
  usesSetting(key: "defaultModel" | "approvalMode"): boolean {
    return key === "defaultModel"
      ? !this.overrides.model?.trim()
      : this.overrides.approvalMode === undefined;
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
    this.streaming = false;
    this.turnPendingOrActive = false;
    this.turnStartedAt = 0;
    this.uiPendingIds.clear();
    this.uiPendingFrames.clear();
    this.resetSubagents();
    this.abandonRoutedTurn();
    this.hostToolsDown("agent replaced");
    stale?.stop();
    OmpSession.notifyBoard();

    // Deferred settled by initialize() — gates prompts until the agent is negotiated.
    this.initDone = new Promise<void>((resolve, reject) => {
      this.initResolve = resolve;
      this.initReject = reject;
    });
    this.initDone.catch(() => {}); // avoid unhandled rejection when nobody awaits

    this.procState = "starting";
    this.lastError = undefined;
    this.post({ t: "proc", status: "starting" });

    const cfg = vscode.workspace.getConfiguration("ompcode");
    const ompPath = cfg.get<string>("ompPath", "omp") || "omp";
    const approvalMode = this.approvalSetting().mode;
    const configured = cfg.get<Record<string, unknown>>("customProviders", {});
    const customProviders = await this.injectProviderKeys(
      await this.withShippedProviders(configured),
    );

    try {
      // Order matters: a block whose key is gone has to leave before the file
      // is written, or omp reads it, fails validation, and drops every custom
      // provider in it — the user's own included.
      await this.pruneShippedProviders(configured);
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
      this.streaming = false;
      this.turnPendingOrActive = false;
      this.turnStartedAt = 0;
      this.uiPendingIds.clear();
      this.uiPendingFrames.clear();
      this.resetSubagents();
      this.abandonRoutedTurn();
      this.hostToolsDown("agent exited");
      OmpSession.notifyBoard();
      const detail = `agent exited (code ${code ?? "?"}${signal ? `, signal ${signal}` : ""})`;
      this.initReject?.(new Error(detail));
      this.output.appendLine(`[omp] ${detail}`);
      // omp exits immediately when it has no configured models/keys — no
      // amount of restarting fixes that, so go straight to the setup card.
      const needsSetup = /No models available/i.test(stderrTail);
      if (needsSetup) {
        this.procState = "exited";
        this.lastError = detail;
        this.post({ t: "proc", status: "exited", detail, needsSetup });
        return;
      }
      this.autoRestartAttempts++;
      if (this.autoRestartAttempts <= 1) {
        this.output.appendLine("[omp] auto-restarting after crash…");
        this.procState = "restarting";
        this.lastError = detail;
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
      this.procState = "exited";
      this.lastError = detail;
      this.post({ t: "proc", status: "exited", detail, needsSetup });
    });
    proc.onError((err: NodeJS.ErrnoException) => {
      if (this.proc !== proc) {
        return;
      }
      this.initialized = false;
      this.streaming = false;
      this.turnPendingOrActive = false;
      this.turnStartedAt = 0;
      this.uiPendingIds.clear();
      this.uiPendingFrames.clear();
      this.resetSubagents();
      this.abandonRoutedTurn();
      this.hostToolsDown("agent process error");
      OmpSession.notifyBoard();
      const isEnoent = err.code === "ENOENT";
      const detail = isEnoent
        ? t(
            'Cannot find the omp binary "{0}". Install it (bun install -g @oh-my-pi/pi-coding-agent) or set "ompcode.ompPath" to the correct path.',
            ompPath,
          )
        : `omp process error: ${err.message}`;
      this.initReject?.(new Error(detail));
      this.output.appendLine(`[omp] ${detail}`);
      this.procState = "error";
      this.lastError = detail;
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
      this.turnPendingOrActive = true;
      this.turnStartedAt = Date.now();
      OmpSession.notifyBoard();
    } else if (frame.type === "agent_end") {
      this.streaming = false;
      this.turnPendingOrActive = false;
      this.notifyTurnDone(); // also clears turnStartedAt
      this.turnsCompleted++;
      void this.pushSessionStats();
      void this.finishRoutedTurn(proc);
      OmpSession.notifyBoard();
    } else if (frame.type === "tool_execution_start") {
      const id = typeof frame.toolCallId === "string" ? frame.toolCallId : "";
      const job = this.snapshotTool(frame);
      if (id) {
        this.snapshotJobs.set(id, job);
        void job.then(() => {
          if (this.snapshotJobs.get(id) === job) {
            this.snapshotJobs.delete(id);
          }
        }, (err) => {
          if (this.snapshotJobs.get(id) === job) {
            this.snapshotJobs.delete(id);
          }
          this.output.appendLine(`[omp] edit snapshot failed: ${String(err)}`);
        });
      }
    } else if (frame.type === "tool_execution_end") {
      void this.finishToolSnapshot(frame);
    }
    if (frame.type === "host_tool_call" || frame.type === "host_tool_cancel") {
      // Answered by the bridge over stdin, never by the webview. Forwarding
      // the raw frame would make the chat render an unknown event; the
      // `hostTool` message below is the readable form of the same thing.
      this.handleHostToolFrame(frame);
      return;
    }
    if (isSubagentFrame(frame)) {
      this.handleSubagentFrame(frame);
      // Progress and raw child events are coalesced into `t:"subagents"`;
      // only lifecycle carries on to the webview as a frame.
      if (frame.type !== "subagent_lifecycle") {
        return;
      }
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
          this.sessionTitle = title;
          this.callbacks.onTitle?.(title);
          OmpSession.notifyBoard();
        }
      } else if (
        frame.method === "confirm" ||
        frame.method === "select" ||
        frame.method === "input" ||
        frame.method === "editor"
      ) {
        // A modal approval dialog the webview will show — the board surfaces it.
        const id = typeof frame.id === "string" ? frame.id : "";
        if (id) {
          this.uiPendingIds.add(id);
          this.uiPendingFrames.set(id, frame);
          OmpSession.notifyBoard();
        }
      } else if (frame.method === "cancel") {
        // The agent withdraws a pending dialog; the webview drops it too, and
        // no uiResponse will ever arrive for it.
        const target =
          (typeof frame.targetId === "string" && frame.targetId) ||
          (typeof frame.requestId === "string" && frame.requestId) ||
          (typeof frame.cancelId === "string" && frame.cancelId) ||
          "";
        if (target && claimPendingApproval(target, this.uiPendingIds, this.uiPendingFrames)) {
          OmpSession.notifyBoard();
          this.post({
            t: "approvalResolved",
            requestId: target,
            outcome: "cancelled",
            winner: "agent",
          });
        }
      }
    }
  }

  // ---------------------------------------------------------- host tools

  /** Route one `host_tool_*` frame to the bridge and echo it into the chat. */
  private handleHostToolFrame(frame: OmpFrame): void {
    const id = typeof frame.id === "string" ? frame.id : "";
    if (!id) {
      this.output.appendLine(`[omp] ${String(frame.type)} without an id — ignored`);
      return;
    }
    const bridge = this.hostToolBridge;
    if (!bridge) {
      // Only reachable if omp remembers tools this session never registered.
      this.output.appendLine(`[omp] ${String(frame.type)} arrived with no host tool bridge`);
      return;
    }
    if (frame.type === "host_tool_cancel") {
      const targetId = typeof frame.targetId === "string" ? frame.targetId : "";
      if (!targetId) {
        return;
      }
      this.output.appendLine(`[omp] host tool cancel → ${targetId}`);
      bridge.handleCancel({ id, targetId });
      return;
    }
    const toolName = typeof frame.toolName === "string" ? frame.toolName : "";
    const toolCallId = typeof frame.toolCallId === "string" ? frame.toolCallId : id;
    const args =
      frame.arguments && typeof frame.arguments === "object" && !Array.isArray(frame.arguments)
        ? (frame.arguments as Record<string, unknown>)
        : {};
    this.hostToolCalls.set(id, toolName);
    this.output.appendLine(`[omp] host tool call ${toolName} (${id})`);
    this.post({
      t: "hostTool",
      phase: "call",
      name: toolName,
      id,
      summary: OmpSession.hostToolArgSummary(args),
    });
    // Deliberately not awaited: omp fires several calls in one turn and they
    // have to run at the same time.
    bridge.handleCall({ id, toolCallId, toolName, arguments: args });
  }

  /** One-line preview of a tool's arguments for the chat row. */
  private static hostToolArgSummary(args: Record<string, unknown>): string {
    const parts: string[] = [];
    for (const [key, value] of Object.entries(args)) {
      let text: string;
      if (typeof value === "string") {
        text = value;
      } else if (Array.isArray(value)) {
        text = value.map((item) => String(item)).join(", ");
      } else if (value === null || value === undefined) {
        continue;
      } else if (typeof value === "object") {
        text = JSON.stringify(value);
      } else {
        text = String(value);
      }
      text = text.replace(/\s+/g, " ").trim();
      if (!text) continue;
      parts.push(`${key}: ${text.length > 80 ? `${text.slice(0, 80)}…` : text}`);
    }
    const summary = parts.join(" · ");
    return summary.length > 200 ? `${summary.slice(0, 200)}…` : summary;
  }

  /**
   * Watch frames on their way to the agent so a finished call reaches the
   * chat. The bridge owns the result; the session only reports it.
   */
  private noteHostToolResult(frame: Record<string, unknown>): void {
    if (frame.type !== "host_tool_result") {
      return;
    }
    const id = typeof frame.id === "string" ? frame.id : "";
    if (!id) return;
    const name = this.hostToolCalls.get(id) ?? "";
    this.hostToolCalls.delete(id);
    const isError = frame.isError === true;
    this.output.appendLine(`[omp] host tool ${isError ? "failed" : "done"} ${name} (${id})`);
    this.post({
      t: "hostTool",
      phase: "result",
      name,
      id,
      isError,
      summary: OmpSession.hostToolResultSummary(frame.result),
    });
  }

  /** First text block of an AgentToolResult, clipped for a chat row. */
  private static hostToolResultSummary(result: unknown): string {
    if (!result || typeof result !== "object") return "";
    const content = (result as Record<string, unknown>).content;
    if (!Array.isArray(content)) return "";
    for (const block of content) {
      if (block && typeof block === "object") {
        const text = (block as Record<string, unknown>).text;
        if (typeof text === "string" && text.trim()) {
          const flat = text.replace(/\s+/g, " ").trim();
          return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
        }
      }
    }
    return "";
  }

  /**
   * Announce the orchestration tools to a freshly negotiated agent.
   *
   * A failure here is a degradation, not a fault: the chat keeps working, it
   * just cannot drive workspaces, and the reason belongs in the log where the
   * missing tools will be explained.
   */
  private async registerHostTools(proc: OmpProcess): Promise<void> {
    const bridge = this.hostToolBridge;
    if (!bridge || this.hostToolDefs.length === 0 || !this.orchestrates) {
      return;
    }
    if (!vscode.workspace.getConfiguration("ompcode").get<boolean>("orchestratorTools", true)) {
      return;
    }
    try {
      const data = await proc.request({ type: "set_host_tools", tools: this.hostToolDefs });
      const names = this.extractList(data, "toolNames")
        .map((name) => String(name))
        .join(", ");
      this.output.appendLine(`[omp] host tools registered: ${names || "(none reported)"}`);
    } catch (err) {
      this.output.appendLine(
        `[omp] set_host_tools failed — workspace orchestration is unavailable: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** The agent that could answer host tool calls is gone; settle them all. */
  private hostToolsDown(reason: string): void {
    // The bridge first: its own error results travel back through
    // `sendHostToolFrame`, which draws the chat row and forgets the call. Only
    // what it leaves behind — or everything, when there is no bridge — is
    // closed out by hand, so no call is reported twice.
    this.hostToolBridge?.abortAll(reason);
    for (const [id, name] of this.hostToolCalls) {
      this.post({ t: "hostTool", phase: "result", name, id, isError: true, summary: reason });
    }
    this.hostToolCalls.clear();
  }

  private async initialize(proc: OmpProcess): Promise<void> {
    try {
      await proc.request({ type: "negotiate_protocol", protocolVersion: 2 });
      if (this.proc !== proc) {
        return;
      }
      this.procState = "running";
      this.lastError = undefined;
      this.post({ t: "proc", status: "running" });

      // Initial fetches run concurrently (state is re-fetched after set_* below).
      const [stateInit, modelsData, commandsData] = await Promise.all([
        proc.request({ type: "get_state" }),
        proc.request({ type: "get_available_models" }),
        proc.request({ type: "get_available_commands" }),
      ]);
      const models = this.extractList(modelsData, "models");
      const commands = this.extractList(commandsData, "commands");
      await this.subscribeSubagents(proc);
      if (typeof (stateInit as Record<string, unknown>)?.isStreaming === "boolean") {
        this.streaming = (stateInit as Record<string, unknown>).isStreaming as boolean;
        this.turnPendingOrActive = this.streaming;
      }

      const cfg = vscode.workspace.getConfiguration("ompcode");
      await this.applyConfiguredModel(proc);

      const level = cfg.get<string>("thinkingLevel", "auto");
      try {
        await proc.request({ type: "set_thinking_level", level });
      } catch (err) {
        this.output.appendLine(
          `[omp] set_thinking_level "${level}" failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Before any prompt can arrive: a turn that starts without the tools
      // registered would answer as if workspaces did not exist.
      await this.registerHostTools(proc);

      const resumedOverride = await this.resumeOverrideSession(proc);
      if (resumedOverride) {
        // `switch_session` restores the model recorded in that JSONL, which
        // would silently drop the workspace's pin on every reopen.
        await this.applyConfiguredModel(proc);
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
      OmpSession.notifyBoard();
    } catch (err) {
      if (this.proc !== proc) {
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.initialized = false;
      this.streaming = false;
      this.turnPendingOrActive = false;
      this.uiPendingIds.clear();
      this.uiPendingFrames.clear();
      this.resetSubagents();
      this.abandonRoutedTurn();
      this.hostToolsDown("handshake failed");
      this.initReject?.(new Error(`init failed: ${message}`));
      this.output.appendLine(`[omp] init failed: ${message}`);
      const detail = `init failed: ${message}`;
      this.procState = "error";
      this.lastError = detail;
      this.post({ t: "proc", status: "error", detail });
      OmpSession.notifyBoard();
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
              // The session's own model, not the window's: a workspace chat
              // runs on a pinned one and its chip must say so.
              defaultModel: this.configuredModel(),
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
          const fm = msg.forModel;
          const forModel =
            fm === undefined
              ? undefined
              : {
                  provider:
                    fm && typeof fm === "object" &&
                    typeof (fm as Record<string, unknown>).provider === "string"
                      ? ((fm as Record<string, unknown>).provider as string).trim()
                      : "",
                  modelId:
                    fm && typeof fm === "object" &&
                    typeof (fm as Record<string, unknown>).modelId === "string"
                      ? ((fm as Record<string, unknown>).modelId as string).trim()
                      : "",
                };
          await this.promptOnce(message, forModel);
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
        case "runCommand": {
          const command = typeof msg.command === "string" ? msg.command : "";
          if (!PANEL_SLASH_COMMANDS.has(command)) {
            return;
          }
          await vscode.commands.executeCommand(command);
          return;
        }
        case "setModel": {
          const provider = typeof msg.provider === "string" ? msg.provider.trim() : "";
          const modelId = typeof msg.modelId === "string" ? msg.modelId.trim() : "";
          if (!provider || !modelId) {
            return;
          }
          await this.queueModelOperation(async () => {
            await this.ensureStarted();
            if (!this.initialized) {
              await this.initDone;
            }
            await this.request({ type: "set_model", provider, modelId });
            this.pinModel(provider, modelId);
            await this.pushState();
          });
          return;
        }
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
          if (!this.usesSetting("approvalMode")) {
            // A pinned tier belongs to the workspace record, not to settings:
            // writing the window setting here would restart every *other*
            // session onto a tier this one would go on ignoring. So the pin
            // itself moves, and only this session restarts — approval is a
            // spawn argument, so nothing else can apply it.
            const pinned = mode as ApprovalMode;
            if (this.overrides.approvalMode === pinned) {
              return;
            }
            this.overrides.approvalMode = pinned;
            this.overrides.onApprovalMode?.(pinned);
            this.output.appendLine(`[omp] workspace approval tier is now "${pinned}" — restarting`);
            this.pushApproval();
            await this.restart();
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
        case "setProfileField": {
          const family = typeof msg.family === "string" ? msg.family : "";
          const field = msg.field;
          // null clears the override; anything else must be a plain string,
          // since both editable fields are closed-set scalars.
          const value = msg.value === null ? null : typeof msg.value === "string" ? msg.value : undefined;
          if (!family || !isEditableProfileField(field) || value === undefined) {
            return;
          }
          await this.updateUserProfileField(family, field, value);
          return;
        }
        case "openProfileSettings":
          // The overlay is a free-form settings bag; a hand-rolled editor for
          // it would be worse than the real one.
          await vscode.commands.executeCommand("workbench.action.openSettingsJson", {
            revealSetting: { key: "ompcode.modelProfiles", edit: true },
          });
          return;
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
            try {
              this.deliverApprovalResponse(msg.frame as Record<string, unknown>, "desktop");
            } catch (error) {
              // A remote response may have won immediately before the local
              // click reached the extension host. The resolved event already
              // removes the desktop modal; never send a second response.
              if (!(error instanceof ApprovalNotPendingError)) throw error;
            }
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
        case "rejectEdit":
          await this.revertEdit(typeof msg.toolCallId === "string" ? msg.toolCallId : "");
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
          // omp will happily start a credential flow for any provider it knows.
          // The UI offers four; anything else arriving here is a bug or a probe.
          if (!LOGIN_PROVIDERS.some((entry) => entry.id === providerId)) {
            this.output.appendLine(`[omp] refused login for unsupported provider "${providerId}"`);
            return;
          }
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
  /** Guards the one-shot reattach to `overrides.sessionFile`; see resumeOverrideSession. */
  private overrideResumeAttempted = false;
  /** Profile of the model currently selected, or undefined before the first state. */
  private activeProfile: ResolvedProfile | undefined;

  /** agent_start timestamp — completion notifications only fire for slow turns. */
  private turnStartedAt = 0;

  /** Board-facing process lifecycle, mirroring the last `{t:"proc"}` post. */
  private procState: SessionInfo["procState"] = "starting";
  /** Last process/init failure detail; cleared once a process is starting/healthy. */
  private lastError: string | undefined;
  /** Turns completed — agent_end increments, get_session_stats corrects. */
  private turnsCompleted = 0;

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
    let existedBefore = true;
    try {
      before = await fs.readFile(filePath, "utf8");
    } catch (err) {
      if (!isEnoent(err)) {
        this.output.appendLine(`[omp] could not snapshot ${filePath}: ${String(err)}`);
        return;
      }
      existedBefore = false;
      // ENOENT specifically means the tool is creating this path. An existing
      // empty file is represented by existedBefore:true, before:"".
    }
    if (before.length > 2_000_000) {
      return; // a diff this big helps nobody; skip rather than hoard memory
    }
    this.diffSnaps.set(id, { path: filePath, before, existedBefore });
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

  private async finishToolSnapshot(frame: OmpFrame): Promise<void> {
    const id = typeof frame.toolCallId === "string" ? frame.toolCallId : "";
    if (id) {
      await this.snapshotJobs.get(id)?.catch(() => {});
    }
    const snap = id ? this.diffSnaps.get(id) : undefined;
    if (!id || !snap) {
      return;
    }
    if (this.diffStore) {
      this.post({ t: "diffAvailable", toolCallId: id, path: snap.path });
    }
    try {
      let current: string | null;
      try {
        current = await fs.readFile(snap.path, "utf8");
      } catch (err) {
        if (!isEnoent(err)) {
          throw err;
        }
        current = null;
      }
      snap.afterHash = revertStateHash(current);
    } catch (err) {
      // Keep the before-snapshot. Without a trustworthy final-state hash the
      // revert will block, but a transient read failure must not erase the only
      // recovery point.
      this.output.appendLine(`[omp] could not finalize edit snapshot for ${snap.path}: ${String(err)}`);
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

  /**
   * Revert one edit/write tool call back to the before-snapshot taken just
   * before the tool ran. A blocked/failed attempt retains the snapshot so the
   * user can save/close the document or resolve drift and try again. Only a
   * successful mutation (or an already-reverted no-op) consumes it.
   */
  private async revertEdit(toolCallId: string, enforcedPath?: string): Promise<boolean> {
    const snap = this.diffSnaps.get(toolCallId);
    if (!snap) {
      this.post({
        t: "frame",
        frame: {
          type: "notice",
          level: "warning",
          message: t("That edit snapshot is no longer available."),
        },
      });
      return false;
    }
    const filePath = enforcedPath ?? snap.path;
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === filePath);
    let current: string | null;
    try {
      current = await fs.readFile(filePath, "utf8");
    } catch (err) {
      if (!isEnoent(err)) {
        this.reportError("read file for reject edit", err);
        return false;
      }
      current = null;
    }
    const plan = planRevert({
      before: snap.before,
      existedBefore: snap.existedBefore,
      current,
      dirty: doc?.isDirty === true,
      afterHash: snap.afterHash,
    });
    if (plan.action === "blocked") {
      this.output.appendLine(`[omp] reject edit blocked for ${filePath}: ${plan.reason ?? "unknown"}`);
      this.post({
        t: "frame",
        frame: {
          type: "notice",
          level: "warning",
          message:
            plan.reason === "dirty"
              ? t(
                  "{0} has unsaved changes — save or close it before reverting.",
                  path.basename(filePath),
                )
              : t("That edit snapshot is no longer available."),
        },
      });
      return false;
    }
    try {
      if (plan.action === "delete") {
        await fs.unlink(filePath);
      } else if (plan.action === "write" && plan.content !== undefined) {
        await fs.writeFile(filePath, plan.content, "utf8");
      }
      if (plan.action !== "noop") {
        this.post({
          t: "frame",
          frame: {
            type: "notice",
            level: "info",
            message: t("Reverted {0}.", path.basename(filePath)),
          },
        });
        this.post({ t: "editRejected", toolCallId });
        this.scheduleDiagCheck(filePath);
      }
      if (plan.action === "noop") {
        this.post({ t: "editRejected", toolCallId });
      }
      this.diffSnaps.delete(toolCallId);
      return true;
    } catch (err) {
      this.reportError("reject edit", err);
      return false;
    }
  }

  /**
   * One-shot routing (composer "route:" chip): send a single prompt through
   * another model, then put the session back on the model it had. The queued
   * operation stays open through agent_end and the restore RPC, so a following
   * prompt or manual model selection cannot race the restoration.
   */
  private queueModelOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.modelOperationQueue.then(operation);
    this.modelOperationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Claim a turn that is about to be sent but has not been dispatched yet, and
   * return the release for it.
   *
   * For fire-and-forget sends only — the opening prompt of a new workspace,
   * which is handed over while the agent is still handshaking. Between that
   * hand-off and the `prompt` request the session would otherwise snapshot as
   * plain "idle", and an orchestrator waiting on the worker it just created
   * would take that for "finished" and read an empty diff. Release it when the
   * send settles either way; a leaked mark leaves the row busy forever.
   *
   * Deliberately not `turnPendingOrActive`: that flag also decides whether the
   * next send is treated as a steer, and pre-setting it would turn the very
   * prompt it is guarding into a steer into a turn that does not exist.
   */
  markTurnPending(): () => void {
    this.queuedSends += 1;
    OmpSession.notifyBoard();
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.queuedSends = Math.max(0, this.queuedSends - 1);
      OmpSession.notifyBoard();
    };
  }

  /**
   * Send a prompt the user did not type — a workspace's opening instruction, a
   * steer from the orchestrating chat, a follow-up queued behind a live turn.
   *
   * Routes through the same `promptOnce` the composer uses, so queueing,
   * steering and the routed-model transaction stay in one place. Failures are
   * thrown rather than shown as a chat error: the caller is a tool whose model
   * has to be told what went wrong.
   */
  async sendPrompt(
    message: string,
    mode: "prompt" | "steer" | "follow_up" = "prompt",
  ): Promise<void> {
    const text = message.trim();
    if (!text) {
      throw new Error("prompt is empty");
    }
    await this.promptOnce(text, undefined, false, mode);
  }

  /**
   * The agent's last reply as plain text, or undefined when it has not spoken
   * yet. Used for the one-line "what is this workspace saying" column.
   */
  async lastAssistantText(): Promise<string | undefined> {
    // Never as a side effect: this is a status read (the orchestrator calls it
    // for every workspace on every wait), and `ensureStarted` would respawn an
    // agent the user or a crash had stopped just to answer it.
    if (!this.proc?.running || !this.initialized) {
      return undefined;
    }
    const data = await this.request({ type: "get_last_assistant_text" });
    const text =
      data && typeof data === "object" ? (data as Record<string, unknown>).text : undefined;
    return typeof text === "string" && text.trim() ? text : undefined;
  }

  private async promptOnce(
    message: string,
    forModel?: { provider: string; modelId: string },
    reportFailure = true,
    mode: "prompt" | "steer" | "follow_up" = "prompt",
  ): Promise<void> {
    // Whether this send landed on a live turn. A failed steer must not make
    // the webview tear down a turn that is still running.
    let steer = false;
    if (forModel && (!forModel.provider.trim() || !forModel.modelId.trim())) {
      const error = new Error("routed prompt requires provider and modelId");
      if (!reportFailure) throw error;
      this.post({ t: "promptFailed", steer: false });
      this.reportError("prompt", error);
      return;
    }
    try {
      await this.queueModelOperation(async () => {
        await this.ensureStarted();
        if (!this.initialized) {
          await this.initDone;
        }
        const proc = this.proc;
        if (!proc?.running) {
          throw new Error("omp agent is not running");
        }

        if (!forModel) {
          // A turn was already running when this send started. Left as the
          // sole source of truth for the failure path below: only a send that
          // began on an idle session may clear the turn flag again.
          const steering = this.turnPendingOrActive || this.streaming;
          // `mode` is what a caller asserts, `steering` what the session
          // believes; an explicit mode wins because the orchestrator knows why
          // it is writing into a running turn. omp spells the queued form
          // "followUp" — the host tool takes the snake_case name the model
          // writes, and this is the one place they meet.
          const behavior =
            mode === "steer"
              ? "steer"
              : mode === "follow_up"
                ? "followUp"
                : steering
                  ? "steer"
                  : undefined;
          steer = steering || behavior === "steer";
          this.turnPendingOrActive = true;
          try {
            await proc.request({
              type: "prompt",
              message,
              streamingBehavior: behavior,
            });
          } catch (err) {
            // State frames lag the agent, so omp may have started streaming
            // since the last one and rejected a plain prompt as "already
            // processing". A live turn is exactly what steer is for: retry
            // once, and from here on report failures as steer failures.
            const busy = (err instanceof Error ? err.message : String(err)).includes(
              "already processing",
            );
            if (!steering && busy) {
              steer = true;
              await proc.request({ type: "prompt", message, streamingBehavior: "steer" });
              return;
            }
            if (!steering) {
              this.turnPendingOrActive = false;
            }
            throw err;
          }
          return;
        }

        // A routed send is a complete model transaction, not a steering
        // message. Never switch models under an already-running turn.
        if (this.routedTurn || this.turnPendingOrActive || this.streaming) {
          throw new Error("cannot route a prompt while another turn is active");
        }
        const current = await this.currentModel();
        if (!current) {
          throw new Error("cannot route a prompt without a current model");
        }

        let resolveDone: () => void = () => {};
        const done = new Promise<void>((resolve) => {
          resolveDone = resolve;
        });
        const routed: RoutedTurn = {
          proc,
          restore: { provider: current.provider, modelId: current.id },
          done,
          resolve: resolveDone,
        };
        this.routedTurn = routed;
        try {
          await proc.request({
            type: "set_model",
            provider: forModel.provider.trim(),
            modelId: forModel.modelId.trim(),
          });
          this.turnPendingOrActive = true;
          await proc.request({ type: "prompt", message });
          // `prompt` is acknowledged immediately. The transaction remains
          // queued until agent_end has restored the original model.
          await routed.done;
        } catch (err) {
          this.turnPendingOrActive = false;
          await this.finishRoutedTurn(proc);
          throw err;
        }
      });
    } catch (err) {
      if (!reportFailure) throw err;
      this.post({ t: "promptFailed", steer });
      this.reportError("prompt", err);
    }
  }

  /** Put the session back on the model it had before a routed turn. */
  private async finishRoutedTurn(proc: OmpProcess): Promise<void> {
    const routed = this.routedTurn;
    if (!routed || routed.proc !== proc) {
      return;
    }
    if (!routed.restoring) {
      routed.restoring = (async () => {
        try {
          if (this.proc === proc && proc.running) {
            await proc.request({
              type: "set_model",
              provider: routed.restore.provider,
              modelId: routed.restore.modelId,
            });
            if (this.proc === proc) {
              await this.pushState();
              this.post({ t: "routedDone" });
            }
          }
        } catch (err) {
          if (this.proc === proc) {
            this.reportError("restore model", err);
          }
        } finally {
          this.turnPendingOrActive = false;
          if (this.routedTurn === routed) {
            this.routedTurn = undefined;
          }
          routed.resolve();
        }
      })();
    }
    await routed.restoring;
  }

  /** A dead/restarted process needs no restore, but must release the queue. */
  private abandonRoutedTurn(): void {
    const routed = this.routedTurn;
    if (!routed) {
      return;
    }
    this.routedTurn = undefined;
    routed.resolve();
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
      await this.queueModelOperation(async () => {
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
      });
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
  async openSession(sessionPath: string, reportFailure = true): Promise<void> {
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
      if (!reportFailure) throw err;
      this.reportError("open session", err);
    }
  }

  /**
   * Build a complete phone bootstrap from the already-running RPC process.
   * No credentials or raw environment values are included.
   */
  async remoteFullSync(): Promise<JsonValue> {
    await this.ensureStarted();
    if (!this.initialized) await this.initDone;
    const [state, modelsData, commandsData, transcriptData, stats] = await Promise.all([
      this.request({ type: "get_state" }),
      this.request({ type: "get_available_models" }),
      this.request({ type: "get_available_commands" }),
      this.request({ type: "get_messages" }),
      this.request({ type: "get_session_stats" }).catch(() => null),
    ]);
    const cfg = vscode.workspace.getConfiguration("ompcode");
    return toRemoteJson({
      session: this.snapshot(),
      state,
      models: this.extractList(modelsData, "models"),
      commands: this.extractList(commandsData, "commands"),
      transcript: this.extractList(transcriptData, "messages"),
      stats,
      approvalMode: this.approvalSetting().mode,
      profile: this.activeProfile ?? null,
      configuration: {
        defaultModel: this.configuredModel(),
        thinkingLevel: cfg.get<string>("thinkingLevel", "auto"),
        theme: OmpSession.themeId(cfg.get<string>("theme", "violet")),
      },
      approvals: [...this.uiPendingFrames.values()],
    });
  }

  /**
   * The only network-to-agent dispatcher. Every branch constructs a fixed RPC
   * frame locally; a remote object is never passed directly to stdin.
   */
  async handleRemoteCommand(command: RemoteCommand, attachments: readonly Attachment[] = []): Promise<JsonValue> {
    if (command.sessionId !== this.sessionId) {
      throw new Error("remote command targets a different session");
    }
    switch (command.command) {
      case "session.sync":
        return this.remoteFullSync();
      case "transcript.get": {
        await this.ensureStarted();
        if (!this.initialized) await this.initDone;
        const data = await this.request({ type: "get_messages" });
        return toRemoteJson({ messages: this.extractList(data, "messages") });
      }
      case "prompt.send": {
        const message = composePrompt(command.payload.text, [...attachments]);
        if (!message) throw new Error("prompt is empty");
        await this.promptOnce(message, command.payload.forModel, false);
        return { delivered: true };
      }
      case "turn.abort":
        this.proc?.send({ type: "abort" });
        return { delivered: true };
      case "approval.respond":
        return this.handleRemoteApproval(command.payload.requestId, command.payload.response);
      case "model.set":
        await this.queueModelOperation(async () => {
          await this.ensureStarted();
          if (!this.initialized) await this.initDone;
          await this.request({
            type: "set_model",
            provider: command.payload.provider,
            modelId: command.payload.modelId,
          });
          // The same pin the panel's picker sets. Without it a model chosen
          // from the phone lived only in the running process: the next restart
          // — or a window reload, which restores from the tab record — put the
          // session back on `ompcode.defaultModel`.
          this.pinModel(command.payload.provider, command.payload.modelId);
          await this.pushState();
        });
        return { changed: true };
      case "models.probe":
        await this.recheckModels();
        return toRemoteJson({ results: this.probeResults() });
      case "thinking.set":
        await this.request({ type: "set_thinking_level", level: command.payload.level });
        await this.pushState();
        return { changed: true };
      case "files.search": {
        const base = command.payload.query.split("/").pop()?.replace(/[*?[\]{}\\]/g, "") ?? "";
        if (!base) return { files: [] };
        const pattern = new vscode.RelativePattern(this.workspaceCwd(), `**/*${base}*`);
        const uris = await vscode.workspace.findFiles(
          pattern,
          "{**/node_modules/**,**/.git/**,**/dist/**}",
          command.payload.maxResults,
        );
        const files: Array<{ path: string; name: string; relative: string }> = [];
        for (const uri of uris) {
          try {
            const canonical = await requireCanonicalRemotePath(uri.fsPath, [this.workspaceCwd()]);
            files.push({
              path: canonical,
              name: path.basename(canonical),
              relative: path.relative(await fs.realpath(this.workspaceCwd()), canonical),
            });
          } catch {
            // A glob result through a symlink outside the grant is invisible remotely.
          }
        }
        return toRemoteJson({ files });
      }
      case "diff.get": {
        const snap = this.diffSnaps.get(command.payload.changeId);
        if (!snap?.afterHash) throw new Error("diff snapshot is unavailable");
        const canonicalPath = await requireCanonicalRemotePath(snap.path, [this.workspaceCwd()]);
        let current: string | null;
        try {
          current = await fs.readFile(canonicalPath, "utf8");
        } catch (error) {
          if (!isEnoent(error)) throw error;
          current = null;
        }
        return toRemoteJson({
          changeId: command.payload.changeId,
          path: canonicalPath,
          before: snap.before,
          current,
          afterSha256: snap.afterHash,
        });
      }
      case "revert.apply": {
        const snap = this.diffSnaps.get(command.payload.changeId);
        if (!snap?.afterHash || snap.afterHash !== command.payload.expectedAfterSha256) {
          throw new Error("diff snapshot hash does not match");
        }
        const canonicalPath = await requireCanonicalRemotePath(snap.path, [this.workspaceCwd()]);
        if (!(await this.revertEdit(command.payload.changeId, canonicalPath))) {
          throw new Error("revert is blocked by file drift or unsaved changes");
        }
        return { reverted: true };
      }
      case "editor.insert": {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.document.uri.scheme !== "file") throw new Error("no active file editor");
        await requireCanonicalRemotePath(editor.document.uri.fsPath, [this.workspaceCwd()]);
        const applied = await editor.edit((builder) => builder.insert(editor.selection.active, command.payload.text));
        if (!applied) throw new Error("editor rejected the insert");
        return { inserted: true };
      }
      case "transcript.export": {
        const data = await this.request({ type: "get_messages" });
        return { format: "markdown", content: formatTranscript(this.extractList(data, "messages")) };
      }
      case "session.rename":
        this.sessionTitle = command.payload.title;
        this.callbacks.onTitle?.(command.payload.title);
        OmpSession.notifyBoard();
        return { renamed: true };
      case "session.reset":
        await this.newSession();
        return { reset: true };
      case "session.compact":
        await this.request({ type: "compact" });
        return { compacted: true };
      case "session.restart":
        await this.restart();
        return { restarted: true };
      case "profile.update":
        await this.updateUserProfileField(
          command.payload.family,
          command.payload.field,
          command.payload.value,
          true,
        );
        return { changed: true };
      case "auth.login":
        await this.loginProvider(command.payload.providerId, false);
        return { authenticated: true };
      // These are host-global or service-owned and must never fall through to RPC.
      case "attachment.start":
      case "attachment.commit":
      case "attachment.cancel":
      case "sessions.list":
      case "session.create":
      case "session.switch":
      case "session.close":
      case "history.list":
      case "history.open":
      case "approval-mode.set":
      case "settings.update":
      case "credentials.set":
      case "credentials.clear":
      case "diagnostics.get":
      case "remote.stop":
        throw new Error(`remote command ${command.command} is host-service owned`);
    }
  }

  private handleRemoteApproval(
    requestId: string,
    response: ApprovalResponse,
  ): JsonValue {
    const pending = this.uiPendingFrames.get(requestId);
    if (!pending || !this.uiPendingIds.has(requestId)) throw new ApprovalNotPendingError();
    const method = pending.method;
    const frame: Record<string, unknown> = { type: "extension_ui_response", id: requestId };
    if (response.kind === "cancel") {
      frame.cancelled = true;
    } else if (method === "confirm" && response.kind === "confirm") {
      frame.confirmed = response.value;
    } else if (method === "select" && response.kind === "select") {
      const options = Array.isArray(pending.options)
        ? pending.options
        : Array.isArray(pending.items)
          ? pending.items
          : [];
      if (response.index < 0 || response.index >= options.length) {
        throw new Error("approval selection is outside the option list");
      }
      const selected = options[response.index];
      if (selected && typeof selected === "object") {
        const item = selected as Record<string, unknown>;
        frame.value = item.value ?? item.label ?? item.name ?? item.title ?? "";
      } else {
        frame.value = selected;
      }
    } else if (method === "input" && response.kind === "input") {
      frame.value = response.value;
    } else if (method === "editor" && response.kind === "editor") {
      frame.value = response.value;
    } else {
      throw new Error("approval response kind does not match the pending request");
    }
    return this.deliverApprovalResponse(frame, "remote");
  }

  private deliverApprovalResponse(
    frame: Record<string, unknown>,
    winner: "desktop" | "remote",
  ): JsonValue {
    const requestId = typeof frame.id === "string" ? frame.id : "";
    const proc = this.proc;
    if (!requestId || !proc?.running) throw new Error("omp agent is not running");
    if (!claimPendingApproval(requestId, this.uiPendingIds, this.uiPendingFrames)) {
      throw new ApprovalNotPendingError();
    }
    // Claim-before-send is synchronous and shared by local and remote paths;
    // exactly one responder can ever reach stdin.
    proc.send(frame);
    OmpSession.notifyBoard();
    const outcome = frame.cancelled === true ? "cancelled" : "answered";
    this.post({ t: "approvalResolved", requestId, outcome, winner });
    return { delivered: true, outcome };
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
  async loginProvider(providerId: string, reportFailure = true): Promise<void> {
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
      if (reportFailure) {
        this.reportError(`login ${providerId}`, err);
      } else {
        this.output.appendLine(`[omp] login "${providerId}" failed: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
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
  /**
   * Add each shipped provider block (CONFIG_PROVIDERS) whose key is stored.
   *
   * A `ompcode.customProviders` entry of the same name wins outright: that
   * file is the user's, and a shipped default has no business overruling it.
   */
  private async withShippedProviders(
    configured: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = { ...configured };
    for (const entry of CONFIG_PROVIDERS) {
      if (entry.name in out || !(await this.context.secrets.get(entry.secret))) {
        continue;
      }
      out[entry.name] = entry.def;
    }
    return out;
  }

  /**
   * Take back a shipped block once its key is cleared. Blocks the user has
   * since adopted under the same name in settings.json are left alone, as is
   * anything pointing somewhere other than the endpoint this extension writes.
   */
  private async pruneShippedProviders(configured: Record<string, unknown>): Promise<void> {
    for (const entry of CONFIG_PROVIDERS) {
      if (entry.name in configured || (await this.context.secrets.get(entry.secret))) {
        continue;
      }
      const baseUrl = entry.def.baseUrl;
      if (typeof baseUrl !== "string") {
        continue;
      }
      if (await pruneCustomProvider(entry.name, baseUrl)) {
        this.output.appendLine(`[omp] removed models.yml provider "${entry.name}" — key cleared`);
      }
    }
  }

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
   *
   * A session that pinned its own tier answers with that instead. Its target is
   * nominal: the pin lives in the workspace record, not in configuration, so
   * nothing is ever written back through it.
   */
  private approvalSetting(): { mode: ApprovalMode; target: vscode.ConfigurationTarget } {
    const pinned = this.overrides.approvalMode;
    if (pinned && (APPROVAL_MODES as readonly string[]).includes(pinned)) {
      return { mode: pinned, target: vscode.ConfigurationTarget.Global };
    }
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
  /**
   * Write one inspector-editable field into `ompcode.modelProfiles`.
   *
   * The edit lands in a user row for the family rather than being applied to
   * the live agent: a profile is a standing rule for every model of that
   * family, which is exactly what distinguishes it from the `think:` and
   * `access:` chips that only steer the current session.
   *
   * The config-change watcher restarts the sessions, so nothing is restarted
   * here. That restart is warm — the conversation is reattached — which is
   * what makes it acceptable for a runtime field like thinking.
   */
  private async updateUserProfileField(
    family: string,
    field: EditableProfileField,
    value: string | null,
    strict = false,
  ): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("ompcode");
    const inspected = cfg.inspect<unknown[]>("modelProfiles");
    // Write into whichever scope is actually in effect: a Workspace value
    // shadows Global, so writing Global there would look like a no-op.
    const inWorkspace = inspected?.workspaceValue !== undefined;
    const target = inWorkspace
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    const current = inWorkspace ? inspected?.workspaceValue : inspected?.globalValue;
    const rows = Array.isArray(current) ? current : [];

    const fallbackMatch =
      builtinMatchForFamily(family) ??
      (this.activeModel?.id ? exactMatchFor(this.activeModel.id) : undefined);
    if (!fallbackMatch) {
      // No built-in row to copy and no model to pin to: a row would have to
      // match everything, which would silently override every other family.
      this.output.appendLine(
        `[omp] cannot scope a profile row for "${family}" — edit ompcode.modelProfiles by hand`,
      );
      if (strict) throw new Error(`profile family "${family}" cannot be safely scoped`);
      return;
    }

    const next = applyProfileFieldEdit(rows, { family, field, value, fallbackMatch });
    await cfg.update("modelProfiles", next, target);
    this.output.appendLine(
      `[omp] profile "${family}": ${field} ${value === null ? "cleared" : `set to ${value}`}`,
    );
  }

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
    // Kept so an inspector edit on a family with no built-in row can still
    // scope its new row to something narrower than "every model".
    this.activeModel = matchable;
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
      const record = stats && typeof stats === "object" ? (stats as Record<string, unknown>) : undefined;
      const cost = record?.cost;
      const turns = record?.turns;
      if (typeof turns === "number") {
        this.turnsCompleted = turns; // the agent's own count wins when it reports one
      }
      if (typeof cost === "number") {
        this.lastCost = cost;
      }
      if (typeof cost === "number" || typeof turns === "number") {
        OmpSession.notifyBoard();
      }
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

  /**
   * Ask omp to report the subagents it spawns. Levels come from
   * `ompcode.subagentSubscription`: `progress` (status, cost, current tool) is
   * the default, `events` adds the child's raw event stream, `off` stays quiet.
   *
   * A failure here is a degradation, never a fatal: omp builds older than
   * 15.10.12 do not know the command, and the rest of the session works fine
   * without a subagent panel.
   */
  private async subscribeSubagents(proc: OmpProcess): Promise<void> {
    const level = vscode.workspace
      .getConfiguration("ompcode")
      .get<string>("subagentSubscription", "progress");
    if (level === "off") {
      return;
    }
    try {
      await proc.request({ type: "set_subagent_subscription", level });
    } catch (err) {
      this.output.appendLine(
        `[omp] subagent subscription unavailable (${level}): ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    // A restart reattaches to a conversation whose subagents were announced
    // before this process existed; the running ones come back only by asking.
    try {
      const running = await proc.request({ type: "get_subagents" });
      if (this.proc !== proc) {
        return;
      }
      const merged = reduceSubagentList(this.subagentState, running, Date.now());
      if (merged !== this.subagentState) {
        this.subagentState = merged;
        this.flushSubagents();
      }
    } catch (err) {
      this.output.appendLine(`[omp] get_subagents failed: ${String(err)}`);
    }
  }

  /**
   * Fold one subagent frame into state. Lifecycle changes are rare and worth
   * showing at once; progress frames arrive dozens of times a second per agent
   * and are coalesced, because `post()` also mirrors every message to a paired
   * Remote Control device.
   */
  private handleSubagentFrame(frame: OmpFrame): void {
    const next = reduceSubagentFrame(this.subagentState, frame, Date.now());
    if (!next) {
      return;
    }
    const changed = next !== this.subagentState;
    this.subagentState = next;
    if (frame.type === "subagent_lifecycle") {
      this.flushSubagents();
      OmpSession.notifyBoard();
      return;
    }
    if (changed) {
      this.noteSubagentProgress();
    }
  }

  /** Trailing-edge throttle: at most one snapshot per window, last state wins. */
  private noteSubagentProgress(): void {
    if (this.subagentFlushTimer) {
      this.subagentDirty = true;
      return;
    }
    this.flushSubagents();
    this.subagentFlushTimer = setTimeout(() => {
      this.subagentFlushTimer = undefined;
      if (this.subagentDirty) {
        this.subagentDirty = false;
        this.noteSubagentProgress();
      }
    }, SUBAGENT_FLUSH_MS);
  }

  /** Push the current roster to the webview and the board. */
  private flushSubagents(): void {
    this.post({ t: "subagents", snapshot: subagentSnapshot(this.subagentState) });
    OmpSession.notifyBoard();
  }

  /** Drop the roster and any pending flush — subagents never outlive a process. */
  private resetSubagents(): void {
    if (this.subagentFlushTimer) {
      clearTimeout(this.subagentFlushTimer);
      this.subagentFlushTimer = undefined;
    }
    this.subagentDirty = false;
    if (this.subagentState.size > 0) {
      this.subagentState = new Map();
      this.post({ t: "subagents", snapshot: { subagents: [], running: 0 } });
    }
  }

  /**
   * The subagent's own transcript, read from its JSONL by byte offset. omp
   * answers with `entries` (raw file records) and `messages` (parsed); the raw
   * records are what a reader wants when diagnosing a run, so they win when
   * both are present.
   */
  async subagentTranscript(id: string): Promise<string> {
    const info = this.subagentState.get(id);
    if (!info) {
      throw new Error(t("No transcript available for this subagent"));
    }
    const request: Record<string, unknown> = { type: "get_subagent_messages", fromByte: 0 };
    // omp accepts either selector; the id is the stable one, the session file
    // is the fallback for a record that arrived without one.
    if (info.id) {
      request.subagentId = info.id;
    } else if (info.sessionFile) {
      request.sessionFile = info.sessionFile;
    } else {
      throw new Error(t("No transcript available for this subagent"));
    }

    const response = await this.request(request as never);
    const data =
      response && typeof response === "object"
        ? ((response as Record<string, unknown>).data ?? response)
        : {};
    const entries = this.extractList(data, "entries");
    const lines = entries.length > 0 ? entries : this.extractList(data, "messages");
    if (lines.length === 0) {
      throw new Error(t("No transcript available for this subagent"));
    }
    return lines
      .map((line) => (typeof line === "string" ? line : JSON.stringify(line)))
      .join("\n");
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
    OmpSession.remoteMessageEmitter?.fire({ sessionId: this.sessionId, message: msg });
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
    // The tab id has to reach the renderer inside the markup rather than as a
    // message: `setState` must run before the user can reload the window, and
    // a posted message can be dropped while the webview is still loading.
    // Stamped on #app — <body> carries the palette and nothing else — so the
    // renderer can store it with `setState` the moment it loads. A message
    // would race the user reloading the window; the markup cannot.
    const tabId = this.overrides.tabId
      ? ` data-tab-id="${esc(this.overrides.tabId)}"`
      : "";
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
<div id="app"${tabId}>
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
        <button id="route-chip" class="chip hidden" title="${esc(t("Send the next prompt through a different model, once"))}" aria-label="${esc(t("Route next prompt"))}">${esc(t("route: …"))}</button>
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
