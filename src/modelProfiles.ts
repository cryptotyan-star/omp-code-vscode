/**
 * Per-model behaviour profiles: make the agent work the way each model's own
 * harness works — Claude as Claude Code does, GLM as ZCode does, and so on.
 *
 * WHAT THIS FILE MUST NOT DO
 *
 * omp already resolves the wire-level differences by provider id and base URL,
 * before this extension says anything: the thinking dialect
 * (`zai` / `kimi` / `qwen` / `openai`), the effort ladder (which differs by
 * model AND by host — GLM-5.2 is [high, max] on Zhipu but [minimal..xhigh] on
 * OpenRouter), stream-watchdog floors, Moonshot tool-schema down-levelling,
 * Qwen system-message coalescing, and per-family tool-result shaping. Encoding
 * any of that here would duplicate omp less accurately than omp does it.
 *
 * A profile therefore carries POLICY only — the things omp cannot know: how
 * much autonomy to grant, which instruction file the family's own tooling
 * reads, and which rung of an already-resolved ladder to prefer.
 */

/**
 * Thinking selector sent to `set_thinking_level`.
 *
 * `auto` is omp's own per-turn choice. `inherit` is ours: it means "send the
 * model's `thinking.defaultLevel`", used where no single literal is right
 * across a family — qwen3.7-plus is [minimal..high] while qwen3.8-max is
 * [low, medium, xhigh].
 */
export type ThinkingSelector =
  | "auto"
  | "inherit"
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/** omp's three approval tiers. Native harnesses have four to six. */
export type ApprovalMode = "always-ask" | "write" | "yolo";

/** The subset of omp's Model that profile matching reads. */
export interface MatchableModel {
  provider?: string;
  id?: string;
  baseUrl?: string;
}

/**
 * How a row attaches to a model. Predicates are ANDed; a row with none is
 * rejected at load, since it would match everything.
 *
 * Specificity decides precedence when several rows match: id=4, provider=2,
 * host=1. That ordering exists because the same model arrives by several
 * routes — `glm-5.2` can come from the native `zhipu-coding-plan` provider or
 * from a hand-written DashScope provider — and an id match is the strongest
 * evidence of which family we are actually talking to.
 */
export interface ProfileMatch {
  /** Case-insensitive, tested against the bare model id (no provider prefix). */
  id?: RegExp;
  /** Exact omp provider ids. */
  provider?: readonly string[];
  /** Lowercase substrings tested against `Model.baseUrl`. */
  host?: readonly string[];
}

/** Applied over RPC on model change. Never costs a restart. */
export interface RuntimeProfile {
  /** → `set_thinking_level`. omp clamps to the model's real ladder. */
  thinking?: ThinkingSelector;
  /** → `set_steering_mode`. */
  steeringMode?: "all" | "one-at-a-time";
  /** → `set_interrupt_mode`. */
  interruptMode?: "immediate" | "wait";
}

/** Reaches omp only through spawn argv. Changing any of it forces a restart. */
export interface SpawnProfile {
  /** → `--approval-mode`. */
  approvalMode?: ApprovalMode;
  /**
   * → `--append-system-prompt`, always written to a file and passed as a path.
   * omp's `resolvePromptInput` tries a single-line value as a filename first,
   * so passing literal text inline is ambiguous.
   */
  appendSystemPrompt?: string;
  /**
   * Settings keys serialised to a YAML overlay and passed as `--config`.
   * Carries everything with no CLI flag of its own: `tools.approval`,
   * `disabledProviders`, compaction thresholds, personality.
   */
  overlay?: Record<string, unknown>;
}

export interface ModelProfile {
  /** Stable key — overlay filename, UI badge, provenance labels. */
  family: string;
  match: ProfileMatch;
  /**
   * Instruction file this family's own tooling reads. Claude Code reads
   * CLAUDE.md and explicitly not AGENTS.md; Qwen Code reads QWEN.md then
   * AGENTS.md; Kimi Code and ZCode read AGENTS.md.
   */
  contextFile?: string;
  /** Short chip label, e.g. "GLM". */
  badge?: string;
  /** One line on why these values, shown in the profile inspector. */
  note?: string;
  runtime?: RuntimeProfile;
  spawn?: SpawnProfile;
}

/**
 * Floor for anything unmatched. A fifth model family degrades to exactly the
 * behaviour the extension had before profiles existed.
 */
export const BASE_PROFILE: ModelProfile = {
  family: "generic",
  match: { id: /./ },
  contextFile: "AGENTS.md",
  badge: "",
  runtime: { thinking: "auto" },
  spawn: { approvalMode: "always-ask" },
};

