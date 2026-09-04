import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateBudget, sessionTotal } from "../src/costGuard.ts";

/**
 * The pure arithmetic under the orchestrator's cost guard: a limit of 0 means
 * "off", the boundary itself (cost == limit) already counts as over, and what
 * is left can never go negative.
 */

test("a zero limit is no limit at all", () => {
  assert.deepEqual(evaluateBudget({ costUsd: 12.5, limitUsd: 0 }), {
    over: false,
    remainingUsd: Infinity,
  });
});

test("a negative limit is treated as off too", () => {
  assert.deepEqual(evaluateBudget({ costUsd: 1, limitUsd: -5 }), {
    over: false,
    remainingUsd: Infinity,
  });
});

test("under the limit keeps going and reports what is left", () => {
  assert.deepEqual(evaluateBudget({ costUsd: 1.25, limitUsd: 5 }), {
    over: false,
    remainingUsd: 3.75,
  });
});

test("exactly at the limit is already over", () => {
  assert.deepEqual(evaluateBudget({ costUsd: 5, limitUsd: 5 }), { over: true, remainingUsd: 0 });
});

test("past the limit clamps the remainder at zero", () => {
  assert.deepEqual(evaluateBudget({ costUsd: 50, limitUsd: 5 }), { over: true, remainingUsd: 0 });
});

test("the session total is the orchestrator plus every workspace", () => {
  assert.equal(sessionTotal(2, [{ cost: 1.5 }, { cost: 0.25 }]), 3.75);
});

test("a session with no workspaces has spent its orchestrator's cost", () => {
  assert.equal(sessionTotal(0.5, []), 0.5);
});
