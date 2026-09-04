import type { CapabilityVerb } from "./remoteProtocol.ts";

const APPROVAL_METHODS = new Set(["confirm", "select", "input", "editor", "cancel"]);

function safeAuthUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 8192) return undefined;
  try {
    const url = new URL(value);
    if (url.username || url.password) return undefined;
    const loopbackHttp = url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
    return url.protocol === "https:" || loopbackHttp ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Redact host-only auth state before the shared webview feed reaches a phone. */
export function filterRemoteSessionMessage(
  input: Record<string, unknown>,
  verbs: readonly CapabilityVerb[],
): Record<string, unknown> | undefined {
  if (!verbs.includes("view")) return undefined;
  const type = typeof input.t === "string" ? input.t : "";
  if (type === "authStart" || type === "authDone") {
    if (!verbs.includes("credentials.manage")) return undefined;
    return {
      t: type,
      ...(typeof input.providerId === "string" ? { providerId: input.providerId.slice(0, 32) } : {}),
      ...(type === "authDone" && typeof input.ok === "boolean" ? { ok: input.ok } : {}),
    };
  }
  // These frames contain booleans/labels, not key values, but are still part
  // of credential administration and stay behind the explicit elevated verb.
  if ((type === "keyStatus" || type === "deadKey") && !verbs.includes("credentials.manage")) return undefined;
  // The processes column is a desktop-only surface — no phone renders one. This
  // filter is default-allow, so without an explicit refusal the whole board
  // snapshot rides out to any paired device: every workspace's name, branch,
  // model, cost and last error, from a device scoped to a single chat.
  if (type === "board") return undefined;
  if (type === "approvalResolved") {
    if (!verbs.includes("approve")) return undefined;
    if (
      typeof input.requestId !== "string" || input.requestId.length > 128 ||
      (input.outcome !== "answered" && input.outcome !== "cancelled") ||
      (input.winner !== "desktop" && input.winner !== "remote" && input.winner !== "agent")
    ) return undefined;
    return {
      t: "approvalResolved",
      requestId: input.requestId,
      outcome: input.outcome,
      winner: input.winner,
    };
  }
  if (type === "frame" && input.frame && typeof input.frame === "object") {
    const frame = input.frame as Record<string, unknown>;
    if (frame.type === "extension_ui_request") {
      if (frame.method === "open_url") {
        if (!verbs.includes("credentials.manage")) return undefined;
        const url = safeAuthUrl(frame.url);
        const launchUrl = safeAuthUrl(frame.launchUrl);
        if (!url && !launchUrl) return undefined;
        return {
          t: "frame",
          frame: {
            type: "extension_ui_request",
            method: "open_url",
            ...(typeof frame.id === "string" ? { id: frame.id.slice(0, 128) } : {}),
            ...(url ? { url } : {}),
            ...(launchUrl ? { launchUrl } : {}),
            ...(typeof frame.instructions === "string"
              ? { instructions: frame.instructions.slice(0, 4096).replace(/[^\P{C}\n\t]/gu, "") }
              : {}),
          },
        };
      }
      if (APPROVAL_METHODS.has(String(frame.method ?? "")) && !verbs.includes("approve")) return undefined;
    }
  }
  // Do not recursively mutate transcript/tool objects: generic fields named
  // `token` are also correlation ids used by fileCandidates/attached.
  return JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
}
