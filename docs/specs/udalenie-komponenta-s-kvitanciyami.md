# Удаление компонента с квитанциями

<!-- spec-id: udalenie-komponenta-s-kvitanciyami -->

- **Раздел:** Установка компонентов
- **Код:** `src/uninstall-targets.js`, `src/uninstall-exec.js`, `src/install-receipts.js`, `src/main.js:3163-3283`, `src/main.js:3037-3161`, `src/main.js:3014-3029`, `src/main.js:2896-2971`, `src/main.js:2662-2696`, `src/main.js:1330-1365`, `src/main.js:368-375`, `src/renderer/app.js:38-43`, `src/renderer/app.js:506-575`, `src/preload.js:12`, `src/install-manifest.js:160-167`
- **Тесты:** «targets: course (win32) — контент курса из известных мест; ярлык из вшитого config; НИ одной цели в ~/.claude», «targets: uv (win32) — ТОЧНЫЕ файлы (не рекурсивный каталог), emptydir, pathentry только при опустевшем каталоге», «targets: mascot (darwin) БЕЗ vendor → НЕТ appbundle-цели (fail-closed); с vendor → точный путь + пин TeamID», «targets: неизвестный/не-removable id → null (деинсталляция отклоняется fail-closed)», «guard: сам ~/.claude, всё внутри него, дом, предок дома, ~/CLAUDE.md, ~/.hamidun-setup → отказ», «PRESERVE: деинсталляция курса — sandbox/state.json/identity.json/settings.local.json ЦЕЛЫ, контент курса удалён, ~/.claude цел», «PRESERVE: мост — config.json с SSH-кредами ЦЕЛ, bridge_agent.py удалён, каталог остаётся (не пуст)», «crafted-квитанция с artifacts на ~/.claude НЕ влияет на план: artifacts игнорируются целиком», «uninstall: REMOVABLE (app.js) гейтится квитанцией-маркером; все REMOVABLE имеют зашитую карту целей», «main.js: uninstall гейтится hasReceipt (маркер); receipted в detect-state; маркер пишется при успехе установки», «main.js (source): деактивация маркера ДО удаления, restore при провале, stillThere → ok:false, финальная очистка проверяется», «receipts: deactivate (атомарно, ДО удаления) → hasReceipt=false; restore → true; finalize с ПРОВЕРКОЙ результата», «прерванное удаление: маркер возвращается на старте, живой не затирается», «P0-4 (source): uninstall-component — platform-гейт ДО плана (win32-компонент на darwin → отказ)», «main.js (source) + app.js: Nomad-uninstall отбит ранним гейтом (UNINSTALL_DISABLED) и НЕ предлагается в UI», «P1-7 main.js: учёт чистится ТОЛЬКО после пост-детекции отсутствия; оставшийся компонент → ok:false», «цель hookurl заводится ДЛЯ СКРЕПКИ на обеих платформах и только для неё», «restoreHookUrl (реальная ФС): порт снят, чужие ключи целы, повтор идемпотентен»

## Что обещает человеку

Кнопка «Удалить» на карточке установленного компонента сносит только то, что поставил
этот установщик, и ничего больше. Данные пользователя переживают удаление по имени:
прогресс курса (`sandbox`, `.course/state.json`, `.course/identity.json`,
`.claude/settings.local.json`), SSH-настройки моста (`config.json` в каталоге
HamidunBridge), весь общий каталог `~/.claude` с ключами, памятью и историей. Это
записано не пожеланием, а списком `preserve` в плане и защищённым набором guard-а
(`src/uninstall-targets.js`, `src/uninstall-exec.js:73-79`).

Кнопка появляется только у компонентов, которые установщик ставил САМ: в UI её
показывает `renderInstalledActions` при условии `REMOVABLE.has(c.id) && det.receipted`
(`src/renderer/app.js:513`), а в main то же требование стоит гейтом
`receipts.hasReceipt` (`src/main.js:3200`). Обещание «удалю только своё» проверяемо: у
человека, который поставил uv руками год назад, кнопки не будет, а если он вызовет
операцию в обход UI — она откажет с текстом «этот установщик его не ставил».

