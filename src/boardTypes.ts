/** Colour of the stripe along the top edge of a board row. */
export type BoardBar = "running" | "done" | "error" | "waiting" | "idle" | "budget";
/** Where a workspace is in the orchestration pipeline. */
export type BoardStage = "created" | "working" | "diffed" | "verified" | "merged";

export interface BoardRow {
  id: string;
  kind: "orchestrator" | "workspace";
  parentId?: string;
  name: string;
  /** provider/modelId */
  model: string;
  branch?: string;
  bar: BoardBar;
  stage?: BoardStage;
  /** 0..100, stage-based for running rows; 100 for done/error/waiting. */
  progress: number;
  costUsd: number;
  costLimitUsd?: number;
  overBudget: boolean;
  elapsedSec?: number;
  lastText?: string;
  lastError?: string;
  /** True when only a person can move this row on (approval, question, error). */
  needsHuman: boolean;
}

export interface BoardSnapshot {
  rows: BoardRow[];
  totalCostUsd: number;
  sessionLimitUsd?: number;
  overSessionBudget: boolean;
  /**
   * Workspace rows only. `merged` counts the pipeline's last stage rather than
   * a bar, so every surface reports the same "N of M merged" instead of each
   * recomputing it from `rows` and drifting.
   */
  counts: { running: number; done: number; error: number; waiting: number; merged: number };
}

/** The subset of a workspace status the board needs; orchestrator.ts's WorkspaceStatus satisfies it. */
export interface WorkspaceStatusLike {
  id: string;
  name: string;
  branch: string;
  model: string;
  state: "starting" | "working" | "needs_input" | "idle" | "no_session";
  cost: number;
  setupState: string;
  stage?: BoardStage;
  startedAt?: number;
  costLimitUsd?: number;
  overBudget?: boolean;
  lastText?: string;
  lastError?: string;
}

export interface BoardInput {
  orchestrator?: {
    id: string;
    /** What to call the row; board.mjs appends the translated role suffix. */
    name?: string;
    model: string;
    costUsd: number;
    state: "starting" | "asks" | "working" | "idle";
    startedAt?: number;
  };
  workspaces: WorkspaceStatusLike[];
  limits: { perWorkspaceUsd: number; perSessionUsd: number };
  now: number;
}

export type BoardToHost =
  | { t: "ready" }
  | { t: "reveal"; id: string }
  | { t: "stop"; id: string }
  | { t: "delete"; id: string }
  /** A line typed into the board panel's composer, addressed at one workspace. */
  | { t: "prompt"; id: string; text: string };

export type HostToBoard = { t: "board"; snapshot: BoardSnapshot };
