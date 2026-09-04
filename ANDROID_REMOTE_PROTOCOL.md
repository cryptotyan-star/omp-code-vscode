# OMP Code Remote Protocol v1

Статус: normative wire contract для desktop extension и Android-клиента.

Этот протокол даёт телефону управление **тем же** `OmpSession`, который уже работает в
VS Code. Он использует topology/envelope OMP relay, но application frames не совместимы
с native `pi-wire COLLAB_PROTO=3`. Второй процесс `omp` не запускается.

## 1. Transport и границы доверия

- Relay URL: `wss://<origin>/r/<roomId>?role=host|guest`.
- `roomId`: 16 CSPRNG bytes, lowercase hex (32 символа).
- `ws://` разрешён только для `localhost`, `127.0.0.1` и loopback IPv6.
- Relay видит room, peer id, размеры и время frames, но не plaintext.
- Binary relay frame:

```text
outerPeerId:u32be | nonce:12 | ciphertext:N | gcmTag:16
```

- Guest отправляет relay `outerPeerId=0`; relay переписывает его в назначенный sender
  peer id. Host отправляет `0` для broadcast или `N` для конкретного guest.
- Секретные/pairing frames никогда не broadcast-ятся.
- Unencrypted relay control использует native OMP shape и ограничен host frames
  `{"t":"peer-joined"|"peer-left","peer":N}` и guest frame
  `{"t":"room-closed"}`; другие TEXT frames игнорируются/закрывают connection.
- Control plaintext не более 256 KiB. Attachment не более 20 MiB, chunk не более
  256 KiB. Один base64 frame для файла запрещён.

## 2. Pairing URI

Canonical форма:

```text
omp-code://pair?v=1&relay=<percent-encoded-origin>&room=<32hex>
  &key=<32-byte-unpadded-base64url>&expires=<unix-ms>&epoch=<positive-u32>
```

Физически URI однострочный; перенос выше только для чтения. TTL не более 10 минут.
Неизвестные, повторяющиеся или отсутствующие параметры отклоняются. Приложение не пишет
полный URI/key в log, analytics, crash report, recent-search или clipboard history.

Нормативная реализация parser/formatter: `src/remoteProtocol.ts`. Android parser обязан
проходить те же positive/negative fixtures.

## 3. Key schedule

Все master/pairing/device-token значения имеют 32 bytes. HKDF — SHA-256, output 32 bytes.

Directional salt (UTF-8):

```text
omp-code-remote/v1\0<roomId>\0<keyEpoch>
```

Directional info (UTF-8):

```text
omp-code-remote/v1\0<purpose>\0<direction>
```

`purpose ∈ {pair, auth, traffic}`, `direction ∈ {device-to-host, host-to-device}`.
Pairing key используется только для одного pending enrolment. Room master key напрямую
не шифрует data frames.

Connection traffic key выводится из room master key:

```text
salt = directionalSalt || "\0connection\0" || hostNonce16 || deviceNonce16
info = directionalInfo("traffic", direction)
```

Порядок nonces всегда host затем device, независимо от direction.

## 4. AEAD header, nonce и replay

AES-256-GCM AAD — ровно 40 bytes:

```text
0..3    ASCII "OMP1"
4       protocolVersion u8 = 1
5       direction u8: 1=device-to-host, 2=host-to-device
6..7    flags u16be = 0
8..23   roomId raw 16 bytes
24..27  keyEpoch u32be (>0)
28..31  logicalPeerId u32be
32..39  frameCounter u64be
```

Nonce — ровно 12 bytes:

```text
0..3   0x44324831 (ASCII D2H1) либо 0x48324431 (ASCII H2D1)
4..11  frameCounter u64be
```

Для каждого key/direction counter монотонно растёт. Receiver сначала проверяет GCM и
только затем двигает replay high-water mark; forged high counter не блокирует канал.

`logicalPeerId` обычно равен receiver-visible outer peer. Исключение: первый guest frame
`pair` или `hello` отправляется до того, как guest узнал назначенный relay peer. Он имеет
logical peer `0`; host получает переписанный outer `N` и открывает frame с `aadPeerId=0`.
Targeted host reply сообщает/аутентифицирует `N`; следующие guest frames используют
logical peer `N`, хотя guest по relay contract продолжает отправлять outer `0`.

Long-lived auth keys имеют **durable** counters на весь key epoch. Они не сбрасываются
при reconnect/restart. Connection traffic counters начинают с нуля только после вывода
нового connection key из новых 128-bit host/device nonces.

