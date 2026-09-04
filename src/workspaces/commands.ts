import * as path from "node:path";
import * as vscode from "vscode";
import { t } from "../l10n.ts";
import { APPROVAL_MODES, type ApprovalMode } from "../ompSession";
import { currentBranch, listBranches } from "./git";
import { sanitizeWorkspaceName, type WorkspaceManager } from "./manager";
import type { ListeningPort } from "./ports";
import type { TerminalManager } from "./terminals";
import type { WorkspaceRecord } from "./types";

/**
 * Every workspace command's user interface. `manager.ts` owns the ordering
 * rules and touches no VS Code API; this file owns the prompts and the error
 * surface and holds no state of its own.
 */

/**
 * What the tree hands a command: the board node for the clicked row, a bare id,
 * or nothing at all when the command comes from the palette. Typed structurally
 * rather than importing `BoardNode` — the board already imports the workspace
 * types, and an import back would close the cycle.
 */
type WorkspaceCommandArg = string | { kind?: unknown; record?: WorkspaceRecord } | undefined;

/** Branch marker, matched to the board rows so the two surfaces read alike. */
const BRANCH_MARK = "⎇";

/**
 * The workspace's live half: the terminals it owns and the ports the scanner
 * attributes to it. Injected like everything else here — the commands act
 * through it and hold no state of their own.
 */
export interface WorkspaceRuntime {
  terminals: TerminalManager;
  portsFor(workspaceId: string): ListeningPort[];
}

