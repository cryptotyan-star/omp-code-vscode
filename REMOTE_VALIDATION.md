---
schema: omp-code-remote-validation/v1
extension_version: 0.7.0
android_version: 0.1.0
snapshot_date: 2026-08-22
overall_status: NOT_RUN
status_vocabulary: PASS,FAIL,BLOCKED,NOT_RUN,NOT_APPLICABLE
---

# OMP Code Remote — validation report

Это release-evidence документ, а не обещание результата. Статусы относятся только к
указанным командам и окружению текущего прогона. Перед финальной упаковкой исполнитель
обновляет строку только после фактического запуска и записывает конкретное evidence
(лог, имя артефакта, emulator/API/device). Если хотя бы обязательный gate не `PASS`,
`overall_status` не может быть `PASS`.

Machine rules:

- `Required=YES` допускает для готового релиза только `Status=PASS`.
- `Required=NO` фиксирует важную, но внешнюю/необязательную границу и не блокирует
  локальный handoff.
- Допустимы только `PASS`, `FAIL`, `BLOCKED`, `NOT_RUN`, `NOT_APPLICABLE`.
- `BLOCKED` означает известную внешнюю причину, которая записана в Evidence / boundary.
- Один local/reference-relay gate не повышает status public-relay или internet E2E.
- Debug и unsigned release Android artifacts никогда не означают production signing.