## Как работает

**Что вообще удаляемо.** Список в UI — `REMOVABLE = new Set(['course', 'uv', 'mascot',
'bridge'])` (`src/renderer/app.js:43`). Со стороны main тот же набор получается из
`switch (id)` в `uninstallTargets` (`src/uninstall-targets.js:106-257`): у `course`,
`uv`, `bridge`, `mascot` есть карта целей; `nomad` возвращает ПУСТОЙ план плюс
`uninstallSupported: false`; любой другой id — `null`, то есть отказ.

**Клик.** `uninstallComponent` (`src/renderer/app.js:560-575`) спрашивает
`window.confirm`, затем зовёт `window.installer.uninstallComponent(id, envForRun())` →
`ipcRenderer.invoke('uninstall-component', { id, env })` (`src/preload.js:12`).

**Гейты в обработчике** `ipcMain.handle('uninstall-component')`
(`src/main.js:3163-3283`), строго по порядку:

1. id из `VALID_COMPONENT_IDS`, иначе `Unknown component id`;
2. `meta.hidden` → «Служебный компонент … не деинсталлируется»;
3. `componentShownOnPlatform(meta, process.platform)` → отказ, если компонент чужой
   платформы (crafted-квитанция win32-компонента на macOS не исполнит win32-план);
4. `uninstallTargets.UNINSTALL_DISABLED.has(id)` → ранний отказ (сейчас там один
   `nomad`, `src/uninstall-targets.js:53`) — ДО построения плана и ДО деактивации
   маркера;
5. `receipts.hasReceipt(home, id)` → нет маркера, значит ставили не мы, отказ.

**Построение плана.** `uninstallTargets(id, buildUninstallCtx())`
(`src/main.js:3209`). Контекст `buildUninstallCtx` (`src/main.js:3014-3029`) собран
только из доверенных источников: `process.platform`, `os.homedir()`,
`app.getPath('desktop')`, вшитый `config.json` (`course.targetDirDefault`,
`course.shortcutName`, `nomad.packageName`) и — на macOS — vendor-бандл маскота через
`resolveMascotVendorApp`. Значения из renderer-env в контекст не попадают. Пустой план
или `null` → «Компонент … не поддерживает деинсталляцию».

**Ветвление платформы — внутри карты целей**, `ctx.platform` передаётся явным
параметром, а модуль пути выбирается по нему (`platformPath`,
`src/uninstall-targets.js:47`), а не по хосту:

- `course` — одинаково на обеих: `dirtree` на `tracks`, `.claude/skills`,
  `.claude/commands`, `.course/knowledge`; `file` на `CLAUDE.md`, `AGENTS.md`,
  `README.md`, `.course/config.yaml`, `.course/state.example.json`; ярлык на рабочем
  столе — `.lnk` на Windows, `.command` на macOS; четыре `emptydir` вверх по дереву;
  четыре пути в `preserve`.
- `uv` — Windows: точные `uv.exe`/`uvx.exe` в `%LOCALAPPDATA%\Programs\uv`, `emptydir`
  этого каталога и `pathentry` с `onlyIfDirGone: true`. macOS: только два файла
  `~/.local/bin/uv` и `~/.local/bin/uvx`; сам `~/.local/bin` не трогается как общий.
- `bridge` — Windows: `bridge_agent.py`, `emptydir` каталога, `reg`-значение
  `HamidunBridge` в `HKCU\...\Run`. macOS: `launchagent com.hamidun.bridge` + plist,
  `bridge_agent.py`, `emptydir`, и две `profileline`-цели с ТОЧНОЙ строкой
  `BRIDGE_RC_LINE` для `~/.zshrc` и `~/.bash_profile`. В обоих случаях
  `config.json` уходит в `preserve`.
