import * as path from "node:path";
import * as fs from "node:fs";

/**
 * Windows launcher resolution for the omp binary.
 *
 * On Linux and macOS `spawn("omp", args)` works because the installed file is
 * a real executable. On Windows a global install can instead drop a batch
 * shim (`omp.cmd`), which `CreateProcess` cannot run — libuv finds the file
 * and the spawn fails with ENOEXEC/ENOENT, which reads to the user as "omp is
 * not installed".
 *
 * The usual fix, `shell: true`, is wrong here. Node does not quote the
 * argument vector when a shell is used on Windows: it concatenates the parts
 * with single spaces and hands the string to `cmd.exe`. Our argv carries the
 * workspace path (`--cwd`) plus generated file paths, so a directory name
 * containing a space would break the launch, and one containing `&` or `|`
 * would run whatever follows it. This module builds the `cmd.exe` command
 * line itself, quoting every argument, and leaves the non-Windows and
 * real-executable paths untouched.
 */

/** Batch wrappers: runnable, but only through cmd.exe. */
const BATCH_EXTENSIONS = new Set([".cmd", ".bat"]);
/** PowerShell wrappers: cmd.exe cannot run these at all. */
const POWERSHELL_EXTENSIONS = new Set([".ps1"]);
/**
 * What CreateProcess can start on its own. A real PATHEXT also lists `.vbs`,
 * `.js`, `.wsf`, `.msc` and friends, none of which are PE images — resolving
 * to one of those has to be reported, not handed to spawn. The empty string
 * covers an explicitly configured path to an extensionless file.
 */
const DIRECT_EXTENSIONS = new Set([".exe", ".com", ""]);

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

export interface LaunchTarget {
  /** Executable to hand to `spawn`. */
  file: string;
  /** Argument vector to hand to `spawn`. */
  args: string[];
  /** Set when `args` is a pre-built command line rather than a real argv. */
  windowsVerbatimArguments?: boolean;
  /**
   * Set when the target cannot be launched at all. Callers must report this
   * instead of spawning — the message names the fix.
   */
  problem?: string;
}

export interface ResolveLaunchOptions {
  /** The configured `ompcode.ompPath` — a bare name or a full path. */
  file: string;
  args: string[];
  /** Defaults to the running platform. Injected by the tests. */
  platform?: NodeJS.Platform;
  /** Defaults to `process.env`. Injected by the tests. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to a real filesystem check. Injected by the tests. */
  exists?: (candidate: string) => boolean;
}

/** Lower-cased extension of a Windows path, `""` when there is none. */
export function extensionOf(file: string): string {
  return path.win32.extname(file).toLowerCase();
}

function pathExtensions(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATHEXT ?? env.Pathext ?? env.pathext ?? DEFAULT_PATHEXT;
  const list = raw
    .split(";")
    .map((ext) => ext.trim())
    .filter((ext) => ext.length > 0)
    // PATHEXT is conventionally upper-case; the files on disk are not. The
    // filesystem ignores the difference, so lower-case keeps logged and
    // reported paths looking like the real ones.
    .map((ext) => (ext.startsWith(".") ? ext : `.${ext}`).toLowerCase());
  return list.length > 0 ? list : DEFAULT_PATHEXT.toLowerCase().split(";");
}

function pathDirectories(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATH ?? env.Path ?? env.path ?? "";
  return raw
    .split(";")
    .map((dir) => dir.trim().replace(/^"(.*)"$/, "$1"))
    .filter((dir) => dir.length > 0);
}

/** The system legs of the CreateProcess search, ahead of PATH. */
function systemDirectories(env: NodeJS.ProcessEnv): string[] {
  const root = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir;
  return root ? [path.win32.join(root, "system32"), root] : [];
}

