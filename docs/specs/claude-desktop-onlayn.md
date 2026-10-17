# Claude Desktop (онлайн)

<!-- spec-id: claude-desktop-onlayn -->

- **Раздел:** Установка компонентов
- **Код:** `components.json:284-305`, `scripts/windows/claude-desktop.ps1`, `scripts/macos/claude-desktop.sh`, `scripts/windows/_deelev.ps1:127-139`, `src/main.js:3188-3193`, `src/main.js:682-686`, `src/install-receipts.js:34-58`, `src/renderer/app.js:43`, `mac-arch-support.json:135-140`, `tools/sync-sizes.js:141-142`
- **Тесты:** «components: claude-desktop + chatgpt-desktop опциональны (default:false), online, platforms win32+darwin», «claude-desktop.ps1: secure-cache (НЕ %TEMP%); НАДЁЖНАЯ подпись (chain→LocalMachine\\Root + exact O= + EKU) ДО запуска; exit 120; идемпотентно; cleanup», «claude-desktop.sh: абсолютные /usr/bin/codesign + /usr/sbin/spctl (require, fail-closed) + Team ID + bundle id ДО ditto; curl https; exit 120», «grep-инвариант: нет download-в-user-writable + нет запуска бинаря без проверки подписи», «6b: нет spoofable substring-пина подписи + есть проверяемая криптоцепочка (все 4 desktop-скрипта)», «main.js: detectComponents знает claude-desktop и chatgpt-desktop (идемпотентность)», «claude-desktop.ps1: вердикт через Wait-HmClaudeDesktopVerdict (факт завершения процесса), гоночный опрос 90 c убран, вечного ожидания нет», «claude-desktop.ps1 (прогон PS 5.1): вердикт ждёт живой процесс, НЕ ждёт вечно, успех — сразу по маркеру», «Windows: установщики, САМИ запускающие приложение, идут БЕЗ -Wait», «Windows: НИ ОДИН сетевой вызов без -TimeoutSec (дефолт = бесконечность)», «lite: тяжёлые компоненты авто-remote по реестру; uv bundled-only»

## Что обещает человеку

Галочка ставит нативное приложение Claude отдельным окном на рабочем столе. Приложение
не вшито в установщик, а качается во время установки с сайта Anthropic — поэтому по
умолчанию галочка снята (`components.json:295` `"default": false`), а в карточке стоит
пометка «скачивается во время установки» (`components.json:304`). Компонент ни от чего
не зависит (`"requires": []`, `components.json:297`) и доступен только на Windows и
macOS (`"platforms": ["win32","darwin"]`, `components.json:300-303`).

Обещание, за которое можно спросить: чужой установщик не будет запущен, пока его
подпись не подтверждена. На Windows проверяется Authenticode — цепочка сертификатов
до корня в машинном сторе, точное поле `O=Anthropic, PBC` и EKU Code Signing (общая функция `Test-HmTrustedSigner`, `scripts/windows/_deelev.ps1:467-548`; вызывается из `scripts/windows/claude-desktop.ps1:206`). На macOS — Developer ID с Team ID
`Q6L2SF6YDW`, bundle id `com.anthropic.claudefordesktop` и обязательная нотаризация
(`scripts/macos/claude-desktop.sh:88-111`). Любая невыполненная проверка означает, что
компонент будет пропущен, а не поставлен «на авось». Второе обещание: пропуск не
красит установку в ошибку — нет сети или подпись не сошлась, шаг честно помечается
пропущенным (код 120), остальные компоненты ставятся дальше.

## Как работает

Общий каркас одинаков на обеих платформах: `main.js` находит скрипт по имени
компонента — `scripts/<windows|macos>/<id>.<ps1|sh>` (`src/main.js:682-686`), сверяет,
что компонент разрешён на этой платформе (`src/main.js:1056-1060`), и что файл скрипта
существует (`src/main.js:1065-1068`). Код возврата 120 разбирается как «осознанно
пропущен»: `EXIT_SKIP = 120` и `isSkipExit` (`src/install-receipts.js:34-35`),
`const skipped = receipts.isSkipExit(code)` (`src/main.js:1549`); при таком коде маркер
установки и запись в манифест НЕ пишутся (`shouldRecordInstall`,
`src/install-receipts.js:36-58`).