- `mascot` — сперва платформонезависимая цель `hookurl` на `~/.claude/settings.json`
  (замена `127.0.0.1:45832/hook` обратно на `127.0.0.1:VSCODE_PORT/hook`). Дальше
  Windows: `killproc claude-mascot.exe`, `dirtree` каталога приложения,
  `.claude-mascot/.installed`, `emptydir`, `reg`-значение `ClaudeMascot`. macOS:
  `launchagent com.hamidun.claude-mascot` + plist, и `appbundle` в `~/Applications` —
  ТОЛЬКО если `ctx.mascotMac` дал ИМЯ `.app` из vendor: гейт проверяет ровно
  `ctx.mascotMac.appName` и его расширение (`src/uninstall-targets.js:221`), bundleId
  в условии не участвует и берётся строкой ниже как `String(bundleId || '')`
  (`src/uninstall-targets.js:226`). Имени нет — цели `.app` нет вовсе и в план уходит
  нота «Vendor недоступен» (`src/uninstall-targets.js:232`). Имя есть, а bundleId
  вычислить не удалось (`macBundleIdOf` возвращает `''` при ЛЮБОМ сбое PlistBuddy,
  `src/main.js:2974-2980`; `resolveMascotVendorApp` отдаёт результат как есть,
  `src/main.js:2999-3010`) — цель ВСЁ РАВНО попадает в план с пустым эталоном, и ноты
  «Vendor недоступен» человек не видит. Fail-closed при этом не теряется, но
  срабатывает позже и — если бандл на месте — дороже: в `executeUninstallTarget`
  сначала стоит проверка существования (`src/main.js:3121`), и при отсутствующем
  `~/Applications/<appName>.app` цель тихо отдаёт `absent`; существующий бандл
  отбивается как `failed` («ЗАЩИТА: нет эталонного CFBundleIdentifier (vendor) —
  отказ удалять .app», `src/main.js:3124`), а один `failed` роняет ВСЮ деинсталляцию
  маскота в `ok:false` с возвратом маркера (`src/main.js:3256-3264`).

**Dry-run.** `isDryRun` берётся из `process.env.HM_DRY_RUN` ИЛИ из renderer-подсказки
(`src/main.js:3188`). В этом режиме печатаются строки `WOULD:` и `KEEP:` и возврат
происходит ДО деактивации маркера — ни одной операции над диском.

**Учёт до и после.** `receipts.deactivateReceipt` атомарным `rename` превращает
маркер в `<id>.json.uninst` ДО первой операции удаления; не смог — деинсталляция
прерывается, ничего не удаляется. Дальше каждая цель исполняется
`executeUninstallTarget` (`src/main.js:3056-3161`), который раскладывает тип на
исполнителя из `uninstall-exec` (`removeFile`, `removeEmptyDir`, `removeDirTree`,
`removeProfileLine`, `restoreHookUrl`) либо на локальные `winRegDeleteValue` /
`winRemoveUserPathEntry` (`src/main.js:2900-2971`), а неизвестный тип отбивает
fail-closed. Каждая строка результата уходит и в UI (`component-log`), и в
`install.log`.

**Пост-проверка и финал.** `uninstallExec.verifyPostconditions(plan, guardOpts, …)`
(`src/uninstall-exec.js:597-675`) проверяет ИМЕННО цели этого плана, а не «есть ли на
машине uv вообще». `failed > 0 || stillThere` → `restoreReceipt` возвращает маркер и
операция честно отдаёт `ok:false`. Только при подтверждённом успехе идут
`finalizeRemoval` (снятие tombstone и хвостов `.bak`/`.tmp`) и
`manifest.removeEntry` (`src/install-manifest.js:160-167`); их результат проверяется —
если учёт не почистился, ответ всё равно `ok:false` с текстом «Артефакты удалены, но
учётные записи не очищены».

**Прерванное удаление.** При старте приложения `receipts.recoverOrphanTombstones`
(`src/main.js:374`) возвращает осиротевшие tombstone обратно в маркеры — иначе кнопка
«Удалить» исчезла бы навсегда у наполовину удалённого компонента.

## Инварианты

1. Ни один путь удаления не берётся из квитанции: `buildReceipt` не содержит поля
   artifacts вовсе (`src/install-receipts.js:66-74`), а цели строит только
   `uninstallTargets` из `home`/вшитого config/vendor. Легаси-квитанция v1 с
   artifacts остаётся валидным маркером, её artifacts игнорируются целиком.
