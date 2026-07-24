# Node.js LTS — Windows
$ErrorActionPreference = 'Stop'
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
Write-Host "Проверяю Node.js..."
if (Get-Command node -ErrorAction SilentlyContinue) { Write-Host "Node.js уже установлен: $(node --version)"; if ($DRY) { Write-Host "[dry-run] Node.js уже установлен — без изменений."; exit 0 } else { exit 0 } }

$local = if ($env:HM_VENDOR) { Join-Path $env:HM_VENDOR 'apps\node-lts.msi' } else { '' }
if ($local -and (Test-Path $local)) {
    Write-Host "Ставлю Node.js из встроенного MSI (офлайн)..."
    if ($DRY) { Write-Host "  [dry-run] WOULD: msiexec /i $local /qn /norestart" }
    else { Confirm-HmArtifact $local; Start-Process msiexec.exe -ArgumentList '/i', "`"$local`"", '/qn', '/norestart' -Wait }
} elseif (Get-Command winget -ErrorAction SilentlyContinue) {
    if ($DRY) { Write-Host "  [dry-run] WOULD: winget install -e --id OpenJS.NodeJS.LTS --silent" }
    else { Write-Host "Устанавливаю Node.js LTS через winget..."; winget install -e --id OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements }
} else {
    if ($DRY) { Write-Host "  [dry-run] WOULD: скачать MSI Node.js LTS с nodejs.org в secure-cache, проверить подпись и msiexec /i /qn" }
    else {
        Write-Host "winget не найден — качаю MSI Node.js LTS..."
        # СЕТЬ: дефолтный TimeoutSec=0 (бесконечно) недопустим, а прогресс-бар в PS5.1 в разы замедляет скачивание.
        # SECURITY (#4): качаем НЕ в user-writable %TEMP% (medium-малварь того же юзера подменила бы msi
        # между скачиванием и msiexec → RCE под админом), а в ADMIN-OWNED secure-cache
        # (New-HmSecureStagingDir -Elevated $true). Перед elevated-запуском — гейт Authenticode (fail-closed).
        $ProgressPreference = 'SilentlyContinue'
        $sysRoot  = if ($env:SystemRoot) { $env:SystemRoot } else { 'C:\Windows' }
        $icacls   = Join-Path (Join-Path $sysRoot 'System32') 'icacls.exe'
        $progData = Join-Path ([System.IO.Path]::GetPathRoot($sysRoot)) 'ProgramData'
        $cache = $null
        if ((Test-Path -LiteralPath $icacls) -and (Test-Path -LiteralPath $progData)) {
            $cache = New-HmSecureStagingDir -ProgramData $progData -Icacls $icacls -Elevated $true
        }
        if (-not ($cache -and (Test-Path -LiteralPath $cache))) {
            Write-Host "  Не удалось создать защищённый кэш для скачивания — прерываю онлайн-фолбэк Node.js."
            exit 1
        }
        $msi = $null
        try {
            $idx = Invoke-RestMethod "https://nodejs.org/dist/index.json" -UseBasicParsing -TimeoutSec 60
            $lts = $idx | Where-Object { $_.lts } | Select-Object -First 1
            $url = "https://nodejs.org/dist/$($lts.version)/node-$($lts.version)-x64.msi"
            $msi = Join-Path $cache "node-lts.msi"
            Invoke-WebRequest $url -OutFile $msi -UseBasicParsing -TimeoutSec 600
        } catch {
            try { Remove-Item -LiteralPath $cache -Recurse -Force -ErrorAction SilentlyContinue } catch { }
            Write-Host "Сеть недоступна или медленная — повтори установку компонента. ($($_.Exception.Message))"
            exit 1
        }
        # Гейт подписи ДО запуска (fail-closed): elevated-запуск неподтверждённого msi недопустим даже из secure-cache.
        $sig = if ($msi -and (Test-Path -LiteralPath $msi)) { Get-AuthenticodeSignature -LiteralPath $msi } else { $null }
        if ($sig -and $sig.Status -eq 'Valid') {
            Start-Process msiexec.exe -ArgumentList '/i', "`"$msi`"", '/qn', '/norestart' -Wait
        } else {
            $st = if ($sig) { $sig.Status } else { 'нет подписи' }
            Write-Host "  БЕЗОПАСНОСТЬ: подпись MSI Node.js не подтвердилась ($st) — НЕ запускаю (fail-closed)."
        }
        # Чистим Admins-only кэш (установщик уже отработал; больше не нужен). Best-effort.
        try { Remove-Item -LiteralPath $cache -Recurse -Force -ErrorAction SilentlyContinue } catch { }
    }
}

if ($DRY) { Write-Host "[dry-run] Node.js: офлайн-ветка выбрана, без изменений."; exit 0 }
Update-Path
if (Get-Command node -ErrorAction SilentlyContinue) { Write-Host "OK: node $(node --version), npm $(npm --version)"; exit 0 }
Write-Host "Node.js не обнаружен после установки."; exit 1
