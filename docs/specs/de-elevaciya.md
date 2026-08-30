# Де-элевация

<!-- spec-id: de-elevaciya -->

- **Раздел:** Целостность и гейты
- **Код:** `scripts/windows/_deelev.ps1`, `src/staging-paths.js`, `src/main.js:1591-1944`, `src/main.js:300-341`, `src/main.js:995-1024`, `src/main.js:2164-2186`, `src/remote-fetch.js:296-331`, `scripts/windows/vscode.ps1:124-211`, `scripts/windows/extension.ps1:111-150`, `scripts/windows/bridge.ps1:60-160`, `scripts/windows/handy.ps1:43-100`, `scripts/windows/claude.ps1:88-110`, `scripts/windows/cursor.ps1:52-95`, `scripts/windows/git.ps1:74-105`, `scripts/windows/node.ps1:117-150`, `scripts/windows/pydeps.ps1:63-95`, `scripts/windows/claude-desktop.ps1:196-215`, `scripts/macos/_lib.sh`, `.github/workflows/staging-primitive.yml`, `test/staging-primitive.ps1`, `package.json`
- **Тесты:** «_deelev.ps1: НЕТ %TEMP% control-файлов; -EncodedCommand; PRIVATE staging; env-литералы до cmdlet; абс. whoami; gate; Last Result; fail-closed», «_deelev.ps1: round-trip — де-элевирует команду на MEDIUM (маркер содержит S-1-16-8192), Gate=medium; либо fail-closed $null», «_deelev.ps1: Test-HmExtInstalled — ^${extId}-<цифра> + Directory-only (helper НЕ проходит, файл НЕ проходит, <extId>-<ver> проходит)», «P0-D/P1-1 launch (main.js): -EncodedCommand + PRIVATE staging (нет %TEMP%); env-литералы; абс. whoami; gate; Last Result аттестация; folder-fallback; quoting пробела», «P0 regate#4: launch secure-dir атомарен (_deelev [IO.Directory]::CreateDirectory($dir,$sd) + main.js делегирует, нет fs.mkdirSync+icacls)», «P0 regate#4 (round-trip): New-HmSecureStagingDir -> каталог PROTECTED (наследование снято) без посторонних ACE; либо fail-closed $null», «P0 регресс: PSModulePath от pwsh 7 не ломает staging (модуль Security не требуется)», «P0 install (vscode.ps1): install-extension де-элевированно + FS-аттестация (Test-HmExtInstalled), НЕ через --list-extensions/вывод; fail-closed», «P0-A (extension.ps1): Cursor install де-элевированно + FS-аттестация (.cursor), НЕ --list-extensions; нет дубля VS Code; fail-closed», «ИНВАРИАНТ: нет user-writable control/attestation-файлов в trust-пути (_deelev.ps1 + main.js launch)», «_deelev.ps1: парсится Windows PowerShell 5.1 (боевой интерпретатор)», «_deelev.ps1: объявления ДО первого использования; авто-уборка стоит ПОСЛЕДНЕЙ», «_deelev.ps1 (поведение, PS 5.1): предикат сироты — возраст/состояние/исключение/fail-safe», «_deelev.ps1 (интеграция, реальный планировщик): сирота снесена; свежая/бегущая/исключённая целы», «_deelev.ps1: уборка staging — ТОЛЬКО через Remove-HmSecureStagingDir (подъём от w + шаблон имени, fail-closed)», «PS 5.1: Remove-HmSecureStagingDir(…\\w) сносит ВНЕШНИЙ HmDeElev-<hex>; постороннее имя цело (fail-closed)», «staging-paths: rmStagingTree сносит ВНЕШНИЙ HmDeElev-<hex>; чужое имя цело (fail-closed)», «main.js: все сносы staging идут через rmStagingTree, голого rmSync(stagingRootOf) нет», «main.js: путь вне %ProgramData% -> отказ БЕЗ удаления», «handy.ps1: согласие пишется ДЕ-ЭЛЕВИРОВАННО (HKCU админа — не тот пользователь), fail-closed», «Windows: vsix ставится из ЧИТАЕМОЙ пользователем копии (де-элевация не видит admins-only)», «главный процесс: примитив staging запускается с ДОВЕРЕННЫМ env (COR_PROFILER не наследуется)», «claude.ps1: офлайн-путь проверяется ЗАПУСКОМ claude --version (де-элевированно); сломанная обёртка убирается; финал БЕЗ квитанции при broken», «долгие шаги не выглядят зависшими: де-элевированная установка печатает отсчёт, сторож не обвиняет MSI», «причина отказа staging-каталога приходит в UTF-8», «_lib.sh: HM_PKG_INSTALL_SH + HM_APP_INSTALL_SH — root-staging (/var/root 0700), verify+install на STAGED, позиционные $N, fail-closed; verify_pkg_team_id удалён»

## Что обещает человеку

Установщик на Windows просит права администратора один раз и работает с ними всю
установку (`package.json:115`, `"requestedExecutionLevel": "requireAdministrator"`).
Обещание этой фичи: ни один файл, лежащий в личных папках пользователя
(`%LOCALAPPDATA%\Programs\…\Code.exe`, `Cursor.exe`, `python.exe` из пользовательской
установки, `code.cmd`), администраторскими правами **не запускается**. Такие программы
стартуют от имени обычного пользователя — ровно с теми правами, с какими человек
запускает их сам.

