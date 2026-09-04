# Target-36 platform/security spike

This directory is the mandatory gate from `ANDROID_REMOTE_PLAN.md`, implemented before
the feature shell. It deliberately proves the risky Android primitives in isolation:

- AGP 8.13.2 + Gradle 8.13 + JDK 17 compile against the expanded 36.1 DSL while targeting
  API 36 and supporting API 26+.
- `RemoteSessionService` is declared as `remoteMessaging`, requests the API 34 foreground
  service permission, creates its notification before opening a socket, and never uses
  the Android 15 `dataSync` quota.
- Web content is served from `https://appassets.androidplatform.net` by
  `WebViewAssetLoader`. File/content access, mixed content and arbitrary navigation are
  disabled. There is no `addJavascriptInterface` and no `file://` load.
- A closed, size-limited message schema is exposed only to the packaged origin through
  AndroidX WebKit's origin-scoped web-message listener.
- CSP has no inline/eval/remote script path. The bundled hostile-markdown corpus covers
  script tags, event attributes, SVG/data/javascript URLs, broken fences and hostile tool
  output. Rendering uses escaped text nodes and an HTTP(S)-only link allowlist.

Passing Gradle unit/instrumented tests demonstrates the static and in-emulator parts of
this gate. Background reconnect across real network changes remains a device/emulator
runtime acceptance item and must not be claimed from a build alone.

This spike is only the platform-security prerequisite. The production path lives in the
pairing/crypto/relay/protocol/service packages and implements the Android side of the
desktop wire contract. Its contract tests do not replace the live desktop+relay acceptance
matrix in `VALIDATION.md`.
