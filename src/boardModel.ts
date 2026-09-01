import type {
  BoardBar,
  BoardInput,
  BoardRow,
  BoardSnapshot,
  BoardStage,
  WorkspaceStatusLike,
} from "./boardTypes";

/** Pipeline order; a running row's progress is its position in this list. */
const STAGES: readonly BoardStage[] = ["created", "working", "diffed", "verified", "merged"];

/** Bars only a person can move on — approval, question, crash, overrun. */
const HUMAN_BARS: ReadonlySet<BoardBar> = new Set(["waiting", "error", "budget"]);

/** state → bar, in precedence order: lastError, then overBudget, then state. */
function workspaceBar(ws: WorkspaceStatusLike): BoardBar {
  if (ws.lastError) {
    return "error";
  }
  if (ws.overBudget === true) {
    return "budget";
  }
  if (ws.state === "needs_input") {
    return "waiting";
  }
  if (ws.state === "no_session" || ws.state === "starting") {
    return "idle";
  }
  if (ws.state === "working") {
    return "running";
  }
  return ws.stage === "merged" ? "done" : "idle"; // state === "idle"
}

/** 0..100 from the stage index; a missing stage counts as "created". */
function workspaceProgress(bar: BoardBar, ws: WorkspaceStatusLike): number {
  if (bar === "running") {
    const index = Math.max(STAGES.indexOf(ws.stage ?? "created"), 0);
    return (index / STAGES.length) * 100;
  }
  if (bar === "idle") {
    return 0;
  }
  return 100; // done | error | waiting | budget
}
/** Percentage of workspaces that reached "merged"; 0 when there are none. */
function mergedPercent(workspaces: readonly WorkspaceStatusLike[]): number {
  if (workspaces.length === 0) {
    return 0;
  }
  const merged = workspaces.filter((ws) => ws.stage === "merged").length;
  return (merged / workspaces.length) * 100;
}

/** Wall-clock seconds since startedAt, never negative; undefined when unset. */
function elapsedSec(now: number, startedAt: number | undefined): number | undefined {
  return startedAt === undefined ? undefined : Math.max(0, (now - startedAt) / 1000);
}

/** Pure: turns live statuses into what the board draws. */
export function buildBoardSnapshot(input: BoardInput): BoardSnapshot {
  const workspaces = input.workspaces;
  const orch = input.orchestrator;
  const rows: BoardRow[] = [];

  if (orch) {
    const bar: BoardBar =
      orch.state === "working" ? "running" : orch.state === "asks" ? "waiting" : "idle";
    rows.push({
      id: orch.id,
      kind: "orchestrator",
      name: "Orchestrator",
      model: orch.model,
      bar,
      progress: mergedPercent(workspaces),
      costUsd: orch.costUsd,
      overBudget: false,
      ...(orch.startedAt !== undefined
        ? { elapsedSec: elapsedSec(input.now, orch.startedAt) }
        : {}),
      needsHuman: HUMAN_BARS.has(bar),
    });
  }

  for (const ws of workspaces) {
    const bar = workspaceBar(ws);
    rows.push({
      id: ws.id,
      kind: "workspace",
      ...(orch ? { parentId: orch.id } : {}),
      name: ws.name,
      model: ws.model,
      branch: ws.branch,
      bar,
      ...(ws.stage !== undefined ? { stage: ws.stage } : {}),
      progress: workspaceProgress(bar, ws),
      costUsd: ws.cost,
      ...(ws.costLimitUsd !== undefined
        ? { costLimitUsd: ws.costLimitUsd }
        : input.limits.perWorkspaceUsd > 0
          ? { costLimitUsd: input.limits.perWorkspaceUsd }
          : {}),
      overBudget: ws.overBudget === true,
      ...(ws.startedAt !== undefined ? { elapsedSec: elapsedSec(input.now, ws.startedAt) } : {}),
      ...(ws.lastText !== undefined ? { lastText: ws.lastText } : {}),
      ...(ws.lastError !== undefined ? { lastError: ws.lastError } : {}),
      needsHuman: HUMAN_BARS.has(bar),
    });
  }

  const totalCostUsd =
    (orch?.costUsd ?? 0) + workspaces.reduce((sum, ws) => sum + ws.cost, 0);
  const sessionLimitUsd =
    input.limits.perSessionUsd > 0 ? input.limits.perSessionUsd : undefined;

  return {
    rows,
    totalCostUsd,
    ...(sessionLimitUsd !== undefined ? { sessionLimitUsd } : {}),
    overSessionBudget: sessionLimitUsd !== undefined && totalCostUsd >= sessionLimitUsd,
    counts: {
      running: rows.filter((r) => r.bar === "running").length,
      done: rows.filter((r) => r.bar === "done").length,
      error: rows.filter((r) => r.bar === "error").length,
      waiting: rows.filter((r) => r.bar === "waiting").length,
    },
  };
}