Нормативная реализация и KAT: `src/remoteCrypto.ts`, `test/remoteCrypto.test.ts`.

## 5. Enrolment state machine

```text
QR issued
  → pair (D2H pair key, logicalPeer=0, device-nonce-derived counter)
  → enrolled (H2D pair key, targeted N, peer-bound enrolment counter)
  → enrolled-ack (D2H pair key, logicalPeer=N, same peer-bound counter)
  → active (host persists device and destroys pairing key)
```

Правила:

- `pairCounter = uint64be(SHA256(UTF8("omp-code-remote/v1\0pair-counter\0") ||
  base64urlDecode(deviceNonce))[0..8]) & 0x7fff_ffff_ffff_ffff`. Host после
  authenticated decrypt обязан пересчитать counter из `pair.deviceNonce`.
- `enrolCounter = 0x8000_0000_0000_0000 | uint64(assignedPeerId)` используется
  для `enrolled` и `enrolled-ack`. High-bit domains исключают nonce collision с
  pair request; новый relay peer при rebind получает новый counter.
- Host связывает pending enrolment с room, epoch, relay peer, device id и expiry.
- `pair` retry обязан повторять тот же transaction/payload; другой payload с тем же
  pairing context — conflict.
- `enrolled` содержит фиксированные для pending transaction `enrolmentId`, room master
  key, device token, key epoch, host generation и capability manifest. До ACK host может
  безопасно повторить тот же ciphertext.
- Android сначала атомарно сохраняет credential через Android Keystore, затем отправляет
  `enrolled-ack` с `enrolmentId` и credential digest.
- Host активирует device и уничтожает pairing key только после валидного ACK. ACK retry
  idempotent. Истёкший pending enrolment никогда не активируется.
- Первый релиз допускает один write-device. Re-pair/revoke закрывает старую room и вращает
  room id, key epoch, room master key, device token и host generation.

## 6. Authenticated reconnect

```text
hello       D2H auth key, durable auth counter, logicalPeer=0
challenge   H2D auth key, durable auth counter, targeted assigned peer N
proof       D2H new traffic key, traffic counter=0, logicalPeer=N
welcome     H2D new traffic key, traffic counter=0, targeted N
data        independent directional traffic counters from 1
```

`hello` содержит device id/token, fresh device nonce, последнюю host generation и
последний применённый event sequence. `challenge` эхо-подтверждает device nonce и содержит
fresh host nonce, assigned peer, current generation и connection id. `proof` связывает
handshake transcript HMAC; `welcome` переводит connection в active. До `welcome` mutating
commands не принимаются.

После каждого authenticated reconnect и при generation mismatch host отправляет
детерминированный phased full sync. Чувствительные transcript/diff/event payloads не
пишутся в `globalState`; reconnect восстанавливается из живого `OmpSession`.

## 7. JSON frames

Каждый JSON object имеет `protocolVersion: 1` и закрытый schema guard. Неизвестная major
version, неизвестный command, неверный type/size или лишние authority claims отклоняются
до обращения к `OmpSession`.

### 7.1 Mutating command

```json
{
  "protocolVersion": 1,
  "type": "command",
  "commandId": "uuid",
  "commandCounter": "42",
  "hostGeneration": "uuid",
  "sessionId": "desktop-session-id",
  "command": "prompt.send",
  "payload": { "text": "continue", "attachmentIds": [] }
}
```

`commandCounter` — canonical decimal uint64 string, не JSON number. `sessionId` отсутствует
только у действительно host-global commands. Полный allowlist и payload schemas находятся
в `RemoteCommandPayloadMap` (`src/remoteProtocol.ts`); raw RPC objects не разрешены.
Parity-команды имеют закрытые payloads: `auth.login` (только `anthropic|kimi-code`),
`profile.update` (только два scalar-поля), `models.probe`, `history.open` по точной записи
host history и optional `prompt.send.forModel`.

ACK lifecycle:

```text
accepted → completed | rejected | indeterminate
```

Android удаляет outbox item только после terminal ACK. `indeterminate` означает crash
между durable accept и side effect: host не повторяет команду, делает resync, пользователь
решает, отправлять ли новое действие с новым id/counter.

### 7.2 Host events

Каждый sequenced event содержит:

```json
{
  "protocolVersion": 1,
  "type": "event",
  "hostGeneration": "uuid",
  "sequence": "123",
  "sessionId": "desktop-session-id",
  "eventId": "uuid",
  "event": "session-message",
  "payload": {}
}
```

