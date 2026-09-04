# OMP Code for Android + Remote Control — план реализации

Статус: редакция 3, plan-critic gate пройден; реализация `0.7.0` / `0.1.0` собрана  
Граница: автоматические и локальные Android runtime-gates пройдены; manual acceptance
с настоящей активной OMP-сессией перечислен как `NOT_RUN` в `REMOTE_VALIDATION.md`  
Дата: 2026-08-22  
Цель релиза: `OMP Code 0.7.0` + Android-приложение `OMP Code Remote 0.1.0`

## 1. Результат, который должен получить пользователь

Пользователь запускает Remote Control в OMP Code на включённом домашнем компьютере,
сканирует телефоном одноразовый QR-код и продолжает **ту же активную OMP-сессию** в
Android-приложении. Модель, контекст, инструменты, рабочая папка, файлы, shell и MCP
остаются на компьютере. Телефон является вторым синхронизированным интерфейсом, а не
вторым агентом.

Работа должна быть возможна как в одной локальной сети, так и через интернет без
проброса портов: desktop-host устанавливает только исходящее WSS-соединение с relay.
Содержимое сессии шифруется end-to-end и не доступно relay.

## 2. Проверенная исходная точка

- Текущий OMP Code — VS Code extension `0.6.0`, один `OmpSession` на вкладку и один
  `omp --mode rpc-ui` на сессию.
- Установленный CLI: `omp/17.3.5`; npm latest на дату аудита: `18.0.0`.
- OMP уже имеет E2EE collab relay (`wss://my.omp.sh`, AES-256-GCM), но `/collab` и
  `/join` реализованы только для TUI. RPC v2 не содержит `collab_start/status/stop`,
  поэтому активную VS Code `rpc-ui`-сессию штатно опубликовать нельзя.
- Запуск второго `omp` для телефона запрещён архитектурой: это создаст split-brain,
  другой процесс, отдельные approvals и риск одновременных правок.
- В рабочем дереве уже есть пользовательские незакоммиченные изменения 0.6.0. Они
  сохраняются; remote-функция строится поверх них.
- Android Studio 2026.1, SDK 34/35/36.1, build-tools до 37, JDK 17/21, эмуляторы и adb
  доступны. Проект обязан иметь собственный Gradle wrapper и не зависеть от глобального
  Gradle 9.6.1.
- До remote-работ найдены регрессы текущего незакоммиченного слоя, которые нужно
  исправить и закрыть тестами: потерянная финализация `initialize()` (`initialized`,
  crash counter, status callback); недостижимый `revert` из-за порядка CSS-selectors;
  удаление существующего пустого файла при revert; потеря revert snapshot при dirty-file
  блокировке и отсутствие after-hash/drift guard; неверный тип аргумента Abort/Close из
  TreeView; гонки one-shot route restore с новым prompt/ручной сменой модели. Эти дефекты
  присутствуют и в уже собранном `omp-code-0.6.0.vsix`, поэтому он не является годным
  baseline-релизом.

## 3. Архитектура

```text
Android app
  native shell: pairing, Keystore, foreground connection, notifications,
  files/camera/share, session drawer
  shared chat UI: streaming markdown, tools, approvals, models, history
          │
          │ WSS + application sequence/ACK
          │ AES-256-GCM, relay sees only room/peer/size/timing
          ▼
configurable blind relay (reference self-hosted relay included;
public OMP relay only after a live compatibility gate)
          ▲
          │ outbound-only WSS; no listener/open port on laptop
          │
VS Code extension RemoteControlService
  pairing/device auth, replay ring, idempotency, session multiplexer
          │
          ├── active OmpSession A ── stdio NDJSON ── omp rpc-ui A
          ├── active OmpSession B ── stdio NDJSON ── omp rpc-ui B
          └── VS Code host operations (diff, revert, attachments, settings)
```

Источник истины — `OmpSession` на компьютере. Существующий UI сначала получает явный
`HostPort` (`post(command)`, `subscribe(hostMessage)`, host capabilities) вместо прямой
зависимости от `acquireVsCodeApi()`/`window.message`. Реализации порта: VS Code, Android
origin-scoped WebMessage и in-memory test port. DOM renderer и типизированный UI message
contract общие, transport/session multiplexing разные и проверяются contract tests.