Компонент не значится в реестре докачки: тест «lite: тяжёлые компоненты авто-remote по
реестру; uv bundled-only» проверяет, что для `claude-desktop` записи в реестре нет —
скачивает не `main.js`, а сам скрипт компонента.

**Windows (`scripts/windows/claude-desktop.ps1`).**

1. Скрипт подключает `_deelev.ps1` (строка 62) ради `New-HmSecureStagingDir`, `Remove-HmSecureStagingDir` и общей проверки подписи `Test-HmTrustedSigner`.
2. `Test-ClaudeDesktopInstalled` (строки 85-105) ищет `claude.exe` в
   `%LOCALAPPDATA%\AnthropicClaude` и `%LOCALAPPDATA%\Microsoft\WindowsApps`, затем
   рекурсивно внутри `AnthropicClaude`, затем спрашивает `Get-AppxPackage` про пакет с
   именем, содержащим `Claude`, и издателем, содержащим `Anthropic`. Нашлось — печать
   «уже установлен» и `exit 0` (строки 186-189), ничего не качается.
3. Развилка архитектуры (строки 192-193): `$env:PROCESSOR_ARCHITECTURE` совпал с
   `ARM64` → arm64-эндпоинт, иначе x64. Оба URL — официальные редиректы
   `https://claude.ai/api/desktop/win32/<arch>/setup/latest/redirect` (строки 65-66).
4. Развилка dry-run (строки 195-198): `$DRY = [bool]$env:HM_DRY_RUN` (строка 62) →
   печатается строка «что было бы сделано» и `exit 0`, сеть не трогается.
5. Готовятся системные пути: `SystemRoot\System32\icacls.exe` и корневой `ProgramData`
   (строки 201-205). Чего-то нет → `exit 120` с советом поставить вручную (207-209).
6. `New-HmSecureStagingDir -Elevated $true` (строка 211) создаёт свежий каталог
   `%ProgramData%\HmDeElev-<32 hex>` с владельцем Administrators и DACL
   {SYSTEM, Administrators}, protection on, и возвращает вложенный рабочий подкаталог
   `w` (`scripts/windows/_deelev.ps1:307`). Вернулся `$null` → `exit 120` (212-215).
7. Скачивание (строки 220-236): включается TLS 1.2, URL проверяется на префикс
   `https://`, `Invoke-WebRequest -OutFile $installer -MaximumRedirection 5
   -TimeoutSec 600` пишет файл в `$cache\ClaudeSetup.exe` (строка 217). Исключение или
   отсутствие файла → `exit 120`. Причина при исключении называется по факту (с
   06.10.2026): код ответа из `$_.Exception.Response.StatusCode`; 403/451 — «сервер
   Anthropic отказал в скачивании… это не обрыв сети», с советом про VPN на весь
   компьютер; другой HTTP-код — «сервер ответил ошибкой HTTP N»; ответа нет вовсе — «нет
   соединения с сервером». Раньше на всё печаталось «(нет сети?)», и в живом журнале
   «(403) Запрещено» от Anthropic выглядело как обрыв интернета.
8. Санити размера (строки 197-202): меньше 20 МБ или больше 900 МБ → `exit 120`.
9. Гейт подписи (строки 204-210) — `Test-HmTrustedSigner -Path $installer
   -ExpectedOrg $PUBLISHER_O -ExpectedThumbprint $LEAF_THUMBPRINT`. Своей копии проверки в
   скрипте больше нет (до 10.10.2026 здесь жила локальная `Test-HmSignerTrusted`): гейт —
   общая функция примитива (`scripts/windows/_deelev.ps1:467-548`). Внутри по порядку:
   `Get-AuthenticodeSignature` со `Status -eq 'Valid'`; цепочка листа через
   `Get-HmSignerChainRoot` (`_deelev.ps1:401-431`: `IgnoreNotTimeValid`, `ApplicationPolicy`
   Code Signing, `RevocationMode = NoCheck`; срок КАЖДОГО звена считается отдельно —
   `OutOfWindow`); отпечаток корня обязан лежать в списке `Get-HmMachineRootThumbprints`
   (`_deelev.ps1:375-383`, только `StoreLocation::LocalMachine`); для цепочки со звеном
   вне срока — метка времени, чья цепочка (EKU Time Stamping) тоже кончается в
   `LocalMachine\Root`; EKU `1.3.6.1.5.5.7.3.3`; разбор RDN `O=` из
   `SubjectName.Format($true)` со снятием кавычек, которые .NET ставит вокруг значения с
   запятой, и точное сравнение с `Anthropic, PBC`; необязательный пин отпечатка листа,
   включаемый только если `$LEAF_THUMBPRINT` непуст (по умолчанию строка 72 — пустая).
   Функция возвращает пустую строку при успехе и текст причины при отказе; непустая
   причина → `exit 120`.