Практический смысл для человека простой: если на компьютере уже сидит что-то
недоброе, оно работает с обычными правами и подменить может только то, что лежит в
пользовательских папках. Установщик, получив права администратора, не становится для
такой программы лифтом наверх. Цена обещания — иногда честное «не смог»: когда
безопасный путь недоступен, шаг отказывается делать работу вместо того, чтобы сделать
её под администратором (в тексте шага дословно: «— пропускаю (fail-closed, НЕ
запускаю под админом).» — `vscode.ps1:191`, `extension.ps1:139`).

## Как работает

### Windows: единый примитив `Invoke-HmDeElevated` (`scripts/windows/_deelev.ps1`)

1. **Проверка своего уровня.** `Get-HmSelfIntegrity` вызывает абсолютный
   `System32\whoami.exe /groups` и по SID определяет уровень: `S-1-16-8192` = medium,
   `S-1-16-12288` = high, `S-1-16-16384` = system, `S-1-16-4096` = low. Неизвестный
   результат возвращает `'unknown'`. В `Invoke-HmDeElevated` из этого выводится
   `$elevated = ($selfLvl -ne 'medium' -and $selfLvl -ne 'low')` — то есть `unknown`
   трактуется как «мы под админом» (fail-safe).
2. **Чистое окружение родителя.** На время работы примитива `$env:PSModulePath` и
   `$env:Path` подменяются литералами, собранными из `$sysRoot` (System32,
   `WindowsPowerShell\v1.0`), и восстанавливаются в `finally`. Это защита от
   module-hijack через `HKCU\Environment`.
3. **Проверка наличия системных бинарей.** `powershell.exe`, `schtasks.exe`,
   `whoami.exe`, `icacls.exe` — все абсолютными путями из `$sysRoot\System32`.
   Отсутствие любого → `return $null`.
4. **Защищённый staging.** `New-HmSecureStagingDir` создаёт
   `%ProgramData%\HmDeElev-<32 hex>` с DACL `{SYSTEM, Administrators: FullControl}`,
   `SetAccessRuleProtection($true,$false)` и (при elevated) владельцем
   `S-1-5-32-544`, заданным **атомарно в SD** через
   `[System.IO.Directory]::CreateDirectory($dir, $sd)`.
   Ветвление: если атомарный путь бросил (нет `SeRestorePrivilege`, либо в
   PowerShell 7 нет такой перегрузки) — фолбэк «создать каталог → применить DACL
   отдельным дескриптором без владельца → `icacls /setowner *S-1-5-32-544`», и об
   этом печатается `HMSECNOTE`. После любого пути идут проверки: не
   reparse-point и каталог **пуст** — fail-closed безусловно; владелец =
   Administrators и «в DACL нет посторонних SID» — fail-closed **только при
   elevated**. Посторонний ACE всегда печатает `HMSECFAIL`, но снос каталога и
   `return $null` стоят внутри `if ($Elevated)` — и на самом `HmDeElev-<hex>`
   (`_deelev.ps1:265-277`, снос на `:273-275`), и на рабочем подкаталоге
   (`:337-348`, снос на `:344-346`). При `-Elevated $false` функция логирует
   посторонний SID и **продолжает**, возвращая путь на `:349`; комментарий в коде
   это признаёт прямо (`_deelev.ps1:271-272`: «Medium -> нет privesc (родитель уже
   medium), но такой ACE не должен появляться при protection on»).
   Наружу отдаётся **не** сам `HmDeElev-<hex>`, а
   подкаталог `w` внутри него — он рождается, когда родитель уже заперт, что
   обесценивает удержанный дескриптор родителя.
   Отдельная ветка: при `-Elevated $false` в DACL добавляется SID текущего
   пользователя (иначе medium-родитель не запишет `task.xml`), и проверка владельца
   пропускается.
5. **Тело обёртки — в `-EncodedCommand`.** Строится в `$body` как строка с
   **вбитыми литералами** (System32, whoami, целевой exe, аргументы — каждый через
   `'` → `''`), кодируется `[System.Text.Encoding]::Unicode.GetBytes` →
   `ToBase64String`. Первые две инструкции обёртки — присваивания `$env:PSModulePath`
   и `$env:Path` литералами, до них нет ни одного cmdlet.
6. **Гейт внутри обёртки.** `if(@(& '<абс. whoami>' /groups) -match 'S-1-16-8192')` —
   целевой бинарь запускается **только** при medium; иначе `exit 210`.
7. **Одноразовая задача планировщика.** `task.xml` пишется в staging, задача
   создаётся `schtasks /Create /TN <tag> /XML <файл> /F` (модуль `ScheduledTasks`
   не используется), XML удаляется сразу после `/Create`. В XML:
   `<UserId>` текущего интерактивного пользователя, `<LogonType>InteractiveToken</LogonType>`,
   `<RunLevel>LeastPrivilege</RunLevel>`, `<ExecutionTimeLimit>PT10M</ExecutionTimeLimit>`,
   `<Hidden>true</Hidden>`, `<RegistrationInfo><Date>` в формате `ToString('s')`.