Remote Protocol использует совместимые с OMP relay WebSocket role/path и 4-byte envelope,
но его application frames **не совместимы** с native `pi-wire COLLAB_PROTO=3` и готовым
OMP browser guest. Не заявлять native wire compatibility: для неё понадобились бы новые
mode-neutral collab RPC-команды в самом OMP CLI.

## 4. Почему не копировать Claude Code wire protocol

Публичного Claude Remote Control API/wire schema нет. Официально известна модель UX:
локальный процесс остаётся владельцем tools/files, телефон и web синхронизируют одну
сессию через исходящее соединение и умеют prompts, approvals, model/effort, attachments,
subagents и push. Совместимость с закрытым Anthropic backend невозможна и не является
целью. Мы воспроизводим пользовательскую модель на открытом OMP runtime.

## 5. Функциональный паритет

### 5.1 Диалог и управление ходом

- Начальная загрузка полного transcript активной сессии.
- Потоковые assistant text/thinking, tool start/update/end, notices, retry и compaction.
- Отправка prompt; во время хода — steering/очередь по семантике текущего OMP RPC.
- Явные состояния отправки: `queued → accepted → delivered → turn-started/completed`.
- `Stop`, reconnect после смены сети/фона приложения, полная resync при пропуске replay.
- Slash-command autocomplete и выполнение поддерживаемых OMP команд.
- Локальная история набранных prompts.

### 5.2 Approvals и вопросы

- `confirm`, `select`, `input`, `editor`, cancel и timeout/cancel lifecycle.
- `first-valid-answer-wins` и at-most-once dispatch по исходному OMP request id,
  device counter и remote idempotency key; после crash boundary — `indeterminate` + resync.
- На телефоне показываются tool name, аргументы и предупреждение о последствиях.
- Action-required notification открывает нужную сессию и approval.
- При гонке desktop/phone первый валидный ответ закрывает запрос на всех интерфейсах.

### 5.3 Модели, стоимость и режимы

- Список доступных и проверенных моделей, provider grouping и dead-model verdicts.
- Смена модели текущей сессии.
- Одноразовая маршрутизация следующего prompt и гарантированный restore.
- Thinking level `off…max/auto` с реальной model-specific ladder.
- Approval mode `always-ask/write/yolo` с тем же предупреждением и warm restart.
- Model profile inspector; редактирование разрешённых scalar overrides.
- Tokens, reasoning/cache tokens, cost и context usage/warnings.

### 5.4 Сессии

- Доска всех живых sidebar/editor sessions: title, cwd, model, status, cost.
- Переключение телефона между активными сессиями без переключения desktop UI.
- Создание новой desktop-backed сессии с телефона.
- Stop/close активной вкладки (sidebar session не закрывается).
- История по всем workspace, фильтр и `switch_session` с replay transcript.
- Rename, reset/new session, compact, restart и восстановление после restart.
- Состояния `online/reconnecting/offline/ended`; host generation защищает от старого
  sequence после перезапуска.
- Remote lease удерживает опубликованный `OmpSession`, даже если его webview/tab временно
  закрыт; закрытие телефона не убивает локальную сессию, а extension deactivation/явный
  Stop Remote Control освобождает lease. Reveal восстанавливает UI того же процесса.

### 5.5 Файлы и результаты tools

- Выбор Android-файла/фото, передача E2EE, ограничение 20 MiB, безопасное имя,
  сохранение в extension storage и attachment к следующему prompt.
- `@`-поиск файлов workspace через host.
- Tool output с collapse, copy и открытием URL на телефоне.
- Diff `before ↔ current` на телефоне и однократный revert с проверкой drift/dirty file.
- `Insert at cursor` остаётся осмысленной remote-командой: вставляет в активный editor
  на компьютере и явно сообщает, если editor отсутствует.
- Export transcript: получить Markdown с host и вызвать Android share/save sheet.

### 5.6 Настройка и диагностика

