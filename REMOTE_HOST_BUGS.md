# Remote Control: open host bug blocking E2E gates

Trimmed 2026-08-31 to issues still reproducible against the current code.

- **Bug 2 of the original report (enrolled-ack AAD-bound to a dead relay peer)
  is resolved.** `rebindPendingEnrolment` (`src/remoteControlService.ts`) now
  re-targets the pending enrolment when the relay reassigns the peer: a
  byte-identical resent `pair` from a new peer id re-seals the `enrolled`
  ciphertext against that peer and updates `pending.peerId`, so the
  device's ack — sealed against the current `assignedPeerId` — authenticates.
- The "omp init timed out after 60s" observation was never a remote bug; drop.

What remains is the multi-window one.

---

## Bug 1 — every VS Code window hosts the same relay room (no arbitration)

**Symptom (host log, repeating indefinitely):**

```
[remote] relay connected
[remote] relay reconnecting: relay closed (4009): room exists
```

4009 = relay `CONFLICT` ("room already has a host", `remote-relay/relay.mjs`).

**Mechanism (verified against current code):**

- `src/extension.ts` — every extension host constructs a
  `RemoteControlService` and calls `restore()` on activation
  (`void remoteControl.restore().catch(...)`).
- `src/remoteControlService.ts` `restore()` — reads the *shared*
  SecretStorage/globalState (`ompcode.remote.secrets.v1`) and, when a live
  session exists, reconnects the room as host. Nothing between the two
  arbitrates ownership across windows: no lease in `globalState`, no
  `hostWindowId` in the secrets blob. (`acquireLease`/`acquireScopedLeases`
  retain *sessions*, not the relay room, and `restoreInProgress` is an
  instance field — per window, not across them.)
- With N windows holding an OMP session, N hosts fight for one room; the relay
  kicks each duplicate with 4009 and each one immediately reconnects.

**Impact:** the host's relay connection flaps continuously. Device sessions
die mid-flight (`device disconnected during full sync`, then `resync failed`).
Any gate that assumes a stable host (all E2E-*) is unreliable while more than
one window is open.

**Fix direction:** single-host arbitration. Cheapest sound option: a lease in
`globalState` (owner window/extension-host id + heartbeat timestamp); a window
acquires the lease before `restore()` connects, renews while alive, and a
stale lease (TTL ~2 heartbeats) is taken over. Windows that do not own the
lease must not connect as host; their "Start Android Remote Control" should
report where the live host is. Alternative: only the window that ran `Start`
ever hosts (persist `hostWindowId` in the secrets blob), everyone else stays
stopped — simpler, but no failover on window close without an explicit
hand-off. Add a regression test: two simulated extension hosts, one room,
exactly one host connection.

**Repro:**

1. Open 2+ VS Code windows with active OMP Code sessions — watch the OMP Code
   output channel for the 4009 flap.
