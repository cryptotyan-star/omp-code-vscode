# OMP Code — план доработок редактора/UX/надёжности

Исполнитель кода: KIMI k3. Каждый пункт — отдельный PR, не бандлить.

## Приоритет 0 — фундамент (даёт контекст остальным фичам)

### 1. Контекст из редактора → композер
- Сейчас: чат не видит `activeTextEditor`/selection вообще.
- Команда `editor/context` → `ompcode.addSelectionToChat`: берёт `vscode.window.activeTextEditor.selection`, формирует attachment `{file, startLine, endLine, text}`, шлёт в webview как `postMessage({t:"attachContext", ...})`. Композер рендерит чип-вложение (паттерн уже есть в `src/attachments.ts` — расширить, не с нуля).
- Плюс live-чип активного файла: подписка на `onDidChangeActiveTextEditor` в `src/chatViewProvider.ts`, пушить в webview, рендерить над input (как в Claude Code).
- Файлы: `package.json` (`menus.editor/context`), `src/attachments.ts`, `src/chatViewProvider.ts`, `media/main.mjs`, `media/main.css`.
- Effort: M.

### 2. @-упоминания файлов
- Slash-попап уже есть (`slashVisible/slashItems/renderSlash`, `media/main.mjs:1540+`) — @-автодополнение делать по тому же паттерну, отдельный триггер-символ `@`.
- Список файлов — `vscode.workspace.findFiles`, дебаунс, шлётся в webview как список кандидатов; выбор → вставка относительного пути (`vscode.workspace.asRelativePath`).
- Зависит от (1) — использует тот же attachment-формат для контекста, но по имени, не по selection.
- Effort: M.

## Приоритет 1 — дешёвые точечные правки

### 3. Keybindings
- Сейчас: `package.json` вообще без секции `contributes.keybindings` (grep пустой).
- Добавить: `ctrl+alt+o` → `ompcode.openChat`, `ctrl+alt+n` → `ompcode.newSession` (команда уже есть в `package.json:57`).
- Effort: S.

### 4. История промптов по ↑
- Сейчас: `ArrowUp` в `media/main.mjs:1550` обрабатывает только навигацию slash-попапа, в пустом input ничего не делает.
- В keydown-хендлере: если `slashVisible()` — старое поведение; иначе если input пуст/курсор в начале — листать массив `promptHistory` (in-memory per-session, опционально `context.workspaceState` для персистентности между сессиями).
- Effort: S.

### 5. Status bar item
- `vscode.window.createStatusBarItem`, текст `model.name` + `ctx %` (данные уже в state, `media/main.mjs:1654` `state.contextUsage` — переиспользовать тот же паттерн на стороне extension через сообщение из webview или дублировать вычисление в `src/ompSession.ts`). Клик → `ompcode.openChat`.
- Effort: S.

## Приоритет 2 — цикл "правка → фидбек"

### 6. Open diff на tool-карточках
- Сейчас: `tool_execution_end` (`media/main.mjs:1740`) просто красит карточку и льёт текст результата, диффа нет.
- До вызова edit/write-тула снапшотить контент через `git show HEAD:<path>` (или прочитанное до-состояние из RPC-фрейма, если оно там есть — проверить `f.result` shape для этих тулов в `SPEC.md`). Кнопка "Open diff" на карточке → `vscode.commands.executeCommand("vscode.diff", uriBefore, uriAfter)`, `uriBefore` — временный документ через `vscode.workspace.openTextDocument({content})`.
- Effort: M — главный риск: откуда брать "до"-контент, если RPC его не отдаёт (нужно проверить протокол omp).

### 7. Insert at cursor
- В `media/markdown.mjs` рядом с существующей кнопкой Copy у `pre.code` добавить вторую кнопку → `postMessage({t:"insertAtCursor", text})` → в extension `activeTextEditor.edit(eb => eb.insert(selection.active, text))`.
- Effort: S. Независим от остального, можно делать первым если нужен быстрый видимый результат.

