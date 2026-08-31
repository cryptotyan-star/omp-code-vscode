import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  mergeLocalConfig,
  parseLocalConfig,
  parseWorkspaceConfig,
  readWorkspaceConfig,
} from "../src/workspaces/setup.ts";

/** Build a throwaway worktree directory holding the given files. */
async function withWorktree(files, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-workspace-"));
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

test("parseWorkspaceConfig reads the full ompcode schema", () => {
  const config = parseWorkspaceConfig(
    { setup: ["npm ci", "npm run build"], teardown: ["docker compose down"], run: ["npm run dev"] },
    "ompcode",
  );
  assert.deepEqual(config, {
    setup: ["npm ci", "npm run build"],
    teardown: ["docker compose down"],
    run: ["npm run dev"],
  });
});

test("a bare string is accepted wherever a command list is", () => {
  const config = parseWorkspaceConfig({ setup: "npm ci", teardown: "true", run: "npm start" }, "ompcode");
  assert.deepEqual(config.setup, ["npm ci"]);
  assert.deepEqual(config.teardown, ["true"]);
  assert.deepEqual(config.run, ["npm start"]);
});

test("missing fields become empty lists rather than undefined", () => {
  assert.deepEqual(parseWorkspaceConfig({}, "ompcode"), { setup: [], teardown: [], run: [] });
});

test("Superset's file parses to exactly the same config as ours", () => {
  const json = { setup: ["pnpm install"], teardown: [], run: ["pnpm dev"], cwd: "apps/web" };
  assert.deepEqual(parseWorkspaceConfig(json, "superset"), parseWorkspaceConfig(json, "ompcode"));
});

test("cwd is trimmed, and an empty one is dropped", () => {
  assert.equal(parseWorkspaceConfig({ cwd: "  apps/web  " }, "ompcode").cwd, "apps/web");
  assert.equal(parseWorkspaceConfig({ cwd: "   " }, "ompcode").cwd, undefined);
  assert.equal(parseWorkspaceConfig({ cwd: 42 }, "ompcode").cwd, undefined);
});

test("non-string and blank commands are dropped, not stringified", () => {
  const config = parseWorkspaceConfig(
    { setup: ["npm ci", "", "   ", 5, null, { command: "rm -rf /" }, "npm test"] },
    "ompcode",
  );
  assert.deepEqual(config.setup, ["npm ci", "npm test"]);
});

test("a non-object document yields an empty config", () => {
  for (const json of [null, undefined, 5, "npm ci", ["npm ci"]]) {
    assert.deepEqual(parseWorkspaceConfig(json, "ompcode"), { setup: [], teardown: [], run: [] });
  }
});

test("parseLocalConfig accepts strings and lists, and tolerates junk", () => {
  assert.deepEqual(parseLocalConfig({ before: "nvm use", after: ["code ."] }), {
    before: ["nvm use"],
    after: ["code ."],
  });
  assert.deepEqual(parseLocalConfig({}), { before: [], after: [] });
  assert.deepEqual(parseLocalConfig("nope"), { before: [], after: [] });
});

test("mergeLocalConfig wraps setup and leaves teardown and run alone", () => {
  const config = { setup: ["npm ci"], teardown: ["down"], run: ["dev"], cwd: "web" };
  const merged = mergeLocalConfig(config, { before: ["nvm use"], after: ["cp .env.example .env"] });
  assert.deepEqual(merged.setup, ["nvm use", "npm ci", "cp .env.example .env"]);
  assert.deepEqual(merged.teardown, ["down"]);
  assert.deepEqual(merged.run, ["dev"]);
  assert.equal(merged.cwd, "web");
  // The input is left untouched — callers may still hold it.
  assert.deepEqual(config.setup, ["npm ci"]);
});

test("an empty overlay is a no-op", () => {
  const config = { setup: ["npm ci"], teardown: [], run: [] };
  assert.equal(mergeLocalConfig(config, { before: [], after: [] }), config);
});

test("readWorkspaceConfig prefers our own file", async () => {
  await withWorktree(
    {
      ".ompcode/workspace.json": JSON.stringify({ setup: ["npm ci"] }),
      ".superset/config.json": JSON.stringify({ setup: ["pnpm install"] }),
    },
    async (dir) => {
      const { config, source } = await readWorkspaceConfig(dir);
      assert.equal(source, "ompcode");
      assert.deepEqual(config.setup, ["npm ci"]);
    },
  );
});

test("readWorkspaceConfig falls back to a Superset repo's config", async () => {
  await withWorktree(
    { ".superset/config.json": JSON.stringify({ setup: ["pnpm install"], cwd: "apps/web" }) },
    async (dir) => {
      const { config, source } = await readWorkspaceConfig(dir);
      assert.equal(source, "superset");
      assert.deepEqual(config.setup, ["pnpm install"]);
      assert.equal(config.cwd, "apps/web");
    },
  );
});

test("no config file at all is not an error", async () => {
  await withWorktree({}, async (dir) => {
    const { config, source } = await readWorkspaceConfig(dir);
    assert.equal(source, "none");
    assert.deepEqual(config, { setup: [], teardown: [], run: [] });
  });
});

test("a malformed config degrades instead of breaking workspace creation", async () => {
  await withWorktree(
    {
      ".ompcode/workspace.json": "{ setup: [ trailing, ] ",
      ".superset/config.json": JSON.stringify({ setup: ["pnpm install"] }),
    },
    async (dir) => {
      const { config, source } = await readWorkspaceConfig(dir);
      assert.equal(source, "superset");
      assert.deepEqual(config.setup, ["pnpm install"]);
    },
  );
});

test("the local overlay wraps the committed setup list", async () => {
  await withWorktree(
    {
      ".ompcode/workspace.json": JSON.stringify({ setup: ["npm ci"] }),
      ".ompcode/workspace.local.json": JSON.stringify({ before: ["nvm use 22"], after: ["npm run seed"] }),
    },
    async (dir) => {
      const { config, source } = await readWorkspaceConfig(dir);
      assert.equal(source, "ompcode");
      assert.deepEqual(config.setup, ["nvm use 22", "npm ci", "npm run seed"]);
    },
  );
});

test("a local overlay alone is a valid setup list", async () => {
  await withWorktree(
    { ".ompcode/workspace.local.json": JSON.stringify({ before: ["direnv allow"] }) },
    async (dir) => {
      const { config, source } = await readWorkspaceConfig(dir);
      assert.equal(source, "none");
      assert.deepEqual(config.setup, ["direnv allow"]);
    },
  );
});

test("a Superset repo keeps using its own local overlay", async () => {
  await withWorktree(
    {
      ".superset/config.json": JSON.stringify({ setup: ["pnpm install"] }),
      ".superset/config.local.json": JSON.stringify({ after: ["pnpm db:push"] }),
    },
    async (dir) => {
      const { config } = await readWorkspaceConfig(dir);
      assert.deepEqual(config.setup, ["pnpm install", "pnpm db:push"]);
    },
  );
});

test("our local overlay wins over Superset's, so migration can go one file at a time", async () => {
  await withWorktree(
    {
      ".superset/config.json": JSON.stringify({ setup: ["pnpm install"] }),
      ".superset/config.local.json": JSON.stringify({ after: ["old"] }),
      ".ompcode/workspace.local.json": JSON.stringify({ after: ["new"] }),
    },
    async (dir) => {
      const { config } = await readWorkspaceConfig(dir);
      assert.deepEqual(config.setup, ["pnpm install", "new"]);
    },
  );
});

test("a Superset overlay is ignored when our own config file is the source", async () => {
  await withWorktree(
    {
      ".ompcode/workspace.json": JSON.stringify({ setup: ["npm ci"] }),
      ".superset/config.local.json": JSON.stringify({ after: ["pnpm db:push"] }),
    },
    async (dir) => {
      const { config } = await readWorkspaceConfig(dir);
      assert.deepEqual(config.setup, ["npm ci"]);
    },
  );
});
