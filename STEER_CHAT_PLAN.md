# Steer в чате — отправка промпта во время работы агента

**Цель:** накидывать промпты прямо в процессе выполнения хода, не дожидаясь
его завершения. Бэкенд steer готов и проверен по коду — задача в том, чтобы
раскрыть его в UI, дать честный фидбек и не сломать существующие инварианты.

> Номера строк в этом документе сверены с рабочим деревом на 2026-08-26.
> Перед правкой **перечитывай файл** — он меняется под тобой (пользователь
> параллельно работает в этом же репозитории).

---

## 0. Что уже работает — проверено по исходникам

### Хост (расширение)

- [src/ompSession.ts:1860-1867](src/ompSession.ts#L1860) — `promptOnce()`
  считает `steering = this.turnPendingOrActive || this.streaming` и шлёт
  `{type:"prompt", message, streamingBehavior: steering ? "steer" : undefined}`.
- [src/ompSession.ts:1049](src/ompSession.ts#L1049) — хост принимает
  `{t:"prompt"}` из вебвью и зовёт `promptOnce`. Никакой блокировки по
  `working` на этом пути нет.
- [src/ompProcess.ts:186-189](src/ompProcess.ts#L186) — команды `prompt` и
  `login` освобождены от 60-секундного таймаута.
- [src/ompSession.ts:2237](src/ompSession.ts#L2237) — remote-путь
  (`prompt.send`) идёт в тот же `promptOnce`, то есть тоже получает steer.

### omp (проверено в `~/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js`)

Три факта, на которых держится весь план:

1. **RPC `prompt` подтверждается сразу, а не в конце хода.** Обработчик
   делает `hGi({id, startPrompt: () => i.prompt(...)})` и немедленно
   возвращает `c(K,"prompt")`. То же зафиксировано комментарием в
   [src/ompSession.ts:1906](src/ompSession.ts#L1906). Следствие:
   `queueModelOperation` **не** держит второй промпт за первым, и steer
   реально доезжает до omp во время стрима. Если бы ответ приходил в конце
   хода — весь план был бы невозможен.
2. `session.prompt()` при `isStreaming` **без** `streamingBehavior` кидает
   `AgentBusyError("Agent is already processing. Use steer() or followUp()…")`.
   Со `streamingBehavior:"steer"` — кладёт сообщение в очередь и возвращается.
3. Steer кладётся в очередь агента как **обычное user-сообщение**:
   `agent.steer({role:"user", content, steering:true, attribution:"user"})`.
   Когда агент его подхватывает, оно эмитится наружу как `message_start`
   с `role:"user"`.

Дополнительно доступно и пока не используется:

- `get_state` отдаёт `queuedMessageCount` и `steeringMode`
  (`dist/types/modes/rpc/rpc-types.d.ts:187,198`). Расширение читает из
  state только `isStreaming` ([src/ompSession.ts:2832](src/ompSession.ts#L2832)).
- Существуют отдельные RPC-команды `steer` и `follow_up`
  (`rpc-types.d.ts:30,35`) — запасной явный путь, если `streamingBehavior`
  где-то окажется недостаточным.

### Вебвью

- Enter шлёт `sendPrompt()` без проверки `working`
  ([media/main.mjs:2947](media/main.mjs#L2947)) → на десктопе steer уже
  работает, но только через Enter и без всякой индикации.
- Enter отключён на Android (там `Enter` = новая строка) → **на Android
  steer сейчас невозможен**, потому что `btnSend` прячется.
- `setWorking(on)` ([media/main.mjs:734-741](media/main.mjs#L734)) прячет
  `btnSend` через `.hidden` и показывает `btnStop`.
- `sendPrompt()` ([media/main.mjs:2836-2871](media/main.mjs#L2836)) шлёт
  `{t:"prompt"}`, инкрементит `pendingLocalUser`, рисует локальный пузырь,
  чистит input и вложения, зовёт `setWorking(true)`.
- `addUserBubble(text, files)` — [media/main.mjs:304](media/main.mjs#L304).
- Эхо от хоста гасится счётчиком `pendingLocalUser`
  ([media/main.mjs:154](media/main.mjs#L154), потребление —
  [media/main.mjs:432](media/main.mjs#L432)).

---

## 1. Известные ловушки — прочитать до первой правки

Эти пункты — причина, по которой наивная реализация даст баги.

### 1.1 Эхо steer-промпта ПРИХОДИТ. Счётчик не трогать

Steer попадает в контекст как обычное `role:"user"` сообщение (см. §0, факт 3),
поэтому `message_start` с ролью `user` **придёт** и будет погашен
`pendingLocalUser`. Инкремент на [media/main.mjs:2861](media/main.mjs#L2861)
**оставить как есть**. Снятие инкремента = дубли пузырей на каждом steer.

### 1.2 `promptFailed` гасит рабочее состояние живого хода

[media/main.mjs:3272-3275](media/main.mjs#L3272):

```js
case "promptFailed":
  setWorking(false);
  if (pendingLocalUser > 0) pendingLocalUser--;
  break;
```

Если провалится **steer**, ход при этом продолжается — а UI погасит
индикатор и кнопку Stop. Нужен guard (см. Фазу 1).

### 1.3 Потеря текста при отказе

`sendPrompt()` чистит `input.value` и `attachments` сразу после `post()`,
не дожидаясь результата. Любой `promptFailed` (в том числе гонка из §1.4)
теряет набранный текст. Это баг уже сегодня; steer делает его заметнее,
потому что отказ становится вероятнее.

### 1.4 Гонка «хост думает idle, а omp уже стримит»

`streaming`/`turnPendingOrActive` в расширении обновляются по фреймам, то
есть с задержкой. В окне рассинхрона `promptOnce` отправит промпт **без**
`streamingBehavior` → omp ответит `AgentBusyError`. Обратная гонка (шлём
steer, а ход уже кончился) безобидна: omp просто выполнит обычный ход.

### 1.5 `workingText` не принадлежит нам

omp пишет туда через `extension_ui_request {method:"setStatus"}`
([media/main.mjs:766-771](media/main.mjs#L766)). Текст «Steering…»,
записанный в `workingText`, будет затёрт первым же `setStatus`.
Индикатор steer — отдельный элемент.

### 1.6 Две кнопки на одной позиции на Android

[media/main.css:2146-2156](media/main.css#L2146): `.send-btn` на Android —
`position:absolute; right:10px; bottom:10px; width:48px`. `.send-btn.stop`
наследует те же правила. Показать обе одновременно без явной раскладки =
кнопки лягут одна на другую.

### 1.7 Разметка продублирована и живёт в двух разных местах

- Десктоп: HTML генерируется строкой в хосте —
  [src/ompSession.ts:2995-2996](src/ompSession.ts#L2995), заголовки кнопок
  подставляются через `esc(t("Send"))` / `esc(t("Stop"))`.
- Android: статический файл [media/android.html:49-50](media/android.html#L49),
  где `title`/`aria-label` захардкожены по-английски.

`media/main.html` **не существует** — не искать. Любая правка разметки
кнопок делается в **обоих** местах. Атрибуты, которые `setWorking` меняет в
рантайме, перекроют оба варианта — это нормально.

### 1.8 Существующие тесты пинят форму кода

- [test/webviewWiring.test.ts:325](test/webviewWiring.test.ts#L325) матчит
  регуляркой строку `if (post({ t: "prompt", text: text, attachments: files, …) === false) return;`.
  Менять форму этого вызова нельзя, не поправив тест.
- [test/l10n.test.ts](test/l10n.test.ts) сканирует все `t("…")` в `src/` и
  `media/` и требует ключ в `l10n/ru.json`. Каждая новая строка через `t()`
  обязана попасть в бандл, иначе тесты красные.

### 1.9 Abort сносит очередь целиком

Кнопка Stop шлёт `{type:"abort"}` — она обрывает весь ход вместе с
накопленными steer-сообщениями. Отмены отдельного steer в протоколе нет.
UI не должен обещать обратное.

### 1.10 `steeringMode`

Профиль может ставить `steeringMode: "all" | "one-at-a-time"`
([src/modelProfiles.ts:72-73](src/modelProfiles.ts#L72)). При
`one-at-a-time` несколько подряд накиданных steer доставляются агенту
по одному. UI не должен обещать «все ушли разом».

### 1.11 Routed-промпты steer не поддерживают — и не должны

[src/ompSession.ts:1877-1881](src/ompSession.ts#L1877) намеренно кидает
`cannot route a prompt while another turn is active`. Это правильно:
routed-отправка меняет модель, её нельзя вклинивать в идущий ход.
**Не менять.** UI при активном ходе просто не должен предлагать routed-send
(чип маршрута остаётся, но send уходит как обычный steer — либо показываем
понятную ошибку, см. Фазу 1).

---

## Фаза 1 — Хост: устойчивый steer

**Цель:** сделать отправку во время хода надёжной до того, как её раскроют в UI.

- [ ] `promptOnce` ([src/ompSession.ts:1836](src/ompSession.ts#L1836)):
      на ошибку от `proc.request` с `AgentBusyError` (сопоставлять по
      подстроке `already processing` — omp не шлёт машинного кода ошибки)
      сделать **ровно один** повтор с `streamingBehavior:"steer"`.
      Повтор только когда `steering` был `false` (иначе steer уже пробовали).
- [ ] Отличать провал steer от провала обычного промпта: добавить в
      `{t:"promptFailed"}` поле `steer: boolean` (значение `steering` из
      того же вызова), чтобы вебвью знало, гасить ли working.
- [ ] Прокинуть `queuedMessageCount` из `get_state` в `pushState`
      ([src/ompSession.ts:2832](src/ompSession.ts#L2832) читает только
      `isStreaming`) — это единственный честный источник «сколько накидано».
      Локальный счётчик в вебвью не заводить.
- [ ] Не трогать routed-ветку.

**Проверка:** unit-тест на ретрай (мок `OmpProcess`, первый `request`
кидает `Error("Agent is already processing…")`, второй резолвится; ассерт —
второй вызов ушёл с `streamingBehavior:"steer"`).

---

## Фаза 2 — Десктоп: Send остаётся видимой и переключается в steer

**Цель:** Send не прячется во время стрима, а переходит в steer-режим.

- [ ] `setWorking(on)` ([media/main.mjs:734](media/main.mjs#L734)):
      убрать `btnSend.classList.toggle("hidden", working)`; вместо этого
      `btnSend.classList.toggle("steer", working)`. `btnStop` показывается
      как сейчас.
- [ ] Там же обновлять `title`/`aria-label` кнопки: `t("Send")` ↔
      `t("Steer (send while running)")`.
- [ ] CSS ([media/main.css:938-963](media/main.css#L938)): добавить
      `.send-btn.steer` — отличный от `--accent` фон (приглушённый акцент
      или `--warn`), иконка `⇪`. Класс `.stop` не трогать: он висит на
      отдельной кнопке `#btn-stop`.
- [ ] Обработчик `promptFailed` ([media/main.mjs:3272](media/main.mjs#L3272)):
      ```js
      case "promptFailed":
        if (!m.steer) setWorking(false);
        if (pendingLocalUser > 0) pendingLocalUser--;
        // вернуть черновик, чтобы отказ не съедал набранное
        break;
      ```
- [ ] Восстановление черновика: в `sendPrompt()` запомнить `text`+`files`
      перед очисткой; на `promptFailed` вернуть `input.value` (только если
      пользователь с тех пор ничего не набрал) и `attachments`, дёрнуть
      `autogrow()` + `renderAttachments()`. Форму строки `post({ t: "prompt", … })`
      не менять — её пинит тест (§1.8).
- [ ] `sendPrompt()` менять больше нечем: блокировки по `working` там нет.

**Проверка:** F5 → отправить промпт → во время стрима нажать Send и Enter →
оба уходят как steer, агент их подхватывает, дублей пузырей нет.

---

## Фаза 3 — Android: steer через кнопку

**Цель:** steer на телефоне (Enter остаётся новой строкой).

- [ ] Раскладка ([media/main.css:2146](media/main.css#L2146)): развести
      кнопки явно. Предлагаемое: `#btn-stop` остаётся `right:10px`,
      `.send-btn.steer` уезжает на `right:66px` (48px кнопка + 8px зазор).
      Обе ≥48px, `touch-action: manipulation`. Проверить, что
      `.attachments { margin: 0 54px 7px 0 }` ([media/main.css:2158](media/main.css#L2158))
      не наезжает — расширить отступ под две кнопки.
- [ ] Разметку (если понадобится обёртка кнопок) править **в обоих**
      местах: [src/ompSession.ts:2995](src/ompSession.ts#L2995) (десктоп,
      генерируется строкой) и [media/android.html:49](media/android.html#L49)
      (статика). См. §1.7.
- [ ] Enter-условие на [media/main.mjs:2947](media/main.mjs#L2947) не
      трогать — мобильная конвенция сохраняется.
- [ ] Мост проверять не нужно: [media/host-port.mjs](media/host-port.mjs)
      прокидывает `postMessage` без учёта состояния хода, а
      `BridgeMessageValidator.kt:67,84` пропускает `prompt` всегда.
      Достаточно подтвердить это ручным прогоном.

**Проверка:** на Android-сборке отправить промпт, во время стрима нажать
Send → steer уходит, кнопки не перекрывают друг друга, обе нажимаются.

---

## Фаза 4 — Фидбек: видно, что промпт ушёл «в процесс»

**Цель:** пользователь отличает steer от нового хода и видит, сколько накидано.

- [ ] `addUserBubble(text, files, opts)` ([media/main.mjs:304](media/main.mjs#L304)):
      третий необязательный аргумент; при `opts.steer` вешать класс
      `.steer` на пузырь и добавлять мини-бейдж `↳ steer`.
- [ ] В `sendPrompt()` передавать `{ steer: working }` третьим аргументом.
- [ ] **Не** трогать `pendingLocalUser` (§1.1). Эхо от хоста придёт и будет
      погашено — это ожидаемое поведение, а не баг.
- [ ] Индикатор очереди — **отдельный** элемент рядом с `workingEl`, не
      подмена `workingText` (§1.5). Текст: `t("queued: {0}")` из
      `queuedMessageCount`, приехавшего в state (Фаза 1). Скрывать при 0.
- [ ] CSS: `.msg.user .bubble.steer` (приглушённый фон / левая полоска) и
      `.steer-badge`.
- [ ] Новые строки `t("…")` добавить в [l10n/ru.json](l10n/ru.json).
      Строки из `package.json` (если появятся команды) — в
      `package.nls.json` и `package.nls.ru.json`.

**Проверка:** steer-пузырь визуально отличается; счётчик очереди растёт при
нескольких быстрых steer и обнуляется, когда агент их разобрал.

---

## Фаза 5 — Remote Control

**Цель:** steer с телефона-пульта ведёт себя так же.

- [ ] Код менять, скорее всего, не нужно: `prompt.send` →
      [src/ompSession.ts:2237](src/ompSession.ts#L2237) → `promptOnce` →
      steer. Подтвердить прогоном, а не чтением.
- [ ] Вложения: `promptAttachmentsBySession`
      ([src/remoteControlService.ts:244](src/remoteControlService.ts#L244))
      и cleanup в `catch` ветке `prompt.send`
      ([src/remoteControlService.ts:1252-1264](src/remoteControlService.ts#L1252))
      — проверить, что steer с вложениями не теряет закоммиченные файлы и
      не удаляет их раньше времени.
- [ ] Если решим показывать steer-режим на пульте — добавить флаг в ответ
      `prompt.send` (`{delivered:true, steered:boolean}`); менять формат
      команды **не** нужно. Изменение протокола тянет за собой
      [test/remoteProtocol.test.ts](test/remoteProtocol.test.ts) и
      Kotlin-сторону — делать только если реально нужно.

**Проверка:** через Remote Control отправить промпт во время стрима →
доставлен как steer, ошибки «turn active» нет.

---

## Фаза 6 — Тесты

`test/webviewWiring.test.ts` — это **регекс-тесты по исходнику** `main.mjs`,
а не DOM-тесты. Писать соответственно.

- [ ] `test/webviewWiring.test.ts`:
      - `setWorking` содержит `btnSend.classList.toggle("steer", working)`
        и **не** содержит `btnSend.classList.toggle("hidden", …)`;
      - `promptFailed` гейтит `setWorking(false)` по `m.steer`;
      - `sendPrompt` передаёт `{ steer: working }` в `addUserBubble`;
      - `pendingLocalUser++` в `sendPrompt` на месте (защита от §1.1).
- [ ] Хост-тест на ретрай `AgentBusyError` (Фаза 1).
- [ ] `test/l10n.test.ts` пройдёт сам, если новые ключи добавлены в `ru.json`.
- [ ] DOM-проверка steer-пузыря — только если поднимать вебвью в браузере
      (media/ по http + скелет со стабом `acquireVsCodeApi` + Playwright).
      Опционально, не блокер.
- [ ] Смоук вручную: десктоп (Фаза 2), Android (Фаза 3), Remote (Фаза 5).

---

## Риски

- **Гонка состояния** (§1.4) снимается ретраем из Фазы 1, но не исчезает
  полностью: если omp завершит ход между отказом и ретраем, steer
  выполнится как обычный следующий ход. Это приемлемо.
- **`steeringMode: one-at-a-time`** (§1.10) меняет тайминг доставки —
  индикатор очереди должен показывать `queuedMessageCount`, а не «ушло».
- **Abort** (§1.9) убивает очередь целиком; отдельной отмены steer нет.
- **Дублированная разметка** (§1.7) — главный источник «на десктопе
  работает, на Android нет».
- **Параллельная работа в репозитории**: файлы меняются под тобой,
  правки держать хирургическими, файлы целиком не перегенерировать.