### 8. Диагностика после правок
- Отдельная фича от существующего `src/diagnostics.ts` (тот — self-test бинарника, не путать).
- После `tool_execution_end` для edit/write: подождать (debounce ~500ms, LSP нужно время), `vscode.languages.getDiagnostics(uri)`, дельта против snapshot до правки → если новые error/warning — добавить как `notice` в чат (существующий канал `addNotice`, `media/main.mjs` уже умеет).
- Effort: M.

## Приоритет 3 — надёжность

### 9. typecheck в pipeline
- `npm run build` = esbuild, типы не проверяет (дыра подтверждена). Добавить `"typecheck": "tsc --noEmit"` в `package.json` scripts, гонять в CI и опционально pre-commit.
- Effort: S.

### 10. CI workflow
- Нет `.github/workflows/`. Добавить `ci.yml`: `npm ci` → `npm run typecheck` → `npm run build` → `node --test` (тесты уже есть, судя по "62 tests pass" в памяти — найти test runner конфиг в `test/`).
- Effort: S. Зависит от (9).

### 11. Auto-restart с backoff
- Сейчас: `src/ompSession.ts:292` `onExit` только шлёт `proc: exited` → баннер с ручной кнопкой Restart, авто-retry нет.
- Добавить: если exit "грязный" (code≠0, не через явный `stop()`/`dispose()` — нужен флаг `intentionalStop` перед теми вызовами) → один `this.restart()` автоматически, с задержкой (напр. 1s), баннер показывать только если и повторный старт упал.
- Effort: M — нужно аккуратно отличать intentional stop от crash (флаг перед `dispose()`/`stop()` вызовами).

### 12. Multi-root workspace
- Сейчас: `cwd` жёстко = `workspaceFolders?.[0]` в 4 местах (`src/ompSession.ts:226,278,532`). При `workspaceFolders.length > 1` — `vscode.window.showWorkspaceFolderPick()` при создании новой вкладки, сохранить выбор per-panel.
- Effort: M — трогает несколько мест создания сессии, тестировать аккуратно.

## Приоритет 4 — мелочи/полировка

### 13. Экспорт транскрипта
- Команда + кнопка в ⚙-меню, сериализовать текущий session JSONL (формат уже описан в памяти "OMP session JSONL format") → .md через существующий рендер сообщений.
- Effort: S.

### 14. Уведомление о завершении
- `vscode.window.state.focused`, если false и `agent_end` пришёл спустя >N сек с последнего `agent_start` → `showInformationMessage`.
- Effort: S.

### 15. Token/cost футер
- RPC `get_session_stats` (`{id, type:"get_session_stats"}`, `SPEC.md:67`) **существует в протоколе, но нигде не вызывается** (grep пустой) — это не с нуля, а первое реальное подключение. Дёрнуть после `turn_end`, рендерить рядом с уже существующим `ctx-chip` (`media/main.mjs:1654`).
- Effort: M — сначала проверить реальный shape ответа у omp CLI, в SPEC он не расписан подробно.

### 16. Полнотекстовый поиск в history
- History-модалка уже есть и рабочая (`media/main.mjs:725+`, `src/sessions.ts`), просто список без фильтра. Добавить `<input>` над `historyList`, client-side filter по title/preview уже загруженных сессий.
- Effort: S.

### 17. Resume last session
- Настройка в `package.json` `contributes.configuration`, при активации если true → `revealTab()` последней сессии из `listSessions()` вместо пустого чата.
- Effort: S.

### 18. i18n
- Самое дорогое и низкий приоритет, отдельно от остального рефакторить весь `main.mjs`/HTML под `vscode-nls` или свой словарь.
- Effort: L. Ставь в конец или отдельный трек.

## Провайдеры моделей (независимый трек, можно параллельно с остальным)

Сейчас в extension built-in только 2 провайдера с ключом через UI: Anthropic и Kimi/Moonshot. Паттерн: константа secret-ключа (`src/ompSession.ts:29-30`), инъекция env-переменной в `launch()` (`src/ompSession.ts:251-259`), команда `ompcode.set*Key` в `package.json`, поле в settings-форме (`media/main.mjs:706-707`), запись в `keyStatus` (`main.mjs:651`, `2034-2035`), обработчики `setKeys`/`clearKey`/`pushKeyStatus` в `src/ompSession.ts:700-760, 1424-1425`.