export function registerWorkspaceCommands(
  context: vscode.ExtensionContext,
  manager: WorkspaceManager,
  resolveRepoRoot: () => Promise<string | undefined>,
  runtime: WorkspaceRuntime,
  /**
   * Something else that wants to point at the same workspace — the review tree,
   * today. Optional and injected rather than imported, so this layer keeps
   * knowing nothing about the review layer, and every failure inside it is the
   * caller's to swallow.
   */
  alsoReveal?: (record: WorkspaceRecord) => void,
): vscode.Disposable[] {
  // The caller owns the lifetime of what we return; nothing here outlives it.
  // `context` is read for one thing only: the bundled orchestrator instruction
  // ships inside the extension, so installing it into a repository means
  // copying a file out of `extensionUri`.
  return [
    vscode.commands.registerCommand("ompcode.workspace.create", async () => {
      const repoRoot = await resolveRepoRoot();
      if (!repoRoot) {
        void vscode.window.showErrorMessage(
          t("Open a git repository first — a workspace is a git worktree of one."),
        );
        return;
      }
      const opts = await collectCreateOptions(manager, repoRoot);
      if (!opts) {
        return;
      }
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: t("Creating workspace {0}…", opts.name),
        },
        async () => {
          try {
            const record = await manager.create(repoRoot, opts);
            // The branch is the part the operator did not choose — it is derived
            // from the name and the prefix setting, so the message names it.
            void vscode.window.showInformationMessage(
              t("Workspace {0} is ready on {1}.", record.name, record.branch),
            );
          } catch (err) {
            void vscode.window.showErrorMessage(
              t("Could not create the workspace: {0}", describeError(err)),
            );
          }
        },
      );
    }),

    vscode.commands.registerCommand("ompcode.workspace.delete", async (arg?: WorkspaceCommandArg) => {
      const record = await resolveWorkspace(manager, arg);
      if (!record) {
        return;
      }
      // The branch is the one part of a workspace that can outlive it, so it is
      // an explicit choice rather than a checkbox buried in a confirmation.
      const picked = await vscode.window.showQuickPick(
        [
          {
            label: t("Delete the workspace, keep the branch"),
            detail: t("The worktree at {0} goes; {1} stays.", record.worktreePath, record.branch),
            deleteBranch: false,
          },
          {
            label: t("Delete the workspace and its branch"),
            detail: t("The worktree and {0} both go, with every commit only on it.", record.branch),
            deleteBranch: true,
          },
        ],
        // Both options say what they destroy: "keep the branch" read as the
        // safe answer while it was in fact the one that deletes the worktree.
        { title: t("Delete the workspace {0}?", record.name), ignoreFocusOut: true },
      );
      if (!picked) {
        return;
      }
      try {
        // No confirmation here: the manager raises one, and only when something
        // would actually be lost. A second modal for a clean workspace would
        // train the operator to click through both.
        await manager.remove(record.id, { deleteBranch: picked.deleteBranch });
      } catch (err) {
        void vscode.window.showErrorMessage(
          t("Could not delete the workspace: {0}", describeError(err)),
        );
        return;
      }
      // The manager's own confirmation can end in "no", which returns quietly —
      // whether the record is still there is the only honest signal.
      if (!manager.get(record.id)) {
        void vscode.window.showInformationMessage(t("Workspace {0} deleted.", record.name));
      }
    }),

    // The row's own click target: bring this workspace's chat to the front, or
    // start it again if the agent was stopped or VS Code restarted.
    vscode.commands.registerCommand("ompcode.workspace.reveal", async (arg?: WorkspaceCommandArg) => {
      const record = await resolveWorkspace(manager, arg);
      if (!record) {
        return;
      }
      try {
        await manager.reopen(record.id);
      } catch (err) {
        void vscode.window.showErrorMessage(
          t("Could not open the workspace chat: {0}", describeError(err)),
        );
      }
      // After the chat, never instead of it: revealing the row elsewhere is a
      // courtesy, and a failure to do it must not look like a failed reveal.
      alsoReveal?.(record);
    }),

    vscode.commands.registerCommand(
      "ompcode.workspace.openTerminal",
      async (arg?: WorkspaceCommandArg) => {
        const record = await resolveWorkspace(manager, arg);
        if (!record) {
          return;
        }
        runtime.terminals.open(record);
      },
    ),

    vscode.commands.registerCommand(
      "ompcode.workspace.openPort",
      async (arg?: WorkspaceCommandArg) => {
        const record = await resolveWorkspace(manager, arg);
        if (!record) {
          return;
        }
        const ports = runtime.portsFor(record.id);
        if (ports.length === 0) {
          void vscode.window.showInformationMessage(
            t("No listening ports detected for {0}.", record.name),
          );
          return;
        }
        let port = ports[0]!.port;
        if (ports.length > 1) {
          const picked = await vscode.window.showQuickPick(
            ports.map((p) => ({ label: String(p.port), description: p.address, port: p.port })),
            { placeHolder: t("Open which port?") },
          );
          if (!picked) {
            return;
          }
          port = picked.port;
        }
        try {
          // `asExternalUri` before opening: under Remote-SSH a plain localhost
          // link points at the operator's machine, and this maps the tunnel.
          const uri = await vscode.env.asExternalUri(
            vscode.Uri.parse(`http://localhost:${port}`),
          );
          await vscode.env.openExternal(uri);
        } catch (err) {
          void vscode.window.showErrorMessage(
            t("Could not open the port: {0}", describeError(err)),
          );
        }
      },
    ),

    vscode.commands.registerCommand(
      "ompcode.workspace.openInNewWindow",
      async (arg?: WorkspaceCommandArg) => {
        const record = await resolveWorkspace(manager, arg);
        if (!record) {
          return;
        }
        // forceNewWindow: this window keeps the main checkout open. Reusing it
        // would swap the project out from under every other running workspace.
        await vscode.commands.executeCommand(
          "vscode.openFolder",
          vscode.Uri.file(record.worktreePath),
          { forceNewWindow: true },
        );
      },
    ),

    vscode.commands.registerCommand(
      "ompcode.workspace.runSetup",
      async (arg?: WorkspaceCommandArg) => {
        const record = await resolveWorkspace(manager, arg);
        if (!record) {
          return;
        }
        try {
          const result = await manager.runSetup(record.id);
          if (!result.ran) {
            void vscode.window.showInformationMessage(
              t("No setup commands are configured for {0}.", record.name),
            );
          } else if (result.ok) {
            void vscode.window.showInformationMessage(t("Setup for {0} finished.", record.name));
          } else if (result.exitCode === undefined) {
            void vscode.window.showErrorMessage(
              t("Setup for {0} failed — see the terminal.", record.name),
            );
          } else {
            void vscode.window.showErrorMessage(
              t(
                "Setup for {0} failed with exit code {1} — see the terminal.",
                record.name,
                result.exitCode,
              ),
            );
          }
        } catch (err) {
          void vscode.window.showErrorMessage(t("Could not run setup: {0}", describeError(err)));
        }
      },
    ),

    vscode.commands.registerCommand(
      "ompcode.workspace.runConfigured",
      async (arg?: WorkspaceCommandArg) => {
        const record = await resolveWorkspace(manager, arg);
        if (!record) {
          return;
        }
        try {
          // Resolves once the prep commands finish and the last one — the
          // dev-server slot — has started; the server itself is not awaited.
          const result = await runtime.terminals.runConfigured(record);
          if (result.ran.length === 0) {
            void vscode.window.showInformationMessage(
              t("No run commands are configured for {0}.", record.name),
            );
          } else if (result.exitCode !== undefined) {
            void vscode.window.showErrorMessage(
              t(
                "Run commands for {0} failed with exit code {1} — see the terminal.",
                record.name,
                result.exitCode,
              ),
            );
          }
        } catch (err) {
          void vscode.window.showErrorMessage(
            t("Could not run the workspace commands: {0}", describeError(err)),
          );
        }
      },
    ),

    vscode.commands.registerCommand("ompcode.installOrchestratorAgent", async () => {
      const repoRoot = await resolveRepoRoot();
      if (!repoRoot) {
        void vscode.window.showErrorMessage(
          t("Open a git repository first — the instruction is installed into one."),
        );
        return;
      }
      await installOrchestratorAgent(context, repoRoot);
    }),
  ];
}

