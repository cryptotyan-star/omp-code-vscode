/**
 * The orchestration facade: one object that knows what "create a workspace",
 * "wait for it", "look at what it did" and "land it" mean.
 *
 * Everything above this file is a thin shell. `hostTools.ts` turns model
 * arguments into these calls and their results into prose; the tree views call
 * the same methods. Every rule that decides an outcome — when a wait is
 * finished, when a delete is allowed, how much of a diff a model may see —
 * lives here, once, so the host tools and the UI can never disagree about it.
 *
 * Two deliberate constraints:
 *
 *  - **No `vscode` import, not even a lazy one.** The contract allows it, but
 *    the wait loop and the state mapping are exactly the parts that have to be
 *    tested, and `node --test` cannot load a module that reaches for the
 *    extension host. Everything host-shaped (the board's change event, the
 *    workspace ceiling from settings) arrives through {@link OrchestratorDeps}
 *    instead. `OmpSession` is imported type-only, which erases at build time.
 *
 *  - **No timer polling.** `wait` sleeps on the board's change event and on the
 *    registry's, and wakes only when something actually moved. The only timers
 *    are the deadline itself and nothing else; a twelve-hour run must not cost
 *    a git subprocess every second.
 *
 * Text produced here is English and does not go through `t()`. Its reader is a
 * language model calling a host tool, not a person reading the UI — a Russian
 * error message inside a tool result is noise the model has to work around.
 */

import { workspaceDiff, fileDiff, type WorkspaceDiff } from "./workspaces/diff.ts";
import { samePath } from "./workspaces/git.ts";
import { mergeWorkspace, preflight, type MergeResult, type MergeStrategy } from "./workspaces/merge.ts";
import { detectVerifyCommand, runVerify, type VerifyResult } from "./workspaces/verify.ts";
import { evaluateBudget, sessionTotal } from "./costGuard.ts";
import type { WorkspaceManager } from "./workspaces/manager";
import type { WorkspaceRecord } from "./workspaces/types";
import type { ApprovalMode, OmpSession } from "./ompSession";
import type { BoardStage } from "./boardTypes";

/**
 * What a workspace is doing right now, as an orchestrating model needs to see
 * it.
 *
 * `needs_input` is the load-bearing one: an agent that stopped to ask a
 * question never becomes idle on its own, so without a name of its own it
 * would read as "still working" and an unattended run would sit on it until
 * the deadline. `no_session` means there is no omp process behind the
 * workspace at all — its chat was closed, or it never opened. It is a settled
 * state, not a transient one: waiting for it to change would wait forever.
 */
export type WorkspaceState = "starting" | "working" | "needs_input" | "idle" | "no_session";

export interface WorkspaceStatus {
  id: string;
  name: string;
  branch: string;
  /**
   * Absolute path of the worktree. Reported because it is the only way the
   * model can name this checkout to anything outside these tools — a follow-up
   * prompt, a verify command, a shell of its own.
   */
  worktreePath: string;
  /** `provider/modelId`, from the workspace's pin or from its live session. */
  model: string;
  state: WorkspaceState;
  /** Dollars this workspace's session has spent, 0 when it has no session. */
  cost: number;
  /**
   * Diff totals against the pinned base SHA. Zero when the caller did not ask
   * for them — measuring costs three git invocations per workspace, and the
   * wait loop refreshes statuses on every board event.
   */
  added: number;
  deleted: number;
  files: number;
  /**
   * Whether this workspace would merge cleanly, and what collides if not.
   * Computed only when asked for: it runs `git merge-tree` against the base,
   * which is far too expensive for a listing.
   */
  mergeable?: boolean;
  conflicts?: string[];
  setupState: string;
  /** Tail of the agent's last reply, one line, at most {@link LAST_TEXT_CHARS}. */
  lastText?: string;
  /** How far this workspace is through the pipeline; see {@link BoardStage}. */
  stage?: BoardStage;
  /** When this workspace's agent was started, epoch ms. */
  startedAt?: number;
  /** The per-workspace limit this row is held to, in dollars. */
  costLimitUsd?: number;
  /** True once the workspace has spent its per-workspace limit. */
  overBudget?: boolean;
  /** What the last call into this workspace failed on, when it did. */
  lastError?: string;
}