Отдельно уже существует другой механизм — custom OpenAI-совместимый провайдер через конфиг (пример `akemi` в `SPEC.md:39`: `{"baseUrl","api":"openai-completions","apiKey","models":[...]}`), без UI-ключей, руками в конфиге.

### 19. Рефакторинг под N провайдеров (делать первым, блокирует 20 и 21)
- Текущий код жёстко на 2 провайдера: бинарный тернарник `msg.which === "anthropic" ? ANTHROPIC_KEY_SECRET : MOONSHOT_KEY_SECRET` (`src/ompSession.ts:747`), `keyStatus = {anthropic, moonshot}` (`main.mjs:651`), захардкоженные поля формы (`main.mjs:706-707`). Каждый новый провайдер поверх этого — copy-paste багов.
- Обобщить на таблицу `[{id, secretKey, envVar, label}]` в одном месте (`src/ompSession.ts:1424-1425` уже похожа на такую таблицу для providers-списка логина — унифицировать с ней), `keyStatus` и форма рендерятся из неё циклом.
- Effort: S, но делать один раз перед 20/21, не после.

### 20. GLM 5.2 через API (Zhipu BigModel)
- Сначала проверить: есть ли у omp CLI (`pi-coding-agent`) нативный provider id под Zhipu/GLM (как `anthropic`/`moonshot`), или доступ только через custom `openai`-совместимый provider config (`baseUrl: https://open.bigmodel.cn/api/paas/v4`, `api: "openai-completions"`, ключ `ZHIPU_API_KEY`) — см. связку в глобальном `~/.claude/CLAUDE.md` (там она для другого CLI — `qwen-code`/`glm` алиас, — но baseUrl и envKey те же, провайдер тот же Zhipu).
- Если нативный provider id есть — копировать паттерн Anthropic/Kimi поверх таблицы из (19): секрет `GLM_KEY_SECRET`, env `ZHIPU_API_KEY`, команда `ompcode.setGlmKey`, строка в таблице провайдеров.
- Если нативного нет — заводить через custom-provider config, тогда это не про secret-storage-UI, а про UI-редактор для `modelProviders` (более крупная фича, отдельно оценить).
- Effort: M (нативный путь) / L (нужен custom-provider UI).

### 21. Qwen 3.8 через API (DashScope)
- DashScope уже всплывал в этом проекте раньше (память: "DashScope override preventing Claude/Kimi model selection", сессия Aug 17) — похоже, native provider в omp CLI уже есть, просто раньше конфликтовал при выборе модели. Перепроверить актуальный provider id (`dashscope`? `qwen`?) и env var (`DASHSCOPE_API_KEY`?) в текущей версии omp CLI перед реализацией — не полагаться на старую память вслепую.
- Если подтверждено — тот же паттерн поверх (19): секрет `QWEN_KEY_SECRET`, env var, команда `ompcode.setQwenKey`, строка в таблице провайдеров.
- Effort: S–M, вероятно дешевле (20) — раз DashScope уже был знаком omp раньше.

## Порядок для KIMI

1 → 2 (фундамент context), затем 3, 4, 5, 7 (дешёвые независимые), затем 6, 8 (diff + diagnostics feedback loop), затем 9 → 10 (CI, разблокирует безопасный рефакторинг остального), затем 11, 12 (надёжность), затем 13, 14, 15, 16, 17, и 18 последним/отдельным треком.

19 → 20/21 (провайдеры) не зависят от остального — можно параллельно с (1)/(2) с самого начала, если есть отдельная пара рук.

## Профили моделей — режим работы и доступ под каждое семейство (пункты 22-28)

Цель: при выборе модели агент ведёт себя так, как ведёт себя её родной харнесс — Claude как Claude Code, GLM как ZCode, Qwen как Qwen Code, Kimi как Kimi Code. Включая режим доступа (approval).

### Граница: что omp УЖЕ делает сам — НЕ дублировать

