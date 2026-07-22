# Cursor — Windows
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot '_verify.ps1')  # Confirm-HmArtifact (fail-closed SHA-256)
function Update-Path {
    # SECURITY (#4): PATH для elevated-скрипта — ТОЛЬКО HKLM (Machine) + наши
    # админ-owned фиксированные каталоги. НИКОГДА не читаем HKCU (User) PATH: на чистой
    # машине medium-integrity процесс того же юзера может дописать туда каталог с
    # подложенным git/node/python/winget и исполнить его под нашим elevated-токеном.
    # Инструменты в user-профиле (python/cursor/claude/uv) находим по абсолютным путям.
    $sr  = if ($env:SystemRoot) { $env:SystemRoot } else { 'C:\Windows' }
    $s32 = Join-Path $sr 'System32'
    $parts = @([Environment]::GetEnvironmentVariable('Path', 'Machine'),
               $s32, $sr,
               (Join-Path $s32 'WindowsPowerShell\v1.0'),
               (Join-Path $s32 'OpenSSH'))
    if ($env:ProgramFiles) {
        $parts += (Join-Path $env:ProgramFiles 'Git\cmd')
        $parts += (Join-Path $env:ProgramFiles 'Git\bin')
        $parts += (Join-Path $env:ProgramFiles 'nodejs')
    }
    if (${env:ProgramFiles(x86)}) { $parts += (Join-Path ${env:ProgramFiles(x86)} 'Git\cmd') }
    if ($env:HM_VENDOR) { $parts += (Join-Path $env:HM_VENDOR 'apps') }
    $env:Path = ($parts | Where-Object { $_ }) -join ';'
}

$DRY = [bool]$env:HM_DRY_RUN
Write-Host "Проверяю Cursor..."
if ((Get-Command cursor -ErrorAction SilentlyContinue) -or (Test-Path (Join-Path $env:LOCALAPPDATA 'Programs\cursor\Cursor.exe'))) {
    Write-Host "Cursor уже установлен."
    if (-not $DRY) { exit 0 }
}

$cexe = Join-Path $env:LOCALAPPDATA 'Programs\cursor\Cursor.exe'
$local = if ($env:HM_VENDOR) { Join-Path $env:HM_VENDOR 'apps\cursor-setup.exe' } else { '' }
$inst = $null
$instBundled = $false
if ($local -and (Test-Path $local)) {
    Write-Host "Ставлю Cursor из встроенного установщика (офлайн)..."
    $inst = $local
    $instBundled = $true
} elseif (Get-Command winget -ErrorAction SilentlyContinue) {
    Write-Host "Устанавливаю Cursor через winget..."
    if (-not $DRY) { winget install -e --id Anysphere.Cursor --silent --accept-package-agreements --accept-source-agreements }
} else {
    Write-Host "winget не найден — качаю Cursor напрямую..."
    if (-not $DRY) {
        # СЕТЬ: дефолтный TimeoutSec=0 (бесконечно) недопустим, а прогресс-бар в PS5.1 в разы замедляет скачивание.
        $ProgressPreference = 'SilentlyContinue'
        try {
            $api = Invoke-RestMethod 'https://www.cursor.com/api/download?platform=win32-x64-user&releaseTrack=stable' -Headers @{ 'User-Agent' = 'hamidun-setup' } -UseBasicParsing -TimeoutSec 60
            $inst = Join-Path $env:TEMP 'cursor-setup.exe'
            Invoke-WebRequest $api.downloadUrl -OutFile $inst -MaximumRedirection 6 -UseBasicParsing -TimeoutSec 600
        } catch {
            Write-Host "Сеть недоступна или медленная — повтори установку компонента. ($($_.Exception.Message))"
            exit 1
        }
    }
}

if ($DRY) { Write-Host "[dry-run] Cursor: ветка выбрана, без изменений."; exit 0 }

# ВАЖНО: установщик Cursor сам запускает Cursor. С -Wait шаг завис бы до закрытия окна (баг с теста).
# Запускаем БЕЗ -Wait, ждём появления Cursor.exe, затем гасим авто-запущенный Cursor (чтобы не блокировал
# и чтобы следующий шаг — установка расширения — не падал с 'aborted' при открытом Cursor).
if ($inst) {
    if ($instBundled) { Confirm-HmArtifact $inst }  # вшитый артефакт — сверяем SHA-256 (fail-closed)
    Write-Host "Установщик Cursor может показать окно «This User Installer is not meant to run as Administrator» — нажми OK, это нормально (весь установщик запущен с правами администратора)."
    Start-Process -FilePath $inst -ArgumentList '/S'
}
for ($i = 0; $i -lt 180 -and -not (Test-Path $cexe); $i++) { Start-Sleep -Seconds 1 }
Start-Sleep -Seconds 2
Get-Process Cursor -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

Update-Path
if (Test-Path $cexe) { Write-Host "Cursor установлен."; exit 0 }
Write-Host "ОШИБКА: Cursor не установился (Cursor.exe не найден). Заверши окно установки и нажми «Повторить неустановленное»."
exit 1
