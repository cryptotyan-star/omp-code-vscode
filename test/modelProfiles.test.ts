import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyProfileFieldEdit,
  builtinMatchForFamily,
  exactMatchFor,
  isEditableProfileField,
  matchScore,
  resolveProfile,
  spawnSignature,
  isValidProfileRow,
  BASE_PROFILE,
  MODEL_PROFILES,
} from "../src/modelProfiles.ts";
import type { ModelProfile, MatchableModel } from "../src/modelProfiles.ts";

// ---------------------------------------------------------------------------
// matchScore
// ---------------------------------------------------------------------------

test("matchScore: returns 0 for a row with no predicates at all", () => {
  const row: ModelProfile = { family: "x", match: {} };
  const model: MatchableModel = { id: "anything", provider: "p" };
  assert.equal(matchScore(row, model), 0);
});

test("matchScore: specificity weights id=4, provider=2, host=1, and they ADD when combined", () => {
  const model: MatchableModel = {
    id: "claude-sonnet-4",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
  };
  const idOnly: ModelProfile = { family: "a", match: { id: /claude/ } };
  const providerOnly: ModelProfile = { family: "b", match: { provider: ["anthropic"] } };
  const hostOnly: ModelProfile = { family: "c", match: { host: ["anthropic.com"] } };
  const combined: ModelProfile = {
    family: "d",
    match: { id: /claude/, provider: ["anthropic"], host: ["anthropic.com"] },
  };
  assert.equal(matchScore(idOnly, model), 4);
  assert.equal(matchScore(providerOnly, model), 2);
  assert.equal(matchScore(hostOnly, model), 1);
  assert.equal(matchScore(combined, model), 7);
});

test("matchScore: a non-matching predicate zeroes the whole score (AND semantics)", () => {
  const model: MatchableModel = {
    id: "claude-sonnet-4",
    provider: "anthropic",
    baseUrl: "https://api.anthropic.com",
  };
  const idMatchesProviderDoesNot: ModelProfile = {
    family: "a",
    match: { id: /claude/, provider: ["zai"] },
  };
  assert.equal(matchScore(idMatchesProviderDoesNot, model), 0);
});

test("matchScore: strips a provider/ prefix from the model id before testing the regex", () => {
  const row: ModelProfile = { family: "a", match: { id: /^sonnet/ } };
  const model: MatchableModel = { id: "anthropic/sonnet-4" };
  // Without stripping, /^sonnet/ would not match "anthropic/sonnet-4".
  assert.equal(matchScore(row, model), 4);
});

test("matchScore: a /g regex must not leak lastIndex across repeated calls", () => {
  const idRegex = /sonnet/g;
  const row: ModelProfile = { family: "a", match: { id: idRegex } };
  const model: MatchableModel = { id: "claude-sonnet-4" };
  assert.equal(matchScore(row, model), 4);
  assert.equal(matchScore(row, model), 4);
  assert.equal(matchScore(row, model), 4);
  // The shared RegExp object itself must not have been advanced.
  assert.equal(idRegex.lastIndex, 0);
});

// ---------------------------------------------------------------------------
// resolveProfile
// ---------------------------------------------------------------------------

test("resolveProfile: falls back to BASE_PROFILE for a model nothing matches", () => {
  const model: MatchableModel = { id: "unknown-model", provider: "nobody" };
  const resolved = resolveProfile(model, [], []);
  assert.equal(resolved.family, BASE_PROFILE.family);
  assert.equal(resolved.contextFile, BASE_PROFILE.contextFile);
  assert.equal(resolved.badge, BASE_PROFILE.badge);
  assert.equal(resolved.runtime?.thinking, BASE_PROFILE.runtime?.thinking);
  assert.equal(resolved.spawn?.approvalMode, BASE_PROFILE.spawn?.approvalMode);
  assert.equal(resolved.provenance.family, "base");
  assert.equal(resolved.provenance.contextFile, "base");
  assert.equal(resolved.provenance["runtime.thinking"], "base");
  assert.equal(resolved.provenance["spawn.approvalMode"], "base");
});

