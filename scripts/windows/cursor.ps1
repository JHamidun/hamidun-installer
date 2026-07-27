# Cursor — Windows
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot '_verify.ps1')  # Confirm-HmArtifact (fail-closed SHA-256)
. (Join-Path $PSScriptRoot '_deelev.ps1')  # New-HmSecureStagingDir (Admins-only secure-cache для онлайн-фолбэка)
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
$onlineCache = $null
$instProc = $null
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
        # SECURITY (#4): качаем НЕ в user-writable %TEMP% (medium-малварь того же юзера подменила бы exe
        # между скачиванием и Start-Process → RCE под админом), а в ADMIN-OWNED secure-cache
        # (New-HmSecureStagingDir -Elevated $true). Перед elevated-запуском — гейт Authenticode (ниже, fail-closed).
        $ProgressPreference = 'SilentlyContinue'
        $sysRoot  = if ($env:SystemRoot) { $env:SystemRoot } else { 'C:\Windows' }
        $icaclsEx = Join-Path (Join-Path $sysRoot 'System32') 'icacls.exe'
        $progData = Join-Path ([System.IO.Path]::GetPathRoot($sysRoot)) 'ProgramData'
        if ((Test-Path -LiteralPath $icaclsEx) -and (Test-Path -LiteralPath $progData)) {
            $onlineCache = New-HmSecureStagingDir -ProgramData $progData -Icacls $icaclsEx -Elevated $true
        }
        if (-not ($onlineCache -and (Test-Path -LiteralPath $onlineCache))) {
            Write-Host "  Не удалось создать защищённый кэш для скачивания — прерываю онлайн-фолбэк Cursor."
            exit 1
        }
        try {
            $api = Invoke-RestMethod 'https://www.cursor.com/api/download?platform=win32-x64-user&releaseTrack=stable' -Headers @{ 'User-Agent' = 'hamidun-setup' } -UseBasicParsing -TimeoutSec 60
            $inst = Join-Path $onlineCache 'cursor-setup.exe'
            Invoke-WebRequest $api.downloadUrl -OutFile $inst -MaximumRedirection 6 -UseBasicParsing -TimeoutSec 600
        } catch {
            Remove-HmSecureStagingDir -Path $onlineCache
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
    if ($instBundled) {
        Confirm-HmArtifact $inst  # вшитый артефакт — сверяем SHA-256 (fail-closed)
    } else {
        # SECURITY (#4): онлайн-скачанный установщик лежит в ADMIN-OWNED secure-cache. ДО elevated-
        # запуска — гейт Authenticode (fail-closed): иначе medium-малварь того же юзера подменила бы exe.
        # Status='Valid' сам по себе НЕ защищает: цепочку строит пользовательский chain-engine, а
        # HKCU\...\SystemCertificates\Root пишется тем же юзером БЕЗ UAC (+ HKCU-прокси WinINET рулит
        # загрузкой). Test-HmTrustedSigner требует корень в LocalMachine\Root + EKU Code Signing.
        $why = Test-HmTrustedSigner -Path $inst
        if ($why) {
            Write-Host "  БЕЗОПАСНОСТЬ: подпись установщика Cursor не подтвердилась ($why) — НЕ запускаю (fail-closed)."
            if ($onlineCache) { Remove-HmSecureStagingDir -Path $onlineCache }
            Write-Host "ОШИБКА: Cursor не установился (подпись не подтверждена)."
            exit 1
        }
    }
    Write-Host "Установщик Cursor может показать окно «This User Installer is not meant to run as Administrator» — нажми OK, это нормально (весь установщик запущен с правами администратора)."
    # -PassThru (но НЕ -Wait: с -Wait шаг завис бы до закрытия авто-запущенного Cursor) — дескриптор
    # нужен, чтобы чистить Admins-only secure-cache ПОСЛЕ реального выхода установщика: пока его
    # образ залочен, Remove-Item тихо не срабатывает и каталог с ~200 МБ остаётся в ProgramData
    # навсегда (пользователю он недоступен: owner=Administrators, Users без ACE).
    $instProc = Start-Process -FilePath $inst -ArgumentList '/S' -PassThru
}
for ($i = 0; $i -lt 180 -and -not (Test-Path $cexe); $i++) { Start-Sleep -Seconds 1 }
Start-Sleep -Seconds 2
Get-Process Cursor -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

# Чистим Admins-only online-кэш. Best-effort, но с ограниченным ожиданием (максимум ~60 с):
# пока процесс установщика жив, его образ залочен и Remove-Item молча ничего не удаляет —
# каталог оставался бы в %ProgramData% навсегда (Admins-only, пользователь удалить не может).
if ($onlineCache) {
    for ($k = 0; $k -lt 30; $k++) {
        if ($instProc -and -not $instProc.HasExited) { Start-Sleep -Seconds 2; continue }
        Remove-HmSecureStagingDir -Path $onlineCache
        if (-not (Test-Path -LiteralPath $onlineCache)) { break }
        Start-Sleep -Seconds 2
    }
}

Update-Path
if (Test-Path $cexe) { Write-Host "Cursor установлен."; exit 0 }
Write-Host "ОШИБКА: Cursor не установился (Cursor.exe не найден). Заверши окно установки и нажми «Повторить неустановленное»."
exit 1
