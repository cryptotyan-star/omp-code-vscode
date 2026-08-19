# OMP Code

Claude Code-style chat in the VS Code sidebar, powered by the [`omp`](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent) (oh-my-pi) coding agent over RPC. Works with the Anthropic Cloud API and any custom OpenAI-compatible provider.

Чат в стиле Claude Code в боковой панели VS Code поверх CLI-агента `omp` (oh-my-pi). Поддерживает Anthropic Cloud API и любые кастомные OpenAI-совместимые провайдеры.

---

## Install / Установка

1. Install the `omp` CLI / Установите CLI `omp`:

   ```bash
   bun install -g @oh-my-pi/pi-coding-agent
   ```

   The extension looks for `omp` in `PATH` (`~/.bun/bin` is added automatically). A custom binary path can be set via the `ompcode.ompPath` setting.

   Расширение ищет `omp` в `PATH` (`~/.bun/bin` добавляется автоматически). Свой путь к бинарнику — настройка `ompcode.ompPath`.

   On Windows a `.cmd` shim is started through `cmd.exe` automatically; point `ompcode.ompPath` at `omp.exe` or `omp.cmd` if the install is somewhere off `PATH`. Windows ARM is not supported — omp has no build for it.

   На Windows `.cmd`-обёртка запускается через `cmd.exe` автоматически; если установка лежит вне `PATH`, укажите `ompcode.ompPath` на `omp.exe` или `omp.cmd`. Windows ARM не поддерживается — сборки omp под него нет.

2. Install the extension (`.vsix`) / Установите расширение (`.vsix`):

   ```bash
   npm install && npm run build && npm run package
   code --install-extension omp-code-0.1.0.vsix
   ```

## Sign in / Вход

Two ways to authenticate / два способа аутентификации:

1. **Subscription (Claude Pro/Max or Kimi Code)** — run **OMP Code: Sign in with Claude (Subscription)** or **OMP Code: Sign in with Kimi Code (Subscription)** from the Command Palette. A browser opens for OAuth; the agent restarts when login completes.

2. **API keys** — stored in VS Code Secret Storage, never written to plaintext config:
   - **OMP Code: Set Anthropic API Key** → passed to `omp` as `ANTHROPIC_API_KEY`.
   - **OMP Code: Set Kimi (Moonshot) API Key** → passed as `MOONSHOT_API_KEY`.
   - **OMP Code: Set GLM (Zhipu BigModel) API Key** → passed as `ZHIPU_API_KEY` (native `zhipu-coding-plan` provider, GLM catalog incl. `glm-5.2`).
   - **OMP Code: Set Qwen (Alibaba Coding Plan) API Key** → passed as `ALIBABA_CODING_PLAN_API_KEY` (native `alibaba-coding-plan` provider, Qwen catalog). Plain DashScope pay-as-you-go keys go through a custom provider instead (below).
   - **OMP Code: Set Custom Provider API Key** → injects an `apiKey` into a `customProviders` entry at agent start (the settings.json value is used as a fallback).

1. **Подписка (Claude Pro/Max или Kimi Code)** — выполните **OMP Code: Sign in with Claude (Subscription)** или **OMP Code: Sign in with Kimi Code (Subscription)** из палитры команд. Откроется браузер для OAuth; после входа агент перезапустится.

2. **API-ключи** — хранятся в Secret Storage VS Code, не попадают в конфиг в открытом виде:
   - **OMP Code: Set Anthropic API Key** → передаётся `omp` как `ANTHROPIC_API_KEY`.
   - **OMP Code: Set Kimi (Moonshot) API Key** → передаётся как `MOONSHOT_API_KEY`.
   - **OMP Code: Set GLM (Zhipu BigModel) API Key** → передаётся как `ZHIPU_API_KEY` (нативный провайдер `zhipu-coding-plan`, каталог GLM включая `glm-5.2`).
   - **OMP Code: Set Qwen (Alibaba Coding Plan) API Key** → передаётся как `ALIBABA_CODING_PLAN_API_KEY` (нативный провайдер `alibaba-coding-plan`, каталог Qwen). Обычный DashScope-ключ (pay-as-you-go) подключается через кастомного провайдера (ниже).
   - **OMP Code: Set Custom Provider API Key** → вливает `apiKey` в запись `customProviders` при старте агента (значение из settings.json используется как fallback).

## Custom providers / Кастомные провайдеры

Add providers in `settings.json` under `ompcode.customProviders` — same shape as the `providers:` map in `~/.omp/agent/models.yml`. They are merged into `models.yml` before each agent start (existing entries are never deleted).

