/**
 * The bridge between omp's host-tool protocol and the orchestration facade,
 * plus the eight tool definitions the main chat model calls.
 *
 * omp lets the host register tools that the *model* then invokes: the host
 * sends `set_host_tools` once, omp answers `host_tool_call` frames, the host
 * replies with `host_tool_result`. That is the whole trick behind Phase 4 —
 * the model in the main chat creates workspaces on other models, waits for
 * them, verifies them and merges the winner without a human clicking
 * anything.
 *
 * Two protocol facts, taken from a live run against omp 17.3.5, shape this
 * file:
 *
 *   - `id` in `host_tool_update` / `host_tool_result` is the id of the
 *     *frame*, not `toolCallId`. Answering with the wrong one strands the
 *     turn forever.
 *   - One assistant turn can emit several `host_tool_call` frames at once.
 *     So {@link HostToolBridge.handleCall} is deliberately NOT `async`: it
 *     registers the call and returns immediately, and the handlers run
 *     concurrently. Serialising here would turn "create three workspaces"
 *     into three round trips.
 *
 * The single hard rule: **no `host_tool_call` may go unanswered**. A missing
 * result is not a failed tool call, it is a permanently wedged conversation —
 * omp waits for that id and the turn never ends. Every path out of a call
 * (success, throw, unknown tool, cancel, dispose, duplicate id) funnels
 * through {@link HostToolBridge.settle}, which sends exactly one result.
 *
 * Nothing here imports `vscode` or `l10n`, and nothing here goes through
 * `t()`: every string in this file is read by the *model*, not by the user.
 * Translating a tool description would silently change the prompt the model
 * reasons over depending on the editor's UI language.
 */

// Type-only imports throughout: they are erased before Node sees this file, so
// the module (and its test) never drags in `vscode`. That is also why they may
// omit the `.ts` extension while the value imports elsewhere in `src/` cannot.
import type { ApprovalMode } from "./ompSession";
import type { MergeResult, MergeStrategy } from "./workspaces/merge";

// ---------------------------------------------------------------------------
// Protocol shapes
// ---------------------------------------------------------------------------

/**
 * Mirrors `RpcHostToolDefinition` from omp's `src/modes/rpc/rpc-types.ts`.
 * Re-declared rather than imported: omp is a binary the user installs on its
 * own release cycle, and a compile-time dependency on its sources would break
 * this build whenever the two versions drift.
 */
export interface RpcHostToolDefinitionLike {
  name: string;
  label?: string;
  description: string;
  /** JSON Schema for an object; omp hands it to the model verbatim. */
  parameters: Record<string, unknown>;
  hidden?: boolean;
  loadMode?: string;
}

/** What a handler hands back; the bridge wraps it into an `AgentToolResult`. */
export interface HostToolOutcome {
  text: string;
  details?: unknown;
  isError?: boolean;
}

/**
 * What a running handler is given. `signal` fires on `host_tool_cancel` and on
 * `dispose`; `sendUpdate` streams a progress line into the still-open call and
 * becomes a no-op once the call has been answered.
 */
export interface HostToolContext {
  signal: AbortSignal;
  sendUpdate(text: string): void;
}

export interface HostToolHandler {
  definition: RpcHostToolDefinitionLike;
  run(args: Record<string, unknown>, ctx: HostToolContext): Promise<HostToolOutcome>;
}

/** The incoming frame, narrowed to the fields this module reads. */
export interface HostToolCallFrame {
  id: string;
  toolCallId: string;
  toolName: string;
  arguments?: Record<string, unknown>;
}

export interface HostToolCancelFrame {
  targetId: string;
}

/** Where the bridge writes frames, and where it logs. */
export interface HostToolIo {
  send(msg: Record<string, unknown>): void;
  output: { appendLine(s: string): void };
}

// ---------------------------------------------------------------------------
// The orchestrator, structurally
//
// `Orchestrator` itself lives in a module that is allowed to import `vscode`.
// Importing it here — even for types only — would tie this file to a module
// graph the unit test cannot resolve, and would risk the cycle the contract
// warns about (orchestrator -> manager -> openChat -> OmpSession -> bridge).
// So the dependency is expressed structurally: the real class satisfies
// `OrchestratorApi` without declaring that it does, and the test satisfies it
// with a twenty-line fake.
// ---------------------------------------------------------------------------

export type WorkspaceState = "starting" | "working" | "needs_input" | "idle" | "no_session";

export interface WorkspaceStatusLike {
  id: string;
  name: string;
  branch: string;
  model: string;
  state: WorkspaceState;
  cost: number;
  added: number;
  deleted: number;
  files: number;
  /** Computed lazily; absent means "nobody asked", not "cannot merge". */
  mergeable?: boolean;
  conflicts?: string[];
  setupState: string;
  /** Tail of the agent's last message, already trimmed by the orchestrator. */
  lastText?: string;
  /** Optional so a status without it still satisfies this interface. */
  worktreePath?: string;
}

export interface VerifyResultLike {
  ok: boolean;
  ran: string;
  exitCode: number | null;
  durationMs: number;
  output: string;
  timedOut: boolean;
}