test("resolveProfile: a more specific row beats a less specific one and the winner's fields override", () => {
  const model: MatchableModel = { id: "glm-5.2", provider: "zai" };
  const lessSpecific: ModelProfile = {
    family: "by-provider",
    match: { provider: ["zai"] },
    runtime: { thinking: "low" },
    spawn: { approvalMode: "always-ask" },
  };
  const moreSpecific: ModelProfile = {
    family: "by-id",
    match: { id: /glm-5/ },
    runtime: { thinking: "high" },
    spawn: { approvalMode: "write" },
  };
  const resolved = resolveProfile(model, [], [lessSpecific, moreSpecific]);
  assert.equal(resolved.family, "by-id");
  assert.equal(resolved.runtime?.thinking, "high");
  assert.equal(resolved.spawn?.approvalMode, "write");
  assert.equal(resolved.provenance.family, "builtin");
  assert.equal(resolved.provenance["runtime.thinking"], "builtin");
  assert.equal(resolved.provenance["spawn.approvalMode"], "builtin");
});

test("resolveProfile: a user row beats a built-in row even when the built-in is more specific", () => {
  const model: MatchableModel = { id: "glm-5.2", provider: "zai" };
  const builtin: ModelProfile = {
    family: "builtin-glm",
    match: { id: /glm-5/, provider: ["zai"] }, // score 6
    runtime: { thinking: "high" },
    spawn: { approvalMode: "yolo" },
  };
  const user: ModelProfile = {
    family: "user-glm",
    match: { provider: ["zai"] }, // score 2 — less specific, but user layer wins
    runtime: { thinking: "medium" },
    spawn: { approvalMode: "write" },
  };
  const resolved = resolveProfile(model, [user], [builtin]);
  assert.equal(resolved.family, "user-glm");
  assert.equal(resolved.runtime?.thinking, "medium");
  assert.equal(resolved.spawn?.approvalMode, "write");
  assert.equal(resolved.provenance.family, "user");
  assert.equal(resolved.provenance["runtime.thinking"], "user");
  assert.equal(resolved.provenance["spawn.approvalMode"], "user");
});

test("resolveProfile: spawn.overlay merges key-by-key across layers (user key keeps built-in keys)", () => {
  const model: MatchableModel = { id: "glm-5.2", provider: "zai" };
  const builtin: ModelProfile = {
    family: "glm",
    match: { provider: ["zai"] },
    spawn: { overlay: { disabledProviders: ["claude"], compaction: { threshold: 100 } } },
  };
  const user: ModelProfile = {
    family: "glm",
    match: { provider: ["zai"] },
    spawn: { overlay: { personality: "terse" } },
  };
  const resolved = resolveProfile(model, [user], [builtin]);
  assert.deepEqual(resolved.spawn?.overlay, {
    disabledProviders: ["claude"],
    compaction: { threshold: 100 },
    personality: "terse",
  });
  assert.equal(resolved.provenance["spawn.overlay"], "user");
});

test("resolveProfile: provenance reports base / builtin / user correctly for overridden fields", () => {
  const model: MatchableModel = { id: "glm-5.2", provider: "zai" };
  const builtin: ModelProfile = {
    family: "glm-builtin",
    match: { provider: ["zai"] },
    runtime: { thinking: "auto" },
    spawn: { overlay: { disabledProviders: ["claude"] } },
  };
  const user: ModelProfile = {
    family: "glm-user",
    match: { provider: ["zai"] },
    badge: "GLM",
  };
  const resolved = resolveProfile(model, [user], [builtin]);
  // family overridden by user
  assert.equal(resolved.family, "glm-user");
  assert.equal(resolved.provenance.family, "user");
  // badge set only by user
  assert.equal(resolved.badge, "GLM");
  assert.equal(resolved.provenance.badge, "user");
  // runtime.thinking set by builtin, untouched by user
  assert.equal(resolved.runtime?.thinking, "auto");
  assert.equal(resolved.provenance["runtime.thinking"], "builtin");
  // spawn.overlay set by builtin
  assert.equal(resolved.provenance["spawn.overlay"], "builtin");
  // spawn.approvalMode never overridden — still base
  assert.equal(resolved.provenance["spawn.approvalMode"], "base");
  // contextFile never overridden — still base
  assert.equal(resolved.provenance.contextFile, "base");
});

