# Remote Control: two live-verified host bugs blocking E2E gates

Date: 2026-08-26. Found during the manual E2E-001…007 / SEC-002 / BG-001 run.
Environment: desktop extension `cryptotyan-star.omp-code@0.10.0`, Android
`OmpCodeRemote-4.2-debug.apk` on emulator `inviz_test` (Android 14, API 34),
public relay `wss://my.omp.sh`, room `4407d9b05b7a6fb81ede91c16a9af1dd`,
key epoch 8. The owner had ~10 VS Code windows open, several with active OMP
Code sessions.

Result: pairing/enrolment against a real host through the public relay cannot
complete in this configuration. Gates E2E-001…007, SEC-002, BG-001 remain
`NOT_RUN`; RELAY-003 evidence is effectively FAIL for a multi-window desktop.

Evidence sources:
- Host output channel: `~/Library/Application Support/Code/logs/20260822T221533/window1/exthost/output_logging_20260826T164046/2-OMP Code.log`
- Host globalState: `state.vscdb` key `cryptotyan-star.omp-code`
  (`ompcode.remote.durable.v1`, `lastEpoch.v1=8`, `revokedEpoch.v1=7`)
- Device sealed store: `shared_prefs/omp_remote_device_sealed.xml`
  (via `run-as`), scoped logcat, WebView CDP (`webview_devtools_remote`)

---

## Bug 1 — every VS Code window hosts the same relay room (no arbitration)

**Symptom (host log, repeating indefinitely):**

```
[remote] relay connected
[remote] relay reconnecting: relay closed (4009): room exists
```

4009 = relay `CONFLICT` ("room already has a host", `remote-relay/relay.mjs`).

**Mechanism:**

- `src/extension.ts:187-195` — every extension host constructs
  `RemoteControlService` and calls `restore()` on activation.
- `src/remoteControlService.ts:298+` (`restore()`) — reads the *shared*
  SecretStorage/globalState (`ompcode.remote.secrets.v1`) and, when a live
  session exists, reconnects the room as host. There is no inter-window
  ownership check, lock, or lease.
- With N windows holding an OMP session, N hosts fight for one room; the relay
  kicks each duplicate with 4009 and each one immediately reconnects.

**Impact:** the host's relay connection flaps continuously. Device sessions die
mid-flight — same log shows `[remote] atomic full sync stopped: Error: device
disconnected during full sync` ×7 with `resync failed`. Any gate that assumes a
stable host (all E2E-*) is unreliable while more than one window is open.

**Fix direction:** single-host arbitration. Cheapest sound option: a lease in
`globalState` (owner window/extension-host id + heartbeat timestamp); a window
acquires the lease before `restore()` connects, renews while alive, and a
stale lease (TTL ~2 heartbeats) is taken over. Windows that do not own the
lease must not connect as host; their `Start Android Remote Control` should
report where the live host is. Alternative: only the window that ran `Start`
ever hosts (persist `hostWindowId` in the secrets blob), everyone else stays
stopped — simpler, but no failover on window close without an explicit
hand-off. Also add a regression test: two simulated extension hosts, one room,
exactly one host connection.

---

## Bug 2 — enrolled-ack is AAD-bound to a dead relay peer after device reconnect

**Symptoms:**

- Host log: `[remote] frame rejected: RemoteCryptoError: encrypted envelope
  failed authentication` ×40+ after the device completed `enrolled` processing.
- App side: `saveAfterEnrolled()` ran (sealed credential written 23:48,
  verified via `run-as`), engine entered `Authenticating`, then UI stalled at
  "Connecting to computer…" forever.
- Host `ompcode.remote.durable.v1` never gained the emulator's device id —
  i.e. `handleEnrolledAck` never accepted the ack. Only the owner's phone
  (`android-78796098-…`, highWater 24) is present.

**Mechanism (suspected, matches all evidence):**

- `android/.../protocol/RemoteProtocolEngine.kt:712-770` (`handleEnrolled`):
  the enrolled-ack is sealed with `peer = enrolled.assignedPeerId` and
  `counter = HandshakeCounters.enrolCounter(assignedPeerId)`.
- If the device's WebSocket drops and reconnects anywhere between `pair` and
  the ack arriving, the relay assigns a **new** peer id and rewrites the outer
  frame header. The app resends the byte-identical ack whose AAD still binds
  the **old** peer. The host (`src/remoteControlService.ts` `handleEnrolledAck`,
  ~715-767) rebuilds the AAD from the observed outer peer → AEAD
  authentication fails → ack rejected forever, the host keeps the pending
  enrolment until TTL, the device is never activated.
- Note the contrast: `sendPair()` (~690-710) seals with peer `0` and is
  explicitly designed to be resent byte-identical across reconnects. The ack
  path does not have that property.

**Fix direction:** re-bind the ack to the *current* relay peer. The design
already supports it: on reconnect the device resends the byte-identical `pair`
and receives an idempotent `enrolled` targeted at the new peer — seal the ack
against *that* `assignedPeerId`/`enrolCounter`. Do not weaken the AAD binding
instead (it exists to stop cross-peer replay). Add a regression test on both
sides: enrol, drop the socket before the ack lands, reconnect, complete
enrolment from the new peer id.

---

## Also observed (probably unrelated, needs its own look)

- Same window log: `[omp] init failed: omp command "get_available_models"
  timed out after 60s` — desktop agent init timed out once during the run
  (kimi profile, cwd `~/Desktop/Ohmypi`).

## Repro for this report

1. Open 2+ VS Code windows with active OMP Code sessions (bug 1 flapping
   starts immediately; watch the OMP Code output channel for 4009).
2. `OMP Code: Start Android Remote Control` → `Copy pairing link`.
3. On the device/emulator: deep-link the URI
   (`adb shell am start -a android.intent.action.VIEW -d 'omp-code://pair?…'`),
   confirm "Connect to computer".
4. Enrolment reaches `Authenticating`, then stalls; host log fills with
   "encrypted envelope failed authentication"; the device never appears in
   `ompcode.remote.durable.v1`.