10. Запуск (строки 222-228): `Start-Process -FilePath $installer -WorkingDirectory $cache -PassThru`, намеренно **без** `-Wait` (объяснение в комментарии 213-221:
    `-Wait` ждёт всё дерево потомков, а Claude уходит в трей и живёт). Рабочий каталог
    процесса — защищённый кэш.
11. Вердикт (строка 234) — `Wait-HmClaudeDesktopVerdict -Proc $cdProc -CapSec 300 -GraceSec 90` (функция 116-132). Цикл раз в секунду: маркер найден → `$true`
    немедленно; процесс ещё жив → ждём; процесс вышел → расходуется грейс 90 секунд;
    исчерпан потолок 300 секунд → последняя проверка маркера.
12. Успех: печать `OK: Claude Desktop установлен.`, при наличии каталога —
    `HM-RECEIPT path <%LOCALAPPDATA%\AnthropicClaude>`, `$rc = 0` (235-240). Неуспех разводится на два разных текста — установщик ещё работает (245) или уже вышел (247), `$rc = 120`.
13. `finally` (251-259): ограниченное ожидание процесса `Wait-Process -Timeout 120`,
    затем `Remove-HmSecureStagingDir -Path $cache`. Помощник поднимается от подкаталога
    `w` к внешнему каталогу и удаляет только имя строго вида `HmDeElev-<32 hex>`
    (`scripts/windows/_deelev.ps1:127-139`).

**macOS (`scripts/macos/claude-desktop.sh`).** Путь другой: элевации нет вообще,
приложение ставится в `~/Applications` под токеном пользователя (строки 41-42).

1. Идемпотентность (45-48): существует `/Applications/Claude.app` или
   `~/Applications/Claude.app` → `exit 0`.
2. Dry-run (50-53) → печать плана и `exit 0`.
3. Рабочий каталог — `mktemp -d` + `chmod 700` (56-58), уборка через `trap cleanup
   EXIT` (62-66), которая отмонтирует образ и удалит каталог.
4. Скачивание `curl -fsSL --proto '=https' --tlsv1.2 --max-time 900` с эндпоинта
   `https://claude.ai/api/desktop/darwin/universal/dmg/latest/redirect` (34, 70).
   Ошибка → `exit 120`. Размер меньше 20 000 000 байт → `exit 120` (74-75).
5. `hdiutil attach -nobrowse -readonly` (79-83) и поиск `*.app` на глубине 1 (84-85);
   любая неудача → `exit 120`.
6. Гейт `verify_desktop_app` (88-111): сначала требуется существование и
   исполняемость `/usr/bin/codesign` и `/usr/sbin/spctl` — их отсутствие даёт отказ, а
   не пропуск проверки (91-96); затем `codesign --verify --deep --strict -R "=anchor
   apple generic and identifier "com.anthropic.claudefordesktop" and certificate
   leaf[subject.OU] = "Q6L2SF6YDW""` (102-105); затем `spctl --assess --type execute
   -vv` (107-109). Функция вызывается ДВАЖДЫ: на образе (112) и повторно на
   staging-копии перед подменой (125-129).
7. Установка (116-135): `ditto` образа в `~/Applications/.claude-desktop-staging.app`,
   повторная проверка копии, `rm -rf` цели, `mv` staging → `~/Applications/Claude.app`.
   Любой сбой → удаление staging и `exit 120`.
