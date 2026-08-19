import { spawn, type ChildProcess } from "node:child_process";
import { resolveLaunch } from "./winLaunch.ts";

/** A single NDJSON frame received from (or sent to) the omp CLI. */
export interface OmpFrame {
  type?: string;
  id?: string;
  [key: string]: unknown;
}

export interface OmpStartOptions {
  /** Path or name of the omp binary. */
  ompPath: string;
  /** Working directory for the agent (also passed as --cwd). */
  cwd: string;
  /** Full environment for the child process. */
  env: NodeJS.ProcessEnv;
  /** ompcode.approvalMode — always passed as --approval-mode (see start()). */
  approvalMode: string;
  /** Extra CLI flags appended verbatim (used by the model prober). */
  extraArgs?: string[];
}

interface PendingRequest {
  command: string;
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | undefined;
}

interface ChunkBuffer {
  count: number;
  parts: Map<number, string>;
  timer: ReturnType<typeof setTimeout> | undefined;
}
const REQUEST_TIMEOUT_MS = 60_000;
/** A chunk set that doesn't fully arrive within this window is dropped. */
const CHUNK_TIMEOUT_MS = 30_000;

/**
 * Manages one `omp --mode rpc-ui` child process: NDJSON framing over stdio,
 * id-correlated request/response, rpc_chunk reassembly, and event fan-out.
 */
export class OmpProcess {
  private proc: ChildProcess | undefined;
  private stdoutBuffer = "";
  private nextId = 1;
  private stopped = false;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly chunks = new Map<string, ChunkBuffer>();
  private readonly frameHandlers: Array<(frame: OmpFrame) => void> = [];
  private readonly stderrHandlers: Array<(text: string) => void> = [];
  private readonly exitHandlers: Array<
    (code: number | null, signal: NodeJS.Signals | null) => void
  > = [];
  private readonly errorHandlers: Array<(err: NodeJS.ErrnoException) => void> = [];

  /** True while the child process is alive and stop() has not been called. */
  get running(): boolean {
    return (
      this.proc !== undefined &&
      this.proc.exitCode === null &&
      this.proc.signalCode === null &&
      !this.stopped
    );
  }

  /** Register a callback for every non-response frame (events + ui requests). */
  onFrame(cb: (frame: OmpFrame) => void): void {
    this.frameHandlers.push(cb);
  }

  /** Register a callback for raw stderr text. */
  onStderr(cb: (text: string) => void): void {
    this.stderrHandlers.push(cb);
  }

  /** Register a callback for process exit (code/signal). */
  onExit(cb: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitHandlers.push(cb);
  }

  /** Register a callback for spawn/process errors (e.g. ENOENT). */
  onError(cb: (err: NodeJS.ErrnoException) => void): void {
    this.errorHandlers.push(cb);
  }