Провайдеры задаются в `settings.json` в `ompcode.customProviders` — та же структура, что и `providers:` в `~/.omp/agent/models.yml`. Перед каждым стартом агента они вливаются в `models.yml` (существующие записи не удаляются).

```jsonc
{
  "ompcode.customProviders": {
    "akemi": {
      "baseUrl": "http://host:8000/v1",
      "api": "openai-completions",
      "apiKey": "sk-...",
      "models": [
        {
          "id": "akemi-1",
          "name": "Akemi",
          "contextWindow": 128000,
          "maxTokens": 32000
        }
      ]
    }
  },
  "ompcode.defaultModel": "akemi/akemi-1"
}
```

You can also edit `models.yml` directly: **OMP Code: Open models.yml (Custom Providers)**.

Файл `models.yml` можно править и напрямую: **OMP Code: Open models.yml (Custom Providers)**.

## Usage / Использование

- Click the ✳ **OMP Code** icon in the Activity Bar and type a prompt. `Enter` sends, `Shift+Enter` inserts a newline, `Esc` interrupts a running turn.
- The **＋** button (topbar or view title) opens a new chat as its own **editor tab** — each tab runs an independent agent session and is closed/killed with the tab. The ⚙ menu has sign-in, API keys, compact, restart and "Clear this session".
- Type `/` to see the agent's slash commands.
- The chips under the input switch the **model** and the **thinking level**; the context chip shows context usage.
- Tool calls (Bash, file edits, etc.) render as collapsible cards; approval requests appear as **Allow / Deny** dialogs (see `ompcode.approvalMode`).
- **Attach files** three ways: the 📎 button in the composer, `Ctrl/Cmd+V` with a file on the clipboard, or dragging files onto the panel **while holding Shift** (VS Code only forwards a drop into a webview with Shift held). Attachments show as chips above the input and are sent to the agent as absolute paths, so nothing is pasted into the context window. Files without a path of their own (clipboard screenshots, Finder drags) are copied into the extension's storage first; anything above 20 MB is rejected.
- The palette is set by `ompcode.theme` (violet, coral, emerald, amber, magenta) and can be overridden with any CSS color via `ompcode.accentColor`. Both apply instantly, without restarting the agent.
- Commands: **New Chat Tab**, **Restart Agent** (restarts every open session; the agent also restarts automatically when any `ompcode.*` setting changes).
- **Editor → chat**: select code and run **OMP Code: Add Selection to Chat** (editor context menu, `Ctrl/Cmd+Alt+L`) — the selection lands as a chip (`file.ts:10-25`) and is inlined into the prompt with its line range. A ghost chip in the composer always shows the active editor file.
- **@-mentions**: type `@` in the composer to autocomplete workspace files; picking one attaches it as a chip with a validated absolute path.
- **Keyboard shortcuts**: `Ctrl/Cmd+Alt+O` open chat, `Ctrl/Cmd+Alt+N` new chat tab, `Ctrl/Cmd+Alt+L` add selection to chat. `↑` at the start of an empty composer recalls previously sent prompts (shell-style).
- **Edit feedback loop**: after an edit/write tool runs, its card gets a **diff** button (before ↔ current, via `vscode.diff`), and new language-server diagnostics surface as a warning notice.
- **Code blocks** carry two buttons: **copy** and **insert** (at the editor cursor).
- **Status bar** shows the current model and context fill; click opens the chat. After each run a chip shows session tokens/cost (`↑in ↓out $cost`).
- **Crash recovery**: a crashed agent is auto-restarted once after 1 s; the manual Restart banner appears only if that fails (missing keys/models skip auto-restart and show the setup card).
- **Multi-root workspaces**: opening a new chat tab asks which folder its agent should work in (per-tab cwd).
- **Export**: ⚙ → **Export transcript as Markdown** saves the conversation via `get_messages`.
- **Notifications**: a turn that ran over 15 s while VS Code was unfocused ends with a native notification.
- **History**: the history panel has a filter box matching title, preview, folder and model.