8. Снятие карантина `xattr -dr com.apple.quarantine` (136), квитанции `HM-RECEIPT path`
   и `HM-RECEIPT teamid` (139-140), `exit 0`.

Архитектурной развилки на macOS нет по конструкции: `mac-arch-support.json:135-140`
помечает компонент `"kind": "universal"` с пустым списком артефактов, а в URL прошито
`/darwin/universal/dmg/`.

**Идемпотентность в UI.** Независимо от скриптов, `main.js` сам определяет, установлено
ли приложение, для отрисовки карточки (`src/main.js:3188-3193`): на Windows — те же два
пути к `claude.exe`, плюс подкаталог вида `Claude-<цифра>` внутри
`%LOCALAPPDATA%\Packages` (`dirHasChildStarting`, `src/main.js:2935-2941`); на macOS —
`/Applications/Claude.app` и `~/Applications/Claude.app`.

Третья проверка — подкаталог внутри `AnthropicClaude` — в коде есть
(`dirHasChildStarting(path.join(la, 'AnthropicClaude'), 'app-')`, `src/main.js:3188`),
но она **мертва**: `dirHasChildStarting` дописывает к переданному префиксу собственный
`-\d` (`src/main.js:2937`), поэтому из `app-` получается регулярка `^app--\d` с двойным
дефисом. Реальный Squirrel-каталог `app-0.13.0` под неё не подходит; совпало бы только
имя вида `app--1` (воспроизведено запуском той же строки в node). Ветка с префиксом
`Claude` от этого не страдает — там префикс без дефиса, и регулярка выходит `^Claude-\d`.

## Инварианты

1. **Скачанный установщик не запускается, пока подпись не подтверждена.** На Windows
   `Test-HmTrustedSigner` вызывается на строке 206, `Start-Process` — на 224, между ними только `exit 120` при непустой причине отказа (`scripts/windows/claude-desktop.ps1:204-228`). Порядок закреплён двумя
   `assertOrder` в тестах.
2. **Доверие подписи не строится на подстроке.** Требуются одновременно: цепочка,
   корень которой лежит в `LocalMachine\Root`, точное значение RDN `O=` = `Anthropic,
   PBC` и EKU Code Signing (общая функция `scripts/windows/_deelev.ps1:467-548`, вызов — `scripts/windows/claude-desktop.ps1:206`). Корни из `CurrentUser\Root` не принимаются: список машинных корней читает только `Get-HmMachineRootThumbprints` (`scripts/windows/_deelev.ps1:375-383`) и только из `LocalMachine\Root`.
3. **Загрузка идёт не в user-writable каталог.** Файл лежит в
   `$cache\ClaudeSetup.exe`, где `$cache` — результат `New-HmSecureStagingDir`
   (`scripts/windows/claude-desktop.ps1:159,165`); ни одного `-OutFile` в `%TEMP%`/
   `%TMP%` в файле нет.
4. **Установщик запускается из того же защищённого каталога.**
   `Start-Process -FilePath $installer -WorkingDirectory $cache` (`scripts/windows/claude-desktop.ps1:224`).
5. **Ни одно ожидание не бесконечно.** `Start-Process` без `-Wait` (224); `Wait-HmClaudeDesktopVerdict` ограничен `$CapSec = 300` через `$deadline` (117-119); `Wait-Process -Timeout 120` в `finally` (256); `Invoke-WebRequest -TimeoutSec 600` (176).
6. **«Установлено» печатается только после фактической проверки маркера.** Строка
   `OK: Claude Desktop установлен.` стоит внутри ветки `if ($installed)`, где
   `$installed` — результат `Wait-HmClaudeDesktopVerdict`
   (`scripts/windows/claude-desktop.ps1:234-236`).
7. **Любой отказ — graceful skip 120, а не ошибка и не тихий успех.** Все ветки отказа
   в обоих скриптах выходят с 120; `main.js` трактует 120 как «пропущен» и не пишет
   маркер установки (`src/main.js:1549`, `src/install-receipts.js:34-58`).
