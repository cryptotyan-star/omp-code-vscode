import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHAT_TABS_KEY,
  MAX_CHAT_TABS,
  claimChatTabRestore,
  dropChatTab,
  finishChatTabRestore,
  isChatTabRecord,
  parseTabState,
  planRestore,
  pruneChatTabs,
  protectChatTabId,
  readChatTabs,
  resetChatTabProtection,
  unprotectChatTabId,
  upsertChatTab,
  type ChatTabRecord,
} from "../src/chatTabs.ts";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts: string[]): string =>
  fs.readFileSync(path.join(root, ...parts), "utf8");

function record(over: Partial<ChatTabRecord> & { tabId: string }): ChatTabRecord {
  return { updatedAt: 1, ...over };
}

/* ------------------------------------------------------------------ */
/* The stored shape                                                    */
/* ------------------------------------------------------------------ */

test("only well-formed records survive a read", () => {
  const stored = [
    record({ tabId: "a", cwd: "/repo" }),
    { tabId: "", updatedAt: 1 }, // no identity — unrestorable
    { tabId: "b" }, // no timestamp — cannot be evicted in order
    { tabId: "c", cwd: 7, updatedAt: 1 }, // a cwd that is not a path
    "not a record",
    null,
  ];
  assert.deepEqual(
    readChatTabs(stored).map((r) => r.tabId),
    ["a"],
  );
  assert.deepEqual(readChatTabs(undefined), []);
  assert.deepEqual(readChatTabs({ tabId: "a" }), []);
});

test("a duplicated id resolves to the newer record", () => {
  const kept = readChatTabs([
    record({ tabId: "a", cwd: "/old", updatedAt: 1 }),
    record({ tabId: "a", cwd: "/new", updatedAt: 2 }),
  ]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0]?.cwd, "/new");
});

test("isChatTabRecord accepts a tab that pinned nothing", () => {
  assert.ok(isChatTabRecord({ tabId: "a", updatedAt: 3 }));
});

/* ------------------------------------------------------------------ */
/* Merging                                                             */
/* ------------------------------------------------------------------ */

test("a patch only touches the fields it carries", () => {
  // The two writers are single-purpose: the agent reported a new JSONL, the
  // user picked a model. Neither knows the rest, and neither may erase it.
  let list = upsertChatTab([], { tabId: "a", cwd: "/repo", workspaceId: "w1" }, 10);
  list = upsertChatTab(list, { tabId: "a", sessionFile: "/j.jsonl" }, 11);
  list = upsertChatTab(list, { tabId: "a", model: "anthropic/opus" }, 12);
  assert.deepEqual(list, [
    {
      tabId: "a",
      cwd: "/repo",
      workspaceId: "w1",
      sessionFile: "/j.jsonl",
      model: "anthropic/opus",
      updatedAt: 12,
    },
  ]);
});

test("a later session file replaces the earlier one", () => {
  let list = upsertChatTab([], { tabId: "a", sessionFile: "/one.jsonl" }, 1);
  list = upsertChatTab(list, { tabId: "a", sessionFile: "/two.jsonl" }, 2);
  assert.equal(list.length, 1);
  assert.equal(list[0]?.sessionFile, "/two.jsonl");
});

test("the store is bounded and evicts the oldest tab first", () => {
  let list: ChatTabRecord[] = [];
  for (let i = 0; i < MAX_CHAT_TABS + 5; i += 1) {
    list = upsertChatTab(list, { tabId: `tab-${i}` }, i);
  }
  assert.equal(list.length, MAX_CHAT_TABS);
  assert.equal(list[0]?.tabId, "tab-5");
  assert.equal(list[list.length - 1]?.tabId, `tab-${MAX_CHAT_TABS + 4}`);
});

test("touching a tab moves it out of the eviction line", () => {
  let list: ChatTabRecord[] = [];
  for (let i = 0; i < MAX_CHAT_TABS; i += 1) {
    list = upsertChatTab(list, { tabId: `tab-${i}` }, i);
  }
  list = upsertChatTab(list, { tabId: "tab-0", sessionFile: "/live.jsonl" }, 100);
  list = upsertChatTab(list, { tabId: "fresh" }, 101);
  assert.ok(list.some((r) => r.tabId === "tab-0"));
  assert.ok(!list.some((r) => r.tabId === "tab-1"));
});

