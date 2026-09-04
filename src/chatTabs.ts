/**
 * What a chat tab has to remember so a window reload can bring it back.
 *
 * VS Code destroys every webview when the window reloads and only offers the
 * panel back through a `WebviewPanelSerializer`. All it hands over is whatever
 * the *webview* stored with `vscode.setState()` — the extension's own objects
 * are gone, and `retainContextWhenHidden` does not survive a reload either. So
 * a tab is restored from two halves:
 *
 *   - the webview keeps a single opaque id (see `data-tab-id` in the chat HTML
 *     and `setState` in media/main.mjs). It is small, it is written once per
 *     attach, and it can never go stale;
 *   - the extension keeps the payload — working directory, workspace, model
 *     pin, conversation file — in `workspaceState`, keyed by that id.
 *
 * The payload deliberately does not live in the webview state: the webview
 * never learns the conversation's JSONL path or the workspace record, and
 * mirroring them down there would mean pushing a message on every state change
 * and trusting the renderer to have stored the last one before the reload.
 *
 * This module is the pure half of that: no `vscode` import, so `node --test`
 * can exercise the parsing, the merge and the pruning directly.
 */

/** Versioned: a future record shape migrates by reading the old key. */
export const CHAT_TABS_KEY = "ompcode.chatTabs.v1";

/**
 * Upper bound on remembered tabs. Records are tiny, but nothing ever deletes
 * the entry of a tab closed while the window was down, so the store needs a
 * ceiling; the oldest entries go first — except the ones still open, see
 * {@link upsertChatTab}.
 */
export const MAX_CHAT_TABS = 40;

export interface ChatTabRecord {
  /** Opaque id shared with the webview state — the identity of the surface. */
  tabId: string;
  /** Folder the agent ran in, when the tab was opened for a specific one. */
  cwd?: string;
  /** Workspace record this tab belongs to, when it is a workspace chat. */
  workspaceId?: string;
  /**
   * `provider/modelId` the user pinned on this tab. Absent means the tab
   * follows `ompcode.defaultModel`, and restoring it must keep following it.
   */
  model?: string;
  /** JSONL of the conversation, so the restored agent switches back into it. */
  sessionFile?: string;
  /** Last write, in ms — the eviction order. */
  updatedAt: number;
}

/** The fields a caller may change; `tabId` identifies, it is never patched away. */
export type ChatTabPatch = Partial<Omit<ChatTabRecord, "tabId" | "updatedAt">> & {
  tabId: string;
};

/**
 * Tab ids whose records must survive eviction because their webview panel is
 * still open or is about to be bound. This is the explicit protection the
 * restore path needs: a panel VS Code hands to the serializer is open from the
 * user's point of view, but it has not reached `bindChatPanel` yet, so the set
 * of currently bound panels alone cannot keep it safe.
 */
const protectedTabIds = new Set<string>();

/** Mark a tab id as protected from eviction while its panel is open. */
export function protectChatTabId(tabId: string): void {
  protectedTabIds.add(tabId);
}

/** Remove eviction protection for a closed/disposed tab. */
export function unprotectChatTabId(tabId: string): void {
  protectedTabIds.delete(tabId);
}

/** Clear the protection registry. Intended for tests. */
export function resetChatTabProtection(): void {
  protectedTabIds.clear();
}

/**
 * Tab ids currently being restored. VS Code deserializes persisted webview
 * panels lazily, and a panel whose state names the same tab id can arrive
 * twice (e.g. a second deserialize for the same persisted surface, or a race
 * with normal activation that already started binding that id). Only one of
 * those paths may be allowed to call `bindChatPanel`.
 */
const restoringTabIds = new Set<string>();

/**
 * Try to take ownership of restoring a tab id. Returns `true` if the caller
 * is now responsible for that id; `false` if it is already bound, already
 * protected, or another restore is in progress.
 */
export function claimChatTabRestore(tabId: string): boolean {
  if (protectedTabIds.has(tabId) || restoringTabIds.has(tabId)) {
    return false;
  }
  restoringTabIds.add(tabId);
  protectedTabIds.add(tabId);
  return true;
}

