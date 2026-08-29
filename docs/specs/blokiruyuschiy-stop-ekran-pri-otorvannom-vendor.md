# Блокирующий стоп-экран при оторванном vendor

<!-- spec-id: blokiruyuschiy-stop-ekran-pri-otorvannom-vendor -->

- **Раздел:** Целостность и гейты
- **Код:** `src/main.js:32-152`, `src/main.js:545-554`, `src/main.js:889-895`, `src/renderer/app.js:73-75`, `src/renderer/app.js:116-121`, `src/renderer/app.js:305-315`, `src/renderer/app.js:699-751`, `src/renderer/app.js:878-902`, `src/renderer/app.js:1248-1253`, `src/renderer/app.js:1849-1852`, `src/renderer/styles.css:637-649`, `src/renderer/index.html`
- **Тесты:** «lite (macOS): том dmg БЕЗ config-pack считается «сиблинг на месте» — ложной плашки нет», «lite (macOS): .app перетащили в «Программы» → сиблинга нет → плашка ОБЯЗАНА гореть», «lite (macOS): неполный сиблинг (нет checksums.json / нет uv / нет курса) → плашка горит», «офлайн (macOS): семантика НЕ изменилась — config-pack по-прежнему обязателен», «МУТАЦИЯ: вернуть проверку config-pack в lite-ветку → тест краснеет (фикс не косметический)», «bootstrap отдаёт renderer editionVendorPresent, а не vendorAvailable; текст плашки верен для ОБОИХ изданий», «config.json в репозитории без сборочных маркеров»

> Оговорка о покрытии: перечисленные тесты проверяют **предикаты обнаружения** (`vendorRoot`, `vendorAvailable`, `editionVendorPresent`) и то, что жёсткий гейт по-прежнему записан как `if (!vendorComplete() && isOfflineEdition())`. Ни один тест не проверяет сам стоп-экран: `renderVendorBlock`, приоритет над приветствием, гашение кнопки в `refreshDerived`, ранний выход из `startInstall` и защиту в `run-component` тестами не покрыты (см. «Риски»).

## Что обещает человеку

Если установщик на macOS запущен так, что офлайн-файлы рядом с ним недоступны, он не даст начать заведомо провальную установку. Вместо получаса ожиданий, красных крестов и непонятного «код 1» человек сразу получает перекрывающее экран окно с объяснением причины, кнопкой «Исправить автоматически» и запасной командой для Терминала. Кнопка «Установить» при этом погашена.

Обещание, за которое можно спросить: пока офлайн-ресурсы оторваны, **ни один компонент не запустится** — ни по кнопке, ни в обход неё. И проверка «оторвано ли» идёт по тому, что обязано быть у **данного издания**, а не по одному произвольному файлу: у лёгкого (lite) издания `config-pack` отсутствует по построению, и раньше это давало ему вечную ложную тревогу.

## Как работает

**1. Где ищется vendor (`src/main.js:22-41`).** `resourceRoot()` — `process.resourcesPath` в упакованном приложении, корень проекта в dev. `vendorRoot()` для упакованного macOS сначала пробует sibling-папку `path.resolve(process.resourcesPath, '..', '..', '..', 'vendor')` (папка рядом с `.app`, то есть корень смонтированного dmg) и возвращает её, если она существует; иначе — `<resourceRoot>/vendor`.

**2. Признаки (`src/main.js:43-132`).**
- `vendorAvailable()` — существует ли `vendor/config-pack`. Комментарий в коде прямо оговаривает: это признак «полная офлайн-база рядом», а не «сиблинг на месте».
- `isTranslocated()` — только на darwin; регулярка `/\/AppTranslocation\//` по `process.execPath` и по `__dirname`.
- `vendorDirHas(sub, test)` — `fs.readdirSync(vendorRoot()/sub).some(test)`, при исключении `false`.
- `vendorComplete()` — `vendorAvailable()` И архив uv `apps/uv-macos-*.tar.gz` И архив курса `course/*.zip`.
- `isOfflineEdition()` — `config.json.offlineEdition === true` (маркер пишет fetch-vendor на сборке).
- `isLiteEdition()` — `config.json.edition === 'lite'`.
- `editionVendorPresent()` — развилка по изданию: не lite → просто `vendorAvailable()`; lite → `checksums.json` И uv (на darwin `apps/uv-macos-*.tar.gz`, иначе `apps/uv/uv.exe|uvx.exe`) И `course/*.zip`.

