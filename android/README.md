# OMP Code Remote for Android

Android client for continuing the same live OMP Code session that remains owned by the
desktop extension. The phone is an encrypted, synchronized control surface; it does not
start a second OMP agent or execute tools locally.

## Build

Requirements: JDK 17 and Android SDK 36.1. The repository-owned wrapper pins Gradle 8.13;
the build pins AGP 8.13.2 and Kotlin/JVM 17.

```sh
cd android
JAVA_HOME=/path/to/jdk-17 ./gradlew \
  :app:testDebugUnitTest :app:lintDebug :app:assembleDebug :app:assembleRelease
JAVA_HOME=/path/to/jdk-17 ./gradlew :app:connectedDebugAndroidTest
```

The debug APK is generated at `app/build/outputs/apk/debug/app-debug.apk`. The release APK
is deliberately unsigned; production signing material must not be stored in this tree.

## Implemented boundary

The application implements the Android side of `ANDROID_REMOTE_PROTOCOL.md`, including:

- strict QR/deep-link pairing, durable two-phase enrolment and authenticated reconnect;
- Android Keystore-sealed credential, counters, pending enrolment and command outbox;
- exact HKDF-SHA256/AES-256-GCM wire header, nonce domains and known-answer vectors;
- ordered relay queue, stale-socket rejection, reconnect policy and handshake timeouts;
- durable command replay/terminal ACK routing and cumulative ACK of every applied event;
- bounded phased full-sync reassembly and the shared desktop renderer over an
  origin-scoped `WebMessage` bridge;
- session drawer, prompt/approvals/models/thinking/history/diff/revert, attachments,
  foreground service, notifications, share sheet, QR, picker and RU/EN native shell;
- signed capability checks before every command and before reading a selected URI.

The shared renderer is copied from `../media` into generated build assets. Android does
not edit or fork those source assets.

## Validation boundary

`docs/SECURITY_SPIKE.md` describes the mandatory platform/security spike. Its tests prove
the risky Android primitives independently: packaged HTTPS WebView origin, hostile-XSS
fixture, native WebMessage roundtrip and Android Keystore sealing.

The protocol implementation goes beyond that spike and is exercised by Kotlin contract,
crypto, parser, sync, relay and attachment tests. A green build/emulator run still does
**not** prove a live internet session against a real desktop host and relay. Before a
public release, run the acceptance matrix in `docs/VALIDATION.md` with an actual desktop
QR, network handoff/backgrounding and a production-configured relay. API 36 physical-device
background behavior, OEM process management, public relay quotas and production signing
remain deployment gates rather than build claims.