/** Release the in-progress restore flag; the id stays protected if still open. */
export function finishChatTabRestore(tabId: string): void {
  restoringTabIds.delete(tabId);
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

/**
 * A record is kept only when every field the restore path dereferences has the
 * right type. A half-parsed record would reopen a tab in the wrong directory,
 * which is worse than reopening it blank.
 */
export function isChatTabRecord(value: unknown): value is ChatTabRecord {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const r = value as Record<string, unknown>;
  return (
    typeof r["tabId"] === "string" &&
    r["tabId"].length > 0 &&
    optionalString(r["cwd"]) &&
    optionalString(r["workspaceId"]) &&
    optionalString(r["model"]) &&
    optionalString(r["sessionFile"]) &&
    typeof r["updatedAt"] === "number" &&
    Number.isFinite(r["updatedAt"])
  );
}

/** Read the stored array back, dropping anything that no longer parses. */
export function readChatTabs(raw: unknown): ChatTabRecord[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const byId = new Map<string, ChatTabRecord>();
  for (const entry of raw) {
    if (isChatTabRecord(entry)) {
      // Last write wins, so a store that somehow grew a duplicate id resolves
      // to the newer record rather than to whichever came first.
      byId.set(entry.tabId, entry);
    }
  }
  return [...byId.values()];
}

/**
 * Merge a patch into the store. Fields left `undefined` keep their stored
 * value: the callers are single-purpose (the agent reported a new JSONL, the
 * user picked a model) and must not erase what they do not know about.
 */
export function upsertChatTab(
  list: readonly ChatTabRecord[],
  patch: ChatTabPatch,
  now: number = Date.now(),
  keep: ReadonlySet<string> = new Set(),
): ChatTabRecord[] {
  const previous = list.find((record) => record.tabId === patch.tabId);
  const merged: ChatTabRecord = {
    ...(previous ?? { tabId: patch.tabId }),
    ...(patch.cwd !== undefined ? { cwd: patch.cwd } : {}),
    ...(patch.workspaceId !== undefined ? { workspaceId: patch.workspaceId } : {}),
    ...(patch.model !== undefined ? { model: patch.model } : {}),
    ...(patch.sessionFile !== undefined ? { sessionFile: patch.sessionFile } : {}),
    tabId: patch.tabId,
    updatedAt: now,
  };
  // Freshest last: eviction below takes from the front.
  const next = list.filter((record) => record.tabId !== patch.tabId);
  next.push(merged);
  if (next.length <= MAX_CHAT_TABS) {
    return next;
  }
  // `updatedAt` moves only when a tab's conversation or model actually
  // changes, so a long-lived chat sitting idle looks as stale as one closed
  // an hour ago. Evicting it would lose the transcript of the tab the user
  // still has in front of him, so the ids of the open panels are spared and
  // the closed tabs behind them absorb the cap instead. When every record is
  // protected the store simply runs over: bounded by what the user has open.
  const kept: ChatTabRecord[] = [];
  let over = next.length - MAX_CHAT_TABS;
  for (const record of next) {
    if (over > 0 && !keep.has(record.tabId) && !protectedTabIds.has(record.tabId)) {
      over -= 1;
      continue;
    }
    kept.push(record);
  }
  return kept;
}

/** Forget one tab — it was closed, or its restore found nothing to open. */
export function dropChatTab(
  list: readonly ChatTabRecord[],
  tabId: string,
): ChatTabRecord[] {
  return list.filter((record) => record.tabId !== tabId);
}

export interface PruneResult {
  kept: ChatTabRecord[];
  /** Records whose workspace the registry no longer has. */
  dropped: ChatTabRecord[];
}

/**
 * Drop the records of tabs whose workspace is gone. A deleted workspace takes
 * its worktree with it, so restoring such a tab would start an agent in a
 * directory that no longer exists and bind a board row that no longer has one.
 */
export function pruneChatTabs(
  list: readonly ChatTabRecord[],
  liveWorkspaceIds: Iterable<string>,
): PruneResult {
  const live = new Set(liveWorkspaceIds);
  const kept: ChatTabRecord[] = [];
  const dropped: ChatTabRecord[] = [];
  for (const record of list) {
    if (record.workspaceId !== undefined && !live.has(record.workspaceId)) {
      dropped.push(record);
    } else {
      kept.push(record);
    }
  }
  return { kept, dropped };
}

/**
 * The tab id out of the state VS Code hands the serializer. Anything else —
 * a panel persisted by an older build, a hand-edited state — reads as absent.
 */
export function parseTabState(state: unknown): string | undefined {
  if (typeof state !== "object" || state === null) {
    return undefined;
  }
  const id = (state as Record<string, unknown>)["tabId"];
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/** How a restored panel should be brought back. */
export type RestorePlan =
  /** A workspace chat: rebind it to that record, which owns model and branch. */
  | { kind: "workspace"; record: ChatTabRecord; workspaceId: string }
  /** A plain chat: reopen it on its own folder, model pin and conversation. */
  | { kind: "plain"; record: ChatTabRecord }
  /**
   * The tab belonged to a workspace that no longer exists. Its worktree is
   * gone, so there is nothing honest to reopen — the panel is closed and the
   * record forgotten instead of resurrected in the wrong directory.
   */
  | { kind: "close"; reason: "dead-workspace"; record: ChatTabRecord }
  /**
   * Nothing identifies this panel: it was persisted before this build existed,
   * or its record has been evicted. A blank chat is the honest fallback — the
   * tab survives, its conversation does not.
   */
  | { kind: "blank"; reason: "no-state" | "unknown-tab" };

/**
 * Decide what a restored panel becomes. Pure on purpose: this is the whole
 * decision the serializer makes, and it is the part worth testing.
 */
export function planRestore(
  list: readonly ChatTabRecord[],
  state: unknown,
  liveWorkspaceIds: Iterable<string>,
): RestorePlan {
  const tabId = parseTabState(state);
  if (!tabId) {
    return { kind: "blank", reason: "no-state" };
  }
  const record = list.find((entry) => entry.tabId === tabId);
  if (!record) {
    return { kind: "blank", reason: "unknown-tab" };
  }
  if (record.workspaceId !== undefined) {
    const live = new Set(liveWorkspaceIds);
    return live.has(record.workspaceId)
      ? { kind: "workspace", record, workspaceId: record.workspaceId }
      : { kind: "close", reason: "dead-workspace", record };
  }
  return { kind: "plain", record };
}
