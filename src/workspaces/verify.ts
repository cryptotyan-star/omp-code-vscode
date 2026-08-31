/**
 * The green gate in front of a merge: run a workspace's own test or build
 * command inside its worktree and report how it went.
 *
 * An orchestrating model merges branches it has never executed. Reading a diff
 * tells it the shape of a change, never whether the change works, so without a
 * gate the only signal is the agent's own claim that it is done — and that
 * claim is exactly what needs checking. `runVerify` is that check, and it is
 * deliberately dumb: it runs one shell command and reports the exit code.
 *
 * Two things it must not do:
 *
 *  - **Guess the command.** A wrong guess (`npm test` in a repo with no tests,
 *    a script that starts a dev server and never returns) burns ten minutes and
 *    then reports a failure that is not one. Only the explicit `verify` field
 *    and the three conventional script names below are consulted; anything else
 *    is `undefined`, which the caller can surface as "tell me what to run".
 *  - **Leak processes.** A verify command is usually a script that spawns more
 *    processes, and killing only the shell on timeout orphans them: a `vitest
 *    --watch` left behind holds a port and every later verify in that worktree
 *    fails for a reason nobody can see. So the child is put in its own process
 *    group and the *group* is signalled.
 *
 * Free of `vscode` like the rest of `src/workspaces/`, so `node --test` can run
 * it directly.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readWorkspaceConfig } from "./setup.ts";

export interface VerifyResult {
  ok: boolean;
  /** The command line that was executed; empty when there was nothing to run. */
  ran: string;
  /** `null` when the process was killed by a signal, or never started. */
  exitCode: number | null;
  durationMs: number;
  /** The *tail* of the combined output, with a marker when it was cut. */
  output: string;
  timedOut: boolean;
}

export interface RunVerifyOptions {
  timeoutMs?: number;
  maxOutputBytes?: number;
  signal?: AbortSignal;
}

/**
 * Ten minutes. A full `npm ci && npm test` in a cold worktree really can take
 * that long, and a gate that gives up early teaches the orchestrator to skip
 * verification.
 */
const DEFAULT_TIMEOUT_MS = 600_000;

/** Enough tail to hold a test runner's failure summary, not its whole log. */
const DEFAULT_MAX_OUTPUT_BYTES = 16_384;

/** How long a timed-out process gets to die politely before SIGKILL. */
const KILL_GRACE_MS = 5_000;

/**
 * How long after the SIGKILL we still wait for `close`.
 *
 * `close` fires when the *pipes* are drained, and a pipe is held by whoever
 * inherited it — not only by the child we killed. A descendant that survives
 * (a process the kill could not reach, or one wedged in uninterruptible I/O)
 * keeps stdout open and `close` never comes. One second is far longer than a
 * killed group needs, so reaching this deadline means the pipe is stuck, and a
 * stuck pipe must not hold the caller's promise open forever.
 */
const HARD_SETTLE_MS = 1_000;

/**
 * The only script names worth assuming. `test` first because it is the one
 * that actually proves something; `build` last because compiling is the
 * weakest of the three signals.
 */
const SCRIPT_PREFERENCE = ["test", "check", "build"] as const;

const NO_COMMAND_MESSAGE =
  "No verify command is configured for this workspace. Set `verify` in .ompcode/workspace.json, " +
  "add a `test`, `check` or `build` script to package.json, or pass an explicit command.";

/** `undefined` for a missing, unreadable or malformed package.json. */
async function readPackageScripts(worktreePath: string): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await fs.readFile(path.join(worktreePath, "package.json"), "utf8");
  } catch {
    return undefined;
  }
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    // A package.json we cannot parse is not our problem to report here: the
    // caller just learns there is no command to run.
    return undefined;
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return undefined;
  }
  const scripts = (json as Record<string, unknown>)["scripts"];
  if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) {
    return undefined;
  }
  return scripts as Record<string, unknown>;
}

interface VerifyTarget {
  /** `undefined` when the repo declares nothing worth running. */
  command: string | undefined;
  /** Absolute directory the command belongs in. */
  cwd: string;
}

/**
 * What this worktree says should be run to prove itself, and where.
 *
 * The workspace config wins, because it travels with the branch and is the
 * only place a human can state the intent. `npm run <name>` rather than a
 * package-manager guess: pnpm and yarn both honour it, and picking the "right"
 * manager from a lockfile is exactly the kind of guess that fails silently in
 * a monorepo.
 *
 * `cwd` is resolved the same way `runSetup` resolves it (setupRun.ts), because
 * a monorepo that installs its dependencies in `packages/app` must run its
 * tests there too: verifying in the worktree root would fail with "no test
 * specified" and the orchestrator would read that as broken work.
 */