export interface OrchestratorApi {
  create(a: {
    name: string;
    prompt: string;
    model?: string;
    baseRef?: string;
    approvalMode?: ApprovalMode;
    runSetup?: boolean;
  }): Promise<WorkspaceStatusLike>;
  list(a?: { withDiff?: boolean }): Promise<WorkspaceStatusLike[]>;
  prompt(a: { id: string; message: string; mode?: PromptMode }): Promise<WorkspaceStatusLike>;
  wait(a: {
    ids?: string[];
    until?: WaitUntil;
    timeoutMs: number;
    onProgress?: (statuses: WorkspaceStatusLike[]) => void;
    signal?: AbortSignal;
    // Optional so a caller (and the unit test's fake) that reports no unknown
    // ids still satisfies this shape; `wait` drops them rather than failing,
    // and the handler names them so the model can re-list instead of guessing.
  }): Promise<{ statuses: WorkspaceStatusLike[]; timedOut: boolean; unknownIds?: string[] }>;
  diff(a: {
    id: string;
    path?: string;
    statOnly?: boolean;
    maxBytes?: number;
  }): Promise<{ status: WorkspaceStatusLike; text?: string; truncated: boolean }>;
  verify(a: {
    id: string;
    command?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<VerifyResultLike>;
  merge(a: {
    id: string;
    strategy?: MergeStrategy;
    force?: boolean;
    commitMessage?: string;
  }): Promise<MergeResult>;
  remove(a: { id: string; deleteBranch?: boolean; force?: boolean }): Promise<void>;
}

export type PromptMode = "prompt" | "steer" | "follow_up";
export type WaitUntil = "idle" | "needs_input" | "any";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ORCHESTRATOR_TOOL_NAMES = [
  "workspace_create",
  "workspace_list",
  "workspace_prompt",
  "workspace_wait",
  "workspace_diff",
  "workspace_verify",
  "workspace_merge",
  "workspace_delete",
] as const;

/**
 * `discoverable` keeps eight extra tools out of every system prompt: omp loads
 * the full schemas only once the model reaches for one. The main chat is often
 * used for ordinary coding, where none of this is relevant.
 */
const LOAD_MODE = "discoverable";

const APPROVAL_MODES: readonly ApprovalMode[] = ["always-ask", "write", "yolo"];
const MERGE_STRATEGIES: readonly MergeStrategy[] = ["merge", "squash"];
const PROMPT_MODES: readonly PromptMode[] = ["prompt", "steer", "follow_up"];
const WAIT_UNTIL: readonly WaitUntil[] = ["idle", "needs_input", "any"];

const DEFAULT_WAIT_SECONDS = 300;
const MAX_WAIT_SECONDS = 3600;
const DEFAULT_VERIFY_SECONDS = 600;
const MAX_VERIFY_SECONDS = 3600;

/**
 * Ceiling on `workspace_diff`'s patch budget.
 *
 * `maxBytes` arrives from the model, and without a cap a single call can ask
 * the extension host to concatenate half a gigabyte of patch text into one
 * string and push it through the RPC transport. 200 kB is already far more
 * than any context window can absorb, so nothing legitimate is lost, and the
 * per-file `path` argument is the intended way to read a large change.
 */
const MAX_DIFF_BYTES = 200_000;

/**
 * What `workspace_verify` accepts as a runnable script name.
 *
 * The model may not compose a shell command here — see the `workspace_verify`
 * definition below for why — so the only free-form part of the command line is
 * an npm script name, and it must be a name and nothing else: no spaces, no
 * quotes, no `;` `&` `|` `$` `` ` `` and no path separators, all of which would
 * turn `npm run <x>` back into arbitrary shell.
 */
const NPM_SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/;

/** Floor on the gap between `host_tool_update` frames from a long wait. */
export const WAIT_UPDATE_INTERVAL_MS = 5_000;

// ---------------------------------------------------------------------------
// Argument validation
//
// Hand-written rather than schema-driven, because the *message* matters more
// than the check: a rejected call is a turn the model has to spend recovering
// from, so every failure names the tool, the field, what actually arrived and
// what to send instead. "Invalid arguments" would cost a retry loop.
//
// The coercions below (numeric strings, "true"/"false", a bare string where an
// array is expected) are deliberate. Models produce those constantly, they are
// unambiguous, and refusing them buys nothing but a wasted round trip.
// ---------------------------------------------------------------------------

/** A failure the model can fix by calling again; reported with `isError`. */
export class ToolArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolArgumentError";
  }
}

function describeValue(value: unknown): string {
  if (value === undefined) return "nothing";
  if (value === null) return "null";
  if (typeof value === "string") return `the string ${JSON.stringify(value.slice(0, 60))}`;
  if (Array.isArray(value)) return `an array (${JSON.stringify(value).slice(0, 60)})`;
  if (typeof value === "object") return `an object (${JSON.stringify(value).slice(0, 60)})`;
  return `${typeof value} ${JSON.stringify(value)}`;
}

function quoted(values: readonly string[]): string {
  return values.map((value) => `"${value}"`).join(", ");
}

function requireString(tool: string, args: Record<string, unknown>, field: string): string {
  const value = args[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToolArgumentError(
      `${tool}: "${field}" is required and must be a non-empty string, but got ${describeValue(value)}. ` +
        `Call ${tool} again with "${field}" filled in.`,
    );
  }
  return value.trim();
}

function optionalString(tool: string, args: Record<string, unknown>, field: string): string | undefined {
  const value = args[field];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new ToolArgumentError(
      `${tool}: "${field}" must be a string when present, but got ${describeValue(value)}. Omit it if you have no value for it.`,
    );
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function optionalEnum<T extends string>(
  tool: string,
  args: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
): T | undefined {
  const value = args[field];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new ToolArgumentError(
      `${tool}: "${field}" must be one of ${quoted(allowed)}, but got ${describeValue(value)}. ` +
        `Omit "${field}" to take the default.`,
    );
  }
  return value as T;
}

function optionalBoolean(tool: string, args: Record<string, unknown>, field: string): boolean | undefined {
  const value = args[field];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") return value;
  // Models emit the JSON literal as a string surprisingly often; the intent is
  // never in doubt, so honour it rather than burning a turn on a retry.
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ToolArgumentError(
    `${tool}: "${field}" must be true or false, but got ${describeValue(value)}. Omit it to take the default.`,
  );
}

function optionalPositiveNumber(
  tool: string,
  args: Record<string, unknown>,
  field: string,
): number | undefined {
  const value = args[field];
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new ToolArgumentError(
      `${tool}: "${field}" must be a positive number, but got ${describeValue(value)}. Omit it to take the default.`,
    );
  }
  return parsed;
}

/**
 * Clamps rather than rejects: an out-of-range timeout is a preference, not a
 * mistake.
 *
 * The floor matters more than the ceiling. Rounding happens *inside* the clamp
 * and never below 1, because a sub-second value like `0.4` would otherwise
 * round to 0 — and 0 does not mean "give up at once" anywhere downstream, it
 * means "no timeout at all" (`runVerify` only arms its timer for a positive
 * number). Silently turning the one bound on a model-spawned build into "run
 * forever" is the exact opposite of what the argument asked for.
 */
function seconds(
  tool: string,
  args: Record<string, unknown>,
  field: string,
  fallback: number,
  max: number,
): number {
  const value = optionalPositiveNumber(tool, args, field);
  if (value === undefined) return fallback;
  return Math.min(Math.max(1, Math.round(value)), max);
}

function optionalStringArray(
  tool: string,
  args: Record<string, unknown>,
  field: string,
): string[] | undefined {
  const value = args[field];
  if (value === undefined || value === null || value === "") return undefined;
  // A single id where an array belongs is the most common shape error here.
  const raw = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new ToolArgumentError(
        `${tool}: "${field}[${index}]" must be a workspace id string, but got ${describeValue(entry)}. ` +
          `Pass ids exactly as workspace_list prints them, e.g. ["ws-1", "ws-2"].`,
      );
    }
    out.push(entry.trim());
  }
  return out.length > 0 ? out : undefined;
}

const KEBAB = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Names become git branch names and board labels, so they are checked here
 * rather than deep inside the worktree code where the message would be a git
 * error. The suggestion matters more than the rejection: the model usually
 * meant the kebab-cased form of what it sent.
 */