  /** Spawn the omp process and wire up stdio handling. */
  start(opts: OmpStartOptions): void {
    if (this.proc) {
      throw new Error("OmpProcess already started");
    }
    this.stopped = false;
    this.stdoutBuffer = "";
    this.chunks.clear();

    const args = ["--mode", "rpc-ui", "--cwd", opts.cwd];
    // Always passed, including "always-ask". omp's own default for
    // `tools.approvalMode` is `yolo`, so omitting the flag does not mean
    // "ask" — it silently auto-approves reads, writes and shell commands.
    if (opts.approvalMode) {
      args.push("--approval-mode", opts.approvalMode);
    }
    if (opts.extraArgs?.length) {
      args.push(...opts.extraArgs);
    }

    // On Windows a global install can be a batch shim that CreateProcess
    // refuses to run; resolveLaunch reroutes those through cmd.exe and leaves
    // every other platform alone.
    const target = resolveLaunch({ file: opts.ompPath, args, env: opts.env });
    if (target.problem) {
      const err: NodeJS.ErrnoException = new Error(target.problem);
      err.code = "EINVAL";
      // Reported like a spawn failure so the host's existing error path shows
      // it; spawn errors are async, so this one is too.
      queueMicrotask(() => {
        this.failAllPending(new Error(target.problem as string));
        for (const cb of this.errorHandlers) {
          cb(err);
        }
      });
      return;
    }

    const proc = spawn(target.file, target.args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsVerbatimArguments: target.windowsVerbatimArguments,
    });
    this.proc = proc;

    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => {
      this.onStdoutData(chunk);
    });

    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => {
      for (const cb of this.stderrHandlers) {
        cb(chunk);
      }
    });

    // Ignore EPIPE when writing to a process that just died; the exit
    // handler reports the failure to the host.
    proc.stdin?.on("error", () => {
      /* noop */
    });

    proc.on("error", (err: NodeJS.ErrnoException) => {
      this.failAllPending(new Error(`omp process error: ${err.message}`));
      for (const cb of this.errorHandlers) {
        cb(err);
      }
    });

    proc.on("exit", (code, signal) => {
      this.failAllPending(
        new Error(
          `omp process exited (code ${code ?? "null"}, signal ${signal ?? "null"})`,
        ),
      );
      this.stdoutBuffer = "";
      this.clearChunks();
      for (const cb of this.exitHandlers) {
        cb(code, signal);
      }
    });
  }

  /**
   * Send a command and resolve with `data` of the matching response frame.
   * Rejects with the response `error` when `success` is false.
   * 60s timeout for every command except `prompt` and `login`
   * (no timeout — prompts stream and OAuth waits on the browser).
   */
  request(cmd: Record<string, unknown>): Promise<unknown> {
    if (!this.running) {
      return Promise.reject(new Error("omp process is not running"));
    }
    const id = `r${this.nextId++}`;
    const command = typeof cmd.type === "string" ? cmd.type : "unknown";
    return new Promise<unknown>((resolve, reject) => {
      const timer =
        command === "prompt" || command === "login"
          ? undefined
          : setTimeout(() => {
              this.pending.delete(id);
              reject(
                new Error(
                  `omp command "${command}" timed out after ${REQUEST_TIMEOUT_MS / 1000}s`,
                ),
              );
            }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { command, resolve, reject, timer });
      this.writeLine({ ...cmd, id });
    });
  }

  /** Fire-and-forget write (extension_ui_response, abort, …). */
  send(frame: Record<string, unknown>): void {
    if (this.running) {
      this.writeLine(frame);
    }
  }

  /** Kill the process and reject any in-flight requests. */
  stop(): void {
    this.stopped = true;
    this.failAllPending(new Error("omp process stopped"));
    this.stdoutBuffer = "";
    this.clearChunks();
    const proc = this.proc;
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      try {
        proc.kill();
      } catch {
        /* already dead */
      }
    }
  }

  private writeLine(obj: Record<string, unknown>): void {
    try {
      this.proc?.stdin?.write(JSON.stringify(obj) + "\n");
    } catch {
      /* stdin gone — exit handler will report */
    }
  }

  private onStdoutData(chunk: string): void {
    this.stdoutBuffer += chunk;
    let nl = this.stdoutBuffer.indexOf("\n");
    while (nl !== -1) {
      const line = this.stdoutBuffer.slice(0, nl);
      this.stdoutBuffer = this.stdoutBuffer.slice(nl + 1);
      nl = this.stdoutBuffer.indexOf("\n");
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let frame: unknown;
      try {
        frame = JSON.parse(trimmed);
      } catch {
        continue; // ignore unparseable lines per protocol
      }
      if (typeof frame === "object" && frame !== null) {
        this.handleFrame(frame as OmpFrame);
      }
    }
  }

  private handleFrame(frame: OmpFrame): void {
    if (frame.type === "rpc_chunk") {
      this.handleChunk(frame);
      return;
    }
    if (frame.type === "response") {
      const id = typeof frame.id === "string" ? frame.id : undefined;
      if (id === undefined) {
        return;
      }
      const req = this.pending.get(id);
      if (!req) {
        return;
      }
      this.pending.delete(id);
      if (req.timer !== undefined) {
        clearTimeout(req.timer);
      }
      if (frame.success === false) {
        const errVal = frame.error;
        const message =
          typeof errVal === "string"
            ? errVal
            : errVal !== undefined && errVal !== null
              ? JSON.stringify(errVal)
              : `omp command "${req.command}" failed`;
        req.reject(new Error(message));
      } else {
        req.resolve(frame.data);
      }
      return; // response frames are never forwarded
    }
    for (const cb of this.frameHandlers) {
      cb(frame);
    }
  }

  private handleChunk(frame: OmpFrame): void {
    const chunkId =
      typeof frame.chunkId === "string" || typeof frame.chunkId === "number"
        ? String(frame.chunkId)
        : "";
    const index = typeof frame.index === "number" ? frame.index : NaN;
    const count = typeof frame.count === "number" ? frame.count : NaN;
    const data = typeof frame.data === "string" ? frame.data : "";
    if (!chunkId || !Number.isInteger(index) || !Number.isInteger(count) || count <= 0) {
      return;
    }
    let buf = this.chunks.get(chunkId);
    if (!buf) {
      buf = {
        count,
        parts: new Map<number, string>(),
        timer: setTimeout(() => {
          this.chunks.delete(chunkId);
        }, CHUNK_TIMEOUT_MS),
      };
      this.chunks.set(chunkId, buf);
    }
    buf.parts.set(index, data);
    if (buf.parts.size < buf.count) {
      return;
    }
    clearTimeout(buf.timer);
    buf.timer = undefined;
    this.chunks.delete(chunkId);
    // Concatenate the raw string slices in index order, then JSON.parse.
    // (Spec: "concat data of all parts in index order, then JSON.parse".)
    let joined = "";
    for (let i = 0; i < buf.count; i++) {
      joined += buf.parts.get(i) ?? "";
    }
    let inner: unknown;
    try {
      inner = JSON.parse(joined);
    } catch {
      return; // malformed reassembly — drop
    }
    if (typeof inner === "object" && inner !== null) {
      this.handleFrame(inner as OmpFrame);
    }
  }

  private failAllPending(err: Error): void {
    for (const req of this.pending.values()) {
      clearTimeout(req.timer);
      req.reject(err);
    }
    this.pending.clear();
  }

  /** Drop all in-flight chunk buffers and clear their TTL timers. */
  private clearChunks(): void {
    for (const buf of this.chunks.values()) {
      clearTimeout(buf.timer);
    }
    this.chunks.clear();
  }
}