8. **Аттестация.** Родитель опрашивает `schtasks /Query /TN <tag> /HRESULT /FO CSV /NH /V`
   и читает поле №6 («Last Result»): `267009` = выполняется, `267011` = ещё не
   запускалась, иное = exit-код обёртки. Дедлайн — 630 секунд; раз в минуту
   печатается строка «…устанавливается, прошло N мин». Результат — объект
   `{ Gate; Code }`: `'refused'` (Last Result = 210), `'unknown'` (родитель не
   дождался) и `'medium'` — **ветка `else`, catch-all для всего остального**
   (`_deelev.ps1:671-673`). То есть `Gate='medium'` НЕ доказывает, что обёртка
   отработала: служебные статусы планировщика (`SCHED_S_*`/`SCHED_E_*`,
   `0x8004130x`, `0x80070005` «отказано в доступе», коды аварийного завершения
   хоста задачи) приезжают тем же `Gate='medium'` с большим `Code`, хотя
   целевой бинарь не исполнялся вовсе. Разобрано в коде: комментарий
   `claude.ps1:103-121` — «Опрос в `_deelev.ps1` пережидает только 267009/267011 —
   остальные долетают сюда как Code при `Gate='medium'`… Статус ЗАДАЧИ ничего не
   доказывает про БИНАРЬ», поэтому `claude.ps1` отдельно отбрасывает сентинелы и
   всё, что вне 0..255, в `'unverified'` (`claude.ps1:112, 121`). Остальные
   вызывающие такой фильтрации не делают: `vscode.ps1:199` стартует вторую задачу
   ровно по признаку `Gate -eq 'medium'`.
9. **Уборка.** В `finally`: `schtasks /Delete`, удаление XML,
   `Remove-HmSecureStagingDir` (поднимается от `w` к родителю и удаляет только
   каталог с именем строго `HmDeElev-<32 hex>`), восстановление `PATH`/`PSModulePath`.
   Плюс при **каждой** загрузке файла (дот-сорс, последняя строка файла) вызывается
   `Remove-HmOrphanTasks` — подметает задачи `HmDeElev_*`/`HmLaunch_*` прошлых
   прерванных запусков. Решение «сирота или нет» принимает чистая функция
   `Test-HmTaskIsOrphan`: имя по шаблону `^Hm(DeElev|Launch)_[0-9a-fA-F]{8,64}$`,
   состояние не Running(4)/Queued(2), возраст ≥ 60 минут; возраст неизвестен →
   **не** удаляем.

### Windows: вторая точка входа — запуск редактора из главного процесса

`src/main.js`, функция `winLaunchDeElevated(exe, folderArg)` повторяет ту же схему
на JS: `winMakeSecureDir()` → `task.xml` (UTF-16LE + BOM) → `schtasks /Create /XML`
→ `/Run` → неблокирующий опрос `readLastResult()` с дедлайном 30 секунд. Обёртка
здесь запускает `Start-Process` и возвращает `exit 0` при старте, `211` при
исключении, `210` при не-medium. `true` возвращается **только** при Last Result `0`;
во всех прочих случаях — `folderFallback()`: `spawn` абсолютного
`<sysRoot>\explorer.exe` **на папку**, никогда на exe.

`winMakeSecureDir()` не создаёт каталог сам: она собирает инлайн-скрипт, дот-сорсит
вшитый `_deelev.ps1` (путь из `winDeElevScript()` → `resourceRoot()`) и зовёт
`New-HmSecureStagingDir -Elevated $true`, читая путь из маркера `HMSECDIR::…::END`.
Запуск асинхронный (`spawn`, таймаут 20 с), окружение — `detectSpawnEnv()`
(`src/main.js:2171`), а не унаследованное; stderr читается ради причины отказа
(`HMSECFAIL`), которая попадает в `lastSecureDirError` и в текст ошибки шага.
После возврата JS перепроверяет независимо: путь строго под ProgramData и
`remoteFetch.verifyDirSecureWin(dir)` (SID-based owner + DACL, `src/remote-fetch.js:303`).

Вызывают `winLaunchDeElevated`: `launchVsCodeOn()` (для найденного `Code.exe`, а если
его нет — для `Cursor.exe`) и IPC-обработчик `launch-cursor`.

### Windows: кто пользуется примитивом

- `vscode.ps1` / `extension.ps1` — установка расширений через CLI редактора.
  `$null` → шаг ставит `$script:DeElevFailed = $true` и печатает «пропускаю
  (fail-closed, НЕ запускаю под админом)». Успех подтверждается **файловой системой**
  (`Test-HmExtInstalled`: каталог `^<extId>-\d`, только каталоги), а не выводом бинаря.
  Ретрай через Marketplace гейтится **по-разному в двух файлах**. В `vscode.ps1:199`
  условие `if ($vsix -and $r.Gate -eq 'medium')` — вторая задача идёт, только когда
  первая доказанно завершилась; комментарий на `vscode.ps1:196-198` объявляет запуск
  при `'unknown'` недопустимым («вторая задача пошла бы поверх неё в тот же
  `~/.vscode/extensions` — конкурентная запись»). В `extension.ps1:144-146` условие
  — `if ($vsix) { … $r2 = Invoke-HmDeElevated $cli @('--install-extension', $extId,
  '--force') }`: `Gate` там не проверяется вовсе (подстрока `Gate` во всём файле
  `extension.ps1` встречается 0 раз). То есть при `Gate='unknown'` Cursor-ветка
  стартует вторую задачу поверх первой — ровно та конкурентная запись в каталог
  расширений, которую комментарий в `vscode.ps1` называет недопустимой.
