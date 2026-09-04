/**
 * Subagent tracking: the extension's own record of the agents omp spawned.
 *
 * omp reports subagents on three frames -- `subagent_lifecycle` (rare, one per
 * state change), `subagent_progress` (dozens per second per agent) and
 * `subagent_event` (the raw child event stream, only at subscription level
 * `events`). All three carry their data under `payload`, never at the top
 * level, and the progress payload has no `id` of its own: the identifier lives
 * in `payload.progress.id`.
 *
 * The registry inside omp drops a subagent the moment it reaches a terminal
 * state, and `get_subagents` only ever returns the running ones. A UI that
 * mirrored that would erase a finished agent's cost and transcript link the
 * instant it succeeded, so this module keeps terminated agents as history and
 * lets the surfaces decide what to show.
 *
 * Pure by design: no `vscode` import, so the reducer is testable under
 * `node --test` without a window.
 */

/**
 * Lifecycle vocabulary, which is *not* the same as `AgentProgress.status`
 * (`"pending" | "running" | "completed" | "failed" | "aborted"`). Progress
 * statuses are normalised into this set on the way in, so no surface ever has
 * to guess what an unmapped value means.
 */
export type SubagentStatus = "started" | "completed" | "failed" | "aborted";

/** One subagent, reduced from whatever frames have arrived so far. */
export interface SubagentInfo {
  /** Stable key: `payload.id` (lifecycle) or `payload.progress.id` (progress). */
  id: string;
  /** Agent definition name, e.g. "scout". */
  agent: string;
  /** Where the definition came from: "bundled", "project", "user", ... */
  agentSource: string;
  /** Human label the parent gave the spawn; falls back to the agent name. */
  description: string;
  status: SubagentStatus;
  /** The task text the parent handed down, "" when unknown. */
  task: string;
  /** Tool call id of the parent `task` call, "" when unknown. */
  parentToolCallId: string;
  /** Position within a batch spawn; -1 when unknown. */
  index: number;
  /** True for detached spawns -- the parent turn keeps running alongside them. */
  detached: boolean;
  /** Absolute path of this subagent's own JSONL transcript, "" when unknown. */
  sessionFile: string;
  /** Model the subagent actually resolved to, "" before the first progress. */
  resolvedModel: string;
  /** Tool the subagent is running right now, "" when idle or unknown. */
  currentTool: string;
  /** USD billed to this subagent so far. */
  cost: number;
  /** Cumulative tokens (input + output + cache writes). */
  tokens: number;
  /** Epoch ms of the first frame seen for this subagent. */
  startedAt: number;
  /** Epoch ms of the most recent frame. */
  updatedAt: number;
}

/** Ordered view the board and the webview both consume. */
export interface SubagentSnapshot {
  subagents: SubagentInfo[];
  /** How many are not in a terminal state. */
  running: number;
}

/** The three frame types this module understands. */
const SUBAGENT_FRAME_TYPES = new Set(["subagent_lifecycle", "subagent_progress", "subagent_event"]);

