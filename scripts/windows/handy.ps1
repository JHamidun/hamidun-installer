# Handy — голосовой ввод (speech-to-text), Windows
#
# Handy (github.com/cjpais/Handy, MIT) — локальное распознавание речи: зажал хоткей,
# продиктовал, отпустил — текст вставился в активное поле. Ничего не уходит в облако.
#
# ЧТО ВАЖНО ЗНАТЬ ПРО ЭТОТ КОМПОНЕНТ (проверено по исходникам Handy v0.9.4):
#   • Установщик NSIS ставит приложение ПО-ПОЛЬЗОВАТЕЛЬСКИ в %LOCALAPPDATA%\Handy и
#     НЕ требует администратора (tauri.conf.json не задаёт installMode → дефолт
#     currentUser; installer.nsi: RequestExecutionLevel user).
#   • Тихая установка — флаг /S (у Tauri-NSIS: /S = silent, /P = passive).
#   • МОДЕЛЬ РАСПОЗНАВАНИЯ В УСТАНОВЩИК НЕ ВХОДИТ и НЕ КАЧАЕТСЯ САМА. Внутри лежит
#     только VAD (silero_vad). При первом запуске Handy показывает экран выбора
#     модели, и загрузка (~270–750 МБ) стартует ТОЛЬКО после клика пользователя.
#     Поэтому обещать «поставили — работает» нельзя: мы честно говорим про шаг выбора.
#   • Первая карточка в списке (Parakeet EN) НЕ ЗНАЕТ РУССКОГО. Для русского нужны
#     GigaAM v3 (~272 МБ, только русский) или Nemotron Streaming 3.5 (~751 МБ, 28 языков).
#     Об этом пишем прямо, иначе новичок ткнёт верхнюю и получит английский.
#   • Дефолтный хоткей ctrl+space конфликтует с переключением раскладки у многих
#     русскоязычных пользователей — пре-сидируем другой (ctrl+alt+space).
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot '_verify.ps1')  # Confirm-HmArtifact (fail-closed SHA-256)
. (Join-Path $PSScriptRoot '_deelev.ps1')  # Invoke-HmDeElevated (укреплённая де-элевация, fail-closed)

$DRY = [bool]$env:HM_DRY_RUN

$appDir  = Join-Path $env:LOCALAPPDATA 'Handy'
$appExe  = Join-Path $appDir 'handy.exe'
# Данные приложения (settings_store.json, каталог моделей) — по bundle identifier.
$dataDir = Join-Path $env:APPDATA 'com.pais.handy'