8. **Защищённый кэш убирается ровно одним помощником.** `Remove-HmSecureStagingDir` в
   `finally` (`scripts/windows/claude-desktop.ps1:251,258`), который поднимается от `w` к
   внешнему каталогу и удаляет только имя вида `HmDeElev-<32 hex>`
   (`scripts/windows/_deelev.ps1:131-137`).
9. **macOS: отсутствие инструмента проверки — отказ, а не пропуск проверки.**
   `[ ! -x "$CODESIGN" ]` и `[ ! -x "$SPCTL" ]` возвращают 1 из `verify_desktop_app`
   (`scripts/macos/claude-desktop.sh:91-96`); `spctl` вызывается безусловно (107).
10. **macOS: в `~/Applications` попадает только проверенная копия.** `ditto` идёт после
    проверки образа (112, 119), и сама staging-копия проверяется повторно перед `mv`
    (`scripts/macos/claude-desktop.sh:125-135`).
11. **Уже установленное приложение не переустанавливается и ничего не качает.**
    `Test-ClaudeDesktopInstalled` → `exit 0` до всех сетевых действий
    (`scripts/windows/claude-desktop.ps1:134-137`); аналогично `-d` проверки на macOS
    (`scripts/macos/claude-desktop.sh:45-48`).
12. **Dry-run не создаёт защищённый каталог и не выходит в сеть.** Ветка `$DRY`
    стоит выше создания кэша (`scripts/windows/claude-desktop.ps1:143-146`), ветка
    `$DRY` на macOS — выше `mktemp` (`scripts/macos/claude-desktop.sh:50-53`).
13. **Компонент не показывается и не запускается на неподдерживаемой платформе.**
    `platforms: ["win32","darwin"]` (`components.json:300-303`) + гейт
    `componentShownOnPlatform` перед запуском скрипта (`src/main.js:1056-1060`).
14. **Кнопки «Удалить» у компонента нет.** `REMOVABLE` содержит только
    `course, uv, mascot, bridge` (`src/renderer/app.js:43`), и кнопка рисуется только
    для членов этого множества (`src/renderer/app.js:519`).

## Что ломается, если инвариант нарушить

1. Человек под правами администратора запускает произвольный `.exe`, приехавший по
   сети. Это не «неудачная установка», а установка чужого кода в систему.
2. Достаточно любого сертификата, у которого в Subject где-то встречается слово
   Anthropic, либо самоподписанного корня, положенного в пользовательский стор без
   UAC, — и подделка проходит гейт.
3. Между «скачали» и «проверили подпись» другая программа того же пользователя
   подменяет файл, и запускается уже не то, что проверено. Человек получит
   постороннее приложение под видом Claude.
4. Установщик подхватывает `.dll` из рабочего каталога — вместо приложения человек
   получает чужой код с правами установщика.
5. Шаг зависает навсегда: спиннер крутится, пока человек не выгрузит Claude из трея.
   Установка остальных компонентов не продолжится, а причину на экране не видно.
6. В отчёте написано «установлено», а в меню «Пуск» пусто: человек не понимает, почему
   приложения нет, и не знает, что нужно поставить вручную.
7. Два разных провала: либо вся установка краснеет из-за отключённого интернета и
   человек думает, что сломано всё, либо пропуск выдаётся за успех — тогда пишется
   маркер установки того, чего нет.
8. Каталог `%ProgramData%\HmDeElev-<hex>` с владельцем Administrators остаётся навсегда
   на диске: обычный пользователь его не сотрёт, и такие каталоги копятся при каждом
   повторе. Голый `Remove-Item` по возвращённому пути снёс бы только `w`, оставив
   внешний.
9. На маке, где `spctl` или `codesign` недоступны, проверка молча пропускается — и
   ставится нотаризационно неподтверждённое приложение (класс fail-open).
10. Между проверкой смонтированного образа и подменой цели содержимое подменяется, и в
    `~/Applications` уезжает уже другое приложение.
11. Повторный запуск установщика поверх работающего Claude качает сотни мегабайт
    заново и может перезаписать существующую установку.
12. Сухой прогон перестаёт быть сухим: создаёт каталоги в `ProgramData` и тянет файл из
    сети — то есть тестовый режим меняет систему.
