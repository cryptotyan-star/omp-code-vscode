# OMP Code — установка / Install

## RU

1. **Установите CLI-агент** (нужен, расширение — только GUI поверх него):
   ```bash
   bun install -g @oh-my-pi/pi-coding-agent
   ```
   Если нет `bun`: `curl -fsSL https://bun.sh/install | bash`, затем перезапустите терминал.

2. **Установите расширение — одна кнопка:**
   - Откройте VS Code → вкладка **Extensions** (`Cmd+Shift+X` / `Ctrl+Shift+X`)
   - Кнопка `...` в правом верхнем углу панели → **Install from VSIX...**
   - Выберите `omp-code-0.5.0.vsix` из этой папки
   - Перезапустите VS Code / нажмите **Reload Window**

   Либо из терминала:
   ```bash
   code --install-extension omp-code-0.5.0.vsix
   ```

3. **Войдите / добавьте ключ** — палитра команд (`Cmd+Shift+P`), любое из:
   - `OMP Code: Sign in with Claude (Subscription)` — OAuth, Claude Pro/Max
   - `OMP Code: Sign in with Kimi Code (Subscription)` — OAuth
   - `OMP Code: Set Anthropic API Key`
   - `OMP Code: Set Kimi (Moonshot) API Key`
   - `OMP Code: Set GLM (Zhipu BigModel) API Key` — каталог включает `glm-5.2`
   - `OMP Code: Set Qwen (Alibaba Coding Plan) API Key`

4. Иконка OMP Code в activity bar слева → открыть чат.

**Язык интерфейса.** Чат есть на русском и английском. Настройка `ompcode.language`
(`auto` по умолчанию) не зависит от языка интерфейса VS Code — редактор может
остаться английским, а чат быть русским, Language Pack не нужен. Названия команд
в палитре и описания настроек VS Code читает до загрузки расширения, поэтому они
следуют языку самого редактора.

Полная документация, кастомные провайдеры, все настройки — `README.md` и `SPEC.md` в этом архиве.

Исходники — в `src/`, `media/`; чтобы пересобрать после правок: `npm install && npm run build && npm run package` (нужны Node.js 18+, npm).

---

## EN

1. **Install the CLI agent** (the extension is a GUI on top of it):
   ```bash
   bun install -g @oh-my-pi/pi-coding-agent
   ```
   No `bun`? `curl -fsSL https://bun.sh/install | bash`, then restart your terminal.

2. **Install the extension — one button:**
   - Open VS Code → **Extensions** view (`Cmd+Shift+X` / `Ctrl+Shift+X`)
   - `...` menu (top-right of the panel) → **Install from VSIX...**
   - Pick `omp-code-0.5.0.vsix` from this folder
   - Restart VS Code / click **Reload Window**

   Or from a terminal:
   ```bash
   code --install-extension omp-code-0.5.0.vsix
   ```

3. **Sign in / add a key** — Command Palette (`Cmd+Shift+P`), any of:
   - `OMP Code: Sign in with Claude (Subscription)` — OAuth, Claude Pro/Max
   - `OMP Code: Sign in with Kimi Code (Subscription)` — OAuth
   - `OMP Code: Set Anthropic API Key`
   - `OMP Code: Set Kimi (Moonshot) API Key`
   - `OMP Code: Set GLM (Zhipu BigModel) API Key` — catalog includes `glm-5.2`
   - `OMP Code: Set Qwen (Alibaba Coding Plan) API Key`

4. OMP Code icon in the left activity bar → open the chat.

**Interface language.** The chat ships in English and Russian. `ompcode.language`
(`auto` by default) is separate from the VS Code display language, so an English
editor can hold a Russian chat — no Language Pack needed. Command titles and
setting descriptions are read by VS Code before the extension loads, so those
follow the editor's own language.

Full docs, custom providers, all settings — see `README.md` and `SPEC.md` in this archive.

Source lives in `src/`, `media/`; to rebuild after edits: `npm install && npm run build && npm run package` (needs Node.js 18+, npm).

---

## Платформы / Platforms

Расширение — чистый JavaScript, без нативных модулей и без ограничений `os`/`cpu`
в манифесте, поэтому сам `.vsix` ставится на VS Code под macOS, Linux и Windows.
Нативная часть — только у CLI `omp`, и он публикует сборки под
`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `win32-x64`.

The extension is plain JavaScript with no native modules and no `os`/`cpu`
constraints in its manifest, so the `.vsix` installs on VS Code under macOS,
Linux and Windows. Only the `omp` CLI has native parts, and it ships builds for
`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `win32-x64`.

**Windows ARM (Surface Pro X и подобные) не поддерживается** — сборки
`win32-arm64` у omp нет. / **Windows on ARM is not supported** — omp publishes no
`win32-arm64` build.

### Если на Windows расширение не находит `omp`

С версии 0.5.0 расширение само разбирается с обёртками, которые глобальная
установка может оставить вместо `omp.exe`: путь ищется так же, как это делает
Windows (`PATH` × `PATHEXT`), а `.cmd`/`.bat` запускается через `cmd.exe`.
Отдельно настраивать ничего не нужно.

Если запуск всё равно падает, укажите путь вручную: `Settings` → найдите
`ompcode.ompPath` → полный путь, например
`C:\Users\<имя>\.bun\bin\omp.exe`.

Что именно видит расширение, покажет палитра команд → **OMP Code: Run Diagnostics**:
путь из настройки, найденный лаунчер, вывод `omp --version` и какие ключи подхвачены.

Известное ограничение: `.ps1`-обёртку запустить нельзя — расширение скажет об
этом прямо и попросит указать соседний `.cmd` или `.exe`.

### If the extension cannot find `omp` on Windows

Since 0.5.0 the extension handles the wrappers a global install can leave
behind instead of `omp.exe`: it resolves the path the way Windows does
(`PATH` × `PATHEXT`) and starts a `.cmd`/`.bat` through `cmd.exe`. Nothing
needs configuring.

If the launch still fails, set the path by hand: `Settings` → search
`ompcode.ompPath` → full path, e.g. `C:\Users\<name>\.bun\bin\omp.exe`.

To see what the extension actually finds: Command Palette →
**OMP Code: Run Diagnostics** — it reports the configured path, the resolved
launcher, `omp --version` output and which API keys were picked up.

Known limit: a `.ps1` wrapper cannot be started — the extension says so and
asks you to point at the `.cmd` or `.exe` next to it.
