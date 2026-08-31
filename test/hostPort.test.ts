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

test("the VS Code state slot round-trips the tab id and closes with the port", () => {
  // This slot is the whole of what survives a window reload: VS Code hands it
  // back to the panel serializer, which is how a restored chat finds its own
  // record again (see src/chatTabs.ts).
  let slot: unknown = null;
  const scope = fakeScope({
    acquireVsCodeApi: () => ({
      postMessage() {},
      setState(value: unknown) { slot = value; },
      getState: () => slot,
    }),
  });
  const port = createHostPort(scope as never);
  assert.equal(port.getState(), null);
  port.setState({ tabId: "tab-1" });
  assert.deepEqual(slot, { tabId: "tab-1" });
  assert.deepEqual(port.getState(), { tabId: "tab-1" });

  port.dispose();
  // Both halves agree once disposed: the slot can no longer be written, so
  // reading it would only hand the renderer an id it cannot keep current.
  port.setState({ tabId: "tab-2" });
  assert.deepEqual(slot, { tabId: "tab-1" });
  assert.equal(port.getState(), null);
});

test("the Android adapter keeps its state in memory, since nothing reloads it", () => {
  const scope = fakeScope({ ompHost: { postMessage() {} } });
  const port = createHostPort(scope as never);
  assert.equal(port.getState(), null);
  port.setState({ tabId: "tab-1" });
  assert.deepEqual(port.getState(), { tabId: "tab-1" });
  port.dispose();
  assert.equal(port.getState(), null);
});
