# Скрепка Claude (маскот) — Windows: живой помощник поверх окон + кнопки разрешений
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot '_verify.ps1'); . (Join-Path $PSScriptRoot '_mascot.ps1')  # Confirm-HmArtifact (fail-closed SHA-256); общие функции скрепки (их же зовёт touchup-mascot.ps1)
$DRY = [bool]$env:HM_DRY_RUN

# Вшитый артефакт (Windows-only; кладёт tools/fetch-vendor.ps1 из локальной сборки claude-mascot)
$src = if ($env:HM_VENDOR) { Join-Path $env:HM_VENDOR 'apps\claude-mascot\claude-mascot.exe' } else { '' }
if (-not ($src -and (Test-Path $src))) { Write-Host "Скрепка (косметический помощник) не вошла в эту сборку — пропускаю. Claude Code и всё остальное работают без неё."; exit 120 }

$destDir = Join-Path $env:LOCALAPPDATA 'Programs\ClaudeMascot'
$dest    = Join-Path $destDir 'claude-mascot.exe'

if ($DRY) {
    Write-Host "  [dry-run] WOULD: SHA-256 exe, копия -> $dest, хуки (settings.json: hook-url 127.0.0.1:VSCODE_PORT/hook -> :45832/hook, атомарно + бэкап .hm-bak), без автозапуска (запись HKCU Run ClaudeMascot от прошлых версий снять, если ведёт на наш exe), ярлык «Claude Mascot» в меню «Пуск», запуск один раз + health-check"
    Write-Host "[dry-run] Скрепка: ветка выбрана, без изменений."; exit 0
}

# 1. Целостность вшитого exe — fail-closed (при несовпадении SHA-256 выходит с кодом 1 сам)
Confirm-HmArtifact $src

# 2. WebView2 Runtime (нужен Tauri-приложению). На Win11 есть всегда, на старых Win10 может отсутствовать.
$wvKeys = @(
    'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
    'HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
)
$wvOk = $false
foreach ($k in $wvKeys) {
    $pv = (Get-ItemProperty -Path $k -Name pv -ErrorAction SilentlyContinue).pv
    if ($pv -and $pv -ne '0.0.0.0') { $wvOk = $true; break }
}
if (-not $wvOk) {
    Write-Host "ВНИМАНИЕ: WebView2 Runtime не найден — скрепка может не показать окно."
    Write-Host "  На Windows 11 он есть из коробки; на Windows 10 поставь Evergreen WebView2 с сайта Microsoft, если скрепка не появится."
}
# Флаг доживает до пункта 6: там он вместе с провалом health-check даёт ОДНОЗНАЧНЫЙ
# диагноз. По отдельности каждый факт двусмыслен (WebView2 мог не определиться по
# реестру; health мог не успеть), вместе — нет.

# 3. Остановить работающую скрепку (exe может быть залочен) и скопировать свежую
Stop-Process -Name 'claude-mascot' -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $destDir | Out-Null
$copied = $false
foreach ($attempt in 1..3) {
    try { Copy-Item -Force $src $dest -ErrorAction Stop; $copied = $true; break }
    catch { Start-Sleep -Seconds 1 }   # процесс мог не успеть отпустить файл
}
if (-not $copied -or -not (Test-Path $dest)) { Write-Host "Не удалось скопировать скрепку в $dest — файл занят. Закрой её и повтори установку."; exit 1 }