- `claude.ps1` — проверочный запуск `claude --version` де-элевированно; при
  `$null` или `Gate -ne 'medium'` результат `'unverified'`, а не «сломано».
- `bridge.ps1` — `pip install`, import-check и `--selftest` пользовательского Python.
- `handy.ps1` — и чтение, и запись согласия на микрофон в
  `HKCU\…\ConsentStore\microphone\NonPackaged\…` через `reg.exe`: под админом это
  была бы **чужая** ветка реестра.
- `cursor.ps1`, `git.ps1`, `node.ps1`, `pydeps.ps1` — используют из того же файла
  только `New-HmSecureStagingDir` (Admins-only кэш докачки) и `Test-HmTrustedSigner`
  (`cursor.ps1:90`, `git.ps1:103`, `node.ps1:147`, `pydeps.ps1:94`); сам
  `Invoke-HmDeElevated` там не вызывается.
- `claude-desktop.ps1` — берёт из `_deelev.ps1` **только** `New-HmSecureStagingDir`
  (`claude-desktop.ps1:211`). `Test-HmTrustedSigner` он не вызывает ни разу: у него
  СВОЯ локальная функция с другим именем — `Test-HmSignerTrusted`
  (`claude-desktop.ps1:76`, вызов на `:246`), с дополнительным параметром
  `-PinnedThumbprint`, которого у примитива (`_deelev.ps1:375-380`) нет.
  `Invoke-HmDeElevated` здесь тоже не вызывается.

### Обратная сторона: vsix из admins-only кэша

`vscode.ps1`, `Get-Vsix`: в облегчённом издании .vsix лежит в скачанном паке,
распакованном в `HmDeElev-*` без ACE пользователя, и **medium-процесс прочитать его
не может**. Поэтому после `Confirm-HmArtifact` делается копия в `%TEMP%`, читаемость
проверяется `[System.IO.File]::OpenRead(...).Close()`, путь копится в
`$script:VsixTemps` и убирается в `finally`.

### macOS: инверсия вместо де-элевации

На macOS компонентные скрипты запускаются `/bin/bash <script>` из процесса Electron
(`src/main.js:1223`), который сам **не** повышен. Де-элевировать нечего: по умолчанию
всё уже идёт от пользователя, а привилегии берутся точечно через `admin_run`
(`scripts/macos/_lib.sh:38`) — `osascript … "do shell script … with administrator
privileges"`. Каждый argv-элемент квотируется (`shell_quote_arg`), затем строка
экранируется для AppleScript, а сам `osascript` запускается под
`/usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin HOME="$HOME"` — окружение
medium-шелла до root не доезжает.

Root-скрипты (`HM_PKG_INSTALL_SH`, `HM_APP_INSTALL_SH`, `HM_VSCODE_INSTALL_SH`)
устроены так, что root никогда не исполняет объект, лежащий в пользовательском
пространстве: сначала `mktemp -d /var/root/…`, затем `cp` артефакта в этот
root-owned staging, затем проверка (`pkgutil --check-signature` с якорем Team ID в
конце CN; `codesign --verify --deep --strict -R "=anchor apple generic and
certificate leaf[subject.OU] = \"$2\""` + `spctl --assess`) — и только потом
установка **ровно** проверенной копии. Внешние значения передаются позиционными
`$1/$2/$3`, инструменты — абсолютными путями с `|| exit 1`.

### CI-гейт

`.github/workflows/staging-primitive.yml` гоняет `test/staging-primitive.ps1` на
`windows-latest` **дважды**: боевым `System32\WindowsPowerShell\v1.0\powershell.exe`
(5.1) и `pwsh` 7 — потому что перегрузка `CreateDirectory(path, SD)` есть только в
5.1, то есть это разные ветки кода. Триггеры: `workflow_dispatch` и push в
`probe/**`/`e2e/**` при изменении `_deelev.ps1`, самого теста или workflow. При
падении печатается ACL на ProgramData и остатки `HmDeElev-*`. Сам файл теста
подменяет консольный stderr, чтобы поймать `HMSECFAIL`/`HMSECNOTE`, и выходит
1 при FAIL.

## Инварианты

1. **Целевой бинарь исполняется только при medium.** Обёртка сверяет
   `S-1-16-8192` абсолютным `System32\whoami.exe` и при несовпадении делает
   `exit 210`, не запуская ничего (`_deelev.ps1`, `$body`; `src/main.js`,
   `wrapperBody`).
