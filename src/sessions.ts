import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Session history across the whole extension.
 *
 * omp has no "list sessions" RPC — it persists every session as JSONL under
 * `~/.omp/agent/sessions/<slugged-cwd>/<timestamp>_<id>.jsonl`. We read those
 * files directly, so the list spans every workspace and every model, and
 * `switch_session` reopens any of them by path.
 */

export interface SessionSummary {
  /** Absolute path of the JSONL file — what `switch_session` takes. */
  path: string;
  id: string;
  cwd: string;
  /** omp's auto-generated title, empty when it never got one. */
  title: string;
  /** First user message, for rows with no title. */
  preview: string;
  startedAt: number;
  updatedAt: number;
  userMessages: number;
  /** Distinct `provider/model` values that produced assistant replies, in order of first use. */
  models: string[];
}

/** Files bigger than this are summarized from their head and tail only. */
const HUGE_FILE_BYTES = 4 * 1024 * 1024;
const EDGE_LINES = 400;
const PREVIEW_CHARS = 160;

export function sessionsRoot(): string {
  return path.join(os.homedir(), ".omp", "agent", "sessions");
}

function textOf(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: string }).type === "text") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string") {
        parts.push(text);
      }
    }
  }
  return parts.join("\n");
}

/**
 * Build a summary from a session file's contents. Returns undefined for
 * sessions with no user message — omp writes a file the moment an agent starts,
 * so most of them are empty shells from restarts and would bury the real ones.
 */
export function summarizeSession(
  text: string,
  meta: { path: string; updatedAt: number },
): SessionSummary | undefined {
  const all = text.split("\n");
  const lines =
    text.length > HUGE_FILE_BYTES
      ? [...all.slice(0, EDGE_LINES), ...all.slice(-EDGE_LINES)]
      : all;

  let id = "";
  let cwd = "";
  let title = "";
  let startedAt = 0;
  let preview = "";
  let userMessages = 0;
  const models: string[] = [];
  /** Fallback when a session has model_change entries but no assistant reply yet. */
  let lastConfiguredModel = "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue; // truncated tail slice, or a partially written line
    }
    switch (entry.type) {
      case "title":
        if (typeof entry.title === "string" && entry.title) {
          title = entry.title;
        }
        break;
      case "session":
        if (typeof entry.id === "string") {
          id = entry.id;
        }
        if (typeof entry.cwd === "string") {
          cwd = entry.cwd;
        }
        if (typeof entry.timestamp === "string") {
          const parsed = Date.parse(entry.timestamp);
          if (!Number.isNaN(parsed)) {
            startedAt = parsed;
          }
        }
        break;
      case "model_change":
        if (typeof entry.model === "string") {
          lastConfiguredModel = entry.model;
        }
        break;
      case "message": {
        const message = entry.message as Record<string, unknown> | undefined;
        if (!message) {
          break;
        }
        if (message.role === "user") {
          userMessages++;
          if (!preview) {
            preview = textOf(message.content).trim().slice(0, PREVIEW_CHARS);
          }
        } else if (message.role === "assistant") {
          const provider = typeof message.provider === "string" ? message.provider : "";
          const model = typeof message.model === "string" ? message.model : "";
          if (provider && model) {
            const key = `${provider}/${model}`;
            if (!models.includes(key)) {
              models.push(key);
            }
          }
        }
        break;
      }
      default:
        break;
    }
  }

  if (!userMessages) {
    return undefined;
  }
  if (!models.length && lastConfiguredModel) {
    models.push(lastConfiguredModel);
  }
  return {
    path: meta.path,
    id: id || path.basename(meta.path).replace(/\.jsonl$/, ""),
    cwd,
    title,
    preview,
    startedAt: startedAt || meta.updatedAt,
    updatedAt: meta.updatedAt,
    userMessages,
    models,
  };
}

/** Cache keyed by `path` — a finished session file never changes again. */
const cache = new Map<string, { updatedAt: number; summary: SessionSummary | undefined }>();