2. Удаление без маркера невозможно: `receipts.hasReceipt(home, id)` — обязательный
   гейт (`src/main.js:3200-3206`), а в UI кнопка вообще не рендерится без
   `det.receipted` (`src/renderer/app.js:513`).
3. Ни одна УДАЛЯЮЩАЯ цель не может лежать в `~/.claude`, `~/CLAUDE.md`,
   `~/.hamidun-setup`, в самом доме или его предке: `checkTarget` отбивает и точное
   совпадение, и «внутри», и «предок существующего защищённого»
   (`src/uninstall-exec.js:139-158`). На POSIX дополнительно сверяются device+inode
   (`src/uninstall-exec.js:162-181`). Исключение ровно одно и оно ничего не удаляет:
   цель `hookurl` на `~/.claude/settings.json` (`src/uninstall-targets.js:201-207`) —
   первая в плане маскота на обеих платформах. Через `checkTarget` она НЕ проходит:
   `executeUninstallTarget` отправляет её напрямую в `restoreHookUrl`
   (`src/main.js:3077`), а тот заменяет guard собственным узким допуском — см.
   инвариант 4.
4. Единственная операция, которой разрешено писать в `~/.claude`, — `restoreHookUrl`,
   и она ничего не удаляет: допущен ровно один путь `~/.claude/settings.json`
   (`src/uninstall-exec.js:528-531`), проверяется, что это не symlink и обычный файл,
   JSON парсится ДО и ПОСЛЕ замены, запись атомарная.
5. Пути из `preserve` переживают удаление: они уходят в `guardOpts.extraProtected`
   (`src/main.js:3213`), и `removeDirTree` отказывает всей цели, если внутри неё лежит
   сохраняемый путь (`src/uninstall-exec.js:235-239`).
6. `emptydir` физически не может удалить содержимое: используется `fs.rmdirSync` без
   рекурсии, а непустой каталог возвращает `kept`
   (`src/uninstall-exec.js:209-228`).
7. Запись PATH убирается только при реально отсутствующем каталоге: существует —
   `kept`; ошибка проверки, отличная от ENOENT/ENOTDIR — `failed`
   (`src/main.js:2930-2937`). Само значение переписывается с сохранением типа и с
   отказом при подозрении на потерю символов (`src/main.js:2953-2955`).
8. Из реестра удаляется только точное значение под единственным разрешённым ключом:
   `WIN_REG_ALLOWED_KEYS` содержит ровно `software\microsoft\windows\currentversion\run`
   (`src/main.js:2896`), hive обязан быть `HKCU`, результат верифицируется повторным
   чтением.
9. Из rc-файла уходит только строка, ЦЕЛИКОМ равная installer-строке после `trim`
   (`src/uninstall-exec.js:441-444`), и только из `~/.zshrc`, `~/.bash_profile`,
   `~/.bashrc` (`allowedRcFiles`).
10. `.app` на macOS удаляется только при двойном совпадении идентичности:
    `CFBundleIdentifier` равен значению из vendor И `TeamIdentifier` равен пину
    `3VN93XA9DY` (`src/main.js:3119-3133`, `src/uninstall-targets.js:56`). Vendor не
    дал ИМЕНИ `.app` — цели `.app` в плане нет (`src/uninstall-targets.js:221`); дал
    имя, но не bundleId — цель в плане есть с пустым `expectBundleId`, и её отбивает
    уже исполнитель (`src/main.js:3124`), а не построитель плана.
11. Маркер деактивируется ДО первой операции удаления, и невозможность деактивации
    прерывает всё (`src/main.js:3224-3228`).
12. Учёт (tombstone + манифест) чистится только после подтверждённой пост-проверки, и
    результат чистки проверяется: `finalizeRemoval` возвращает `ok:false`, если
    tombstone остался или остались хвосты `.bak`/`.tmp`
    (`src/install-receipts.js:268-291`).
13. Неизвестный тип цели не исполняется: `default` в `executeUninstallTarget` →
    `failed` с «ЗАЩИТА: неизвестный тип цели» (`src/main.js:3158-3159`).