**3. Решение о блокировке (`src/main.js:143-152`, `vendorBlockInfo`).** Три ветки:
- не darwin **или** не `app.isPackaged` → `{ blocked: false }` (на Windows и в dev фича инертна целиком);
- `isTranslocated()` → `{ blocked: true, translocated: true, reason: 'translocation' }` — блок всегда, независимо от издания;
- `!vendorComplete() && isOfflineEdition()` → `{ blocked: true, translocated: false, reason: 'incomplete-vendor' }` — блок только для издания, объявившего себя офлайн-полным. Онлайн/lite-издание без vendor не блокируется: у него штатный онлайн-фолбэк.

**4. Передача в UI (`src/main.js:545-554`).** `bootstrap` кладёт в ответ два разных поля: `vendorAvailable: editionVendorPresent()` (мягкая плашка) и `vendorBlock: vendorBlockInfo()` (жёсткий стоп).

**5. Renderer (`src/renderer/app.js`).** `init()` записывает `STATE.vendorBlock` и `STATE.vendorBlocked` (73-75), затем вызывает `renderVendorBlock()` (116) **до** `showInitialScreen()` (121) — порядок задан комментарием и нужен, чтобы стоп имел приоритет над приветствием. `showInitialScreen()` (305-315) при `STATE.vendorBlocked` прячет `#view-welcome` и показывает `#view-select`, поверх которого уже висит модалка.

`renderVendorBlock()` (703-751): если `vb.blocked` ложно — уходит в мягкий путь `renderVendorWarning()` и выходит. Иначе выставляет `STATE.vendorBlocked = true` и делает три вещи: (а) `openModal({ id: 'vendor-block', blocking: true, … })` с инструкцией из четырёх шагов, кнопкой `#mac-selfheal` и однострочной командой `find … hdiutil detach … xattr -dr com.apple.quarantine … open`; (б) добавляет несмываемый красный баннер `#vendorblock-banner` с той же командой, дублирующей кнопкой `#mac-selfheal-banner` и кнопкой `#vendorblock-reopen`, переоткрывающей модалку; (в) привязывает обе кнопки самолечения через `bindMacSelfHeal` и показывает причину провала прошлой попытки (`showPrevSelfHealFailure`).

`openModal` (878-902) рисует `div.modal-overlay` c `position: fixed; inset: 0; z-index: 200` (`src/renderer/styles.css:637-644`). `blocking: true` меняет ровно две вещи: `role="alertdialog"` вместо `dialog` и отсутствие закрытия кликом по фону. Кнопка «Понятно» закрывает окно в любом случае; обработчика Escape в `openModal` нет.

**6. Два дублирующих запрета на запуск.** В renderer — `refreshDerived` (1248-1253): `btnInstall.disabled = n === 0 || !STATE.detectDone || !STATE.netProbeDone || !!STATE.vendorBlocked` — и ранний выход в `startInstall` (1849-1852), который заодно переоткрывает модалку. В main — `run-component` (889-895): перед allowlist-проверкой id заново вызывается `vendorBlockInfo()`, и при `blocked` возвращается `{ ok: false, code: -1, error: 'офлайн-ресурсы недоступны (translocation/оторванный vendor) — установка заблокирована' }`. Комментарий помечает это как defense-in-depth: «MAIN — единственный авторитет запуска».

## Инварианты

