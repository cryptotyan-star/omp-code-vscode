import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { MAX_SNIPPET_CHARS, type Attachment } from "./attachments";
import { buildBoardSnapshot } from "./boardModel";
import { BoardViewProvider } from "./boardViewProvider";
import { ChatViewProvider } from "./chatViewProvider";
import {
  APPROVAL_MODES,
  OmpSession,
  type ApprovalMode,
  type DiffStore,
  type SessionInfo,
  type SessionOverrides,
} from "./ompSession";
import { KEYED_PROVIDERS } from "./providers";
import { REMOTE_PROTOCOL_VERSION } from "./remoteProtocol";
import { HostToolBridge, buildWorkspaceHostTools } from "./hostTools";
import { Orchestrator, type WorkspaceStatus } from "./orchestrator";
import { SessionBoardProvider, type BoardNode } from "./sessionBoard";
import { RemoteControlService, type RemoteGrant } from "./remoteControlService";
import { BaseContentProvider } from "./review/baseContentProvider";
import { registerReviewCommands } from "./review/commands";
import { ReviewProvider, type ReviewNode } from "./review/reviewProvider";
import { registerWorkspaceCommands } from "./workspaces/commands";
import { mainRepoRoot } from "./workspaces/git";
import { WorkspaceManager } from "./workspaces/manager";
import { PortScanner } from "./workspaces/ports";
import { WorkspaceRegistry } from "./workspaces/registry";
import { runSetup as runWorkspaceSetup } from "./workspaces/setupRun";
import { TerminalManager } from "./workspaces/terminals";
import type { WorkspaceRecord } from "./workspaces/types";
import { loadBundle, resolveLanguage, setBundle, t } from "./l10n.ts";
import {
  CHAT_TABS_KEY,
  claimChatTabRestore,
  dropChatTab,
  finishChatTabRestore,
  planRestore,
  pruneChatTabs,
  protectChatTabId,
  readChatTabs,
  unprotectChatTabId,
  upsertChatTab,
  type ChatTabPatch,
  type ChatTabRecord,
} from "./chatTabs.ts";

let activeRemoteControl: RemoteControlService | undefined;

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

/**
 * Row clicks pass an id; native tree context actions pass the row object, which
 * is a board node since the tree grew subagent children. A subagent row acts on
 * the session that owns it — abort/close/reveal have no per-subagent meaning —
 * and a workspace row acts on its live session, if it currently has one.
 */
function sessionCommandId(arg?: SessionInfo | BoardNode | string): string | undefined {
  if (typeof arg === "string") {
    return arg || undefined;
  }
  if (!arg) {
    return undefined;
  }
  if ("kind" in arg) {
    switch (arg.kind) {
      case "group":
        return undefined;
      case "workspace":
        return arg.info?.id || undefined;
      case "session":
        return arg.info.id || undefined;
      default:
        return arg.sessionId || undefined;
    }
  }
  return arg.id || undefined;
}

/**
 * Settings a workspace can pin for itself. A change to one of these must leave
 * the workspaces that overrode it alone: restarting their agent would swap the
 * model the operator deliberately chose for that branch.
 */
const OVERRIDABLE_SETTINGS = ["defaultModel", "approvalMode"] as const;

/**
 * Settings the omp process never reads — they shape the editor side only. A
 * change to one of these must not restart a live agent.
 */
const HOST_ONLY_SETTINGS = [
  "theme",
  "accentColor",
  "worktreeBaseDir",
  "workspaceBranchPrefix",
  "workspaceSetup",
  // Port scanning shapes the board's ⇡ badges and nothing else; the agent
  // process never hears about either setting.
  "portScan",
  "portScanIgnore",
  // Whether the review tree recounts on its own. It changes how often the
  // *editor* asks git a question; the agent never hears about it, and killing
  // a running turn over it would be pure loss.
  "reviewAutoRefresh",
  // The workspace ceiling is read by the orchestration facade alone, per
  // `create`. Raising it is the natural reaction to a create that just
  // refused, so restarting every agent over it would kill the turns of the
  // very workers the user is making room beside. `orchestratorTools` is
  // deliberately NOT here: it is announced to the agent at handshake, so it
  // does need the restart.
  "orchestratorMaxWorkspaces",
  // Cost ceilings are read by the orchestration facade on each create/prompt
  // tick; changing a limit must not restart agents mid-turn.
  "costLimitPerWorkspaceUsd",
  "costLimitPerSessionUsd",
] as const;

/**
 * Every `ompcode.*` setting this build declares, read from its own manifest.
 * `ConfigurationChangeEvent` can only answer "did this key change?", so telling
 * "only the model changed" from "the model and the binary path changed" needs
 * the key list up front.
 */
function declaredSettingKeys(context: vscode.ExtensionContext): string[] {
  const manifest = context.extension.packageJSON as {
    contributes?: { configuration?: unknown };
  };
  const configuration = manifest.contributes?.configuration;
  const blocks = Array.isArray(configuration) ? configuration : [configuration];
  const keys = new Set<string>();
  for (const block of blocks) {
    const properties = (block as { properties?: Record<string, unknown> } | undefined)?.properties;
    for (const key of Object.keys(properties ?? {})) {
      if (key.startsWith("ompcode.")) {
        keys.add(key.slice("ompcode.".length));
      }
    }
  }
  return [...keys];
}

/**
 * Pick the interface language and install its bundle. Runs before anything
 * renders, and again whenever `ompcode.language` changes.
 */