- Key status без передачи значения ключа. Set/replace/clear API key доступен только при
  отдельно выданной desktop-side capability `credentials.manage`; значения никогда не
  возвращаются телефону и не сохраняются Android-приложением после terminal ACK.
- OAuth/device-code login: URL открывается на телефоне, код копируется локально,
  credential сохраняет сам OMP на компьютере.
- Re-check models, diagnostics report, remote status и restart.
- Custom providers редактируются на телефоне типизированной формой с preview/validation;
  raw JSON/неизвестные future fields остаются доступны без потери только в desktop editor.
  Model profile scalar overrides доступны на телефоне, произвольный overlay — read-only
  preview с явной командой открыть desktop settings.
- Русский и английский интерфейс, темы OMP Code, светлая/тёмная Android тема.

### 5.7 Android-системная интеграция

- QR scan, paste/deep-link pairing, Android Keystore для device credential/room key.
- Foreground service type `remoteMessaging` для устойчивого cross-device WebSocket при
  закрытом Activity; `dataSync` не используется, потому что Android 15 ограничивает его
  шестью часами за 24 часа. Проверяются launch/background restrictions API 34 и 36.
- Push-like local notifications от host connection: turn completed и action required.
  Настоящий FCM при полностью убитом процессе требует отдельного доверенного push
  backend и не включается молча; foreground service закрывает локальный релиз.
- Network callback, exponential backoff с jitter, connectivity/offline banner.
- Notification permission Android 13+, foreground-service permissions Android 14+.
- Share/open-document/camera intents; секрет pairing никогда не попадает в analytics/logs.

### 5.8 Capability model и desktop consent

- Device credential не означает «полный доступ ко всему». Host хранит подписанный
  capability manifest и проверяет его для **каждой** команды: allowed session IDs,
  workspace roots и verbs (`view`, `prompt`, `approve`, `files`, `session.manage`,
  `settings.manage`, `credentials.manage`). Клиентские claims не являются authority.
- Безопасный default QR: только исходная сессия, её transcript/prompt/abort/approvals,
  model/thinking и вложения в её workspace; без глобальной истории, lifecycle других
  сессий, settings и credentials.
- Полный паритет включается кнопкой `Grant full OMP Code control` только на desktop QR
  panel: all live sessions/history/session lifecycle/settings; credentials — ещё одним
  отдельным явным toggle с предупреждением. Телефон не может повысить собственный scope.
- Расширение workspace/session scope после pairing требует desktop confirmation и выдачи
  нового manifest/key epoch; revoke закрывает room целиком.

## 6. Remote protocol v1

### 6.1 Transport

- URL relay: `wss://<relay>/r/<128-bit-room-id>?role=host|guest`.
- Binary envelope: 4-byte big-endian peer id + encrypted payload.
- Payload: UTF-8 JSON, AES-256-GCM; 96-bit nonce однозначно строится из direction constant
  и connection frame counter; layout `[12-byte nonce][ciphertext][16-byte tag]`.
- Plain relay control JSON может содержать только peer joined/left/room closed.
- Малые control/event JSON frames имеют жёсткий лимит. Вложения не кодируются одним
  base64 JSON frame: `attachment-start/chunk/commit/cancel`, chunks не более 256 KiB,
  total-size 20 MiB, SHA-256, offset/ACK, resume, per-device quota и cleanup timeout.
  Реальный frame/room/rate limit публичного relay до live probe считается неизвестным.

### 6.2 Pairing/enrolment

- QR содержит custom URI с room id, relay origin, 256-bit **одноразовым** pairing key и
  expiry (10 минут). Постоянный room key в QR отсутствует.
- Android генерирует device id, подключается и отправляет `pair` под pairing key.
- Enrolment двухфазный и привязан к relay peer + device id. Host хранит pending enrolment
  до `enrolled-ack`: targeted `enrolled` с room key, key epoch и random device token можно
  безопасно повторить под pairing key после обрыва. Только валидный ACK активирует device
  и уничтожает pairing key; TTL проверяется host на каждом шаге.
- Android сохраняет room key/device token только за Android Keystore encryption.
- Последующие `hello` шифруются room key и подтверждаются device token.
- Первый релиз поддерживает одно enrolled write-device. Новое pairing/revoke закрывает
  старую relay room и вращает **room id + host generation + key epoch + room key + device
  token**. Старый телефон не может занять новую room, читать или flood-ить её.
