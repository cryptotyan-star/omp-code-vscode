import type { ResolvedProfile } from "./modelProfiles";
import * as YAML from "yaml";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/**
 * Recursively reorder a JSON-ish value so every object's own keys appear in
 * sorted order. Arrays keep their element order (it is semantic); only map
 * keys are reordered. Used so an unchanged overlay serialises to a
 * byte-identical YAML file — the spawn caller diffs these files across model
 * switches to decide whether a respawn is needed, and key reordering must not
 * masquerade as a real change.
 */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return (value as unknown[]).map((el) => sortKeysDeep(el));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = sortKeysDeep(value[key]);
    }
    return out;
  }
  return value;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Expand dotted setting keys into the nested shape omp actually reads.
 *
 * omp's own settings SCHEMA names keys with dots (`tools.approvalMode`), and
 * its loader claims to accept both forms, but that is not true of every key:
 * verified against a live agent, a config file containing
 *
 *     tools.approval:
 *       bash: deny
 *
 * has NO effect, while
 *
 *     tools:
 *       approval:
 *         bash: deny
 *
 * blocks the tool — even under `--approval-mode yolo`. Writing the dotted form
 * therefore fails silently, which for an access-control setting is the worst
 * possible failure mode. Profiles may use either spelling; only the nested one
 * is ever written.
 */
function expandDottedKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((el) => expandDottedKeys(el));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value)) {
    const child = expandDottedKeys(raw);
    const parts = key.split(".").filter((p) => p.length > 0);
    if (parts.length < 2) {
      out[key] = mergeInto(out[key], child);
      continue;
    }
    let cursor = out;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!isPlainObject(cursor[part])) {
        cursor[part] = {};
      }
      cursor = cursor[part] as Record<string, unknown>;
    }
    const leaf = parts[parts.length - 1];
    cursor[leaf] = mergeInto(cursor[leaf], child);
  }
  return out;
}

/** Two spellings of the same branch must merge, not clobber each other. */
function mergeInto(existing: unknown, incoming: unknown): unknown {
  if (isPlainObject(existing) && isPlainObject(incoming)) {
    const merged: Record<string, unknown> = { ...existing };
    for (const [k, v] of Object.entries(incoming)) {
      merged[k] = mergeInto(merged[k], v);
    }
    return merged;
  }
  return incoming;
}

function isNonEmptyString(s: string | undefined): s is string {
  return typeof s === "string" && s.length > 0;
}

/**
 * Serialise the profile's `spawn.overlay` settings bag to `<dir>/<family>.yml`
 * and return the absolute path, for the caller to pass to omp as
 * `--config <path>`.
 *
 * Returns `undefined` when the profile carries no overlay. omp's `--config`
 * flag is only meaningful when there are settings to overlay; writing an empty
 * file would invite needless respawn churn without effect. The companion
 * `appendSystemPrompt` is not written here — it is materialised to its own
 * file by `writeAppendPrompt` and passed via `--append-system-prompt`.
 *
 * Keys are emitted sorted (recursively) so two runs over an unchanged profile
 * produce a byte-identical file. The spawn caller compares overlay files to
 * decide whether a model switch requires a restart; a key-order difference
 * must not look like a content change.
 */
export async function writeOverlay(
  dir: string,
  profile: ResolvedProfile,
): Promise<string | undefined> {
  const overlay = profile.spawn?.overlay;
  if (!overlay) {
    return undefined;
  }

  const absDir = path.resolve(dir);
  const filePath = path.join(absDir, `${profile.family}.yml`);
  const yaml = YAML.stringify(sortKeysDeep(expandDottedKeys(overlay)));

  try {
    await fs.mkdir(absDir, { recursive: true });
    await fs.writeFile(filePath, yaml, "utf8");
  } catch (err) {
    throw new Error(
      `Failed to write overlay file ${filePath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return filePath;
}

/**
 * Materialise the profile's `appendSystemPrompt` (plus an optional `extra`
 * string) into `<dir>/<family>-append.md` and return the absolute path, for
 * the caller to pass to omp as `--append-system-prompt <path>`.
 *
 * We always pass a *path* rather than inline text because omp's
 * `resolvePromptInput` first tries a single-line value as a filename and only
 * falls back to literal text for multi-line values — passing inline prompt
 * text that happens to be one line would be ambiguous. The file's content is
 * therefore what omp ultimately reads as the prompt body.
 *
 * The content is forced to end with a trailing newline, which also guarantees
 * it contains at least one newline character. That keeps the body clean and
 * avoids any edge case where a lone single-line body could be reinterpreted
 * downstream as a path rather than literal text.
 *
 * Returns `undefined` when neither `appendSystemPrompt` nor `extra` is
 * present, so the caller can omit the flag entirely.
 */
export async function writeAppendPrompt(
  dir: string,
  profile: ResolvedProfile,
  extra?: string,
): Promise<string | undefined> {
  const append = profile.spawn?.appendSystemPrompt;
  const parts = [append, extra].filter(isNonEmptyString);
  if (parts.length === 0) {
    return undefined;
  }

  const absDir = path.resolve(dir);
  const filePath = path.join(absDir, `${profile.family}-append.md`);
  // One blank line between sections; the trailing newline ensures the body is
  // never a lone single line (see the resolvePromptInput note above).
  const content = `${parts.join("\n\n")}\n`;

  try {
    await fs.mkdir(absDir, { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
  } catch (err) {
    throw new Error(
      `Failed to write append-prompt file ${filePath}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  return filePath;
}

/**
 * Build the omp CLI argument vector for the two file-backed spawn inputs,
 * skipping whichever path is absent. Returns `[]` when neither file was
 * produced, so the caller can spread the result unconditionally.
 *
 * `--config` precedes `--append-system-prompt`; omp accepts either order, but
 * a fixed order keeps spawned-argv diffs readable when the caller logs them.
 */
export function overlayArgs(
  overlayPath?: string,
  appendPromptPath?: string,
): string[] {
  const args: string[] = [];
  if (overlayPath) {
    args.push("--config", overlayPath);
  }
  if (appendPromptPath) {
    args.push("--append-system-prompt", appendPromptPath);
  }
  return args;
}