/**
 * Built-in family rows.
 *
 * Each family gets TWO rows on purpose. Predicates are ANDed, so a row naming
 * both an id pattern and a provider only fires on the native route (score 6).
 * The same model routinely arrives another way — `glm-5.2` and `qwen3.8-max`
 * through a hand-written DashScope provider, anything through a corporate
 * proxy — so a broad id-only row (score 4) carries the family identity there,
 * and the native row refines it when it applies.
 *
 * Approval values round DOWN from each harness's native default: omp has three
 * tiers where the originals have four to six, and erring toward asking is the
 * only safe direction to round.
 */
export const MODEL_PROFILES: readonly ModelProfile[] = [
  // ---------------------------------------------------------------- Claude
  {
    family: "claude",
    match: { id: /claude|opus|sonnet|haiku|fable/i },
    contextFile: "CLAUDE.md", // Claude Code reads CLAUDE.md, explicitly not AGENTS.md
    badge: "Claude",
    note: "Claude Code starts interactively in auto/acceptEdits; omp's nearest tier is write. xhigh is Claude Code's own default effort.",
    runtime: { thinking: "xhigh" },
    spawn: { approvalMode: "write" },
  },
  {
    family: "claude",
    match: { id: /claude|opus|sonnet|haiku|fable/i, provider: ["anthropic"] },
    badge: "Claude",
  },

  // ------------------------------------------------------------------- GLM
  {
    // `glm[-.]?\d` rather than `glm-5`, so glm-6 is covered without an edit.
    family: "glm",
    match: { id: /(^|[^a-z])glm[-.]?\d/i },
    contextFile: "AGENTS.md", // ZCode; no GLM.md convention exists
    badge: "GLM",
    note: "ZCode defaults to Confirm Before Changes. The effort ladder depends on both version and host — glm-5.2 is [high, max] on Zhipu but [minimal..xhigh] on OpenRouter — so the level is left to omp.",
    runtime: { thinking: "auto" },
    spawn: {
      approvalMode: "always-ask",
      // CLAUDE.md outranks a bare AGENTS.md in omp's instruction-file
      // providers, so without this a GLM session reads a file written for
      // a different agent.
      overlay: { disabledProviders: ["claude"] },
    },
  },
  {
    family: "glm",
    match: { id: /(^|[^a-z])glm[-.]?\d/i, provider: ["zhipu-coding-plan", "zai"] },
    badge: "GLM",
  },

  // ------------------------------------------------------------------ Qwen
  {
    family: "qwen",
    match: { id: /qwen/i },
    contextFile: "QWEN.md", // Qwen Code reads QWEN.md, then AGENTS.md
    badge: "Qwen",
    note: "Qwen Code's default is classifier approval, one tier above auto-edit; omp has no classifier tier, so it rounds down to write. No single effort literal fits — qwen3.7-plus is [minimal..high] while qwen3.8-max is [low, medium, xhigh].",
    runtime: { thinking: "inherit" },
    spawn: {
      approvalMode: "write",
      overlay: { disabledProviders: ["claude"] },
    },
  },
  {
    family: "qwen",
    match: { id: /qwen/i, provider: ["alibaba-coding-plan", "alibaba-token-plan"] },
    badge: "Qwen",
  },

  // ------------------------------------------------------------------ Kimi
  {
    // Anchored so `k2`/`k3` cannot match inside an unrelated identifier.
    family: "kimi",
    match: { id: /kimi|(^|[^a-z0-9])k[23]([^a-z0-9]|$)/i },
    contextFile: "AGENTS.md", // Kimi Code; it reads neither CLAUDE.md nor QWEN.md
    badge: "Kimi",
    note: "kimi-code ships default_permission_mode = manual. Thinking is on by default; high is safe across the family since omp clamps it up on k3, whose ladder is [low, high, max] with thinking mandatory.",
    runtime: { thinking: "high" },
    spawn: {
      approvalMode: "always-ask",
      overlay: { disabledProviders: ["claude"] },
    },
  },
  {
    family: "kimi",
    match: {
      id: /kimi|(^|[^a-z0-9])k[23]([^a-z0-9]|$)/i,
      provider: ["moonshot", "kimi-code"],
    },
    badge: "Kimi",
  },
];

/** Weight of a row against a model; 0 means no match. */
export function matchScore(row: ModelProfile, model: MatchableModel): number {
  const { match } = row;
  if (!match.id && !match.provider && !match.host) {
    return 0; // a predicate-free row would match everything
  }
  let score = 0;

  if (match.id) {
    const bare = String(model.id ?? "");
    const id = bare.includes("/") ? bare.slice(bare.lastIndexOf("/") + 1) : bare;
    // Regex objects are shared across calls; `lastIndex` would persist on /g.
    if (!new RegExp(match.id.source, match.id.flags.replace(/[gy]/g, "")).test(id)) {
      return 0;
    }
    score += 4;
  }
  if (match.provider) {
    if (!match.provider.includes(String(model.provider ?? ""))) {
      return 0;
    }
    score += 2;
  }
  if (match.host) {
    const url = String(model.baseUrl ?? "").toLowerCase();
    if (!match.host.some((h) => url.includes(h.toLowerCase()))) {
      return 0;
    }
    score += 1;
  }
  return score;
}

