import { test } from "node:test";
import assert from "node:assert/strict";
import { RemoteCommandScheduler } from "../src/remoteCommandScheduler.ts";

test("approval and abort bypass a routed prompt waiting for agent_end", async () => {
  const scheduler = new RemoteCommandScheduler();
  const order: string[] = [];
  let finishPrompt!: () => void;
  const agentEnd = new Promise<void>((resolve) => { finishPrompt = resolve; });

  const prompt = scheduler.run("session", "session-1", async () => {
    order.push("prompt-start");
    await agentEnd;
    order.push("prompt-complete");
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  const approval = scheduler.run("control", "session-1", async () => {
    order.push("approval");
  });
  const abort = scheduler.run("control", "session-1", async () => {
    order.push("abort");
    finishPrompt();
  });
  await Promise.all([prompt, approval, abort]);
  assert.deepEqual(order, ["prompt-start", "approval", "abort", "prompt-complete"]);
});

test("long commands serialize within a session but not across sessions", async () => {
  const scheduler = new RemoteCommandScheduler();
  const order: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = scheduler.run("session", "a", async () => { order.push("a1"); await gate; });
  const second = scheduler.run("session", "a", async () => { order.push("a2"); });
  const parallel = scheduler.run("session", "b", async () => { order.push("b1"); });
  await parallel;
  assert.deepEqual(order, ["a1", "b1"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["a1", "b1", "a2"]);
});

test("command admission remains globally ordered before execution lanes", async () => {
  const scheduler = new RemoteCommandScheduler();
  const order: number[] = [];
  await Promise.all(Array.from({ length: 20 }, (_, index) =>
    scheduler.admit(async () => { order.push(index); })));
  assert.deepEqual(order, Array.from({ length: 20 }, (_, index) => index));
});