Sequence передаётся decimal uint64 string. Presence/ping и command ACK не sequenced.
Android подтверждает события cumulative ACK:

```json
{"protocolVersion":1,"type":"event-ack","hostGeneration":"uuid","sequence":"123"}
```

Host держит не более четырёх unacked sequenced events на peer, отправляет их с pacing не
быстрее 100 frames/s и при отсутствии ACK 30 секунд переподключается с обязательным full
sync. Future ACK или `hello.lastSequence` выше реально отправленного host high-water не
принимается. Event payloads не сохраняются в plaintext durable storage: после reconnect
host строит новый атомарный full sync, а live events ставятся после его `complete`.

Full sync состоит из `reset`, малых session/board/config sections, transcript chunks либо
bounded fragments и завершается `complete`. На один sync допускается до 128 sessions,
до 32 fragments на logical item и до 2 MiB на одно transcript message/section; превышение
заменяется typed notice, а не обрезанным JSON. Full sync включает boot configuration без
секретов, models/commands/state, transcript, stats/profile и open approvals. `keyStatus`
передаётся только при `credentials.manage`.

### 7.3 Private command-result stream

Command result размером до 64 KiB остаётся неизменённым `command-ack.result`. Более крупный
JSON до 2 MiB host отправляет только запросившему peer как атомарную последовательность
sequenced events с `event:"command-result"`:

```json
{"phase":"begin","streamId":"uuid","commandId":"uuid","encoding":"base64-json","totalBytes":70000,"chunkCount":1,"sha256":"lowercase-hex"}
{"phase":"chunk","streamId":"uuid","commandId":"uuid","index":0,"chunkCount":1,"data":"standard-base64-no-wrap"}
{"phase":"commit","streamId":"uuid","commandId":"uuid","totalBytes":70000,"chunkCount":1,"sha256":"lowercase-hex"}
```

Raw chunk не больше 96 KiB, chunks не больше 32. `sha256` считается от полного UTF-8 JSON
до base64. Host удерживает event-queue barrier, пропускает stream через общий ACK-window и
только после cumulative ACK для `commit` отправляет terminal completed ACK:

```json
{"streamed":true,"totalBytes":70000,"sha256":"lowercase-hex"}
```

Result больше 2 MiB не обрезается и не превращается в preview: terminal ACK имеет
`status:"rejected"`, `errorCode:"result-too-large"`, а stream не создаётся.

Android ACK-ит begin/chunks для flow control, но не продвигает durable
`hello.lastSequence` внутри незавершённого stream. На `commit` он проверяет identity,
индексы/count/decoded size/SHA, парсит JSON и атомарно сохраняет result вместе с commit
sequence до ACK. Если socket/process исчез до commit, partial отбрасывается, reconnect
advertise-ит pre-begin sequence и получает full sync. Тот же live host держит bounded
in-memory cache и на exact duplicate command повторяет stream без side effect. После host
restart private bytes недоступны: exact duplicate получает `indeterminate` с
`errorCode:"result-unavailable"`; read-only command можно повторить с новым command id.
Два result streams не перемешиваются: completed marker первого отправляется внутри той же
event-queue transaction до `begin` следующего.

### 7.4 Approval resolution

Durable admission всех commands сериализован, но `approval.respond` и `turn.abort` после
accept используют priority control lane и не ждут завершения routed prompt. Desktop UI и
phone используют один атомарный claim-before-stdin. Результат зеркалируется как:

```json
{"t":"approvalResolved","requestId":"request-id","outcome":"answered","winner":"desktop"}
```

`outcome` — `answered|cancelled`, `winner` — `desktop|remote|agent`. Сообщение доступно
только с verb `approve`; Android удаляет cached approval/modal. Проигравший phone response
получает terminal rejected ACK с `errorCode:"host-not-pending"` и тоже очищает request.

## 8. Capability manifest

Host является единственным authority. Manifest содержит device/manifest id, key epoch,
issue/expiry, session ids, canonical workspace roots, `allSessions` и verbs:

```text
view, prompt, approve, files, session.manage,
settings.manage, credentials.manage
```

`remote.stop` требует только `view`: любое успешно enrolled устройство может отозвать
собственную единственную room, но это не даёт ему session/settings authority.
До terminal completed ACK host durably записывает revoked-through-epoch tombstone и удаляет
credential из SecretStorage, оставляя traffic key только в памяти до flush. Restore всегда
отклоняет tombstoned epoch, даже если extension host упал до фактического закрытия socket.
Tombstone и удаление SecretStorage предшествуют durable записи `accepted`, поэтому crash не
оставляет восстановимую room в окне между принятием `remote.stop` и фиксацией revocation.
Сразу после durable admission `remote.stop` host включает необратимый in-memory barrier и
коммитит revocation внутри глобальной admission queue. Любая следующая новая команда
получает `revocation-in-progress` до side effect; допускается только exact duplicate для
восстановления уже принятого terminal status.

