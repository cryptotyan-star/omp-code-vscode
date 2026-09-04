export const REMOTE_CAPABILITY_REFRESH_WINDOW_MS = 24 * 60 * 60 * 1000;
export const REMOTE_CAPABILITY_MAX_TIMER_MS = 24 * 24 * 60 * 60 * 1000;

/** Refresh an authenticated device grant before it can expire mid-session. */
export function shouldRefreshRemoteCapability(
  expiresAt: number,
  nowMs: number,
  refreshWindowMs = REMOTE_CAPABILITY_REFRESH_WINDOW_MS,
): boolean {
  if (!Number.isSafeInteger(expiresAt) || !Number.isSafeInteger(nowMs) || refreshWindowMs < 0) {
    throw new Error("invalid remote capability refresh time");
  }
  return expiresAt <= nowMs + refreshWindowMs;
}

/** Node timers cap near 24.85 days, so long grants wake and reschedule safely. */
export function remoteCapabilityRefreshDelay(expiresAt: number, nowMs: number): number {
  const untilRefresh = Math.max(0, expiresAt - nowMs - REMOTE_CAPABILITY_REFRESH_WINDOW_MS);
  return Math.min(untilRefresh, REMOTE_CAPABILITY_MAX_TIMER_MS);
}

/**
 * Restore a persisted session scope against live sessions that already passed
 * the frozen canonical-root check. A current-session grant is identity-bound:
 * another session in the same workspace must never inherit it after restart.
 */
export function selectRestoredRemoteSessionIds(
  allSessions: boolean,
  persistedSessionIds: readonly string[],
  canonicalLiveSessionIds: readonly string[],
): string[] | undefined {
  const live = [...new Set(canonicalLiveSessionIds)];
  if (allSessions) return live;
  if (persistedSessionIds.length !== 1) return undefined;
  const exactSessionId = persistedSessionIds[0];
  return live.includes(exactSessionId) ? [exactSessionId] : undefined;
}