test("an open tab is not evicted to make room for a closed one", () => {
  // `updatedAt` moves only when a tab's conversation or model actually
  // changes, so a supervisor chat sitting idle while an orchestrator opens
  // forty workspace chats looks as stale as any of them — and it is the one
  // tab the user most wants back.
  const open = new Set(["supervisor"]);
  let list = upsertChatTab([], { tabId: "supervisor", sessionFile: "/s.jsonl" }, 0, open);
  for (let i = 0; i < MAX_CHAT_TABS + 5; i += 1) {
    list = upsertChatTab(list, { tabId: `tab-${i}` }, i + 1, open);
  }
  assert.equal(list.length, MAX_CHAT_TABS);
  assert.ok(list.some((r) => r.tabId === "supervisor"));
  // The closed tabs behind it absorb the cap instead.
  assert.ok(!list.some((r) => r.tabId === "tab-0"));
});

test("with every tab open the store runs over rather than losing one", () => {
  // Bounded by what the user actually has open, which is bounded by the user.
  const open = new Set<string>();
  let list: ChatTabRecord[] = [];
  for (let i = 0; i < MAX_CHAT_TABS + 3; i += 1) {
    open.add(`tab-${i}`);
    list = upsertChatTab(list, { tabId: `tab-${i}` }, i, open);
  }
  assert.equal(list.length, MAX_CHAT_TABS + 3);
});

test("dropping a tab leaves the others alone", () => {
  const list = [record({ tabId: "a" }), record({ tabId: "b" })];
  assert.deepEqual(
    dropChatTab(list, "a").map((r) => r.tabId),
    ["b"],
  );
  assert.equal(dropChatTab(list, "missing").length, 2);
});

/* ------------------------------------------------------------------ */
/* Eviction protection                                                  */
/* ------------------------------------------------------------------ */

test("a protected tab record survives eviction pressure", () => {
  resetChatTabProtection();
  protectChatTabId("victim");
  let list = upsertChatTab([], { tabId: "victim", sessionFile: "/v.jsonl" }, 0);
  for (let i = 0; i < MAX_CHAT_TABS + 5; i += 1) {
    list = upsertChatTab(list, { tabId: `tab-${i}` }, i + 1);
  }
  assert.ok(list.some((r) => r.tabId === "victim"));
  unprotectChatTabId("victim");
});

test("a tab stays protected even when the caller forgets the keep set", () => {
  resetChatTabProtection();
  protectChatTabId("victim");
  let list = upsertChatTab([], { tabId: "victim", sessionFile: "/v.jsonl" }, 0);
  for (let i = 0; i < MAX_CHAT_TABS + 5; i += 1) {
    // No keep set passed: the global protection is what keeps it alive.
    list = upsertChatTab(list, { tabId: `tab-${i}` }, i + 1);
  }
  assert.ok(list.some((r) => r.tabId === "victim"));
  unprotectChatTabId("victim");
});

/* ------------------------------------------------------------------ */
/* Restore deduplication                                                */
/* ------------------------------------------------------------------ */

test("a second restore for the same tab id is rejected", () => {
  resetChatTabProtection();
  assert.ok(claimChatTabRestore("shared"));
  assert.ok(!claimChatTabRestore("shared"), "duplicate restore must be rejected");
  finishChatTabRestore("shared");
  // The tab id is still protected, so a new claim still fails.
  assert.ok(!claimChatTabRestore("shared"));
  unprotectChatTabId("shared");
  // Once unprotected, the id can be restored again.
  assert.ok(claimChatTabRestore("shared"));
  finishChatTabRestore("shared");
  unprotectChatTabId("shared");
});

/* ------------------------------------------------------------------ */
/* Dead records                                                        */
/* ------------------------------------------------------------------ */

test("records of deleted workspaces are pruned, plain chats are not", () => {
  const list = [
    record({ tabId: "plain", cwd: "/repo" }),
    record({ tabId: "live", workspaceId: "w1" }),
    record({ tabId: "dead", workspaceId: "gone" }),
  ];
  const { kept, dropped } = pruneChatTabs(list, ["w1"]);
  assert.deepEqual(
    kept.map((r) => r.tabId),
    ["plain", "live"],
  );
  assert.deepEqual(
    dropped.map((r) => r.tabId),
    ["dead"],
  );
});

/* ------------------------------------------------------------------ */
/* The restore decision                                                */
/* ------------------------------------------------------------------ */

test("the tab id is read out of the webview state, and nothing else is", () => {
  assert.equal(parseTabState({ tabId: "a" }), "a");
  assert.equal(parseTabState({ tabId: "" }), undefined);
  assert.equal(parseTabState({ tabId: 3 }), undefined);
  assert.equal(parseTabState(undefined), undefined);
  assert.equal(parseTabState("a"), undefined);
  assert.equal(parseTabState(null), undefined);
});