function requireWorkspaceName(tool: string, args: Record<string, unknown>): string {
  const name = requireString(tool, args, "name");
  if (KEBAB.test(name) && name.length <= 40) {
    return name;
  }
  const suggestion = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const hint = KEBAB.test(suggestion) ? ` Use "${suggestion}" instead.` : "";
  throw new ToolArgumentError(
    `${tool}: "name" must be short kebab-case — lowercase letters, digits and hyphens, at most 40 characters ` +
      `(for example "auth-jwt"). Got ${describeValue(name)}.${hint}`,
  );
}

/**
 * Turn `workspace_verify`'s optional argument into a command line, or refuse.
 *
 * This is a security boundary, not a convenience check. `runVerify` spawns
 * with `shell: true` and the editor's own `process.env` — provider API keys
 * included — and nothing on that path prompts anybody, so a free-form
 * `command` from the model would be an unapproved shell on the user's machine
 * that a session configured `always-ask` still executes silently.
 *
 * So the model does not get to compose a command. It may only pick a script
 * the *project* declared in its own package.json, which is run as
 * `npm run <script>`; the default path — no argument at all — runs what the
 * repository itself says proves it (`verify` in .ompcode/workspace.json, else
 * its test / check / build script). The regexp keeps the name a name, so the
 * interpolation below cannot grow a `;` and become two commands.
 *
 * A model that sends the old `command` argument is answered with the script
 * name it should have sent, rather than with a bare rejection.
 */
function verifyCommand(args: Record<string, unknown>): string | undefined {
  const tool = "workspace_verify";
  const legacy = optionalString(tool, args, "command");
  if (legacy !== undefined) {
    const npm = /^npm\s+(?:run\s+)?([A-Za-z0-9][A-Za-z0-9:._-]*)$/.exec(legacy);
    throw new ToolArgumentError(
      `${tool}: "command" is not accepted — this tool cannot run a shell command you compose, only what the project itself declares. ` +
        (npm
          ? `Call it again with script="${npm[1]}" instead.`
          : `Omit the argument to run the project's own verify command, or pass script="<a script name from the workspace's package.json>".`),
    );
  }
  const script = optionalString(tool, args, "script");
  if (script === undefined) return undefined;
  if (!NPM_SCRIPT_NAME.test(script)) {
    throw new ToolArgumentError(
      `${tool}: "script" must be the bare name of a script in the workspace's package.json — letters, digits, ":", ".", "_" and "-" only, ` +
        `for example "test" or "test:unit". Got ${describeValue(script)}. It is run as \`npm run <script>\`, so a full command line, arguments, ` +
        `pipes or paths cannot go here. Omit it to run the project's own configured verify command.`,
    );
  }
  return `npm run ${script}`;
}

// ---------------------------------------------------------------------------
// Result rendering
//
// Results are `key: value` prose, not JSON: the model reads them directly, and
// a table it can quote back to the user beats a blob it has to parse. The
// structured form rides along in `details`, where the webview (or a future MCP
// server) can pick it up without re-parsing the text.
// ---------------------------------------------------------------------------

function money(cost: number): string {
  if (!Number.isFinite(cost) || cost <= 0) return "$0.00";
  return `$${cost < 1 ? cost.toFixed(3) : cost.toFixed(2)}`;
}

function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 90) return `${s.toFixed(1)}s`;
  // Round to whole seconds *before* splitting: rounding the remainder instead
  // lets 119.7s print as "1m60s", which reads like a broken tool.
  const total = Math.round(s);
  const m = Math.floor(total / 60);
  return `${m}m${String(total % 60).padStart(2, "0")}s`;
}

/** `id · name · branch · model · state · $cost · +A/-D · N files · setup:done` */
export function formatStatusRow(status: WorkspaceStatusLike): string {
  const parts = [
    status.id,
    status.name,
    status.branch,
    status.model || "(session model)",
    status.state,
    money(status.cost),
    `+${status.added}/-${status.deleted}`,
    `${status.files} ${status.files === 1 ? "file" : "files"}`,
    `setup:${status.setupState}`,
  ];
  if (status.mergeable !== undefined) {
    parts.push(`mergeable:${status.mergeable ? "yes" : "no"}`);
  }
  return parts.join(" · ");
}

function statusLines(status: WorkspaceStatusLike): string[] {
  const lines = [
    `workspace: ${status.name} (${status.id})`,
    `branch: ${status.branch}`,
    `model: ${status.model || "(session model)"}`,
    `state: ${status.state}`,
    `cost: ${money(status.cost)}`,
    `changes: ${status.files} ${status.files === 1 ? "file" : "files"}, +${status.added}/-${status.deleted}`,
    `setup: ${status.setupState}`,
  ];
  if (status.worktreePath) {
    lines.splice(2, 0, `path: ${status.worktreePath}`);
  }
  return lines;
}

/**
 * One sentence explaining what a state means, so the model does not guess.
 *
 * `needs_input` is the one worth reading twice. It is derived from the
 * workspace session holding an unanswered `extension_ui_request` — a modal
 * approval or `ask` dialog drawn in that workspace's own chat tab — and the
 * only thing that clears it is a human answering that dialog there (or through
 * Remote Control). `workspace_prompt` sends a *turn*, not a dialog answer, so
 * telling the model to unblock it that way would be sending it in a circle.
 * An agent that merely asked a question in prose and ended its turn is `idle`,
 * and that one really is answered with `workspace_prompt`.
 */
function explainState(state: WorkspaceState): string {
  switch (state) {
    case "starting":
      return "its agent process is still coming up; nothing has been produced yet";
    case "working":
      return "its agent is running a turn right now";
    case "needs_input":
      return (
        "its agent put up an approval dialog in that workspace's own chat tab and STOPPED — it needs a human to click it, " +
        "and no workspace tool can answer it (workspace_prompt will not release it). Tell the human, or delete the workspace " +
        'and recreate it with approvalMode "yolo" so it never stops to ask'
      );
    case "idle":
      return "its agent finished its turn and is waiting for more work";
    case "no_session":
      return "no agent process is attached to this workspace; the worktree and its commits are still there, but nothing is running";
  }
}

function outcome(text: string, details?: unknown): HostToolOutcome {
  return details === undefined ? { text } : { text, details };
}

// ---------------------------------------------------------------------------
// The eight tools
// ---------------------------------------------------------------------------

/**
 * Build the handlers over one orchestrator.
 *
 * The `description` fields below are prompt engineering, not documentation.
 * Each one exists to head off a specific failure seen in practice: bare model
 * ids, abandoning a wait that is merely slow, forcing a merge through a
 * conflict, merging a diff that was never read, deleting a workspace whose
 * work is not landed anywhere.
 */