14. Компонент из `UNINSTALL_DISABLED` отбивается ДО построения плана даже при валидной
    квитанции (`src/main.js:3181-3183`).
15. В dry-run не деактивируется маркер, не исполняется ни одна цель и не пишется
    `install.log` (`src/main.js:3190`, `3306-3310`).

## Что ломается, если инвариант нарушить

1. Подменённая квитанция в user-writable `~/.hamidun-setup` увела бы удаление в
   произвольный путь — рабочие файлы человека сносит установщик, на Windows ещё и
   elevated.
2. Кнопка «Удалить» на компоненте, поставленном не нами: человек жмёт её ради своего
   старого uv и теряет чужой рабочий инструмент, которым пользуются другие проекты.
3. Цель внутри `~/.claude` — это удаление ключей, памяти и истории сессий: не «ошибка»,
   а потеря всего, ради чего человек ставил Claude Code.
4. Если бы правку settings.json пустили общим путём удаления, сломанный или чужой
   конфиг переписывался бы молча; без самой правки хук-URL остаётся указывать на порт
   45832, где после удаления скрепки никто не слушает. **Масштаб этой потери кодом НЕ
   подтверждён.** «Четырнадцать хук-записей × 2,2 с ≈ полминуты мёртвого ожидания в
   каждой сессии» — цифры из комментариев того же кода, который спека документирует
   (`src/uninstall-exec.js:514-518`, `src/uninstall-targets.js:188-193`); другого
   источника у них в репозитории нет. Вшитый пак их не подтверждает: в
   `vendor/config-pack/.claude/settings.json` блок `hooks` (строки 205-228) содержит
   РОВНО ДВЕ записи — `PreToolUse` → `node "${HOME}/.claude/hooks/guard.js"` и
   `SessionStart` → `node "${HOME}/.claude/hooks/gsd-check-update.js"`, обе
   `"type": "command"`, ни одна не ходит на порт; подстроки `VSCODE_PORT` нет ни в
   одном из 9 765 файлов `vendor/config-pack/`. Откуда взяться четырнадцати HTTP-хукам,
   по репозиторию не прослеживается; `scripts/windows/mascot.ps1:60-62` указывает на
   другой источник — при отсутствующем `settings.json` «скрепка пропишет хуки сама при
   первом запуске». Чтобы цифра стала фактом, нужен замер на реальном конфиге.
5. Потеря `preserve`: у ученика исчезает прогресс курса (`sandbox`, `state.json`), у
   пользователя моста — SSH-настройки, и переустановка их не вернёт.
6. Рекурсивный `emptydir` снёс бы каталог курса вместе с сохраняемым прогрессом внутри:
   ровно тот случай, когда «удалил компонент» означает «удалил свою работу».
7. Снятие записи PATH при живом каталоге ломает чужие инструменты, которые её ждут;
   переписывание испорченно прочитанного PATH стирает чужие кириллические пути — и
   пользователь получает машину, где перестают находиться посторонние программы.
8. Удаление произвольного значения реестра — это снятие чужой автозагрузки: у человека
   молча перестаёт стартовать не наша программа.
9. Удаление строки по подстроке вырезало бы пользовательскую строку, внутри которой
   встретился наш маркер, — сломанный или изменившийся `~/.zshrc` у человека, который
   ничего такого не просил.
10. Без сверки идентичности под именем маскота может лежать чужая программа в
    `~/Applications` — удаление уносит её вместе с данными.
11. Без деактивации до удаления крах посередине оставляет маркер живым при снесённых
    файлах: UI считает компонент установленным, повтор установки идёт поверх обломков.
12. Оставшийся `.bak` воскрешает «удалённый» компонент при следующем чтении маркера
    (`recoverBak`), и человек видит кнопку «Удалить» у того, чего уже нет.
13. Тихо пропущенная цель неизвестного типа = «удалено» в отчёте при оставшемся на
    диске артефакте: ложный успех хуже отказа.
14. Снятие гейта на Nomad возвращает TOCTOU/data-loss риск сноса venv и шимов — можно
    затереть чужой uv-tool с тем же именем пакета.
15. Dry-run, который что-то делает, — это удаление без спроса у того, кто просил
    показать план.

