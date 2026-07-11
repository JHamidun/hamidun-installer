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
    Write-Host "  [dry-run] WOULD: SHA-256 exe, копия -> $dest, хуки (settings.json: порт 45832), Run-автозапуск, запуск + health-check"
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
if (-not $copied) { Write-Host "Не удалось скопировать скрепку в $dest — файл занят. Закрой её и повтори установку."; exit 1 }

# 4. Хуки Claude Code: конфиг-пак несёт hook-записи с плейсхолдером VSCODE_PORT —
# подставляем порт скрепки (45832). Безопасно: только текстовая замена; нет файла/плейсхолдера — ничего не трогаем.
$settingsPath = Join-Path $env:USERPROFILE '.claude\settings.json'
if (Test-Path $settingsPath) {
    try {
        $rawSettings = [IO.File]::ReadAllText($settingsPath)
        if ($rawSettings -match 'VSCODE_PORT') {
            [IO.File]::WriteAllText($settingsPath, ($rawSettings -replace 'VSCODE_PORT', '45832'), (New-Object System.Text.UTF8Encoding -ArgumentList $false))
            Write-Host "  Хуки Claude Code направлены на скрепку (порт 45832)."
        }
    } catch { Write-Host "  Не удалось обновить ~/.claude/settings.json ($($_.Exception.Message)) — скрепка пропишет хуки сама при первом запуске." }
}
# Сбросить маркер первой установки: приложение перепропишет свои хуки заново (merge аддитивный, чужие записи не трогает).
Remove-Item (Join-Path $env:USERPROFILE '.claude-mascot\.installed') -Force -ErrorAction SilentlyContinue

# 5. Автозапуск при входе в Windows (HKCU, без админа) + запуск сейчас
New-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'ClaudeMascot' -Value "`"$dest`"" -PropertyType String -Force | Out-Null
Start-Process -FilePath $dest

# 6. Health-check (НЕ критичный: скрепка поднимает http://127.0.0.1:45832/health, но может не успеть за 10 с)
$healthy = $false
foreach ($i in 1..10) {
    Start-Sleep -Seconds 1
    try {
        $r = Invoke-WebRequest 'http://127.0.0.1:45832/health' -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
        if ($r.StatusCode -eq 200) { $healthy = $true; break }
    } catch { }
}
if ($healthy) { Write-Host "OK: Скрепка установлена и запущена — она уже на экране. Ctrl+Shift+D откроет твои сессии Claude." }
else { Write-Host "OK: Скрепка установлена и запускается (не успела ответить на проверку — это не ошибка). Если не появится на экране — запусти вручную: $dest" }
exit 0