/**
 * Where omp looks for a project's own agent files (`omp agents unpack
 * --project` writes here), so the instruction sits beside them rather than in
 * a folder only this extension knows about.
 */
const ORCHESTRATOR_AGENT_PATH = [".omp", "agents", "orchestrator.md"];

/**
 * The line to put in `AGENTS.md`. omp loads `AGENTS.md` into the *top-level*
 * session, which is the only session that has the workspace tools — a file
 * under `.omp/agents/` on its own is read by the `task` runner, and a subagent
 * cannot orchestrate anything. So the file is where omp's own agents live, and
 * this pointer is what actually puts it in front of the chat that can act on
 * it. English on purpose: a model reads it, not a person.
 */
const AGENTS_MD_LINE =
  "When a task is big enough to split across parallel workspaces, follow .omp/agents/orchestrator.md.";

/**
 * Copy the bundled orchestration instruction into the repository. Deliberately
 * a copy and not a link: the point is that the human can edit their project's
 * copy — trim the model routing, add their own conventions — without the next
 * extension update overwriting it, which is also why an existing file is never
 * replaced without asking.
 */
async function installOrchestratorAgent(
  context: vscode.ExtensionContext,
  repoRoot: string,
): Promise<void> {
  const source = vscode.Uri.joinPath(context.extensionUri, "media", "orchestrator.md");
  const target = vscode.Uri.file(path.join(repoRoot, ...ORCHESTRATOR_AGENT_PATH));
  const relative = ORCHESTRATOR_AGENT_PATH.join("/");

  let existed = false;
  try {
    await vscode.workspace.fs.stat(target);
    existed = true;
  } catch {
    // Nothing there yet, which is the ordinary case.
  }
  if (existed) {
    const replace = t("Replace it");
    const picked = await vscode.window.showWarningMessage(
      t("{0} already exists. Replace it with the bundled instruction?", relative),
      { modal: true, detail: t("Anything you changed in that file is lost.") },
      replace,
    );
    if (picked !== replace) {
      return;
    }
  }

  try {
    const bytes = await vscode.workspace.fs.readFile(source);
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(target, ".."));
    await vscode.workspace.fs.writeFile(target, bytes);
  } catch (err) {
    void vscode.window.showErrorMessage(
      t("Could not write {0}: {1}", relative, describeError(err)),
    );
    return;
  }

  const open = t("Open it");
  const copy = t("Copy the AGENTS.md line");
  // Both halves in one line: a non-modal notification drops `detail`, and the
  // second half is the part an operator forgets — the file alone changes
  // nothing until something the main chat reads points at it.
  const picked = await vscode.window.showInformationMessage(
    t("Wrote {0}. Point AGENTS.md at it so the main chat follows it.", relative),
    open,
    copy,
  );
  if (picked === open) {
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target));
  } else if (picked === copy) {
    await vscode.env.clipboard.writeText(AGENTS_MD_LINE);
    void vscode.window.showInformationMessage(
      t("Copied. Paste it into AGENTS.md at the repository root."),
    );
  }
}

