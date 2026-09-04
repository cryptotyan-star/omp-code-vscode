/**
 * Listening-port detection: which TCP ports the processes running inside a
 * workspace's terminals are listening on, refreshed on a timer and attributed
 * back to a workspace through its process tree.
 *
 * This file deliberately imports `vscode` at the type level only. The parsers
 * and the pid-tree walk are the risky part of the feature and they are
 * unit-tested by plain `node --test` outside the extension host, where the
 * `vscode` module does not exist — a runtime import here would make that
 * impossible. The private `Emitter` below exists for the same reason: it is a
 * minimal stand-in for `vscode.EventEmitter` whose `.event` still satisfies
 * `vscode.Event<T>` for the extension-side consumers.
 */

import { execFile as execFileCb } from "node:child_process";
import * as fs from "node:fs/promises";
import { promisify } from "node:util";
import type * as vscode from "vscode";

const execFile = promisify(execFileCb);

/** See the module doc: a host-free `vscode.EventEmitter` replacement. */
class Emitter<T> {
  private readonly listeners = new Set<(e: T) => unknown>();

  readonly event: vscode.Event<T> = (listener, thisArgs?, disposables?) => {
    const bound = thisArgs === undefined ? listener : listener.bind(thisArgs);
    this.listeners.add(bound);
    const disposable = {
      dispose: () => {
        this.listeners.delete(bound);
      },
    };
    disposables?.push(disposable);
    return disposable;
  };

  fire(e: T): void {
    // Copy first: a listener disposing itself mid-fire must not skip others.
    for (const listener of [...this.listeners]) listener(e);
  }

  dispose(): void {
    this.listeners.clear();
  }
}

/** One TCP socket in LISTEN state, attributed to the pid that owns it. */
export interface ListeningPort {
  port: number;
  pid: number;
  /** The local address exactly as the source printed it, without the port. */
  address: string;
}

/**
 * Parse `lsof -a -p <pids> -iTCP -sTCP:LISTEN -P -n` output (macOS / Linux).
 * With `-P -n` the NAME column is a single token like `*:3000`, `[::1]:3000`
 * or `127.0.0.1:8000`, followed by `(LISTEN)`. Anything that does not look
 * like that — the header, truncated lines — is skipped, never thrown on.
 */
export function parseLsof(stdout: string): ListeningPort[] {
  const ports: ListeningPort[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.includes("(LISTEN)")) continue;
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) continue;
    const pid = Number(fields[1]);
    const name = fields[fields.length - 2];
    const cut = name.lastIndexOf(":");
    if (!Number.isInteger(pid) || cut < 0) continue;
    const port = Number(name.slice(cut + 1));
    if (!Number.isInteger(port)) continue;
    ports.push({ port, pid, address: name.slice(0, cut) });
  }
  return ports;
}

/**
 * Parse Windows `netstat -ano` output. Only `TCP` rows in `LISTENING` state
 * count; UDP rows have no state column and established rows are not servers.
 * The local address is `0.0.0.0:3000` or `[::]:3000`; the PID is last.
 */
export function parseNetstat(stdout: string): ListeningPort[] {
  const ports: ListeningPort[] = [];
  for (const line of stdout.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 5 || fields[0] !== "TCP" || fields[3] !== "LISTENING") continue;
    const local = fields[1];
    const cut = local.lastIndexOf(":");
    const pid = Number(fields[fields.length - 1]);
    if (cut < 0 || !Number.isInteger(pid)) continue;
    const port = Number(local.slice(cut + 1));
    if (!Number.isInteger(port)) continue;
    ports.push({ port, pid, address: local.slice(0, cut) });
  }
  return ports;
}

/**
 * The kernel writes /proc/net/tcp addresses as hex in little-endian 32-bit
 * words: `0100007F` is 127.0.0.1. IPv6 gets the same word-wise treatment;
 * rendering is best-effort (no zero compression), `::` for the wildcard.
 */