// ---------------------------------------------------------------------------
// spawnSignature
// ---------------------------------------------------------------------------

test("spawnSignature: stable under key reordering of an identical overlay (incl. nested), differs when a value changes", () => {
  const base: ModelProfile = {
    family: "x",
    match: { id: /x/ },
    contextFile: "AGENTS.md",
    spawn: {
      approvalMode: "write",
      overlay: { outer: { b: 2, a: 1 }, leaf: true },
    },
  };
  const reordered: ModelProfile = {
    family: "x",
    match: { id: /x/ },
    contextFile: "AGENTS.md",
    spawn: {
      approvalMode: "write",
      overlay: { leaf: true, outer: { a: 1, b: 2 } },
    },
  };
  const changed: ModelProfile = {
    family: "x",
    match: { id: /x/ },
    contextFile: "AGENTS.md",
    spawn: {
      approvalMode: "write",
      overlay: { outer: { b: 99, a: 1 }, leaf: true },
    },
  };
  assert.equal(spawnSignature(base), spawnSignature(reordered));
  assert.notEqual(spawnSignature(base), spawnSignature(changed));
});

// ---------------------------------------------------------------------------
// isValidProfileRow
// ---------------------------------------------------------------------------

test("isValidProfileRow: rejects non-objects, rows with no family, rows with no match, and matches with no predicate", () => {
  // non-objects
  for (const bad of [null, undefined, "string", 42, true, []]) {
    assert.equal(isValidProfileRow(bad), false, `expected false for ${String(bad)}`);
  }
  // row with no family (missing, empty, or wrong type)
  assert.equal(isValidProfileRow({ match: { id: /x/ } }), false);
  assert.equal(isValidProfileRow({ family: "", match: { id: /x/ } }), false);
  assert.equal(isValidProfileRow({ family: 123, match: { id: /x/ } }), false);
  // row with no match
  assert.equal(isValidProfileRow({ family: "x" }), false);
  assert.equal(isValidProfileRow({ family: "x", match: null }), false);
  assert.equal(isValidProfileRow({ family: "x", match: "nope" }), false);
  // match object with no predicate
  assert.equal(isValidProfileRow({ family: "x", match: {} }), false);
});

test("isValidProfileRow: accepts a valid row carrying any single predicate", () => {
  assert.equal(isValidProfileRow({ family: "x", match: { id: /x/ } }), true);
  assert.equal(isValidProfileRow({ family: "x", match: { provider: ["p"] } }), true);
  assert.equal(isValidProfileRow({ family: "x", match: { host: ["h"] } }), true);
});

// ---------------------------------------------------------------------------
// The shipped MODEL_PROFILES against models omp really reports
// ---------------------------------------------------------------------------

test("MODEL_PROFILES: every family resolves through its native provider", () => {
  const cases: Array<[MatchableModel, string, string, string]> = [
    [{ provider: "anthropic", id: "claude-opus-5" }, "claude", "CLAUDE.md", "write"],
    [{ provider: "zhipu-coding-plan", id: "glm-5.2" }, "glm", "AGENTS.md", "always-ask"],
    [{ provider: "alibaba-coding-plan", id: "qwen3.7-plus" }, "qwen", "QWEN.md", "write"],
    [{ provider: "kimi-code", id: "k3" }, "kimi", "AGENTS.md", "always-ask"],
  ];
  for (const [model, family, contextFile, approval] of cases) {
    const p = resolveProfile(model);
    assert.equal(p.family, family, `family for ${model.provider}/${model.id}`);
    assert.equal(p.contextFile, contextFile, `contextFile for ${model.id}`);
    assert.equal(p.spawn?.approvalMode, approval, `approvalMode for ${model.id}`);
  }
});