/**
 * The New Workspace flow: name, base branch, model, approval tier, first
 * message. Sequential prompts rather than one multi-step QuickInput — each
 * step's list depends on the answer before it, and Escape anywhere means
 * "never mind", which is what an `undefined` from any step already gives us.
 */
async function collectCreateOptions(
  manager: WorkspaceManager,
  repoRoot: string,
): Promise<
  | {
      name: string;
      baseRef: string;
      model: string;
      approvalMode: ApprovalMode;
      prompt?: string;
    }
  | undefined
> {
  const taken = new Set(manager.list().map((record) => record.name.toLowerCase()));
  // Read once, up front: the branch clash is otherwise only found inside
  // `create`, four prompts later, and the fix is to start the wizard over.
  const branchPrefix = vscode.workspace
    .getConfiguration("ompcode")
    .get<string>("workspaceBranchPrefix", "omp/");
  const branches = new Set(await listBranches(repoRoot).catch(() => [] as string[]));
  const raw = await vscode.window.showInputBox({
    title: t("Name the new workspace"),
    prompt: t("Becomes the branch name and the worktree folder."),
    placeHolder: "feat-a",
    ignoreFocusOut: true,
    validateInput: (value) => {
      const name = sanitizeWorkspaceName(value);
      if (!name) {
        return value.trim()
          ? t("Use letters, digits, dot, dash and underscore only.")
          : t("A workspace needs a name.");
      }
      // Compared in the sanitized form, because that is what would collide.
      if (taken.has(name.toLowerCase())) {
        return t("A workspace named \"{0}\" already exists.", name);
      }
      const branch = `${branchPrefix}${name}`;
      if (branches.has(branch)) {
        return t("Branch {0} already exists — pick another name.", branch);
      }
      return undefined;
    },
  });
  if (raw === undefined) {
    return undefined;
  }
  const name = sanitizeWorkspaceName(raw);

  const baseRef = await pickBaseRef(repoRoot);
  if (baseRef === undefined) {
    return undefined;
  }

  const cfg = vscode.workspace.getConfiguration("ompcode");
  // Pre-filled with the global default so the common answer is Enter, and
  // clearing it is the explicit way to say "just follow the setting".
  const model = await vscode.window.showInputBox({
    title: t("Model for this workspace"),
    placeHolder: t("provider/model — empty keeps the default model"),
    value: cfg.get<string>("defaultModel", ""),
    ignoreFocusOut: true,
  });
  if (model === undefined) {
    return undefined;
  }

  const approvalMode = await pickApprovalMode(cfg.get<string>("approvalMode", "always-ask"));
  if (!approvalMode) {
    return undefined;
  }

  const prompt = await vscode.window.showInputBox({
    title: t("First prompt (optional)"),
    prompt: t("Sent as soon as the workspace opens."),
    ignoreFocusOut: true,
  });
  if (prompt === undefined) {
    return undefined;
  }

  return { name, baseRef, model: model.trim(), approvalMode, prompt: prompt.trim() || undefined };
}