- Нажмите значок ✳ **OMP Code** в панели активности и введите запрос. `Enter` — отправить, `Shift+Enter` — перенос строки, `Esc` — прервать выполнение.
- Кнопка **＋** (в чате или в заголовке панели) открывает новый чат **вкладкой в редакторе** — у каждой вкладки своя независимая сессия агента; закрытие вкладки останавливает её процесс. В меню ⚙ — вход через подписку, API-ключи, compact, рестарт и «Clear this session».
- Введите `/`, чтобы увидеть slash-команды агента.
- Чипы под полем ввода переключают **модель** и **уровень размышлений**; чип контекста показывает заполненность контекста.
- Вызовы инструментов (Bash, правки файлов и т.д.) отображаются сворачиваемыми карточками; запросы на подтверждение — диалогами **Allow / Deny** (см. `ompcode.approvalMode`).
- **Вложения** — тремя способами: кнопка 📎 в поле ввода, `Ctrl/Cmd+V` с файлом в буфере обмена или перетаскивание файлов в панель **с зажатым Shift** (VS Code пробрасывает drop в webview только с Shift). Вложения показываются чипами над полем ввода и передаются агенту абсолютными путями — содержимое не вставляется в контекст. Файлы без собственного пути (скриншот из буфера, перетаскивание из Finder) сначала копируются в хранилище расширения; больше 20 МБ — отклоняются.
- Цветовая гамма задаётся настройкой `ompcode.theme` (violet, coral, emerald, amber, magenta), свой цвет — `ompcode.accentColor`. Применяется сразу, без перезапуска агента.
- Команды: **New Chat Tab**, **Restart Agent** (перезапускает все открытые сессии; агент также перезапускается автоматически при изменении любой настройки `ompcode.*`).
- **Редактор → чат**: выделите код и выполните **OMP Code: Add Selection to Chat** (контекстное меню редактора, `Ctrl/Cmd+Alt+L`) — выделение станет чипом (`file.ts:10-25`) и попадёт в промпт с диапазоном строк. Призрачный чип в композере всегда показывает активный файл.
- **@-упоминания**: введите `@` в композере — автодополнение файлов workspace; выбор прикрепляет файл чипом с проверенным абсолютным путём.
- **Горячие клавиши**: `Ctrl/Cmd+Alt+O` открыть чат, `Ctrl/Cmd+Alt+N` новая вкладка, `Ctrl/Cmd+Alt+L` выделение в чат. `↑` в начале пустого поля листает отправленные промпты.
- **Фидбек правок**: после edit/write-инструмента на карточке появляется кнопка **diff** (до ↔ после через `vscode.diff`), а новые диагностики языкового сервера показываются предупреждением.
- **Блоки кода** имеют кнопки **copy** и **insert** (в позицию курсора редактора).
- **Статус-бар** показывает модель и заполнение контекста; клик открывает чат. После каждого прогона чип показывает токены/стоимость сессии (`↑in ↓out $cost`).
- **Восстановление после сбоя**: упавший агент перезапускается автоматически один раз через 1 с; баннер с ручным Restart — только если не помогло (при отсутствии ключей/моделей авто-рестарт пропускается).
- **Multi-root**: при открытии новой вкладки чата спрашивает, в какой папке работать её агенту (cwd на вкладку).
- **Экспорт**: ⚙ → **Export transcript as Markdown** сохраняет диалог через `get_messages`.
- **Уведомления**: ход длиннее 15 с при нефокусированном окне завершается нативным уведомлением.
- **История**: в панели истории есть фильтр по названию, превью, папке и модели.

### Language / Язык

The chat interface ships in English and Russian. `ompcode.language` (`auto` by default) is separate from the VS Code display language, so an English editor can hold a Russian chat — no Language Pack needed. Command titles and setting descriptions are read by VS Code before the extension loads, so those follow the editor's own language.

Интерфейс чата есть на английском и русском. Настройка `ompcode.language` (по умолчанию `auto`) не зависит от языка интерфейса VS Code — редактор может остаться английским, а чат быть русским, Language Pack не нужен. Названия команд и описания настроек VS Code читает до загрузки расширения, поэтому они следуют языку самого редактора.

## Settings / Настройки

| Setting | Default | Description |
| --- | --- | --- |
| `ompcode.ompPath` | `omp` | Path to the omp binary / путь к бинарнику omp |
| `ompcode.language` | `auto` | Chat interface language / язык интерфейса чата: `auto`, `en`, `ru` |
| `ompcode.customProviders` | `{}` | Providers merged into models.yml / провайдеры для models.yml |
| `ompcode.defaultModel` | `""` | `provider/modelId` selected on start / модель по умолчанию |
| `ompcode.thinkingLevel` | `auto` | off…max, auto / уровень размышлений |
| `ompcode.approvalMode` | `always-ask` | `always-ask` \| `write` \| `yolo` |
| `ompcode.theme` | `violet` | Accent palette / цветовая гамма: violet, coral, emerald, amber, magenta |
| `ompcode.accentColor` | `""` | Custom accent CSS color / свой цвет акцента, например `#8B7BF7` |
| `ompcode.resumeLastSession` | `false` | New chats resume the most recent session / новые чаты продолжают последнюю сессию |
