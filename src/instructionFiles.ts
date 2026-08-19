import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ResolvedProfile } from "./modelProfiles";

/**
 * Instruction files that the `omp` CLI discovers on its own when it launches
 * an agent in a workspace. omp walks the project root for exactly these three
 * files and folds any it finds into the agent's system prompt before the
 * extension ever gets a turn.
 *
 * This list exists because of a discovery gap that drives the whole module:
 * omp discovers AGENTS.md, CLAUDE.md and GEMINI.md, but NOT QWEN.md. Yet Qwen
 * Code's own harness reads QWEN.md first, then AGENTS.md — so a Qwen session
 * started through omp would silently miss the QWEN.md the user wrote for
 * Qwen Code unless this extension reads that file itself and feeds it to the
 * agent via `--append-system-prompt`. The functions below use this list to
 * decide which files the extension must supply manually versus which it can
 * trust omp to find.
 */
export const OMP_DISCOVERS: readonly string[] = [
  "AGENTS.md",
  "CLAUDE.md",
  "GEMINI.md",
];

/** 64 KB, measured in UTF-8 bytes. See {@link readInstructionFile}. */
const MAX_INSTRUCTION_BYTES = 64 * 1024;

/** Appended when a project instruction file exceeds the safety cap. */
const TRUNCATION_MARKER =
  "\n\n[truncated: this project instruction file exceeds the 64 KB safety cap; only the first 64 KB is included]\n";

/**
 * Decide whether the extension must read `contextFile` itself.
 *
 * Why this exists: each model family's own tooling reads a different project
 * instruction file — Claude Code reads CLAUDE.md (and explicitly not
 * AGENTS.md), Qwen Code reads QWEN.md then AGENTS.md, Kimi Code and ZCode
 * read AGENTS.md. omp only discovers the files in {@link OMP_DISCOVERS}; any
 * family whose file omp cannot find — today, Qwen's QWEN.md — would be
 * silently dropped unless the extension reads it and passes it to the agent
 * through `--append-system-prompt`. This predicate is the switch that keeps
 * that from happening.
 *
 * The comparison is case-insensitive: instruction-file discovery on real
 * filesystems is case-insensitive on macOS/Windows (and routinely lowercase
 * on Linux), and the configured name can arrive in either case from a profile.
 *
 * @returns `true` when `contextFile` is set and is NOT in
 * {@link OMP_DISCOVERS}; `false` when it is absent or omp will discover it.
 */
export function needsManualLoad(contextFile: string | undefined): boolean {
  if (!contextFile) {
    return false;
  }
  const target = contextFile.toLowerCase();
  return !OMP_DISCOVERS.some((name) => name.toLowerCase() === target);
}

/**
 * Read a family's project instruction file so it can be injected into the
 * agent's system prompt via `--append-system-prompt`.
 *
 * Returns `undefined` ("nothing to inject") in three cases:
 *  1. `contextFile` is absent or omp will discover it —
 *     {@link needsManualLoad} is `false`, so injecting would duplicate what
 *     omp already supplies and double the prompt weight for that file.
 *  2. the file does not exist in `cwd` — a missing file is the normal state
 *     (the user simply has not written one), so ENOENT is swallowed rather
 *     than surfaced as an error. Any other I/O failure (permissions, a broken
 *     symlink) is rethrown, because those indicate a real problem the user
 *     needs to see rather than a quietly empty prompt.
 *
 * Safety cap — 64 KB: a project instruction file can be arbitrarily large and
 * its contents land verbatim in the system prompt, where every byte counts
 * against the context window and, on some providers, against cost. The cap is
 * applied to UTF-8 *bytes*, not character count, because the families this
 * module serves — Qwen, GLM, Kimi — are CJK-heavy and a CJK character is
 * three UTF-8 bytes; a character cap would let through roughly 3× the byte
 * budget for a Chinese QWEN.md. Truncation always lands on a character
 * boundary so no multi-byte sequence is split.
 *
 * The returned text is wrapped in a heading so the agent can distinguish this
 * block from omp's own discovery output and from any other appended prompt.
 *
 * @returns the wrapped file contents, or `undefined` when there is nothing
 * to inject.
 */
export async function readInstructionFile(
  cwd: string,
  contextFile: string | undefined,
): Promise<string | undefined> {
  // The `!contextFile` guard is not redundant with needsManualLoad(): it
  // narrows the type to `string` for the rest of the function so join() and
  // the template below receive a definite string.
  if (!contextFile || !needsManualLoad(contextFile)) {
    return undefined;
  }

  // join(), not `/`, so this resolves correctly on Windows where the path
  // separator is a backslash.
  const filePath = join(cwd, contextFile);

  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (err: unknown) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw err;
  }

  let body: string;
  if (Buffer.byteLength(content, "utf8") <= MAX_INSTRUCTION_BYTES) {
    body = content;
  } else {
    // Re-encode to slice on a byte boundary. A UTF-8 continuation byte has
    // the bit pattern 10xxxxxx (0x80–0xBF); the leading byte of a character
    // does not, so walking back past continuation bytes lands on a safe cut.
    const buf = Buffer.from(content, "utf8");
    let end = MAX_INSTRUCTION_BYTES;
    while (end > 0 && (buf[end] & 0xc0) === 0x80) {
      end--;
    }
    body = buf.subarray(0, end).toString("utf8") + TRUNCATION_MARKER;
  }

  return `# Project instructions from ${contextFile}\n\n${body}`;
}

/**
 * One-line summary for the profile inspector describing how a profile's
 * instruction file reaches the agent.
 *
 * The three phrasings matter to the user because they explain a behavioural
 * difference that is otherwise invisible: a file the extension loads
 * ("loaded by the extension") is injected through
 * `--append-system-prompt` and so survives a model switch with no respawn;
 * a file omp discovers ("discovered by omp") is handled entirely by omp; a
 * file that should have been loaded but was not found in the workspace
 * ("not found in this workspace") means the family's expected instructions
 * are simply absent for this run, which is usually news the user can act on.
 */
export function describeInstructionSetup(
  profile: ResolvedProfile,
  loaded: boolean,
): string {
  const file = profile.contextFile;
  if (!file) {
    return "No project instruction file configured for this profile";
  }
  if (needsManualLoad(file)) {
    return loaded
      ? `Reads ${file} (loaded by the extension)`
      : `Reads ${file} (not found in this workspace)`;
  }
  return `Reads ${file} (discovered by omp)`;
}
