# Задача: Phase 3 — терминалы и порты на каждый workspace

Ты — оркестратор. Ты **не пишешь код воркеров сам**. Ты делишь работу, раздаёшь её агентам в отдельных workspace, проверяешь результат и вливаешь. Своими руками ты трогаешь только общие файлы — они перечислены в §6.

Проект: OMP Code, `/Users/ilonapushilina/Desktop/Ohmypi`. Это VS Code расширение (TypeScript strict, esbuild, MIT). Прежде чем раздавать задачи, прочитай `src/workspaces/types.ts`, `src/workspaces/setup.ts`, `src/workspaces/commands.ts`, `src/sessionBoard.ts` — тебе нужно знать, что там уже есть.

---

## 1. Что построить

Каждый workspace — это git worktree, в котором работает свой агент. Сейчас у workspace нет ни своего терминала с историей, ни понимания, какой порт он занял. Нужно:

1. **Терминалы, привязанные к workspace.** Открыть терминал в его worktree; запустить команды `run[]` из `.ompcode/workspace.json`; знать, какие терминалы принадлежат какому workspace, и их pid.
2. **Определение слушающих портов.** Если агент поднял dev-сервер на `:3000`, строка workspace в панели сессий показывает `⇡ 3000`, а клик открывает адрес в браузере.

Зачем: когда параллельно работают три агента, у каждого свой dev-сервер на своём порту, и человек должен видеть, чей именно.

---

## 2. Что уже готово — не переписывать

- `WorkspaceRecord` (`src/workspaces/types.ts`): `id`, `name`, `worktreePath`, `branch`, `repoRoot`, `baseSha`, `model`.
- `WorkspaceConfig.run: string[]` — **уже парсится** из `.ompcode/workspace.json` в `src/workspaces/setup.ts` (функция `readWorkspaceConfig`). Парсер трогать не нужно, нужно только исполнять.
- `src/workspaces/setupRun.ts` — рабочий пример запуска команд в терминале через shell integration с ожиданием кода возврата. Читай его как образец, но **не изменяй**.
- Команда `ompcode.workspace.openTerminal` (`src/workspaces/commands.ts:142`) существует, но она «выстрелил и забыл»: создаёт терминал и не помнит о нём. Её надо перевести на реестр — это делаешь ты сам (§6), не воркер.

---

## 3. Разбиение работы: три воркера, ни одного общего файла

**Главное правило: два воркера никогда не пишут в один файл.** Ниже границы. Каждому воркеру передай его список дословно, включая запрет на чужие файлы.

### Воркер A — `terminals`
Создаёт: `src/workspaces/terminals.ts`, `test/workspaceTerminals.test.ts`
Читает (менять запрещено): `src/workspaces/types.ts`, `src/workspaces/setup.ts`, `src/workspaces/setupRun.ts`

### Воркер B — `ports`
Создаёт: `src/workspaces/ports.ts`, `test/workspacePorts.test.ts`
Читает (менять запрещено): `src/workspaces/types.ts`

### Воркер C — `contributes`
Изменяет: `package.json`, `package.nls.json`, `package.nls.ru.json`, `l10n/ru.json`
Не трогает вообще: всё в `src/`, `media/`, `test/`

Файлы `src/extension.ts`, `src/sessionBoard.ts`, `src/workspaces/commands.ts` не отдаются никому — их правишь ты сам после мержа (§6).

---

## 4. Контракты — эти сигнатуры обязаны совпасть

Передай их воркерам дословно. A и B пишут независимо, и сойтись они должны без правок.

### `src/workspaces/terminals.ts` (воркер A)

```ts
export interface TerminalManagerDeps {
  output: { appendLine(s: string): void };
}

export class TerminalManager implements vscode.Disposable {
  constructor(deps: TerminalManagerDeps);

  /** Открыть (или показать существующий) терминал workspace в его worktree. */
  open(record: WorkspaceRecord, opts?: { name?: string; show?: boolean }): vscode.Terminal;

  /** Выполнить run[] из .ompcode/workspace.json. supervised=false, если shell integration недоступна. */
  runConfigured(record: WorkspaceRecord): Promise<{ ran: string[]; supervised: boolean; exitCode?: number }>;

  terminalsFor(workspaceId: string): vscode.Terminal[];

  /** pid каждого терминала workspace — корни дерева процессов для сканера портов. */
  rootPids(workspaceId: string): Promise<number[]>;

  /** Открылся или закрылся терминал — сканер портов пересчитывает корни. */
  readonly onDidChange: vscode.Event<string>;   // workspaceId

  dispose(): void;
}
```