## Границы

- Не удаляет Nomad: он ставится, но авто-удаление отключено (`UNINSTALL_DISABLED`), и
  ни одной цели для него не строится. Человек видит текст РАННЕГО ОТКАЗА обработчика
  («Авто-удаление компонента «nomad» в этой версии отключено — он остаётся
  установленным. Удали вручную при необходимости», `src/main.js:3182`), а не ноту:
  гейт `UNINSTALL_DISABLED` (`src/main.js:3181-3183`) возвращает ДО единственного в
  файле вызова `uninstallTargets` (`src/main.js:3209`), поэтому ветка `case 'nomad'`
  (`src/uninstall-targets.js:241-253`) вместе с её нотой
  (`src/uninstall-targets.js:251`) на пути деинсталляции недостижима — печатать ноты
  плана некому (`src/main.js:3216`). В UI кнопки «Удалить» у nomad нет вовсе:
  `REMOVABLE` его не содержит (`src/renderer/app.js:43`).
- Не удаляет `config`, `claude-code`, `node`, `git` и прочие компоненты: у них нет
  зашитой карты целей, `uninstallTargets` вернёт `null` и операция откажет.
- Не деинсталлирует Python, uv-окружения других инструментов и вообще что-либо, чего
  нет в per-component аллоулисте.
- На macOS не чистит `~/.local/bin` — только два файла внутри; общий каталог остаётся
  сознательно (`src/uninstall-targets.js:153`).
- На macOS без доступного vendor-бандла `.app` маскота НЕ удаляется — по коду это
  штатный fail-closed. Предложение удалить вручную человек видит только тогда, когда
  vendor не дал ИМЕНИ `.app`: тогда цели нет и печатается нота
  (`src/uninstall-targets.js:232`). Если имя есть, а `CFBundleIdentifier` из vendor
  вычислить не удалось, `.app` тоже не удаляется и ноты нет, но исход зависит от того,
  лежит ли бандл на месте: проверка существования стоит РАНЬШЕ проверки эталона
  (`src/main.js:3121`, `if (!fs.existsSync(t.path)) return { status: 'absent', … }`).
  Есть `~/Applications/<appName>.app` — цель отдаёт `failed` («ЗАЩИТА: нет эталонного
  CFBundleIdentifier», `src/main.js:3124`) и роняет всю деинсталляцию
  (`src/main.js:3256-3264`). Бандла там нет (перетащен в `/Applications`, снесён
  руками) — цель отдаёт `absent`, счётчик `failed` не растёт, и общий отказ приходит не
  отсюда, а от `hookurl` в пост-проверке (риск №1). Защита от удаления чужого `.app` в
  обеих ветках одинакова.
- Не откатывает частичное удаление: при провале возвращается только маркер установки,
  уже удалённые файлы обратно не появляются.
- Каталоги, где остались чужие или сохраняемые файлы, остаются на диске (`kept`) — это
  ожидаемое поведение, а не сбой.
- Возврат hook-url — не удаление, а замена подстроки в `settings.json`: механика
  подтверждена (`src/uninstall-targets.js:201-207` → `src/main.js:3077` →
  `src/uninstall-exec.js:525-562`), чужие записи и правки пользователя в файле не
  трогаются. Но подставляемая строка `127.0.0.1:VSCODE_PORT/hook` — НЕ «плейсхолдер
  пака»: в `vendor/config-pack/` её нет ни в одном файле, включая сам
  `vendor/config-pack/.claude/settings.json` (10 247 байт, ноль вхождений
  `VSCODE_PORT`). Обоснование «приводим конфиг к тому виду, в котором его раздаёт пак»
  (`src/uninstall-targets.js:195-198`) и та же посылка в установщике
  (`scripts/windows/mascot.ps1:50`, `scripts/macos/mascot.sh:174`) вшитым паком
  опровергаются; происхождение этого плейсхолдера по репозиторию не прослеживается.
  Обратимость («следующая установка скрепки снова подставит порт») держится только
  если хуки с `VSCODE_PORT` кто-то реально прописал: `mascot.ps1:71` меняет файл ТОЛЬКО
  при `$rawSettings.Contains($HOOK_OLD)`.
