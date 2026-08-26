export class ApprovalNotPendingError extends Error {
  readonly code = "host-not-pending";

  constructor() {
    super("approval request is not pending");
    this.name = "ApprovalNotPendingError";
  }
}

/** Claim and remove one pending approval before any response is sent. */
export function claimPendingApproval<T>(
  requestId: string,
  pendingIds: Set<string>,
  pendingFrames: Map<string, T>,
): T | undefined {
  if (!pendingIds.has(requestId)) return undefined;
  const frame = pendingFrames.get(requestId);
  if (frame === undefined) {
    pendingIds.delete(requestId);
    return undefined;
  }
  pendingIds.delete(requestId);
  pendingFrames.delete(requestId);
  return frame;
}
