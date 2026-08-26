/**
 * Decision logic for reverting one agent edit back to the snapshot taken
 * just before the tool ran. Pure on purpose: the host (ompSession) supplies
 * file contents and performs the actual write, so this stays unit-testable.
 */

import { createHash } from "node:crypto";

export interface RevertInput {
  /** Snapshot content captured before the tool ran (which may legitimately be empty). */
  before: string;
  /** Whether the path existed before the tool ran. */
  existedBefore: boolean;
  /** File content on disk right now, or null when the file no longer exists. */
  current: string | null;
  /** The file is open in an editor with unsaved changes. */
  dirty: boolean;
  /** Hash of the file state immediately after the tool finished. */
  afterHash?: string;
}

export interface RevertPlan {
  /** What to do; `blocked` explains why instead. */
  action: "noop" | "delete" | "write" | "blocked";
  /** Human-facing reason for a blocked action. */
  reason?: "dirty" | "drift" | "unverified";
  /** Content to write back (only for action:"write"). */
  content?: string;
}

/** Stable identity for both a file's contents and the missing-path state. */
export function revertStateHash(content: string | null): string {
  return content === null
    ? "missing"
    : `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;
}

/**
 * Compare the snapshot against the file's current state.
 *
 * A file the agent created is reverted by deleting it. `existedBefore` is
 * deliberately separate from `before`: an existing empty file must be written
 * back to empty, not mistaken for a newly-created path and deleted.
 *
 * The after-hash is the optimistic-concurrency guard. If anything changed on
 * disk after the tool finished, the revert is blocked instead of overwriting a
 * later user/agent edit. A path already back in its exact before-state is a
 * no-op and needs no mutation.
 */
export function planRevert(input: RevertInput): RevertPlan {
  if (input.dirty) {
    // Writing into a dirty document would discard the user's unsaved edits
    // without a chance to get them back; refuse instead of guessing.
    return { action: "blocked", reason: "dirty" };
  }
  const alreadyBefore = input.existedBefore
    ? input.current === input.before
    : input.current === null;
  if (alreadyBefore) {
    return { action: "noop" };
  }
  if (input.afterHash === undefined) {
    return { action: "blocked", reason: "unverified" };
  }
  if (revertStateHash(input.current) !== input.afterHash) {
    return { action: "blocked", reason: "drift" };
  }
  if (!input.existedBefore) {
    return { action: "delete" };
  }
  return { action: "write", content: input.before };
}