2. **Ни одного control- или attestation-файла в общем `%TEMP%`.** Тело обёртки —
   целиком в `-EncodedCommand`; единственный транзиентный файл `task.xml` лежит в
   `%ProgramData%\HmDeElev-<hex>\w` и удаляется сразу после `/Create`
   (`_deelev.ps1`; `src/main.js:1792, 1861`).
3. **Результат берётся только из БД планировщика.** Признак успеха — поле №6
   «Last Result» из `schtasks /Query … /HRESULT /FO CSV /NH /V`, а не файл и не
   stdout бинаря (`_deelev.ps1`; `readLastResult()` в `src/main.js:1844`).
4. **Staging-каталог рождается атомарно защищённым.** DACL `{S-1-5-18, S-1-5-32-544}`
   + `SetAccessRuleProtection($true,$false)` + владелец в SD при elevated —
   одной операцией `[System.IO.Directory]::CreateDirectory($dir, $sd)`
   (`New-HmSecureStagingDir`). `fs.mkdirSync` + post-`icacls` в JS отсутствует
   (`winMakeSecureDir` только делегирует).
5. **Любой сбой примитива = отказ, а не запуск под админом.** `$null` возвращается
   при отсутствии системного бинаря, незапертом staging, провале
   `schtasks /Create` или `/Run`, исключении. Все вызывающие проверяют
   `$null -eq $r` или `Gate -ne 'medium'` перед тем, как считать работу сделанной
   (`vscode.ps1:190`, `extension.ps1:137-146`, `bridge.ps1:78,83,143`,
   `handy.ps1:75,87`, `claude.ps1:101`).
6. **Успех установки подтверждается диском, а не выводом бинаря.**
   `Test-HmExtInstalled` ищет каталог `^<extId>-\d` (`-Directory`, ordinal
   regex-match) — вывод `--list-extensions` не используется вовсе
   (`_deelev.ps1:59`, `vscode.ps1:169, 186`, `extension.ps1:120`).
7. **Окружение привилегированных вызовов доверенное, не унаследованное — но не
   у всех вызовов.** `env: detectSpawnEnv()` получают три точки: `spawn` примитива
   staging, `execFileSync` для `schtasks /Create|/Run|/Delete` и `execFileSync` для
   `schtasks /Query` (`src/main.js:1710, 1796, 1847`). Внутри самого примитива
   `PATH`/`PSModulePath` перебиты литералами и восстановлены в `finally`.
   Квантор «все» здесь НЕ выполняется: в том же `winLaunchDeElevated`
   `folderFallback` запускает explorer с полностью унаследованным окружением —
   `spawn(exp, [String(folderArg)], { detached: true, stdio: 'ignore',
   windowsHide: true })` (`src/main.js:1772`, поля `env` нет). Вторая такая точка —
   `spawnSync('explorer.exe', [dir])` в `launchVsCodeOn` (`src/main.js:1916`, см.
   «Риски» №1). Отдельно: `verifyDirSecureWin`, на которую опирается независимая
   перепроверка каталога, собирает окружение своим `trustedEnv()`, а не
   `detectSpawnEnv()` (`src/remote-fetch.js:324`).
8. **Задача планировщика — одноразовая и подметаемая.** `Remove-HmOrphanTasks`
   вызывается при каждой загрузке `_deelev.ps1` и удаляет только имена по шаблону
   `^Hm(DeElev|Launch)_[0-9a-fA-F]{8,64}$`, не Running/Queued, старше 60 минут;
   неизвестный возраст → не трогаем (`Test-HmTaskIsOrphan`).
9. **Уборка staging сносит внешний каталог, а не только `w`, и обе стороны
   fail-closed по имени.** `Remove-HmSecureStagingDir` (`_deelev.ps1:113-125`)
   поднимается от `w` к родителю (`:118-120`) и удаляет каталог **только** если имя
   совпало с `^HmDeElev-[0-9a-f]{32}$` (`:122`), иначе выходит молча. То же в JS —
   `src/staging-paths.js`: `stagingRootOf()` поднимается к родителю **лишь когда
   родитель действительно наш staging**, а `rmStagingTree()` сверяет имя и
   возвращает `false`, ничего не тронув, при любом несовпадении. Все четыре
   потребителя в `src/main.js` зовут только `rmStagingTree` — голого
   `fs.rmSync(stagingRootOf(…))` в файле не осталось, это сторожит тест.

   **Так было не всегда.** До 30.08 гейт стоял только в PowerShell, а JS делал
   лишь первую половину: `path.basename(s) === 'w' ? path.dirname(s) : s` без
   единой проверки имени, и все потребители сносили результат рекурсивно. То есть
   `stagingRootOf('<…>\ProgramData\w')` отдавал `<…>\ProgramData` прямо в
   `fs.rmSync(…, { recursive: true, force: true })` под админом. Нашлось при
   независимом опровержении этой же спеки: агент читал код, а не пересказ.

10. **Проверка границы `%ProgramData%` отказывает, а не удаляет.** Если примитив
    вернул путь вне `%ProgramData%`, `winMakeSecureDir` пишет причину в
    `lastSecureDirError` и возвращает `null`, **не трогая каталог**.

    До 30.08 эта ветка вызывала `rm()`. Разбор стоит того, чтобы его назвать:
    проверка, обнаружившая путь не там, где ему положено быть, отвечала на находку
    рекурсивным удалением этого пути — под админом. Страховка от выхода за границу
    сама была примитивом «снести каталог, оказавшийся не нашим», то есть работала
    ровно против своей цели. Правильный ответ на «путь не наш» — не удалять его.