13. На Linux резолвер путей выбирает каталог по одному признаку `IS_WIN`
    (`const dir = IS_WIN ? 'windows' : 'macos'`, `src/main.js:683`), то есть на любой
    не-Windows платформе берёт `macos`. Путь разрешится в существующий
    `scripts/macos/claude-desktop.sh`, проверка `fs.existsSync` (`src/main.js:1066`)
    пройдёт — и bash-скрипт будет реально запущен вместо того, чтобы компонент просто не
    показывался. `Script not found` при этом не появится; сломается позже и невнятно
    (например, на отсутствующем `hdiutil`).
14. Появляется кнопка «Удалить» у чужого приложения. Поскольку целей удаления квитанция
    не задаёт, кнопка либо ничего не сделает, либо удалит не то.

## Границы

- Компонент только **ставит**. Обновления и удаления нет: авто-удаление чужого
  приложения не поддерживается сознательно (комментарий
  `scripts/windows/claude-desktop.ps1:49-50`, `scripts/macos/claude-desktop.sh:20`), и
  в `REMOVABLE` его нет (`src/renderer/app.js:43`).
- Если приложение уже стоит, скрипт **не проверяет его версию и не обновляет** — просто
  выходит с 0.
- Linux не поддерживается (`components.json:300-303`).
- SHA-пиннинг бинаря **не применяется намеренно**: версии десктопа меняются, вшитый sha
  устарел бы (`scripts/windows/claude-desktop.ps1:18-19`,
  `scripts/macos/claude-desktop.sh:9-10`). Гарантия целостности здесь — подпись.
- Пин отпечатка leaf-сертификата на Windows **выключен по умолчанию**:
  `$LEAF_THUMBPRINT = ''` (`scripts/windows/claude-desktop.ps1:72`).
- Windows: запуск идёт **элевейтед**, де-элевации нет — это осознанная уступка,
  описанная в комментарии (строки 32-41). Остаточный риск (доверенный установщик сам
  распаковывает бутстрап в пользовательский `%TEMP%`) принят и вынесен в
  `THREAT-MODEL.md`.
- Windows: отзыв сертификата отдельно не проверяется —
  `ChainPolicy.RevocationMode = NoCheck` (`scripts/windows/_deelev.ps1:409`, `Get-HmSignerChainRoot`), с расчётом на то, что отзыв уже
  проверил WinVerifyTrust при `Status = Valid`.
- macOS: установка идёт в `~/Applications`, а не в `/Applications` (строка 41), то есть
  приложение ставится только текущему пользователю.
- Компонент не логинит в аккаунт, не настраивает приложение и не связан с панелью
  Claude в VS Code (`components.json:292-293`).
- Размер заранее неизвестен: у компонента нет `sizeBytes`, только текстовая пометка
  (`components.json:304`, `tools/sync-sizes.js:141-142`).
- Компонент отсутствует в реестре докачки — его файл не проходит через
  sha-проверенный конвейер `main.js`, скрипт качает сам.

## Риски и открытые вопросы

1. **`THREAT-MODEL.md:87` расходится с кодом.** Там написано, что в
   `claude-desktop.ps1` есть «пин отпечатка leaf». В коде пин по умолчанию выключен:
   `$LEAF_THUMBPRINT = ''` (`scripts/windows/claude-desktop.ps1:72`), а комментарий 55-60 прямо помечает его как опциональное усиление. Читатель модели угроз
   пересчитает защиту на один вентиль больше, чем есть.
2. **Две копии проверки подписи (закрыто 10.10.2026).** Раньше `claude-desktop.ps1` и
   `chatgpt-desktop.ps1` объявляли каждый свою `Test-HmSignerTrusted`, а
   `THREAT-MODEL.md:85-86` называл гейтом `Test-HmTrustedSigner` из `_deelev.ps1`, которую
   скрипт не вызывал. Копии разошлись с общей функцией и держали два дефекта: цепочка
   «на сегодня» отвергала подписанта с истёкшим коротким листом, а пин `O=Anthropic, PBC`
   не совпадал НИКОГДА — .NET берёт значение с запятой в кавычки, и сравнивалось
   `"Anthropic, PBC"` (проверено на установленном Claude Desktop: лист
   `CN="Anthropic, PBC", O="Anthropic, PBC"`). Теперь оба скрипта зовут
   `Test-HmTrustedSigner` (`scripts/windows/claude-desktop.ps1:206`,
   `scripts/windows/chatgpt-desktop.ps1:117`), текст модели угроз совпадает с кодом.
   Следствие, о котором стоит знать: до правки онлайн-установка Claude Desktop на
   Windows при ЛЮБОМ установщике уходила в `exit 120` на гейте подписи; теперь при
   действительной подписи Anthropic установщик реально запускается (повышенно, из
   защищённого кэша — как и задумано в шапке скрипта).
