import { test } from "node:test";
import assert from "node:assert/strict";
import {
  REMOTE_CAPABILITY_REFRESH_WINDOW_MS,
  REMOTE_CAPABILITY_MAX_TIMER_MS,
  remoteCapabilityRefreshDelay,
  selectRestoredRemoteSessionIds,
  shouldRefreshRemoteCapability,
} from "../src/remoteCapability.ts";

test("remote capability refreshes before expiry and after expiry", () => {
  const now = 1_800_000_000_000;
  assert.equal(shouldRefreshRemoteCapability(now + REMOTE_CAPABILITY_REFRESH_WINDOW_MS + 1, now), false);
  assert.equal(shouldRefreshRemoteCapability(now + REMOTE_CAPABILITY_REFRESH_WINDOW_MS, now), true);
  assert.equal(shouldRefreshRemoteCapability(now - 1, now), true);
});

test("active capability timer wakes within Node's limit and crosses the refresh boundary", () => {
  const now = 1_800_000_000_000;
  const expires = now + 30 * 24 * 60 * 60 * 1000;
  assert.equal(remoteCapabilityRefreshDelay(expires, now), REMOTE_CAPABILITY_MAX_TIMER_MS);
  const afterFirstWake = now + REMOTE_CAPABILITY_MAX_TIMER_MS;
  assert.equal(remoteCapabilityRefreshDelay(expires, afterFirstWake), 5 * 24 * 60 * 60 * 1000);
  assert.equal(remoteCapabilityRefreshDelay(expires, expires - REMOTE_CAPABILITY_REFRESH_WINDOW_MS), 0);
});

test("a current-only grant never rebinds to either of two live sessions in the same root", () => {
  const sameCanonicalRootCandidates = ["new-session-a", "new-session-b"];
  assert.equal(
    selectRestoredRemoteSessionIds(false, ["previous-session"], sameCanonicalRootCandidates),
    undefined,
  );
  assert.deepEqual(
    selectRestoredRemoteSessionIds(false, ["new-session-b"], sameCanonicalRootCandidates),
    ["new-session-b"],
  );
  assert.deepEqual(
    selectRestoredRemoteSessionIds(true, ["previous-session"], sameCanonicalRootCandidates),
    sameCanonicalRootCandidates,
  );
});
