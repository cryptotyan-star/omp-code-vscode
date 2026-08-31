import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { detectVerifyCommand, runVerify } from "../src/workspaces/verify.ts";

/** Build a throwaway worktree directory holding the given files. */
async function withWorktree(files, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-verify-"));
  try {
    for (const [relative, contents] of Object.entries(files)) {
      const target = path.join(dir, relative);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, contents);
    }
    await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

const isWindows = process.platform === "win32";

/**
 * Poll until `pid` is gone. The kill is asynchronous and a signalled group can
 * take a moment to be reaped, so asking once right after `runVerify` returns
 * would be a coin flip.
 */
async function waitForGone(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() >= deadline) {
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** The pid a test command wrote for us, once it is actually there. */
async function readPid(pidFile) {
  const raw = await fs.readFile(pidFile, "utf8");
  const pid = Number.parseInt(raw, 10);
  assert.ok(Number.isInteger(pid) && pid > 0, `expected a pid in ${pidFile}, got ${JSON.stringify(raw)}`);
  return pid;
}

// ---------------------------------------------------------------- detect

test("the workspace config's verify field wins", async () => {
  await withWorktree(
    {
      ".ompcode/workspace.json": JSON.stringify({ setup: ["npm ci"], verify: "npm test" }),
      "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
    },
    async (dir) => {
      assert.equal(await detectVerifyCommand(dir), "npm test");
    },
  );
});

test("a verify list is joined with && so a failing step stops the rest", async () => {
  await withWorktree(
    { ".ompcode/workspace.json": JSON.stringify({ verify: ["npm run lint", "npm test"] }) },
    async (dir) => {
      assert.equal(await detectVerifyCommand(dir), "npm run lint && npm test");
    },
  );
});

test("package.json scripts are the fallback, in test / check / build order", async () => {
  await withWorktree(
    { "package.json": JSON.stringify({ scripts: { build: "tsc", check: "tsc --noEmit", test: "node --test" } }) },
    async (dir) => {
      assert.equal(await detectVerifyCommand(dir), "npm run test");
    },
  );
  await withWorktree({ "package.json": JSON.stringify({ scripts: { build: "tsc", check: "tsc --noEmit" } }) }, async (dir) => {
    assert.equal(await detectVerifyCommand(dir), "npm run check");
  });
  await withWorktree({ "package.json": JSON.stringify({ scripts: { build: "tsc" } }) }, async (dir) => {
    assert.equal(await detectVerifyCommand(dir), "npm run build");
  });
});

test("an empty verify list falls through to package.json rather than meaning 'run nothing'", async () => {
  await withWorktree(
    {
      ".ompcode/workspace.json": JSON.stringify({ verify: [] }),
      "package.json": JSON.stringify({ scripts: { test: "node --test" } }),
    },
    async (dir) => {
      assert.equal(await detectVerifyCommand(dir), "npm run test");
    },
  );
});

test("nothing to detect stays undefined instead of guessing", async () => {
  await withWorktree({}, async (dir) => {
    assert.equal(await detectVerifyCommand(dir), undefined);
  });
  // A package.json with no interesting script, and a malformed one, both count
  // as "no command" rather than as an error.
  await withWorktree({ "package.json": JSON.stringify({ scripts: { dev: "vite" } }) }, async (dir) => {
    assert.equal(await detectVerifyCommand(dir), undefined);
  });
  await withWorktree({ "package.json": "{ not json" }, async (dir) => {
    assert.equal(await detectVerifyCommand(dir), undefined);
  });
  await withWorktree({ "package.json": JSON.stringify({ scripts: "npm test" }) }, async (dir) => {
    assert.equal(await detectVerifyCommand(dir), undefined);
  });
});

test("a blank script body is not a command", async () => {
  await withWorktree(
    { "package.json": JSON.stringify({ scripts: { test: "   ", check: "tsc --noEmit" } }) },
    async (dir) => {
      assert.equal(await detectVerifyCommand(dir), "npm run check");
    },
  );
});

// ------------------------------------------------------------------- run

test("a declared npm script passed explicitly is a green gate", async () => {
  await withWorktree(
    { "package.json": JSON.stringify({ scripts: { hello: "echo hello-from-verify" } }) },
    async (dir) => {
      // The one override shape a caller may name: `npm run <script>`, the
      // script really present in the package.json being verified.
      const result = await runVerify(dir, "npm run hello");
      assert.equal(result.ok, true, result.output);
      assert.equal(result.exitCode, 0);
      assert.equal(result.timedOut, false);
      assert.equal(result.ran, "npm run hello");
      assert.match(result.output, /hello-from-verify/);
      assert.ok(result.durationMs >= 0);
    },
  );
});

test("the command runs inside the worktree", async () => {
  const command = isWindows ? "dir marker.txt" : "ls marker.txt";
  await withWorktree(
    {
      "marker.txt": "here",
      ".ompcode/workspace.json": JSON.stringify({ verify: command }),
    },
    async (dir) => {
      const result = await runVerify(dir, command);
      assert.equal(result.ok, true, result.output);
      assert.match(result.output, /marker\.txt/);
    },
  );
});

test("a non-zero exit is a red gate carrying the reason", async () => {
  const command = "echo boom 1>&2 && exit 3";
  await withWorktree(
    { ".ompcode/workspace.json": JSON.stringify({ verify: command }) },
    async (dir) => {
      const result = await runVerify(dir, command);
      assert.equal(result.ok, false);
      assert.equal(result.exitCode, 3);
      assert.equal(result.timedOut, false);
      // stderr is in the same excerpt as stdout, or the reason would be missing.
      assert.match(result.output, /boom/);
    },
  );
});

test("runVerify detects the command when none is passed", async () => {
  await withWorktree(
    { ".ompcode/workspace.json": JSON.stringify({ verify: "echo detected-command" }) },
    async (dir) => {
      const result = await runVerify(dir);
      assert.equal(result.ran, "echo detected-command");
      assert.equal(result.ok, true);
    },
  );
});
test("output is kept as a tail, with the truncation said out loud", async () => {
  const command = isWindows
    ? "for /L %i in (1,1,400) do @echo LINE-%i"
    : "for i in $(seq 1 400); do echo LINE-$i; done";
  await withWorktree(
    { ".ompcode/workspace.json": JSON.stringify({ verify: command }) },
    async (dir) => {
      const result = await runVerify(dir, command, { maxOutputBytes: 256 });
      assert.equal(result.ok, true, result.output);
      assert.match(result.output, /output truncated/);
      // The tail, not the head: the last line survives and the first does not.
      assert.match(result.output, /LINE-400/);
      assert.ok(!/LINE-1\b/.test(result.output));
      // The marker is allowed to exceed the byte budget; the body is not.
      const body = result.output.slice(result.output.indexOf("\n") + 1);
      assert.ok(Buffer.byteLength(body, "utf8") <= 256, `body was ${Buffer.byteLength(body, "utf8")} bytes`);
    },
  );
});

test("a short output is not marked as truncated", async () => {
  await withWorktree(
    { ".ompcode/workspace.json": JSON.stringify({ verify: "echo short" }) },
    async (dir) => {
      const result = await runVerify(dir, "echo short", { maxOutputBytes: 4096 });
      assert.ok(!/output truncated/.test(result.output));
    },
  );
});

test("a timeout kills the whole process tree, not just the shell", { skip: isWindows }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-verify-"));
  const pidFile = path.join(dir, "child.pid");
  // A background grandchild that outlives the shell unless the *group* is
  // signalled — this is the leak the detached process group exists to stop.
  // Declared in the workspace config and echoed back explicitly: both of the
  // shapes a caller is allowed to pass reach the same spawn.
  const command = `sleep 60 & echo $! > ${JSON.stringify(pidFile)}; wait`;
  try {
    await fs.mkdir(path.join(dir, ".ompcode"), { recursive: true });
    await fs.writeFile(path.join(dir, ".ompcode", "workspace.json"), JSON.stringify({ verify: command }));
    const result = await runVerify(dir, command, { timeoutMs: 700 });
    assert.equal(result.timedOut, true);
    assert.equal(result.ok, false);
    assert.match(result.output, /timed out/);
    assert.ok(result.durationMs >= 600, `took ${result.durationMs}ms`);
    // The interesting half: killing only the shell leaves the grandchild
    // holding the stdio pipes, so `close` would not fire until its own 60s
    // sleep ended. Returning promptly is the proof the group was signalled.
    assert.ok(result.durationMs < 15_000, `the process tree outlived the timeout (${result.durationMs}ms)`);

    const pid = await readPid(pidFile);
    assert.equal(await waitForGone(pid), true, `grandchild ${pid} survived the timeout`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

// `timeout` on purpose: the bug these two cover is a promise that never
// settles, and without a per-test deadline a regression would hang the whole
// suite instead of failing one test.
test("a descendant that ignores SIGTERM is killed anyway, and the call still settles", { skip: isWindows, timeout: 30_000 }, async () => {
  const pidFile = path.join(os.tmpdir(), `omp-verify-stubborn-${process.pid}.pid`);
  const command = `sh -c 'trap "" TERM; sleep 45' & echo $! > ${JSON.stringify(pidFile)}; wait`;
  try {
    await withWorktree({ ".ompcode/workspace.json": JSON.stringify({ verify: command }) }, async (dir) => {
      // The shape that matters: the group *leader* obeys SIGTERM and dies, while
      // the descendant ignores it — an ignored disposition survives both fork and
      // exec, so the inner `sleep` ignores SIGTERM too. Only the SIGKILL
      // escalation can end this tree, and that escalation used to be unreachable:
      // killTree returned early once `child.exitCode` was set, i.e. exactly when
      // the leader had died, which is exactly when escalating is the whole point.
      // The tree then leaked and the promise never settled.
      const result = await runVerify(dir, command, { timeoutMs: 700 });
      assert.equal(result.timedOut, true);
      assert.equal(result.ok, false);
      assert.match(result.output, /timed out/);
      // SIGTERM at the timeout, SIGKILL one grace period later, then a hard
      // deadline. Any of those settles the call long before the command's own
      // 45 seconds — waiting that long is the failure this asserts against.
      assert.ok(result.durationMs < 20_000, `runVerify did not settle promptly (${result.durationMs}ms)`);

      const pid = await readPid(pidFile);
      assert.equal(await waitForGone(pid), true, `the SIGTERM-proof descendant ${pid} survived`);
    });
  } finally {
    await fs.rm(pidFile, { force: true });
  }
});

test("a survivor holding the pipes cannot hold the promise open", { skip: isWindows, timeout: 30_000 }, async () => {
  const pidFile = path.join(os.tmpdir(), `omp-verify-survivor-${process.pid}.pid`);
  let survivor;
  try {
    await withWorktree({}, async (dir) => {
      // A grandchild that detaches into its *own* process group is out of
      // reach of the group kill, and it inherited stdout — so the pipe stays
      // open and `close` never fires. Only the hard settle deadline gets the
      // caller an answer here; without it this promise hangs on a wedged pipe.
      const spawnSurvivor =
        `const c = require('child_process').spawn('sleep', ['45'], ` +
        `{ detached: true, stdio: ['ignore', 'inherit', 'inherit'] }); ` +
        `require('fs').writeFileSync('${pidFile}', String(c.pid)); c.unref();`;
      const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(spawnSurvivor)}; trap '' TERM; sleep 45`;
      await fs.mkdir(path.join(dir, ".ompcode"), { recursive: true });
      await fs.writeFile(path.join(dir, ".ompcode", "workspace.json"), JSON.stringify({ verify: command }));
      const result = await runVerify(dir, command, { timeoutMs: 700 });
      assert.equal(result.timedOut, true);
      assert.equal(result.ok, false);
      assert.equal(result.exitCode, null);
      // The excerpt has to say why it is short, or the model reads a truncated
      // log as the whole story.
      assert.match(result.output, /pipes never closed/);
      assert.ok(result.durationMs < 20_000, `a stuck pipe held runVerify for ${result.durationMs}ms`);
      survivor = await readPid(pidFile);
    });
  } finally {
    // This one is meant to survive; nothing else will clean it up.
    if (survivor !== undefined) {
      try {
        process.kill(survivor, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
    await fs.rm(pidFile, { force: true });
  }
});
test("the workspace config's cwd decides where the command is detected and run", async () => {
  // A monorepo that installs its dependencies in packages/app has to be
  // verified there too: setupRun.ts resolves cwd the same way, and running
  // `npm test` at the root would fail with "no test specified" — which the
  // orchestrator would read as broken work rather than as a misplaced gate.
  await withWorktree(
    {
      ".ompcode/workspace.json": JSON.stringify({ cwd: "packages/app" }),
      "package.json": JSON.stringify({ scripts: { build: "root-build" } }),
      "packages/app/package.json": JSON.stringify({ scripts: { test: "node --test" } }),
    },
    async (dir) => {
      // The root's `build` would have won if the lookup ignored cwd.
      assert.equal(await detectVerifyCommand(dir), "npm run test");
    },
  );

  await withWorktree(
    {
      ".ompcode/workspace.json": JSON.stringify({ cwd: "packages/app", verify: ["ls marker.txt"] }),
      "packages/app/marker.txt": "here",
    },
    async (dir) => {
      // Detection, not an explicit command: a caller may not compose one.
      const result = await runVerify(dir);
      assert.equal(result.ok, true, result.output);
      assert.match(result.output, /marker\.txt/);
    },
  );
});

test("an already-aborted signal never starts the command", async () => {
  await withWorktree(
    { ".ompcode/workspace.json": JSON.stringify({ verify: "echo should-not-run" }) },
    async (dir) => {
      const controller = new AbortController();
      controller.abort();
      const result = await runVerify(dir, "echo should-not-run", { signal: controller.signal });
      assert.equal(result.ok, false);
      assert.equal(result.timedOut, false);
      assert.ok(!/should-not-run/.test(result.output));
    },
  );
});

test("aborting mid-run stops it without reporting a timeout", { skip: isWindows }, async () => {
  await withWorktree(
    { ".ompcode/workspace.json": JSON.stringify({ verify: "sleep 60" }) },
    async (dir) => {
      const controller = new AbortController();
      const pending = runVerify(dir, "sleep 60", { signal: controller.signal, timeoutMs: 30_000 });
      setTimeout(() => controller.abort(), 200);
      const result = await pending;
      assert.equal(result.ok, false);
      assert.equal(result.timedOut, false);
      assert.match(result.output, /cancelled/);
      assert.ok(result.durationMs < 10_000, `took ${result.durationMs}ms`);
    },
  );
});

test("a command that cannot start is reported, not thrown", async () => {
  const command = "definitely-not-a-real-binary-9f3a";
  await withWorktree(
    { ".ompcode/workspace.json": JSON.stringify({ verify: command }) },
    async (dir) => {
      const result = await runVerify(dir, command);
      assert.equal(result.ok, false);
      assert.notEqual(result.exitCode, 0);
    },
  );
});

// --------------------------------------------- the explicit-command gate ----

/**
 * Every refusal looks the same from outside: a red gate, nothing executed,
 * and an output that says the command was refused and why.
 */
async function assertRefused(dir, command) {
  const result = await runVerify(dir, command);
  assert.equal(result.ok, false, command);
  assert.equal(result.ran, "", command);
  assert.equal(result.exitCode, null, command);
  assert.equal(result.timedOut, false, command);
  assert.match(result.output, /Refused to run/, command);
}

test("an explicit command that is not the repo's own and not an npm script is refused", async () => {
  await withWorktree({ "package.json": JSON.stringify({ scripts: { test: "node --test" } }) }, async (dir) => {
    for (const command of [
      "echo hello",
      "make test",
      "sh -c 'echo no'",
      "./scripts/verify.sh",
      "npm",
      "npm run",
    ]) {
      await assertRefused(dir, command);
    }
  });
});

test("shell metacharacters are refused, not interpreted", async () => {
  await withWorktree({ "package.json": JSON.stringify({ scripts: { test: "node --test" } }) }, async (dir) => {
    // Each of these would run a second command of the model's choosing if the
    // string reached the shell; the gate must reject the whole line.
    for (const command of [
      "npm run test; touch pwned",
      "npm run test && touch pwned",
      "npm run test | sh",
      "npm run `id`",
      "npm run $(id)",
      "npm run test>out",
      "npm run 'test'",
    ]) {
      await assertRefused(dir, command);
    }
    // The refusals above were decided before any spawn: the injected second
    // command (`touch pwned`) never ran.
    assert.equal(await fs.stat(path.join(dir, "pwned")).then(() => true, () => false), false);
  });
});

test("path traversal and arguments in a script name are refused", async () => {
  await withWorktree({ "package.json": JSON.stringify({ scripts: { test: "node --test" } }) }, async (dir) => {
    for (const command of [
      "npm run ../other-pkg",
      "npm run ..",
      "npm run a/b",
      "npm run ./test",
      "npm run sub\\test",
      "npm run --prefix .. test",
      "npm run test -- --watch",
      "npm run -s test",
    ]) {
      await assertRefused(dir, command);
    }
  });
});

test("a script name the repo never declared is refused", async () => {
  await withWorktree(
    { "package.json": JSON.stringify({ scripts: { test: "node --test", build: "tsc" } }) },
    async (dir) => {
      const result = await runVerify(dir, "npm run lint");
      assert.equal(result.ok, false);
      assert.equal(result.ran, "");
      assert.match(result.output, /"lint" is not a script in the package.json/);
    },
  );
});

test("a name inherited from the prototype is not a script", async () => {
  await withWorktree({ "package.json": JSON.stringify({ scripts: { test: "node --test" } }) }, async (dir) => {
    // `toString` is absent from the scripts object but present on its
    // prototype; `in` would let it through, `Object.hasOwn` does not.
    await assertRefused(dir, "npm run toString");
  });
});

test("with no package.json there is no explicit script to allow", async () => {
  await withWorktree({}, async (dir) => {
    const result = await runVerify(dir, "npm run test");
    assert.equal(result.ok, false);
    assert.match(result.output, /not a script in the package.json/);
  });
});

test("the repo's own declared command may be passed back verbatim", async () => {
  // The orchestrator's shape: it relays `detectVerifyCommand`'s output as the
  // explicit command. That echo must keep working for any declared command.
  await withWorktree(
    { ".ompcode/workspace.json": JSON.stringify({ verify: "echo declared-command" }) },
    async (dir) => {
      const result = await runVerify(dir, "echo declared-command");
      assert.equal(result.ok, true, result.output);
      assert.equal(result.ran, "echo declared-command");
    },
  );
});

test("an allowlisted script is looked up in the package.json the config's cwd names", async () => {
  await withWorktree(
    {
      ".ompcode/workspace.json": JSON.stringify({ cwd: "packages/app" }),
      "package.json": JSON.stringify({ scripts: { hello: "echo wrong-place" } }),
      "packages/app/package.json": JSON.stringify({ scripts: { hello: "echo right-place" } }),
    },
    async (dir) => {
      const result = await runVerify(dir, "npm run hello");
      assert.equal(result.ok, true, result.output);
      assert.match(result.output, /right-place/);
      assert.ok(!result.output.includes("wrong-place"));
    },
  );
});
