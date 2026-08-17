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

## Порядок для KIMI

1 → 2 (фундамент context), затем 3, 4, 5, 7 (дешёвые независимые), затем 6, 8 (diff + diagnostics feedback loop), затем 9 → 10 (CI, разблокирует безопасный рефакторинг остального), затем 11, 12 (надёжность), затем 13, 14, 15, 16, 17, и 18 последним/отдельным треком.