function hexToAddress(hex: string): string {
  if (hex.length === 8) {
    const bytes: number[] = [];
    for (let i = 6; i >= 0; i -= 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
    return bytes.join(".");
  }
  if (/^0+$/.test(hex)) return "::";
  const groups: string[] = [];
  for (let word = 0; word + 8 <= hex.length; word += 8) {
    const w = hex.slice(word, word + 8);
    const swapped = w.slice(6, 8) + w.slice(4, 6) + w.slice(2, 4) + w.slice(0, 2);
    groups.push(swapped.slice(0, 4), swapped.slice(4, 8));
  }
  return groups.map((g) => g.toLowerCase().replace(/^0+(?=.)/, "")).join(":");
}

/**
 * Parse `/proc/net/tcp` / `/proc/net/tcp6` (Linux fallback when lsof is not
 * installed). State hex `0A` is LISTEN. The row only names a socket inode;
 * ownership comes from `inodeToPid`, and rows whose inode is not in the map
 * belong to processes outside our workspaces — dropped.
 */
export function parseProcNetTcp(stdout: string, inodeToPid: Map<string, number>): ListeningPort[] {
  const ports: ListeningPort[] = [];
  for (const line of stdout.split("\n")) {
    const fields = line.trim().split(/\s+/);
    // Data rows start "0:", "1:", … — the header's first field is "sl".
    if (fields.length < 10 || !/^\d+:$/.test(fields[0])) continue;
    if (fields[3].toUpperCase() !== "0A") continue;
    const cut = fields[1].lastIndexOf(":");
    if (cut < 0) continue;
    const port = parseInt(fields[1].slice(cut + 1), 16);
    if (!Number.isInteger(port)) continue;
    const pid = inodeToPid.get(fields[9]);
    if (pid === undefined) continue;
    ports.push({ port, pid, address: hexToAddress(fields[1].slice(0, cut)) });
  }
  return ports;
}

/** Parse `ps -eo pid,ppid` into pid → ppid, tolerating ragged whitespace. */
export function parsePsTree(stdout: string): Map<number, number> {
  const map = new Map<number, number>();
  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) continue;
    map.set(Number(match[1]), Number(match[2]));
  }
  return map;
}

/**
 * The given roots plus every pid whose parent chain reaches one of them.
 * Walks child edges breadth-first with a visited set, so a corrupt tree
 * containing a pid cycle terminates instead of hanging.
 */
export function descendantsOf(roots: number[], parents: Map<number, number>): number[] {
  const children = new Map<number, number[]>();
  for (const [pid, ppid] of parents) {
    const list = children.get(ppid);
    if (list) list.push(pid);
    else children.set(ppid, [pid]);
  }
  const seen = new Set<number>();
  const queue = [...roots];
  for (let pid = queue.shift(); pid !== undefined; pid = queue.shift()) {
    if (seen.has(pid)) continue;
    seen.add(pid);
    const kids = children.get(pid);
    if (kids) queue.push(...kids);
  }
  return [...seen];
}

export interface PortScannerDeps {
  workspaceIds(): string[];
  rootPids(workspaceId: string): Promise<number[]>;
  output: { appendLine(s: string): void };
  /** Absent → the default ignore list below. */
  ignorePorts?(): number[];
}

const FAST_INTERVAL_MS = 2500;
const SLOW_INTERVAL_MS = 30000;
const BACKOFF_AFTER_MS = 60000;
/** ssh/http/https listeners are ambient noise, never a workspace dev server. */
const DEFAULT_IGNORED_PORTS = [22, 80, 443];

/** For a non-zero exit where the process still ran, its stdout; else nothing. */
function exitOutput(err: unknown): string | undefined {
  if (err && typeof err === "object" && "code" in err && "stdout" in err) {
    if (typeof err.code === "number" && typeof err.stdout === "string") return err.stdout;
  }
  return undefined;
}

/**
 * `wmic process get ParentProcessId,ProcessId` prints its columns in
 * alphabetical order, so each pair reads (ppid, pid) — the reverse of ps.
 */
function parseWmicTree(stdout: string): Map<number, number> {
  const map = new Map<number, number>();
  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) continue;
    map.set(Number(match[2]), Number(match[1]));
  }
  return map;
}