# --- Разрешение на микрофон (галочка «Сразу разрешить доступ к микрофону») -------------
#
# Windows держит согласия НЕ-упакованных (не из Store) приложений в реестре ПОЛЬЗОВАТЕЛЯ:
#   HKCU\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\
#   microphone\NonPackaged\<путь к exe>
# где в имени подключа обратные слэши заменены решётками (C:\X\y.exe -> C:#X#y.exe),
# а значение Value = "Allow" либо "Deny".
#
# ЛОВУШКА, ради которой здесь де-элевация: установщик работает ПОД АДМИНОМ, поэтому его
# HKCU — ветка АДМИНСКОГО токена. Прямой reg add / Set-ItemProperty записал бы согласие
# не туда (а если админ — отдельная учётка, то вообще мимо человека за машиной), и Handy
# всё равно остался бы без микрофона, зато в реестре появилась бы лишняя запись. Поэтому
# И ЧТЕНИЕ, И ЗАПИСЬ идут через единый укреплённый примитив Invoke-HmDeElevated
# (_deelev.ps1): одноразовая задача планировщика от имени интерактивного пользователя с
# LeastPrivilege-токеном. $null или гейт не 'medium' -> НЕ ПИШЕМ НИЧЕГО (fail-closed):
# лучше остаться без согласия, чем поставить его в чужую ветку.
#
# СУЩЕСТВУЮЩЕЕ РЕШЕНИЕ НЕ ПЕРЕЗАПИСЫВАЕМ: если Value уже есть — неважно, Allow или Deny —
# человек уже высказался (сам или через «Параметры -> Конфиденциальность»), и установщик
# не вправе это менять. Проверка тоже де-элевированная: из-под админа она смотрела бы в
# админскую ветку и не увидела бы пользовательский Deny, то есть молча затёрла бы запрет.
function Grant-HmHandyMic {
    param([Parameter(Mandatory = $true)][string]$ExePath)

    # Галочка не стоит -> реестра НЕ КАСАЕМСЯ ВООБЩЕ (даже на чтение). Гейт стоит внутри
    # функции, а не на местах вызова: так его нельзя забыть в одной из веток.
    if ($env:HM_HANDY_MIC -ne '1') { return }

    $sysRoot = if ($env:SystemRoot) { $env:SystemRoot } else { 'C:\Windows' }
    $regExe  = Join-Path (Join-Path $sysRoot 'System32') 'reg.exe'
    $consentKey = 'HKCU\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone\NonPackaged\' +
                  ($ExePath -replace '\\', '#')

    if ($DRY) {
        Write-Host "  [dry-run] WOULD: де-элевированно (Invoke-HmDeElevated) проверить $consentKey и записать Value=Allow — ТОЛЬКО если решения там ещё нет"
        return
    }
    if (-not (Test-Path -LiteralPath $regExe)) {
        Write-Host "  Микрофон: не найден $regExe — разрешение не записываю."
        return
    }

    # (1) Есть ли уже решение? Код 0 = значение найдено, 1 = нет такого значения/ключа.
    $q = Invoke-HmDeElevated $regExe @('query', $consentKey, '/v', 'Value')
    if ($null -eq $q -or $q.Gate -ne 'medium') {
        Write-Host "  Микрофон: проверку от имени пользователя выполнить не удалось — ничего не меняю."
        Write-Host "  Разрешить вручную: Параметры -> Конфиденциальность и защита -> Микрофон."
        return
    }
    if ($q.Code -eq 0) {
        Write-Host "  Микрофон: решение для Handy в Windows уже записано — не трогаю его."
        return
    }

    # (2) Пишем Allow — тоже де-элевированно, в ветку РЕАЛЬНОГО пользователя.
    $a = Invoke-HmDeElevated $regExe @('add', $consentKey, '/v', 'Value', '/t', 'REG_SZ', '/d', 'Allow', '/f')
    if ($null -ne $a -and $a.Gate -eq 'medium' -and $a.Code -eq 0) {
        Write-Host "  Микрофон: доступ для Handy разрешён (настройки приватности Windows)."
        Write-Host "HM-RECEIPT reg HKCU|$($consentKey.Substring(5))|Value"
        return
    }
    $why = 'причина неизвестна'
    if ($null -eq $a) { $why = 'примитив де-элевации не отработал' }
    elseif ($a.Gate -ne 'medium') { $why = "гейт де-элевации: $($a.Gate)" }
    else { $why = "reg.exe вернул $($a.Code)" }
    Write-Host "  Микрофон: разрешение записать не удалось ($why)."
    Write-Host "  Разрешить вручную: Параметры -> Конфиденциальность и защита -> Микрофон -> Разрешить классическим приложениям."
}

Write-Host "Проверяю Handy (голосовой ввод)..."
if (Test-Path -LiteralPath $appExe) {
    Write-Host "Handy уже установлен: $appExe"
    if (-not $DRY) {
        # Настройки не трогаем: у пользователя мог быть выбран свой хоткей/модель.
        # А вот галочку микрофона отрабатываем и на повторном запуске: человек мог
        # прогнать установщик второй раз именно ради неё.
        Grant-HmHandyMic -ExePath $appExe
        Write-Host "HM-RECEIPT path $appDir"
        exit 0
    }
}

$local = if ($env:HM_VENDOR) { Join-Path $env:HM_VENDOR 'apps\handy-setup.exe' } else { '' }

if ($DRY) {
    if ($local -and (Test-Path -LiteralPath $local)) {
        Write-Host "  [dry-run] WOULD: тихая установка Handy из встроенного установщика ($local /S)"
    } else {
        Write-Host "  [dry-run] WOULD: установщик Handy не вшит — компонент был бы пропущен (exit 120)"
    }
    Write-Host "  [dry-run] WOULD: пре-сид $dataDir\settings_store.json (язык ru, хоткей ctrl+alt+space) — ТОЛЬКО если файла нет"
    Grant-HmHandyMic -ExePath $appExe   # без HM_HANDY_MIC=1 не печатает ничего — и это правда
    Write-Host "[dry-run] Handy: без изменений."
    exit 0
}

if (-not ($local -and (Test-Path -LiteralPath $local))) {
    # Онлайн-фолбэка НЕТ намеренно: качать 21 МБ с GitHub под elevated-токеном мимо
    # sha-проверенного канала — ровно тот класс риска, который закрыт для остальных
    # компонентов. Нет вшитого/докачанного артефакта → честный graceful skip.
    Write-Host "Установщик Handy не найден в наборе — пропускаю компонент (это не ошибка)."
    Write-Host "  Поставить вручную: https://handy.computer"
    exit 120
}

# Второй гейт целостности (вшитый vendor/checksums.json) — как у всех бинарей.
Confirm-HmArtifact $local