<!-- GATES:BEGIN -->
| Gate ID | Area | Required | Status | Command / procedure | Evidence / boundary |
| --- | --- | --- | --- | --- | --- |
| HND-001 | Handoff script syntax and declared layout | YES | PASS | `bash -n scripts/pack-remote-release.sh`; `scripts/pack-remote-release.sh --print-layout` | Re-run after mandatory APK/AAB, collision and forbidden-path hardening; canonical layout printed successfully |
| DESK-001 | Desktop typecheck and complete Node test suite | YES | PASS | `npm test`; explicit `npm run typecheck`; `npm run build` | Final source: 263/263 tests, zero fail/skip; typecheck/build/diff/JSON/NLS gates pass; `dist/extension.js` 836.6 KiB |
| DESK-002 | VSIX build and internal version | YES | PASS | `npm run package`; inspect `extension/package.json`; install and list | `omp-code-0.7.0.vsix`, 253449 B, SHA-256 `16c2031eb7533d73c74677cca08060d4860a0d049add5d70717f0ebd7bddd330`; internal and installed `cryptotyan-star.omp-code@0.7.0`; packaged dist equals current dist |
| DESK-003 | VSIX contents and secret/exclusion audit | YES | PASS | `npx vsce ls`; `unzip -Z1`; forbidden-path scan | 16 extension payload files / 18 total ZIP entries; no Android tree, relay, projects, build/cache, local config, validation copy, key or secret path |
| PROTO-001 | TypeScript/Kotlin crypto KAT and tamper parity | YES | PASS | TS crypto/handshake/protocol tests plus Android JVM crypto tests | Targeted TS 32/32; final Android JVM suite 42/42 includes matching HKDF/AAD/nonce/AES-GCM KAT and tamper/replay cases |
| PROTO-002 | Schema, replay, capability, full-sync and ACK-window tests | YES | PASS | Complete desktop and Android unit suites | Desktop 263/263 + Android 42/42 cover strict schemas, durable replay/high-water, caps, chunk/order bounds, sync, reconnect and indeterminate recovery |
| RELAY-001 | Reference relay syntax/unit/in-process integration | YES | PASS | `npm --prefix remote-relay run check`; relay/live-harness targeted tests | Syntax check passes; 13/13 relay plus in-process pair/auth/sync/prompt tests pass; normative local opaque-transport contract only |
| RELAY-002 | Reference relay live host-to-phone flow | YES | PASS | Local relay + installed final debug APK + synthetic host | On `inviz_test` Android 14/API 34: pair, enrol, auth, phased sync, phone prompt accepted/completed and post-event ACK; harness exit 0, sequence 29. Synthetic host deliberately does not run VS Code/OMP |
| RELAY-003 | Public relay full application E2E | NO | NOT_RUN | Pair and exercise the app through the configured public `wss://` relay | Public relay passed only the opaque peer-rewrite/245828-byte-frame TLS probe; full application flow/SLA/quota were not run |
| RELAY-004 | Docker image build and health check | NO | BLOCKED | Build `remote-relay/Dockerfile`; query `/healthz` | Docker CLI/runtime is unavailable in this environment; source syntax and in-process relay tests passed |
| AND-001 | Android JVM unit tests | YES | PASS | Gradle `:app:testDebugUnitTest` in final aggregate gate | JDK 17; 42/42, zero failures/errors/skips across 8 XML suites |
| AND-002 | Android lint | YES | PASS | Gradle `:app:lintDebug` | Green; `android/app/build/reports/lint-results-debug.xml` contains zero issues |
| AND-003 | Debug APK build | YES | PASS | Gradle `:app:assembleDebug`; `aapt`; `apksigner` | `sh.omp.remote.debug` 0.1.0-debug, min 26/target 36, 44725037 B, SHA-256 `014f7f2b8f24e1ae9da37f6101b5fd15d8fcf1f5c8d2815f81a0d96a53c8dfec`; APK v2 debug signature verifies |
| AND-004 | Unsigned release APK build | YES | PASS | Gradle `:app:assembleRelease`; `aapt`; `apksigner` | `sh.omp.remote` 0.1.0, 24020613 B, SHA-256 `2ccf12f7c639ab792ec174a8c5ce885bad826734c3f4b9a050a9b32b5327c7d5`; intentionally unsigned (`apksigner verify` fails) |
| AND-005 | Unsigned release AAB build | YES | PASS | Gradle `:app:bundleRelease`; `jarsigner -verify` inspection | 15294193 B, SHA-256 `a7d423381096d2d4449c51c8d095973fb8bd0e2b8cf009c6d8007bf8f9bbb58b`; reports `jar is unsigned`; not adb-installable |
| AND-006 | Instrumented tests on Android runtime | YES | PASS | Gradle `:app:connectedDebugAndroidTest` | 9/9, zero failures/errors/skips on `inviz_test`, Android 14 / API 34; Keystore, cold resume, hostile WebView, bridge, durable result/export lifecycle covered |
| AND-007 | APK install, launch and crash/logcat smoke | YES | PASS | Clean `adb install`; launch/pair harness; scoped logcat scan | Final debug APK installed; package/version confirmed; process remained live, fatal/crash lines 0 and sensitive-pattern lines 0 |
| E2E-001 | Existing active session transcript and prompt streaming | YES | NOT_RUN | Pair phone to running desktop session; send one prompt | Verify exactly one user command and same streamed result on both UIs; no second OMP process |
| E2E-002 | Approval race and terminal ACK behavior | YES | NOT_RUN | Trigger tool/file approval; answer on phone and desktop variants | Both UIs must close one request; optimistic display is not terminal evidence |
| E2E-003 | Files, diff and guarded revert | YES | NOT_RUN | Open a diff; revert a controlled edit; attempt drifted/dirty case | Verify content and rejection of unsafe drift |
| E2E-004 | Multi-session create/switch/close/history routing | YES | NOT_RUN | Exercise two concurrent allowed sessions | No cross-session event or command routing |
| E2E-005 | Network loss, reconnect, resync and no duplicate command | YES | NOT_RUN | Cut and restore network during/after prompt | One side effect only; transcript converges after full sync |
| E2E-006 | Phone attachment lifecycle | YES | NOT_RUN | Send 0-byte, normal and bounded large file/photo; cancel one | Verify hash/size, host access and cleanup; over-limit input is rejected |
| E2E-007 | Model, thinking, access, profile and scoped credentials UI | YES | NOT_RUN | Exercise controls allowed by desktop capability | Controls outside capability must be hidden/disabled or explicitly rejected |
| SEC-001 | WebView origin/CSP/hostile-content bridge test | YES | PASS | Instrumented packaged WebView tests | `hostileFixtureRunsAtPackagedHttpsOriginWithoutExecution` and origin-scoped shared-renderer reply pass in the 9/9 runtime suite |
| SEC-002 | Revoke and old-epoch denial | YES | NOT_RUN | Revoke phone; attempt reconnect/decrypt/command with old state | Automated tombstone/old-epoch/crash-order tests pass, but this exact packaged live procedure was not run |
| SEC-003 | Runtime sensitive-log audit | YES | PASS | Inspect scoped Android logcat and machine host output from local live flow | App log: zero pairing/key/token/auth/prompt matches; host emits only SHA-256-redacted IDs; 0600 pairing link was deleted after the run |
| BG-001 | Background reconnect and notification behavior | YES | NOT_RUN | Exercise foreground/background, network change and process recreation | Record Android API; build success alone does not prove lifecycle behavior |
| DEVICE-001 | Physical Android device acceptance | NO | NOT_RUN | Repeat pairing and core E2E on a supported physical device | Emulator success does not prove OEM battery/network behavior |
<!-- GATES:END -->

## Current boundary

Подтверждены final desktop/VSIX, protocol, reference-relay, Android build/lint/unit/
instrumented, clean-install smoke, hostile WebView и локальный encrypted phone flow.
Локальный flow использовал synthetic host: он проверяет установленный Android-клиент,
pair/auth/sync/command/ACK, но намеренно не запускает VS Code или OMP и не выполняет
prompt моделью. Поэтому real-OMP manual gates `E2E-001…007`, packaged live revoke и
полный background/network scenario остаются `NOT_RUN`; public relay full flow и physical
device также не проверялись. `overall_status: NOT_RUN` намеренно остаётся честным, а ZIP
собирается только как явно unverified diagnostic handoff через `--allow-unverified`.

## Signing and distribution boundary

Debug APK подписан только Android debug key. Release APK/AAB создаются unsigned и не
содержат production keystore. Production signing, Play upload, публикация VSIX, deploy
relay, SLA и внешний security review в этот отчёт не входят, пока для них не появится
отдельное явное evidence.