async function resolveVerifyTarget(worktreePath: string): Promise<VerifyTarget> {
  const { config } = await readWorkspaceConfig(worktreePath);
  const cwd = config.cwd ? path.resolve(worktreePath, config.cwd) : worktreePath;
  if (config.verify && config.verify.length > 0) {
    // Joined with `&&` for the same reason setup is: a failing step must stop
    // the ones after it, or the gate goes green on a broken tree.
    return { command: config.verify.join(" && "), cwd };
  }
  // The package.json that matters is the one beside the code, not the one at
  // the root of a monorepo whose scripts belong to the workspace tooling.
  const scripts = await readPackageScripts(cwd);
  if (scripts) {
    for (const name of SCRIPT_PREFERENCE) {
      const body = scripts[name];
      if (typeof body === "string" && body.trim().length > 0) {
        return { command: `npm run ${name}`, cwd };
      }
    }
  }
  return { command: undefined, cwd };
}

/** The command this worktree declares, or `undefined` — never a guess. */
export async function detectVerifyCommand(worktreePath: string): Promise<string | undefined> {
  return (await resolveVerifyTarget(worktreePath)).command;
}

/**
 * A bounded ring of the most recent output bytes.
 *
 * Bytes, not characters: the limit is a memory bound and a test runner can
 * print megabytes. Dropping from the front can split a multi-byte character,
 * so the leading continuation bytes are trimmed before decoding rather than
 * left to become a stray U+FFFD at the very start of the excerpt.
 */
class OutputTail {
  private readonly chunks: Buffer[] = [];
  private readonly limit: number;
  private size = 0;
  private dropped = false;

  // A plain field rather than a parameter property: `node --experimental-strip-types`
  // runs these modules in the tests, and it refuses parameter properties.
  constructor(limit: number) {
    this.limit = limit;
  }

  push(chunk: Buffer): void {
    if (this.limit <= 0) {
      this.dropped = this.dropped || chunk.length > 0;
      return;
    }
    this.chunks.push(chunk);
    this.size += chunk.length;
    while (this.size > this.limit) {
      const first = this.chunks[0]!;
      const excess = this.size - this.limit;
      if (first.length <= excess) {
        this.chunks.shift();
        this.size -= first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.size -= excess;
      }
      this.dropped = true;
    }
  }

  text(): string {
    let buffer = Buffer.concat(this.chunks, this.size);
    if (this.dropped) {
      let start = 0;
      while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) {
        start += 1;
      }
      buffer = buffer.subarray(start);
    }
    const body = buffer.toString("utf8");
    if (!this.dropped) {
      return body;
    }
    return `[output truncated — showing the last ${this.limit} bytes]\n${body}`;
  }
}

/**
 * Signal the child *and everything it started*.
 *
 * On POSIX the child is spawned detached, which makes it a process-group
 * leader; its descendants inherit that group, so a negative pid reaches all of
 * them. Windows has no process groups worth the name — `taskkill /T` walks the
 * job tree instead, and there is no polite variant, so the grace period is a
 * no-op there.
 *
 * Deliberately *not* guarded on the child being alive. A group outlives its
 * leader: the common shape of a leaked tree is a shell that took the SIGTERM
 * and died while the descendant it started ignored it, so `child.exitCode` is
 * already set exactly when the escalation to SIGKILL is the thing that matters.
 * Guarding on it made that escalation dead code. Callers must instead stop
 * signalling once `close` has fired — after that the pid may have been reused,
 * and there is nothing of ours left in that group anyway.
 */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }
  try {
    if (process.platform === "win32") {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
      killer.on("error", () => {
        /* nothing left to try */
      });
      return;
    }
    process.kill(-pid, signal);
  } catch {
    // The group may already be gone, or we may never have got one (a spawn
    // that failed). Falling back to the single child is strictly better than
    // leaving it running.
    try {
      child.kill(signal);
    } catch {
      /* already dead */
    }
  }
}

/**
 * Run the verify command in `worktreePath` and collect the tail of its output.
 *
 * Never rejects: a verify that could not run is a red gate with an
 * explanation, not an exception for the caller to translate. The environment
 * is inherited, because the command is the repo's own and expects the PATH,
 * NVM shims and tokens the user has.
 */