# 4. Хуки Claude Code: конфиг-пак несёт hook-записи с плейсхолдером VSCODE_PORT в url —
# подставляем порт скрепки (45832). Безопасность (settings.json — ВЕСЬ конфиг пользователя):
#   - правим ТОЛЬКО подстроку hook-url `127.0.0.1:VSCODE_PORT/hook` (чужой "VSCODE_PORT" в JSON не задеваем);
#   - JSON валидируем до и после замены; битый файл НЕ трогаем;
#   - запись атомарная: бэкап .hm-bak -> tmp в той же папке -> валидация tmp -> Move-Item поверх оригинала;
#   - при любом сбое оригинал остаётся нетронутым, а маркер .installed НЕ сбрасываем.
$settingsPath = Join-Path $env:USERPROFILE '.claude\settings.json'
$HOOK_OLD = '127.0.0.1:VSCODE_PORT/hook'
$HOOK_NEW = '127.0.0.1:45832/hook'
$keepMarker = $false
if (-not (Test-Path $settingsPath)) {
    # Файл НЕ создаём: скрепка при первом запуске пропишет хуки сама (merge аддитивный).
    Write-Host "  ~/.claude/settings.json отсутствует — скрепка пропишет хуки сама при первом запуске."
} else {
    $rawSettings = $null
    try { $rawSettings = [IO.File]::ReadAllText($settingsPath) }
    catch { Write-Host "  Не удалось прочитать settings.json ($($_.Exception.Message)) — файл не тронут, скрепка разберётся с хуками сама." }
    if ($null -ne $rawSettings) {
        $parsedOk = $false
        try { $null = $rawSettings | ConvertFrom-Json; $parsedOk = $true }
        catch { Write-Host "  settings.json не парсится как JSON — файл не тронут, скрепка разберётся с хуками сама." }
        if ($parsedOk -and $rawSettings.Contains($HOOK_OLD)) {
            $newSettings = $rawSettings.Replace($HOOK_OLD, $HOOK_NEW)
            $newOk = $false
            try { $null = $newSettings | ConvertFrom-Json; $newOk = $true }
            catch { Write-Host "  ВНИМАНИЕ: после замены hook-url JSON стал невалидным — откат, файл не тронут."; $keepMarker = $true }
            if ($newOk) {
                $tmpPath = "$settingsPath.hm-tmp"
                try {
                    Copy-Item $settingsPath "$settingsPath.hm-bak" -Force -ErrorAction Stop
                    [IO.File]::WriteAllText($tmpPath, $newSettings, [Text.UTF8Encoding]::new($false))
                    $null = [IO.File]::ReadAllText($tmpPath) | ConvertFrom-Json   # tmp дописался целиком и валиден?
                    Move-Item -Force $tmpPath $settingsPath -ErrorAction Stop     # атомарная замена в пределах тома
                    Write-Host "  Хуки Claude Code направлены на скрепку (порт 45832). Бэкап: settings.json.hm-bak."
                } catch {
                    Remove-Item $tmpPath -Force -ErrorAction SilentlyContinue
                    Write-Host "  ВНИМАНИЕ: не удалось безопасно обновить settings.json ($($_.Exception.Message)) — оригинал не тронут."
                    $keepMarker = $true
                }
            }
        }
    }
}
if (-not $keepMarker) {
    # Сбросить маркер первой установки: приложение перепропишет свои хуки заново (merge аддитивный, чужие записи не трогает).
    Remove-Item (Join-Path $env:USERPROFILE '.claude-mascot\.installed') -Force -ErrorAction SilentlyContinue
} else {
    Write-Host "  Маркер .installed оставлен — правку хуков скрепка докрутит сама."
}

# 5. Автозапуска НЕТ — решение владельца 06.10.2026 (строка A26 разбора диалогов
# поддержки): люди не понимали, что за скрепка появляется при входе в Windows и откуда
# она взялась. Теперь скрепка стартует один раз сразу после установки (ниже), а дальше —
# только когда человек сам откроет её из меню «Пуск».
#
# Прошлые версии установщика прописывали HKCU\...\Run\ClaudeMascot всегда. При повторной
# установке эту запись снимаем, но ТОЛЬКО свою: имя ClaudeMascot И значение ведёт ровно
# на наш exe (правило и функции — в _mascot.ps1, их же зовёт touchup-mascot.ps1: сюда
# повторный запуск установщика не доходит, пока скрепка отмечена «уже установлено»).
# Чужое значение под тем же именем не трогаем — и пишем об этом в журнал.
$null = Remove-HmMascotOldAutorun 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' $dest