/** Tool results longer than this are cut — transcripts stay skimmable. */
const TRANSCRIPT_RESULT_MAX = 4000;

/**
 * Serialize the agent's message list (get_messages shape) to Markdown for
 * "Export transcript". Fences are four backticks so embedded ``` blocks in
 * tool output cannot break the document.
 */
export function formatTranscript(messages: unknown[], exportedAt = new Date()): string {
  const out: string[] = [
    "# OMP Code transcript",
    "",
    `_Exported ${exportedAt.toISOString()} · ${messages.length} messages_`,
    "",
  ];
  for (const raw of messages) {
    if (!raw || typeof raw !== "object") {
      continue;
    }
    const m = raw as Record<string, unknown>;
    if (m.role === "user") {
      if (m.synthetic) {
        continue; // injected context, not something the user typed
      }
      const text = textOf(m.content).trim();
      out.push("## You", "", text || "_(no text)_", "");
    } else if (m.role === "assistant") {
      const model = typeof m.model === "string" ? m.model : "";
      out.push(model ? `## Assistant (${model})` : "## Assistant", "");
      const content = Array.isArray(m.content) ? m.content : [];
      for (const block of content) {
        if (!block || typeof block !== "object") {
          continue;
        }
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
          out.push(b.text.trim(), "");
        } else if (b.type === "thinking") {
          const thinking =
            typeof b.thinking === "string" ? b.thinking
            : typeof b.text === "string" ? b.text
            : "";
          if (thinking.trim()) {
            out.push(...thinking.trim().split("\n").map((line) => `> ${line}`), "");
          }
        } else if (b.type === "toolCall") {
          const name = typeof b.name === "string" ? b.name : "tool";
          out.push(`**⚙ ${name}**`, "");
          const args = b.arguments;
          const argsText =
            typeof args === "string" ? args : args ? JSON.stringify(args, null, 2) : "";
          if (argsText && argsText !== "{}") {
            out.push("````json", argsText, "````", "");
          }
        }
      }
    } else if (m.role === "toolResult") {
      const name = typeof m.toolName === "string" ? m.toolName : "tool";
      const isError = m.isError === true;
      const text = textOf(m.content);
      const truncated = text.length > TRANSCRIPT_RESULT_MAX;
      out.push(`### Result — ${name}${isError ? " (error)" : ""}`, "");
      out.push(
        "````text",
        truncated ? `${text.slice(0, TRANSCRIPT_RESULT_MAX)}\n… (truncated)` : text,
        "````",
        "",
      );
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}

/**
 * Newest sessions first, across every workspace omp has run in.
 * `limit` bounds how many files are read, not how many are returned.
 */
export async function listSessions(limit = 80): Promise<SessionSummary[]> {
  const root = sessionsRoot();
  let dirs: string[];
  try {
    dirs = (await fs.readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => path.join(root, e.name));
  } catch {
    return []; // no sessions yet
  }

  const files: Array<{ path: string; updatedAt: number }> = [];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) {
        continue;
      }
      const file = path.join(dir, name);
      try {
        const stat = await fs.stat(file);
        files.push({ path: file, updatedAt: stat.mtimeMs });
      } catch {
        /* vanished between readdir and stat */
      }
    }
  }

  files.sort((a, b) => b.updatedAt - a.updatedAt);

  const out: SessionSummary[] = [];
  for (const file of files.slice(0, limit)) {
    const cached = cache.get(file.path);
    if (cached && cached.updatedAt === file.updatedAt) {
      if (cached.summary) {
        out.push(cached.summary);
      }
      continue;
    }
    let summary: SessionSummary | undefined;
    try {
      summary = summarizeSession(await fs.readFile(file.path, "utf8"), file);
    } catch {
      summary = undefined;
    }
    cache.set(file.path, { updatedAt: file.updatedAt, summary });
    if (summary) {
      out.push(summary);
    }
  }
  return out;
}
