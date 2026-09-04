import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { BIGMODEL_BASE_URL, CONFIG_PROVIDERS, KEYED_PROVIDERS } from "../src/providers.ts";

const root = path.join(import.meta.dirname, "..");
const sessionSrc = fs.readFileSync(path.join(root, "src", "ompSession.ts"), "utf8");

/**
 * A shipped provider block reaches omp through models.yml, and omp only reads a
 * credential from that file — never from an env var it has no id for. A row
 * that claimed an env var would put the key somewhere nothing looks.
 */
test("every shipped provider has a keyed row that carries no env var", () => {
  assert.ok(CONFIG_PROVIDERS.length > 0, "expected at least one shipped provider");
  for (const entry of CONFIG_PROVIDERS) {
    const row = KEYED_PROVIDERS.find((p) => p.secret === entry.secret);
    assert.ok(row, `${entry.name} needs a keyed row, or its key has no way in`);
    assert.equal(row.provider, entry.name, "probe verdicts are keyed by the omp provider id");
    assert.equal(row.envVar, undefined, `${entry.name} has no env var to be injected into`);
  }
});

/**
 * `injectProviderKeys` looks the secret up by name, so the convention is the
 * wiring: a row naming its secret anything else stays keyless forever.
 */
test("shipped secrets follow the name injectProviderKeys looks up", () => {
  assert.match(
    sessionSrc,
    /secrets\.get\(`ompcode\.providerKey\.\$\{name\}`\)/,
    "the lookup this convention is pinned to must still exist",
  );
  for (const entry of CONFIG_PROVIDERS) {
    assert.equal(entry.secret, `ompcode.providerKey.${entry.name}`);
  }
});

/** omp validates the block; these are the fields it refuses to go without. */
test("every shipped block is one omp will accept", () => {
  for (const entry of CONFIG_PROVIDERS) {
    const def = entry.def;
    assert.match(String(def.baseUrl), /^https:\/\//, `${entry.name} needs an https baseUrl`);
    assert.equal(def.api, "openai-completions", `${entry.name} needs an api for its models`);
    assert.equal(def.apiKey, undefined, "the key comes from Secret Storage, never the source");

    const models = def.models as { id: string; name: string }[];
    assert.ok(Array.isArray(models) && models.length > 0, `${entry.name} needs models`);
    const ids = models.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length, "duplicate ids would collide in the picker");
    for (const model of models) {
      assert.ok(model.id && model.name, "every model needs an id and a name");
    }
  }
});

/**
 * The pay-as-you-go endpoint is the whole point of the block: the Coding Plan
 * path (`/api/coding/paas/v4`) is what the ZHIPU_API_KEY row already covers,
 * and both are meant to be usable at once.
 */
test("BigModel points at the platform endpoint, not the Coding Plan one", () => {
  assert.equal(BIGMODEL_BASE_URL, "https://open.bigmodel.cn/api/paas/v4");
  const zhipu = KEYED_PROVIDERS.find((p) => p.id === "zhipu");
  assert.equal(zhipu?.provider, "zhipu-coding-plan", "the subscription row stays as it was");
  const bigmodel = KEYED_PROVIDERS.find((p) => p.id === "bigmodel");
  assert.notEqual(bigmodel?.secret, zhipu?.secret, "two accounts, two secrets");
});

/**
 * A block whose key is gone fails validation, and omp answers that by dropping
 * every custom provider in the file — so the removal has to land before the
 * write, not after it.
 */
test("the stale block is pruned before models.yml is written", () => {
  const prune = sessionSrc.indexOf("await this.pruneShippedProviders(");
  const sync = sessionSrc.indexOf("await syncCustomProviders(");
  assert.ok(prune > 0 && sync > 0, "both steps must run at spawn");
  assert.ok(prune < sync, "pruning after the write would leave the bad block in place");
  assert.match(
    sessionSrc,
    /entry\.name in configured \|\| \(await this\.context\.secrets\.get\(entry\.secret\)\)/,
    "a stored key, or a user entry of the same name, must stop the prune",
  );
});
