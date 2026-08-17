import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as YAML from "yaml";
import { syncCustomProviders } from "../src/modelsSync.ts";

// Point HOME at a temp dir so models.yml never touches the real user config.
function withTempHome(fn) {
  return async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-test-"));
    const realHome = process.env.HOME;
    process.env.HOME = tmp;
    try {
      await fn(tmp);
    } finally {
      process.env.HOME = realHome;
      await fs.rm(tmp, { recursive: true, force: true });
    }
  };
}

test("syncCustomProviders: no-op when cfg is empty/null/undefined", async () => {
  await withTempHome(async () => {
    for (const empty of [{}, null, undefined, "nope"] as const) {
      await syncCustomProviders(empty as never);
    }
    // file should not have been created
    await assert.rejects(() => fs.readFile(path.join(os.homedir(), ".omp", "agent", "models.yml"), "utf8"));
  });
});

test("syncCustomProviders: creates file + dir when missing", async () => {
  await withTempHome(async () => {
    const cfg = { akemi: { baseUrl: "http://h:8000/v1", models: [] } };
    await syncCustomProviders(cfg);
    const text = await fs.readFile(path.join(os.homedir(), ".omp", "agent", "models.yml"), "utf8");
    const doc = YAML.parse(text);
    assert.equal(doc.providers.akemi.baseUrl, "http://h:8000/v1");
  });
});

test("syncCustomProviders: never deletes existing providers", async () => {
  await withTempHome(async (home) => {
    const file = path.join(home, ".omp", "agent", "models.yml");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "providers:\n  keepme:\n    baseUrl: old\n", "utf8");

    await syncCustomProviders({ akemi: { baseUrl: "new" } });
    const doc = YAML.parse(await fs.readFile(file, "utf8"));
    assert.equal(doc.providers.keepme.baseUrl, "old", "existing provider preserved");
    assert.equal(doc.providers.akemi.baseUrl, "new", "new provider merged");
  });
});

test("syncCustomProviders: same-named provider is deep-merged, cfg wins", async () => {
  await withTempHome(async (home) => {
    const file = path.join(home, ".omp", "agent", "models.yml");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      YAML.stringify({
        providers: {
          akemi: {
            baseUrl: "http://old:8000/v1",
            api: "openai-completions",
            models: [{ id: "akemi-1", name: "Old" }],
          },
        },
      }),
      "utf8",
    );

    await syncCustomProviders({
      akemi: {
        baseUrl: "http://new:8000/v1",
        apiKey: "sk-xyz",
        models: [{ id: "akemi-2", name: "New" }],
      },
    });
    const doc = YAML.parse(await fs.readFile(file, "utf8"));
    assert.equal(doc.providers.akemi.baseUrl, "http://new:8000/v1", "scalar overwritten");
    assert.equal(doc.providers.akemi.api, "openai-completions", "non-touched key preserved");
    assert.equal(doc.providers.akemi.apiKey, "sk-xyz", "new key added");
    assert.deepEqual(
      doc.providers.akemi.models.map((m) => m.id),
      ["akemi-2"],
      "arrays replaced (cfg wins), not concat",
    );
  });
});

test("syncCustomProviders: no write when nothing changed", async () => {
  await withTempHome(async (home) => {
    const file = path.join(home, ".omp", "agent", "models.yml");
    await fs.mkdir(path.dirname(file), { recursive: true });
    const original = "providers:\n  akemi:\n    baseUrl: x\n";
    await fs.writeFile(file, original, "utf8");
    const before = await fs.stat(file).then((s) => s.mtimeMs);
    // identical merge target → no change → no write
    await syncCustomProviders({ akemi: { baseUrl: "x" } });
    // re-issue to settle fs timing
    await new Promise((r) => setTimeout(r, 20));
    const after = await fs.stat(file).then((s) => s.mtimeMs);
    assert.equal(before, after, "file mtime unchanged when no-op");
  });
});

test("syncCustomProviders: refuses to clobber invalid YAML", async () => {
  await withTempHome(async (home) => {
    const file = path.join(home, ".omp", "agent", "models.yml");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "providers: [unclosed", "utf8");
    await assert.rejects(() => syncCustomProviders({ akemi: { baseUrl: "x" } }), /invalid YAML/i);
    // original garbage untouched
    const text = await fs.readFile(file, "utf8");
    assert.equal(text, "providers: [unclosed");
  });
});

test("syncCustomProviders: rejects when root is not a mapping", async () => {
  await withTempHome(async (home) => {
    const file = path.join(home, ".omp", "agent", "models.yml");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "- just\n- a\n- list\n", "utf8");
    await assert.rejects(() => syncCustomProviders({ akemi: { baseUrl: "x" } }), /not a YAML mapping/i);
  });
});