test("a plain chat comes back on its folder, model and conversation", () => {
  const tab = record({
    tabId: "a",
    cwd: "/repo/sub",
    model: "anthropic/opus",
    sessionFile: "/j.jsonl",
  });
  const plan = planRestore([tab], { tabId: "a" }, []);
  assert.equal(plan.kind, "plain");
  assert.deepEqual(plan.kind === "plain" ? plan.record : undefined, tab);
});

test("a workspace chat is rebound to its workspace, not reopened as a plain one", () => {
  const plan = planRestore(
    [record({ tabId: "a", workspaceId: "w1", cwd: "/wt" })],
    { tabId: "a" },
    ["w1", "w2"],
  );
  assert.equal(plan.kind, "workspace");
  assert.equal(plan.kind === "workspace" ? plan.workspaceId : "", "w1");
});

test("a tab whose workspace is gone is closed, never silently reopened", () => {
  // Its worktree went with the workspace: the agent would start in a directory
  // that no longer exists, on a board row with nothing behind it.
  const plan = planRestore([record({ tabId: "a", workspaceId: "gone" })], { tabId: "a" }, ["w1"]);
  assert.equal(plan.kind, "close");
  assert.equal(plan.kind === "close" ? plan.reason : "", "dead-workspace");
});

test("a panel with no state, or an unknown one, comes back blank rather than wrong", () => {
  assert.deepEqual(planRestore([], undefined, []), { kind: "blank", reason: "no-state" });
  assert.deepEqual(planRestore([record({ tabId: "a" })], { tabId: "b" }, []), {
    kind: "blank",
    reason: "unknown-tab",
  });
});

test("an unpinned tab stays unpinned, so it keeps following the default model", () => {
  // The regression this whole path exists to avoid: a restored chat that comes
  // back on `ompcode.defaultModel` when the user had picked something else —
  // and, the other way round, one pinned to a model it never chose.
  const plan = planRestore([record({ tabId: "a" })], { tabId: "a" }, []);
  assert.equal(plan.kind === "plain" ? plan.record.model : "set", undefined);
});

/* ------------------------------------------------------------------ */
/* Wiring — source invariants                                          */
/* ------------------------------------------------------------------ */
/*
 * extension.ts, ompSession.ts and the renderer all import `vscode` or run in a
 * webview, so `node --test` cannot load them. Following the precedent of
 * test/workspaceManager.test.ts and test/workspaceTerminals.test.ts, these are
 * source-text invariants: promises a refactor could break with no compile error.
 */

const extensionSrc = read("src", "extension.ts");
const sessionSrc = read("src", "ompSession.ts");
const mainSrc = read("media", "main.mjs");
const hostPortSrc = read("media", "host-port.mjs");
const manifest = JSON.parse(read("package.json")) as {
  activationEvents: string[];
};