1. **Решение о блокировке принимает main, не renderer.** `vendorBlockInfo()` живёт только в `src/main.js:143-152`; renderer получает готовый `vendorBlock` из `bootstrap` (`src/main.js:554`) и читает лишь `.blocked` (`src/renderer/app.js:74-75, 704-706`).
2. **Проверка идёт по изданию, а не по одному файлу.** `editionVendorPresent()` (`src/main.js:122-132`) для lite не смотрит на `config-pack` вовсе, а требует `checksums.json` + uv + курс; `bootstrap.vendorAvailable` считается именно им (`src/main.js:551`).
3. **App Translocation блокирует безусловно.** `isTranslocated()` проверяется первым и до всех признаков издания (`src/main.js:145-147`) — офлайн-компоненты физически недостижимы.
4. **Неполный vendor без translocation блокирует только офлайн-издание.** Условие `!vendorComplete() && isOfflineEdition()` (`src/main.js:148-150`); онлайн/lite при отсутствующем vendor получает мягкую плашку `renderVendorWarning` (`src/renderer/app.js:705, 855-871`), а не кирпич.
5. **На Windows и в dev жёсткий стоп не срабатывает никогда.** Первая строка `vendorBlockInfo()`: `if (process.platform !== 'darwin' || !app.isPackaged) return { blocked: false }` (`src/main.js:144`).
6. **Запуск компонента при `blocked` невозможен независимо от состояния UI.** Проверка повторяется в `run-component` до allowlist-проверки id (`src/main.js:889-895`).
7. **Стоп-экран имеет приоритет над приветственным.** `renderVendorBlock()` вызывается до `showInitialScreen()`, а тот при `STATE.vendorBlocked` прячет `#view-welcome` (`src/renderer/app.js:116-121, 305-315`).
8. **Закрытие модалки не открывает путь к установке.** После «Понятно» остаётся несмываемый баннер `#vendorblock-banner` с кнопкой «Показать инструкцию» (`src/renderer/app.js:732-747`), а `startInstall` при `STATE.vendorBlocked` переоткрывает модалку и выходит (`src/renderer/app.js:1852`).
9. **Сборочные маркеры издания не лежат в репозитории.** `config.json` в коммите не содержит ни `offlineEdition`, ни `edition` — иначе `npm run dist:mac` даёт `.app`, который блокирует сам себя. Держится тестом «config.json в репозитории без сборочных маркеров» (`test/run-tests.js`).

## Что ломается, если инвариант нарушить

1. Renderer решает сам → перезагрузка окна (Ctrl+R) или подменённое состояние снимает стоп, и человек запускает установку, которая гарантированно провалится на офлайн-компонентах.
2. Проверка по одному `config-pack` → маковод с лёгким изданием, запустивший `.app` правильно из окна dmg, видит предупреждение «файлы рядом не подхватятся» при каждом запуске. Предупреждение, которое горит всегда, перестают читать — и настоящую поломку тоже пропустят.
3. Translocation не блокирует → Gatekeeper исполняет копию из read-only `AppTranslocation`, sibling-vendor оторван, uv/nomad/курс/маскот недостижимы: установка идёт долго и падает «код 1» без объяснения причины.
4. Блокировать при любом неполном vendor → легитимная mac-сборка без офлайн-vendor (онлайн/lite) превращается в кирпич: онлайн-фолбэк работал бы, но кнопка погашена, и человек не может поставить ничего.
5. Стоп срабатывает на Windows или в dev → установщик на Windows блокирует сам себя без причины (translocation там невозможен), разработчик не может запустить приложение локально.
6. Нет проверки в main → достаточно любого пути, минующего кнопку (переоткрытое окно, гонка при загрузке, ошибка в `refreshDerived`), чтобы стартовал mac-скрипт компонента в состоянии, где офлайн-архивов нет: `scriptFor` на darwin собирает путь `scripts/macos/<id>.sh` (`src/main.js:569-573`), а `uv.sh` берёт архив по пути `${HM_VENDOR}/apps/uv-macos-<arch>.tar.gz` (`scripts/macos/uv.sh:33`) — тот самый архив, отсутствие которого и делает `vendorComplete()` ложным (`src/main.js:79`). Windows-путь (`msiexec`) сюда не относится вовсе: гейт активен только на darwin (`src/main.js:144`), а `msiexec` в `scripts/macos/` не встречается ни разу.
7. Приветствие поверх стопа → человек нажимает «Поехали →», попадает на экран выбора, отмечает компоненты и только потом упирается в погашенную кнопку без объяснения.
8. Нет баннера после закрытия модалки → глухой тупик: «Установить» погашена, причина исчезла вместе с окном, повторный показ зашит только в `startInstall`, который по disabled-кнопке не стреляет. Выход — только перезапуск приложения.
9. Маркер `offlineEdition` уехал в коммит → выпущенная сборка `dist:mac` показывает стоп-экран про карантин сразу после установки, и ни один компонент поставить нельзя.