export function buildWorkspaceHostTools(orchestrator: OrchestratorApi): HostToolHandler[] {
  const handlers: HostToolHandler[] = [
    // ------------------------------------------------------------- create --
    {
      definition: {
        name: "workspace_create",
        label: "Create workspace",
        loadMode: LOAD_MODE,
        description:
          "Create an isolated git worktree for one task and start a second coding agent inside it, on the model you name. " +
          "This returns as soon as that agent is launched — the call finishing does NOT mean the task is done; the agent keeps working in the background. " +
          "Use one workspace per independent task to run work in parallel, or several workspaces with the SAME prompt on DIFFERENT models when you want to compare solutions and keep the best one. " +
          "The agent you start cannot see this conversation, cannot read your notes and has no way to ask you anything until you next message it, so `prompt` must be a complete, self-contained brief. " +
          "Typical sequence: workspace_create -> workspace_wait -> workspace_diff -> workspace_verify -> workspace_merge.",
        parameters: {
          type: "object",
          required: ["name", "prompt"],
          additionalProperties: false,
          properties: {
            name: {
              type: "string",
              description:
                'Short kebab-case name — lowercase letters, digits and hyphens only, two or three words, e.g. "auth-jwt", "glm-attempt", "retry-backoff". It becomes the git branch and the board label, so it must be unique among the workspaces workspace_list shows. Not a sentence, not Title Case.',
            },
            prompt: {
              type: "string",
              description:
                "The complete task for that agent, written as if to an engineer who joined today and can see only the repository: what to change, in which files or area, the constraints, and what finished looks like. " +
                "Copy in every fact from this conversation it needs — it sees none of it. Never write 'the bug we discussed' or 'as above'; there is no above for it.",
            },
            model: {
              type: "string",
              description:
                'Which model runs in that workspace, as "provider/modelId" — the provider, a slash, then the exact model id, e.g. "anthropic/claude-opus-4-6", "dashscope/qwen3.8-max". Never a bare id ("qwen3.8-max") and never a human label ("Opus"). ' +
                "Use ids this installation actually has: which providers are configured differs per machine, so take them from the model column of workspace_list or ask the human, rather than from memory. " +
                "An id that does not exist here is NOT rejected and NOT reported: the workspace quietly runs on the window's default model while every tool keeps echoing back the id you asked for. Confirm an unfamiliar id with the human before dispatching a comparison, because afterwards nothing in the output can tell you it happened. " +
                "Omit it to inherit this session's model.",
            },
            approvalMode: {
              type: "string",
              enum: ["always-ask", "write", "yolo"],
              description:
                '"yolo" lets that agent edit files and run commands unattended, and is what an unattended workspace needs. ' +
                '"write" lets it edit files but stops it before shell commands, and "always-ask" stops it at nearly everything: both make the agent raise an approval dialog in its own chat tab and sit in state needs_input until a HUMAN clicks it — no workspace tool can answer that dialog, so an unwatched workspace on those modes is stuck for good. ' +
                "Pick them only when the human said they will supervise the run. Omitting this takes the editor's configured default, which may be one of those two, so pass \"yolo\" explicitly whenever you are working on your own.",
            },
            baseRef: {
              type: "string",
              description:
                'Branch, tag or commit the worktree starts from, e.g. "main". Omit to branch off the repository\'s current HEAD, which is usually right. When you start several workspaces to compare solutions, name the SAME explicit baseRef for all of them so their diffs are comparable. Diffs are always measured against this starting point.',
            },
            runSetup: {
              type: "boolean",
              description:
                "Run the workspace setup commands (dependency install and the like) in the new worktree before the agent starts. Leave it off unless the task needs installed dependencies to even begin; setup can take minutes.",
            },
          },
        },
      },
      async run(args) {
        const tool = "workspace_create";
        const status = await orchestrator.create({
          name: requireWorkspaceName(tool, args),
          prompt: requireString(tool, args, "prompt"),
          ...pick("model", optionalString(tool, args, "model")),
          ...pick("baseRef", optionalString(tool, args, "baseRef")),
          ...pick("approvalMode", optionalEnum(tool, args, "approvalMode", APPROVAL_MODES)),
          ...pick("runSetup", optionalBoolean(tool, args, "runSetup")),
        });
        const body = [
          "created and started.",
          ...statusLines(status),
          "",
          "The agent is now working on its own. Call workspace_wait with this id; do not assume it is finished.",
        ].join("\n");
        return outcome(body, status);
      },
    },

    // --------------------------------------------------------------- list --
    {
      definition: {
        name: "workspace_list",
        label: "List workspaces",
        loadMode: LOAD_MODE,
        description:
          "List every workspace with its live state, accumulated cost and how much it has changed. Instant and cheap — call it whenever you are unsure which ids exist or which agents are still running. " +
          "It never waits for anything: to wait, use workspace_wait, and never poll this tool in a loop instead. " +
          'Read the state column carefully. "working" = busy right now. "idle" = finished its turn (an agent that asked a question in prose and stopped looks like this — answer it with workspace_prompt). ' +
          '"needs_input" = STOPPED on an approval dialog in its own chat tab that only a human can click; no workspace tool releases it, so report it rather than trying to answer it. ' +
          '"starting" = the agent process is still coming up. "no_session" = nothing is running for that worktree. ' +
          "This tool does not print what an agent last said — workspace_wait does, on the ids it returns.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            withDiff: {
              type: "boolean",
              description:
                "Also measure how much each workspace has changed (+added/-deleted and the file count) by diffing every worktree against its base commit. Costs an extra git pass per workspace, so use it when you are about to choose a winner, not on every check. " +
                "It does NOT tell you whether a branch still merges cleanly: for that, call workspace_diff on the workspace you are about to merge.",
            },
          },
        },
      },
      async run(args) {
        const tool = "workspace_list";
        const withDiff = optionalBoolean(tool, args, "withDiff");
        const statuses = await orchestrator.list(withDiff === undefined ? undefined : { withDiff });
        if (statuses.length === 0) {
          return outcome(
            "No workspaces exist. Start one with workspace_create, giving it a kebab-case name and a self-contained prompt.",
            [],
          );
        }
        const lines = [
          `${statuses.length} ${statuses.length === 1 ? "workspace" : "workspaces"}:`,
          ...statuses.map((status) => formatStatusRow(status)),
        ];
        const blocked = statuses.filter((status) => status.state === "needs_input");
        if (blocked.length > 0) {
          lines.push(
            "",
            `Blocked and making no progress: ${blocked.map((s) => s.id).join(", ")}. ` +
              "Each is stopped on an approval dialog in its own chat tab that only a human can click — workspace_prompt does not clear it. " +
              'Tell the human which workspaces are waiting, or delete one and recreate it with approvalMode "yolo".',
          );
        }
        return outcome(lines.join("\n"), statuses);
      },
    },

    // ------------------------------------------------------------- prompt --
    {
      definition: {
        name: "workspace_prompt",
        label: "Message workspace",
        loadMode: LOAD_MODE,
        description:
          "Send a message to the agent running in a workspace: the answer to a question it asked in prose, a correction, or its next task. " +
          "Returns as soon as the message is delivered — NOT when the agent has acted on it — so follow it with workspace_wait. " +
          "It does NOT answer an approval dialog: a workspace in state needs_input is waiting for a human to click something in its own chat tab, and this tool cannot release it. " +
          "It also restarts a workspace in state no_session, reopening its chat before delivering the message. " +
          "This is also how you fix a workspace whose branch conflicts with the base: tell its own agent to rebase onto the base branch and resolve the named files. " +
          "The agent still cannot see this conversation, so the message must stand on its own.",
        parameters: {
          type: "object",
          required: ["id", "message"],
          additionalProperties: false,
          properties: {
            id: {
              type: "string",
              description: "Workspace id exactly as workspace_create or workspace_list prints it — not the name, not the branch.",
            },
            message: {
              type: "string",
              description:
                "What to say to that agent. Self-contained, like the original prompt: name files and facts explicitly instead of referring back to anything said here.",
            },
            mode: {
              type: "string",
              enum: ["prompt", "steer", "follow_up"],
              description:
                '"prompt" (default) starts a new turn — correct when the workspace is idle. ' +
                '"steer" cuts into the turn it is running RIGHT NOW to redirect it mid-flight without stopping it — use it while state is "working". ' +
                '"follow_up" queues the message behind the running turn, so the agent picks it up as soon as it finishes instead of being interrupted. ' +
                "None of the three answers an approval dialog: a workspace in state needs_input stays blocked whichever you pick.",
            },
          },
        },
      },
      async run(args) {
        const tool = "workspace_prompt";
        const status = await orchestrator.prompt({
          id: requireString(tool, args, "id"),
          message: requireString(tool, args, "message"),
          ...pick("mode", optionalEnum(tool, args, "mode", PROMPT_MODES)),
        });
        const body = [
          "message delivered.",
          ...statusLines(status),
          "",
          `State ${status.state} means ${explainState(status.state)}. The agent has not finished acting on this message — call workspace_wait next.`,
        ].join("\n");
        return outcome(body, status);
      },
    },

    // --------------------------------------------------------------- wait --
    {
      definition: {
        name: "workspace_wait",
        label: "Wait for workspaces",
        loadMode: LOAD_MODE,
        description:
          "Block until the named workspaces stop working, then report where each one stands. " +
          "THIS CALL IS MEANT TO TAKE A LONG TIME — many minutes on a real task — and a long silence is normal progress, not a hang. " +
          "If it comes back saying workspaces are still running, that is a SUCCESS and a timeout, not a failure: nothing was lost, the agents are still working, and the correct response is to call workspace_wait again with the same ids. " +
          "Never cancel a wait because it feels slow, never start a second wait for the same ids, and never poll workspace_list in a loop instead of waiting. " +
          'A workspace that comes back as "needs_input" is stopped on an approval dialog only a human can click and will never finish on its own — waiting on it again changes nothing; say so to the human. ' +
          "This is the only tool that reports what each agent last said.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            ids: {
              type: "array",
              items: { type: "string" },
              description:
                'Workspace ids to wait for, as an array — ["ws-1"] even for a single one. Waiting for several at once is far better than one after another. Omit to wait for every workspace.',
            },
            until: {
              type: "string",
              enum: ["idle", "needs_input", "any"],
              description:
                '"idle" (default) returns when every listed workspace has stopped working. ' +
                '"needs_input" returns only when one of them stops on an approval dialog — it does NOT return when they merely finish, so a run where nobody asks anything burns the whole timeoutSeconds. Use it only to watch for a stall you already expect. ' +
                '"any" returns as soon as any single workspace has stopped, whichever way. Prefer "idle" or "any".',
            },
            timeoutSeconds: {
              type: "number",
              description:
                "How long to wait before returning a still-running report, in SECONDS (default 300, maximum 3600). The cap is deliberate: do not try to wait out a twelve-hour run in one call — loop over repeated waits so you see progress and can react to a workspace that starts asking questions.",
            },
          },
        },
      },
      async run(args, ctx) {
        const tool = "workspace_wait";
        const ids = optionalStringArray(tool, args, "ids");
        const until = optionalEnum(tool, args, "until", WAIT_UNTIL);
        const waitSeconds = seconds(tool, args, "timeoutSeconds", DEFAULT_WAIT_SECONDS, MAX_WAIT_SECONDS);

        // Throttled here as well as in the orchestrator: an update frame costs
        // a round trip through omp, and a chattier source upstream must not be
        // able to flood the transport.
        let lastUpdate = 0;
        const onProgress = (statuses: WorkspaceStatusLike[]): void => {
          const now = Date.now();
          if (now - lastUpdate < WAIT_UPDATE_INTERVAL_MS) return;
          lastUpdate = now;
          ctx.sendUpdate(statuses.map((status) => formatStatusRow(status)).join("\n"));
        };

        const result = await orchestrator.wait({
          ...pick("ids", ids),
          ...pick("until", until),
          timeoutMs: waitSeconds * 1000,
          onProgress,
          signal: ctx.signal,
        });

        const lines: string[] = [];
        // Named first, before the statuses: an id that no longer exists is the
        // one fact that changes what the model should do next, and this tool
        // never turns it into an error.
        const unknown = result.unknownIds ?? [];
        if (unknown.length > 0) {
          lines.push(
            `Not a workspace, so not waited for: ${unknown.join(", ")}. ` +
              "They were deleted or misspelled — call workspace_list for the ids that exist.",
            "",
          );
        }
        if (result.statuses.length === 0) {
          lines.push("No workspaces matched, so there was nothing to wait for. Check the ids with workspace_list.");
        } else {
          for (const status of result.statuses) {
            lines.push(formatStatusRow(status));
            if (status.lastText) {
              lines.push(`    last said: ${status.lastText}`);
            }
          }
        }

        const blocked = result.statuses.filter((status) => status.state === "needs_input");
        const running = result.statuses.filter(
          (status) => status.state === "working" || status.state === "starting",
        );

        lines.push("");
        if (result.timedOut) {
          lines.push(
            `Waited ${waitSeconds}s and ${running.length > 0 ? `${running.length} workspace(s) are` : "work is"} still running. ` +
              "This is not a failure and not a hang — the agents kept working the whole time. Call workspace_wait again with the same ids to keep waiting.",
          );
        } else {
          lines.push("Every workspace waited for has stopped working.");
        }
        if (blocked.length > 0) {
          lines.push(
            `Stopped on an approval dialog and making no progress: ${blocked.map((s) => s.id).join(", ")}. ` +
              "Only a human clicking in that workspace's chat tab releases these — workspace_prompt does not, and waiting again will not move them. " +
              'Report them to the human, or delete and recreate the workspace with approvalMode "yolo".',
          );
        }
        if (!result.timedOut && blocked.length === 0 && result.statuses.length > 0) {
          lines.push("Next: workspace_diff to read what changed, then workspace_verify before any merge.");
        }
        return outcome(lines.join("\n"), {
          timedOut: result.timedOut,
          statuses: result.statuses,
          unknownIds: unknown,
        });
      },
    },

    // --------------------------------------------------------------- diff --
    {
      definition: {
        name: "workspace_diff",
        label: "Read workspace diff",
        loadMode: LOAD_MODE,
        description:
          "Read what a workspace actually changed, measured against the commit it branched from. " +
          "Start with statOnly true (or no path) to get the touched files with their added/deleted counts, then call again with one path at a time to read the real patch for the files that matter. " +
          "Never merge or recommend a workspace whose diff you have not read: an agent's own summary of its work is not evidence. " +
          "The reply also tells you whether the branch still merges cleanly and, if not, which files conflict — read that before calling workspace_merge, because a conflicting workspace cannot be merged and force will not change it.",
        parameters: {
          type: "object",
          required: ["id"],
          additionalProperties: false,
          properties: {
            id: { type: "string", description: "Workspace id from workspace_create or workspace_list." },
            path: {
              type: "string",
              description:
                'Repository-relative path of a single file to show as a unified patch, e.g. "src/auth.ts". Omit for the whole diff. This is the right way to handle a truncated reply — ask for one file at a time rather than raising maxBytes.',
            },
            statOnly: {
              type: "boolean",
              description:
                "Return only the per-file summary and the merge check, with no patch text at all. The cheapest way to see the shape of a change before deciding which files are worth reading.",
            },
            maxBytes: {
              type: "number",
              description:
                "Cut the patch text off at this many bytes (default 60000, hard maximum 200000 — anything larger is silently clamped to it). The file list and the merge check are never cut. " +
                "If a reply says it was truncated, ask for a single path instead of raising this: a patch too big for the budget is also too big to reason about.",
            },
          },
        },
      },
      async run(args) {
        const tool = "workspace_diff";
        const path = optionalString(tool, args, "path");
        // Clamped here, with every other model-supplied budget, rather than
        // deeper down: the orchestrator only floors it, so an unclamped value
        // becomes a real allocation in the extension host.
        const requestedBytes = optionalPositiveNumber(tool, args, "maxBytes");
        const result = await orchestrator.diff({
          id: requireString(tool, args, "id"),
          ...pick("path", path),
          ...pick("statOnly", optionalBoolean(tool, args, "statOnly")),
          ...pick(
            "maxBytes",
            requestedBytes === undefined ? undefined : Math.min(Math.round(requestedBytes), MAX_DIFF_BYTES),
          ),
        });
        const status = result.status;

        // Order is load-bearing: the file counts and the merge verdict are the
        // minimum needed to decide anything, so they are printed first and are
        // never truncated. The patch text is the only part that can be cut.
        const lines = [
          `workspace: ${status.name} (${status.id})`,
          `branch: ${status.branch}`,
          `changes: ${status.files} ${status.files === 1 ? "file" : "files"}, +${status.added}/-${status.deleted}`,
          `mergeable: ${status.mergeable === undefined ? "not checked" : status.mergeable ? "yes" : "no"}`,
        ];
        if (status.conflicts && status.conflicts.length > 0) {
          lines.push(`conflicts: ${status.conflicts.join(", ")}`);
          lines.push(
            "Do not call workspace_merge on this workspace: a conflict cannot be forced through. " +
              "Send its own agent a workspace_prompt telling it to rebase onto the base branch and resolve those files, wait for it, then diff again.",
          );
        }
        if (status.files === 0) {
          lines.push("", "This workspace has changed nothing yet. If its agent is idle, it may have misread the task — check its last message.");
        }
        if (result.text) {
          lines.push("", path ? `--- patch: ${path} ---` : "--- patch ---", result.text);
        }
        if (result.truncated) {
          lines.push(
            "",
            "[truncated] The patch above is incomplete. Call workspace_diff again with path=\"<one file from the list above>\" to read the rest; do not raise maxBytes.",
          );
        }
        return outcome(lines.join("\n"), { status, truncated: result.truncated });
      },
    },

    // ------------------------------------------------------------- verify --
    {
      definition: {
        name: "workspace_verify",
        label: "Verify workspace",
        loadMode: LOAD_MODE,
        description:
          "Run the project's tests or build inside a workspace's worktree and report the result. " +
          "Run this BEFORE workspace_merge, every time: reading a diff tells you what an agent wrote, not whether it works, and merging an unverified workspace is how a twelve-hour unattended run ends with a broken branch. " +
          "When comparing several candidates, verify all of them and prefer the one that is green over the one whose diff reads nicer. " +
          "A non-zero exit is a normal, useful answer, not a tool failure — the tail of the output comes back with it, and the fix is usually a workspace_prompt telling that agent what failed. " +
          "It runs only what the project declares — the `verify` list in .ompcode/workspace.json, else its package.json test / check / build script — or one npm script you name. " +
          "You cannot compose a shell command here; if nothing is configured the call comes back saying so, and the answer is to ask the human what proves this work, not to invent a command.",
        parameters: {
          type: "object",
          required: ["id"],
          additionalProperties: false,
          properties: {
            id: { type: "string", description: "Workspace id from workspace_create or workspace_list." },
            script: {
              type: "string",
              description:
                'The bare name of a script in that workspace\'s package.json to run instead of the project\'s configured verify command, e.g. "test", "lint", "test:unit". It is run as `npm run <script>`, so a full command line, arguments, pipes or a path are rejected. ' +
                "Omit it in almost every case: the project's own verify command is the one the repository says proves it, and naming a script that does not exist there only produces a red result that means nothing.",
            },
            timeoutSeconds: {
              type: "number",
              description:
                "Kill the command after this many seconds (default 600, minimum 1, maximum 3600; values outside that are clamped, never treated as 'no limit'). A timeout comes back as a normal result with timedOut set, not as an error.",
            },
          },
        },
      },
      async run(args, ctx) {
        const tool = "workspace_verify";
        const command = verifyCommand(args);
        const verifySeconds = seconds(tool, args, "timeoutSeconds", DEFAULT_VERIFY_SECONDS, MAX_VERIFY_SECONDS);
        ctx.sendUpdate(command ? `running ${command}…` : "running the project's verify command…");
        const result = await orchestrator.verify({
          id: requireString(tool, args, "id"),
          ...pick("command", command),
          timeoutMs: verifySeconds * 1000,
          signal: ctx.signal,
        });
        const lines = [
          `verify: ${result.ok ? "PASSED" : "FAILED"}`,
          `command: ${result.ran || "(none configured)"}`,
          `exit code: ${result.exitCode === null ? "none (killed)" : result.exitCode}`,
          `duration: ${duration(result.durationMs)}`,
          `timed out: ${result.timedOut ? "yes" : "no"}`,
        ];
        if (result.output) {
          lines.push("", "--- output (tail) ---", result.output);
        }
        lines.push("");
        if (result.ok) {
          lines.push("Green. This workspace is safe to merge once you have read its diff.");
        } else if (result.timedOut) {
          lines.push(
            "The command was killed on the timeout, so this is not proof of failure. Re-run with a larger timeoutSeconds, or name a narrower script, before judging the workspace.",
          );
        } else {
          lines.push(
            "Do not merge this workspace. Send its own agent a workspace_prompt quoting the failure above and telling it to fix it, then wait and verify again.",
          );
        }
        return outcome(lines.join("\n"), result);
      },
    },

    // -------------------------------------------------------------- merge --
    {
      definition: {
        name: "workspace_merge",
        label: "Merge workspace",
        loadMode: LOAD_MODE,
        description:
          "Merge a workspace's branch into the base branch it came from. Read its workspace_diff and get a green workspace_verify first. " +
          "A workspace whose changes CONFLICT with the base cannot be merged, and force does NOT change that — force only waives the refusals about the base branch having moved, the base checkout being dirty, or the worktree having uncommitted work. " +
          "When a merge is refused for conflicts it names the conflicting files: the fix is to send that workspace's own agent a workspace_prompt telling it to rebase onto the base branch and resolve those files, wait, verify, then merge again. Repeating the same merge call will fail identically. " +
          "Merge one winner, then delete the other candidates with workspace_delete.",
        parameters: {
          type: "object",
          required: ["id"],
          additionalProperties: false,
          properties: {
            id: { type: "string", description: "Workspace id from workspace_create or workspace_list." },
            strategy: {
              type: "string",
              enum: ["merge", "squash"],
              description:
                '"merge" (default) keeps the workspace\'s own commits and records the join with a merge commit. "squash" collapses everything it did into one commit on the base — usually nicer for a throwaway experiment.',
            },
            force: {
              type: "boolean",
              description:
                "Waive the refusals about a moved or dirty base and a dirty worktree. It does NOT resolve conflicts and will never get a conflicting workspace merged, so do not reach for it after a conflict.",
            },
            commitMessage: {
              type: "string",
              description:
                "Subject line for the merge or squash commit. Write what the change does, not which agent produced it. Omit for a generated message.",
            },
          },
        },
      },
      async run(args) {
        const tool = "workspace_merge";
        const result = await orchestrator.merge({
          id: requireString(tool, args, "id"),
          ...pick("strategy", optionalEnum(tool, args, "strategy", MERGE_STRATEGIES)),
          ...pick("force", optionalBoolean(tool, args, "force")),
          ...pick("commitMessage", optionalString(tool, args, "commitMessage")),
        });
        const lines = [
          `merged: ${result.merged ? "yes" : "no"}`,
          `strategy: ${result.strategy}`,
        ];
        if (result.commit) lines.push(`commit: ${result.commit}`);
        if (result.stashed) lines.push("stash: the base checkout's uncommitted work was stashed during the merge");
        lines.push(`details: ${result.message}`);
        if (result.conflictingFiles.length > 0) {
          lines.push(
            `conflicts: ${result.conflictingFiles.join(", ")}`,
            "",
            "This cannot be forced through. Send this workspace's agent a workspace_prompt telling it to rebase onto the base branch and resolve exactly those files, then wait, verify and merge again.",
          );
        } else if (result.merged) {
          lines.push("", "Landed. Delete the losing candidates with workspace_delete so the board stays readable.");
        }
        return outcome(lines.join("\n"), result);
      },
    },

    // ------------------------------------------------------------- delete --
    {
      definition: {
        name: "workspace_delete",
        label: "Delete workspace",
        loadMode: LOAD_MODE,
        description:
          "Throw a workspace away: stop its agent and remove its worktree. Use it on the candidates that lost after you merged a winner, or on a workspace whose approach turned out wrong. " +
          "Without force this REFUSES when the workspace still holds work that is not on the base branch, which is the safety net against deleting the run you meant to keep — if it refuses, read workspace_diff and decide deliberately. " +
          "That is the ONLY refusal: a workspace whose agent is mid-turn but has written nothing yet is deleted without a word, killing it. Check its state with workspace_list first, and never delete a workspace you have not waited for. " +
          "Anything unmerged is gone for good once you pass force.",
        parameters: {
          type: "object",
          required: ["id"],
          additionalProperties: false,
          properties: {
            id: { type: "string", description: "Workspace id from workspace_create or workspace_list." },
            deleteBranch: {
              type: "boolean",
              description:
                "Also delete the git branch, losing its commits. Leave it off to keep the branch for a later look; the worktree directory goes either way.",
            },
            force: {
              type: "boolean",
              description:
                "Delete even though the workspace holds unmerged work. That refusal is the only one it waives — a running agent is stopped and its worktree removed with or without this flag. Irreversible: pass it only after you have seen the diff, or when this workspace is a candidate you already decided against.",
            },
          },
        },
      },
      async run(args) {
        const tool = "workspace_delete";
        const id = requireString(tool, args, "id");
        const deleteBranch = optionalBoolean(tool, args, "deleteBranch");
        await orchestrator.remove({
          id,
          ...pick("deleteBranch", deleteBranch),
          ...pick("force", optionalBoolean(tool, args, "force")),
        });
        return outcome(
          `deleted: ${id}\nbranch: ${deleteBranch ? "deleted too" : "kept"}\n\nThe worktree is gone. Call workspace_list to see what remains.`,
          { id, deleteBranch: deleteBranch ?? false },
        );
      },
    },
  ];
  return handlers;
}