# 5б. Ярлык «Claude Mascot» в меню «Пуск» (только для этого пользователя): раз скрепка сама
# не стартует, человеку нужно место, откуда её открыть. Ярлык — просто файл, он ничего не
# запускает, и exe под админом здесь не исполняется. Но пишем мы его из-под админа в
# каталог, который может менять любая программа этого пользователя — отсюда правила в
# _mascot.ps1: папка берётся от профиля и сверяется с ответом оболочки (не из реестра
# вслепую), без junction/symlink в пути, сохранение через временный файл и Move с
# тремя попытками, повторная проверка непосредственно перед переносом. Не вышло — не
# критично: скрепка запущена, путь к exe в журнале.
$lnkPath = $null
try {
    $progsDir = Get-HmMascotProgramsDir
    $lnkPath = New-HmMascotShortcut $progsDir $dest { $null = Get-HmMascotProgramsDir }
    Write-Host "  Ярлык в меню «Пуск»: $lnkPath"
} catch { Write-Host "  Ярлык в меню «Пуск» не создался (не критично): $($_.Exception.Message). Скрепку можно запускать файлом: $dest" }

# P0-4: квитанция владения — ТОЧНЫЕ пути созданных артефактов (main соберёт в receipt).
Write-Host "HM-RECEIPT path $destDir"
Write-Host "HM-RECEIPT path $(Join-Path $env:USERPROFILE '.claude-mascot')"
if ($lnkPath) { Write-Host "HM-RECEIPT path $lnkPath" }

# Запуск сейчас
# Запуск сейчас — ДЕ-ЭЛЕВАЦИЯ ТОКЕНОМ ОБОЛОЧКИ (Invoke-HmAsShellUser из _deelev.ps1): под
# elevated-токеном был бы copy→run TOCTOU (medium-малварь юзера подменит $dest в user-writable
# каталоге между Copy-Item и запуском → elevated-запуск чужого exe). Раньше запуск отдавали
# explorer.exe в расчёте, что он перешлёт его оболочке обычного уровня, — но без живой оболочки
# (её может прибить малварь того же юзера) наш elevated explorer исполнил бы файл САМ, под админом,
# по обработчику из HKCU\Software\Classes. Токен оболочки проверяется ДО запуска: ровно medium и тот
# же пользователь. Нет оболочки / она не обычного уровня / отключена служба «Вторичный вход» —
# не запускаем НИЧЕГО (ни explorer, ни Start-Process под админом) и говорим человеку, как открыть
# скрепку самому; это не критично, файлы на месте. -NoWait: окно живёт дальше, процесс ждём лишь 3 с,
# чтобы поймать мгновенное падение; живость остального проверяем HTTP-probe ниже.
# _deelev.ps1 подключаем ЗДЕСЬ, а не в шапке: холостому прогону и шагам до запуска он ни к чему.
# Его загрузка по умолчанию ещё и подметает осиротевшие задачи планировщика (COM Schedule.Service) —
# шагу скрепки это тоже ни к чему (эту уборку делают шаги, которым примитив нужен для задач), поэтому
# $script:HmSkipOrphanSweep = $true ДО подключения: планировщик здесь не открывается вовсе.
$launched = $false
$shRes = $null
$shWhy = ''
$script:HmSkipOrphanSweep = $true
try {
    . (Join-Path $PSScriptRoot '_deelev.ps1')
    $shRes = Invoke-HmAsShellUser -Exe $dest -NoWait -Label 'mascot'
} catch { $shWhy = $_.Exception.Message }
if ($null -ne $shRes -and $shRes.Gate -eq 'medium' -and $shRes.Code -eq 0) { $launched = $true }
elseif ($null -ne $shRes -and $shRes.Gate -eq 'medium') {
    Write-Host "  ВНИМАНИЕ: скрепка запустилась и сразу закрылась (код $($shRes.Code))."
}
else {
    if ($null -ne $shRes) { $shWhy = [string]$shRes.Reason }
    if (-not $shWhy) { $shWhy = 'причина не определена' }
    Write-Host "  ВНИМАНИЕ: скрепку сейчас запустить не удалось: $shWhy. Под правами администратора я её не запускаю."
}
# Машинный маркер исхода запуска: main убирает строку из журнала на экране и отдаёт признак экрану финиша,
# чтобы тот не писал «установщик запустил её», когда запуск не принят (шаг при этом зелёный: не критично).
# 1 — запуск принят (токен оболочки обычного уровня, процесс не упал за 3 с), 0 — иначе. Печатается один раз.
Write-Host "HM-MASCOT launched=$(if ($launched) { 1 } else { 0 })"