11. **Удаление чужих каталогов невозможно.** `pruneStaleSecureDirs()`
    (`src/main.js:318`) требует одновременно: имя `^HmDeElev-[0-9a-f]{32}$`,
    не symlink, «остыл» ≥ 6 часов и `verifyDirSecureWin(dir)` = true. Свою копию
    шаблона (с флагом `/i`) она держит намеренно — это подметание мусора ПРОШЛЫХ
    запусков, а не уборка своего staging, и защищено оно ещё тремя условиями.
    Единственный источник шаблона для СВОЕЙ уборки — `STAGING_NAME` в
    `src/staging-paths.js`.
12. **macOS: root исполняет только root-owned проверенную копию.** Каждый из трёх
    `HM_*_INSTALL_SH` сначала копирует артефакт в `mktemp -d /var/root/…`, потом
    проверяет подпись именно staged-объекта, потом ставит именно его
    (`scripts/macos/_lib.sh:302-352`).
13. **macOS: root-шелл стартует из стёртого окружения.** `admin_run` запускает
    `osascript` под `/usr/bin/env -i` с фиксированным `PATH`
    (`scripts/macos/_lib.sh:66`), а каждый root-скрипт первой строкой ещё раз
    фиксирует `PATH` (defense-in-depth).

## Что ломается, если инвариант нарушить

1. **Гейт medium убран.** Задача, ушедшая на high (встроенный Administrator, UAC
   выключен), запустит `Code.exe`/`Cursor.exe`/`python.exe` из папки пользователя с
   правами администратора. Программа, заранее подложенная на это место обычным
   пользователем, получает полный контроль над машиной — человек при этом видит
   обычную успешную установку.
2. **Control-файл вернулся в `%TEMP%`.** Файл там можно создать **заранее**, сохранив
   свой DACL; наша запись перезапишет содержимое, но не права. Дальше в `task.xml`
   меняется `LeastPrivilege` → `HighestAvailable` и `<Command>` на чужой бинарь — и
   администраторские права уезжают чужой программе. Для человека это выглядит как
   «установщик поставил редактор».
3. **Успех читается из stdout.** Пользовательская программа может напечатать что
   угодно. Установщик отрапортует «расширение на месте», человек откроет редактор и
   не найдёт панели Claude — а на экране установки будет зелёная галочка.
4. **Каталог создаётся неатомарно.** Между `mkdir` и назначением прав каталог
   наследует права ProgramData, где обычный пользователь может создавать файлы.
   Успевший туда файл (или удержанный на него дескриптор) подменяет `task.xml` или
   скачанный `.zip` — установщик распакует и запустит не то, что скачал.
5. **Сбой трактуется как «можно под админом».** Ровно тот случай, ради которого
   фича существует: под администратором запустится user-writable бинарь. Правильное
   поведение — сказать человеку «пропускаю», и он поставит расширение вручную из
   панели Extensions (текст с инструкцией уже печатается).
6. **Аттестация по выводу CLI.** Чтобы прочитать `--list-extensions`, придётся
   запустить редактор из-под администратора — то есть нарушить инвариант 1 ради
   проверки инварианта 1.
7. **Унаследованное окружение.** `COR_ENABLE_PROFILING`/`COR_PROFILER_PATH` читаются
   CLR при старте хоста, **до** разбора `-Command`, а пишутся в `HKCU\Environment`
   без запроса прав: чужая DLL загрузится в `powershell.exe`, запущенный нами под
   администратором. Инлайн-присваивание `$env:PSModulePath` от этого не спасает.
8. **Сироты не подметаются.** Каждый прерванный запуск оставляет скрытую задачу в
   планировщике пользователя навсегда. Через десяток прерванных установок список
   задач замусорен, и человек не может понять, что из этого его.
9. **Уборка сносит только `w`.** В `%ProgramData%` остаются пустые каталоги
   `HmDeElev-*` с правами «только администраторы» — сам обычный пользователь удалить
   их не может. Накопления, однако, не происходит: их подметает
   `pruneStaleSecureDirs()` (`src/main.js:318-341`) — имя
   `^HmDeElev-[0-9a-f]{32}$` (`:325`), не symlink (`:329`), ничего не менялось ≥ 6
   часов (`:323, :336`), `verifyDirSecureWin(dir)` = true (`:337`) →
   `fs.rmSync(dir, { recursive: true, force: true })` (`:338`), и вызывается она на
   КАЖДОМ запуске установщика (`src/main.js:369`). Пустой каталог с
   owner = `S-1-5-32-544` и ACE только `{S-1-5-18, S-1-5-32-544}` эту проверку
   проходит по построению (`src/remote-fetch.js:309, 318-322`). Не подметётся лишь
   каталог, рождённый при `-Elevated $false`: там в DACL намеренно добавлен SID
   пользователя (`_deelev.ps1:156-165`), и `verifyDirSecureWin` его отвергнет.
   Цена нарушения инварианта — не «мусор до переустановки Windows», а до шести
   часов и одного запуска установщика.
