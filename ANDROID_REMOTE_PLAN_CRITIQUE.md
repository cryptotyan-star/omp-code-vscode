# Plan Critic Report — OMP Code Android Remote Control

Дата: 2026-08-22  
Объект: `ANDROID_REMOTE_PLAN.md`  
Метод: два независимых read-only review; код до прохождения gate не изменялся.

## Первый verdict: REVISE

Первый критик остановил исходный план по семи блокирующим причинам:

1. Revoke вращал key, но оставлял старый room id, что позволяло отозванному peer
   продолжать занимать/flood-ить room.
2. UUID + bounded memory cache не давали защиту от replay и повторного выполнения после
   restart/cache eviction.
3. Enrolment уничтожала pairing key до подтверждения доставки постоянного credential.
4. 20 MiB binary attachment превращался в ~26.7 MiB base64 до JSON/GCM и не помещался в
   заявленный 25 MiB frame.
5. Android `dataSync` foreground service имеет шестичасовую background-квоту и не
   соответствует длительному remote control.
6. План не описывал реальный refactor жёсткой зависимости UI от `acquireVsCodeApi()`.
7. Публичный `my.omp.sh` не обещает поддержку custom application frames/limits/SLA;
   совместимость была заявлена до проверки.

## Исправления редакции 2

- Re-pair/revoke теперь закрывает старую room и вращает room id, host generation, epoch,
  room key и device token.
- Введены durable per-device counter/high-water mark, authenticated room/epoch/direction/
  peer/session context и `indeterminate` crash state.
- Enrolment стал двухфазным, idempotent и peer-bound с `enrolled-ack` до уничтожения
  pairing key.
- Вложения переведены на start/chunk/commit/cancel с <=256 KiB chunks, SHA-256,
  ACK/resume/quota/cleanup.
- Android service type заменён на `remoteMessaging`; background policy включена в tests.
- Введён общий `HostPort` с VS Code, Android WebMessage и in-memory adapters.
- Reference self-host relay стал нормативным; public OMP relay — только после live gate.
- Явно записано, что application protocol не совместим с native OMP collab v3.

## Второй verdict: REVISE

Повторный независимый critic подтвердил исправление прежних blockers и потребовал четыре
последних решения до начала кода:

1. Capability manifest и безопасный default вместо полного доступа телефона ко всем
   sessions/workspaces/settings/credentials.
2. Content-XSS защита privileged WebView bridge, а не только origin restriction.
3. Формальная key derivation/nonce policy и честное название гарантии выполнения:
   at-most-once dispatch, не exactly-once.
4. Ранний target-36 platform/security spike для `remoteMessaging`, WebView CSP и hostile
   markdown до основной Android-реализации.

## Исправления редакции 3

- Default credential ограничен исходной сессией; `all sessions`, settings и credentials
  требуют отдельного desktop consent. Host проверяет capability на каждой команде.
- Добавлены secure-origin `WebViewAssetLoader`, строгий CSP, собственный escaped markdown
  renderer, typed origin-scoped WebMessage port и XSS fixtures.
- Добавлены HKDF-SHA-256 purpose/direction keys, authenticated reconnect nonces,
  connection-specific traffic keys и детерминированный direction+counter nonce.
- Контракт переименован в `at-most-once dispatch with indeterminate recovery`.
- Platform/security spike стал обязательным вторым этапом и gate перед переносом UI.

## Финальное согласование

Последний pass обнаружил два текстовых противоречия, которые были устранены: random IV
заменён единым counter-based nonce contract; `Exactly-once approval` — согласован с
`first-valid-answer-wins / at-most-once dispatch + indeterminate recovery`. После этих
двух исправлений critic указал итоговое условие **PASS**.

## Gate для начала реализации

Редакция 3 прошла plan-critic gate. Порядок реализации:

1. Исправить подтверждённые baseline-регрессы 0.6.0.
2. Пройти минимальный Android platform/security spike.
3. Реализовать и проверить protocol/security core до подключения mutating remote commands.