/** Ignore-filter, dedupe by port (a v4+v6 double listen shows once), sort. */
function normalize(ports: ListeningPort[], ignored: Set<number>): ListeningPort[] {
  const byPort = new Map<number, ListeningPort>();
  for (const port of ports) {
    if (ignored.has(port.port)) continue;
    if (!byPort.has(port.port)) byPort.set(port.port, port);
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

/** True when both lists name the same ports owned by the same pids, in order. */
function samePorts(a: ListeningPort[], b: ListeningPort[]): boolean {
  return a.length === b.length && a.every((p, i) => p.port === b[i].port && p.pid === b[i].pid);
}

/**
 * Polls the OS for listening sockets owned by workspace process trees. One
 * scan covers every workspace: a single ps + lsof (or netstat, or /proc read)
 * pair per tick, not one per workspace.
 */
export class PortScanner implements vscode.Disposable {
  private readonly emitter = new Emitter<{ workspaceId: string; ports: ListeningPort[] }>();
  readonly onDidChange: vscode.Event<{ workspaceId: string; ports: ListeningPort[] }> =
    this.emitter.event;

  private readonly known = new Map<string, ListeningPort[]>();
  private readonly loggedErrors = new Set<string>();
  private timer: NodeJS.Timeout | undefined;
  private running = false;
  private scanning = false;
  private lastChangeAt = 0;
  /** Bumped by start(); an in-flight tick from an older loop stops itself. */
  private epoch = 0;

  private readonly deps: PortScannerDeps;

  // Not a parameter property: node --experimental-strip-types (which runs the
  // parser tests against this module) rejects that TS-only constructor sugar.
  constructor(deps: PortScannerDeps) {
    this.deps = deps;
  }

  start(): void {
    // start() means something just happened (a terminal opened), so the loop
    // always restarts at the fast cadence even if it was already running.
    this.stop();
    this.running = true;
    this.lastChangeAt = Date.now();
    const epoch = ++this.epoch;
    void this.tick(epoch);
  }

  stop(): void {
    this.running = false;
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  portsFor(workspaceId: string): ListeningPort[] {
    return this.known.get(workspaceId) ?? [];
  }

  dispose(): void {
    this.stop();
    this.emitter.dispose();
  }

  private async tick(epoch: number): Promise<void> {
    // A slow scan must not stack a second one on top of itself.
    if (!this.scanning) {
      this.scanning = true;
      try {
        await this.scan();
      } catch (err) {
        this.logOnce(err instanceof Error ? err.message : String(err));
      } finally {
        this.scanning = false;
      }
    }
    if (!this.running || epoch !== this.epoch) return;
    // Quiet for a minute → poll lazily; any change snaps back to fast.
    const idle = Date.now() - this.lastChangeAt;
    const interval = idle >= BACKOFF_AFTER_MS ? SLOW_INTERVAL_MS : FAST_INTERVAL_MS;
    this.timer = setTimeout(() => void this.tick(epoch), interval);
  }

  private async scan(): Promise<void> {
    const ids = this.deps.workspaceIds();
    if (ids.length === 0) {
      // Nothing to attribute to: clear leftovers without spawning anything.
      for (const [workspaceId, ports] of this.known) {
        if (ports.length > 0) this.emitter.fire({ workspaceId, ports: [] });
      }
      this.known.clear();
      return;
    }

    const roots = new Map<string, number[]>();
    await Promise.all(ids.map(async (id) => roots.set(id, await this.deps.rootPids(id))));

    const byWorkspace =
      process.platform === "win32" ? await this.scanWindows(roots) : await this.scanPosix(roots);

    const ignored = new Set(this.deps.ignorePorts?.() ?? DEFAULT_IGNORED_PORTS);
    let changed = false;
    for (const id of ids) {
      const ports = normalize(byWorkspace.get(id) ?? [], ignored);
      const previous = this.known.get(id) ?? [];
      // Fire only on a real change: the board repaints on every event, and an
      // event every 2.5 s would make it flicker.
      if (samePorts(previous, ports)) continue;
      this.known.set(id, ports);
      this.emitter.fire({ workspaceId: id, ports });
      changed = true;
    }
    for (const [workspaceId, ports] of this.known) {
      if (ids.includes(workspaceId)) continue;
      this.known.delete(workspaceId);
      if (ports.length > 0) {
        this.emitter.fire({ workspaceId, ports: [] });
        changed = true;
      }
    }
    if (changed) this.lastChangeAt = Date.now();
  }

  /** macOS and Linux: ps for the tree, one lsof call for every pid at once. */
  private async scanPosix(roots: Map<string, number[]>): Promise<Map<string, ListeningPort[]>> {
    const ps = await execFile("ps", ["-eo", "pid,ppid"]);
    const tree = parsePsTree(ps.stdout);
    const pidSets = new Map<string, Set<number>>();
    const allPids = new Set<number>();
    for (const [id, rootPids] of roots) {
      const set = new Set(descendantsOf(rootPids, tree));
      pidSets.set(id, set);
      for (const pid of set) allPids.add(pid);
    }
    const result = new Map<string, ListeningPort[]>();
    if (allPids.size === 0) return result;

    let ports: ListeningPort[];
    try {
      ports = parseLsof(await this.runLsof([...allPids]));
    } catch (err) {
      const enoent = err instanceof Error && "code" in err && err.code === "ENOENT";
      if (process.platform === "linux" && enoent) {
        // Minimal Linux images ship without lsof; /proc has the same data.
        ports = await this.scanProcNet(allPids);
      } else {
        throw err;
      }
    }
    for (const [id, set] of pidSets) {
      result.set(id, ports.filter((p) => set.has(p.pid)));
    }
    return result;
  }

  private async runLsof(pids: number[]): Promise<string> {
    const args = ["-a", "-p", pids.join(","), "-iTCP", "-sTCP:LISTEN", "-P", "-n"];
    try {
      const { stdout } = await execFile("lsof", args);
      return stdout;
    } catch (err) {
      // lsof exits non-zero when nothing matched; that is an empty answer.
      const out = exitOutput(err);
      if (out !== undefined) return out;
      throw err;
    }
  }

  /** Linux without lsof: map socket inodes to pids by scanning /proc fds. */
  private async scanProcNet(pids: Set<number>): Promise<ListeningPort[]> {
    const inodeToPid = new Map<string, number>();
    for (const pid of pids) {
      let fds: string[];
      try {
        fds = await fs.readdir(`/proc/${pid}/fd`);
      } catch {
        continue; // process exited, or EACCES on someone else's tree
      }
      for (const fd of fds) {
        try {
          const target = await fs.readlink(`/proc/${pid}/fd/${fd}`);
          const match = /^socket:\[(\d+)\]$/.exec(target);
          if (match) inodeToPid.set(match[1], pid);
        } catch {
          // fd closed between readdir and readlink — normal churn
        }
      }
    }
    const ports: ListeningPort[] = [];
    for (const file of ["/proc/net/tcp", "/proc/net/tcp6"]) {
      try {
        ports.push(...parseProcNetTcp(await fs.readFile(file, "utf8"), inodeToPid));
      } catch {
        // e.g. IPv6 disabled → no tcp6 file
      }
    }
    return ports;
  }

  private async scanWindows(roots: Map<string, number[]>): Promise<Map<string, ListeningPort[]>> {
    const { stdout } = await execFile("netstat", ["-ano"]);
    const ports = parseNetstat(stdout);
    let tree: Map<number, number>;
    try {
      const wmic = await execFile("wmic", ["process", "get", "ParentProcessId,ProcessId"]);
      tree = parseWmicTree(wmic.stdout);
    } catch {
      // wmic is deprecated and absent on newer builds; with no tree we can
      // still attribute ports owned by the exact root pids.
      tree = new Map();
    }
    const result = new Map<string, ListeningPort[]>();
    for (const [id, rootPids] of roots) {
      const set = new Set(descendantsOf(rootPids, tree));
      result.set(id, ports.filter((p) => set.has(p.pid)));
    }
    return result;
  }

  /** Repeat once per distinct message: a broken host would spam every tick. */
  private logOnce(message: string): void {
    if (this.loggedErrors.has(message)) return;
    this.loggedErrors.add(message);
    this.deps.output.appendLine(`[ports] ${message}`);
  }
}