## Границы

- **Только macOS и только упакованное приложение.** На Windows и в dev-режиме `vendorBlockInfo()` всегда возвращает `{ blocked: false }`; для Windows остаётся общий гейт целостности артефактов, а не этот стоп-экран.
- **Не чинит проблему сам.** Стоп-экран только останавливает и объясняет; снятие карантина, перемонтирование dmg и перезапуск — отдельная фича самолечения (`macos-samolechenie-karantina-i-translokacii`, `ipcMain.handle('mac-selfheal')` в `src/main.js:3437`, `bindMacSelfHeal` в `src/renderer/app.js:808-850`).
- **Не проверяет содержимое найденных архивов.** `vendorComplete()` и `editionVendorPresent()` смотрят только на имена файлов в каталогах (`vendorDirHas` — `readdirSync` + regexp). Битый или подменённый архив этой проверкой не ловится: за содержимое отвечают гейты sha256, а не эта фича.
- **Не блокирует онлайн/lite-издание без vendor.** Это осознанная уступка: у такого издания есть онлайн-фолбэк, и жёсткий стоп сделал бы его неработоспособным. Ему достаётся мягкая плашка.
- **Модалку можно закрыть.** `blocking: true` в `openModal` убирает закрытие кликом по фону, но не кнопку «Понятно». «Блокирующим» экран остаётся за счёт погашенной кнопки и несмываемого баннера, а не за счёт невозможности закрыть окно.
- **Не различает причину в тексте.** Стоп-экран показывает одну и ту же инструкцию про карантин и dmg для обеих причин блокировки.

## Риски и открытые вопросы

1. **Сам стоп-экран не покрыт тестами.** Поиск по `test/run-tests.js` по `vendorBlocked`, `renderVendorBlock`, `vendor-block`, `vendorblock` не даёт ни одного совпадения; по `vendorBlock` — единственное совпадение в комментарии на строке 7504. Покрыты только предикаты обнаружения и наличие строки `if (!vendorComplete() && isOfflineEdition())` в исходнике. Значит без теста остаются: приоритет стоп-экрана над приветствием, `btnInstall.disabled` при `vendorBlocked`, ранний выход из `startInstall`, наличие несмываемого баннера и — самое дорогое — **защита в `run-component` (`src/main.js:892-895`)**. Её можно удалить, и весь набор тестов останется зелёным.
2. **Текст модалки говорит только про карантин, хотя причин две.** При `reason: 'incomplete-vendor'` без translocation (офлайн-издание, у которого не хватает `config-pack`/uv/курса) человек читает «macOS поставил приложению «карантин» и запускает его из защищённой копии» — утверждение, которое в этой ветке кодом не проверялось. Инструкция «снять карантин и перемонтировать образ» в этом случае может не помочь.
3. **Поля `translocated` и `reason` вычисляются, но renderer их не читает.** Проверено поиском по `src/renderer/app.js`: используется только `vb.blocked`. Различить две причины в UI сейчас нечем (см. п. 2).
4. **`vendorComplete()` напрямую тестом не прогоняется.** Тесты в блоке `liteSiblingVendorDetection` вырезают из `main.js` фрагмент от `function resourceRoot()` до строки `\n// Жёсткий стоп ДО установки` — то есть ровно **до** `vendorBlockInfo()`, и исполняют в `vm` только `editionVendorPresent`, `vendorAvailable`, `vendorRoot`. Логика самой блокировки в vm не выполняется; её стережёт лишь текстовая проверка регулярным выражением в тесте «bootstrap отдаёт renderer editionVendorPresent…».
5. **Вырез для vm привязан к строке комментария.** `src.indexOf('\n// Жёсткий стоп ДО установки')` в `test/run-tests.js:8020` — переписывание этого комментария в `src/main.js:134` сломает тесты либо (хуже) сдвинет границу выреза незаметно.
6. **`isTranslocated()` опирается на подстроку пути.** `/\/AppTranslocation\//` по `process.execPath` и `__dirname` — эвристика по имени системного каталога, не по API Gatekeeper. Поведение при изменении этого пути в будущих macOS кодом не подстраховано.