const TERMINAL: ReadonlySet<SubagentStatus> = new Set<SubagentStatus>([
  "completed",
  "failed",
  "aborted",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Map either vocabulary onto {@link SubagentStatus}. `AgentProgress` reports a
 * live agent as "running" or "pending"; the lifecycle frame calls the same
 * state "started". Collapsing them here is what lets the surfaces switch
 * exhaustively instead of falling through to a wrong default.
 */
function toStatus(value: unknown, fallback: SubagentStatus): SubagentStatus {
  switch (value) {
    case "started":
    case "running":
    case "pending":
      return "started";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "aborted":
      return "aborted";
    default:
      return fallback;
  }
}

/** True for `subagent_lifecycle`, `subagent_progress` and `subagent_event`. */
export function isSubagentFrame(frame: unknown): boolean {
  return isRecord(frame) && SUBAGENT_FRAME_TYPES.has(str(frame.type));
}

/**
 * A blank record. Every field has a defined value from the start so a surface
 * never has to distinguish "absent" from "not yet known" -- only the frames
 * that actually carry a field overwrite it.
 */
function blank(id: string, now: number): SubagentInfo {
  return {
    id,
    agent: "",
    agentSource: "",
    description: "",
    status: "started",
    task: "",
    parentToolCallId: "",
    index: -1,
    detached: false,
    sessionFile: "",
    resolvedModel: "",
    currentTool: "",
    cost: 0,
    tokens: 0,
    startedAt: now,
    updatedAt: now,
  };
}

/**
 * Identity for a progress payload. omp keys progress by `progress.id`; the
 * `parentToolCallId:index` pair is the fallback for the rare payload that
 * arrives without a resolved progress object, and matches how a lifecycle
 * frame for the same spawn would be keyed if its own id were missing.
 */
function progressId(payload: Record<string, unknown>): string {
  const progress = isRecord(payload.progress) ? payload.progress : undefined;
  const direct = str(progress?.id) || str(payload.id);
  if (direct) {
    return direct;
  }
  const parent = str(payload.parentToolCallId);
  const index = num(payload.index, -1);
  return parent ? `${parent}:${index}` : "";
}

/** Fold one lifecycle payload into a record. */
function applyLifecycle(
  base: SubagentInfo,
  payload: Record<string, unknown>,
  now: number,
): SubagentInfo {
  return {
    ...base,
    agent: str(payload.agent) || base.agent,
    agentSource: str(payload.agentSource) || base.agentSource,
    description: str(payload.description) || base.description,
    status: toStatus(payload.status, base.status),
    parentToolCallId: str(payload.parentToolCallId) || base.parentToolCallId,
    index: num(payload.index, base.index),
    detached: typeof payload.detached === "boolean" ? payload.detached : base.detached,
    sessionFile: str(payload.sessionFile) || base.sessionFile,
    updatedAt: now,
  };
}

/** Fold one progress payload -- and the `AgentProgress` inside it -- into a record. */
function applyProgress(
  base: SubagentInfo,
  payload: Record<string, unknown>,
  now: number,
): SubagentInfo {
  const progress = isRecord(payload.progress) ? payload.progress : {};
  return {
    ...base,
    agent: str(payload.agent) || str(progress.agent) || base.agent,
    agentSource: str(payload.agentSource) || str(progress.agentSource) || base.agentSource,
    description: str(progress.description) || str(payload.assignment) || base.description,
    // A terminal lifecycle frame must not be undone by a progress frame that
    // was already in flight when the agent finished.
    status: TERMINAL.has(base.status) ? base.status : toStatus(progress.status, base.status),
    task: str(payload.task) || str(progress.task) || base.task,
    parentToolCallId: str(payload.parentToolCallId) || base.parentToolCallId,
    index: num(payload.index, num(progress.index, base.index)),
    detached: typeof payload.detached === "boolean" ? payload.detached : base.detached,
    sessionFile: str(payload.sessionFile) || base.sessionFile,
    resolvedModel: str(progress.resolvedModel) || base.resolvedModel,
    currentTool: str(progress.currentTool),
    cost: num(progress.cost, base.cost),
    tokens: num(progress.tokens, base.tokens),
    updatedAt: now,
  };
}

/**
 * Reduce one raw omp frame. Returns a new map when the frame was understood,
 * or `null` when it was not -- the caller then leaves its state untouched.
 *
 * `subagent_event` is recognised but carries no state: it is the child's raw
 * event stream, which the extension only forwards.
 */
export function reduceSubagentFrame(
  state: Map<string, SubagentInfo>,
  frame: unknown,
  now: number,
): Map<string, SubagentInfo> | null {
  if (!isRecord(frame)) {
    return null;
  }
  const type = str(frame.type);
  if (!SUBAGENT_FRAME_TYPES.has(type)) {
    return null;
  }
  if (type === "subagent_event") {
    return state;
  }
  const payload = isRecord(frame.payload) ? frame.payload : undefined;
  if (!payload) {
    return state;
  }

  const id = type === "subagent_lifecycle" ? str(payload.id) : progressId(payload);
  if (!id) {
    return state;
  }

  const base = state.get(id) ?? blank(id, now);
  const next =
    type === "subagent_lifecycle"
      ? applyLifecycle(base, payload, now)
      : applyProgress(base, payload, now);
  if (!next.description) {
    next.description = next.agent;
  }

  const merged = new Map(state);
  merged.set(id, next);
  return merged;
}

/**
 * Merge a `get_subagents` response into state. Used on reattach, where the
 * frames that built the running agents were emitted before this session's
 * webview existed. omp answers with running agents only, so nothing here may
 * delete the history the frames already produced.
 */
export function reduceSubagentList(
  state: Map<string, SubagentInfo>,
  response: unknown,
  now: number,
): Map<string, SubagentInfo> {
  const container = isRecord(response) ? response : {};
  const data = isRecord(container.data) ? container.data : container;
  const list = Array.isArray(data.subagents) ? data.subagents : undefined;
  if (!list) {
    return state;
  }

  const merged = new Map(state);
  for (const entry of list) {
    if (!isRecord(entry)) {
      continue;
    }
    const id = str(entry.id) || progressId(entry);
    if (!id) {
      continue;
    }
    const base = merged.get(id) ?? blank(id, now);
    const progress = isRecord(entry.progress) ? entry.progress : {};
    merged.set(id, {
      ...base,
      agent: str(entry.agent) || base.agent,
      agentSource: str(entry.agentSource) || base.agentSource,
      description: str(entry.description) || base.description || str(entry.agent),
      // Same race as an in-flight progress frame: the answer left omp while
      // the agent was still running, and a terminal lifecycle frame landed
      // first. The list must not resurrect what the frames already buried.
      status: TERMINAL.has(base.status) ? base.status : toStatus(entry.status, base.status),
      task: str(entry.task) || base.task,
      parentToolCallId: str(entry.parentToolCallId) || base.parentToolCallId,
      index: num(entry.index, base.index),
      detached: typeof entry.detached === "boolean" ? entry.detached : base.detached,
      sessionFile: str(entry.sessionFile) || base.sessionFile,
      resolvedModel: str(progress.resolvedModel) || base.resolvedModel,
      currentTool: str(progress.currentTool) || base.currentTool,
      cost: num(progress.cost, base.cost),
      tokens: num(progress.tokens, base.tokens),
      updatedAt: num(entry.lastUpdate, now),
    });
  }
  return merged;
}

/**
 * Snapshot for display: running agents first (they are what an operator acts
 * on), then oldest-first within each group so rows never reshuffle as costs
 * tick up.
 */
export function subagentSnapshot(state: Map<string, SubagentInfo>): SubagentSnapshot {
  const subagents = [...state.values()].sort((a, b) => {
    const aRunning = TERMINAL.has(a.status) ? 1 : 0;
    const bRunning = TERMINAL.has(b.status) ? 1 : 0;
    if (aRunning !== bRunning) {
      return aRunning - bRunning;
    }
    return a.startedAt - b.startedAt;
  });
  return {
    subagents,
    running: subagents.reduce((n, sub) => (TERMINAL.has(sub.status) ? n : n + 1), 0),
  };
}
