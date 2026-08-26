<!-- ppt-master-schema: spec-lock/v1 -->
# Execution Lock

## canvas
- viewBox: 0 0 1280 720
- format: PPT 16:9

## communication
- primary_language: ru-RU
- audience: Разработчик в VS Code, впервые видящий OMP Code; знает редактор, не знает ни CLI-агента omp, ни профилей моделей
- objective: Довести читателя от неустановленного расширения до работающей панели чата, затем оставить ему сканируемую справку по возможностям, настройкам и диагностике
- core_message: OMP Code — это GUI поверх CLI-агента omp: поставь агента, поставь vsix, войди — дальше любая модель в одной панели со стоимостью на виду
- consumption_mode: text

## mode
- mode: custom
- mode_references: instructional, briefing
- mode_behavior: Страницы 01–07 ведут по установке и первому запуску в манере instructional — декомпозиция на пронумерованные шаги, порядок «предусловие → зависимое», заголовки называют выполняемое действие, каждая страница закрывает один проверяемый шаг. Страницы 08–10 переключаются на briefing — тезиса нет, заголовки предметные, сиблинги равного веса, материал разложен в сканируемые таблицы для возврата как к справке. Точка перелома объявлена явно на странице 08. Голос ровный и утвердительный; предупреждения источника сохраняются отдельными помеченными врезками, а не растворяются в прозе.

## visual_style
- visual_style: custom
- visual_style_references: swiss-minimal, editorial
- visual_style_behavior: Скелет держит swiss-minimal — модульная сетка, широкие поля, прямые углы, ни одного украшения без информационной работы, крупный номер шага как архитектурный элемент; строго плоско, без теней и градиентов. editorial отвечает за уровень доказательства внутри скелета — волосяные линейки вместо повторяющихся карточек, кикер над заголовком, подписи под скриншотами, таблицы на линейках без заливки строк. Собственный элемент вне обеих баз — тёмная сцена цвета stage_surface под каждым скриншотом: кадры сняты с тёмной темы редактора и на белом листе обрываются по краю, сцена даёт им основание и работает зоной внимания. Команды набираются моноширинным на подложке secondary_bg с левой акцентной линейкой.

## colors
- background: #FFFFFF
- secondary_bg: #F4F3FA
- primary: #2A2440
- accent: #6F5CE8
- secondary_accent: #4EC9A6
- body_text: #1D1B26
- stage_surface: #16141F
- muted_text: #6B667E
- rule: #DDD8EE

## typography
- font_family: Golos Text, Arial, Helvetica Neue, sans-serif
- title_family: Golos Text, Arial, Helvetica Neue, sans-serif
- body_family: Golos Text, Arial, Helvetica Neue, sans-serif
- code_family: Consolas, Courier New, monospace
- body: 20
- title: 38
- subtitle: 26
- annotation: 15
- hero: 88
- step_numeral: 56
- hero_family: Golos Text, Arial, Helvetica Neue, sans-serif
- step_numeral_family: Golos Text, Arial, Helvetica Neue, sans-serif

## icons
- library: tabler-outline
- stroke_width: 2
- inventory: tabler-outline/terminal-2, tabler-outline/package, tabler-outline/key, tabler-outline/user-check, tabler-outline/message-2, tabler-outline/coin, tabler-outline/shield-lock, tabler-outline/adjustments, tabler-outline/history, tabler-outline/settings, tabler-outline/stethoscope, tabler-outline/keyboard, tabler-outline/alert-triangle, tabler-outline/circle-check, tabler-outline/arrow-right, simple-icons/visualstudiocode, simple-icons/github, simple-icons/bun

## images
- p04-keys: images/keys.png | source=user | pattern=Одиночный вертикальный кадр в правой зоне, на тёмной сцене, с подписью под ним (`#P1-02` боковое изображение с текстовым полем, `#P1-12` рамка с подписью) | crop=no-crop
- p05-chat: images/chat.png | source=user | pattern=Одиночный вертикальный кадр в правой зоне, на тёмной сцене; выноски с номерами слева ведут к частям панели (`#P1-02`, `#P2-02` точки с легендой) | crop=no-crop
- p06-models: images/models.png | source=user | pattern=Левый кадр пары равных ячеек на общей тёмной сцене (`#P3-01` диптих) | crop=no-crop
- p06-context: images/context-warning.png | source=user | pattern=Правый кадр той же пары равных ячеек (`#P3-01` диптих) | crop=no-crop
- p07-access: images/tool-access.png | source=user | pattern=Левый кадр пары равных ячеек на общей тёмной сцене (`#P3-01` диптих) | crop=no-crop
- p07-approval: images/approval.png | source=user | pattern=Правый кадр той же пары равных ячеек (`#P3-01` диптих) | crop=no-crop
- p08-profile: images/profile.png | source=user | pattern=Левый кадр пары равных ячеек на общей тёмной сцене (`#P3-01` диптих) | crop=no-crop
- p08-thinking: images/profile-thinking.png | source=user | pattern=Правый кадр той же пары равных ячеек (`#P3-01` диптих) | crop=no-crop
- p09-history: images/history.png | source=user | pattern=Левый кадр пары равных ячеек на общей тёмной сцене (`#P3-01` диптих) | crop=no-crop
- p09-settings: images/settings-menu.png | source=user | pattern=Правый кадр той же пары равных ячеек (`#P3-01` диптих) | crop=no-crop

## page_visualizations
- P07: table/feature_matrix
- P09: table/record_table
- P10: table/record_table

## page_rhythm
- P01: breathing
- P02: breathing
- P03: anchor
- P04: anchor
- P05: anchor
- P06: dense
- P07: dense
- P08: anchor
- P09: dense
- P10: dense

## pptx_structure
- mode: flat

## forbidden
- `mask`, `<style>`, `class`, external CSS, `<foreignObject>`, `textPath`, `@font-face`, `<animate*>`, `<set>`, `<script>` / event attributes, `<iframe>`
- HTML named entities in text; write typography as raw Unicode and escape XML reserved characters