/**
 * Build `{ key: value }` only when the value is present.
 *
 * The orchestrator's option objects distinguish "absent" from "undefined" in
 * places (a spread `undefined` would override a default), and
 * `exactOptionalPropertyTypes`-style discipline is easier to keep with one
 * helper than with eight ternaries per call site.
 */
function pick<K extends string, V>(key: K, value: V | undefined): Record<K, V> | Record<string, never> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

// ---------------------------------------------------------------------------
// The bridge
// ---------------------------------------------------------------------------

interface PendingCall {
  toolName: string;
  controller: AbortController;
  /** Guards the "exactly one result per id" rule against every path that ends a call. */
  settled: boolean;
}

/** Human-readable, stack-free. A stack in a tool result is noise the model cannot act on. */
function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message || err.name || "unknown error";
  }
  if (typeof err === "string" && err.trim() !== "") return err;
  try {
    return JSON.stringify(err) ?? "unknown error";
  } catch {
    return "unknown error";
  }
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

export class HostToolBridge {
  private readonly handlers = new Map<string, HostToolHandler>();
  private readonly io: HostToolIo;
  private readonly calls = new Map<string, PendingCall>();
  private disposed = false;

  constructor(handlers: HostToolHandler[], io: HostToolIo) {
    this.io = io;
    for (const handler of handlers) {
      this.handlers.set(handler.definition.name, handler);
    }
  }