- Remote Control можно stop/revoke с desktop; секреты удаляются из SecretStorage.

### 6.3 Ordering, replay и at-most-once dispatch

- У каждого host event есть `hostGeneration`, монотонный `sequence`, `sessionId`,
  `eventId`.
- Host держит bounded replay ring; Android подтверждает последний применённый sequence.
- При reconnect host replay-ит хвост, а при gap/generation mismatch делает полный sync.
- Каждая mutating command имеет UUID и per-device monotonic command counter. AEAD AAD
  связывает protocol version, room id, key epoch, direction и envelope peer id; payload
  связывает host generation/session id. Host **durably** хранит high-water mark и
  non-terminal/terminal result metadata до смены key epoch. Повтор, старый counter,
  ciphertext из другой room/epoch/session и retry после restart не выполняются.
- ACK разделяет `accepted`, `completed`, `rejected/error`; Android outbox удаляет команду
  только после terminal ACK.
- Heartbeat/presence не смешивается с transcript и не увеличивает sequence.
- Внешняя гарантия называется **at-most-once dispatch with indeterminate recovery**, а
  не exactly-once: при crash между durable accept и side effect команда возвращает
  `indeterminate`, не исполняется повторно, делает resync и требует явного нового действия.

### 6.4 Key derivation, nonce и replay context

- Pairing key применяется только к конкретной pending-enrolment transaction. Room master
  key не используется напрямую для обычных frames.
- HKDF-SHA-256 выводит независимые auth/traffic keys по `roomId`, `keyEpoch`, purpose и
  direction (`pair`, `device→host`, `host→device`), исключая cross-protocol/key reuse.
- Reconnect handshake обменивается случайными 128-bit host/device nonces под directional
  auth keys. Из обоих nonces выводятся connection-specific directional traffic keys.
- Для каждого traffic key nonce однозначен: 32-bit direction constant + monotonically
  increasing 64-bit frame counter, начинающийся с нуля только для нового connection key.
  Receiver rejects duplicate/lower counter; counter входит в authenticated header/AAD.
- Handshake replay отклоняется durable device command counter/key epoch/expiry; random
  values генерируются только CSPRNG. Cross-language known-answer tests фиксируют HKDF,
  header, nonce, ciphertext/tag и tamper behavior.

### 6.5 Версионирование и валидация

- Каждое сообщение имеет `protocolVersion: 1`; несовместимая major version отклоняется.
- Runtime schema guards на desktop и Android; неизвестные optional fields игнорируются.
- Команды проходят allowlist и per-command size/type validation до вызова `OmpSession`.
- Никаких произвольных RPC frame passthrough от сети к stdin.
- Capability manifest проверяется до schema-specific dispatch; пути canonicalize-ятся и
  сверяются с разрешёнными workspace roots, URI schemes — с allowlist.

## 7. Изменения desktop extension

### 7.1 Core session adapter

- Исправить все найденные baseline-регрессы из раздела 2 и добавить regression tests.
- Добавить remote observer к `OmpSession.post()` без изменения webview lifecycle.
- Добавить `remoteSync()` для boot/models/commands/state/transcript/stats/profile/keys.
- Добавить строго типизированный `handleRemoteCommand()` с allowlist.
- Добавить host-authoritative capability policy и desktop-only elevation/revoke flow.
- Сделать approval settlement атомарным; вернуть diff contents вместо открытия только
  desktop diff editor; экспорт/diagnostics возвращают данные вызывающему каналу.
- Board IDs и lifecycle остаются существующими; закрытие session удаляет remote stream.

### 7.2 RemoteControlService

- Relay WebSocket client, AES-GCM codec, pairing/enrolment, device revoke.
- Session multiplexer, observer subscription, sequence/replay/idempotency/heartbeat.
- Persist non-plaintext host state в VS Code SecretStorage; auto-resume только после
  явного включения пользователем.
- Никаких inbound listeners, telemetry, prompts/responses/secrets в OutputChannel.

### 7.3 Desktop UX

