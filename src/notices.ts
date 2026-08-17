import type { OmpFrame } from "./ompProcess";

/**
 * `source` tags omp puts on plumbing notices (device mounts, tool visibility
 * reconciliation, MCP wiring). They are startup bookkeeping, not chat content.
 */
const NOISY_NOTICE_SOURCES = new Set(["xdev", "vision", "mcp", "tools", "startup"]);

/**
 * True for info-level notices that only report internal wiring — the
 * `xd://: mounted …` / `inspect_image is now hidden …` block omp emits on every
 * start. Warnings and errors are never suppressed. The message-shape fallbacks
 * cover omp builds that emit these notices without a `source` tag.
 */
export function isNoisyNotice(frame: OmpFrame): boolean {
  if (frame.type !== "notice") {
    return false;
  }
  const level = typeof frame.level === "string" ? frame.level : "info";
  if (level !== "info") {
    return false;
  }
  const source = typeof frame.source === "string" ? frame.source : "";
  if (source && NOISY_NOTICE_SOURCES.has(source)) {
    return true;
  }
  const message = typeof frame.message === "string" ? frame.message : "";
  return /^xd:\/\/:/.test(message) || /^inspect_image is now (hidden|available)\b/.test(message);
}