export interface OrchestratorDeps {
  manager: WorkspaceManager;
  /** The live omp session driving this workspace, when one is open. */
  sessionFor(workspaceId: string): OmpSession | undefined;
  repoRoot(): Promise<string | undefined>;
  output: { appendLine(s: string): void };
  /**
   * Fires whenever any session's board-visible state may have moved — this is
   * `OmpSession.onBoardChange`, handed in rather than imported.
   *
   * Not in the original contract, and the one place this file deviates from
   * it. Reaching the static directly would pull `ompSession` — and with it
   * `vscode` — into this module's runtime graph, which would make
   * `test/orchestrator.test.ts` unloadable; and the alternative, a polling
   * timer, is exactly what the contract forbids. So the event comes in as a
   * dependency, which is also what lets the tests drive the wait loop by hand.
   *
   * Optional so a host that forgets it still gets a working orchestrator:
   * `wait` then falls back to the registry's own change event, which sees
   * creates and deletes but not an agent going idle, and says so in the output
   * channel once.
   */
  onBoardChange?(listener: () => void): { dispose(): void };
  /**
   * The `ompcode.orchestratorMaxWorkspaces` ceiling. Read through a callback
   * rather than from settings directly, both to keep `vscode` out of here and
   * because the value has to be re-read on every `create` — the user may raise
   * it in the middle of a run precisely because a create just refused.
   */
  maxWorkspaces?(): number;
  /**
   * The `ompcode.workspaceSetup` policy. The manager honours an explicit
   * `runSetup` flag ahead of it, which is correct for a human who just ticked
   * the box and wrong for a model that asked: an operator who set "never"
   * opted out of running repository-defined shell commands, and a tool
   * argument must not be able to opt back in for them.
   */
  setupPolicy?(): "auto" | "ask" | "never";
  /**
   * The `ompcode.costLimitPerWorkspaceUsd` and
   * `ompcode.costLimitPerSessionUsd` caps. Read through a callback like the
   * two settings above, and re-read on every refresh: the human raising a
   * limit in the middle of a run — precisely because one just refused — must
   * take effect without reloading. A value of 0 or below means that limit is
   * off; a missing callback means no limits at all.
   */
  costLimits?(): { perWorkspaceUsd: number; perSessionUsd: number };
  /**
   * The orchestrator's own session cost in dollars, the other half of the
   * session total. A missing callback counts as zero.
   */
  sessionCostUsd?(): number;
  /**
   * Called exactly once per workspace the first time it is seen at or past
   * its per-workspace limit, so its agent stops spending while the
   * orchestrating model decides what to do.
   */
  abortTurn?(workspaceId: string): void;
}

/** Fallback for `ompcode.orchestratorMaxWorkspaces`; mirrors the package.json default. */
const DEFAULT_MAX_WORKSPACES = 5;
const MIN_MAX_WORKSPACES = 1;
const MAX_MAX_WORKSPACES = 20;

/** Upper bound on `WorkspaceStatus.lastText`; it is a column, not a transcript. */
const LAST_TEXT_CHARS = 400;

/** Default byte budget for the assembled diff text of a whole workspace. */
const DEFAULT_DIFF_BYTES = 60_000;

/**
 * Hard ceiling on a requested diff budget.
 *
 * The number comes from a model, and asking for half a gigabyte is one typo
 * away: that would concatenate the whole patch into a single string in the
 * extension host and then push it through the RPC transport. Clamped here
 * rather than only in the tool schema, because this file is where the limits
 * that decide an outcome live — the UI calls the same method.
 */
const MAX_DIFF_BYTES = 200_000;

/** Never spend more than this on progress callbacks; the contract's floor. */
const PROGRESS_INTERVAL_MS = 5_000;

/**
 * How `fileDiff` marks a diff it had to cut. Matched rather than recomputed:
 * the truncation happens inside `diff.ts` on a line boundary it alone knows,
 * and duplicating the byte arithmetic here would drift from it.
 */
const TRUNCATION_MARKER = /\*\*\* diff truncated at \d+ of \d+ bytes \*\*\*/;

/** Pipeline stages only move forward; this is the order they move in. */
const STAGE_ORDER: Record<BoardStage, number> = {
  created: 0,
  working: 1,
  diffed: 2,
  verified: 3,
  merged: 4,
};