  /** What goes into `set_host_tools`. */
  definitions(): RpcHostToolDefinitionLike[] {
    return [...this.handlers.values()].map((handler) => handler.definition);
  }

  /**
   * Start one tool call. Never throws, never returns a promise, and always
   * ends in exactly one `host_tool_result` — see the file header for why that
   * is the one invariant worth defending here.
   */
  handleCall(frame: HostToolCallFrame): void {
    const id = typeof frame?.id === "string" ? frame.id : "";
    const toolName = typeof frame?.toolName === "string" ? frame.toolName : "";
    if (!id) {
      // Nothing to answer to: without an id there is no frame omp can match a
      // result against. Log it so the failure is visible somewhere.
      this.log(`host tool call with no id (tool ${toolName || "?"}), ignored`);
      return;
    }
    if (this.disposed) {
      this.send(id, `This editor session is shutting down, so "${toolName}" was not run.`, true);
      return;
    }
    if (this.calls.has(id)) {
      // Two frames sharing an id would make "exactly one result" ambiguous.
      // The first call keeps the id; the duplicate is answered immediately.
      this.log(`duplicate host tool call id ${id} (${toolName}), rejected`);
      this.send(id, `A tool call with id ${id} is already running; the duplicate was ignored.`, true);
      return;
    }

    const handler = this.handlers.get(toolName);
    if (!handler) {
      const known = [...this.handlers.keys()].join(", ");
      this.send(
        id,
        `Unknown tool "${toolName || "(none)"}". The tools this host provides are: ${known}. ` +
          "Call one of those, spelled exactly as listed.",
        true,
      );
      return;
    }

    const call: PendingCall = { toolName, controller: new AbortController(), settled: false };
    this.calls.set(id, call);
    this.log(`host tool ${toolName} started (${id})`);

    const ctx: HostToolContext = {
      signal: call.controller.signal,
      sendUpdate: (text: string) => {
        if (call.settled || typeof text !== "string" || text === "") return;
        this.post({
          type: "host_tool_update",
          id,
          partialResult: { content: [{ type: "text", text }] },
        });
      },
    };

    // `Promise.resolve().then(...)` rather than a bare call: a handler that
    // throws *synchronously* before its first await would otherwise escape
    // past `.catch` and leave the call unanswered.
    Promise.resolve()
      .then(() => handler.run({ ...(frame.arguments ?? {}) }, ctx))
      .then(
        (result) => {
          this.settle(id, result.text, result.isError === true, result.details);
        },
        (err: unknown) => {
          if (isAbort(err)) {
            this.settle(id, this.cancelText(toolName), true);
            return;
          }
          this.log(`host tool ${toolName} failed (${id}): ${describeError(err)}`);
          this.settle(id, `${toolName} failed: ${describeError(err)}`, true);
        },
      );
  }

