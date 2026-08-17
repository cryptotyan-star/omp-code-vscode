import * as path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A file handed to the agent with the next prompt. The agent reads files with
 * its own tools, so an attachment is a *path*, never inlined content — a 2 MB
 * source file must not be pasted into the context window.
 */
/** Line range of an editor selection, 1-based and inclusive. */
export interface AttachmentSelection {
  startLine: number;
  endLine: number;
}

export interface Attachment {
  /** Absolute filesystem path the agent can read. */
  path: string;
  /** Display name (basename) shown on the composer chip. */
  name: string;
  /** Size in bytes when the host could stat it. */
  size?: number;
  /** Present when the attachment is an editor selection, not a whole file. */
  selection?: AttachmentSelection;
  /** Selected source text, inlined into the prompt (bounded — see MAX_SNIPPET_CHARS). */
  snippet?: string;
  /** VS Code language id, used for the fenced code block around `snippet`. */
  language?: string;
}

/**
 * Cap for clipboard/drop payloads the host copies into extension storage.
 * Dropped/pasted *paths* are not copied and are not subject to this.
 */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/**
 * Cap for inlined selection snippets. A selection is small by nature; this
 * only guards against a whole-file select-all being pasted into the context.
 */
export const MAX_SNIPPET_CHARS = 30_000;

/**
 * Parse a `text/uri-list` (RFC 2483) or VS Code `vnd.code.uri-list` payload
 * into local filesystem paths. Non-file URIs (http, vscode-remote, untitled)
 * are dropped: the agent runs on the local filesystem and cannot read them.
 */
export function parseUriList(raw: string): string[] {
  const out: string[] = [];
  for (const line of String(raw ?? "").split(/\r?\n/)) {
    const entry = line.trim();
    if (!entry || entry.startsWith("#")) {
      continue;
    }
    if (/^file:\/\//i.test(entry)) {
      try {
        out.push(fileURLToPath(entry));
      } catch {
        // Malformed file URI — skip rather than feed the agent a bad path.
      }
      continue;
    }
    // No scheme test here: on Windows `C:\dir\file` looks exactly like a URI
    // scheme, so absoluteness — not shape — decides what is a local path.
    if (path.isAbsolute(entry)) {
      out.push(entry);
    }
  }
  return dedupe(out);
}

/** Order-preserving de-duplication of paths. */
export function dedupe(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    if (!p || seen.has(p)) {
      continue;
    }
    seen.add(p);
    out.push(p);
  }
  return out;
}

/**
 * Make a clipboard-supplied name safe to use as a filename in extension
 * storage: no separators, no traversal, no control characters.
 */
export function safeFileName(name: string, fallback = "pasted-file"): string {
  const base = path.basename(String(name ?? "").replace(/\\/g, "/"));
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[/\\:*?"<>|]/g, "-")
    .replace(/^\.+/, "")
    .trim();
  if (!cleaned) {
    return fallback;
  }
  return cleaned.length > 120 ? cleaned.slice(0, 120) : cleaned;
}

/** Human-readable size for composer chips and the diagnostics log. */
export function formatSize(bytes: number | undefined): string {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) {
    return "";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

/**
 * Build the prompt actually sent to omp. Attachments become an explicit path
 * list appended to the user's text; the agent opens what it needs with `read`.
 * Composition lives host-side so there is exactly one format to maintain.
 */
/**
 * Build the prompt actually sent to omp. Whole-file attachments become an
 * explicit path list (the agent opens what it needs with `read`); editor
 * selections additionally inline their snippet, since the *point* of a
 * selection is that exact text — the path alone would lose the range.
 * Composition lives host-side so there is exactly one format to maintain.
 */
export function composePrompt(text: string, attachments: Attachment[]): string {
  const body = String(text ?? "").trim();
  const list = attachments ?? [];
  if (list.length === 0) {
    return body;
  }
  // De-dupe by path + range: attaching a file and a selection from it are two
  // different things, but the same drop twice is one.
  const seen = new Set<string>();
  const entries: Attachment[] = [];
  for (const att of list) {
    if (!att || typeof att.path !== "string" || !att.path) {
      continue;
    }
    const sel = att.selection;
    const key = sel ? `${att.path}#L${sel.startLine}-${sel.endLine}` : att.path;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    entries.push(att);
  }
  if (entries.length === 0) {
    return body;
  }
  const lines = ["Attached files:"];
  const snippets: string[] = [];
  for (const att of entries) {
    const sel = att.selection;
    if (!sel) {
      lines.push(`- ${att.path}`);
      continue;
    }
    const range = `lines ${sel.startLine}–${sel.endLine}`;
    lines.push(`- ${att.path} (${range})`);
    const snippet = typeof att.snippet === "string" ? att.snippet : "";
    if (!snippet) {
      continue;
    }
    const truncated = snippet.length > MAX_SNIPPET_CHARS;
    const code = truncated ? snippet.slice(0, MAX_SNIPPET_CHARS) : snippet;
    // Language id must not be able to break out of its own fence.
    const langRaw = String(att.language ?? "").trim();
    const lang = /^[\w#+.-]{1,30}$/.test(langRaw) ? langRaw : "";
    snippets.push(
      `Selected code from ${att.path} (${range}):\n` +
        `\`\`\`${lang}\n${code}\n` +
        (truncated ? `\n… (truncated at ${MAX_SNIPPET_CHARS} chars — full file at the path above)\n` : "") +
        "```",
    );
  }
  const block = snippets.length
    ? `${lines.join("\n")}\n\n${snippets.join("\n\n")}`
    : lines.join("\n");
  return body ? `${body}\n\n${block}` : block;
}
