import * as vscode from "vscode";
import { readWorkspaceConfig } from "./setup";
import type { WorkspaceRecord } from "./types";

/**
 * Per-workspace terminals: opening them, remembering which workspace each one
 * belongs to, and running the worktree's configured `run` commands in them.
 *
 * A static `vscode` import, like `setupRun.ts` and for the same reason: the
 * module is bundled into the extension and never loaded by `node --test`,
 * which is why `test/workspaceTerminals.test.ts` checks this file as source
 * text instead of importing it.
 */

export interface TerminalManagerDeps {
  output: { appendLine(s: string): void };
}

/** How long to wait for shell integration before falling back to `sendText`. */
const SHELL_INTEGRATION_TIMEOUT_MS = 3000;

/**
 * Wait for the terminal to report shell integration, which is what makes an
 * exit code observable at all. It arrives a beat after the shell starts, and
 * on some shells never — hence the timeout.
 */
function waitForShellIntegration(
  terminal: vscode.Terminal,
): Promise<vscode.TerminalShellIntegration | undefined> {
  if (terminal.shellIntegration) {
    return Promise.resolve(terminal.shellIntegration);
  }
  return new Promise((resolve) => {
    const done = (value: vscode.TerminalShellIntegration | undefined) => {
      clearTimeout(timer);
      integration.dispose();
      closed.dispose();
      resolve(value);
    };
    const timer = setTimeout(() => done(undefined), SHELL_INTEGRATION_TIMEOUT_MS);
    const integration = vscode.window.onDidChangeTerminalShellIntegration((event) => {
      if (event.terminal === terminal) {
        done(event.shellIntegration);
      }
    });
    const closed = vscode.window.onDidCloseTerminal((event) => {
      if (event === terminal) {
        done(undefined);
      }
    });
  });
}

type ExecutionOutcome = { ended: true; exitCode: number | undefined } | { ended: false };

/**
 * Resolve when this execution finishes — or when the terminal is closed under
 * it, which is the user cancelling and must not be read as success.
 */
function waitForExecution(
  terminal: vscode.Terminal,
  execution: vscode.TerminalShellExecution,
): Promise<ExecutionOutcome> {
  return new Promise((resolve) => {
    const done = (outcome: ExecutionOutcome) => {
      ended.dispose();
      closed.dispose();
      resolve(outcome);
    };
    const ended = vscode.window.onDidEndTerminalShellExecution((event) => {
      if (event.execution === execution) {
        done({ ended: true, exitCode: event.exitCode });
      }
    });
    const closed = vscode.window.onDidCloseTerminal((event) => {
      if (event === terminal) {
        done({ ended: false });
      }
    });
  });
}

/**
 * Owns the terminal↔workspace mapping. Terminals are found by membership in
 * the registry, not by name: names are user-visible and renameable, and two
 * workspaces may legitimately share one.
 *
 * `dispose()` drops the listener and the emitter but leaves the terminals
 * alone — they hold the user's running dev servers, and an extension reload
 * must not take those down.
 */
export class TerminalManager implements vscode.Disposable {
  private readonly registry = new Map<vscode.Terminal, string>();
  private readonly emitter = new vscode.EventEmitter<string>();
  /** Fires the workspaceId whenever one of its terminals opens or closes. */
  readonly onDidChange: vscode.Event<string> = this.emitter.event;
  private readonly closeListener: vscode.Disposable;

  constructor(private readonly deps: TerminalManagerDeps) {
    // One subscription for every terminal: the registry key is the terminal
    // object itself, so a close event maps straight back to its workspace.
    this.closeListener = vscode.window.onDidCloseTerminal((terminal) => {
      const workspaceId = this.registry.get(terminal);
      if (workspaceId === undefined) {
        return;
      }
      this.registry.delete(terminal);
      this.deps.output.appendLine(
        `[terminals] "${terminal.name}" for workspace ${workspaceId} closed`,
      );
      this.emitter.fire(workspaceId);
    });
  }

