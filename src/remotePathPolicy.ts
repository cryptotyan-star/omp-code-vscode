import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isPathWithinWorkspaceRoots } from "./remoteProtocol.ts";

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Resolve symlinks for an existing target, or for the nearest existing parent. */
export async function canonicalRemotePath(candidate: string): Promise<string> {
  const absolute = path.resolve(candidate);
  try {
    return await fs.realpath(absolute);
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
  const missing: string[] = [];
  let cursor = absolute;
  for (;;) {
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error("no existing parent for remote path");
    missing.unshift(path.basename(cursor));
    cursor = parent;
    try {
      const canonicalParent = await fs.realpath(cursor);
      return path.join(canonicalParent, ...missing);
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
  }
}

/** Return the canonical target only when it remains under a canonical grant root. */
export async function requireCanonicalRemotePath(
  candidate: string,
  workspaceRoots: readonly string[],
): Promise<string> {
  const [canonical, roots] = await Promise.all([
    canonicalRemotePath(candidate),
    Promise.all(workspaceRoots.map((root) => fs.realpath(path.resolve(root)))),
  ]);
  if (!isPathWithinWorkspaceRoots(canonical, roots)) {
    throw new Error("path resolves outside the granted workspace roots");
  }
  return canonical;
}