- Квитанция отвечает ровно на один вопрос — «ставил ли этот установщик компонент»; она
  не хранит версию артефактов на диске и не является инвентарём.

## Риски и открытые вопросы

1. **Пост-проверка не знает типа `hookurl` — удаление маскота всегда рапортует
   провал.** `verifyPostconditions` разбирает `file`, `dirtree`, `emptydir`, `reg`,
   `pathentry`, `profileline`, `launchagent`, `appbundle`, `killproc`, а всё прочее
   уходит в `default` → `problems.push('неизвестный тип цели в пост-проверке: …')`
   (`src/uninstall-exec.js:667-668`). План маскота содержит `hookurl` первой целью
   (`src/uninstall-targets.js:201-207`). Проверено запуском на этой машине:
   `verifyPostconditions` для плана `mascot` (win32) возвращает
   `{ ok: false, problems: ['неизвестный тип цели в пост-проверке: hookurl'] }`. В
   `main.js` это даёт `stillThere = true` → `restoreReceipt` → ответ `ok:false`
   (`src/main.js:3245-3264`). То есть при фактически успешном удалении человек видит
   «Не удалось удалить», маркер возвращается, кнопка «Удалить» остаётся, а файлы уже
   снесены; повтор пройдёт по `absent`-целям и упрётся в ту же пост-проверку. Учёт
   (`finalizeRemoval`, `manifest.removeEntry`) при этом не выполняется никогда.
2. **Нота маскота противоречит его же цели.** В том же `case 'mascot'` в план
   добавляется цель, правящая `~/.claude/settings.json`
   (`src/uninstall-targets.js:201-207`), и тут же — нота «Хуки в ~/.claude/settings.json
   НЕ трогаю (там могут быть твои правки)» (`src/uninstall-targets.js:237`). Обе строки
   печатаются человеку в одном логе удаления (`src/main.js:3216`, `3324`).
3. **Тестами не покрыт сквозной путь удаления маскота.** Тестовый исполнитель
   `execFsPlan` (test/run-tests.js) прогоняет только `file`, `emptydir`, `dirtree`,
   `profileline`; `hookurl`, `reg`, `pathentry`, `launchagent`, `appbundle` через него
   не проходят, а `verifyPostconditions` в связке с планом маскота не вызывается ни в
   одном тесте. Именно поэтому риск №1 живёт незамеченным: `restoreHookUrl` покрыт
   изолированно, связка «план маскота → пост-проверка → вердикт» — нет.
4. **Частичный провал оставляет расхождение диска и учёта.** Ветка
   `failed > 0 || stillThere` возвращает маркер, но не восстанавливает удалённое
   (`src/main.js:3256-3264`). Состояние «часть артефактов удалена, компонент числится
   установленным» штатно не разрешается ничем, кроме переустановки.
5. **`restoreReceipt` может не сработать**, и код это честно печатает («Отметка
   установки НЕ восстановилась»), но никакого дальнейшего сценария для человека нет.
6. **Остаток в карантине.** Если `removeDirTree` не смог удалить дерево И не смог
   вернуть его на место, каталог остаётся под именем `.hm-quar.<hex>` рядом с
   исходным; путь попадает в сообщение и лог, но автоматической уборки нет
   (`src/uninstall-exec.js:270-281`).
7. **Кнопка «Удалить» не гейтится идущим прогоном установки.** `STATE.runActive`
   используется только для inline-«Повторить» (`src/renderer/app.js:1802`);
   `renderInstalledActions` его не смотрит, и повторные клики по «Удалить» ничем не
   блокируются на стороне UI. Что произойдёт при параллельном запуске установки того
   же компонента — кодом не подтверждено, отдельной защиты в обработчике я не нашёл.
8. **Не подтверждено кодом:** что именно записано в `config.json` пака
   (`course.targetDirDefault`, `course.shortcutName`) — эти значения читаются из
   вшитого ресурса на рантайме, самого файла я не открывал; поведение при их отсутствии
   покрыто дефолтами (`~/HamidunCourse`, «Курс вайбкодинг (Claude Code)»).