  /**
   * Open (or reveal) a terminal for the workspace. An existing live terminal
   * with the same name is reused: "open the workspace terminal" is idempotent,
   * pressing the button twice must not stack shells.
   */
  open(record: WorkspaceRecord, opts?: { name?: string; show?: boolean }): vscode.Terminal {
    // Same branch mark the tree items use, so the terminal panel and the board
    // read as one thing.
    const name = opts?.name ?? `⎇ ${record.name}`;
    for (const [terminal, workspaceId] of this.registry) {
      if (workspaceId === record.id && terminal.name === name && terminal.exitStatus === undefined) {
        if (opts?.show !== false) {
          terminal.show();
        }
        return terminal;
      }
    }
    const terminal = vscode.window.createTerminal({
      name,
      cwd: record.worktreePath,
      iconPath: new vscode.ThemeIcon("git-branch"),
      // So anything started in this shell (and the port scanner reading the
      // process tree) can tell which workspace it belongs to.
      env: {
        OMPCODE_WORKSPACE_ID: record.id,
        OMPCODE_WORKSPACE_PATH: record.worktreePath,
      },
    });
    this.registry.set(terminal, record.id);
    this.deps.output.appendLine(`[terminals] opened "${name}" for workspace ${record.id}`);
    this.emitter.fire(record.id);
    if (opts?.show !== false) {
      terminal.show();
    }
    return terminal;
  }

  /**
   * Run the worktree's configured `run` commands in the workspace terminal.
   *
   * `run` is the long-running dev-server slot (see `WorkspaceConfig.run`), so
   * the commands before the last are prep steps: each is awaited and a failure
   * stops the sequence. The last command is started and deliberately not
   * awaited — a dev server never exits, and waiting on it would hang forever.
   *
   * Without shell integration nothing is observable: the commands are sent as
   * text and the run reported unsupervised, mirroring `setupRun.ts`.
   */
  async runConfigured(
    record: WorkspaceRecord,
  ): Promise<{ ran: string[]; supervised: boolean; exitCode?: number }> {
    const { config } = await readWorkspaceConfig(record.worktreePath);
    if (config.run.length === 0) {
      // Nothing configured — do not open a terminal just to run nothing in it.
      return { ran: [], supervised: false };
    }
    const terminal = this.open(record);
    // Runtime check because the TerminalShellIntegration API only stabilised
    // in 1.93 while `@types/vscode` describes the newest API — same guard as
    // `setupRun.ts`, duplicated rather than exported to keep the two runners
    // uncoupled.
    const observable =
      typeof vscode.window.onDidChangeTerminalShellIntegration === "function" &&
      typeof vscode.window.onDidEndTerminalShellExecution === "function";
    const shell = observable ? await waitForShellIntegration(terminal) : undefined;
    if (!shell) {
      this.deps.output.appendLine(
        `[terminals] no shell integration for ${record.name} — running unsupervised`,
      );
      for (const command of config.run) {
        terminal.sendText(command);
      }
      return { ran: [...config.run], supervised: false };
    }
    const ran: string[] = [];
    // Everything before the last command is a prep step and must finish first.
    for (const command of config.run.slice(0, -1)) {
      ran.push(command);
      const outcome = await waitForExecution(terminal, shell.executeCommand(command));
      if (!outcome.ended) {
        // The user closed the terminal under the run: a cancellation, not a
        // failure — there is no exit code to report.
        this.deps.output.appendLine(
          `[terminals] terminal for ${record.name} closed during "${command}" — run cancelled`,
        );
        return { ran, supervised: true };
      }
      if (outcome.exitCode !== undefined && outcome.exitCode !== 0) {
        this.deps.output.appendLine(
          `[terminals] "${command}" for ${record.name} exited with ${outcome.exitCode} — stopping`,
        );
        return { ran, supervised: true, exitCode: outcome.exitCode };
      }
    }
    const server = config.run[config.run.length - 1]!;
    shell.executeCommand(server);
    ran.push(server);
    this.deps.output.appendLine(`[terminals] started "${server}" for ${record.name}`);
    return { ran, supervised: true };
  }

  /** The workspace's registered terminals that are still alive. */
  terminalsFor(workspaceId: string): vscode.Terminal[] {
    const result: vscode.Terminal[] = [];
    for (const [terminal, id] of this.registry) {
      if (id === workspaceId && terminal.exitStatus === undefined) {
        result.push(terminal);
      }
    }
    return result;
  }

  /**
   * Shell PIDs of the workspace's terminals — the roots the port scanner walks
   * the process tree down from. Deduplicated because `processId` is a promise
   * VS Code may resolve to the same PID for split terminals.
   */
  async rootPids(workspaceId: string): Promise<number[]> {
    const pids = await Promise.all(
      this.terminalsFor(workspaceId).map((terminal) => terminal.processId),
    );
    return [...new Set(pids.filter((pid): pid is number => pid !== undefined))];
  }

  dispose(): void {
    this.closeListener.dispose();
    this.emitter.dispose();
    // The terminals themselves are the user's — a running dev server must
    // survive this manager being torn down.
    this.registry.clear();
  }
}
