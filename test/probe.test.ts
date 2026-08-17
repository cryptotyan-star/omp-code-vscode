import { test } from "node:test";
import assert from "node:assert/strict";
import { isCacheFresh, isProviderLevelFailure, modelKey, planProbeOrder } from "../src/probe.ts";

const now = 1_700_000_000_000;

test("planProbeOrder puts one representative per provider first", () => {
  const models = [
    { provider: "anthropic", id: "claude-opus-4", cost: { input: 15 } },
    { provider: "anthropic", id: "claude-haiku-4", cost: { input: 0.8 } },
    { provider: "moonshot", id: "kimi-k2.5", cost: { input: 0.95 } },
    { provider: "moonshot", id: "kimi-k2-thinking", cost: { input: 0.6 } },
    { provider: "kimi-code", id: "kimi-for-coding", cost: { input: 0 } },
    { provider: "kimi-code", id: "k3", cost: { input: 0 } },
  ];
  const order = planProbeOrder(models).map((m) => modelKey(m.provider, m.id));
  assert.deepEqual(order.slice(0, 3), [
    "anthropic/claude-haiku-4",
    "moonshot/kimi-k2-thinking",
    "kimi-code/k3", // same price → shortest id wins
  ]);
  assert.equal(order.length, models.length, "every model still gets probed");
  assert.equal(new Set(order).size, models.length, "no duplicates");
});

test("planProbeOrder handles missing cost and empty input", () => {
  assert.deepEqual(planProbeOrder([]), []);
  const order = planProbeOrder([
    { provider: "p", id: "b" },
    { provider: "p", id: "a", cost: { input: 5 } },
  ]);
  assert.equal(order[0].id, "a", "priced model sorts ahead of an unpriced one");
});

test("isProviderLevelFailure only condemns a provider on credential errors", () => {
  const base = { ok: false, checkedAt: now };
  assert.equal(isProviderLevelFailure({ ...base, status: 401 }), true);
  assert.equal(
    isProviderLevelFailure({ ...base, detail: "401 Invalid Authentication (type=invalid_authentication_error)" }),
    true,
    "auth-shaped message with no parsed status",
  );
  // A model the account may not use must not take its siblings down.
  assert.equal(isProviderLevelFailure({ ...base, status: 403, detail: "model not allowed" }), false);
  assert.equal(isProviderLevelFailure({ ...base, status: 404, detail: "model_not_found" }), false);
  assert.equal(isProviderLevelFailure({ ...base, status: 429, detail: "rate limited" }), false);
  assert.equal(isProviderLevelFailure({ ...base, detail: "timed out" }), false);
  assert.equal(isProviderLevelFailure({ ok: true, checkedAt: now }), false);
});

test("isCacheFresh requires a fresh verdict for every model", () => {
  const models = [
    { provider: "a", id: "1" },
    { provider: "b", id: "2" },
  ];
  const ttl = 1000;
  const fresh = {
    "a/1": { ok: true, checkedAt: now },
    "b/2": { ok: false, checkedAt: now },
  };
  assert.equal(isCacheFresh(models, fresh, now + 500, ttl), true);
  assert.equal(isCacheFresh(models, fresh, now + 1500, ttl), false, "expired");
  assert.equal(isCacheFresh(models, { "a/1": { ok: true, checkedAt: now } }, now, ttl), false, "missing model");
  assert.equal(isCacheFresh([], {}, now, ttl), true, "nothing to check");
});