Write-Host "Ставлю Handy (тихая установка, без прав администратора)..."
# /S — silent у Tauri-NSIS. Установка per-user в %LOCALAPPDATA%\Handy.
# ВАЖНО: -Wait обязателен, иначе проверка ниже побежит раньше распаковки.
$proc = $null
try {
    $proc = Start-Process -FilePath $local -ArgumentList '/S' -Wait -PassThru -ErrorAction Stop
} catch {
    Write-Host "Не удалось запустить установщик Handy: $($_.Exception.Message)"
    exit 1
}
$code = if ($proc) { $proc.ExitCode } else { -1 }
if ($code -ne 0) {
    Write-Host "Установщик Handy завершился с кодом $code."
    # На Windows 10 без WebView2 NSIS Tauri тянет его bootstrapper из сети и при
    # неудаче прерывает установку — самый вероятный сценарий ненулевого кода офлайн.
    Write-Host "  Частая причина на Windows 10 без интернета: не установлен компонент WebView2."
    exit 1
}

# Факт установки проверяем ПО ФАЙЛУ, а не по коду возврата.
if (-not (Test-Path -LiteralPath $appExe)) {
    Write-Host "Установщик отработал, но $appExe не появился — считаю установку неудачной."
    exit 1
}
Write-Host "OK: Handy установлен ($appExe)"

# --- Пре-сид настроек: только если пользователь ещё ничего не настраивал ---
# Формат — плоский JSON tauri-plugin-store: {"settings": {...}}. Частично неполный
# объект безопасен: Handy мержит валидные поля с дефолтами. Ставим ровно два поля,
# которые реально мешают русскоязычному новичку из коробки.
$store = Join-Path $dataDir 'settings_store.json'
if (Test-Path -LiteralPath $store) {
    Write-Host "  Настройки Handy уже есть — не трогаю ($store)"
} else {
    try {
        New-Item -ItemType Directory -Force -Path $dataDir -ErrorAction Stop | Out-Null
        # history_limit по умолчанию = 5 записей, а хранение аудио — «preserve_limit»
        # (то есть привязано к тем же 5). Для человека это значит: вчерашняя диктовка
        # уже недоступна. Ставим максимум из того, что поддерживает сам Handy:
        # история 1000 записей и recording_retention_period = months3 — самый долгий
        # вариант перечисления (Never | PreserveLimit | Days3 | Weeks2 | Months3;
        # serde rename_all = snake_case, поэтому в JSON именно "months3").
        $seed = @{
            settings = @{
                selected_language = 'ru'
                bindings = @{ transcribe = @{ current_binding = 'ctrl+alt+space' } }
                history_limit = 1000
                recording_retention_period = 'months3'
            }
        }
        $tmp = "$store.tmp"
        ($seed | ConvertTo-Json -Depth 6) | Set-Content -LiteralPath $tmp -Encoding UTF8 -ErrorAction Stop
        Move-Item -LiteralPath $tmp -Destination $store -Force -ErrorAction Stop
        Write-Host "  Пред-настроено: язык распознавания «русский», горячая клавиша Ctrl+Alt+Space"
        Write-Host "  (Ctrl+Space не берём — он у многих переключает раскладку.)"
    } catch {
        # Не критично: Handy стартует с дефолтами, пользователь настроит в окне.
        Write-Host "  Пред-настройку записать не удалось ($($_.Exception.Message)) — Handy запустится с настройками по умолчанию."
    }
}

# Согласие на микрофон — после того, как exe реально появился на диске: до этого
# писать разрешение не на что.
Grant-HmHandyMic -ExePath $appExe

Write-Host ""
Write-Host "ЧТО СДЕЛАТЬ ПОСЛЕ УСТАНОВКИ (один раз, ~2 минуты):"
Write-Host "  1. Запусти Handy — откроется выбор модели распознавания."
Write-Host "  2. Выбери «Parakeet TDT 0.6B v3» — около 705 МБ."
Write-Host "     Это лучший выбор для русского: точность как у самых тяжёлых моделей,"
Write-Host "     но работает вдвое быстрее них."
Write-Host "     Жалко трафика? «Whisper Small» — 257 МБ, точность чуть ниже."
Write-Host "     ВНИМАНИЕ: не путай с «Parakeet Unified EN» (обычно стоит ПЕРВЫМ в списке) —"
Write-Host "     вот он русский НЕ понимает. Нужен именно тот, где в названии «v3»."
Write-Host "  3. Дождись загрузки модели — она качается ОДИН раз и дальше работает без интернета."
Write-Host "  4. Разреши доступ к микрофону, если Windows спросит."
Write-Host "Дальше: зажми Ctrl+Alt+Space, продиктуй — текст вставится сам."

Write-Host "HM-RECEIPT path $appDir"
Write-Host "HM-RECEIPT reg HKCU|Software\Microsoft\Windows\CurrentVersion\Uninstall\Handy|UninstallString"
exit 0
