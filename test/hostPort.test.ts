import { test } from "node:test";
import assert from "node:assert/strict";
import { createHostPort, HOST_PORT_MAX_INBOUND_JSON_CHARS } from "../media/host-port.mjs";

type Listener = (event: { data: unknown; origin?: string }) => void;

function fakeScope(extra: Record<string, unknown> = {}) {
  let listener: Listener | undefined;
  return Object.assign({
    location: { origin: "https://appassets.androidplatform.net" },
    addEventListener(type: string, next: Listener) {
      if (type === "message") listener = next;
    },
    removeEventListener(type: string, next: Listener) {
      if (type === "message" && listener === next) listener = undefined;
    },
    emit(data: unknown, origin = "https://appassets.androidplatform.net") {
      listener?.({ data, origin });
    },
  }, extra);
}

test("VS Code adapter sends objects and accepts host objects", () => {
  const sent: unknown[] = [];
  const scope = fakeScope({ acquireVsCodeApi: () => ({ postMessage: (value: unknown) => sent.push(value) }) });
  const port = createHostPort(scope as never);
  const received: unknown[] = [];
  port.subscribe((value) => received.push(value));
  port.post({ t: "ready" });
  scope.emit({ t: "state" }, "vscode-webview://opaque");
  assert.equal(port.kind, "vscode");
  assert.deepEqual(sent, [{ t: "ready" }]);
  assert.deepEqual(received, [{ t: "state" }]);
});

test("Android adapter serializes outbound messages and enforces its HTTPS origin", () => {
  const sent: string[] = [];
  let nativeReply: Listener | undefined;
  const ompHost = {
    postMessage: (value: string) => sent.push(value),
    addEventListener(type: string, next: Listener) { if (type === "message") nativeReply = next; },
    removeEventListener(type: string, next: Listener) {
      if (type === "message" && nativeReply === next) nativeReply = undefined;
    },
  };
  const scope = fakeScope({ ompHost });
  const port = createHostPort(scope as never);
  const received: unknown[] = [];
  port.subscribe((value) => received.push(value));
  port.post({ t: "prompt", text: "hello" });
  // A page-wide postMessage cannot impersonate the origin-scoped bridge.
  scope.emit('{"t":"attacker"}', "https://attacker.invalid");
  nativeReply?.({ data: '{"t":"state"}' });
  assert.equal(port.kind, "android");
  assert.deepEqual(sent.map(JSON.parse), [{ t: "prompt", text: "hello" }]);
  assert.deepEqual(received, [{ t: "state" }]);
});

test("adapter rejects arrays, malformed JSON and oversized messages", () => {
  const scope = fakeScope({ ompHost: { postMessage() {} } });
  const port = createHostPort(scope as never);
  const received: unknown[] = [];
  port.subscribe((value) => received.push(value));
  scope.emit("[");
  scope.emit("[]");
  scope.emit("x".repeat(HOST_PORT_MAX_INBOUND_JSON_CHARS + 1));
  port.post([] as never);
  assert.deepEqual(received, []);
});

test("dispose detaches the platform listener", () => {
  const scope = fakeScope({ ompHost: { postMessage() {} } });
  const port = createHostPort(scope as never);
  const received: unknown[] = [];
  port.subscribe((value) => received.push(value));
  port.dispose();
  scope.emit('{"t":"state"}');
  assert.deepEqual(received, []);
});

test("Android adapter supports an onmessage-only injected object", () => {
  const sent: string[] = [];
  const priorEvents: unknown[] = [];
  const prior = (event: unknown) => priorEvents.push(event);
  const ompHost: { postMessage(value: string): void; onmessage: (event: { data: unknown }) => void } = {
    postMessage(value: string) { sent.push(value); },
    onmessage: prior,
  };
  const scope = fakeScope({ ompHost });
  const port = createHostPort(scope as never);
  const received: unknown[] = [];
  port.subscribe((value) => received.push(value));

  port.post({ t: "ready" });
  const event = { data: '{"t":"state","state":{"model":"test"}}' };
  ompHost.onmessage(event);
  assert.deepEqual(sent.map(JSON.parse), [{ t: "ready" }]);
  assert.deepEqual(priorEvents, [event]);
  assert.deepEqual(received, [{ t: "state", state: { model: "test" } }]);

  port.dispose();
  assert.equal(ompHost.onmessage, prior);
});
