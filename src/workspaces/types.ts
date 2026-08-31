/**
 * The data shapes the workspace layer passes around: a workspace record as it
 * is persisted, and the setup script config read out of the worktree.
 *
 * This file deliberately knows nothing about `vscode` or about git. Every
 * other module in `src/workspaces/` depends on it, and the pure ones
 * (registry reconciliation, config parsing) are unit-tested outside the
 * extension host — a `vscode` import here would make that impossible.
 */

import type { ApprovalMode } from "../ompSession";

/**
 * How far the per-workspace setup script got. `skipped` is a deliberate
 * outcome (the user's policy is `never`, or they declined the prompt), not a
 * failure, so the board can show it differently from `failed`.
 */
export type WorkspaceSetupState = "pending" | "running" | "done" | "failed" | "skipped";

export interface WorkspaceRecord {
  /** Stable identity across restarts; the worktree path is not, it can move. */
  id: string;
  /** Human-readable, already sanitised to `[A-Za-z0-9._-]` by the creator. */
  name: string;
  /** The main checkout the worktree hangs off, absolute. */
  repoRoot: string;
  /** Absolute path of the linked worktree. */
  worktreePath: string;
  branch: string;
  baseRef: string;
  /**
   * The SHA `baseRef` pointed at when the workspace was created. Diffs are
   * taken against this rather than against `baseRef` itself: the base branch
   * keeps moving while the agent works, and a moving base would keep
   * re-labelling untouched files as changed.
   */
  baseSha: string;
  createdAt: number;
  /** `provider/modelId` for this workspace's own agent process. */
  model?: string;
  approvalMode?: ApprovalMode;
  /**
   * The last omp session JSONL for this workspace, so a restarted VS Code can
   * `switch_session` back into the conversation instead of starting a blank one.
   */
  sessionFile?: string;
  setupState: WorkspaceSetupState;
}

/**
 * Commands a workspace runs, read from the worktree itself so they travel with
 * the branch. `run` is recorded but not executed by Phase 1 — it is the
 * long-running dev server slot.
 */
export interface WorkspaceConfig {
  setup: string[];
  teardown: string[];
  run: string[];
  /**
   * What proves this workspace's work is sound — the command an orchestrator
   * runs before merging it. Optional rather than a list defaulting to `[]`:
   * "no verify configured" and "configured to run nothing" are different
   * answers, and only the first one may be filled in from package.json.
   */
  verify?: string[];
  /** Where to run them; relative paths resolve against the worktree root. */
  cwd?: string;
}

export interface WorkspaceCreateOptions {
  name: string;
  baseRef?: string;
  branch?: string;
  model?: string;
  approvalMode?: ApprovalMode;
  prompt?: string;
  runSetup?: boolean;
}