  /**
   * omp asking us to stop a call. The abort is best-effort — a handler that
   * ignores its signal keeps running — so the result is sent right away rather
   * than waiting for the handler to notice.
   */
  handleCancel(frame: HostToolCancelFrame): void {
    const targetId = typeof frame?.targetId === "string" ? frame.targetId : "";
    const call = targetId ? this.calls.get(targetId) : undefined;
    if (!call) {
      this.log(`host tool cancel for unknown id ${targetId || "?"}, ignored`);
      return;
    }
    this.log(`host tool ${call.toolName} cancelled (${targetId})`);
    call.controller.abort();
    this.settle(targetId, this.cancelText(call.toolName), true);
  }

  /**
   * The agent that could have received these results is gone; settle every
   * call in flight and keep the bridge usable.
   *
   * Distinct from {@link dispose} on purpose. A session restarts its omp
   * process (crash, `restart`, model switch) and re-registers the same bridge
   * on the next handshake, so the teardown that runs on *process* death must
   * not be the permanent one — a bridge left `disposed` would answer every
   * later call with "shutting down" for the rest of the window.
   */
  abortAll(reason: string): void {
    for (const [id, call] of [...this.calls]) {
      call.controller.abort();
      this.settle(id, this.abortText(call.toolName, reason), true);
    }
    this.calls.clear();
  }

