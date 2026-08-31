import * as path from "node:path";
import * as vscode from "vscode";
import { t } from "../l10n.ts";
import type { WorkspaceConfig, WorkspaceRecord } from "./types";

/**
 * Running a workspace's setup commands, split out of `setup.ts` so that file
 * stays importable outside the extension host.
 *
 * `vscode` is not a real package: VS Code injects it through the CommonJS
 * loader, so a dynamic `import("vscode")` — which bypasses that hook — fails at
 * runtime in the bundled extension. A static import is the only form that
 * works, and it is what makes this its own module: `setup.ts` keeps the pure
 * parsers that `node --test` imports.
 */

/**
 * How a setup run ended.
 *
 * `supervised` is false when the shell could not be instrumented: the commands
 * were sent to a terminal and nobody knows how they ended, which is neither
 * success nor failure and must not be recorded as either.
 */
export interface SetupOutcome {
  ok: boolean;
  exitCode?: number;
  supervised?: boolean;
}

/** How long to wait for shell integration before falling back to `sendText`. */
const SHELL_INTEGRATION_TIMEOUT_MS = 3000;

/**
 * Is this VS Code new enough to report shell execution results?
 *
 * The TerminalShellIntegration API only became stable in 1.93, while the
 * extension still installs on older builds; `@types/vscode` describes the
 * newest API, so nothing but a runtime check can tell. Without it every setup
 * would die on a TypeError instead of falling back.
 */
function canObserveShell(): boolean {
  return (
    typeof vscode.window.onDidChangeTerminalShellIntegration === "function" &&
    typeof vscode.window.onDidEndTerminalShellExecution === "function"
  );
}

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
 * it, which is a user cancelling the setup and must not be read as success.
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
 * Run the workspace's setup commands in a visible terminal.
 *
 * A terminal rather than a hidden child process on purpose: setup installs
 * dependencies, and that output is exactly what someone needs to see when it
 * fails. The commands are joined with `&&` so a failing step stops the rest,
 * matching what the author would have typed by hand.
 *
 * Without shell integration there is no exit code to be had, so the run is
 * reported unsupervised rather than failed: guessing "failed" would block
 * workspace creation on every shell VS Code cannot instrument.
 */
export async function runSetup(
  record: WorkspaceRecord,
  config: WorkspaceConfig,
  output: { appendLine(s: string): void },
): Promise<SetupOutcome> {
  if (config.setup.length === 0) {
    return { ok: true, supervised: true };
  }
  const commandLine = config.setup.join(" && ");
  const cwd = config.cwd ? path.resolve(record.worktreePath, config.cwd) : record.worktreePath;
  output.appendLine(`[workspace] setup for ${record.name} in ${cwd}: ${commandLine}`);

  return await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: t("Setting up workspace {0}…", record.name),
      cancellable: false,
    },
    async (): Promise<SetupOutcome> => {
      const terminal = vscode.window.createTerminal({ name: `Setup · ${record.name}`, cwd });
      // Visible but not focused — the user asked for a workspace, not a shell.
      terminal.show(true);
      const shell = canObserveShell() ? await waitForShellIntegration(terminal) : undefined;
      if (!shell) {
        output.appendLine(
          `[workspace] no shell integration for ${record.name} — running setup unsupervised`,
        );
        terminal.sendText(commandLine);
        // Said out loud, because the agent is about to start working in a tree
        // whose dependencies may still be installing — or may have failed.
        void vscode.window.showWarningMessage(
          t(
            "Setup for {0} is running without shell integration — watch its terminal, the result is unknown here.",
            record.name,
          ),
        );
        return { ok: true, supervised: false };
      }
      const outcome = await waitForExecution(terminal, shell.executeCommand(commandLine));
      if (!outcome.ended) {
        output.appendLine(`[workspace] setup terminal for ${record.name} closed before finishing`);
        return { ok: false, supervised: true };
      }
      const { exitCode } = outcome;
      output.appendLine(`[workspace] setup for ${record.name} exited with ${exitCode ?? "unknown"}`);
      return exitCode === undefined
        ? { ok: true, supervised: false }
        : { ok: exitCode === 0, exitCode, supervised: true };
    },
  );
}