Требования: реестр `terminal → workspaceId`; `onDidCloseTerminal` вычищает запись и поднимает событие; `iconPath: new vscode.ThemeIcon("git-branch")`; в env терминала передать `OMPCODE_WORKSPACE_ID` и `OMPCODE_WORKSPACE_PATH`; `dispose()` не убивает пользовательские терминалы, только отписывается.

### `src/workspaces/ports.ts` (воркер B)

```ts
export interface ListeningPort { port: number; pid: number; address: string }

// Чистые парсеры — основная ценность файла, тестируются без запуска процессов:
export function parseLsof(stdout: string): ListeningPort[];
export function parseNetstat(stdout: string): ListeningPort[];        // Windows, netstat -ano
export function parseProcNetTcp(stdout: string, inodeToPid: Map<string, number>): ListeningPort[];  // Linux
export function parsePsTree(stdout: string): Map<number, number>;     // ps -eo pid,ppid  →  pid → ppid
export function descendantsOf(roots: number[], parents: Map<number, number>): number[];

export interface PortScannerDeps {
  workspaceIds(): string[];
  rootPids(workspaceId: string): Promise<number[]>;
  output: { appendLine(s: string): void };
}

export class PortScanner implements vscode.Disposable {
  constructor(deps: PortScannerDeps);
  start(): void;
  stop(): void;
  portsFor(workspaceId: string): ListeningPort[];
  readonly onDidChange: vscode.Event<{ workspaceId: string; ports: ListeningPort[] }>;
  dispose(): void;
}
```

Требования: macOS/Linux — `lsof -a -p <pids> -iTCP -sTCP:LISTEN -P -n`; Linux без lsof — `/proc/net/tcp` + `/proc/<pid>/fd`; Windows — `netstat -ano`. Интервал 2500 мс; если 60 секунд ничего не менялось — переходить на 30000 мс, при изменении возвращаться. Порты 22, 80, 443 игнорировать. Событие поднимать **только когда набор портов изменился**, иначе борд будет перерисовываться каждые 2.5 секунды. Если ни один workspace не открыт — не сканировать вообще.

### Что добавляет воркер C

Команды: `ompcode.workspace.runConfigured` (иконка `$(play)`), `ompcode.workspace.openPort` (иконка `$(globe)`).
Меню `view/item/context` для обеих: `view == ompcode.sessions && viewItem =~ /^workspace-/`.
Настройки:
- `ompcode.portScan` — boolean, default `true`;
- `ompcode.portScanIgnore` — array of number, default `[22, 80, 443]`.
Все строки — через `%ключ%` в обоих `package.nls*.json`. В `l10n/ru.json` добавить переводы английских строк, которые появятся в `src/` (тест `l10n.test.ts` падает и на непереведённой строке, и на лишнем ключе — сверься с ним в конце).

---

## 5. Кому какая модель

| Воркер | Модель | Почему |
|---|---|---|
| A — terminals | `openai-codex/gpt-5.6-sol` | Событийный жизненный цикл VS Code API, много краевых случаев (терминал закрыли снаружи, shell integration не поднялась). Нужна аккуратность, не объём. |
| B — ports | `dashscope/qwen3.8-max` | Разбор вывода трёх платформенных утилит. Работа на внимательность и полноту, миллионный контекст лишним не будет. |
| C — contributes | `dashscope/glm-5.2` | Механическая правка JSON и переводов. Дорогую модель сюда ставить незачем. |

Три разных провайдера выбраны намеренно: у каждого своя корзина лимитов, поэтому все трое работают параллельно и не блокируют друг друга. Если один провайдер упёрся в лимит — не долби его повторами, перекинь задачу на свободного (`kimi-code/kimi-for-coding` идёт по подписке и в счётчике стоит $0).

---

## 6. Что делаешь ты сам

Эти файлы общие, поэтому их правишь только ты и только **после** мержа воркеров — иначе конфликт гарантирован:

1. `src/extension.ts` — создать `TerminalManager` и `PortScanner`, связать их (`rootPids` сканера берётся у менеджера), зарегистрировать команды, положить оба в `context.subscriptions`.
2. `src/sessionBoard.ts` — в `describeWorkspace` добавить `⇡ <порт>` из `portsFor(id)`. Борд не должен зависеть от сканера напрямую: передай необязательный dep в конструктор, как это уже сделано для `stats`.
3. `src/workspaces/commands.ts` — перевести существующий `openTerminal` на `TerminalManager.open`, добавить обработчики `runConfigured` и `openPort` (`openPort` открывает `env.asExternalUri` через `env.openExternal` — под Remote-SSH прямой localhost не сработает).
4. `CHANGELOG.md` — запись в стиле соседних.

---

## 7. Порядок работы

1. Прочитай файлы из §2 и убедись, что контракты §4 не конфликтуют с тем, что уже есть.
2. Создай три workspace: `workspace_create` с именами `p3-terminals`, `p3-ports`, `p3-contributes` и моделями из §5. В `prompt` каждого положи: его цель, **его список файлов и запрет на чужие**, его контракт из §4 дословно, соглашения §9 и критерии приёмки §8.
3. `workspace_wait` по всем трём. Таймаут — не провал, а повод вызвать ещё раз. Статус `needs_input` означает, что агент задал вопрос: прочитай и ответь через `workspace_prompt`.
4. Для каждого готового: `workspace_diff` — проверь, что тронуты **только его файлы**. Вышел за границы — верни на доработку через `workspace_prompt`, не правь сам.
5. `workspace_verify` на каждом. Красные тесты — назад воркеру с текстом ошибки.
6. Вливай по одному: `workspace_merge`. После каждого мержа следующий workspace окажется «base moved» — это нормально, но перед вливанием следующего перепроверь `workspace_diff` на конфликты.
7. Слил всех троих — сделай свою часть (§6).
8. Прогони `npm test` и `npm run build` целиком. Зелено — удали workspace воркеров (`workspace_delete`). Красно — чини сам, это уже общий код.
9. Отчитайся: что сделано, сколько потрачено на каждого воркера, что пришлось возвращать на доработку.

---

## 8. Критерии приёмки

- «Open terminal» на workspace открывает терминал в его worktree; повторный вызов показывает тот же терминал, а не плодит новые.
- `npm run dev` в терминале workspace → **не позже чем через 3 секунды** строка этого workspace показывает `⇡ 3000`; клик открывает браузер.
- Закрыли терминал → порт исчез со строки.
- Второй workspace со своим сервером на другом порту показывает **свой** порт, а не чужой.
- `npm test` зелёный целиком; парсеры воркера B покрыты тестами на реальных примерах вывода `lsof`, `netstat` и `/proc/net/tcp`.
- `npx tsc --noEmit` и `npm run build` проходят.

---

## 9. Соглашения проекта — вставь в задание каждому воркеру

- TypeScript strict. Импорты внутри `src/` — без расширения, **кроме** `./l10n.ts` и модулей, которые грузятся тестами: в `src/workspaces/` уже пишут `"./git.ts"`. Посмотри соседние файлы и повтори точно.
- Тесты: `node --test --experimental-strip-types test/*.test.ts`. Чистые функции обязаны тестироваться без запуска процессов.
- Никаких новых npm-зависимостей. Никакого `execSync` — только асинхронный `spawn`/`execFile`.
- Комментарии по-английски, объясняют **почему**, а не пересказывают код. Никаких `TODO`.
- Пользовательские строки — через `t("...")` из `../l10n.ts`.
- Ничего не логировать в `console` — только через переданный `output`.

---

## 10. Чего не делать

- Не давать двум воркерам один файл. Если по ходу выяснится, что задачи пересекаются — останови одного и переразбей, а не «пусть аккуратно допишут оба».
- Не вливать workspace, не посмотрев diff. Отчёт агента «готово» — не проверка.
- Не проталкивать мерж при конфликте: `force` покрывает грязную базу и грязный worktree, но конфликт им не продавливается — и не надо.
- Не пытаться читать вывод чужих терминалов программно: в VS Code это proposed API, его нет. Признак «сервер поднялся» — появившийся порт, а не текст в терминале.
- Не ставить дорогую модель на механическую работу.
- Не запускать всех троих на одном провайдере: упрутся в общий лимит и встанут вместе.
- Не делать работу воркера за него, если он ошибся, — верни ему с конкретным замечанием. Смысл прогона в том, чтобы работали они.
