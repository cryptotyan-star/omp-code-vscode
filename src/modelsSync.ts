import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as YAML from "yaml";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Deep-merge `override` on top of `base`. Plain objects merge key-by-key;
 * everything else (arrays, scalars) is replaced by `override`.
 */
function deepMerge(base: unknown, override: unknown): unknown {
  if (isPlainObject(base) && isPlainObject(override)) {
    const out: Record<string, unknown> = { ...base };
    for (const [key, value] of Object.entries(override)) {
      out[key] = deepMerge(out[key], value);
    }
    return out;
  }
  return override;
}

function modelsYmlPath(): string {
  return path.join(os.homedir(), ".omp", "agent", "models.yml");
}

/**
 * Merge the `ompcode.customProviders` setting into `~/.omp/agent/models.yml`.
 *
 * - No-op when the setting is empty.
 * - Creates the directory/file when missing.
 * - Never deletes existing user entries; same-named providers are
 *   deep-merged with the configured values winning.
 * - Throws (without touching the file) when existing YAML is invalid,
 *   so a broken user config is never clobbered.
 */
export async function syncCustomProviders(
  cfg: Record<string, unknown> | null | undefined,
): Promise<void> {
  if (!isPlainObject(cfg) || Object.keys(cfg).length === 0) {
    return;
  }

  const file = modelsYmlPath();

  let text: string | undefined;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw err;
    }
  }

  // Document API keeps user comments/formatting outside the keys we touch.
  const doc =
    text !== undefined && text.trim() !== "" ? YAML.parseDocument(text) : new YAML.Document({});
  if (doc.errors.length > 0) {
    throw new Error(`models.yml is invalid YAML — refusing to overwrite: ${doc.errors[0].message}`);
  }
  const root: unknown = doc.toJSON();
  if (root !== null && root !== undefined && !isPlainObject(root)) {
    throw new Error("models.yml root is not a YAML mapping — refusing to overwrite");
  }
  const existing =
    isPlainObject(root) && isPlainObject(root.providers) ? root.providers : {};

  let changed = false;
  for (const [name, def] of Object.entries(cfg)) {
    const merged = deepMerge(existing[name], def);
    if (JSON.stringify(merged) !== JSON.stringify(existing[name])) {
      doc.setIn(["providers", name], merged);
      changed = true;
    }
  }
  if (!changed) {
    return; // unchanged restarts never touch the file
  }

  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, doc.toString(), "utf8");
}