function defaultExists(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * Find the file Windows would actually execute for `name`, so the caller can
 * tell a real executable from a batch shim before spawning.
 *
 * Follows the `CreateProcess` order for the legs that can plausibly hold omp:
 * the system directories, then every PATH directory, each tried with every
 * PATHEXT extension. Two legs are skipped on purpose, so this is a close
 * mirror rather than an exact one:
 *
 * - the current directory (and the empty PATH entries that mean it) — an
 *   `omp.cmd` dropped into a workspace must never outrank the installed one;
 * - the calling application's directory, which here is the VS Code install.
 *
 * A miss in a skipped leg only costs the cmd.exe reroute: the caller falls
 * back to spawning the configured name, which still works for a real
 * executable. Returns undefined when nothing matches, which leaves the
 * caller's existing "cannot find omp" error intact.
 */
export function resolveWindowsExecutable(
  name: string,
  env: NodeJS.ProcessEnv,
  exists: (candidate: string) => boolean = defaultExists,
): string | undefined {
  if (!name) {
    return undefined;
  }
  // An explicit extension is used as given; only a bare name gets PATHEXT.
  const extensions = extensionOf(name) ? [""] : pathExtensions(env);
  const hasDirectory =
    name.includes("/") || name.includes("\\") || path.win32.isAbsolute(name);
  const bases = hasDirectory
    ? [name]
    : [...systemDirectories(env), ...pathDirectories(env)].map((dir) =>
        path.win32.join(dir, name),
      );

  for (const base of bases) {
    for (const ext of extensions) {
      const candidate = base + ext;
      if (exists(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

/**
 * Quote one argument the way the Microsoft C runtime parses argv back out:
 * wrap it in double quotes, and double every backslash that immediately
 * precedes a quote (including the closing one).
 *
 * Quoting is unconditional rather than only-when-needed. The result is also
 * read by cmd.exe, which treats `&`, `|`, `<`, `>` and `^` literally inside
 * quotes and as operators outside them — so an argument that "does not need"
 * quotes for the child process may still need them for the shell.
 */
export function quoteWindowsArg(arg: string): string {
  let out = '"';
  let backslashes = 0;
  for (const ch of arg) {
    if (ch === "\\") {
      backslashes += 1;
      continue;
    }
    if (ch === '"') {
      out += "\\".repeat(backslashes * 2 + 1) + '"';
      backslashes = 0;
      continue;
    }
    out += "\\".repeat(backslashes) + ch;
    backslashes = 0;
  }
  // Trailing backslashes would escape the closing quote, so they double too.
  return out + "\\".repeat(backslashes * 2) + '"';
}

/**
 * Build the single command-line string that `cmd.exe /d /s /c` consumes.
 *
 * Returns a `problem` instead of a line when an argument contains a double
 * quote. Escaping one correctly needs two incompatible conventions at once
 * (`\"` for the child's argv parser, `^"` for cmd's own), and getting it
 * wrong ends the quoted region early — which is precisely the injection this
 * module exists to prevent. No Windows path can contain a quote, so refusing
 * costs nothing real.
 */
export function buildCmdCommandLine(
  file: string,
  args: string[],
): { line: string } | { problem: string } {
  for (const part of [file, ...args]) {
    if (part.includes('"')) {
      return {
        problem:
          `cannot launch omp through cmd.exe: the argument ${JSON.stringify(part)} ` +
          "contains a double quote. Move the workspace to a path without quotes, " +
          'or set "ompcode.ompPath" to the omp executable itself.',
      };
    }
  }
  // `%VAR%` still expands inside the quotes — quoting cannot stop that. It is
  // outside the threat model: every argument here is either a constant, a
  // path this extension generated under the OS temp directory, or the
  // workspace path, and a workspace would have to be named after a defined
  // variable whose value itself carried a metacharacter for it to matter.
  return { line: [file, ...args].map(quoteWindowsArg).join(" ") };
}

/**
 * Decide how to spawn omp on the current platform.
 *
 * Everything off Windows, and every real Windows executable, passes straight
 * through. Only a batch shim is rerouted through cmd.exe.
 */
export function resolveLaunch(opts: ResolveLaunchOptions): LaunchTarget {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") {
    return { file: opts.file, args: opts.args };
  }

  const env = opts.env ?? process.env;
  const resolved = resolveWindowsExecutable(opts.file, env, opts.exists ?? defaultExists);
  // Nothing found: spawn the name as configured so the caller still reports
  // its own "cannot find the omp binary" message rather than a vaguer one.
  if (resolved === undefined) {
    return { file: opts.file, args: opts.args };
  }

  const ext = extensionOf(resolved);
  if (DIRECT_EXTENSIONS.has(ext)) {
    return { file: resolved, args: opts.args };
  }
  if (!BATCH_EXTENSIONS.has(ext)) {
    return {
      file: opts.file,
      args: opts.args,
      problem: POWERSHELL_EXTENSIONS.has(ext)
        ? `"${resolved}" is a PowerShell wrapper, which cannot be started directly. ` +
          'Set "ompcode.ompPath" to the omp.cmd or omp.exe next to it.'
        : `"${resolved}" is a ${ext} file, which Windows cannot start as a process. ` +
          'Set "ompcode.ompPath" to the omp.exe or omp.cmd to run.',
    };
  }

  const built = buildCmdCommandLine(resolved, opts.args);
  if ("problem" in built) {
    return { file: opts.file, args: opts.args, problem: built.problem };
  }
  return {
    file: env.ComSpec ?? env.COMSPEC ?? "cmd.exe",
    // /d skips AutoRun commands from the registry, /s makes cmd strip exactly
    // the outer quote pair and treat the rest as the command line.
    args: ["/d", "/s", "/c", `"${built.line}"`],
    windowsVerbatimArguments: true,
  };
}
