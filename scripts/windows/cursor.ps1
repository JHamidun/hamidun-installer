# Cursor — Windows
$ErrorActionPreference = 'Continue'
function Update-Path { $env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User') }

$DRY = [bool]$env:HM_DRY_RUN
Write-Host "Проверяю Cursor..."
if ((Get-Command cursor -ErrorAction SilentlyContinue) -or (Test-Path (Join-Path $env:LOCALAPPDATA 'Programs\cursor\Cursor.exe'))) {
    Write-Host "Cursor уже установлен."
    if (-not $DRY) { exit 0 }
}

$cexe = Join-Path $env:LOCALAPPDATA 'Programs\cursor\Cursor.exe'
$local = if ($env:HM_VENDOR) { Join-Path $env:HM_VENDOR 'apps\cursor-setup.exe' } else { '' }
$inst = $null
if ($local -and (Test-Path $local)) {
    Write-Host "Ставлю Cursor из встроенного установщика (офлайн)..."
    $inst = $local
} elseif (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host "Устанавливаю Cursor через winget..."
    if (-not $DRY) { winget install -e --id Anysphere.Cursor --silent --accept-package-agreements --accept-source-agreements }
} else {
    Write-Host "winget не найден — качаю Cursor напрямую..."
    if (-not $DRY) {
        $api = Invoke-RestMethod 'https://www.cursor.com/api/download?platform=win32-x64-user&releaseTrack=stable' -Headers @{ 'User-Agent' = 'hamidun-setup' }
        $inst = Join-Path $env:TEMP 'cursor-setup.exe'
        Invoke-WebRequest $api.downloadUrl -OutFile $inst -MaximumRedirection 6
    }
}

if ($DRY) { Write-Host "[dry-run] Cursor: ветка выбрана, без изменений."; exit 0 }

# ВАЖНО: установщик Cursor сам запускает Cursor. С -Wait шаг завис бы до закрытия окна (баг с теста).
# Запускаем БЕЗ -Wait, ждём появления Cursor.exe, затем гасим авто-запущенный Cursor (чтобы не блокировал
# и чтобы следующий шаг — установка расширения — не падал с 'aborted' при открытом Cursor).
if ($inst) { Start-Process -FilePath $inst -ArgumentList '/S' }
for ($i = 0; $i -lt 180 -and -not (Test-Path $cexe); $i++) { Start-Sleep -Seconds 1 }
Start-Sleep -Seconds 2
Get-Process Cursor -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

Update-Path
if (Test-Path $cexe) { Write-Host "Cursor установлен." } else { Write-Host "Cursor: установка запущена (проверьте окно отдельно)." }
exit 0