# 6. Health-check (НЕ критичный: скрепка поднимает http://127.0.0.1:45832/health, но может не успеть за 10 с)
$healthy = $false
if ($launched) {
    foreach ($i in 1..10) {
        Start-Sleep -Seconds 1
        try {
            $r = Invoke-WebRequest 'http://127.0.0.1:45832/health' -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
            if ($r.StatusCode -eq 200) { $healthy = $true; break }
        } catch { }
    }
}
# Автозапуска нет, поэтому в каждом исходе говорим, откуда открыть скрепку потом.
$reopen = if ($lnkPath) { 'меню «Пуск» → Claude Mascot' } else { $dest }
if ($healthy) {
    Write-Host "  Сама при входе в Windows скрепка не запускается — открыть её снова: $reopen."
    Write-Host "OK: Скрепка установлена и запущена — она уже на экране. Ctrl+Shift+D откроет твои сессии Claude."
}
elseif (-not $wvOk -and $launched) {
    # ДВА факта вместе, а не по отдельности: WebView2 в реестре нет И скрепка не
    # ответила на проверку. Это не «не успела» — окно рисовать нечем, Tauri без
    # WebView2 не поднимается вовсе.
    #
    # «Не ответила» — только если её запустили ($launched): когда запуск не принят
    # (нет оболочки обычного уровня, UAC выключен), проверки не было вовсе, и красный
    # диагноз вставал бы на одном факте, на реестре. Тогда — общий исход ниже: файлы
    # на месте, открой сама; предупреждение про WebView2 уже напечатано выше.
    #
    # Раньше здесь печаталось «не успела ответить на проверку — это не ошибка» и
    # возвращался 0. Человек видел на финальном экране ЗЕЛЁНУЮ галочку и пустой
    # рабочий стол — и решал, что не понял, как скрепку вызвать. Зелёная галочка,
    # за которой ничего нет, хуже честного красного крестика: она отправляет
    # искать ошибку в себе.
    #
    # Красный тут безопасен: от скрепки не зависит НИ ОДИН компонент (проверено по
    # components.json), поэтому провал никуда не каскадит. Claude Code, редактор и
    # курс от этого не страдают — скрепка косметическая.
    Write-Host "СКРЕПКА НЕ ЗАРАБОТАЕТ: в системе нет WebView2 Runtime — компонента Windows, которым скрепка рисует своё окно."
    Write-Host "  Файлы установлены ($dest), но показать себя ей нечем."
    Write-Host "  Что делать: поставь Microsoft Edge WebView2 Runtime (Evergreen Standalone Installer)"
    Write-Host "  https://developer.microsoft.com/microsoft-edge/webview2/  — и запусти скрепку: $dest"
    Write-Host "  Всё остальное установлено и работает: скрепка косметическая."
    exit 1
}
elseif ($launched) { Write-Host "OK: Скрепка установлена и запускается (не успела ответить на проверку — это не ошибка). Если не появится на экране — открой её: $reopen" }
else { Write-Host "Скрепка установлена, но не запустилась — открой её вручную: $reopen" }
exit 0
