/**
 * The per-workspace setup script: where its commands come from, and how they
 * are run.
 *
 * A fresh `git worktree` is a checkout with no `node_modules`, no `.env`, no
 * build output — git copies none of that. Something has to reinstall it before
 * an agent can do anything useful, and that something is repo-specific, so it
 * lives in the worktree rather than in settings.
 *
 * Two files are understood. `.ompcode/workspace.json` is ours;
 * `.superset/config.json` is Superset's and carries the same
 * `{setup, teardown, run, cwd}` shape, so a repo already set up for Superset
 * works here with no extra file. Only the *format* is shared — none of
 * Superset's (Elastic-licensed) code is used or derived from. `verify` is our
 * own addition on top of that shape (see `verify.ts`); a Superset file that
 * happens to carry one is honoured rather than specially rejected.
 *
 * `.ompcode/workspace.local.json` is the personal, git-ignored companion:
 * `before` and `after` wrap the committed `setup` list, which is how someone
 * adds a machine-specific step without editing a file the whole team shares.
 *
 * Running what is parsed here is `setupRun.ts`'s job — it needs `vscode`, and
 * this file must not.
 */

// Nothing here touches `vscode`: running the commands lives in `setupRun.ts`,
// so this half can be imported by `node --test` outside the extension host.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { WorkspaceConfig } from "./types";

/** Where a config was found, or that none was. */
export type WorkspaceConfigSource = "ompcode" | "superset" | "none";

/** The git-ignored personal overlay that wraps the committed setup list. */
export interface WorkspaceLocalConfig {
  before: string[];
  after: string[];
}

const OMPCODE_CONFIG = path.join(".ompcode", "workspace.json");
const OMPCODE_LOCAL_CONFIG = path.join(".ompcode", "workspace.local.json");
const SUPERSET_CONFIG = path.join(".superset", "config.json");
const SUPERSET_LOCAL_CONFIG = path.join(".superset", "config.local.json");

/**
 * Accept both a single command string and a list of them, because both spell
 * the same intent and demanding one of them is a papercut nobody remembers.
 * Anything else in the slot — a number, an object, `null` — is dropped rather
 * than stringified: `"[object Object]"` reaching a shell is worse than a
 * missing step.
 */
function toCommands(value: unknown): string[] {
  const raw = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      continue;
    }
    const command = entry.trim();
    if (command.length > 0) {
      out.push(command);
    }
  }
  return out;
}

/**
 * Turn parsed JSON into a config.
 *
 * `source` is taken but not branched on: the two schemas are field-compatible
 * today, and the parameter is here so that a future divergence in Superset's
 * file lands in this one function instead of at every call site.
 */
export function parseWorkspaceConfig(
  json: unknown,
  source: "ompcode" | "superset",
): WorkspaceConfig {
  void source;
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { setup: [], teardown: [], run: [] };
  }
  const raw = json as Record<string, unknown>;
  const config: WorkspaceConfig = {
    setup: toCommands(raw["setup"]),
    teardown: toCommands(raw["teardown"]),
    run: toCommands(raw["run"]),
  };
  // Only carried when it is actually there: an always-present empty list
  // would read as "this repo says run nothing", which would stop
  // `detectVerifyCommand` from falling back to package.json.
  const verify = toCommands(raw["verify"]);
  if (verify.length > 0) {
    config.verify = verify;
  }
  const cwd = raw["cwd"];
  // An empty `cwd` means "the worktree root", which is already the default —
  // carrying it as `""` would only make callers guard against it.
  if (typeof cwd === "string" && cwd.trim().length > 0) {
    config.cwd = cwd.trim();
  }
  return config;
}

export function parseLocalConfig(json: unknown): WorkspaceLocalConfig {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { before: [], after: [] };
  }
  const raw = json as Record<string, unknown>;
  return { before: toCommands(raw["before"]), after: toCommands(raw["after"]) };
}

/**
 * Wrap the committed setup list with the personal one. Only `setup` is
 * wrapped: `teardown` and `run` belong to the repo, and letting a local file
 * inject into them would make a shared workspace behave differently per
 * machine in ways nobody can see in review.
 */
export function mergeLocalConfig(
  config: WorkspaceConfig,
  local: WorkspaceLocalConfig,
): WorkspaceConfig {
  if (local.before.length === 0 && local.after.length === 0) {
    return config;
  }
  return { ...config, setup: [...local.before, ...config.setup, ...local.after] };
}

/** `undefined` for a missing or unreadable file; parse errors are not fatal. */
async function readJson(file: string): Promise<unknown | undefined> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // A hand-edited config with a trailing comma should degrade to "no setup",
    // not break workspace creation.
    return undefined;
  }
}

/**
 * Read the worktree's setup config: ours first, Superset's as a fallback, then
 * the matching local overlay merged on top.
 *
 * The overlay is looked for next to the config that won, so a Superset repo
 * keeps using `.superset/config.local.json`; `.ompcode/workspace.local.json`
 * still wins if it exists, which is how someone migrates one file at a time.
 * The overlay applies even when no committed config was found, because a
 * purely local setup list is a legitimate way to work in someone else's repo.
 */
export async function readWorkspaceConfig(
  worktreePath: string,
): Promise<{ config: WorkspaceConfig; source: WorkspaceConfigSource }> {
  let source: WorkspaceConfigSource = "none";
  let config: WorkspaceConfig = { setup: [], teardown: [], run: [] };

  const ours = await readJson(path.join(worktreePath, OMPCODE_CONFIG));
  if (ours !== undefined) {
    source = "ompcode";
    config = parseWorkspaceConfig(ours, "ompcode");
  } else {
    const theirs = await readJson(path.join(worktreePath, SUPERSET_CONFIG));
    if (theirs !== undefined) {
      source = "superset";
      config = parseWorkspaceConfig(theirs, "superset");
    }
  }

  let localJson = await readJson(path.join(worktreePath, OMPCODE_LOCAL_CONFIG));
  if (localJson === undefined && source === "superset") {
    localJson = await readJson(path.join(worktreePath, SUPERSET_LOCAL_CONFIG));
  }
  if (localJson !== undefined) {
    config = mergeLocalConfig(config, parseLocalConfig(localJson));
  }

  return { config, source };
}
