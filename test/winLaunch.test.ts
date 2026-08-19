import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildCmdCommandLine,
  extensionOf,
  quoteWindowsArg,
  resolveLaunch,
  resolveWindowsExecutable,
} from "../src/winLaunch.ts";

const WIN_ENV: NodeJS.ProcessEnv = {
  PATH: "C:\\Windows\\system32;C:\\Users\\dev\\.bun\\bin",
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  ComSpec: "C:\\Windows\\system32\\cmd.exe",
};

/** Fake filesystem: only the listed paths exist. */
function only(...files: string[]): (candidate: string) => boolean {
  const set = new Set(files.map((f) => f.toLowerCase()));
  return (candidate) => set.has(candidate.toLowerCase());
}

const ARGS = ["--mode", "rpc-ui", "--cwd", "C:\\work\\proj"];

test("non-Windows platforms are left completely alone", () => {
  const target = resolveLaunch({
    file: "omp",
    args: ARGS,
    platform: "darwin",
    env: WIN_ENV,
    exists: only("C:\\Users\\dev\\.bun\\bin\\omp.cmd"),
  });
  assert.deepEqual(target, { file: "omp", args: ARGS });
  assert.equal(target.windowsVerbatimArguments, undefined);
});

test("a real Windows executable spawns directly, at its resolved path", () => {
  const target = resolveLaunch({
    file: "omp",
    args: ARGS,
    platform: "win32",
    env: WIN_ENV,
    exists: only("C:\\Users\\dev\\.bun\\bin\\omp.exe"),
  });
  assert.equal(target.file, "C:\\Users\\dev\\.bun\\bin\\omp.exe");
  assert.deepEqual(target.args, ARGS);
  assert.equal(target.windowsVerbatimArguments, undefined);
  assert.equal(target.problem, undefined);
});

test("a batch shim is rerouted through cmd.exe with every argument quoted", () => {
  const target = resolveLaunch({
    file: "omp",
    args: ARGS,
    platform: "win32",
    env: WIN_ENV,
    exists: only("C:\\Users\\dev\\.bun\\bin\\omp.cmd"),
  });
  assert.equal(target.file, "C:\\Windows\\system32\\cmd.exe");
  assert.equal(target.windowsVerbatimArguments, true);
  assert.deepEqual(target.args, [
    "/d",
    "/s",
    "/c",
    '""C:\\Users\\dev\\.bun\\bin\\omp.cmd" "--mode" "rpc-ui" "--cwd" "C:\\work\\proj""',
  ]);
});

test("cmd.exe comes from ComSpec, falling back to the bare name", () => {
  const exists = only("C:\\Users\\dev\\.bun\\bin\\omp.cmd");
  const withComSpec = resolveLaunch({
    file: "omp",
    args: [],
    platform: "win32",
    env: { ...WIN_ENV, ComSpec: "D:\\alt\\cmd.exe" },
    exists,
  });
  assert.equal(withComSpec.file, "D:\\alt\\cmd.exe");

  const withoutComSpec = resolveLaunch({
    file: "omp",
    args: [],
    platform: "win32",
    env: { PATH: WIN_ENV.PATH, PATHEXT: WIN_ENV.PATHEXT },
    exists,
  });
  assert.equal(withoutComSpec.file, "cmd.exe");
});

test("a workspace path with a space survives the cmd.exe hop", () => {
  const cwd = "C:\\Users\\Jane Doe\\My Projects\\app";
  const target = resolveLaunch({
    file: "omp",
    args: ["--cwd", cwd],
    platform: "win32",
    env: WIN_ENV,
    exists: only("C:\\Users\\dev\\.bun\\bin\\omp.cmd"),
  });
  assert.ok(target.args[3]?.includes(`"${cwd}"`));
});

