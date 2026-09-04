import * as vscode from "vscode";
import { t } from "../l10n.ts";
import { baseContent } from "../workspaces/diff.ts";
import type { WorkspaceRecord } from "../workspaces/types.ts";

/**
 * The left-hand side of every review diff: a file as it stood at the commit
 * the workspace was cut from.
 *
 * It is a virtual document rather than a temp file for two reasons. The base
 * version is not on disk anywhere — the worktree holds the agent's version and
 * the main checkout has moved on — and a read-only URI is what makes VS Code
 * render the pane as un-editable, so nobody can "fix" the base side of a diff
 * and lose the edit when the document closes.
 *
 * The SHA travels in the query string even though the record already carries
 * it. VS Code caches content per-URI for the life of a document, and a
 * workspace whose base is re-pinned would otherwise keep serving the old text
 * from a URI that looks identical.
 */
export class BaseContentProvider implements vscode.TextDocumentContentProvider {
  public static readonly scheme = "ompcode-base";

  constructor(private readonly resolve: (workspaceId: string) => WorkspaceRecord | undefined) {}

  /**
   * `ompcode-base://<workspaceId>/<relPath>?sha=<baseSha>`.
   *
   * Built with `Uri.from` rather than `Uri.parse`: a path can hold `#` or `?`,
   * and parsing a hand-assembled string would silently amputate the file name
   * at the first of them.
   *
   * The id rides in the authority, which URI serialisation lower-cases. That is
   * safe only because ids are `randomUUID()` — lowercase hex with no separator
   * an authority would mangle (`manager.ts`). An id source with uppercase or
   * with `/`, `@`, `:` or a space would have to move into the path instead.
   */
  static uriFor(record: WorkspaceRecord, relPath: string): vscode.Uri {
    const clean = relPath.replace(/^\/+/, "");
    return vscode.Uri.from({
      scheme: BaseContentProvider.scheme,
      authority: record.id,
      path: `/${clean}`,
      query: `sha=${record.baseSha}`,
    });
  }

  /**
   * The same file, but always empty.
   *
   * The right-hand side of a diff for a file the agent *deleted*. A `file:`
   * URI for a path that is no longer on disk does not render as an empty pane —
   * it renders as a file-not-found error, which is why VS Code's own git
   * extension hands the diff a virtual document for the deleted side too.
   */
  static emptyUriFor(record: WorkspaceRecord, relPath: string): vscode.Uri {
    const uri = BaseContentProvider.uriFor(record, relPath);
    // A distinct query, so VS Code's per-URI content cache cannot confuse this
    // with the base side of the very same file.
    return uri.with({ query: `${uri.query}&empty=1` });
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    if (/(^|&)empty=1($|&)/.test(uri.query)) {
      return "";
    }
    const record = this.resolve(uri.authority);
    if (!record) {
      // Thrown, not blanked: an empty left side is how "this file is new" is
      // drawn, so returning "" for a workspace that has been deleted would
      // quietly claim the agent wrote the whole file.
      throw new Error(t("Workspace {0} no longer exists.", uri.authority));
    }
    const relPath = uri.path.replace(/^\/+/, "");
    if (!relPath) {
      // Untranslated on purpose: only a caller that built the URI by hand can
      // land here, so this is a bug report for a developer, not a user message.
      throw new Error(`${BaseContentProvider.scheme}: no file path in ${uri.toString()}`);
    }
    // The URI wins over the record: the diff the user is looking at was opened
    // against a particular commit, and re-pinning the base underneath an open
    // editor must not swap out the text it is showing.
    const sha = shaOf(uri) ?? record.baseSha;
    const content = await baseContent(record.worktreePath, sha, relPath);
    // Absent from the base — added or untracked. An empty left side is exactly
    // how VS Code draws "file added", so this is the answer, not a failure.
    return content ?? "";
  }
}

/** `sha=<value>` out of the query, without pulling in a URL parser. */
function shaOf(uri: vscode.Uri): string | undefined {
  for (const pair of uri.query.split("&")) {
    const at = pair.indexOf("=");
    if (at !== -1 && pair.slice(0, at) === "sha") {
      const value = decodeURIComponent(pair.slice(at + 1)).trim();
      return value || undefined;
    }
  }
  return undefined;
}