async function pickBaseRef(repoRoot: string): Promise<string | undefined> {
  let branches: string[];
  let current: string;
  try {
    [branches, current] = await Promise.all([listBranches(repoRoot), currentBranch(repoRoot)]);
  } catch (err) {
    void vscode.window.showErrorMessage(
      t("Could not read this repository's branches: {0}", describeError(err)),
    );
    return undefined;
  }
  if (branches.length === 0) {
    // `git worktree add` needs a commit to branch from, and a repository with
    // no branch yet has none.
    void vscode.window.showErrorMessage(
      t("This repository has no branches yet — make a first commit."),
    );
    return undefined;
  }
  // The branch you are on is nearly always the one to branch from, so it leads
  // the list rather than sitting wherever git's alphabetical order put it.
  const ordered = current ? [current, ...branches.filter((b) => b !== current)] : branches;
  const picked = await vscode.window.showQuickPick(
    ordered.map((branch) => ({
      label: branch,
      description: branch === current ? t("current") : undefined,
    })),
    { placeHolder: t("Branch the workspace starts from"), ignoreFocusOut: true },
  );
  return picked?.label;
}

/**
 * The three tiers omp actually has, worded exactly as the chat composer words
 * them — the same choice in two places must not read as two different ones.
 */
async function pickApprovalMode(current: string): Promise<ApprovalMode | undefined> {
  const described: Record<ApprovalMode, { label: string; detail: string }> = {
    "always-ask": {
      label: t("Ask before changes"),
      detail: t("Reads files freely; asks before writing a file or running a command"),
    },
    write: {
      label: t("Write freely, ask to run"),
      detail: t("Reads and edits files on its own; asks before running a command"),
    },
    yolo: {
      label: t("Full access"),
      detail: t("Reads, edits and runs shell commands with no confirmation"),
    },
  };
  const picked = await vscode.window.showQuickPick(
    APPROVAL_MODES.map((mode) => ({
      mode,
      label: described[mode].label,
      detail: described[mode].detail,
      description: mode === current ? t("current") : undefined,
    })),
    { placeHolder: t("Tool access for this workspace"), ignoreFocusOut: true },
  );
  return picked?.mode;
}

/**
 * Which workspace a command acts on. A row action carries the node, a row click
 * carries an id, the palette carries nothing — and the palette case has to ask,
 * never guess, since one of these commands deletes.
 */
async function resolveWorkspace(
  manager: WorkspaceManager,
  arg: WorkspaceCommandArg,
): Promise<WorkspaceRecord | undefined> {
  if (typeof arg === "string") {
    return arg ? manager.get(arg) : pickWorkspace(manager);
  }
  const id = arg?.record?.id;
  if (typeof id === "string" && id) {
    // The node carries the snapshot the tree was painted with; the registry has
    // the current one, and setup state may have moved on since.
    return manager.get(id) ?? arg?.record;
  }
  return pickWorkspace(manager);
}

async function pickWorkspace(manager: WorkspaceManager): Promise<WorkspaceRecord | undefined> {
  const records = manager.list();
  if (records.length === 0) {
    void vscode.window.showInformationMessage(t("No workspaces yet — create one first."));
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    records.map((record) => ({
      label: record.name,
      description: `${BRANCH_MARK} ${record.branch}`,
      detail: record.worktreePath,
      record,
    })),
    { placeHolder: t("Select a workspace"), ignoreFocusOut: true },
  );
  return picked?.record;
}

/**
 * git's own stderr is the most actionable thing a failure carries and needs no
 * translation, so a `GitError` reports that rather than a wrapper message.
 * Duck-typed to keep this file off the git module's error class.
 */
function describeError(err: unknown): string {
  if (err && typeof err === "object" && "stderr" in err) {
    const stderr = String((err as { stderr: unknown }).stderr).trim();
    if (stderr) {
      return stderr;
    }
  }
  return err instanceof Error ? err.message : String(err);
}
