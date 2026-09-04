/*
 * Platform-neutral bridge used by the OMP Code renderer.
 *
 * VS Code injects `acquireVsCodeApi()`. Android injects an origin-scoped
 * `ompHost` WebMessageListener object. Tests may provide an explicit
 * `__OMP_HOST_PORT__` adapter; production HTML never defines that hook.
 */

const MAX_INBOUND_JSON_CHARS = 2 * 1024 * 1024;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function decodeInbound(value) {
  if (isRecord(value)) return value;
  if (typeof value !== "string" || value.length > MAX_INBOUND_JSON_CHARS) return null;
  try {
    const parsed = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function sameOrigin(scope, event) {
  const expected = scope.location && typeof scope.location.origin === "string"
    ? scope.location.origin
    : "";
  return Boolean(expected && event && event.origin === expected);
}

/**
 * @param {Window & typeof globalThis | Record<string, any>} scope
 * @returns {{ kind: "vscode"|"android"|"in-memory", post(message: object): void,
 *   subscribe(listener: (message: object) => void): () => void,
 *   setState(value: object|null): void, getState(): object|null, dispose(): void }}
 */
export function createHostPort(scope = globalThis) {
  const override = scope.__OMP_HOST_PORT__;
  if (override && typeof override.post === "function" && typeof override.subscribe === "function") {
    return {
      kind: "in-memory",
      post(message) { override.post(message); },
      subscribe(listener) { return override.subscribe(listener); },
      setState(value) { if (typeof override.setState === "function") override.setState(value); },
      getState() { return typeof override.getState === "function" ? override.getState() : null; },
      dispose() { if (typeof override.dispose === "function") override.dispose(); },
    };
  }

  const acquire = scope.acquireVsCodeApi;
  const vscode = typeof acquire === "function" ? acquire() : null;
  const android = !vscode && scope.ompHost &&
    typeof scope.ompHost.postMessage === "function"
    ? scope.ompHost
    : null;
  if (!vscode && !android) {
    throw new Error("OMP Code host bridge is unavailable");
  }

  const listeners = new Set();
  let disposed = false;
  let androidState = null;
  let androidSlotInstalled = false;
  // JavaScriptReplyProxy replies are delivered on the origin-scoped injected
  // object itself (`ompHost`), not as generic page-wide window messages.
  const androidEventTarget = android && typeof android.addEventListener === "function";
  const inboundTarget = androidEventTarget ? android : scope;
  const onMessage = (event) => {
    if (disposed) return;
    // VS Code owns its isolated webview channel. Android messages must arrive
    // through the WebViewCompat object restricted to the packaged HTTPS
    // origin. The same-origin check is only for older window-message fallbacks.
    if (android && inboundTarget === scope && !androidSlotInstalled && !sameOrigin(scope, event)) return;
    const message = decodeInbound(event && event.data);
    if (!message) return;
    for (const listener of listeners) {
      try { listener(message); } catch { /* one renderer listener must not break others */ }
    }
  };
  let androidOnMessage;
  let previousAndroidOnMessage;
  if (android && !androidEventTarget) {
    // Some Android System WebView releases expose the injected listener with
    // only an `onmessage` slot. Preserve an existing native/app handler and
    // restore it when this renderer is disposed.
    previousAndroidOnMessage = typeof android.onmessage === "function"
      ? android.onmessage
      : null;
    androidOnMessage = (event) => {
      try { previousAndroidOnMessage?.call(android, event); } catch { /* keep renderer alive */ }
      onMessage(event);
    };
    try {
      android.onmessage = androidOnMessage;
      androidSlotInstalled = android.onmessage === androidOnMessage;
    } catch { /* fall back to a same-origin window message below */ }
    if (!androidSlotInstalled) inboundTarget.addEventListener("message", onMessage);
  } else {
    inboundTarget.addEventListener("message", onMessage);
  }

  return {
    kind: vscode ? "vscode" : "android",
    post(message) {
      if (disposed || !isRecord(message)) return;
      if (vscode) vscode.postMessage(message);
      else android.postMessage(JSON.stringify(message));
    },
    // The only state that survives a window reload. VS Code hands it back to
    // the extension's WebviewPanelSerializer, which is what lets a chat tab
    // find its own record again; Android reloads nothing, so it keeps the
    // value in memory and the getter stays honest either way.
    setState(value) {
      if (disposed) return;
      if (vscode) vscode.setState(value);
      else androidState = value;
    },
    getState() {
      // Mirrors `setState`: a disposed port owns nothing, and a renderer that
      // read a state slot it can no longer write would act on a stale id.
      if (disposed) return null;
      if (vscode) return vscode.getState();
      return androidState;
    },
    subscribe(listener) {
      if (disposed || typeof listener !== "function") return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      if (android && !androidEventTarget) {
        if (androidSlotInstalled && android.onmessage === androidOnMessage) {
          android.onmessage = previousAndroidOnMessage;
        } else if (!androidSlotInstalled) {
          inboundTarget.removeEventListener("message", onMessage);
        }
      } else {
        inboundTarget.removeEventListener("message", onMessage);
      }
    },
  };
}

export const HOST_PORT_MAX_INBOUND_JSON_CHARS = MAX_INBOUND_JSON_CHARS;
