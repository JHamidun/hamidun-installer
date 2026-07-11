# Скрепка Claude (маскот) — Windows: живой помощник поверх окон + кнопки разрешений
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot '_verify.ps1')  # Confirm-HmArtifact (fail-closed SHA-256)
$DRY = [bool]$env:HM_DRY_RUN

# Вшитый артефакт (Windows-only; кладёт tools/fetch-vendor.ps1 из локальной сборки claude-mascot)
$src = if ($env:HM_VENDOR) { Join-Path $env:HM_VENDOR 'apps\claude-mascot\claude-mascot.exe' } else { '' }
if (-not ($src -and (Test-Path $src))) { Write-Host "Скрепка не найдена в сборке ($src) — компонент вшивается только в Windows-издание."; exit 1 }

$destDir = Join-Path $env:LOCALAPPDATA 'Programs\ClaudeMascot'
$dest    = Join-Path $destDir 'claude-mascot.exe'

if ($DRY) {
    Write-Host "  [dry-run] WOULD: SHA-256 exe, копия -> $dest, хуки (settings.json: hook-url 127.0.0.1:VSCODE_PORT/hook -> :45832/hook, атомарно + бэкап .hm-bak), Run-автозапуск, запуск + health-check"
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

# 5. Автозапуск при входе в Windows (HKCU, без админа) — не критичен, но о провале сообщаем честно
$autoRunOk = $false
try {
    New-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'ClaudeMascot' -Value "`"$dest`"" -PropertyType String -Force -ErrorAction Stop | Out-Null
    $autoRunOk = $true
} catch { Write-Host "  ВНИМАНИЕ: автозапуск не прописался ($($_.Exception.Message)) — скрепку придётся запускать вручную: $dest" }

# Запуск сейчас
$proc = $null
try { $proc = Start-Process -FilePath $dest -PassThru -ErrorAction Stop }
catch { Write-Host "  ВНИМАНИЕ: скрепка не запустилась ($($_.Exception.Message))." }

# 6. Health-check (НЕ критичный: скрепка поднимает http://127.0.0.1:45832/health, но может не успеть за 10 с)
$healthy = $false
if ($proc) {
    foreach ($i in 1..10) {
        Start-Sleep -Seconds 1
        try {
            $r = Invoke-WebRequest 'http://127.0.0.1:45832/health' -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
            if ($r.StatusCode -eq 200) { $healthy = $true; break }
        } catch { }
    }
}
$procAlive = $false
if ($proc) { try { $procAlive = -not $proc.HasExited } catch { } }
if ($healthy) { Write-Host "OK: Скрепка установлена и запущена — она уже на экране. Ctrl+Shift+D откроет твои сессии Claude." }
elseif ($procAlive) { Write-Host "OK: Скрепка установлена и запускается (не успела ответить на проверку — это не ошибка). Если не появится на экране — запусти вручную: $dest" }
elseif ($autoRunOk) { Write-Host "Скрепка установлена, но не подтвердила запуск — стартует при следующем входе в Windows (автозапуск). Вручную: $dest" }
else { Write-Host "Скрепка установлена, но не запустилась и автозапуск не прописан — запусти вручную: $dest" }
exit 0
