import type { BoardInput, BoardSnapshot } from "./boardTypes";

/** Pure: turns live statuses into what the board draws. Replaced by the real implementation. */
export function buildBoardSnapshot(input: BoardInput): BoardSnapshot {
  return {
    rows: [],
    totalCostUsd: 0,
    sessionLimitUsd: input.limits.perSessionUsd || undefined,
    overSessionBudget: false,
    counts: { running: 0, done: 0, error: 0, waiting: 0 },
  };
}