/** Dollars for error messages and log lines; two decimals, always. */
function dollars(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

/**
 * States from which a workspace will not move on its own.
 *
 * `needs_input` counts as settled on purpose: the agent is blocked on a
 * question, so "wait until idle" would be a guaranteed timeout. The caller
 * finds out which kind of settled it is by reading the returned statuses.
 */
function isSettled(state: WorkspaceState): boolean {
  return state === "idle" || state === "needs_input" || state === "no_session";
}

export class Orchestrator {
  private readonly deps: OrchestratorDeps;
  /** Logged at most once; a missing board event degrades `wait`, silently otherwise. */
  private warnedNoBoardEvent = false;
  /**
   * Creates run one at a time, in arrival order.
   *
   * The host tool bridge answers calls concurrently on purpose, and the
   * instruction file tells the model to fan out — so three `workspace_create`
   * frames from one turn all read the workspace count before any of them has
   * added a row, and the ceiling is walked straight past into N checkouts and
   * N metered agents. The manager's own repo lock cannot help: it is taken
   * inside `create`, after the count was already read here.
   *
   * Races this chain settles, and why none of them needs more machinery:
   *
   * - Reentrancy is impossible by construction. `createOne` touches only
   *   {@link OrchestratorDeps} members — `repoRoot`, `manager`, `setupPolicy`,
   *   `output` — and none of them call back into this class, so nothing a
   *   create starts can queue another create before the first has finished.
   *   The fresh workspace's agent talks to *its own* bridge, not this one.
   * - Double-start of the same name is two links on this chain, so the second
   *   reads `manager.list()` only after the first's checkout exists and the
   *   manager rejects the duplicate branch. The rejection unwedges the chain
   *   (see `create`), so a third, differently-named create still runs.
   * - Bridge teardown mid-create cancels the *report*, not the work: `create`
   *   takes no abort signal, so an `abortAll` during a checkout leaves the
   *   checkout to finish and the workspace to land on the board. The cancel
   *   text already tells the model exactly that, and `workspace_list` shows
   *   the result.
   * - A create that never settles wedges the chain, on purpose: anything that
   *   could unblock it (a manager timeout, a git failure) rejects eventually,
   *   and refusing to start an *unknown* number of creates behind one that
   *   hangs is the safe side of that trade.
   */
  private createChain: Promise<unknown> = Promise.resolve();

  /**
   * Pipeline stage per workspace id, and when each one's agent was started.
   * In memory only — the registry persists identity, not progress: a stage
   * that survived a restart would read as truth when the diff, verify or
   * merge behind it happened under a different facade.
   */
  private readonly stages = new Map<string, BoardStage>();
  private readonly startedAt = new Map<string, number>();
  /** Ids already aborted for overspending; `abortTurn` fires once per workspace. */
  private readonly budgetAborted = new Set<string>();

  // Assigned in the body rather than as a parameter property: `node --test`
  // strips types without transforming and rejects parameter properties, and
  // this module has to stay directly runnable there.
  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
  }

  /**
   * Cut a new workspace and set it working.
   *
   * The ceiling is checked before anything is created, and counts only this
   * repository's workspaces: a second checkout's rows are on the same board
   * but cost this repo nothing.
   */
  async create(a: {
    name: string;
    prompt: string;
    model?: string;
    baseRef?: string;
    approvalMode?: ApprovalMode;
    runSetup?: boolean;
  }): Promise<WorkspaceStatus> {
    // Queued behind whatever create is in flight, so the ceiling check and the
    // checkout that follows it are one critical section. The chain keeps
    // running after a failed link: one refused create must not wedge the next.
    const run = this.createChain.then(() => this.createOne(a));
    this.createChain = run.catch(() => undefined);
    return await run;
  }

  private async createOne(a: {
    name: string;
    prompt: string;
    model?: string;
    baseRef?: string;
    approvalMode?: ApprovalMode;
    runSetup?: boolean;
  }): Promise<WorkspaceStatus> {
    const name = a.name.trim();
    if (!name) {
      throw new Error("A workspace needs a name; pass a short kebab-case one, such as auth-jwt.");
    }
    const prompt = a.prompt.trim();
    if (!prompt) {
      throw new Error(
        "A workspace needs an opening prompt describing the whole task; it is the only instruction the worker gets to start from.",
      );
    }

    // Before any git work: a session past its budget starts nothing new.
    this.assertSessionBudget();
    const repoRoot = await this.deps.repoRoot();
    if (!repoRoot) {
      throw new Error("No git repository is open, so there is nothing to create a worktree from.");
    }

    const limit = this.maxWorkspaces();
    const mine = this.deps.manager.list().filter((record) => samePath(record.repoRoot, repoRoot));
    if (mine.length >= limit) {
      // Named limit, named setting, named way out: a model that is only told
      // "refused" will retry the same call until the turn dies.
      throw new Error(
        `Workspace limit reached: ${mine.length} of ${limit} allowed. Merge or delete one with workspace_delete, or raise the ompcode.orchestratorMaxWorkspaces setting.`,
      );
    }

    // A worker nobody is watching cannot answer a modal approval dialog: the
    // only thing that clears one is a human clicking it in that workspace's
    // own chat. Inheriting the window's `always-ask` would deadlock the
    // workspace on its first edit, with no host tool able to unblock it — so
    // an unspecified tier means the unattended one, not the window default.
    const approvalMode: ApprovalMode = a.approvalMode ?? "yolo";

    // The user's policy outranks the model's flag. `runSetup: true` is passed
    // through as "explicit" and the manager honours explicit ahead of policy,
    // which would let a tool argument run repository-defined shell commands
    // for someone who set "never".
    const policy = this.deps.setupPolicy?.();
    const setupRefused = a.runSetup === true && policy === "never";
    const runSetup = setupRefused ? false : a.runSetup;

    const record = await this.deps.manager.create(repoRoot, {
      name,
      prompt,
      model: a.model?.trim() || undefined,
      baseRef: a.baseRef?.trim() || undefined,
      approvalMode,
      runSetup,
    });
    this.deps.output.appendLine(
      `[omp] orchestrator: created ${record.name} on ${record.branch} (${record.model ?? "the default model"})`,
    );
    if (setupRefused) {
      this.deps.output.appendLine(
        `[omp] orchestrator: setup skipped for ${record.name} — ompcode.workspaceSetup is "never"`,
      );
    }
    // The first step of the pipeline is having been created.
    this.stages.set(record.id, "created");
    this.startedAt.set(record.id, Date.now());
    return await this.statusOf(record);
  }

  /**
   * Every workspace on the board. Diff totals are measured only on request —
   * see {@link WorkspaceStatus.added}.
   */
  async list(a?: { withDiff?: boolean }): Promise<WorkspaceStatus[]> {
    const records = this.deps.manager.list();
    return await Promise.all(
      // `withDiff` buys the merge probe as well as the churn numbers: the tool
      // description promises both, and the one moment a model asks for it is
      // when it is choosing a winner — which is a question about conflicts,
      // not about line counts. Both are best-effort inside `statusOf`.
      records.map((record) =>
        this.statusOf(record, { diff: a?.withDiff === true, merge: a?.withDiff === true }),
      ),
    );
  }

  /**
   * Say something to a workspace's agent.
   *
   * A workspace whose chat was closed is reopened rather than refused: over a
   * long run a tab gets closed by hand or by a reload, and the orchestrator
   * losing the ability to talk to a branch it created is a far worse outcome
   * than an unexpected tab.
   */
  async prompt(a: {
    id: string;
    message: string;
    mode?: "prompt" | "steer" | "follow_up";
  }): Promise<WorkspaceStatus> {
    const record = this.require(a.id);
    const message = a.message.trim();
    if (!message) {
      throw new Error("The message is empty; there is nothing to send.");
    }

    // The cost gate comes before the session is even touched: a spent
    // workspace must not be reopened only to be refused afterwards.
    const budget = this.budgetOf(record, this.deps.sessionFor(record.id)?.snapshot().cost ?? 0);
    if (budget.over) {
      throw new Error(budget.message);
    }
    this.assertSessionBudget();
    const session = await this.ensureSession(record);
    // A workspace in `needs_input` is blocked inside a tool call on a modal
    // approval dialog. Nothing sent from here can clear it — the only thing
    // that does is a human answering that dialog in the workspace's own chat
    // (or through Remote Control) — so a prompt would queue behind a block
    // that never lifts, and the model would believe it had unblocked a worker
    // that is still frozen. Refused loudly instead, with the two real ways out.
    if (this.stateOf(record) === "needs_input") {
      throw new Error(
        `${record.name} is blocked on an approval dialog in its own chat, which only a person can answer; a prompt would queue behind it and never be read. Ask the human to answer it in the ${record.name} tab, or delete this workspace and create it again with approvalMode="yolo" so it never stops to ask.`,
      );
    }
    await session.sendPrompt(message, a.mode ?? "prompt");
    this.deps.output.appendLine(
      `[omp] orchestrator: ${a.mode ?? "prompt"} → ${record.name} (${message.length} chars)`,
    );
    return this.statusOf(record);
  }

  /**
   * Block until the workspaces reach the state the caller is waiting for, or
   * until the deadline — whichever comes first. Never throws on either.
   *
   * `until` semantics, spelled out because they are not symmetric:
   *
   *  - `idle` — **all** targets are settled (idle, needs_input or no_session).
   *    "Every worker has stopped."
   *  - `needs_input` — **any** target is blocked on a question. This is the
   *    interrupt: the run should come back to the orchestrator at once rather
   *    than let one worker sit on a prompt for an hour.
   *  - `any` — **any** target is settled. "Give me the first one that finished."
   *
   * A timeout is a normal outcome and is reported as `timedOut: true` with
   * live statuses, never as a failure — the caller's job is to look at the
   * statuses and call again.
   */
  async wait(a: {
    ids?: string[];
    until?: "idle" | "needs_input" | "any";
    timeoutMs: number;
    onProgress?: (s: WorkspaceStatus[]) => void;
    signal?: AbortSignal;
  }): Promise<{ statuses: WorkspaceStatus[]; timedOut: boolean; unknownIds: string[]; reason?: "over_budget" }> {
    const until = a.until ?? "idle";
    const { ids, unknown } = this.resolveWaitIds(a.ids);

    // A session past its budget has nothing a wait can resolve: return at
    // once instead of blocking, and say so — nothing should spend more.
    const sessionLimit = this.sessionLimitUsd();
    if (sessionLimit > 0 && this.sessionCostUsd() >= sessionLimit) {
      return {
        statuses: await this.richStatuses(ids),
        timedOut: false,
        unknownIds: unknown,
        reason: "over_budget",
      };
    }

    // Read straight from the manager on every check: a workspace deleted while
    // we wait must drop out of the predicate rather than keep it unsatisfiable.
    const records = (): WorkspaceRecord[] => {
      const out: WorkspaceRecord[] = [];
      for (const id of ids) {
        const record = this.deps.manager.get(id);
        if (record) {
          out.push(record);
        }
      }
      return out;
    };

    const ready = (): boolean => {
      const states = records().map((record) => this.stateOf(record));
      if (states.length === 0) {
        // Nothing left to wait for — every target was deleted, or there were
        // none. Reporting a timeout here would be a lie.
        return true;
      }
      if (until === "needs_input") {
        return states.some((state) => state === "needs_input");
      }
      if (until === "any") {
        return states.some(isSettled);
      }
      return states.every(isSettled);
    };

    const timedOut = ready() ? false : await this.waitForEvent(ids, ready, a);
    return { statuses: await this.richStatuses(ids), timedOut, unknownIds: unknown };
  }

  /**
   * What a workspace changed, as statistics plus (optionally) the patch text.
   *
   * The order is the contract's, and it is the reason this method exists at
   * all: statistics and mergeability are computed first and are never trimmed,
   * so a model looking at a 400-file workspace still learns the file list and
   * whether it conflicts, even when not one hunk fits in the budget.
   */
  async diff(a: {
    id: string;
    path?: string;
    statOnly?: boolean;
    maxBytes?: number;
  }): Promise<{ status: WorkspaceStatus; text?: string; truncated: boolean }> {
    const record = this.require(a.id);
    const changes = await workspaceDiff(record.worktreePath, record.baseSha);
    this.advanceStage(record.id, "diffed");
    const status = await this.statusOf(record, { diff: changes, merge: true });
    if (a.statOnly === true) {
      return { status, truncated: false };
    }

    // `Number.isFinite` rather than `??`: the value comes from a model, and a
    // NaN would survive both the floor and the ceiling below as NaN.
    const asked = Number.isFinite(a.maxBytes) ? Math.round(a.maxBytes as number) : DEFAULT_DIFF_BYTES;
    const maxBytes = Math.min(MAX_DIFF_BYTES, Math.max(1, asked));
    if (a.path) {
      const text = await fileDiff(record.worktreePath, record.baseSha, a.path, { maxBytes });
      return { status, text, truncated: TRUNCATION_MARKER.test(text) };
    }

    const { text, truncated } = await this.assembleDiff(record, changes, maxBytes);
    return { status, text, truncated };
  }

  /**
   * Run the workspace's own proof — its tests, its build, whatever the repo
   * declares. The gate an orchestrator is expected to pass before merging.
   */
  async verify(a: {
    id: string;
    command?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<VerifyResult> {
    const record = this.require(a.id);
    const command = a.command?.trim() || (await detectVerifyCommand(record.worktreePath));
    if (!command) {
      // Refused rather than guessed. Inventing `npm test` in a repo that has no
      // test script produces a red result that means nothing, and a model that
      // sees red stops merging work that was fine.
      // No `command="..."` hint any more: the host tool deliberately refuses a
      // model-composed shell line, so pointing the model at one would send it
      // into a call that can only be rejected. A named npm script is the only
      // override it can actually make, and if the repo declares none, the
      // honest answer is that a human has to say what proves this work.
      throw new Error(
        `No verify command is configured for ${record.name}: there is no "verify" in .ompcode/workspace.json and no test, check or build script in package.json. Name one of that workspace's own npm scripts with script="...", or ask the human what proves this work.`,
      );
    }
    this.deps.output.appendLine(`[omp] orchestrator: verify ${record.name}: ${command}`);
    const result = await runVerify(record.worktreePath, command, {
      timeoutMs: a.timeoutMs,
      signal: a.signal,
    });
    this.deps.output.appendLine(
      `[omp] orchestrator: verify ${record.name} → ${result.ok ? "ok" : "failed"} (exit ${String(result.exitCode)}${result.timedOut ? ", timed out" : ""})`,
    );
    if (result.ok) {
      this.advanceStage(record.id, "verified");
    }
    return result;
  }

  /**
   * Land a workspace on its base branch. The whole decision — preflight,
   * consent, rollback — belongs to `mergeWorkspace`; this only supplies the
   * record's fields and records the outcome.
   */
  async merge(a: {
    id: string;
    strategy?: MergeStrategy;
    force?: boolean;
    commitMessage?: string;
  }): Promise<MergeResult> {
    const record = this.require(a.id);
    const result = await mergeWorkspace({
      repoRoot: record.repoRoot,
      worktreePath: record.worktreePath,
      branch: record.branch,
      baseRef: record.baseRef,
      baseSha: record.baseSha,
      strategy: a.strategy ?? "merge",
      commitMessage: a.commitMessage,
      force: a.force,
    });
    this.deps.output.appendLine(
      `[omp] orchestrator: merge ${record.name} → ${result.merged ? "merged" : "refused"}: ${result.message}`,
    );
    if (result.merged) {
      this.advanceStage(record.id, "merged");
    }
    return result;
  }

  /**
   * Throw a workspace away.
   *
   * The gate is here rather than in the manager because the manager's gate is
   * a modal dialog: it asks the user to confirm the loss. In an unattended run
   * — the whole point of this layer — nobody is there to answer, and the call
   * would hang until the operator came back. So the risk is measured here, a
   * refusal is returned to the model as an error it can act on, and the
   * manager is then always called with `force` so it never opens the dialog.
   */
  async remove(a: { id: string; deleteBranch?: boolean; force?: boolean }): Promise<void> {
    const record = this.require(a.id);
    if (a.force !== true) {
      // Before the git question, because git cannot answer this one: an agent
      // that is thinking, reading files or on its first tool call has written
      // nothing yet, so it is `ahead: 0` on a clean worktree and would be
      // deleted — process and all — as if it were an empty leftover. In a
      // "merge the winner, delete the rest" sweep that silently kills the
      // candidate that merely started slower.
      const state = this.stateOf(record);
      if (state === "working" || state === "starting") {
        throw new Error(
          `${record.name} is still ${state}: its agent is mid-turn and may not have written anything to disk yet. Wait for it with workspace_wait, or call workspace_delete with force=true to stop it and throw the work away.`,
        );
      }
      const pre = await preflight({
        repoRoot: record.repoRoot,
        worktreePath: record.worktreePath,
        branch: record.branch,
        baseRef: record.baseRef,
        baseSha: record.baseSha,
      }).catch(() => undefined);
      if (!pre) {
        throw new Error(
          `Could not read the state of ${record.name}, so it may still hold unmerged work. Call workspace_delete with force=true to delete it anyway.`,
        );
      }
      if (pre.ahead > 0 || pre.worktreeDirty) {
        const parts: string[] = [];
        if (pre.ahead > 0) {
          parts.push(`${pre.ahead} commit(s) not on ${record.baseRef}`);
        }
        if (pre.worktreeDirty) {
          parts.push("uncommitted changes in its worktree");
        }
        throw new Error(
          `${record.name} still has unmerged work: ${parts.join(" and ")}. Merge it with workspace_merge first, or call workspace_delete with force=true to throw the work away.`,
        );
      }
    }
    // Always forced past this point: the question the manager would ask has
    // already been answered above, and a modal in an unattended run is a hang.
    await this.deps.manager.remove(record.id, { deleteBranch: a.deleteBranch, force: true });
    this.deps.output.appendLine(`[omp] orchestrator: deleted ${record.name}`);
    // Forget its in-memory progress: a recycled id must not re-enter the
    // board carrying a stage, a start time or a spent-abort from before.
    this.stages.delete(record.id);
    this.startedAt.delete(record.id);
    this.budgetAborted.delete(record.id);
  }

  // ---------------------------------------------------------------- internals

  private require(id: string): WorkspaceRecord {
    const record = this.deps.manager.get(id);
    if (!record) {
      throw new Error(`There is no workspace with id ${id}. Call workspace_list for current ids.`);
    }
    return record;
  }

  private maxWorkspaces(): number {
    const raw = this.deps.maxWorkspaces?.();
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      return DEFAULT_MAX_WORKSPACES;
    }
    // Clamped rather than trusted: the setting is user-editable JSON, and a 0
    // there would make every create refuse with no way to see why.
    return Math.min(MAX_MAX_WORKSPACES, Math.max(MIN_MAX_WORKSPACES, Math.floor(raw)));
  }

  /**
   * The two budget caps, re-read on every use and clamped to "off" when
   * absent or nonsense: a mis-typed setting must degrade to no limit, not
   * to everything refusing.
   */
  private costLimits(): { perWorkspaceUsd: number; perSessionUsd: number } {
    const raw = this.deps.costLimits?.();
    const limit = (value: unknown): number =>
      typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
    return { perWorkspaceUsd: limit(raw?.perWorkspaceUsd), perSessionUsd: limit(raw?.perSessionUsd) };
  }

  /** The session-wide cap in dollars; 0 means the limit is off. */
  sessionLimitUsd(): number {
    return this.costLimits().perSessionUsd;
  }

  /**
   * What the whole session has spent: the orchestrator's own chat (through
   * the callback, 0 when the host wires none) plus every workspace.
   */
  sessionCostUsd(): number {
    return sessionTotal(
      this.deps.sessionCostUsd?.() ?? 0,
      this.deps.manager.list().map((record) => ({
        cost: this.deps.sessionFor(record.id)?.snapshot().cost ?? 0,
      })),
    );
  }

  /** The session spend and cap, for tool output; a 0 limit means off. */
  sessionBudget(): { costUsd: number; limitUsd: number } {
    return { costUsd: this.sessionCostUsd(), limitUsd: this.sessionLimitUsd() };
  }

  /**
   * Refuse a create or a prompt with the numbers in the message: a model
   * told only "over budget" would retry the same call until the turn dies.
   */
  private assertSessionBudget(): void {
    const limit = this.sessionLimitUsd();
    if (limit <= 0) {
      return;
    }
    const total = this.sessionCostUsd();
    if (total >= limit) {
      throw new Error(
        `The session has spent ${dollars(total)} of its ${dollars(limit)} cost limit, so no workspace work is started or sent. ` +
          "Report the run to the human and wait; the limit is the ompcode.costLimitPerSessionUsd setting, and retrying does not lower the total.",
      );
    }
  }

  /**
   * The per-workspace verdict on one cost reading, plus the one-shot abort:
   * the first refresh that sees a workspace at its limit stops its agent,
   * and every later one only reports.
   */
  private budgetOf(
    record: WorkspaceRecord,
    costUsd: number,
  ): { over: boolean; limitUsd: number; message: string } {
    const limitUsd = this.costLimits().perWorkspaceUsd;
    const { over } = evaluateBudget({ costUsd, limitUsd });
    if (!over) {
      return { over: false, limitUsd, message: "" };
    }
    if (!this.budgetAborted.has(record.id)) {
      this.budgetAborted.add(record.id);
      this.deps.abortTurn?.(record.id);
      this.deps.output.appendLine(
        `[omp] orchestrator: ${record.name} is over its cost limit (${dollars(costUsd)} of ${dollars(limitUsd)})`,
      );
    }
    return {
      over: true,
      limitUsd,
      message: `workspace ${record.name} spent ${dollars(costUsd)} of its ${dollars(limitUsd)} limit; raise ompcode.costLimitPerWorkspaceUsd or delete the workspace`,
    };
  }

  /** Stages only advance: a re-run diff cannot demote a merged workspace. */
  private advanceStage(id: string, stage: BoardStage): void {
    const current = this.stages.get(id);
    if (current === undefined || STAGE_ORDER[stage] > STAGE_ORDER[current]) {
      this.stages.set(id, stage);
    }
  }

  /**
   * The board's four statuses, mapped onto the five this layer publishes.
   * Cheap by construction — a field read on a live object, no subprocess and
   * no RPC — because the wait loop calls it on every board event.
   */
  private stateOf(record: WorkspaceRecord): WorkspaceState {
    const session = this.deps.sessionFor(record.id);
    if (!session) {
      return "no_session";
    }
    const info = session.snapshot();
    switch (info.status) {
      case "asks":
        return "needs_input";
      case "working":
        return "working";
      case "starting":
        return "starting";
      default:
        // `status` turns "working" only when the agent's first frame of a turn
        // arrives — a round trip after the prompt was handed over, and a whole
        // handshake after `workspace_create`. `pending` covers that gap. Read
        // as "idle" it would mean "this worker has stopped", which is the one
        // lie that breaks every wait: the orchestrator would go read an empty
        // diff of a workspace whose agent has not spoken yet.
        return info.pending ? "working" : "idle";
    }
  }

  private async ensureSession(record: WorkspaceRecord): Promise<OmpSession> {
    const existing = this.deps.sessionFor(record.id);
    if (existing) {
      return existing;
    }
    await this.deps.manager.reopen(record.id);
    const reopened = this.deps.sessionFor(record.id);
    if (!reopened) {
      throw new Error(
        `${record.name} has no running agent and its chat could not be reopened; check the omp output channel.`,
      );
    }
    return reopened;
  }

  /**
   * Build a status row.
   *
   * `opts.diff` takes either `true` (measure now) or an already-measured
   * {@link WorkspaceDiff}, so `diff()` — which needs the file list anyway —
   * does not pay for a second measurement to fill in the same three numbers.
   */
  private async statusOf(
    record: WorkspaceRecord,
    opts?: { diff?: boolean | WorkspaceDiff; merge?: boolean; text?: boolean },
  ): Promise<WorkspaceStatus> {
    const session = this.deps.sessionFor(record.id);
    const info = session?.snapshot();
    const status: WorkspaceStatus = {
      id: record.id,
      name: record.name,
      branch: record.branch,
      worktreePath: record.worktreePath,
      // The pin first: it is what the process was actually spawned with. The
      // live session's own model is the fallback for a workspace created
      // before pinning, or one that took the window default.
      model: record.model ?? (info && info.model ? `${info.provider}/${info.model}` : ""),
      state: this.stateOf(record),
      cost: info?.cost ?? 0,
      added: 0,
      deleted: 0,
      files: 0,
      setupState: record.setupState,
    };

    // Pipeline bookkeeping: the first time a workspace is seen working it
    // advances, and whatever stage was reached rides along on every row.
    if (status.state === "working") {
      this.advanceStage(record.id, "working");
    }
    const stage = this.stages.get(record.id);
    if (stage !== undefined) {
      status.stage = stage;
    }
    const started = this.startedAt.get(record.id);
    if (started !== undefined) {
      status.startedAt = started;
    }

    // The per-workspace budget, evaluated on every status built: this is the
    // one place the over-budget flags and the one-shot abort live.
    const budget = this.budgetOf(record, status.cost);
    if (budget.over) {
      status.overBudget = true;
      status.costLimitUsd = budget.limitUsd;
      status.lastError = budget.message;
    }

    if (opts?.diff) {
      const changes =
        opts.diff === true
          ? await workspaceDiff(record.worktreePath, record.baseSha).catch(() => undefined)
          : opts.diff;
      if (changes) {
        status.added = changes.added;
        status.deleted = changes.deleted;
        status.files = changes.files.length;
      }
    }

    if (opts?.merge) {
      // Best-effort: a merge probe that fails must not take the diff down with
      // it. `mergeable` simply stays unknown, which is what `undefined` means.
      const pre = await preflight({
        repoRoot: record.repoRoot,
        worktreePath: record.worktreePath,
        branch: record.branch,
        baseRef: record.baseRef,
        baseSha: record.baseSha,
      }).catch(() => undefined);
      if (pre) {
        status.mergeable = pre.conflictingFiles.length === 0;
        status.conflicts = pre.conflictingFiles;
      }
    }

    if (opts?.text && session) {
      const text = await session.lastAssistantText().catch(() => undefined);
      if (text) {
        status.lastText = tailLine(text, LAST_TEXT_CHARS);
      }
    }

    return status;
  }

  /** Statuses as `wait` reports them: diff totals and the agent's last word. */
  private async richStatuses(ids: string[]): Promise<WorkspaceStatus[]> {
    const out: WorkspaceStatus[] = [];
    await Promise.all(
      ids.map(async (id, index) => {
        const record = this.deps.manager.get(id);
        if (!record) {
          return;
        }
        // Indexed rather than pushed: `Promise.all` settles out of order, and
        // the caller's id order is the order the model asked in.
        out[index] = await this.statusOf(record, { diff: true, text: true });
      }),
    );
    return out.filter((status): status is WorkspaceStatus => status !== undefined);
  }

  /**
   * The ids to wait on, split into the ones that exist and the ones that do
   * not.
   *
   * Unknown ids are dropped rather than thrown on: `wait` is the one tool that
   * must never come back as a failure — a workspace merged and deleted between
   * two waits, or one typo in an array of five ids, would otherwise turn a
   * routine poll into an error and push the model into abandoning the run. The
   * dropped ids are reported alongside the statuses instead.
   */
  private resolveWaitIds(ids?: string[]): { ids: string[]; unknown: string[] } {
    const all = this.deps.manager.list();
    if (!ids || ids.length === 0) {
      return { ids: all.map((record) => record.id), unknown: [] };
    }
    const known: string[] = [];
    const unknown: string[] = [];
    for (const id of ids) {
      (all.some((record) => record.id === id) ? known : unknown).push(id);
    }
    return { ids: known, unknown };
  }

  /**
   * Sleep until `ready()` holds, the deadline passes, or the call is aborted.
   * Resolves `true` when the deadline or the abort won.
   *
   * Event-driven: the board event covers agents changing state, the registry
   * event covers workspaces appearing, finishing setup and disappearing.
   * Nothing here wakes on a schedule.
   */
  private waitForEvent(
    /** Already resolved and validated by the caller; re-resolving here would
     * turn a workspace deleted mid-wait into a rejection. */
    ids: string[],
    ready: () => boolean,
    a: {
      onProgress?: (s: WorkspaceStatus[]) => void;
      timeoutMs: number;
      signal?: AbortSignal;
    },
  ): Promise<boolean> {
    if (a.signal?.aborted) {
      return Promise.resolve(true);
    }
    if (!this.deps.onBoardChange && !this.warnedNoBoardEvent) {
      this.warnedNoBoardEvent = true;
      this.deps.output.appendLine(
        "[omp] orchestrator: no board change event was wired — waits will only wake on workspace list changes",
      );
    }

    return new Promise<boolean>((resolve) => {
      let done = false;
      let progressAt = 0;
      let progressing = false;
      const subs: { dispose(): void }[] = [];
      const timer = setTimeout(() => settle(true), Math.max(0, a.timeoutMs));
      const onAbort = (): void => settle(true);

      const cleanup = (): void => {
        clearTimeout(timer);
        a.signal?.removeEventListener("abort", onAbort);
        for (const sub of subs) {
          sub.dispose();
        }
      };

      function settle(timedOut: boolean): void {
        if (done) {
          return;
        }
        done = true;
        cleanup();
        resolve(timedOut);
      }

      const onChange = (): void => {
        if (done) {
          return;
        }
        if (ready()) {
          settle(false);
          return;
        }
        if (!a.onProgress) {
          return;
        }
        const now = Date.now();
        // Throttled to the contract's floor, and skipped while a previous
        // report is still being assembled: each one costs a git diff and an
        // RPC round trip per workspace, and a burst of board events must not
        // stack them up behind each other.
        if (progressing || now - progressAt < PROGRESS_INTERVAL_MS) {
          return;
        }
        progressAt = now;
        progressing = true;
        void this.richStatuses(ids)
          .then((statuses) => {
            if (!done) {
              a.onProgress?.(statuses);
            }
          })
          .catch(() => undefined)
          .finally(() => {
            progressing = false;
          });
      };

      a.signal?.addEventListener("abort", onAbort, { once: true });
      if (this.deps.onBoardChange) {
        subs.push(this.deps.onBoardChange(onChange));
      }
      subs.push(this.deps.manager.onDidChange(onChange));
      // One last look after subscribing: the state could have moved between the
      // caller's check and the first listener being attached.
      onChange();
    });
  }

  /**
   * Concatenate per-file patches until the byte budget runs out.
   *
   * File by file rather than one `git diff`, because the budget has to be spent
   * on whole files: a model given the first 60 kB of a single flat patch gets
   * half a hunk of the last file and no idea which files it never saw. Here the
   * ones that did not fit are named, with the argument that fetches them.
   */
  private async assembleDiff(
    record: WorkspaceRecord,
    changes: WorkspaceDiff,
    maxBytes: number,
  ): Promise<{ text: string; truncated: boolean }> {
    const parts: string[] = [];
    const skipped: string[] = [];
    let used = 0;
    let cut = false;

    for (const file of changes.files) {
      const remaining = maxBytes - used;
      if (remaining <= 0) {
        skipped.push(file.path);
        continue;
      }
      const chunk = await fileDiff(record.worktreePath, record.baseSha, file.path, {
        maxBytes: remaining,
      }).catch(() => "");
      if (!chunk) {
        // A file whose patch failed to read or came back empty is still a file
        // the model was told about in the header counts. Dropped silently it
        // would be missing from the text with nothing to say so; named in the
        // "not shown" line it is a file the model can ask for by path.
        skipped.push(file.path);
        continue;
      }
      if (TRUNCATION_MARKER.test(chunk)) {
        cut = true;
      }
      parts.push(chunk);
      used += Buffer.byteLength(chunk, "utf8");
    }

    if (skipped.length > 0) {
      // Inside the diff text, in English, like git's own output: a localised
      // line here would read as part of the patch.
      const shown = skipped.slice(0, 20).join(", ");
      const more = skipped.length > 20 ? `, and ${skipped.length - 20} more` : "";
      parts.push(
        `*** ${skipped.length} file(s) not shown: ${shown}${more} — request one with path="<file>" ***\n`,
      );
    }
    return { text: parts.join(""), truncated: cut || skipped.length > 0 };
  }
}

/**
 * The last `limit` characters of a reply, flattened to one line.
 *
 * The tail rather than the head: an agent's closing sentences say what it did
 * or what it is stuck on, while its opening ones restate the task it was given.
 */
function tailLine(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `…${flat.slice(flat.length - limit)}`;
}