- Commands: Start/Open, Add/Re-pair phone, Copy link, Status, Stop/Revoke.
- QR/status webview: expiry, connection/device/presence, privacy explanation, Stop.
- Status bar indicator и Session board refresh.
- Settings: relay URL, auto-start, notification defaults; `ws://` разрешён только для
  localhost, всё остальное требует `wss://`.
- README/README.ru, CHANGELOG, package nls, VSIX include list.

## 8. Android project

### 8.1 Build

- `android/` самостоятельный Gradle project с wrapper 8.13, AGP 8.13.2, Kotlin/JDK 17,
  compileSdk 36.1, targetSdk 36, minSdk 26.
- Debug APK и release-ready unsigned APK/AAB; release signing не генерирует и не хранит
  пользовательский production key.
- Shared UI выносится в platform-neutral module с `HostPort`; Android build подключает
  его как единственный source asset, а parity snapshot/contract tests гоняют VS Code и
  Android adapters на одной последовательности сообщений.

### 8.2 Modules/components

- `PairingUri` — strict parser, expiry and relay scheme validation.
- `SecurePairingStore` — Android Keystore encrypted persistence.
- `CryptoCodec` — AES-GCM/envelope cross-platform vectors.
- `RelayConnection` — OkHttp WSS, reconnect/backpressure/heartbeat.
- `RemoteSessionService` — `remoteMessaging` foreground lifecycle, durable outbox,
  sequence, notifications.
- `MainActivity` — QR/deep-link/paste, session drawer, connectivity state.
- `OmpWebBridge` — `WebViewAssetLoader` secure origin + origin-scoped WebMessage port;
  `file://`, generic `addJavascriptInterface`, arbitrary navigation and file access off.
  Local-only open URL/copy/file chooser не пересылаются host как сетевые команды.
- Shared chat web UI — existing OMP renderer plus remote-only diff/export/session hooks.

### 8.3 Web content security

- Static app загружается только с `https://appassets.androidplatform.net` через
  `WebViewAssetLoader`; CSP: `default-src 'none'`, scripts/styles только packaged hashed
  assets, без `unsafe-inline`, `unsafe-eval`, remote subresources or arbitrary navigation.
- Markdown renderer сначала HTML-escape-ит input; разрешённый формат строится собственным
  renderer без raw HTML. Tool args/results вставляются через `textContent`/escaped nodes.
  URL допускаются только `https:`/`http:` и открываются native intent после confirmation.
- Privileged WebMessage port передаётся только известному packaged renderer и принимает
  closed typed schema; неизвестные fields/commands/oversize отклоняются. Renderer не
  получает raw room/device secrets.
- XSS fixtures (`script`, event attrs, SVG/data/javascript URL, hostile tool output,
  broken markdown fences) должны доказать отсутствие script execution и bridge access.

## 9. Relay

- Добавить минимальный blind relay implementation и Dockerfile для self-hosting.
- Relay знает только room id, role, peer id, timestamps and byte counts; не имеет ключей.
- Один host на room, bounded guests/room/frame/rate, idle timeout, ping/pong,
  explicit close codes, no persistence.
- Reference relay является нормативным contract для релиза. `my.omp.sh` использует ту же
  opaque envelope-модель, но custom application protocol и его limits/SLA не обещаны:
  включить его как default можно только после live host/guest/size/reconnect contract gate;
  иначе UI требует URL self-hosted relay и честно показывает internet mode как unconfigured.

## 10. Тестирование

### 10.1 Desktop/unit

- Existing typecheck/test/build/package.
- Link parser, crypto known-answer and tamper tests, envelope framing.
- Pairing expiry/two-phase retry/one-shot/revoke с room-id and key-epoch rotation.
- Schema/allowlist, oversized payloads, malformed JSON, wrong key/token.
- Sequence gap/replay/generation reset, durable counter/high-water mark, cross-epoch replay,
  crash-after-accept и idempotent command retry.
- Approval desktop-vs-phone race; duplicate prompt/revert rejected.
- OmpSession sync parity and all baseline regression tests from section 2.
- Capability escalation/session/workspace/path/credentials denial tests.
- CSP/XSS sanitizer and privileged-port denial tests.