3. **Два незакрытых TODO-verify в самих скриптах.**
   `scripts/windows/claude-desktop.ps1:55-60` — снять и вписать реальный отпечаток
   leaf-серта; `scripts/macos/claude-desktop.sh:26-29` — подтвердить Team ID и bundle
   id на реальной desktop-сборке. Оба помечены как fail-closed при несовпадении, то
   есть цена ошибки — тихий пропуск компонента, а не небезопасная установка.
4. **Детект в UI и детект в скрипте не совпадают.** `scripts/windows/claude-desktop.ps1:101-103`
   спрашивает `Get-AppxPackage`, а `src/main.js:3188` ищет подкаталог
   `%LOCALAPPDATA%\Packages\Claude-<цифра>`: регулярка `dirHasChildStarting`
   (`src/main.js:2937`) требует дефис и цифру после префикса. Совпадёт ли реальное имя
   каталога MSIX-пакета с этим шаблоном — **кодом не подтверждено**; если нет, карточка
   может показывать «не установлено» там, где скрипт корректно выйдет с 0.
5. **Развилка архитектуры на Windows читает только `PROCESSOR_ARCHITECTURE`** (строка 140). Переменная `PROCESSOR_ARCHITEW6432` в скрипте не используется, хотя в
   allowlist окружения она есть (`src/main.js` — список `WIN_SYS_ENV_KEYS`). Поведение
   на ARM64-машине при запуске скрипта в x86-хосте **кодом не подтверждено**; при
   ошибке будет скачан x64-установщик.
6. **macOS: `curl` без `--connect-timeout`.** В `scripts/macos/claude-desktop.sh:70`
   стоит только `--max-time 900`, тогда как общий помощник `dl()` в
   `scripts/macos/_lib.sh:9` использует `--connect-timeout 20`, а комментарий на
   `_lib.sh:5` называет эталоном именно `claude-desktop.sh`. Комментарий и код
   разошлись; практическое следствие — до 15 минут молчания при повисшем соединении.
7. **`scripts/macos/claude-desktop.sh:31` подключает `_lib.sh` best-effort**
   (`2>/dev/null || true`), но ни одной функции оттуда не использует (проверено
   поиском по файлу). Строка вводит в заблуждение: выглядит как зависимость, которой
   нет.
8. **Идемпотентный выход с кодом 0 приводит к записи маркера установки.**
   `shouldRecordInstall` возвращает true при `code === 0`
   (`src/install-receipts.js:36-58`), а скрипт отдаёт 0 и в случае «уже стоит»
   (`scripts/windows/claude-desktop.ps1:136`). То есть квитанция пишется для
   приложения, которое установщик не ставил. Сегодня это безвредно, потому что
   компонента нет в `REMOVABLE`; при добавлении его туда квитанция стала бы основанием
   для удаления чужого приложения.
9. **Повторная проверка staging-копии на macOS (`claude-desktop.sh:125-129`) тестами не
   закреплена.** В `test/run-tests.js` порядок проверяется только для пары
   `verify_desktop_app "$APP"` → `ditto "$APP" "$STAGING"`; исчезновение второй
   проверки тесты не заметят.
10. **`$DRY = [bool]$env:HM_DRY_RUN`** (строка 62) включает сухой прогон по непустоте
    значения. Это единый паттерн всех Windows-скриптов проекта (`bridge.ps1:25`,
    `cursor.ps1:26`, `node.ps1:84` и другие), а не особенность этого файла, но значение
    `HM_DRY_RUN=0` сухой прогон **не** выключит.
