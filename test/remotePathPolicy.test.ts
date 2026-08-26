import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { requireCanonicalRemotePath } from "../src/remotePathPolicy.ts";

test("canonical remote path rejects a symlink escape and allows a missing child inside root", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "omp-remote-path-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const root = path.join(base, "root");
  const outside = path.join(base, "outside");
  await fs.mkdir(root);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "secret.txt"), "secret");
  await fs.symlink(outside, path.join(root, "escape"));
  await assert.rejects(
    requireCanonicalRemotePath(path.join(root, "escape", "secret.txt"), [root]),
    /outside/,
  );
  assert.equal(
    await requireCanonicalRemotePath(path.join(root, "new", "file.txt"), [root]),
    path.join(await fs.realpath(root), "new", "file.txt"),
  );
});