  /**
   * Abort and answer everything still in flight; further calls are refused.
   *
   * The end of the bridge's life, not of one agent process — see
   * {@link abortAll} for the recoverable case.
   */
  dispose(): void {
    this.disposed = true;
    for (const [id, call] of [...this.calls]) {
      call.controller.abort();
      this.settle(id, this.cancelText(call.toolName), true);
    }
    this.calls.clear();
  }

  /** How many calls are still open; for tests and for the output channel. */
  get pending(): number {
    return this.calls.size;
  }

  /**
   * Why a call died with the agent. Says the same reassuring thing as
   * {@link cancelText} — work already started elsewhere outlives this session's
   * process — but names the reason, so the model can tell a crash from a
   * deliberate cancel.
   */
  private abortText(toolName: string, reason: string): string {
    return (
      `${toolName} could not finish because ${reason}, so it has no result. ` +
      "Nothing was undone: any workspace it created or messaged is still there and any agent it started is still running. " +
      "Call workspace_list to see the current state before deciding what to do next."
    );
  }

  private cancelText(toolName: string): string {
    return (
      `${toolName} was cancelled before it finished, so it has no result. ` +
      "Nothing was undone: any workspace it created or messaged is still there and any agent it started is still running. " +
      "Call workspace_list to see the current state before deciding what to do next."
    );
  }

  /**
   * The single exit from a *registered* call: at most one result per id, ever.
   *
   * Membership in `calls` is the ledger. A cancel settles and forgets the id,
   * so when the handler it could not actually stop resolves a minute later
   * there is nothing left to answer and the late outcome is dropped — omp has
   * already moved on, and a second result for the same id would be worse than
   * none. Paths that never registered a call (unknown tool, duplicate id,
   * disposed bridge) answer through {@link send} directly instead.
   */
  private settle(id: string, text: string, isError: boolean, details?: unknown): void {
    const call = this.calls.get(id);
    if (!call || call.settled) {
      return;
    }
    call.settled = true;
    this.calls.delete(id);
    this.send(id, text, isError, details);
  }

  private send(id: string, text: string, isError: boolean, details?: unknown): void {
    const result: Record<string, unknown> = { content: [{ type: "text", text }] };
    if (details !== undefined) {
      result["details"] = details;
    }
    this.post({ type: "host_tool_result", id, result, isError });
  }

  /**
   * A dead stdin must not take the extension with it, and it must not stop the
   * remaining pending calls from being settled either.
   */
  private post(msg: Record<string, unknown>): void {
    try {
      this.io.send(msg);
    } catch (err) {
      this.log(`failed to send ${String(msg["type"])}: ${describeError(err)}`);
    }
  }

  private log(message: string): void {
    try {
      this.io.output.appendLine(`[omp] ${message}`);
    } catch {
      // An output channel that throws is not worth crashing a tool call over.
    }
  }
}