test("MODEL_PROFILES: a hand-written DashScope provider still gets the right family", () => {
  // The whole reason each family carries a broad id-only row: predicates are
  // ANDed, so a native-provider row alone would miss these entirely.
  const base = "https://dashscope.aliyuncs.com/compatible-mode/v1";
  assert.equal(resolveProfile({ provider: "dashscope", id: "glm-5.2", baseUrl: base }).family, "glm");
  assert.equal(resolveProfile({ provider: "dashscope", id: "qwen3.8-max", baseUrl: base }).family, "qwen");
  assert.equal(
    resolveProfile({ provider: "dashscope", id: "kimi-k2.7-code", baseUrl: base }).family,
    "kimi",
  );
});

test("MODEL_PROFILES: non-Claude families do not inherit a CLAUDE.md written for another agent", () => {
  for (const model of [
    { provider: "zhipu-coding-plan", id: "glm-5.2" },
    { provider: "alibaba-coding-plan", id: "qwen3.8-max" },
    { provider: "kimi-code", id: "k3" },
  ]) {
    const overlay = resolveProfile(model).spawn?.overlay ?? {};
    assert.deepEqual(
      overlay.disabledProviders,
      ["claude"],
      `${model.id} must disable the claude instruction provider`,
    );
  }
  // Claude itself must keep it.
  const claude = resolveProfile({ provider: "anthropic", id: "claude-opus-5" });
  assert.equal(claude.spawn?.overlay, undefined);
});

test("MODEL_PROFILES: an unrelated model falls through to the generic floor", () => {
  const p = resolveProfile({ provider: "ollama", id: "llama3" });
  assert.equal(p.family, "generic");
  assert.equal(p.badge, "");
  assert.equal(p.spawn?.approvalMode, "always-ask");
});

test("MODEL_PROFILES: k2/k3 matching does not fire inside unrelated identifiers", () => {
  assert.notEqual(resolveProfile({ provider: "x", id: "sk23-model" }).family, "kimi");
  assert.notEqual(resolveProfile({ provider: "x", id: "mak2r" }).family, "kimi");
  assert.equal(resolveProfile({ provider: "x", id: "k3" }).family, "kimi");
  assert.equal(resolveProfile({ provider: "x", id: "kimi-k2.5" }).family, "kimi");
});

/* ------------------------------------------------------------------ */
/* Editing a profile field from the inspector                          */
/* ------------------------------------------------------------------ */

test("builtinMatchForFamily prefers the broad row over the provider-scoped one", () => {
  // Predicates are ANDed, so copying `{id, provider}` would stop the override
  // applying to the same family reached through another provider.
  const match = builtinMatchForFamily("qwen");
  assert.equal(match?.id, "qwen");
  assert.equal(match?.provider, undefined);
  assert.equal(match?.host, undefined);
});

test("builtinMatchForFamily returns nothing for a family with no built-in row", () => {
  assert.equal(builtinMatchForFamily("no-such-family"), undefined);
});

test("exactMatchFor pins a single model and escapes regex metacharacters", () => {
  const match = exactMatchFor("gpt-4.1-mini");
  assert.equal(match.id, "^gpt-4\\.1-mini$");
  assert.ok(new RegExp(match.id ?? "", "i").test("gpt-4.1-mini"));
  assert.ok(!new RegExp(match.id ?? "", "i").test("gpt-4x1-mini"));
  assert.ok(!new RegExp(match.id ?? "", "i").test("gpt-4.1-mini-preview"));
});

test("isEditableProfileField accepts only the two closed-set fields", () => {
  assert.ok(isEditableProfileField("runtime.thinking"));
  assert.ok(isEditableProfileField("spawn.approvalMode"));
  assert.ok(!isEditableProfileField("spawn.overlay"));
  assert.ok(!isEditableProfileField("contextFile"));
  assert.ok(!isEditableProfileField("__proto__"));
  assert.ok(!isEditableProfileField(42));
});

const FALLBACK = { id: "qwen" };

test("editing with no existing row appends one carrying the family match", () => {
  const out = applyProfileFieldEdit([], {
    family: "qwen",
    field: "runtime.thinking",
    value: "high",
    fallbackMatch: FALLBACK,
  });
  assert.deepEqual(out, [
    { family: "qwen", match: { id: "qwen" }, runtime: { thinking: "high" } },
  ]);
});