function applyLanguage(context: vscode.ExtensionContext, output: vscode.OutputChannel): void {
  const setting = vscode.workspace.getConfiguration("ompcode").get<string>("language", "auto");
  const language = resolveLanguage(setting, vscode.env.language);
  setBundle(language, loadBundle(context.extensionPath, language));
  output.appendLine(`[omp] interface language: ${language} (setting "${setting}")`);
}

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel("OMP Code");
  applyLanguage(context, output);
  output.appendLine("[omp] extension activated");

  /** Chat panels currently open in the editor area, oldest first. */
  const chatPanels = new Map<vscode.WebviewPanel, OmpSession>();
  /**
   * Which workspace a chat tab belongs to. Kept here rather than read back off
   * the session snapshot so that closing a workspace works even while its agent
   * is still starting and has published no state.
   */
  const panelWorkspaces = new Map<vscode.WebviewPanel, string>();

  /**
   * What every chat tab needs to come back after "Developer: Reload Window";
   * see src/chatTabs.ts for why the payload lives here and only an id lives in
   * the webview. `workspaceState`, not `globalState`: a tab's folder, worktree
   * and conversation all belong to the folder that is open.
   *
   * Nothing is deleted when a panel is disposed. A window reload disposes every
   * panel on its way down, and a store that reacted to that would erase itself
   * moments before the restore that needs it; stale entries are bounded by
   * MAX_CHAT_TABS instead, and are only ever read by a panel VS Code itself
   * chose to persist.
   */
  let chatTabs: ChatTabRecord[] = readChatTabs(context.workspaceState.get(CHAT_TABS_KEY, []));

  function persistChatTabs(next: ChatTabRecord[]): void {
    chatTabs = next;
    void context.workspaceState.update(CHAT_TABS_KEY, next).then(undefined, (error: unknown) => {
      output.appendLine(`[omp] could not remember the open chat tabs: ${String(error)}`);
    });
  }

  /**
   * The tab id of every panel currently open, so the bounded store evicts the
   * closed tabs rather than the one the user is looking at. Filled by
   * `bindChatPanel`, emptied by the panel's own dispose handler — it never
   * touches the persisted records, which have to outlive a window reload.
   */
  const panelTabIds = new Map<vscode.WebviewPanel, string>();

  function rememberChatTab(patch: ChatTabPatch): void {
    persistChatTabs(upsertChatTab(chatTabs, patch, Date.now(), new Set(panelTabIds.values())));
  }

  /**
   * Say once that chat tabs of a deleted workspace are gone.
   *
   * Both paths reach it — the serializer refusing to restore a tab, and the
   * prune closing one that was already open — and a workspace that had three
   * chats open would otherwise stack three identical toasts. They would not
   * even coalesce visually: VS Code deserializes each persisted editor only as
   * it is first revealed, so they arrive minutes apart. Reset per registry
   * change, so the *next* deletion is announced again.
   */
  let deadWorkspaceNoticeShown = false;
  function noteDeadWorkspaceTabs(message: string): void {
    if (deadWorkspaceNoticeShown) {
      return;
    }
    deadWorkspaceNoticeShown = true;
    void vscode.window.showInformationMessage(message);
  }

  // Status bar: model + context fill of whichever session reported last.
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "ompcode.openChat";
  statusBar.text = "$(sparkle) OMP Code";
  statusBar.tooltip = t("OMP Code — open chat");
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
    // Context fill is deliberately absent: a percentage that reads 2% for most
    // of a session is noise wherever it is shown. The chat warns once the
    // window actually starts to fill (see noteContextFill in media/main.mjs).
    statusBar.text = name ? `$(sparkle) ${name}` : "$(sparkle) OMP Code";
    statusBar.tooltip = t("OMP Code — open chat");
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

  /** The webview options every chat panel runs with, new or restored. */
  function chatWebviewOptions(): vscode.WebviewOptions {
    return {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "media")],
    };
  }

  /**
   * Give a chat panel its session and its place in the maps.
   *
   * Shared by the two ways a panel comes into existence — the user opening one,
   * and VS Code handing a persisted one back after a window reload — so a
   * restored tab has exactly the lifecycle of a fresh one and no second copy of
   * it can drift.
   */
  function bindChatPanel(
    panel: vscode.WebviewPanel,
    tabId: string,
    cwd: string | undefined,
    overrides: SessionOverrides | undefined,
  ): OmpSession {
    // The id is protected from eviction as soon as the panel has any surface
    // in the editor. During restore this is already true from
    // `claimChatTabRestore`; for a fresh tab it keeps the brand-new record
    // alive while the panel is open.
    protectChatTabId(tabId);
    // Which branch a tab is editing decides whether its edits are safe, so the
    // branch owns the front of the title and the agent's own `setTitle` is
    // composed after it rather than allowed to replace it.
    const branchPrefix = overrides?.branch ? `⎇ ${overrides.branch}` : "";
    // Only when it is not already there. VS Code persists a tab's last title
    // across a reload, so a restored workspace chat arrives reading
    // "⎇ omp/fix-parser · Fix the JSON parser"; stamping the bare prefix over
    // it would throw the agent's own title away until it happens to send
    // another — which, for a resumed conversation, it may never do.
    if (branchPrefix && !panel.title.startsWith(branchPrefix)) {
      panel.title = branchPrefix;
    }
    panel.iconPath = vscode.Uri.joinPath(context.extensionUri, "media", "icon.svg");
    // Everything the restore path will need, written before the agent starts:
    // a window that reloads mid-handshake still finds the tab's folder and
    // workspace. The conversation and the model pin arrive later, through the
    // callbacks below.
    rememberChatTab({
      tabId,
      cwd,
      workspaceId: overrides?.workspaceId,
      model: overrides?.model,
      sessionFile: overrides?.sessionFile,
    });
    const tracked: SessionOverrides = {
      ...overrides,
      // Echoed into the webview markup, which stores it with `setState`; that
      // id is the only thing a reload hands back to the serializer.
      tabId,
      // A workspace records these on its own record too — hence the chaining
      // rather than a replacement. A plain chat had nowhere to keep them at
      // all, which is why it used to come back blank and on the default model.
      onSessionFile: (file) => {
        rememberChatTab({ tabId, sessionFile: file });
        overrides?.onSessionFile?.(file);
      },
      onModel: (model) => {
        rememberChatTab({ tabId, model });
        overrides?.onModel?.(model);
      },
    };
    const session = new OmpSession(context, output, {
      onOpenNewTab: () => {
        void openChatTab();
      },
      onTitle: (title) => {
        panel.title = branchPrefix ? `${branchPrefix} · ${title}` : title;
      },
      onState: onSessionState,
      onReveal: () => {
        panel.reveal(panel.viewColumn ?? vscode.ViewColumn.Beside);
      },
      onClose: () => panel.dispose(),
    }, diffStore, cwd, tracked);
    chatPanels.set(panel, session);
    panelTabIds.set(panel, tabId);
    if (overrides?.workspaceId) {
      panelWorkspaces.set(panel, overrides.workspaceId);
    }
    // Which chats orchestrate is the session's own judgement — every one except
    // a workspace's agent, which must not create workspaces of its own: nothing
    // in the tree stops that recursion. Before `attach`, because attaching
    // starts the agent, and announcing the tools is part of its handshake.
    if (session.orchestrates) {
      attachHostTools(session);
    }
    panel.onDidDispose(() => {
      chatPanels.delete(panel);
      panelWorkspaces.delete(panel);
      // In-memory only, and deliberately so: this drops the tab out of the
      // eviction shield, it does not touch the persisted record — a window
      // reload disposes every panel on its way down, and a store that reacted
      // to that would erase itself moments before the restore reads it.
      panelTabIds.delete(panel);
      unprotectChatTabId(tabId);
      session.dispose();
    });
    session.attach(panel.webview);
    return session;
  }

  /** Open a fresh chat session as its own editor-area tab, to the right. */
  async function openChatTab(
    forcedCwd?: string,
    overrides?: SessionOverrides,
  ): Promise<vscode.WebviewPanel | undefined> {
    // Multi-root: each chat's agent runs in one folder — ask which.
    const folders = vscode.workspace.workspaceFolders ?? [];
    let cwd: string | undefined = forcedCwd;
    if (!cwd && folders.length > 1) {
      const picked = await vscode.window.showWorkspaceFolderPick({
        placeHolder: t("Which folder should this chat's agent work in?"),
      });
      if (!picked) {
        return undefined; // cancelled — no tab without a folder
      }
      cwd = picked.uri.fsPath;
    }
    const panel = vscode.window.createWebviewPanel(
      "ompcode.chatTab",
      overrides?.branch ? `⎇ ${overrides.branch}` : "OMP Code",
      chatColumn(),
      { ...chatWebviewOptions(), retainContextWhenHidden: true },
    );
    bindChatPanel(panel, randomUUID(), cwd, overrides);
    return panel;
  }

  /**
   * Bring back a chat tab VS Code persisted across a window reload.
   *
   * Without a serializer registered for this viewType VS Code drops the panel
   * on the floor, which is how every open chat used to disappear on "Developer:
   * Reload Window". The plan comes from the pure module so the interesting
   * decisions — is this tab known, is its workspace still alive — are testable
   * outside the extension host.
   */
  /** The panel already bound to `tabId`, if there is one. */
  function panelForTab(tabId: string): vscode.WebviewPanel | undefined {
    for (const [panel, id] of panelTabIds) {
      if (id === tabId) {
        return panel;
      }
    }
    return undefined;
  }

  /** The live chat panel of a workspace, if one is open. */
  function panelForWorkspace(workspaceId: string): vscode.WebviewPanel | undefined {
    for (const [panel, id] of panelWorkspaces) {
      if (id === workspaceId && chatPanels.has(panel)) {
        return panel;
      }
    }
    return undefined;
  }

  /**
   * Hand a duplicate panel over to the one already running, and close it.
   *
   * VS Code resolves a persisted webview editor lazily: a chat tab sitting in a
   * background group after a reload is an editor that exists but has not been
   * deserialized, so it is in none of the maps here. Clicking that workspace's
   * board row in the meantime opens a *second* tab, and revealing this shell
   * later would put a second omp process in the same worktree — the very thing
   * `openChat` refuses to do, fighting the first over the same files. The live
   * agent wins; this panel was never bound and has nothing to lose.
   */
  function yieldToLivePanel(live: vscode.WebviewPanel, panel: vscode.WebviewPanel): void {
    live.reveal(live.viewColumn ?? vscode.ViewColumn.Beside);
    panel.dispose();
  }

  /**
   * Reopen a panel nothing identifies as a fresh chat.
   *
   * Async because of the folder pick: `openChatTab` asks which folder a chat's
   * agent works in whenever the window has more than one, and a restore that
   * skipped the question would drop the agent into the first folder — possibly
   * a different repository from the one the tab was in.
   */
  async function restoreBlankTab(panel: vscode.WebviewPanel): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    let cwd: string | undefined;
    if (folders.length > 1) {
      const picked = await vscode.window.showWorkspaceFolderPick({
        placeHolder: t("Which folder should this chat's agent work in?"),
      });
      if (!picked) {
        panel.dispose(); // cancelled — no agent without a folder
        return;
      }
      cwd = picked.uri.fsPath;
    }
    bindChatPanel(panel, randomUUID(), cwd, undefined);
  }

  function restoreChatTab(panel: vscode.WebviewPanel, state: unknown): void {
    panel.webview.options = chatWebviewOptions();
    const plan = planRestore(
      chatTabs,
      state,
      workspaces.list().map((record) => record.id),
    );
    switch (plan.kind) {
      case "workspace": {
        const record = workspaces.get(plan.workspaceId);
        if (!record) {
          // Raced with a removal between the plan and here.
          persistChatTabs(dropChatTab(chatTabs, plan.record.tabId));
          panel.dispose();
          return;
        }
        const sameTab = panelForTab(plan.record.tabId);
        if (sameTab) {
          // Already bound: this id has a running agent, and its record belongs
          // to it — reveal it and drop the duplicate shell, record intact.
          yieldToLivePanel(sameTab, panel);
          return;
        }
        const sameWorkspace = panelForWorkspace(plan.workspaceId);
        if (sameWorkspace) {
          // The board reopened this workspace's chat while this editor was
          // still an unresolved tab. That agent owns the worktree now, so this
          // record is stale and goes with the panel.
          persistChatTabs(dropChatTab(chatTabs, plan.record.tabId));
          yieldToLivePanel(sameWorkspace, panel);
          return;
        }
        // The record is the truth, not the tab entry: model, approval tier,
        // branch and conversation all live on it and may have moved while this
        // window was down. Restoring from it is what puts the tab back on its
        // board row in the state it had.
        if (!claimChatTabRestore(plan.record.tabId)) {
          // Another restore or an already-bound panel owns this id now.
          panel.dispose();
          return;
        }
        let bound = false;
        try {
          bindChatPanel(panel, plan.record.tabId, record.worktreePath, workspaceOverrides(record));
          bound = true;
        } finally {
          finishChatTabRestore(plan.record.tabId);
          if (!bound) {
            unprotectChatTabId(plan.record.tabId);
          }
        }
        return;
      }
      case "plain": {
        const sameTab = panelForTab(plan.record.tabId);
        if (sameTab) {
          // One id, one agent: two panels resuming the same conversation would
          // both write that JSONL.
          yieldToLivePanel(sameTab, panel);
          return;
        }
        if (!claimChatTabRestore(plan.record.tabId)) {
          // Another restore or an already-bound panel owns this id now.
          panel.dispose();
          return;
        }
        let bound = false;
        try {
          bindChatPanel(panel, plan.record.tabId, plan.record.cwd, {
            // Only what the tab actually pinned. A tab that never picked a model
            // has no `model` here and goes on following `ompcode.defaultModel`,
            // exactly as it did before the reload.
            ...(plan.record.model ? { model: plan.record.model } : {}),
            ...(plan.record.sessionFile ? { sessionFile: plan.record.sessionFile } : {}),
          });
          bound = true;
        } finally {
          finishChatTabRestore(plan.record.tabId);
          if (!bound) {
            unprotectChatTabId(plan.record.tabId);
          }
        }
        return;
      }
      case "close":
        // Its worktree is gone. Reopening the tab would start an agent in a
        // directory that no longer exists and show a board row with nothing
        // behind it, so the panel goes and the record with it.
        persistChatTabs(dropChatTab(chatTabs, plan.record.tabId));
        output.appendLine(
          `[omp] chat tab ${plan.record.tabId} belonged to a deleted workspace — not restored`,
        );
        noteDeadWorkspaceTabs(
          t("A chat tab was not restored: the workspace it belonged to no longer exists."),
        );
        panel.dispose();
        return;
      case "blank":
        // Persisted by a build that kept no record, or evicted since. The tab
        // survives as an empty chat: honest, unlike a conversation restored
        // into the wrong folder.
        output.appendLine(`[omp] restoring a chat tab with no record (${plan.reason})`);
        void restoreBlankTab(panel);
        return;
      default: {
        // `RestorePlan` is closed on purpose: a new outcome has to be handled
        // here rather than quietly falling into the blank path.
        const never: never = plan;
        throw new Error(`unhandled restore plan ${JSON.stringify(never)}`);
      }
    }
  }

  /**
   * Deliver a workspace's starting prompt into its freshly opened chat.
   *
   * `handleRemoteCommand` is the session's only public entry point for text the
   * user did not type into that composer; the agent echoes the message back, so
   * the bubble appears in the transcript exactly as a typed one would.
   */
  async function deliverPrompt(session: OmpSession, text: string): Promise<void> {
    await session.handleRemoteCommand({
      protocolVersion: REMOTE_PROTOCOL_VERSION,
      type: "command",
      commandId: randomUUID(),
      commandCounter: "0",
      hostGeneration: "local",
      sessionId: session.remoteSessionId,
      command: "prompt.send",
      payload: { text, attachmentIds: [] },
    });
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

  /**
   * The pins and the write-backs a workspace chat runs with.
   *
   * A function rather than an object literal inside `openChat`, because a tab
   * restored after a window reload has to be wired to its workspace record in
   * exactly the same way — otherwise the model, the branch and the approval
   * tier would come back as a plain chat's defaults.
   */
  function workspaceOverrides(record: WorkspaceRecord): SessionOverrides {
    return {
      model: record.model,
      approvalMode: record.approvalMode,
      workspaceId: record.id,
      branch: record.branch,
      sessionFile: record.sessionFile,
      // The agent picks its own JSONL name; remembering it is what lets the
      // workspace resume the same conversation after VS Code restarts.
      onSessionFile: (file) => {
        void workspaces.rememberSessionFile(record.id, file).catch((error: unknown) => {
          output.appendLine(`[workspaces] could not record the session file: ${String(error)}`);
        });
      },
      // The pins move with the user: switching model or approval tier from the
      // chat has to outlive the process, or the record would put the agent
      // back on the old one at the next restart.
      onModel: (model) => {
        void workspaces.rememberModel(record.id, model).catch((error: unknown) => {
          output.appendLine(`[workspaces] could not record the model: ${String(error)}`);
        });
      },
      onApprovalMode: (mode) => {
        void workspaces.rememberApprovalMode(record.id, mode).catch((error: unknown) => {
          output.appendLine(`[workspaces] could not record the approval tier: ${String(error)}`);
        });
      },
    };
  }

  const provider = new ChatViewProvider(context, output, () => {
    openChatTab();
  }, onSessionState, diffStore);

  /**
   * Workspaces = one git worktree, one branch, one agent. The registry lives in
   * workspaceState because a worktree belongs to the folder that is open, not
   * to the machine.
   */
  const workspaceRegistry = new WorkspaceRegistry(context.workspaceState);
  const workspaces: WorkspaceManager = new WorkspaceManager({
    registry: workspaceRegistry,
    output,
    settings: () => {
      const cfg = vscode.workspace.getConfiguration("ompcode");
      const setupPolicy = cfg.get<string>("workspaceSetup", "ask");
      const approvalMode = cfg.get<string>("approvalMode", "always-ask");
      return {
        worktreeBaseDir: cfg.get<string>("worktreeBaseDir", ""),
        branchPrefix: cfg.get<string>("workspaceBranchPrefix", "omp/"),
        setupPolicy:
          setupPolicy === "auto" || setupPolicy === "never" ? setupPolicy : "ask",
        defaultModel: cfg.get<string>("defaultModel", ""),
        approvalMode: (APPROVAL_MODES as readonly string[]).includes(approvalMode)
          ? (approvalMode as ApprovalMode)
          : "always-ask",
      };
    },
    // The terminal-driven setup runner; the manager stays free of `vscode`.
    runSetup: runWorkspaceSetup,
    openChat: async (record: WorkspaceRecord, prompt?: string) => {
      /** Fire-and-forget: the agent is still starting, and promptOnce waits. */
      const send = (session: OmpSession, text: string | undefined): void => {
        const trimmed = text?.trim();
        if (!trimmed) {
          return;
        }
        // Marked busy *before* the send is dispatched, synchronously, so the
        // session never snapshots as idle in the gap between `create`
        // returning and the prompt reaching the agent. An orchestrator that
        // waits on a workspace it just created reads that gap otherwise, and
        // "idle" there means "this worker is done" — with nothing on disk.
        const release = session.markTurnPending();
        void deliverPrompt(session, trimmed)
          .catch((error: unknown) => {
            output.appendLine(`[workspaces] starting prompt failed: ${String(error)}`);
            void vscode.window.showErrorMessage(
              t("The workspace opened, but its first prompt could not be sent: {0}", String(error)),
            );
          })
          .finally(release);
      };
      // Clicking a running workspace row also lands here. A second omp process
      // in the same worktree would fight the first over the same files, so an
      // open tab is revealed rather than duplicated.
      for (const [tab, id] of panelWorkspaces) {
        const running = id === record.id ? chatPanels.get(tab) : undefined;
        if (running) {
          tab.reveal(tab.viewColumn ?? vscode.ViewColumn.Beside);
          send(running, prompt);
          return { sessionId: running.remoteSessionId };
        }
      }
      const panel = await openChatTab(record.worktreePath, workspaceOverrides(record));
      const session = panel ? chatPanels.get(panel) : undefined;
      if (!session) {
        return undefined;
      }
      send(session, prompt);
      return { sessionId: session.remoteSessionId };
    },
    closeChat: async (record: WorkspaceRecord) => {
      for (const [panel, id] of [...panelWorkspaces]) {
        if (id !== record.id) {
          continue;
        }
        const session = chatPanels.get(panel);
        // `panel.dispose()` alone is not enough: OmpSession.dispose() keeps the
        // child alive while a Remote Control device holds a lease, and the
        // worktree is about to be deleted under it. forceDispose drops the
        // lease, and the await is what makes "closed" mean the process has
        // really released the directory.
        await session?.disposeAndWait();
        panel.dispose();
      }
    },
    confirm: async (message: string, detail: string, ok: string) =>
      (await vscode.window.showWarningMessage(message, { modal: true, detail }, ok)) === ok,
  });

  /**
   * The live chat of a workspace, when it has one open.
   *
   * The tab map answers first: it is filled the moment the panel is created,
   * while the agent is still starting and has published no state at all. The
   * scan behind it catches a workspace chat opened by something other than
   * `openChatTab`, so the orchestrator never mistakes "opened elsewhere" for
   * "not running".
   */
  function liveWorkspaceSession(workspaceId: string): OmpSession | undefined {

    for (const [panel, id] of panelWorkspaces) {
      if (id !== workspaceId) {
        continue;
      }
      const session = chatPanels.get(panel);
      if (session) {
        return session;
      }
    }
    return OmpSession.allSessions().find(
      (session) => session.snapshot().workspaceId === workspaceId,
    );
  }

  /**
   * The sidebar chat — the session the ChatViewProvider drives, and the
   * board's orchestrator row. `closable: false` singles it out among
   * orchestrating sessions: plain chat tabs in the main checkout orchestrate
   * too, but only the sidebar's surface cannot be closed.
   */
  function mainChatSession(): OmpSession | undefined {
    return OmpSession.allSessions().find(
      (session) => session.orchestrates && !session.snapshot().closable,
    );
  }

  /**
   * What the *model* drives, as opposed to what the operator clicks: one facade
   * over the same workspace manager the board and the review tree read, so an
   * agent-created workspace is an ordinary row the moment it exists.
   *
   * It holds no `vscode` surface of its own — everything the editor has to
   * provide arrives through these four callbacks — which is what lets the same
   * object back an MCP server later, with no extension host at all.
   */
  const orchestrator = new Orchestrator({
    manager: workspaces,
    // Only a live chat can be prompted, or asked what its agent last said. A
    // workspace whose tab was closed still exists on disk: the orchestrator
    // reports it out of the registry and simply cannot talk to it.
    sessionFor: (workspaceId: string) => liveWorkspaceSession(workspaceId),
    repoRoot: resolveRepoRoot,
    output,
    // `wait` is event-driven, never a poll loop: this is the one signal that
    // fires when an agent moves between working / asking / idle. Handed in
    // rather than imported so the orchestrator module stays free of `vscode`
    // and its tests can drive the wait loop by hand.
    onBoardChange: (listener: () => void) => OmpSession.onBoardChange(listener),
    // Re-read per `create`, not captured once: raising the ceiling in settings
    // is the natural reaction to a create that just refused, and it should
    // take effect without reloading the window.
    maxWorkspaces: () =>
      vscode.workspace
        .getConfiguration("ompcode")
        .get<number>("orchestratorMaxWorkspaces", 5),
    // Same liveness for the cost ceilings: raising a limit is the natural
    // reaction to a budget stop, and it must take effect on the next tick.
    costLimits: () => {
      const cfg = vscode.workspace.getConfiguration("ompcode");
      return {
        perWorkspaceUsd: cfg.get<number>("costLimitPerWorkspaceUsd", 0),
        perSessionUsd: cfg.get<number>("costLimitPerSessionUsd", 0),
      };
    },
    // The orchestrator's own spend is the sidebar chat's; zero when it is gone.
    sessionCostUsd: () => mainChatSession()?.snapshot().cost ?? 0,
    // An over-budget workspace stops mid-turn through the same signal as a
    // manual stop; one with no live chat has nothing to abort.
    abortTurn: (workspaceId) => liveWorkspaceSession(workspaceId)?.abortTurn(),
    // The user's setup policy, so a model asking for `runSetup: true` cannot
    // turn an operator's "never" into a licence to run the repository's setup
    // commands. The manager checks the explicit flag before the policy — which
    // is right when a human just clicked it, and wrong when a model asked.
    setupPolicy: () => {
      const value = vscode.workspace
        .getConfiguration("ompcode")
        .get<string>("workspaceSetup", "ask");
      return value === "auto" || value === "never" ? value : "ask";
    },
  });

  /** Sessions already bridged — a second bridge would answer every call twice. */
  const bridgedSessions = new WeakSet<OmpSession>();

  /**
   * Give one chat the workspace tools.
   *
   * The bridge is built here rather than inside `OmpSession` because it needs
   * the Orchestrator, which needs the WorkspaceManager, which opens chats
   * through this file: an import from the session would close that loop into a
   * cycle. The session receives a finished bridge plus the definitions to
   * announce, and lends it the transport that writes to its own process — so
   * nothing else ever holds a second handle on that stdin, and a bridge built
   * for a dead session can only write into the void.
   *
   * The definitions are passed explicitly: the bridge carries the behaviour,
   * the definitions carry what omp is told about it, and a session with a
   * bridge but no definitions would register nothing at all.
   */
  function attachHostTools(session: OmpSession): void {
    if (bridgedSessions.has(session)) {
      return;
    }
    bridgedSessions.add(session);
    // Handlers are rebuilt per session so each one closes over its own
    // transport; they share the single orchestrator, which is what makes a
    // workspace created from one chat visible in every other.
    const bridge = new HostToolBridge(buildWorkspaceHostTools(orchestrator), {
      send: (frame) => session.sendHostToolFrame(frame),
      output,
    });
    // Attached even with `ompcode.orchestratorTools` off. The session is what
    // reads that setting, at handshake time, so giving it the bridge up front
    // is what makes switching the setting on take effect on the next agent
    // start rather than needing a brand new tab.
    session.setHostToolBridge(bridge, bridge.definitions());
  }

  // The sidebar chat is built by its provider, before this file has an
  // orchestrator to give it, and the provider keeps its session private — so it
  // is picked up here off the live session list instead. Nothing else can be in
  // that list this early, and asking each session whether it orchestrates keeps
  // that true if anything ever is.
  OmpSession.forEachActive((session) => {
    if (session.orchestrates) {
      attachHostTools(session);
    }
  });

  /**
   * The repository a new workspace branches from: the open folder, or the one
   * the user picks in a multi-root window, resolved to its main checkout so a
   * window already opened *on* a worktree still creates siblings, not nests.
   */
  async function resolveRepoRoot(): Promise<string | undefined> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    let folder: vscode.WorkspaceFolder | undefined = folders[0];
    if (folders.length > 1) {
      folder = await vscode.window.showWorkspaceFolderPick({
        placeHolder: t("Which repository should the workspace branch from?"),
      });
    }
    if (!folder) {
      return undefined;
    }
    try {
      // The *main* checkout, not `rev-parse --show-toplevel`: inside a linked
      // worktree that would name the worktree itself, and new workspaces would
      // nest inside it instead of landing beside the repository.
      return await mainRepoRoot(folder.uri.fsPath);
    } catch (error) {
      output.appendLine(`[workspaces] ${folder.uri.fsPath} is not a git repository: ${String(error)}`);
      void vscode.window.showErrorMessage(
        t("Workspaces need a git repository — {0} is not one.", folder.uri.fsPath),
      );
      return undefined;
    }
  }

  /**
   * The other half of running three agents at once. The board answers "is it
   * still working?"; the review tree answers "what did it actually write?" and
   * carries the merge that ends the race.
   *
   * It reads the manager and never the reverse: two views over one registry,
   * and neither may become the other's dependency.
   */
  const review = new ReviewProvider(workspaces);
  const reviewView = vscode.window.createTreeView(ReviewProvider.viewType, {
    treeDataProvider: review,
  });

  // Terminals are opened per workspace and remembered, so the port scanner can
  // walk each workspace's process tree down from its shells' pids.
  const terminals = new TerminalManager({ output });
  const portScanner = new PortScanner({
    workspaceIds: () => workspaces.list().map((record) => record.id),
    rootPids: (id) => terminals.rootPids(id),
    ignorePorts: () =>
      vscode.workspace.getConfiguration("ompcode").get<number[]>("portScanIgnore", [22, 80, 443]),
    output,
  });
  const portScanEnabled = (): boolean =>
    vscode.workspace.getConfiguration("ompcode").get<boolean>("portScan", true);
  if (portScanEnabled()) {
    portScanner.start();
  }
  // A terminal opening or closing changes the process trees under scan, and
  // the scanner may be idling at its slow cadence — restart it at the fast
  // one so a fresh `npm run dev` shows its port within seconds, not thirty.
  const terminalsChanged = terminals.onDidChange(() => {
    if (portScanEnabled()) {
      portScanner.start();
    }
  });
  // The board shows `+N −M` per workspace out of the review layer's cache. It
  // asks rather than being pushed to, and it never counts anything itself: a
  // `getTreeItem` that shelled out to git would spawn one process per row on
  // every repaint.
  const board = new SessionBoardProvider(
    workspaces,
    (id) => review.stats(id),
    (id) => portScanner.portsFor(id),
  );
  const boardView = vscode.window.createTreeView(SessionBoardProvider.viewType, {
    treeDataProvider: board,
  });

  /**
   * The process board: same registry as the Sessions tree, drawn as a webview
   * panel. The orchestrator's `list()` is async while the provider's snapshot
   * is synchronous, so a cache sits between them: change events and a slow
   * poll refill the cache, then the provider pushes (throttled, trailing edge).
   */
  let boardStatuses: WorkspaceStatus[] = [];
  const boardPanel = new BoardViewProvider(context, {
    snapshot: () => {
      const cfg = vscode.workspace.getConfiguration("ompcode");
      // The orchestrator row is the sidebar chat: its lifecycle status is
      // already exactly the union BoardInput expects, and its clock shows the
      // running turn (turnStartedAt is undefined between turns — no clock then).
      const main = mainChatSession()?.snapshot();
      return buildBoardSnapshot({
        orchestrator: main
          ? {
              id: main.id,
              model: main.model,
              costUsd: main.cost,
              state: main.status,
              ...(main.turnStartedAt ? { startedAt: main.turnStartedAt } : {}),
            }
          : undefined,
        workspaces: boardStatuses,
        limits: {
          perWorkspaceUsd: cfg.get<number>("costLimitPerWorkspaceUsd", 0),
          perSessionUsd: cfg.get<number>("costLimitPerSessionUsd", 0),
        },
        now: Date.now(),
      });
    },
    onChange: (listener) => {
      const bump = (): void => void refreshBoardStatuses().then(listener, listener);
      const subs = [workspaces.onDidChange(bump), OmpSession.onBoardChange(bump)];
      return new vscode.Disposable(() => {
        for (const sub of subs) {
          sub.dispose();
        }
      });
    },
    // Row actions reuse the existing commands: the workspace registry decides
    // whether an id is a workspace (reveal/delete) or its live session (stop).
    reveal: (id) => {
      if (workspaces.get(id)) {
        void vscode.commands.executeCommand("ompcode.workspace.reveal", id);
      } else {
        void vscode.commands.executeCommand("ompcode.sessionReveal", id);
      }
    },
    stop: (id) => {
      const session = liveWorkspaceSession(id);
      if (session) {
        void vscode.commands.executeCommand("ompcode.sessionAbort", session.snapshot().id);
      }
    },
    remove: (id) => {
      if (workspaces.get(id)) {
        void vscode.commands.executeCommand("ompcode.workspace.delete", id);
      }
    },
  });
  const refreshBoardStatuses = (): Promise<void> =>
    orchestrator.list().then(
      (rows) => {
        boardStatuses = rows;
      },
      (error: unknown) => {
        output.appendLine(`[board] could not list workspaces: ${String(error)}`);
      },
    );
  void refreshBoardStatuses();
  // Costs tick upward without a registry or board event, so while the view is
  // visible a slow poll keeps the numbers honest; hidden, the poll is skipped.
  const pollTimer = setInterval(() => {
    if (boardPanel.active) {
      void refreshBoardStatuses().then(() => boardPanel.refresh());
    }
  }, 2000);
  const boardPoll = new vscode.Disposable(() => clearInterval(pollTimer));

  // A workspace that is deleted takes its worktree with it, so the tab records
  // pointing at it can never be restored. Dropping them when the registry moves
  // — including the startup reconcile against `git worktree list` — keeps the
  // bounded store from filling with entries the serializer would only refuse.
  const workspacesChanged = workspaces.onDidChange(() => {
    // A new deletion deserves its own notice, whatever an earlier one showed.
    deadWorkspaceNoticeShown = false;
    const live = workspaces.list().map((record) => record.id);
    const { kept, dropped } = pruneChatTabs(chatTabs, live);
    if (dropped.length) {
      output.appendLine(`[omp] forgot ${dropped.length} chat tab(s) of deleted workspaces`);
      persistChatTabs(kept);
    }
    // Forgetting a record does nothing to a panel that is already open on that
    // workspace. `activate` returns before the startup reconcile against `git
    // worktree list` has run, so a worktree removed outside VS Code — `git
    // worktree remove`, an `rm -rf` — is still in the registry when the
    // serializer reads it, and its tab comes back bound to a directory that no
    // longer exists. When the reconcile lands, that panel is still holding an
    // agent there and still answering `liveWorkspaceSession`. It is closed the
    // way `closeChat` closes one: `disposeAndWait` first, because a Remote
    // Control lease would otherwise keep the child alive in a deleted
    // worktree, and `panel.dispose()` either way so a failure cannot strand it.
    const liveIds = new Set(live);
    let closed = 0;
    for (const [panel, id] of [...panelWorkspaces]) {
      if (liveIds.has(id)) {
        continue;
      }
      closed += 1;
      const session = chatPanels.get(panel);
      const done = session ? session.disposeAndWait() : Promise.resolve();
      void done.then(
        () => panel.dispose(),
        () => panel.dispose(),
      );
    }
    if (closed) {
      output.appendLine(`[omp] closed ${closed} chat tab(s) of deleted workspaces`);
      noteDeadWorkspaceTabs(
        t("A chat tab was closed: the workspace it belonged to no longer exists."),
      );
    }
  });

  // Diffs are counted lazily, so a workspace's churn arrives well after its row
  // does. `onDidChangeStats` rather than the review tree's own change event:
  // the board only cares that a *number* moved, and repainting it every time
  // the other tree re-rendered would be noise.
  const reviewChanged = review.onDidChangeStats(() => board.refresh());
  // The scanner already swallows the noise — it fires only when a workspace's
  // port set actually changed — so every event is worth a repaint.
  const portsChanged = portScanner.onDidChange(() => board.refresh());

  /**
   * Selecting a workspace on the board points the review tree at the same one.
   *
   * `ompcode.workspace.reveal` — the row's click command — brings that
   * workspace's chat to the front, and is left exactly as it was: this hangs
   * off the selection instead of wrapping the command, so reveal keeps its
   * behaviour whether it was a click, a context menu or the palette.
   * `focus: false` because reveal's whole job is to put the chat in front of
   * the operator, and pulling focus into a side panel would undo it.
   */
  const revealInReview = (id: string, name: string): void => {
    // Ask the review provider for its own node: `reveal` matches on element
    // identity, and a node built here would be a different object describing
    // the same row.
    const node: ReviewNode | undefined = review.nodeFor(id);
    if (!node) {
      return;
    }
    void Promise.resolve(reviewView.reveal(node, { select: true, focus: false })).catch(
      (error: unknown) => {
        // Revealing a row in a collapsed, never-rendered tree can simply fail.
        // It is a courtesy, not an action the operator asked for — log it.
        output.appendLine(`[review] could not reveal ${name}: ${String(error)}`);
      },
    );
  };

  const boardSelection = boardView.onDidChangeSelection((event) => {
    const selected = event.selection[0];
    if (selected?.kind !== "workspace") {
      return;
    }
    revealInReview(selected.record.id, selected.record.name);
  });

  // A worktree can be removed with `git worktree remove` behind the extension's
  // back, so the stored list is reconciled against git once per activation.
  void (async () => {
    const roots = new Set<string>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      try {
        roots.add(await mainRepoRoot(folder.uri.fsPath));
      } catch {
        // Not a repository: nothing to reconcile, and nothing worth warning about.
      }
    }
    for (const root of roots) {
      try {
        const result = await workspaces.reconcileWithGit(root);
        if (result.orphaned.length) {
          output.appendLine(
            `[workspaces] dropped ${result.orphaned.length} record(s) with no worktree in ${root}`,
          );
        }
      } catch (error) {
        output.appendLine(`[workspaces] reconcile failed for ${root}: ${String(error)}`);
      }
    }
  })();
  const remoteControl = new RemoteControlService(context, output, {
    createSession: async (workspaceRoot) => {
      const panel = await openChatTab(workspaceRoot);
      return panel ? chatPanels.get(panel) : undefined;
    },
  });
  activeRemoteControl = remoteControl;
  void remoteControl.restore().catch((error) => {
    output.appendLine(`[remote] restore failed: ${String(error)}`);
  });

  // Read once: the manifest cannot change while the extension host is up.
  const settingKeys = declaredSettingKeys(context);

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
    envVar: string | undefined,
  ): Promise<void> {
    const value = await vscode.window.showInputBox({
      title: t("OMP Code: {0} API Key", label),
      // Without an env var the key travels in models.yml, and saying so is the
      // difference between a promise the extension keeps and one it does not.
      prompt: envVar
        ? t(
            "Stored in VS Code Secret Storage and passed to the omp agent as {0}. Leave empty to clear.",
            envVar,
          )
        : t(
            "Stored in VS Code Secret Storage and written into models.yml when the agent starts. Leave empty to clear.",
          ),
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
    const restart = t("Restart Agent");
    const action = await vscode.window.showInformationMessage(
      trimmed
        ? t("{0} API key saved. Restart the agent to apply it.", label)
        : t("{0} API key cleared. Restart the agent to apply it.", label),
      restart,
    );
    if (action === restart) {
      await restartAllSessions();
    }
  }

  context.subscriptions.push(
    output,
    provider,
    remoteControl,
    statusBar,
    vscode.workspace.registerTextDocumentContentProvider("ompcode-diff", {
      provideTextDocumentContent: (uri) => diffContents.get(uri.path) ?? "",
    }),
    // The left-hand side of every review diff: the file as the workspace's
    // pinned base commit had it. A virtual document rather than a temp file, so
    // nothing lands on disk and the editor stays read-only by construction.
    vscode.workspace.registerTextDocumentContentProvider(
      BaseContentProvider.scheme,
      new BaseContentProvider((id) => workspaces.get(id)),
    ),
    vscode.workspace.onDidChangeConfiguration((e) => {
      const changed = settingKeys.filter((key) => e.affectsConfiguration(`ompcode.${key}`));
      // Settings the agent process never reads. Killing a live turn over one of
      // them — a palette, or where the next worktree will go — is pure loss.
      const hostOnly =
        changed.length > 0 &&
        changed.every((key) => (HOST_ONLY_SETTINGS as readonly string[]).includes(key));
      if (hostOnly) {
        if (changed.includes("theme") || changed.includes("accentColor")) {
          output.appendLine("[omp] palette changed — updating webviews");
          OmpSession.forEachActive((session) => session.pushTheme());
        }
        if (changed.includes("portScan") || changed.includes("portScanIgnore")) {
          // start() rescans immediately, so a narrowed ignore list takes
          // effect now rather than on the next tick.
          if (portScanEnabled()) {
            portScanner.start();
          } else {
            portScanner.stop();
          }
        }
        return;
      }
      // The webview bundle is baked into the HTML at build time, so a language
      // change has to rebuild it; the transcript in the DOM is lost either
      // way because the sessions restart below.
      if (e.affectsConfiguration("ompcode.language")) {
        applyLanguage(context, output);
        OmpSession.forEachActive((session) => session.reloadHtml());
        board.refresh();
      }
      if (e.affectsConfiguration("ompcode")) {
        // A workspace pins its own model and approval mode. Restarting its
        // agent because the *global* default moved would silently swap the
        // model the operator chose for that branch, mid-task.
        const overridableOnly =
          changed.length > 0 &&
          changed.every((key) => (OVERRIDABLE_SETTINGS as readonly string[]).includes(key));
        if (!overridableOnly) {
          output.appendLine("[omp] configuration changed — restarting all sessions");
          void restartAllSessions();
          return;
        }
        output.appendLine(
          `[omp] ${changed.join(", ")} changed — restarting the sessions that follow it`,
        );
        OmpSession.forEachActive((session) => {
          if (changed.some((key) => session.usesSetting(key as (typeof OVERRIDABLE_SETTINGS)[number]))) {
            void session.restart();
          }
        });
      }
    }),
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.window.registerWebviewViewProvider(BoardViewProvider.viewType, boardPanel, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    // Chat tabs are ordinary webview panels: VS Code persists them across a
    // window reload but throws them away unless something claims their
    // viewType. Without this every open chat vanished on "Developer: Reload
    // Window", conversation included. Paired with the `onWebviewPanel:` entry
    // in activationEvents — the restore has to be able to wake the extension.
    vscode.window.registerWebviewPanelSerializer("ompcode.chatTab", {
      deserializeWebviewPanel: (panel, state: unknown) => {
        restoreChatTab(panel, state);
        return Promise.resolve();
      },
    }),
    // A TreeView instance, not just a registered provider: later phases need the
    // handle for the view badge (running subagents) and for revealing a row.
    boardView,
    boardSelection,
    reviewChanged,
    workspacesChanged,
    portsChanged,
    terminalsChanged,
    // Same reason as `boardView`: later work wants the handle, for the count of
    // workspaces with changes as a view badge.
    reviewView,
    // The provider and the manager hold subscriptions of their own (session
    // board changes, the workspace registry); the TreeView disposes neither.
    board,
    // The board view holds the change subscription and the flush timer; the
    // poll's interval must die with the extension host.
    boardPanel,
    boardPoll,
    // The review provider owns a diff cache and a file watcher per worktree —
    // both must go when the extension does, or a deactivated window keeps
    // stat-ing worktrees.
    review,
    workspaces,
    // The manager never kills user terminals on dispose; the scanner must stop
    // polling the OS the moment the extension host lets go of it.
    terminals,
    portScanner,

    // The last argument is the review half of `ompcode.workspace.reveal`.
    // Selection alone is not enough: the command is also reachable from the
    // row's inline action, the palette and other code, and none of those
    // select the row.
    ...registerWorkspaceCommands(
      context,
      workspaces,
      resolveRepoRoot,
      { terminals, portsFor: (id) => portScanner.portsFor(id) },
      (record) => revealInReview(record.id, record.name),
    ),
    ...registerReviewCommands(context, { manager: workspaces, provider: review, output }),

    vscode.commands.registerCommand("ompcode.newSession", () => void openChatTab()),

    // What the chat sees when it calls `workspace_list`, printed where a human
    // can read it: the same rows, out of the same facade, so "the model says it
    // is still working" and "the board says it is idle" can be told apart.
    vscode.commands.registerCommand("ompcode.orchestrator.status", async () => {
      const rows = await orchestrator.list().catch((error: unknown) => {
        output.appendLine(`[orchestrator] status failed: ${String(error)}`);
        void vscode.window.showErrorMessage(
          t("Could not read the workspace states: {0}", String(error)),
        );
        return undefined;
      });
      if (!rows) {
        return;
      }
      // `true` keeps the focus where it is: this is a report to glance at, not
      // a panel to work in.
      output.show(true);
      if (!rows.length) {
        output.appendLine("[orchestrator] no workspaces");
        void vscode.window.showInformationMessage(
          t("No workspaces yet. Ask the chat for one, or create it from the Sessions view."),
        );
        return;
      }
      output.appendLine(`[orchestrator] ${rows.length} workspace(s)`);
      for (const row of rows) {
        output.appendLine(
          `  ${row.id} · ${row.name} · ⎇ ${row.branch} · ${row.model || "—"} · ${row.state}` +
            ` · $${row.cost.toFixed(2)} · +${row.added} −${row.deleted} · ${row.files} file(s)` +
            ` · setup ${row.setupState}`,
        );
      }
    }),

    vscode.commands.registerCommand("ompcode.remoteStart", async () => {
      const origin = OmpSession.anyActive() ?? await revealChatTab();
      if (!origin) return;
      const picked = await vscode.window.showQuickPick<{
        label: string;
        description: string;
        grant: RemoteGrant;
      }>([
        {
          label: t("Current session (recommended)"),
          description: t("This one chat only. Every other chat, and every other project, stays invisible to the phone."),
          grant: "current",
        },
        {
          label: t("All sessions"),
          description: t("Every chat in the project folders open right now, grouped by project on the phone — including chats opened in those folders later. A folder opened after pairing needs a new pairing."),
          grant: "all",
        },
        {
          label: t("All sessions + credentials"),
          description: t("As above, and the phone may change provider API keys. Grant this only to a phone you control."),
          grant: "all-with-credentials",
        },
      ], {
        title: t("OMP Code Remote Control: desktop grant"),
        placeHolder: t("Choose exactly what the phone may control"),
      });
      if (!picked) return;
      try {
        await remoteControl.start(origin, picked.grant);
      } catch (error) {
        await vscode.window.showErrorMessage(t("Remote Control could not start: {0}", String(error)));
      }
    }),

    // The picker exists to make the scope an explicit choice. A button whose own
    // label names that scope is the same choice with one less step, so this skips
    // the picker — and only for "all", which never includes credential access.
    vscode.commands.registerCommand("ompcode.remoteStartAllSessions", async () => {
      const origin = OmpSession.anyActive() ?? await revealChatTab();
      if (!origin) return;
      try {
        await remoteControl.start(origin, "all");
      } catch (error) {
        await vscode.window.showErrorMessage(t("Remote Control could not start: {0}", String(error)));
      }
    }),
    vscode.commands.registerCommand("ompcode.remoteOpen", () => remoteControl.openStatusPanel()),
    vscode.commands.registerCommand("ompcode.remoteRefreshPairing", async () => {
      if (!remoteControl.canRefreshPairing()) {
        await vscode.window.showInformationMessage(
          t("There is no Remote Control room to refresh. Start one with “Connect a phone…”."),
        );
        return;
      }
      // Re-minting inside a live room is not a new grant, so it needs no second
      // scope prompt. It does need one when a phone is already enrolled: whoever
      // scans the new code takes that phone's place.
      if (remoteControl.hasPairedDevice()) {
        const proceed = t("Show a new QR");
        const answer = await vscode.window.showWarningMessage(
          t("A phone is already paired. Whoever scans the new QR replaces it."),
          { modal: true },
          proceed,
        );
        if (answer !== proceed) return;
      }
      const refreshed = await remoteControl.refreshPairing();
      if (!refreshed) {
        await vscode.window.showErrorMessage(t("The pairing QR could not be refreshed."));
      }
    }),
    vscode.commands.registerCommand("ompcode.remoteCopyPairing", async () => {
      const copied = await remoteControl.copyPairingUri();
      await vscode.window.showInformationMessage(copied
        ? t("OMP Code pairing link copied. Treat it like a short-lived password.")
        : t("No unexpired pairing link is available."));
    }),
    vscode.commands.registerCommand("ompcode.remoteStatus", async () => {
      await remoteControl.openStatusPanel();
    }),
    vscode.commands.registerCommand("ompcode.remoteStop", async () => {
      const stop = t("Stop and revoke");
      const selected = await vscode.window.showWarningMessage(
        t("Stop Remote Control and permanently revoke the enrolled phone?"),
        { modal: true },
        stop,
      );
      if (selected === stop) {
        await remoteControl.stop(true);
        await vscode.window.showInformationMessage(t("OMP Code Remote Control stopped and revoked."));
      }
    }),

    // Title-bar entry point: the chat opens as an editor tab beside the code,
    // not as the left sidebar view.
    vscode.commands.registerCommand("ompcode.openChat", () => void revealChatTab()),

    vscode.commands.registerCommand("ompcode.showHistory", async () => {
      (await revealChatTab())?.showHistory();
    }),

    // A row click carries its id; inline/context actions receive a board node,
    // which may be a subagent — `sessionCommandId` folds both onto a session id.
    vscode.commands.registerCommand("ompcode.sessionReveal", (arg?: SessionInfo | BoardNode | string) => {
      const id = sessionCommandId(arg);
      if (!id) {
        void revealChatTab();
        return;
      }
      SessionBoardProvider.findSession(id)?.reveal();
    }),
    vscode.commands.registerCommand("ompcode.sessionAbort", (arg?: SessionInfo | BoardNode | string) => {
      const id = sessionCommandId(arg);
      if (!id) {
        return;
      }
      SessionBoardProvider.findSession(id)?.abort();
    }),
    vscode.commands.registerCommand("ompcode.sessionClose", (arg?: SessionInfo | BoardNode | string) => {
      const id = sessionCommandId(arg);
      if (!id) {
        return;
      }
      SessionBoardProvider.findSession(id)?.requestClose();
    }),

    // A subagent has no chat surface of its own, so its JSONL session file is
    // the only record of what it did — opened read-only, as a preview tab.
    vscode.commands.registerCommand("ompcode.subagentTranscript", async (node?: BoardNode) => {
      if (!node || node.kind !== "subagent") {
        // The command is also reachable from the palette, where there is no row
        // to act on — say so instead of appearing to do nothing.
        void vscode.window.showInformationMessage(
          t("Pick a subagent in the OMP Code sessions view to open its transcript."),
        );
        return;
      }
      const session = SessionBoardProvider.findSession(node.sessionId);
      if (!session) {
        void vscode.window.showErrorMessage(t("That chat is no longer open."));
        return;
      }
      try {
        const content = await session.subagentTranscript(node.info.id);
        const doc = await vscode.workspace.openTextDocument({ content, language: "jsonl" });
        await vscode.window.showTextDocument(doc, { preview: true });
      } catch (err) {
        void vscode.window.showErrorMessage(
          t("Could not read the subagent transcript: {0}", String(err)),
        );
      }
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
        KEYED_PROVIDERS.map((p) => ({ label: t("{0} API key", p.label), secret: p.secret })),
        {
          title: t("OMP Code: Clear stored API key"),
          placeHolder: t("Subscription sign-ins are not affected"),
        },
      );
      if (!picked) return;
      await context.secrets.delete(picked.secret);
      const restart = t("Restart Agent");
      const action = await vscode.window.showInformationMessage(
        t("{0} cleared. Restart the agent to apply it.", picked.label),
        restart,
      );
      if (action === restart) {
        await restartAllSessions();
      }
    }),

    vscode.commands.registerCommand("ompcode.setProviderKey", async () => {
      // Provider API keys live in Secret Storage (not the plaintext settings JSON).
      const cfg = vscode.workspace.getConfiguration("ompcode");
      const providers = cfg.get<Record<string, unknown>>("customProviders", {});
      const names = Object.keys(providers).sort();
      if (!names.length) {
        const openModels = t("Open models.yml");
        const action = await vscode.window.showInformationMessage(
          t('No custom providers configured. Add one under "ompcode.customProviders" first.'),
          openModels,
        );
        if (action === openModels) {
          await vscode.commands.executeCommand("ompcode.openModelsConfig");
        }
        return;
      }
      const name = await vscode.window.showQuickPick(names, {
        title: t("OMP Code: Provider API key"),
        placeHolder: t("Select a custom provider"),
      });
      if (!name) return;
      const secretKey = `ompcode.providerKey.${name}`;
      const value = await vscode.window.showInputBox({
        title: t("OMP Code: {0} API key", name),
        prompt: t(
          'Stored in Secret Storage and injected into the "{0}" provider in models.yml. Leave empty to clear.',
          name,
        ),
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
      const restart = t("Restart Agent");
      const action = await vscode.window.showInformationMessage(
        trimmed
          ? t("{0} API key saved. Restart the agent to apply it.", name)
          : t("{0} API key cleared. Restart the agent to apply it.", name),
        restart,
      );
      if (action === restart) {
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
        await vscode.window.showInformationMessage(t("OMP Code: open a chat first."));
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

export async function deactivate(): Promise<void> {
  const remoteControl = activeRemoteControl;
  activeRemoteControl = undefined;
  // Preserve enrolled credentials for restore, but synchronously drain the
  // transport and remove plaintext attachment staging on normal shutdown.
  if (remoteControl) {
    await remoteControl.stop(false);
    remoteControl.dispose();
  }
  // Stop every live session's omp process so we don't leave orphans on
  // extension deactivation (editor tabs + sidebar share OmpSession.active).
  OmpSession.forEachActive((session) => session.forceDispose());
}
