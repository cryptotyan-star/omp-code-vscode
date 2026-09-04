# OMP Code Remote — START HERE

Комплект рассчитан на OMP Code `0.7.0` и Android-приложение OMP Code Remote
`0.1.0`. Телефон продолжает **ту же активную сессию**, которая работает в OMP Code
на компьютере: модель, файлы, терминал и инструменты остаются на ноутбуке. Компьютер
должен быть включён, VS Code и исходная OMP-сессия — активны.

## 1. Сначала проверьте комплект

1. Откройте `docs/REMOTE_VALIDATION.md`. Статус `PASS` означает только то, что
   подтверждено командой и evidence в соответствующей строке. `NOT_RUN`, `BLOCKED` и
   `FAIL` нельзя интерпретировать как проверенный функционал.
2. Проверьте файлы по `SHA256SUMS` из корня распакованного комплекта:

   ```sh
   # macOS
   shasum -a 256 -c SHA256SUMS

   # Linux
   sha256sum -c SHA256SUMS
   ```

3. Не устанавливайте комплект, если checksum не совпал или архив получен из
   недоверенного источника.

## 2. Состав архива

```text
OMP-Code-Remote-0.7.0-Android-0.1.0/
├── 00-START-HERE.md
├── SHA256SUMS
├── MANIFEST.tsv
├── artifacts/
│   ├── desktop/
│   │   └── omp-code-0.7.0.vsix
│   ├── android/
│   │   ├── omp-code-remote-0.1.0-debug.apk
│   │   ├── omp-code-remote-0.1.0-release-unsigned.apk
│   │   └── omp-code-remote-0.1.0-release.aab
│   └── relay/
│       └── omp-code-remote-relay-0.1.0-source.tar.gz
├── docs/
│   ├── REMOTE_VALIDATION.md
│   ├── ANDROID_REMOTE_PROTOCOL.md
│   ├── ANDROID_REMOTE_PLAN.md
│   ├── ANDROID_REMOTE_PLAN_CRITIQUE.md
│   ├── ANDROID_SECURITY_SPIKE.md
│   └── REMOTE_RELAY_SELF_HOSTING.md
└── LICENSE
```

`MANIFEST.tsv` помечает signing-state каждого исполняемого артефакта. Для этого
комплекта debug APK, unsigned release APK и unsigned release AAB обязательны: упаковка
останавливается, если любой из результатов соответствующей Gradle-сборки отсутствует.

## 3. Установка расширения на компьютере

Требования: VS Code с поддерживаемой расширением версией и рабочий OMP CLI.

```sh
code --install-extension artifacts/desktop/omp-code-0.7.0.vsix --force
```

Перезапустите окно VS Code. Откройте OMP Code и запустите обычную сессию. Remote
Control не запускает второй OMP-процесс и не переносит исполнение на телефон.

## 4. Relay

Для controlled/self-hosted варианта распакуйте исходники relay на сервере с Node.js
20+:

```sh
mkdir omp-code-relay
tar -xzf artifacts/relay/omp-code-remote-relay-0.1.0-source.tar.gz -C omp-code-relay
cd omp-code-relay/remote-relay
npm ci
npm start
```

Health endpoint: `GET /healthz`. Для сети разрешён только `wss://` через TLS reverse
proxy. Plaintext `ws://` допускается приложением лишь для loopback (`localhost`,
`127.0.0.1`, `[::1]`). Не публикуйте raw WebSocket listener в интернет.

Публичный `my.omp.sh` считается подтверждённым для полноценного Android E2E только
если соответствующая строка в `REMOTE_VALIDATION.md` имеет `PASS`. Локальный
reference-relay тест не доказывает SLA, quota или доступность публичного сервиса.

В VS Code задайте origin через `ompcode.remoteRelayUrl`, например
`wss://remote.example.org`, до запуска Remote Control.

## 5. Установка Android-приложения

Debug APK предназначен для проверки и подписан отладочным ключом сборочной среды:

```sh
adb install -r artifacts/android/omp-code-remote-0.1.0-debug.apk
```

Его application id — `sh.omp.remote.debug`. Это не production-подпись.

Файлы `release-unsigned.apk` и `.aab` намеренно **не подписаны**. APK нельзя считать
готовым к распространению или безопасному обновлению, пока владелец продукта не
подпишет его своим защищённым стабильным ключом и не проверит подпись. AAB нельзя
устанавливать напрямую через `adb`; он предназначен для доверенного release pipeline
или Play Console. Ни ключ подписи, ни keystore в комплект не входят.

## 6. Подключение телефона к активной сессии

1. На компьютере откройте Command Palette и выполните
   `OMP Code: Start Android Remote Control`.
2. Выберите scope доступа на desktop. Без отдельного desktop-consent телефон не должен
   получать all-session, settings или credentials authority.
3. Откройте `OMP Code: Open Remote Control`. Отсканируйте показанный QR в Android-
   приложении либо вставьте одноразовую pairing-ссылку вручную.
4. Не публикуйте QR и pairing-ссылку: до истечения срока это секрет подключения.
5. Дождитесь состояния защищённого соединения и полной синхронизации. Только после
   terminal ACK команда с телефона считается выполненной; optimistic UI не является
   подтверждением доставки.

Для полного прекращения доступа выполните на компьютере
`OMP Code: Stop and Revoke Remote Control` или используйте действие отзыва в Android-
приложении. Обычный разрыв сети не является отзывом: клиент может переподключиться.

## 7. Граница безопасности и приватности

- Session payload шифруется end-to-end (AES-256-GCM); relay не получает ключи и не
  должен видеть prompts, responses, файлы, approvals или API keys.
- Relay всё равно видит сетевые метаданные: room id, роли/peer id, время соединения и
  объём трафика.
- Pairing key, room key, device credential, API keys и auth URL не должны попадать в
  логи, screenshots, crash reports или Android backup.
- Файлы с телефона временно расшифровываются и staging-ятся на компьютере с локальными
  filesystem permissions. Их lifecycle описан в `ANDROID_REMOTE_PROTOCOL.md`.
- Authority остаётся на компьютере: capability manifest и workspace roots определяет
  host, а не Android UI.
- Контракт доставки — at-most-once dispatch с состоянием `indeterminate` на crash-
  границе, а не обещание exactly-once execution.

## 8. Что нельзя заявлять без соответствующего PASS

- Проверенную работу на Android — без сборки, установки и запуска на emulator/device.
- Background reconnect и notifications — без runtime-теста целевой версии Android.
- Полный internet E2E — по одному только in-process/local relay тесту.
- Production-ready Android release — для debug или unsigned APK/AAB.
- Полный функциональный паритет — если manual E2E строки approvals, attachments,
  diff/revert, multi-session и reconnect ещё `NOT_RUN` или `BLOCKED`.

Подробный wire/security contract находится в `docs/ANDROID_REMOTE_PROTOCOL.md`, а
точные результаты текущего прогона — только в `docs/REMOTE_VALIDATION.md`.
