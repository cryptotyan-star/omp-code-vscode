# Android validation and release boundary

Last local validation: 2026-08-22 (Europe/Moscow).

## Automated gates

Run from `android/` with JDK 17:

```sh
./gradlew :app:compileDebugKotlin :app:compileDebugAndroidTestKotlin :app:testDebugUnitTest
./gradlew :app:connectedDebugAndroidTest
./gradlew :app:lintDebug :app:assembleDebug :app:assembleRelease :app:bundleRelease
```

The emulator suite covers:

- Keystore-generated AES-GCM IV plus sealed pending-enrolment roundtrip and clearing;
- sealed outbox UI correlation surviving store recreation until terminal ACK;
- hostile renderer corpus at the packaged HTTPS origin;
- `ompHost` origin-scoped WebMessage request/reply with the shared renderer.

The JVM suite covers strict Pairing URI parsing, protocol schemas/capabilities, handshake
counters, HKDF/AES-GCM KAT, attachment binary framing, lossless/stale relay behavior,
bridge allowlists, phased sync ordering/limits/fragments and transcript hydration.

## Manual live acceptance still required

These items require a real desktop extension plus relay and are intentionally not inferred
from Gradle success:

1. Pair from a newly issued QR and verify pair/enrolled/ACK/hello/challenge/proof/welcome.
2. Continue the same active desktop session; send prompt, abort, answer all approval types,
   switch model/thinking and verify first-valid-answer behavior on both screens.
3. Background/foreground the app, switch Wi-Fi/mobile networks, restart Android process and
   verify durable reconnect, event replay/full-sync and queued command terminal status.
4. Exercise a transcript larger than 256 KiB and more than 64 sync packets.
5. Upload/cancel/resume a file and photo, including the 20 MiB boundary and 240 KiB sender
   chunks; confirm no persisted document URI grant remains.
6. Test current-session and full-control capability manifests, expiry/update/revoke, session
   CRUD, history, diff/revert, export/share, OAuth URL and restricted-control UX.
7. Test notification denial/grant, actionable approval and turn-complete deep links on API
   33, 34 and 36; repeat on at least one physical OEM device.
8. Verify relay frame/rate/room limits under the production relay configuration.

Release output is unsigned. Signing, Play integrity/data-safety declarations, production
relay operations and optional true push/FCM are outside the checked-in Android client.