omp резолвит по `provider`/`baseUrl` автоматически, до того как расширение что-либо скажет. Всё перечисленное **запрещено** тащить в профили:

- **Диалект thinking на проводе** — `thinkingFormat: zai | kimi | qwen | qwen-chat-template | openai | openrouter`. GLM/Z.ai → `thinking:{type:"enabled"|"disabled"}`, Qwen → `enable_thinking` bool, Kimi native → свой, Claude → adaptive + `output_config.effort`.
- **Лестницы усилий (efforts)** — они разные не только по семействам, но и по хостам. GLM-5.2 на zai/zhipu = `[high, max]`, на OpenRouter = `[minimal..xhigh]`. Qwen3.7-plus = `[minimal, low, medium, high]`, qwen3.8-max = `[low, medium, xhigh]` c `defaultLevel: xhigh`. Kimi K3 = `[max]` + `requiresEffort`. omp клампит уровень к реальной лестнице сам.
- **Watchdog-таймауты стрима** — GLM coding-plan и `alibaba-coding-plan` = 600s idle, Kimi K2.6/K2.7/K3 = 300s.
- **Диалект схемы инструментов** — `moonshot-mfjs` для Kimi-семейства на любом хосте (схлопывание `const`→`enum`, вырезание неподдерживаемых валидаторов).
- **Склейка system-сообщений** — Qwen 3.5+ падает на нескольких leading system-блоках; omp коалесцирует автоматически. Роль `developer` — только OpenAI/Azure.
- **Форма tool-result / assistant-хода** — `requiresReasoningContentForToolCalls` для Kimi, `alwaysSendMaxTokens` для Moonshot (TPM считается по max_tokens), `disableReasoningOnForcedToolChoice` для Kimi (кроме K3) и Anthropic.
- **`streamMarkupHealingPattern`** — `kimi` для kimi-code/moonshot и любого `kimi-k2` id.

Профиль несёт **только политику** — то, что omp не может знать: сколько автономии дать, какой файл инструкций читать, какой уровень thinking предпочесть в рамках уже посчитанной лестницы.

### Что достижимо и что нет

Достижимо: thinking-уровень, approval-режим, пер-инструментный доступ, файл инструкций, temperature/compaction/personality через config-overlay, роли моделей (main/task/plan).

**Не достижимо честно:** у omp ровно три ступени approval (`always-ask | write | yolo`), а у родных харнессов их 4-6 (у Claude Code — `plan`, `acceptEdits`, `dontAsk`; у Qwen — классификаторный `auto`). Точного соответствия нет — только округление вниз до ближайшей ступени. Это надо написать в UI, а не делать вид, что режимы эквивалентны.

---

### 22. ⚠️ Починить approval — блокер, делать первым

**Сейчас управление доступом сломано во всех трёх положениях.** Проверено чтением исходников:

- `ompcode.approvalMode` дефолт `"always-ask"`, описание «Ask before every tool execution».
- [ompProcess.ts:97](src/ompProcess.ts#L97) передаёт `--approval-mode` **только если значение ≠ `always-ask`** → при дефолте не передаётся ничего.
- Собственный дефолт omp — **`yolo`** (`settings-schema.ts:3681`), все чтения написаны как `settings.get("tools.approvalMode") ?? "yolo"`.
- На чистой машине нет ни `~/.omp/agent/config.yml`, ни `settings.json`, таблица `settings` в `agent.db` пуста — переопределить нечему.

⇒ **Расширение сейчас работает в yolo: чтение, запись и shell-команды одобряются автоматически, хотя настройка говорит обратное.**

Положение `write` не лучше: exec-инструменты получают политику `prompt`, rpc-ui регистрирует UI-контекст с `hasUI = true` (`rpc-mode.ts:932`), omp шлёт хосту `extension_ui_request {method:"select"}`, а [ompSession.ts:427-445](src/ompSession.ts#L427) обрабатывает только `open_url` и `setTitle`. Ответ не отправляется никогда; таймаут в `requestRpcDialog` ставится только при явном `opts.timeout`, которого вызов одобрения не передаёт → **зависание навсегда**.

Что делать:
1. Всегда передавать `--approval-mode` явно, включая `always-ask` — убрать условие в [ompProcess.ts:97](src/ompProcess.ts#L97). Молчание = yolo, это недопустимо.
2. Добавить ветки `select` / `confirm` / `input` в обработчик `extension_ui_request` ([ompSession.ts:427](src/ompSession.ts#L427)) и отвечать через `extension_ui_response` (fire-and-forget уже есть, `ompProcess.ts:179`).
3. Карточка одобрения в вебвью: имя инструмента, аргументы, кнопки Approve/Deny. Рендерить в потоке чата рядом с tool-карточкой.
4. Deny → отправить ответ с отказом, чтобы omp бросил `Tool call denied by user`, а не висел.
5. Дефолт сменить на `write` (чтение+запись авто, exec спрашивает) — честный компромисс между работоспособностью и безопасностью.
- Effort: M. **Без этого пункт 26 (доступ под модель) построить не на чем.**

### 23. Тёплый рестарт — сохранить диалог при смене spawn-параметров

**Сейчас:** [ompSession.ts:196-223](src/ompSession.ts#L196) убивает процесс и поднимает новый **без аргумента возобновления** — omp стартует чистую сессию. При этом `{t:"reset"}` в вебвью не шлётся, поэтому UI продолжает показывать переписку, которую агент уже забыл. Рассинхрон.

`RpcSessionState` несёт `sessionFile?: string` (`rpc-types.ts:107`), а RPC-метод `switch_session` уже используется расширением ([ompSession.ts:1327](src/ompSession.ts#L1327)).

Что делать: перед рестартом запомнить `state.sessionFile`; после `ready` вызвать `switch_session` с ним и перерисовать транскрипт. Если `sessionFile` отсутствует (поле опциональное) — честно послать `{t:"reset"}` в вебвью, а не делать вид, что контекст цел.
- Effort: M. Предпосылка для любого профильного поля spawn-уровня.

### 24. Таблица профилей + резолвер (MVP)

Новый файл `src/modelProfiles.ts` по образцу существующего `KEYED_PROVIDERS` ([providers.ts:27](src/providers.ts#L27)).

```ts
export type ThinkingSelector =
  | "auto" | "inherit" | "off"
  | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type ApprovalMode = "always-ask" | "write" | "yolo";

/** Предикаты ANDятся. Вес специфичности: id=4, provider=2, host=1. */
export interface ProfileMatch {
  id?: RegExp;                    // по «голому» id, без префикса provider/
  provider?: readonly string[];   // точные provider id из omp
  host?: readonly string[];       // подстроки Model.baseUrl (lowercase)
}

export interface ModelProfile {
  family: string;
  match: ProfileMatch;
  contextFile?: string;           // см. 25 — spawn, рестарт
  note?: string;                  // текст для инспектора профиля

  /** RPC, применяется на model_changed. БЕЗ рестарта. */
  runtime?: {
    thinking?: ThinkingSelector;             // set_thinking_level
    steeringMode?: "all" | "one-at-a-time";  // set_steering_mode
    interruptMode?: "immediate" | "wait";    // set_interrupt_mode
  };

  /** CLI-флаги. Смена значения ⇒ тёплый рестарт (23). */
  spawn?: {
    approvalMode?: ApprovalMode;             // --approval-mode
    appendSystemPrompt?: string;             // --append-system-prompt, ТОЛЬКО файлом (см. ниже)
    overlay?: Record<string, unknown>;       // → YAML, передаётся как --config <file>
  };
}
```

Резолв: матчим против живого объекта `Model`, который omp уже отдаёт в `get_available_models`/`get_state` (несёт `provider`, `id`, `baseUrl`). Слои снизу вверх: `BASE_PROFILE` → встроенные строки по возрастанию веса → пользовательские из `ompcode.modelProfiles` → sticky-переопределение в `globalState` для конкретной модели. Ничьи разрешаются порядком в массиве, первая строка выигрывает.

Хук — на кадре `model_changed` ([ompSession.ts:424](src/ompSession.ts#L424)): он ловит и пикер, и `ompcode.defaultModel` при инициализации, и `/model` из композера. Резолвим профиль, считаем `spawnSignature`; совпала с текущей — только RPC-вызовы, не совпала — тёплый рестарт.

⚠️ **`--append-system-prompt` нельзя передавать однострочным текстом.** `resolvePromptInput` (`system-prompt.ts:317-328`) сначала пробует открыть значение **как путь к файлу** и только при ENOENT трактует как литерал. Всегда писать текст в файл под `globalStorageUri` и передавать путь.
- Effort: M.

### 25. Встроенные профили четырёх семейств

Значения — из родных дефолтов харнессов, округление approval **вниз** до ближайшей ступени omp, никогда вверх.

```ts
export const MODEL_PROFILES: readonly ModelProfile[] = [
  {
    family: "claude",
    match: { id: /claude|opus|sonnet|haiku|fable/i, provider: ["anthropic"] },
    contextFile: "CLAUDE.md",   // Claude Code читает CLAUDE.md и НЕ читает AGENTS.md
    runtime: { thinking: "xhigh" },        // родной дефолт эффорта Claude Code
    spawn: { approvalMode: "write" },      // ≈ acceptEdits; у omp нет классификаторной ступени
    note: "Claude Code интерактивно стартует в auto/acceptEdits; ближайшая ступень omp — write.",
  },
  {
    family: "glm",
    match: { id: /(^|[^a-z])glm[-.]?\d/i, provider: ["zhipu-coding-plan", "zai"] },
    contextFile: "AGENTS.md",              // ZCode; отдельной GLM.md-конвенции не найдено
    runtime: { thinking: "auto" },         // лестница зависит от версии И хоста — уровень не пиннить
    spawn: { approvalMode: "always-ask" }, // ZCode по умолчанию «Confirm Before Changes»
  },
  {
    family: "qwen",
    match: { id: /qwen/i, provider: ["alibaba-coding-plan", "alibaba-token-plan"] },
    contextFile: "QWEN.md",                // Qwen Code читает QWEN.md, затем AGENTS.md
    runtime: { thinking: "inherit" },      // единого литерала нет: 3.7-plus [minimal..high], 3.8-max [low,medium,xhigh]
    spawn: { approvalMode: "write" },      // родной дефолт auto (классификатор) → вниз до write
  },
  {
    family: "kimi",
    match: { id: /kimi|^k[23]$/i, provider: ["moonshot", "kimi-code"] },
    contextFile: "AGENTS.md",              // kimi-code: AGENTS.md, QWEN.md/CLAUDE.md не читает
    runtime: { thinking: "high" },         // [thinking] enabled = true; на K3 omp склампит к max
    spawn: { approvalMode: "always-ask" }, // default_permission_mode = "manual"
  },
];
```

`appendSystemPrompt` во всех встроенных профилях **пустой намеренно**. Из шести обследованных агентов (Claude Code, Cline, Roo, Kilo, OpenCode, Crush) ни один не отдаёт пер-модельный системный промпт; единственный, кто отдаёт — aider — использует его на 53 записях из 357, и каноническое значение там 22 символа. Придуманная пер-семейная проза — самая красиво выглядящая и наименее обоснованная часть фичи. Слот есть, чтобы пользователь написал своё; мы не пишем ничего.
- Effort: M.

### 26. Пер-инструментный доступ — настоящий рычаг «доступа под модель»

У omp есть запись `tools.approval` со значениями `allow | deny | prompt`, которая действует **во всех** режимах: `deny` побеждает даже под yolo. Это то, чем реально выражается «разный доступ под разные модели», а трёхступенчатый `--approval-mode` — слишком грубый инструмент.

Кладётся в `spawn.overlay` → генерируемый YAML → `--config <file>` (флаг подтверждён, `flag-tables.ts:117`).

```ts
spawn: {
  overlay: {
    "tools.approval": { bash: "prompt", write: "allow", read: "allow" },
  },
}
```

Практический смысл: сильной модели можно дать `bash: allow`, менее предсказуемой — `bash: prompt` при том же общем режиме. Зависит от 22 (иначе `prompt` = зависание).
- Effort: S поверх 24 и 22.

### 27. Файлы инструкций под семейство

omp сам обнаруживает `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`. `QWEN.md` и `.kimi-code/AGENTS.md` его дискавери-провайдеры не видят — расширение читает их из воркспейса и подмешивает через `--append-system-prompt` (файлом, см. предупреждение в 24).

Второй нюанс: у провайдеров инструкций есть приоритеты, и `CLAUDE.md` (80) перекрывает голый `AGENTS.md` (10). Для не-Claude семейств claude-провайдер надо гасить через `overlay.disabledProviders: ["claude"]`, иначе GLM/Qwen/Kimi будут читать чужой CLAUDE.md.
- Effort: M.

### 28. UI: бейдж семейства и инспектор профиля

Чип рядом с моделью — какое семейство и какой режим доступа сейчас действует. Клик → карточка: какие поля откуда взялись (base / встроенное / пользовательское / sticky), кнопка сбросить sticky. Плюс баннер, когда approval-режим — округление вниз от родного (см. «не достижимо честно» выше).
- Effort: S.

### Не делать

- ❌ Не переопределять `thinkingFormat`, `reasoningEffortMap`, лестницы эффортов, watchdog-таймауты, диалект схемы инструментов, склейку system-сообщений — всё это omp резолвит сам и точнее.
- ❌ Не пиннить конкретный уровень thinking там, где лестница зависит от хоста (GLM, Qwen) — использовать `auto`/`inherit` и дать omp склампить.
- ❌ Не рестартовать агента там, где хватает RPC. `set_model`, `set_thinking_level`, `set_steering_mode`, `set_interrupt_mode` — живые, без рестарта.
- ❌ Не передавать `--append-system-prompt` строкой без переводов строк — omp попробует открыть её как файл.
- ❌ Не писать пер-семейный системный промпт «для красоты».
- ❌ Не заводить `modelsYml`-патчи для нативных провайдеров (`anthropic`, `zhipu-coding-plan`, `alibaba-coding-plan`, `moonshot`, `kimi-code`) — там каталог всё уже посчитал. Патч оправдан только для рукописного custom-провайдера на нераспознанном хосте.

### Риски и открытые вопросы

- **Кастомный провайдер теряет часть авто-настроек.** Замерено: `dashscope` на `coding-intl.dashscope.aliyuncs.com` даёт compat, идентичный нативному `alibaba-coding-plan`, **кроме** `streamIdleTimeoutMs` (нативный ставит 600s) и `whenThinking`. Потеря `whenThinking` на `qwen3.8-max` означает, что `reasoning_effort` не отправляется вообще. Контрпример: кастомный `glm` на `open.bigmodel.cn` не теряет практически ничего. Вывод: чинить точечно и только по замеру, не превентивно.
- **На нераспознанном хосте (корпоративный прокси) у GLM разом переключаются шесть параметров провода** — `thinkingFormat` zai→openai и далее. Если у команды прокси — это надо проверять отдельно.
- **`sessionFile` — опциональное поле** (`rpc-types.ts:107`). Тёплый рестарт (23) обязан иметь честный путь отката, когда его нет.
- **Не проверено:** приоритет ZCode `AGENTS.md` подтверждён вторичным источником, не первоисточником z.ai. Дефолт approval у kimi-code (`manual`) взят из доков репозитория, вживую не воспроизводился.
- **Не проверено эмпирически:** весь пункт 22 установлен чтением исходников omp и расширения, без запуска агента с реальным вызовом bash. Перед правкой стоит воспроизвести один раз вживую.

### Порядок для этого блока

22 (блокер, безопасность) → 23 (тёплый рестарт) → 24 (таблица+резолвер) → 25 (встроенные профили) → 26 (пер-инструментный доступ) → 27 (файлы инструкций) → 28 (UI).

Блок независим от пунктов 1-18, но 26 бессмысленен без 22, а 25/26/27 — без 24.