test("the chat tab viewType has a serializer registered for it", () => {
  // Without this, VS Code discards every persisted chat panel on reload.
  assert.match(
    extensionSrc,
    /registerWebviewPanelSerializer\(\s*"ompcode\.chatTab"/,
  );
});

test("a restore can wake the extension on its own", () => {
  // The serializer is useless if nothing activates the extension for it: the
  // window reloads with no chat view focused and the panel is dropped.
  assert.ok(manifest.activationEvents.includes("onWebviewPanel:ompcode.chatTab"));
});

test("new and restored panels go through the same binding", () => {
  // Two copies of the panel lifecycle is how a restored tab quietly loses its
  // dispose handler, its board row or its host tools. The call sites are named
  // rather than counted: a count is satisfied by the declaration plus any two
  // branches, and `createWebviewPanel` would stay at 1 even if a restore
  // branch grew a second lifecycle of its own around the panel it was handed.
  assert.match(extensionSrc, /bindChatPanel\(panel, randomUUID\(\), cwd, overrides\)/);
  assert.match(
    extensionSrc,
    /bindChatPanel\(panel, plan\.record\.tabId, plan\.record\.cwd, \{/,
  );
  assert.match(extensionSrc, /bindChatPanel\(panel, randomUUID\(\), cwd, undefined\)/);
  assert.equal((extensionSrc.match(/createWebviewPanel\(/g) ?? []).length, 1);
});

test("a restored panel gets its scripts and roots back", () => {
  // `webview.options` do not survive a reload; without this the restored chat
  // renders a blank page with its script blocked.
  assert.match(extensionSrc, /panel\.webview\.options\s*=\s*chatWebviewOptions\(\)/);
});

test("a restored workspace tab is wired from its workspace record", () => {
  // Same overrides as a freshly opened one: model, approval tier, branch,
  // conversation and the write-backs that keep the record current.
  assert.match(extensionSrc, /function workspaceOverrides\(record: WorkspaceRecord\)/);
  assert.match(extensionSrc, /bindChatPanel\(panel, plan\.record\.tabId, record\.worktreePath, workspaceOverrides\(record\)\)/);
});

test("the tab store is written to workspaceState under its versioned key", () => {
  assert.match(extensionSrc, /context\.workspaceState\.update\(CHAT_TABS_KEY/);
  assert.match(extensionSrc, /context\.workspaceState\.get\(CHAT_TABS_KEY/);
  assert.equal(CHAT_TABS_KEY, "ompcode.chatTabs.v1");
});

test("closing a panel does not erase its record", () => {
  // A window reload disposes every panel on the way down. A store that reacted
  // to onDidDispose would wipe itself moments before the restore reads it.
  const dispose = extensionSrc.slice(extensionSrc.indexOf("panel.onDidDispose(() => {"));
  const body = dispose.slice(0, dispose.indexOf("});"));
  assert.doesNotMatch(body, /dropChatTab|persistChatTabs|rememberChatTab/);
});

test("the conversation and the model pin are recorded as they move", () => {
  assert.match(extensionSrc, /rememberChatTab\(\{ tabId, sessionFile: file \}\)/);
  assert.match(extensionSrc, /rememberChatTab\(\{ tabId, model \}\)/);
  // Chained, never replaced: a workspace persists both on its own record too.
  assert.match(extensionSrc, /overrides\?\.onSessionFile\?\.\(file\)/);
  assert.match(extensionSrc, /overrides\?\.onModel\?\.\(model\)/);
});

test("the session carries the tab id into the webview markup", () => {
  // A posted message can lose the race with a reload; the markup cannot.
  assert.match(sessionSrc, /tabId\?: string;/);
  assert.match(sessionSrc, /data-tab-id="\$\{esc\(this\.overrides\.tabId\)\}"/);
  assert.match(sessionSrc, /<div id="app"\$\{tabId\}>/);
});

test("the renderer stores the tab id, which is all a reload hands back", () => {
  assert.match(mainSrc, /getAttribute\("data-tab-id"\)/);
  assert.match(mainSrc, /hostPort\.setState\(\{ tabId: tabId \}\)/);
});

test("the host port exposes VS Code's own state slot", () => {
  assert.match(hostPortSrc, /setState\(value\)\s*\{/);
  assert.match(hostPortSrc, /vscode\.setState\(value\)/);
});

test("a restored panel never becomes a second agent in one worktree", () => {
  // VS Code deserializes a persisted editor only when it is first revealed, so
  // the board can reopen a workspace's chat while its old tab is still an
  // unbound editor. Binding that tab later would put two omp processes in the
  // same worktree, which is exactly what `openChat`'s dedupe exists to stop.
  assert.match(extensionSrc, /function panelForTab\(tabId: string\)/);
  assert.match(extensionSrc, /function panelForWorkspace\(workspaceId: string\)/);
  const restore = extensionSrc.slice(
    extensionSrc.indexOf("function restoreChatTab("),
    extensionSrc.indexOf("function deliverPrompt("),
  );
  // Both identity-bearing branches check before they bind.
  const workspaceBranch = restore.slice(
    restore.indexOf('case "workspace"'),
    restore.indexOf('case "plain"'),
  );
  assert.ok(
    workspaceBranch.indexOf("panelForWorkspace(plan.workspaceId)") <
      workspaceBranch.indexOf("bindChatPanel("),
    "the workspace branch binds before it checks for a live panel",
  );
  const plainBranch = restore.slice(
    restore.indexOf('case "plain"'),
    restore.indexOf('case "close"'),
  );
  assert.ok(
    plainBranch.indexOf("panelForTab(plan.record.tabId)") < plainBranch.indexOf("bindChatPanel("),
    "the plain branch binds before it checks for a live panel",
  );
});

test("the restore path claims the tab id before it binds", () => {
  // A duplicate deserialize for the same persisted surface, or a normal-
  // activation race, must not be allowed to call `bindChatPanel` twice.
  const restore = extensionSrc.slice(
    extensionSrc.indexOf("function restoreChatTab("),
    extensionSrc.indexOf("function deliverPrompt("),
  );
  assert.match(restore, /claimChatTabRestore\(plan\.record\.tabId\)/);
  assert.match(restore, /finishChatTabRestore\(plan\.record\.tabId\)/);
});

test("binding a panel protects its record and disposing unprotects it", () => {
  const bind = extensionSrc.slice(
    extensionSrc.indexOf("function bindChatPanel("),
    extensionSrc.indexOf("function openChatTab("),
  );
  assert.match(bind, /protectChatTabId\(tabId\)/);
  const dispose = bind.slice(bind.indexOf("panel.onDidDispose"));
  assert.match(dispose, /unprotectChatTabId\(tabId\)/);
});

test("a workspace that vanished behind the extension's back takes its tabs with it", () => {
  // `activate` returns before the startup reconcile against `git worktree
  // list` has run, so a worktree removed outside VS Code is still in the
  // registry when the serializer restores its tab. Forgetting the record when
  // the reconcile lands does nothing to that already-open panel.
  const handler = extensionSrc.slice(extensionSrc.indexOf("workspaces.onDidChange(() => {"));
  const body = handler.slice(0, handler.indexOf("\n  });"));
  assert.match(body, /pruneChatTabs\(chatTabs, live\)/);
  assert.match(body, /for \(const \[panel, id\] of \[\.\.\.panelWorkspaces\]\)/);
  // The same shutdown `closeChat` uses: a Remote Control lease would otherwise
  // keep the child alive in a directory that is being deleted under it.
  assert.match(body, /disposeAndWait\(\)/);
  assert.match(body, /panel\.dispose\(\)/);
});

test("the dead-workspace notice is raised once, not once per tab", () => {
  assert.match(extensionSrc, /let deadWorkspaceNoticeShown = false;/);
  assert.match(extensionSrc, /function noteDeadWorkspaceTabs\(message: string\)/);
  // One toast per deletion, and the flag resets so the next one is announced.
  assert.match(extensionSrc, /deadWorkspaceNoticeShown = false;\n\s+const live =/);
  const notices = extensionSrc.match(/showInformationMessage\(\s*\n?\s*t\("A chat tab/g) ?? [];
  assert.equal(notices.length, 0, "the notice goes through noteDeadWorkspaceTabs");
});

test("an unidentifiable tab still asks which folder its agent works in", () => {
  // `openChatTab` refuses to open a chat in a multi-root window without the
  // pick, because each chat's agent runs in exactly one folder. A restore that
  // skipped it would silently land in the first folder — another repository.
  const blank = extensionSrc.slice(
    extensionSrc.indexOf("async function restoreBlankTab("),
    extensionSrc.indexOf("function restoreChatTab("),
  );
  assert.match(blank, /folders\.length > 1/);
  assert.match(blank, /showWorkspaceFolderPick/);
  assert.match(blank, /panel\.dispose\(\); \/\/ cancelled/);
});

test("every restore outcome is handled, and a new one fails to compile", () => {
  // RestorePlan is a closed union so the compiler enumerates the outcomes; a
  // `default:` that binds a blank chat would swallow a future variant.
  assert.match(extensionSrc, /case "blank":/);
  assert.match(extensionSrc, /const never: never = plan;/);
});

test("a restored workspace tab keeps the title VS Code persisted", () => {
  // The panel comes back reading "⎇ omp/fix · Fix the parser"; stamping the
  // bare branch prefix over it drops the agent's own title until it sends
  // another, which a resumed conversation may never do.
  assert.match(extensionSrc, /if \(branchPrefix && !panel\.title\.startsWith\(branchPrefix\)\)/);
});

test("both model pickers pin the model on the session", () => {
  // The chat's own picker and Remote Control's `model.set` go through one
  // helper. When the phone's path only fired the RPC, a model chosen there was
  // lost on the next restart: `configuredModel()` reads the pin, and without
  // it the session fell back to `ompcode.defaultModel`.
  assert.match(sessionSrc, /private pinModel\(provider: string, modelId: string\): void \{/);
  assert.match(sessionSrc, /this\.pinModel\(provider, modelId\);/);
  assert.match(
    sessionSrc,
    /this\.pinModel\(command\.payload\.provider, command\.payload\.modelId\);/,
  );
  // Two pins, and no third: the dead-model failover and the routed-turn swaps
  // are the machine's choice and must leave the user's pin alone.
  assert.equal((sessionSrc.match(/this\.pinModel\(/g) ?? []).length, 2);
});
