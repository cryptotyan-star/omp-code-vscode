/**
 * The pure arithmetic under the orchestrator's cost guard: is a budget spent,
 * and what has the whole session cost so far.
 *
 * Deliberately without `vscode`, without the orchestrator and without I/O:
 * the limits arrive from settings through callbacks, the costs from live
 * sessions, and this file only decides what the numbers mean. That is also
 * why it is unit-tested on its own.
 */

/** What a budget check concluded. */
export interface BudgetEvaluation {
  /** True once the cost has reached (or passed) the limit. */
  over: boolean;
  /** Dollars left before the limit; `Infinity` when the limit is off. */
  remainingUsd: number;
}

/**
 * Compare a spend against a limit.
 *
 * A `limitUsd` of 0 — the settings' default — means the limit is *off*:
 * nothing is ever over it, and what remains is `Infinity` rather than a
 * number that could be shown as "zero left". A negative limit is treated the
 * same way; the setting cannot go below 0, but a callback might.
 *
 * The boundary itself is over: a workspace allowed to spend its last cent
 * would start the next turn that pushes past the limit, so `cost == limit`
 * already stops it.
 */
export function evaluateBudget({ costUsd, limitUsd }: { costUsd: number; limitUsd: number }): BudgetEvaluation {
  if (!(limitUsd > 0)) {
    return { over: false, remainingUsd: Infinity };
  }
  return { over: costUsd >= limitUsd, remainingUsd: Math.max(0, limitUsd - costUsd) };
}

/**
 * What a whole session has spent: the orchestrator's own chat plus every
 * workspace's agent. `workspaces` accepts anything carrying a `cost`, so the
 * orchestrator can pass statuses without this file knowing their shape.
 */
export function sessionTotal(orchestratorUsd: number, workspaces: Array<{ cost: number }>): number {
  let total = orchestratorUsd;
  for (const workspace of workspaces) {
    total += workspace.cost;
  }
  return total;
}