test("editing reuses the existing row for that family", () => {
  const rows = [
    { family: "kimi", match: { id: "kimi" }, runtime: { thinking: "low" } },
    { family: "qwen", match: { id: "qwen3" }, spawn: { approvalMode: "write" } },
  ];
  const out = applyProfileFieldEdit(rows, {
    family: "qwen",
    field: "runtime.thinking",
    value: "medium",
    fallbackMatch: FALLBACK,
  });
  assert.equal(out.length, 2);
  assert.deepEqual(out[1], {
    family: "qwen",
    match: { id: "qwen3" }, // the user's own match is never rewritten
    spawn: { approvalMode: "write" },
    runtime: { thinking: "medium" },
  });
});

test("editing does not mutate the array or the rows handed in", () => {
  const rows = [{ family: "qwen", match: { id: "qwen" }, runtime: { thinking: "low" } }];
  const snapshot = JSON.parse(JSON.stringify(rows)) as unknown;
  applyProfileFieldEdit(rows, {
    family: "qwen",
    field: "runtime.thinking",
    value: "max",
    fallbackMatch: FALLBACK,
  });
  assert.deepEqual(rows, snapshot);
});

test("clearing removes the key, then the emptied section, then the empty row", () => {
  const rows = [{ family: "qwen", match: { id: "qwen" }, runtime: { thinking: "high" } }];
  // A row left as nothing but family+match would keep the inspector claiming
  // the value came from "your settings".
  assert.deepEqual(
    applyProfileFieldEdit(rows, {
      family: "qwen",
      field: "runtime.thinking",
      value: null,
      fallbackMatch: FALLBACK,
    }),
    [],
  );
});

test("clearing keeps a row that still carries something else", () => {
  const rows = [
    {
      family: "qwen",
      match: { id: "qwen" },
      runtime: { thinking: "high", steeringMode: "all" },
      spawn: { approvalMode: "write" },
    },
  ];
  const out = applyProfileFieldEdit(rows, {
    family: "qwen",
    field: "runtime.thinking",
    value: null,
    fallbackMatch: FALLBACK,
  });
  assert.deepEqual(out, [
    {
      family: "qwen",
      match: { id: "qwen" },
      runtime: { steeringMode: "all" },
      spawn: { approvalMode: "write" },
    },
  ]);
});

test("clearing a field nobody set is a no-op, not a new row", () => {
  assert.deepEqual(
    applyProfileFieldEdit([], {
      family: "qwen",
      field: "spawn.approvalMode",
      value: null,
      fallbackMatch: FALLBACK,
    }),
    [],
  );
});

test("rows that are not valid profiles are carried through untouched", () => {
  const rows: unknown[] = ["junk", { family: "qwen" }, 7];
  const out = applyProfileFieldEdit(rows, {
    family: "qwen",
    field: "spawn.approvalMode",
    value: "always-ask",
    fallbackMatch: FALLBACK,
  });
  // `{ family: "qwen" }` has no match predicate, so it is not a profile row —
  // the resolver ignores it, and so must the editor.
  assert.deepEqual(out.slice(0, 3), rows);
  assert.deepEqual(out[3], {
    family: "qwen",
    match: { id: "qwen" },
    spawn: { approvalMode: "always-ask" },
  });
});

test("an edited row actually wins over the built-in when resolved", () => {
  const rows = applyProfileFieldEdit([], {
    family: "qwen",
    field: "spawn.approvalMode",
    value: "always-ask",
    fallbackMatch: builtinMatchForFamily("qwen") ?? { id: "qwen" },
  }) as Array<{ match: { id: string } }>;
  // settings.json holds the regex as a string; the loader compiles it.
  const compiled = rows.map((row) => ({ ...row, match: { ...row.match, id: new RegExp(row.match.id, "i") } }));
  const resolved = resolveProfile(
    { provider: "alibaba-coding-plan", id: "qwen3-max" },
    compiled as never,
  );
  assert.equal(resolved.spawn?.approvalMode, "always-ask");
  assert.equal(resolved.provenance["spawn.approvalMode"], "user");
  // Untouched fields keep coming from the built-in row.
  assert.equal(resolved.contextFile, "QWEN.md");
  assert.equal(resolved.provenance.contextFile, "builtin");
});
