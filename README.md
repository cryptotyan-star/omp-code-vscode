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

2. Install the extension (`.vsix`) / Установите расширение (`.vsix`):

   ```bash
   npm install && npm run build && npm run package
   code --install-extension omp-code-0.1.0.vsix
   ```

## Anthropic API key / Ключ Anthropic

Run the command **OMP Code: Set Anthropic API Key** from the Command Palette (`Cmd+Shift+P`). The key is stored in VS Code Secret Storage and passed to `omp` as `ANTHROPIC_API_KEY`.

Выполните команду **OMP Code: Set Anthropic API Key** из палитры команд (`Cmd+Shift+P`). Ключ хранится в Secret Storage VS Code и передаётся `omp` как `ANTHROPIC_API_KEY`.

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
- Commands: **New Chat Tab**, **Restart Agent** (restarts every open session; the agent also restarts automatically when any `ompcode.*` setting changes).

- Нажмите значок ✳ **OMP Code** в панели активности и введите запрос. `Enter` — отправить, `Shift+Enter` — перенос строки, `Esc` — прервать выполнение.
- Кнопка **＋** (в чате или в заголовке панели) открывает новый чат **вкладкой в редакторе** — у каждой вкладки своя независимая сессия агента; закрытие вкладки останавливает её процесс. В меню ⚙ — вход через подписку, API-ключи, compact, рестарт и «Clear this session».
- Введите `/`, чтобы увидеть slash-команды агента.
- Чипы под полем ввода переключают **модель** и **уровень размышлений**; чип контекста показывает заполненность контекста.
- Вызовы инструментов (Bash, правки файлов и т.д.) отображаются сворачиваемыми карточками; запросы на подтверждение — диалогами **Allow / Deny** (см. `ompcode.approvalMode`).
- Команды: **New Chat Tab**, **Restart Agent** (перезапускает все открытые сессии; агент также перезапускается автоматически при изменении любой настройки `ompcode.*`).

## Settings / Настройки

| Setting | Default | Description |
| --- | --- | --- |
| `ompcode.ompPath` | `omp` | Path to the omp binary / путь к бинарнику omp |
| `ompcode.customProviders` | `{}` | Providers merged into models.yml / провайдеры для models.yml |
| `ompcode.defaultModel` | `""` | `provider/modelId` selected on start / модель по умолчанию |
| `ompcode.thinkingLevel` | `auto` | off…max, auto / уровень размышлений |
| `ompcode.approvalMode` | `always-ask` | `always-ask` \| `write` \| `yolo` |