### 10.2 Relay/integration

- In-process relay: host+guest two-phase enrol, reconnect, replay/full sync, backpressure.
- Chunked attachment loss/reorder/resume/hash mismatch/quota/cancel/cleanup.
- Two sessions streaming concurrently; Android-selected session filtering.
- Network cut during prompt and during approval.
- Relay cannot decrypt a captured application frame.

### 10.3 Android

- JVM tests for parser/HKDF/crypto/protocol reducer/outbox/capabilities.
- Instrumented WebView bridge test: transcript, stream, modal approval, models/history.
- File/photo 0-byte, normal and >20 MiB paths.
- `remoteMessaging` background/foreground reconnect, process recreation and notifications;
  отдельно проверить ограничения Android 14/API 34 и target/API 36.
- Build debug APK; launch on an available arm64 emulator; inspect logcat for crashes.

### 10.4 Manual end-to-end acceptance

1. Start OMP Code session on laptop and send a prompt.
2. Start Remote Control, scan expiring QR, see the existing transcript on Android.
3. Send prompt on Android; see exactly one user message and one streamed response on both.
4. Trigger file-write and shell approvals; answer from phone; both UIs close the request.
5. Change model/thinking/access; verify OMP RPC state and warm session continuity.
6. Upload phone photo/file; verify safe host attachment and agent access.
7. Open diff and revert from phone; verify file content and dirty-file protection.
8. Run two live sessions; switch/stop/create from phone without cross-routing events.
9. Drop Wi-Fi, restore it, verify no duplicate prompt and transcript catches up.
10. Revoke phone, verify old credential can neither command nor decrypt new events.

## 11. Артефакты релиза

- `omp-code-0.7.0.vsix` and source+VSIX archive.
- `android/app/build/outputs/apk/debug/omp-code-remote-0.1.0-debug.apk`.
- Unsigned release APK/AAB if release build passes.
- `remote-relay/` Docker image definition and self-host guide.
- `ANDROID_REMOTE_PROTOCOL.md`, Android setup/start-here, security/privacy notes,
  SHA-256 checksums and a validation report with exact tested/unavailable boundaries.

## 12. Порядок реализации

1. Зафиксировать baseline, исправить все выявленные регрессы 0.6.0.
2. Platform/security spike: минимальный target-36 APK с `remoteMessaging`,
   `WebViewAssetLoader`, CSP/WebMessage и hostile-markdown fixture; собрать, запустить на
   emulator, проверить background/reconnect. Без этого gate основной Android перенос не
   начинается.
3. Реализовать pure protocol/HKDF/crypto/link/capability/idempotency libraries и tests.
4. Реализовать relay и end-to-end transport test.
5. Добавить OmpSession remote adapter, lease и RemoteControlService.
6. Добавить desktop consent/commands/QR/status/settings/localization/docs.
7. Развить Android project: secure store/connection/outbox/session shell.
8. Подключить общий chat UI, native file/URL/share/session integrations.
9. Пройти desktop, relay, Android unit/instrumented and emulator E2E gates.
10. Собрать VSIX/APK/AAB, checksums and validation report.

## 13. Жёсткие критерии готовности

- Нельзя называть remote готовым, если телефон управляет вторым OMP-процессом.
- Нельзя открывать порт ноутбука или разрешать plaintext non-local `ws://`.
- Нельзя логировать QR, room key, device token, API keys, prompts, responses or auth URLs.
- Нельзя считать optimistic UI подтверждением доставки prompt.
- Нельзя обещать exactly-once: контракт — at-most-once dispatch с честным
  `indeterminate` после crash boundary.
- Нельзя называть application protocol совместимым с native OMP collab guest.
- Нельзя выдавать all-session/admin/credentials scope без desktop-side consent.
- Нельзя запускать привилегированный Android bridge без прошедшего CSP/XSS spike.
- Нельзя считать APK проверенным на Android без успешной сборки и запуска на emulator/device.
- Нельзя считать internet E2E проверенным только in-process relay тестом; эта граница
  отдельно указывается, если public relay недоступен.
- Существующие незакоммиченные изменения не перезаписываются и не откатываются.
