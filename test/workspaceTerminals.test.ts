import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `terminals.ts` statically imports `vscode`, which only exists inside the
 * extension host — `node --test` cannot load the module at all. So, following
 * the precedent of the wiring check in `workspaceManager.test.ts`, these are
 * source-text invariants: the promises the module makes that a refactor could
 * silently break without any compile error.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = await fs.readFile(path.join(root, "src", "workspaces", "terminals.ts"), "utf8");

test("the manager watches terminal closes through the one supported event", () => {
  // Without this subscription the registry leaks closed terminals and
  // `onDidChange` never fires for a close.
  assert.match(source, /vscode\.window\.onDidCloseTerminal/);
});

test("workspace terminals carry the branch icon", () => {
  assert.match(source, /new vscode\.ThemeIcon\("git-branch"\)/);
});

test("workspace terminals export their identity into the environment", () => {
  // The port scanner and anything the user starts in the shell find their
  // workspace through these two variables.
  assert.match(source, /OMPCODE_WORKSPACE_ID/);
  assert.match(source, /OMPCODE_WORKSPACE_PATH/);
});

test("the manager logs through the injected output channel only", () => {
  assert.doesNotMatch(source, /console\./);
});

test("the manager never blocks the extension host on a child process", () => {
  assert.doesNotMatch(source, /execSync/);
});

test("dispose leaves the user's terminals running", () => {
  // Terminals may hold live dev servers; the manager must only tear down its
  // own listener and emitter. Neither a direct terminal.dispose() nor a sweep
  // of vscode.window.terminals may appear.
  assert.doesNotMatch(source, /terminal\.dispose\(\)/);
  assert.doesNotMatch(source, /vscode\.window\.terminals/);
});

test("runConfigured reuses the shared config parser instead of its own", () => {
  assert.match(source, /import \{ readWorkspaceConfig \} from "\.\/setup"/);
});