/** Field path → the layer that set it, for the inspector. */
export type Provenance = Record<string, "base" | "builtin" | "user">;

export interface ResolvedProfile extends ModelProfile {
  provenance: Provenance;
}

function mergeSection<T extends object>(
  base: T | undefined,
  over: T | undefined,
  prefix: string,
  layer: Provenance[string],
  provenance: Provenance,
): T | undefined {
  if (!over) {
    return base;
  }
  const out = { ...(base ?? {}) } as Record<string, unknown>;
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) {
      continue;
    }
    // `overlay` is a bag of omp settings keys: merge it key-by-key so a user
    // row adding one setting does not drop the built-in ones.
    if (k === "overlay" && isPlainObject(v) && isPlainObject(out[k])) {
      out[k] = { ...(out[k] as object), ...v };
    } else {
      out[k] = v;
    }
    provenance[`${prefix}.${k}`] = layer;
  }
  return out as T;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Resolve the effective profile for a model.
 *
 * Layers, lowest first, merged per leaf field:
 *   0  BASE_PROFILE
 *   1  every matching built-in row, ascending specificity
 *   2  every matching user row from `ompcode.modelProfiles`, ascending
 *
 * Ties break on array order — the first row wins — so a built-in list stays
 * predictable as rows are added.
 */
export function resolveProfile(
  model: MatchableModel,
  userRows: readonly ModelProfile[] = [],
  builtinRows: readonly ModelProfile[] = MODEL_PROFILES,
): ResolvedProfile {
  const provenance: Provenance = {};
  let out: ModelProfile = {
    family: BASE_PROFILE.family,
    match: BASE_PROFILE.match,
    contextFile: BASE_PROFILE.contextFile,
    badge: BASE_PROFILE.badge,
    runtime: { ...BASE_PROFILE.runtime },
    spawn: { ...BASE_PROFILE.spawn },
  };
  for (const key of ["family", "contextFile", "badge"]) {
    provenance[key] = "base";
  }
  for (const key of Object.keys(BASE_PROFILE.runtime ?? {})) {
    provenance[`runtime.${key}`] = "base";
  }
  for (const key of Object.keys(BASE_PROFILE.spawn ?? {})) {
    provenance[`spawn.${key}`] = "base";
  }

  const layers: Array<{ rows: readonly ModelProfile[]; layer: Provenance[string] }> = [
    { rows: builtinRows, layer: "builtin" },
    { rows: userRows, layer: "user" },
  ];

  for (const { rows, layer } of layers) {
    const matched = rows
      .map((row, index) => ({ row, index, score: matchScore(row, model) }))
      .filter((m) => m.score > 0)
      .sort((a, b) => (a.score !== b.score ? a.score - b.score : b.index - a.index));

    for (const { row } of matched) {
      if (row.family) {
        out.family = row.family;
        provenance.family = layer;
      }
      if (row.contextFile !== undefined) {
        out.contextFile = row.contextFile;
        provenance.contextFile = layer;
      }
      if (row.badge !== undefined) {
        out.badge = row.badge;
        provenance.badge = layer;
      }
      if (row.note !== undefined) {
        out.note = row.note;
        provenance.note = layer;
      }
      out.runtime = mergeSection(out.runtime, row.runtime, "runtime", layer, provenance);
      out.spawn = mergeSection(out.spawn, row.spawn, "spawn", layer, provenance);
    }
  }

  return { ...out, provenance };
}

/**
 * The part of a profile that cannot change without respawning the agent.
 * Two signatures comparing equal means a model switch is a pure RPC call.
 */
export function spawnSignature(profile: ModelProfile): string {
  const spawn = profile.spawn ?? {};
  return JSON.stringify({
    approvalMode: spawn.approvalMode ?? null,
    appendSystemPrompt: spawn.appendSystemPrompt ?? null,
    overlay: spawn.overlay ? sortedKeys(spawn.overlay) : null,
    contextFile: profile.contextFile ?? null,
  });
}

/** Stable key order so an unchanged overlay never looks like a change. */
function sortedKeys(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key];
    out[key] = isPlainObject(v) ? sortedKeys(v) : v;
  }
  return out;
}