Safe pairing default: originating session + `view,prompt,approve,files`; без глобальной
history/lifecycle/settings/credentials. `Grant full OMP Code control` выдаётся только на
desktop и не включает credentials автоматически. Manifest HMAC проверяется host-side;
claims из команды не повышают права. Path operations проходят real/canonical path check
против разрешённых roots.

`current` grant привязан к exact ephemeral desktop session id. Если после перезапуска host
этот id отсутствует, host отзывает epoch и требует новый pairing; он никогда не передаёт
grant другой сессии только потому, что у неё тот же canonical workspace root.

Host обновляет manifest до истечения TTL и отправляет sequenced `capability-update` с новым
подписанным manifest. Android обязан проверить подпись/epoch/device, атомарно сохранить
update и использовать его для последующих команд; истёкший manifest не даёт authority.

## 9. At-most-once dispatch

До side effect host атомарно persist-ит `(epoch, device, commandCounter, commandId,
canonical-command-digest, accepted)`. Затем:

- тот же id/counter/digest не запускает side effect повторно и возвращает terminal status,
  если он ещё есть в bounded metadata; после pruning требует resync;
- тот же id с другим counter/digest — conflict;
- counter не выше durable high-water — replay;
- другой epoch/generation/session — rejected;
- незавершённый `accepted` после host restart становится `indeterminate`.

Гарантия называется **at-most-once dispatch with indeterminate recovery**, не
exactly-once execution.

## 10. Attachments

Control:

```text
attachment.start  {attachmentId,fileName,mediaType?,totalBytes,sha256}
attachment.commit {attachmentId}
attachment.cancel {attachmentId}
```

Binary plaintext chunk перед шифрованием:

```text
0..3    ASCII OMPA
4       version=1
5       flags=0
6..7    headerBytes=36 u16be
8..23   attachment UUID raw16
24..31  offset u64be
32..35  dataLength u32be
36..    bytes (<=256 KiB)
```

Host принимает только точный next offset и отвечает expected/next offset ACK. Commit
успешен лишь при `received==totalBytes` и совпадении SHA-256. Per-device reserved quota —
64 MiB. Partial и неиспользованные committed files очищаются по TTL, при cancel и при
startup sweep. Committed файл пишется mode `0600` во временный extension storage с
директорией mode `0700`, безопасным basename и становится prompt attachment только после
commit. Это локальный plaintext staging: после `prompt.send` файл удерживается до
соответствующего `agent_end` (в том числе дольше TTL), затем удаляется. Android отправляет
`attachment.cancel`, если пользователь убрал chip до отправки.

## 11. Relay compatibility gate

Reference relay в `remote-relay/` является нормативным сервером. Public `my.omp.sh`
прошёл live contract probe 2026-08-22 с принудительной TLS-проверкой: native
`peer-joined`, guest→host peer rewrite, byte-identical Android attachment wire frame
245828 bytes (240 KiB data chunk) и
targeted host→guest reply. Это позволяет использовать его как default relay,
но не доказывает SLA, долгосрочную quota или единый frame на 20 MiB;
поэтому transfer всегда chunked, а relay остаётся configurable.

## 12. Обязательные conformance tests

- TS/Kotlin одинаково парсят pairing URI, command fixtures, uint64 границы и rejects.
- HKDF/AAD/nonce/AES-GCM KAT byte-for-byte совпадают.
- Header/room/epoch/direction/peer/counter tamper не проходит authentication.
- Forged high counter не двигает replay guard; duplicate/lower frame отклоняется.
- Enrolment повторяется после drop между `enrolled` и ACK и не bricked.
- Host restart возвращает `indeterminate`, но не повторяет side effect.
- Full sync не перемешивается с live events; event window не превышает четыре unacked
  frames и timeout вызывает reconnect/resync.
- Future `hello.lastSequence`/event ACK не выключает delivery window.
- Capability refresh проходит на непрерывно активном соединении до expiry.
- Attachment loss/reorder/resume/cancel/quota/hash mismatch/cleanup.
- Revoke закрывает old room; старый device не читает и не исполняет команды нового epoch.