test("shell metacharacters in a workspace path stay inside quotes", () => {
  // The whole reason this module does its own quoting: with `shell: true`
  // Node would emit this path bare and cmd would run `calc` as a second
  // command.
  const cwd = "C:\\work\\a & calc & b";
  const target = resolveLaunch({
    file: "omp",
    args: ["--cwd", cwd],
    platform: "win32",
    env: WIN_ENV,
    exists: only("C:\\Users\\dev\\.bun\\bin\\omp.cmd"),
  });
  // Drop the outer quote pair that cmd's /s strips before parsing.
  const line = (target.args[3] ?? "").slice(1, -1);
  assert.ok(line.includes(`"${cwd}"`));
  // Every `&` sits between the quotes of the argument that owns it.
  for (const match of line.matchAll(/&/g)) {
    const quotesBefore = (line.slice(0, match.index).match(/"/g) ?? []).length;
    assert.equal(quotesBefore % 2, 1, `unquoted & at index ${match.index}`);
  }
});

test("a PowerShell wrapper is refused with an actionable message", () => {
  const target = resolveLaunch({
    file: "C:\\Users\\dev\\.bun\\bin\\omp.ps1",
    args: ARGS,
    platform: "win32",
    env: WIN_ENV,
    exists: only("C:\\Users\\dev\\.bun\\bin\\omp.ps1"),
  });
  assert.match(target.problem ?? "", /PowerShell wrapper/);
  assert.match(target.problem ?? "", /ompcode\.ompPath/);
  assert.equal(target.windowsVerbatimArguments, undefined);
});

test("an argument containing a quote is refused rather than escaped", () => {
  const target = resolveLaunch({
    file: "omp",
    args: ["--cwd", 'C:\\work\\we"rd'],
    platform: "win32",
    env: WIN_ENV,
    exists: only("C:\\Users\\dev\\.bun\\bin\\omp.cmd"),
  });
  assert.match(target.problem ?? "", /double quote/);
});

test("an unresolvable name passes through so the caller's ENOENT message wins", () => {
  const target = resolveLaunch({
    file: "omp",
    args: ARGS,
    platform: "win32",
    env: WIN_ENV,
    exists: () => false,
  });
  assert.deepEqual(target, { file: "omp", args: ARGS });
});

test("PATH directories are searched in order, extensions within each", () => {
  // .EXE precedes .CMD in PATHEXT, but the system32 directory precedes
  // .bun/bin in PATH — the directory has to win.
  const target = resolveWindowsExecutable(
    "omp",
    WIN_ENV,
    only("C:\\Windows\\system32\\omp.cmd", "C:\\Users\\dev\\.bun\\bin\\omp.exe"),
  );
  assert.equal(target, "C:\\Windows\\system32\\omp.cmd");
});

test("within one directory, PATHEXT order decides", () => {
  const dir = "C:\\Users\\dev\\.bun\\bin";
  assert.equal(
    resolveWindowsExecutable("omp", WIN_ENV, only(`${dir}\\omp.cmd`, `${dir}\\omp.exe`)),
    `${dir}\\omp.exe`,
  );
});

test("an explicit extension is never widened by PATHEXT", () => {
  const dir = "C:\\Users\\dev\\.bun\\bin";
  assert.equal(
    resolveWindowsExecutable(`${dir}\\omp.cmd`, WIN_ENV, only(`${dir}\\omp.cmd`, `${dir}\\omp.exe`)),
    `${dir}\\omp.cmd`,
  );
  assert.equal(
    resolveWindowsExecutable(`${dir}\\omp.exe`, WIN_ENV, only(`${dir}\\omp.cmd`)),
    undefined,
  );
});

test("the current directory is not searched", () => {
  assert.equal(resolveWindowsExecutable("omp", WIN_ENV, only("omp.cmd")), undefined);
});

test("PATHEXT falls back to the Windows default when unset", () => {
  const env: NodeJS.ProcessEnv = { PATH: "C:\\bin" };
  assert.equal(resolveWindowsExecutable("omp", env, only("C:\\bin\\omp.cmd")), "C:\\bin\\omp.cmd");
});

test("case-variant PATH and PATHEXT keys are honoured", () => {
  const env: NodeJS.ProcessEnv = { Path: "C:\\bin", Pathext: ".exe" };
  assert.equal(resolveWindowsExecutable("omp", env, only("C:\\bin\\omp.exe")), "C:\\bin\\omp.exe");
});

test("quoted and empty PATH entries do not produce bogus candidates", () => {
  const seen: string[] = [];
  resolveWindowsExecutable("omp", { PATH: '"C:\\bin";;C:\\other', PATHEXT: ".EXE" }, (c) => {
    seen.push(c);
    return false;
  });
  assert.deepEqual(seen, ["C:\\bin\\omp.exe", "C:\\other\\omp.exe"]);
});

test("an empty name resolves to nothing", () => {
  assert.equal(resolveWindowsExecutable("", WIN_ENV, () => true), undefined);
});

test("quoteWindowsArg follows the C runtime backslash rules", () => {
  assert.equal(quoteWindowsArg("plain"), '"plain"');
  assert.equal(quoteWindowsArg("with space"), '"with space"');
  assert.equal(quoteWindowsArg(""), '""');
  // Backslashes not before a quote stay as they are.
  assert.equal(quoteWindowsArg("C:\\a\\b"), '"C:\\a\\b"');
  // Trailing ones would escape the closing quote, so they double.
  assert.equal(quoteWindowsArg("C:\\dir\\"), '"C:\\dir\\\\"');
  assert.equal(quoteWindowsArg("C:\\dir\\\\"), '"C:\\dir\\\\\\\\"');
  // A backslash run before an embedded quote doubles, and the quote escapes.
  assert.equal(quoteWindowsArg('a\\"b'), '"a\\\\\\"b"');
});

test("buildCmdCommandLine quotes the executable too", () => {
  const built = buildCmdCommandLine("C:\\Program Files\\omp\\omp.cmd", ["--mode", "rpc-ui"]);
  assert.deepEqual(built, {
    line: '"C:\\Program Files\\omp\\omp.cmd" "--mode" "rpc-ui"',
  });
});

test("extensionOf lower-cases and handles bare names", () => {
  assert.equal(extensionOf("omp"), "");
  assert.equal(extensionOf("C:\\bin\\OMP.CMD"), ".cmd");
  assert.equal(extensionOf("C:\\bin\\omp.exe"), ".exe");
  assert.equal(extensionOf("C:\\my.dir\\omp"), "");
});