10. **Проверка границы отвечает удалением.** Ветка «путь вне `%ProgramData%`»,
    зовущая уборку, делает из ошибки катастрофу: любой путь, который примитив вернул
    не оттуда, откуда положено, немедленно сносится рекурсивно с правами
    администратора. Сбой парсинга `HMSECDIR::…::END`, подстановка в вывод, ошибка в
    вычислении пути — всё это перестаёт быть отказом установки и становится потерей
    данных. Именно так этот код и был написан до 30.08.
11. **Шаблон имени ослаблен.** Удаление под администратором превращается в примитив
    «стереть произвольный каталог»: `%ProgramData%` доступен обычным пользователям на
    создание, значит junction на чужую папку туда подкладывается заранее. До 30.08
    в JS этого шаблона не было вовсе — снос шёл по вычисленному пути без проверки
    имени, и `<любой каталог>\w` превращался в удаление этого каталога.
12. **macOS: проверка не на staged-копии.** Между проверкой подписи и установкой
    процесс того же пользователя подменяет `.pkg`/`.app` (пока открыт диалог пароля —
    времени достаточно), и root ставит другие байты. Человек получает подписанный на
    вид, а фактически подменённый пакет.
13. **macOS: окружение утекает в root.** `BASH_FUNC_mktemp%%=() {…}` перекрывает
    системную команду до всякого `PATH`, `ENV`/`BASH_ENV` подгружаются на старте
    `/bin/sh`, `SHELLOPTS=xtrace` + `PS4='$(payload)'` исполняет подстановку перед
    первой командой — всё это выполнится как root ещё до строки с проверкой подписи.

## Границы

- Фича описывает **направление вниз** (админ → пользователь). Проверка целостности
  вшитых артефактов (`Confirm-HmArtifact`, `verify_artifact`, `checksums.json`) и
  гейт Authenticode/codesign — соседние фичи; `Test-HmTrustedSigner` физически лежит
  в `_deelev.ps1`, но относится к онлайн-загрузкам, а не к де-элевации.
- **`bridge.ps1` намеренно не использует примитив для запуска трея.** Трей —
  долгоживущий процесс, а `Invoke-HmDeElevated` блокирует и удаляет одноразовую
  задачу. Вместо этого пишется `launch-bridge.cmd` в `%LOCALAPPDATA%\HamidunBridge`
  и запускается `Start-Process "$env:WINDIR\explorer.exe" <launchCmd>` — explorer
  стартует `.cmd` токеном оболочки. Уровень тут не проверяется кодом вовсе:
  де-элевация держится на поведении explorer, а не на гейте. Эскалации это не даёт
  (сам `.cmd` лежит в пользовательской папке и исполняется в пользовательском
  контексте), но и гарантии «исполнилось ровно наше содержимое» здесь нет.
- **`folderFallback` тоже опирается на поведение explorer**, а не на проверку:
  комментарий в `src/main.js:1767` утверждает, что explorer наследует токен
  оболочки (medium). Кодом это не подтверждается — гейта на уровень там нет. Мера
  предосторожности другая: в fallback открывается **только папка**, exe не
  передаётся никогда.
- **`Get-HmSelfIntegrity` знает про low, обёртка — нет.** Родитель с уровнем `low`
  считается неэлевированным (`$elevated = $false`, `_deelev.ps1:554`), а гейт в
  обёртке пропускает только `S-1-16-8192` (`_deelev.ps1:572`). Асимметрия в коде на
  этом и заканчивается: на уровень целостности самой обёртки уровень родителя не
  влияет. Обёртку запускает планировщик по принципалу задачи —
  `<LogonType>InteractiveToken</LogonType>` + `<RunLevel>LeastPrivilege</RunLevel>`
  (`_deelev.ps1:604-605`), то есть отфильтрованным токеном интерактивного
  пользователя, а это medium. Гейт увидит `S-1-16-8192` и пропустит →
  `Gate='medium'`. Второй возможный исход при low-родителе — `$null`: low-процесс не
  пишет в `%ProgramData%`, `New-HmSecureStagingDir` отдаёт `$null` — но не через
  ветку «не удалось создать каталог даже фолбэком» (`_deelev.ps1:196-197`), а через
  **внешний catch функции** (`_deelev.ps1:350-356`, текст `HMSECFAIL: <сообщение
  исключения>`): `[void][System.IO.Directory]::CreateDirectory($dir)` на `:194` не
  обёрнут в try/catch, а отказ в доступе бросает `UnauthorizedAccessException`, и в
  PowerShell исключение .NET-метода терминирующее. Ветка `:196-197` достижима лишь
  тогда, когда `CreateDirectory` вернулась БЕЗ исключения, а каталога нет. Дальше
  примитив выходит на `:584`. `Gate='refused'` из-за
  low-родителя не получится ни на одной ветке: `'refused'` присваивается
  ИСКЛЮЧИТЕЛЬНО при Last Result = 210 (`_deelev.ps1:672`), а 210 отдаёт обёртка,
  чей уровень от родителя не зависит.
