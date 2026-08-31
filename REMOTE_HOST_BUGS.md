# Remote Control: host bugs — all resolved

Trimmed 2026-08-31 to issues still reproducible against the current code;
none remain.

- **Bug 1 (every VS Code window hosts the same relay room) is resolved.**
  Single-host arbitration now lives in a `globalState` lease
  (`ompcode.remote.hostLease.v1`, `src/remoteHostLease.ts`): each window owns a
  random per-extension-host id, acquires the lease (write + settle + confirm)
  before `restore()`/`start()` opens the relay transport, and renews it on a
  10s heartbeat against a 25s TTL. Windows that lose acquisition never
  connect — they stand by on a low-frequency retry watcher and take over once
  the owner's heartbeat goes stale, so closing the host window fails over to a
  survivor. `stop()`/`dispose()` release the lease, and a window whose
  heartbeat sees a fresh foreign record disconnects instead of fighting for
  the room, so the relay's 4009 "room exists" kick can no longer start a
  reconnect flap. `start()` in a non-owner window reports that another window
  is hosting instead of revoking the live room. Regression coverage:
  `test/remoteHostArbitration.test.ts` (two simulated extension hosts, one
  shared store, exactly one host; stale-owner failover) plus the wiring
  assertions in `test/remoteIntegrationWiring.test.ts`.
- **Bug 2 of the original report (enrolled-ack AAD-bound to a dead relay peer)
  is resolved.** `rebindPendingEnrolment` (`src/remoteControlService.ts`)
  re-targets the pending enrolment when the relay reassigns the peer: a
  byte-identical resent `pair` from a new peer id re-seals the `enrolled`
  ciphertext against that peer and updates `pending.peerId`, so the device's
  ack — sealed against the current `assignedPeerId` — authenticates.
- The "omp init timed out after 60s" observation was never a remote bug; drop.
