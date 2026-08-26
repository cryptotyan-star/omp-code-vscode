import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

const hostSrc = fs.readFileSync(
  path.join(import.meta.dirname, "..", "src", "ompSession.ts"),
  "utf8",
);

/**
 * State frames lag the agent, so the host can believe a session is idle while
 * omp has already started streaming. omp answers a plain prompt in that window
 * with "already processing" — the one case where a retry is not a guess.
 */
test("a prompt rejected as busy is retried once as an explicit steer", () => {
  assert.match(
    hostSrc,
    /const busy = \(err instanceof Error \? err\.message : String\(err\)\)\.includes\(\s*"already processing",\s*\);/,
  );
  assert.match(
    hostSrc,
    /if \(!steering && busy\) \{\s*steer = true;\s*await proc\.request\(\{ type: "prompt", message, streamingBehavior: "steer" \}\);/,
  );
});

test("promptFailed tells the webview whether a live turn was involved", () => {
  assert.match(hostSrc, /this\.post\(\{ t: "promptFailed", steer \}\);/);
  assert.match(hostSrc, /this\.post\(\{ t: "promptFailed", steer: false \}\);/);
});

test("routed prompts still refuse to interrupt a running turn", () => {
  assert.match(
    hostSrc,
    /cannot route a prompt while another turn is active/,
    "a routed send swaps the model — it must never be steered into a live turn",
  );
});