- **XML в `winLaunchDeElevated` не содержит `<RegistrationInfo><Date>`** — в отличие
  от XML в `_deelev.ps1`. Возраст задач `HmLaunch_*` определяется по `CreationTime`
  файла в `System32\Tasks`; это прямо оговорено в комментарии `_deelev.ps1:455-457`.
- **Полного E2E de-elevation-теста на реальной elevated-Windows нет** — но не потому,
  что round-trip гоняется только вручную. Отдельный workflow `staging-primitive.yml`
  действительно проверяет **только** `New-HmSecureStagingDir`, а не весь примитив.
  Однако round-trip самого `Invoke-HmDeElevated` (с реальной задачей планировщика,
  `test/run-tests.js:1150`) входит в **обязательный** CI-гейт: `unit-tests.yml`,
  джоба `unit-tests-windows` на `windows-latest`, шаг «Юнит-тесты — ОБЯЗАТЕЛЬНЫЙ гейт
  (без continue-on-error)» гоняет `npm test` (`package.json:27` →
  `node test/run-tests.js`) на push и pull_request в `main`, а `gate` объявлен
  единственной обязательной проверкой ветки. Тест стоит под
  `if (powershellAvailable())` (`test/run-tests.js:1149`), а `powershellAvailable()`
  (`:2167-2172`) истинна на любом win32 с рабочим `powershell.exe` — то есть и на
  раннере. Оговорка: джоба идёт только при `changes.outputs.code == 'true'`, поэтому
  PR, правящий одни документы, её не поднимает. Слабое место в другом: тест
  принимает `$null` и `refused` как валидный исход (`test/run-tests.js:1162-1169`),
  и на машине, где задача не создаётся или не даёт medium, прогон зелёный без
  фактической де-элевации.
- Дедлайны — 630 с у примитива (при `ExecutionTimeLimit` 10 минут), 30 с у запуска
  редактора, 20 с у создания staging из JS, 60 минут порог сироты. За этими границами
  результат становится `unknown`/fallback, а не ошибкой.
- macOS не имеет ни планировщика-обёртки, ни integrity-гейта: там модель другая —
  процесс изначально непривилегированный.

## Риски и открытые вопросы

1. **`launchVsCodeOn` запускает `explorer.exe` по короткому имени.**
   `src/main.js:1916`: `spawnSync('explorer.exe', [dir], { stdio: 'ignore', timeout: 10000 })`
   — без абсолютного пути и без `detectSpawnEnv()`, то есть с унаследованным `PATH`
   в elevated-процессе. Соседний `folderFallback` в том же файле
   (`src/main.js:1768-1776`) делает обратное только в части пути:
   `path.join(sysRoot, 'explorer.exe')` — абсолютный, но `env` там тоже нет
   (`src/main.js:1772`, см. инвариант 7). Ветка достижима, когда
   не найден ни `Code.exe`, ни `Cursor.exe`. Тест «P0-D/P1-1 launch (main.js): …»
   проверяет абсолютный explorer только внутри среза `winLaunchDeElevated` (до
   комментария «Открыть VS Code НА ПАПКЕ»), а срез `lvh` для `launchVsCodeOn`
   ограничен 900 символами от начала функции — эта строка в него не попадает.
2. **Копия vsix кладётся в общий `%TEMP%`** (`vscode.ps1:144`) — с случайным GUID в
   имени и проверкой читаемости, но это единственное место фичи, где артефакт
   покидает защищённый каталог. Комментарий обосновывает это тем, что vsix и так
   исполняется редактором при medium; отдельной проверки того, что скопированный
   файл совпадает с проверенным оригиналом, после `Copy-Item` нет.
3. **Round-trip-тесты примитива допускают `$null` как успех.** Заголовки прямо
   содержат «либо fail-closed $null». Это честно, но означает: зелёный прогон не
   доказывает, что де-элевация на этой машине работает — только что она не делает
   ничего опасного.
4. **Фолбэк `icacls /setowner` в `New-HmSecureStagingDir` не проверяет свой exit-код**
   (`& $Icacls $dir '/setowner' … *> $null`). Ошибку ловит следующая проверка
   владельца — но только при `$Elevated`; при medium владелец не проверяется вовсе.
5. **`Remove-HmOrphanTasks` полностью best-effort**: весь тело обёрнуто в `try{}catch{}`
   без единого сообщения, включая `$root.DeleteTask`. Если удаление стабильно падает
   (нет прав на задачу), это никак не видно ни в логе, ни пользователю.
6. **Что делает `Gate='unknown'` с точки зрения человека, описано только в
   `vscode.ps1`** («установка пока не отчиталась… проверь панель Extensions позже»).
   В `bridge.ps1` и `handy.ps1` `unknown` попадает в общую ветку неуспеха, и человек
   получает «не удалось» там, где работа, возможно, ещё идёт.
7. **Не подтверждено кодом**: утверждение инвентаря про «отдельный CI-гейт на
   де-элевацию». Гейт существует
   (`.github/workflows/staging-primitive.yml`), но его предмет — конструктор
   защищённого каталога, а не гейт integrity и не задача планировщика.