/** Validate a user-authored row before it can shadow a built-in. */
export function isValidProfileRow(v: unknown): v is ModelProfile {
  if (!isPlainObject(v) || typeof v.family !== "string" || !v.family) {
    return false;
  }
  const match = v.match;
  if (!isPlainObject(match)) {
    return false;
  }
  const hasPredicate =
    typeof match.id === "string" ||
    match.id instanceof RegExp ||
    Array.isArray(match.provider) ||
    Array.isArray(match.host);
  return hasPredicate;
}

/**
 * The fields the profile inspector can edit in place.
 *
 * Both are single scalars with a closed set of values, which is why they are
 * safe to expose as a menu: the UI can offer every legal value and cannot
 * produce an illegal one. Everything else a profile carries — the overlay
 * bag, the instruction file, the note — is free-form, and a hand-rolled
 * editor for it would be worse than settings.json.
 */
export const EDITABLE_PROFILE_FIELDS = ["runtime.thinking", "spawn.approvalMode"] as const;
export type EditableProfileField = (typeof EDITABLE_PROFILE_FIELDS)[number];

export function isEditableProfileField(v: unknown): v is EditableProfileField {
  return typeof v === "string" && (EDITABLE_PROFILE_FIELDS as readonly string[]).includes(v);
}

/** A `match` as it appears in settings.json: `id` is a regex source string. */
export interface SerialisedMatch {
  id?: string;
  provider?: string[];
  host?: string[];
}

/**
 * The match a new user row for `family` should carry, taken from the built-in
 * row it is meant to override.
 *
 * The broad row — the one matching on `id` alone — is preferred over the
 * narrow `{id, provider}` one: predicates are ANDed, so copying the narrow
 * row would silently stop the user's override from applying to the same
 * family reached through a different provider. Returns undefined for a family
 * with no built-in row at all, leaving the caller to scope the row itself.
 */
export function builtinMatchForFamily(
  family: string,
  rows: readonly ModelProfile[] = MODEL_PROFILES,
): SerialisedMatch | undefined {
  const forFamily = rows.filter((row) => row.family === family);
  if (!forFamily.length) {
    return undefined;
  }
  const broad = forFamily.find(
    (row) => row.match.id !== undefined && !row.match.provider && !row.match.host,
  );
  const chosen = broad ?? forFamily[0];
  if (!chosen) {
    return undefined;
  }
  const out: SerialisedMatch = {};
  if (chosen.match.id) {
    out.id = chosen.match.id.source;
  }
  if (chosen.match.provider) {
    out.provider = [...chosen.match.provider];
  }
  if (chosen.match.host) {
    out.host = [...chosen.match.host];
  }
  return out;
}

/** Escape a model id so it matches itself and nothing else. */
export function exactMatchFor(modelId: string): SerialisedMatch {
  return { id: `^${modelId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$` };
}

/**
 * Return `rows` with one field of the user row for `family` set to `value`,
 * or removed when `value` is null.
 *
 * Pure and JSON-shaped on both sides: the input is whatever
 * `ompcode.modelProfiles` currently holds and the output is what should be
 * written back, so the caller only reads and writes configuration.
 *
 * Clearing prunes upward — the key, then an emptied section, then a row that
 * has become nothing but `family` and `match`. Without that last step the
 * settings file would fill with inert rows, and, worse, the inspector would
 * keep reporting the value as coming from "your settings" when it no longer
 * does.
 */
export function applyProfileFieldEdit(
  rows: readonly unknown[],
  edit: {
    family: string;
    field: EditableProfileField;
    value: string | null;
    /** Used only when no row for this family exists yet. */
    fallbackMatch: SerialisedMatch;
  },
): unknown[] {
  const [section, key] = edit.field.split(".") as ["runtime" | "spawn", string];
  const out: unknown[] = rows.map((row) =>
    isPlainObject(row) ? (JSON.parse(JSON.stringify(row)) as unknown) : row,
  );

  let index = out.findIndex(
    (row) => isValidProfileRow(row) && (row as ModelProfile).family === edit.family,
  );

  if (index === -1) {
    if (edit.value === null) {
      return out; // nothing of the user's to clear
    }
    out.push({ family: edit.family, match: { ...edit.fallbackMatch } });
    index = out.length - 1;
  }

  const row = out[index] as Record<string, unknown>;
  const bag = isPlainObject(row[section]) ? { ...(row[section] as object) } : {};

  if (edit.value === null) {
    delete (bag as Record<string, unknown>)[key];
    if (Object.keys(bag).length === 0) {
      delete row[section];
    } else {
      row[section] = bag;
    }
    const left = Object.keys(row).filter((k) => k !== "family" && k !== "match");
    if (left.length === 0) {
      out.splice(index, 1);
    }
    return out;
  }

  (bag as Record<string, unknown>)[key] = edit.value;
  row[section] = bag;
  return out;
}