export async function runVerify(
  worktreePath: string,
  command?: string,
  opts: RunVerifyOptions = {},
): Promise<VerifyResult> {
  const started = Date.now();
  const explicit = command?.trim();
  // Read the config even for an explicit command: the caller supplies *what* to
  // run, the repo still says *where*.
  const target = await resolveVerifyTarget(worktreePath);
  const resolved = explicit && explicit.length > 0 ? explicit : target.command;
  if (!resolved) {
    return {
      ok: false,
      ran: "",
      exitCode: null,
      durationMs: Date.now() - started,
      output: NO_COMMAND_MESSAGE,
      timedOut: false,
    };
  }

  // A zero, negative or non-finite timeout is a caller's rounding accident, not
  // a request for an unbounded build: the whole point of this gate is that a
  // model-spawned process cannot run forever, so it falls back to the default.
  const requested = opts.timeoutMs;
  const timeoutMs =
    typeof requested === "number" && Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_TIMEOUT_MS;
  const tail = new OutputTail(opts.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES);

  return await new Promise<VerifyResult>((resolve) => {
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let killing = false;
    let timer: NodeJS.Timeout | undefined;
    let grace: NodeJS.Timeout | undefined;
    let hardStop: NodeJS.Timeout | undefined;

    const finish = (result: Omit<VerifyResult, "ran" | "durationMs">) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      clearTimeout(hardStop);
      opts.signal?.removeEventListener("abort", onAbort);
      resolve({ ...result, ran: resolved, durationMs: Date.now() - started });
    };

    if (opts.signal?.aborted) {
      finish({ ok: false, exitCode: null, output: "Verification was cancelled before it started.", timedOut: false });
      return;
    }

    let child: ChildProcess;
    try {
      child = spawn(resolved, {
        cwd: target.cwd,
        // A verify command is written to be typed at a prompt: it uses `&&`,
        // pipes and shell builtins, so it needs a shell rather than argv.
        shell: true,
        // Its own process group, so a timeout can take the whole tree down.
        detached: process.platform !== "win32",
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      finish({
        ok: false,
        exitCode: null,
        output: `Could not start the verify command: ${(err as Error).message}`,
        timedOut: false,
      });
      return;
    }

    /** Everything that has been captured, prefixed with why the run ended. */
    const excerpt = (...notes: string[]): string => {
      const parts = [...notes];
      const body = tail.text();
      if (body.length > 0) {
        parts.push(body);
      }
      return parts.join("\n");
    };

    const reason = (): string =>
      timedOut ? `[timed out after ${timeoutMs} ms — the process tree was killed]` : "[cancelled — the process tree was killed]";

    /**
     * Take the tree down and guarantee the promise settles.
     *
     * SIGTERM, then SIGKILL for whatever ignored it, then a hard deadline:
     * `close` waits on the stdio pipes, and a descendant we could not reach
     * still holds them, so waiting for `close` alone is how this call used to
     * hang forever. Idempotent, because an abort landing on top of a timeout
     * (or the reverse) must not arm a second pair of timers.
     */
    const killAndSettle = (): void => {
      if (killing || settled) {
        return;
      }
      killing = true;
      killTree(child, "SIGTERM");
      grace = setTimeout(() => {
        // `close` has already told us nothing of ours is left in that group,
        // and the pid may have been reused by then — never signal after it.
        if (settled) {
          return;
        }
        killTree(child, "SIGKILL");
        hardStop = setTimeout(() => {
          if (settled) {
            return;
          }
          // Let go of the pipes as well, or their handles keep this process's
          // event loop alive long after the caller has its answer.
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish({
            ok: false,
            exitCode: null,
            output: excerpt(reason(), "[its output pipes never closed, so this is the output captured up to that point]"),
            timedOut,
          });
        }, HARD_SETTLE_MS);
        hardStop.unref?.();
      }, KILL_GRACE_MS);
      grace.unref?.();
    };

    function onAbort(): void {
      aborted = true;
      killAndSettle();
    }
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    // stdout and stderr share one tail on purpose: a build's error line and the
    // command that provoked it are on different streams, and separating them
    // loses the ordering that makes the excerpt readable.
    child.stdout?.on("data", (chunk: Buffer) => tail.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => tail.push(chunk));

    timer = setTimeout(() => {
      timedOut = true;
      killAndSettle();
    }, timeoutMs);
    timer.unref?.();

    child.once("error", (err: Error) => {
      finish({
        ok: false,
        exitCode: null,
        output: `Could not start the verify command: ${err.message}\n${tail.text()}`.trimEnd(),
        timedOut,
      });
    });

    // `close` rather than `exit`: the pipes must be drained first, or the
    // failure that explains the exit code is missing from the excerpt.
    child.once("close", (code: number | null) => {
      finish({
        ok: !timedOut && !aborted && code === 0,
        exitCode: code,
        output: timedOut || aborted ? excerpt(reason()) : excerpt(),
        timedOut,
      });
    });
  });
}
